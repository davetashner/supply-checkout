// The pre sign-up trigger that links a first Google or Apple sign-in to an
// existing account with the same email (supply-checkout-0b1), its Cognito
// calls, and the journey: the retried sign-in lands in the same user, which
// the guard and the email_verified trigger then treat as a native user.

import type { PreAuthenticationTriggerEvent, PreSignUpTriggerEvent, PreTokenGenerationTriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import {
  answerCognito,
  asciiLower,
  authoritative,
  createAccountLinkHandler,
  FAILED_ERROR,
  LINKED_MARKER,
  linkedError,
  type LinkResult,
  providerIdentity,
} from "../src/identity/account-link-handler.js";
import { cognitoLinking, type LinkProviderForUser, type ListUsersByEmail, type PoolUser, type UpdateUserAttributes } from "../src/identity/cognito-admin.js";
import { createEmailVerifiedHandler } from "../src/identity/email-verified-handler.js";
import { LINKED_EMAIL_ATTRIBUTE, PROVIDER_EMAIL_VERIFIED_ATTRIBUTE, PROVIDER_HOSTED_DOMAIN_ATTRIBUTE } from "../src/identity/names.js";
import { createSignInGuardHandler } from "../src/identity/sign-in-guard-handler.js";
import type { Observability } from "../src/observability/index.js";
import { REGION } from "./helpers.js";

const POOL = `${REGION}_pool`;
const GOOGLE_ID = "107691234567890123456";
const APPLE_ID = "001234.0a1b2c3d4e5f.1234";
const NATIVE = "8f0e5b1c-0000-4000-8000-000000000001";
// A Google Workspace address: Google is authoritative for it when `hd` is example.com
const EMAIL = "pat@example.com";
const HD = "example.com";
// Made-up addresses at the providers' own domains, for the authority rules
const GMAIL = "pat.lee.test@gmail.com"; // public-safety: allow (made-up address)
const ICLOUD = "pat.lee.test@icloud.com"; // public-safety: allow (made-up address)
const RELAY = "x7k2q9m4ab@privaterelay.appleid.com"; // public-safety: allow (a made-up relay address)
const PROVIDERS = [
  ["Google", GOOGLE_ID],
  ["SignInWithApple", APPLE_ID],
] as const;
/** An address the provider is authoritative for: the Workspace address for Google (with its hd), iCloud for Apple. */
const emailFor = (provider: string) => (provider === "Google" ? EMAIL : ICLOUD);

type Logged = { level: string; message: string; data: Record<string, unknown> };

function fakeObservability(logs: Logged[]): Observability {
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push({ level, message, data });
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: () => {},
    flush: () => {},
  };
}

const identities = (...entries: [string, string][]) =>
  JSON.stringify(entries.map(([providerName, userId]) => ({ userId, providerName, providerType: providerName, issuer: null, primary: false, dateCreated: 1_700_000_000_000 })));

/** A native user as ListUsers describes it: confirmed, enabled, with a verified email, unless told otherwise. */
const nativeUser = (overrides: { username?: string; status?: string; enabled?: boolean; attributes?: Record<string, string> } = {}): PoolUser => ({
  username: overrides.username ?? NATIVE,
  status: overrides.status ?? "CONFIRMED",
  enabled: overrides.enabled ?? true,
  attributes: { sub: NATIVE, email: EMAIL, email_verified: "true", ...overrides.attributes },
});

/** A federated-only user with the same email, as a Google sign-in before this trigger existed would have made. */
const federatedUser = (provider = "Google", id = GOOGLE_ID): PoolUser => ({
  username: `${provider}_${id}`.toLowerCase(),
  status: "EXTERNAL_PROVIDER",
  enabled: true,
  attributes: { sub: "8f0e5b1c-0000-4000-8000-000000000002", email: EMAIL, email_verified: "true", identities: identities([provider, id]) },
});

/** A provider sign-up, as Cognito sends it after applying the attribute mapping. */
function signUpEvent(
  options: { provider?: string; id?: string; userName?: string; claim?: unknown; email?: string | null; hd?: string | null; triggerSource?: string } = {},
): PreSignUpTriggerEvent {
  const provider = options.provider ?? "Google";
  const userAttributes: Record<string, string> = {};
  if (options.email !== null) userAttributes.email = options.email ?? emailFor(provider);
  // Google sends hd only for Workspace accounts; Apple never does
  const hd = options.hd === undefined ? (provider === "Google" ? HD : null) : options.hd;
  if (hd !== null) userAttributes[PROVIDER_HOSTED_DOMAIN_ATTRIBUTE] = hd;
  if (options.claim !== undefined) userAttributes[PROVIDER_EMAIL_VERIFIED_ATTRIBUTE] = options.claim as string;
  return {
    version: "1",
    triggerSource: options.triggerSource ?? "PreSignUp_ExternalProvider",
    region: REGION,
    userPoolId: POOL,
    userName: options.userName ?? `${provider}_${options.id ?? GOOGLE_ID}`,
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "web" },
    request: { userAttributes },
    response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
  } as PreSignUpTriggerEvent;
}

function linker(options: { users?: PoolUser[]; more?: boolean; list?: ListUsersByEmail; update?: UpdateUserAttributes; link?: LinkProviderForUser } = {}) {
  const lookups: { pool: string; email: string }[] = [];
  const links: { pool: string; user: string; provider: string; id: string }[] = [];
  const updates: { pool: string; user: string; attributes: Record<string, string> }[] = [];
  const order: string[] = [];
  const logs: Logged[] = [];
  const handler = createAccountLinkHandler({
    obs: fakeObservability(logs),
    updateUserAttributes:
      options.update ??
      (async (pool, user, attributes) => {
        order.push("record");
        updates.push({ pool, user, attributes: { ...attributes } });
      }),
    listUsersByEmail:
      options.list ??
      (async (pool, email) => {
        lookups.push({ pool, email });
        return { users: options.users ?? [], more: options.more ?? false };
      }),
    linkProviderForUser:
      options.link ??
      (async (pool, user, provider, id) => {
        order.push("link");
        links.push({ pool, user, provider, id });
      }),
  });
  const outcome = () => logs.find((l) => l.message === "Account link")?.data.outcome;
  return { handler, lookups, links, updates, order, logs, outcome };
}

const eventOf = (result: LinkResult) => {
  if (!("event" in result)) throw new Error("Expected the sign-up to go ahead");
  return result.event;
};

describe("providerIdentity", () => {
  it("reads the provider and its user ID from a provider sign-up's username, in any case", () => {
    expect(providerIdentity(`Google_${GOOGLE_ID}`)).toEqual({ provider: "Google", userId: GOOGLE_ID });
    expect(providerIdentity(`google_${GOOGLE_ID}`)).toEqual({ provider: "Google", userId: GOOGLE_ID });
    expect(providerIdentity(`SignInWithApple_${APPLE_ID}`)).toEqual({ provider: "SignInWithApple", userId: APPLE_ID });
    expect(providerIdentity(`signinwithapple_${APPLE_ID}`)).toEqual({ provider: "SignInWithApple", userId: APPLE_ID });
  });

  it("is undefined for anything else", () => {
    for (const name of [undefined, 42, NATIVE, `Facebook_${GOOGLE_ID}`, "Google_", "Google", `Google_${GOOGLE_ID} x`, `Google_a"b`, `Google_${"1".repeat(256)}`]) {
      expect(providerIdentity(name), String(name)).toBeUndefined();
    }
  });
});

describe("authoritative", () => {
  it("is true only for mailboxes the provider runs", () => {
    expect(authoritative("Google", GMAIL, undefined)).toBe(true);
    expect(authoritative("Google", EMAIL, HD)).toBe(true);
    expect(authoritative("Google", EMAIL, undefined)).toBe(false);
    expect(authoritative("Google", EMAIL, "example.org")).toBe(false);
    expect(authoritative("SignInWithApple", ICLOUD, undefined)).toBe(true);
    expect(authoritative("SignInWithApple", RELAY, undefined)).toBe(true);
    // Apple has no hosted domain
    expect(authoritative("SignInWithApple", EMAIL, HD)).toBe(false);
  });
});

describe("pre sign-up trigger", () => {
  for (const [provider, id] of PROVIDERS) {
    const yes = provider === "Google" ? [true, "true"] : ["true", "TRUE"];
    it(`links a ${provider} sign-up with a verified email to the one confirmed, verified account with it, and stops the sign-up`, async () => {
      for (const claim of yes) {
        const email = emailFor(provider);
        const { handler, lookups, links, updates, order, logs, outcome } = linker({ users: [nativeUser({ attributes: { email } })] });
        const result = await handler(signUpEvent({ provider, id, claim }));
        expect(result).toEqual({ linked: provider });
        expect(lookups).toEqual([{ pool: POOL, email }]);
        // The email is recorded where no client can write it, then the identity is linked
        expect(updates).toEqual([{ pool: POOL, user: NATIVE, attributes: { [LINKED_EMAIL_ATTRIBUTE]: email } }]);
        expect(links).toEqual([{ pool: POOL, user: NATIVE, provider, id }]);
        expect(order).toEqual(["record", "link"]);
        expect(outcome()).toBe("linked");
        expect(logs.find((l) => l.message === "Account link")?.data).toEqual({ triggerSource: "PreSignUp_ExternalProvider", outcome: "linked", provider });
        // Cognito shows this in error_description; the web app signs in again with that provider
        expect(() => answerCognito(result)).toThrow(new Error(`${LINKED_MARKER}:${provider}`));
      }
    });

    it(`never links a ${provider} sign-up whose provider doesn't say the email is verified`, async () => {
      for (const claim of [false, "false", "", "yes", "1", undefined]) {
        const { handler, lookups, links, outcome } = linker({ users: [nativeUser({ attributes: { email: emailFor(provider) } })] });
        const event = signUpEvent({ provider, id, claim });
        const result = await handler(event);
        expect(answerCognito(result)).toBe(event);
        expect(lookups).toEqual([]);
        expect(links).toEqual([]);
        expect(outcome()).toBe("unverified-email");
      }
    });
  }

  it("leaves native sign-ups and admin-created users alone, confirming and verifying nothing", async () => {
    for (const triggerSource of ["PreSignUp_SignUp", "PreSignUp_AdminCreateUser"]) {
      const { handler, lookups, links, outcome } = linker({ users: [nativeUser()] });
      const event = signUpEvent({ triggerSource, userName: NATIVE, claim: "true" });
      const result = eventOf(await handler(event));
      expect(result).toBe(event);
      expect(result.response).toEqual({ autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false });
      expect(lookups).toEqual([]);
      expect(links).toEqual([]);
      expect(outcome()).toBe("not-provider-sign-up");
    }
  });

  it("doesn't link a username that isn't a Google or Apple identity", async () => {
    const { handler, lookups, outcome } = linker({ users: [nativeUser()] });
    await handler(signUpEvent({ userName: `Facebook_${GOOGLE_ID}`, claim: "true" }));
    expect(lookups).toEqual([]);
    expect(outcome()).toBe("unknown-provider");
  });

  it("doesn't look up a missing, malformed or filter-breaking email", async () => {
    for (const email of [null, "", "pat", "pat@example", "pat@@example.com", 'p"t@example.com', "p\\t@example.com", "pat @example.com", `${"a".repeat(250)}@example.com`]) {
      const { handler, lookups, outcome } = linker({ users: [nativeUser()] });
      await handler(signUpEvent({ claim: "true", email }));
      expect(lookups, String(email)).toEqual([]);
      expect(outcome()).toBe("unusable-email");
    }
    const { handler, outcome } = linker({ users: [nativeUser()] });
    const noAttributes = signUpEvent({ claim: "true" });
    (noAttributes as unknown as { request: unknown }).request = undefined;
    await handler(noAttributes);
    expect(outcome()).toBe("unverified-email");
  });

  it("links a Google sign-in only for Gmail, or a Workspace account whose hd is the email's domain", async () => {
    const cases: [string, string | null, string][] = [
      [GMAIL, null, "linked"],
      [GMAIL.replace("gmail.com", "googlemail.com"), null, "linked"],
      [EMAIL, HD, "linked"],
      [EMAIL, " Example.COM ", "linked"],
      // An old personal Google account still carrying a work address it once verified
      [EMAIL, null, "not-authoritative"],
      [EMAIL, "", "not-authoritative"],
      // Another Workspace tenant vouching for this domain's address
      [EMAIL, "other.example.org", "not-authoritative"],
      [EMAIL, "sub.example.com", "not-authoritative"],
      ["pat@sub.example.com", HD, "not-authoritative"], // public-safety: allow (made-up address)
      [RELAY, null, "not-authoritative"],
      [ICLOUD, null, "not-authoritative"],
    ];
    for (const [email, hd, expected] of cases) {
      const { handler, lookups, links, outcome } = linker({ users: [nativeUser({ attributes: { email } })] });
      await handler(signUpEvent({ claim: "true", email, hd }));
      expect(outcome(), `${email} ${String(hd)}`).toBe(expected);
      expect(links).toHaveLength(expected === "linked" ? 1 : 0);
      if (expected !== "linked") expect(lookups).toEqual([]);
    }
  });

  it("links an Apple sign-in only for a private relay or iCloud address", async () => {
    const cases: [string, string][] = [
      [RELAY, "linked"],
      [RELAY.toUpperCase(), "linked"],
      [ICLOUD, "linked"],
      [ICLOUD.replace("icloud.com", "me.com"), "linked"],
      [ICLOUD.replace("icloud.com", "mac.com"), "linked"],
      // A company address on an Apple ID: Apple doesn't run that mailbox
      [EMAIL, "not-authoritative"],
      [GMAIL, "not-authoritative"],
      ["pat@icloud.com.example.org", "not-authoritative"], // public-safety: allow (made-up address)
    ];
    for (const [email, expected] of cases) {
      const { handler, links, outcome } = linker({ users: [nativeUser({ attributes: { email: email.toLowerCase() } })] });
      // hd means nothing from Apple
      await handler(signUpEvent({ provider: "SignInWithApple", id: APPLE_ID, claim: "true", email, hd: expected === "linked" ? null : "example.com" }));
      expect(outcome(), email).toBe(expected);
      expect(links).toEqual(expected === "linked" ? [{ pool: POOL, user: NATIVE, provider: "SignInWithApple", id: APPLE_ID }] : []);
    }
  });

  it("compares addresses with ASCII case only, so Unicode case folding can't make two match", async () => {
    expect(asciiLower("Pat.K@Example.COM")).toBe("pat.k@example.com");
    expect(asciiLower("PAT\u212A")).toBe("pat\u212A");
    // A provider address with a non-ASCII character isn't used at all
    const unicode = linker({ users: [nativeUser()] });
    await unicode.handler(signUpEvent({ claim: "true", email: "pat\u212A@example.com" }));
    expect(unicode.outcome()).toBe("unusable-email");
    // A listed account whose address only folds to the provider's isn't a match
    const folded = linker({ users: [nativeUser({ attributes: { email: "pat\u212A@example.com" } })] });
    await folded.handler(signUpEvent({ claim: "true", email: "patk@example.com" }));
    expect(folded.outcome()).toBe("no-account");
  });

  it("makes a separate account when no native account has the email, ignoring federated-only users and other addresses", async () => {
    for (const users of [[], [federatedUser()], [federatedUser("SignInWithApple", APPLE_ID)], [nativeUser({ attributes: { email: "pat@example.org" } })]]) {
      const { handler, links, outcome } = linker({ users });
      const event = signUpEvent({ claim: "true" });
      expect(answerCognito(await handler(event))).toBe(event);
      expect(links).toEqual([]);
      expect(outcome()).toBe("no-account");
    }
    // A missing email attribute on the listed user isn't a match either
    const bare = { ...nativeUser(), attributes: { sub: NATIVE, email_verified: "true" } };
    const { handler, outcome } = linker({ users: [bare] });
    await handler(signUpEvent({ claim: "true" }));
    expect(outcome()).toBe("no-account");
  });

  it("matches the email case-insensitively, as the pool does", async () => {
    const { handler, lookups, links, updates } = linker({ users: [nativeUser({ attributes: { email: "Pat@Example.com" } })] });
    expect(await handler(signUpEvent({ claim: "true", email: " Pat@Example.com " }))).toEqual({ linked: "Google" });
    expect(lookups[0]?.email).toBe("Pat@Example.com");
    expect(links).toHaveLength(1);
    expect(updates[0]?.attributes).toEqual({ [LINKED_EMAIL_ATTRIBUTE]: EMAIL });
  });

  it("links to the native account even when a federated-only user shares the email", async () => {
    const { handler, links } = linker({ users: [federatedUser("SignInWithApple", APPLE_ID), nativeUser()] });
    expect(await handler(signUpEvent({ claim: "true" }))).toEqual({ linked: "Google" });
    expect(links.map((l) => l.user)).toEqual([NATIVE]);
  });

  it("refuses to pick when several native accounts share the email, or Cognito has more than one page", async () => {
    const other = nativeUser({ username: "8f0e5b1c-0000-4000-8000-000000000003" });
    for (const options of [{ users: [nativeUser(), other] }, { users: [nativeUser()], more: true }]) {
      const { handler, links, outcome } = linker(options);
      const event = signUpEvent({ claim: "true" });
      expect(answerCognito(await handler(event))).toBe(event);
      expect(links).toEqual([]);
      expect(outcome()).toBe("ambiguous");
    }
    // Even when only one of them could be linked
    const { handler, outcome } = linker({ users: [nativeUser(), nativeUser({ username: "other", status: "UNCONFIRMED", attributes: { email_verified: "false" } })] });
    await handler(signUpEvent({ claim: "true" }));
    expect(outcome()).toBe("ambiguous");
  });

  it("never links to an unconfirmed, unverified or disabled account", async () => {
    for (const user of [
      nativeUser({ status: "UNCONFIRMED" }),
      nativeUser({ status: "UNCONFIRMED", attributes: { email_verified: "false" } }),
      nativeUser({ status: "FORCE_CHANGE_PASSWORD" }),
      nativeUser({ status: "RESET_REQUIRED" }),
      nativeUser({ status: "" }),
      nativeUser({ attributes: { email_verified: "false" } }),
      nativeUser({ attributes: { email_verified: "TRUE " } }),
      { ...nativeUser(), attributes: { sub: NATIVE, email: EMAIL } },
      nativeUser({ enabled: false }),
    ]) {
      const { handler, links, outcome } = linker({ users: [user] });
      const event = signUpEvent({ claim: "true" });
      expect(answerCognito(await handler(event))).toBe(event);
      expect(links, JSON.stringify(user)).toEqual([]);
      expect(outcome()).toBe("not-eligible");
    }
  });

  it("doesn't link a second identity from the same provider, or when the linked identities can't be read", async () => {
    const withGoogle = nativeUser({ attributes: { identities: identities(["Google", "999"]), [LINKED_EMAIL_ATTRIBUTE]: EMAIL } });
    const again = linker({ users: [withGoogle] });
    await again.handler(signUpEvent({ claim: "true" }));
    expect(again.links).toEqual([]);
    expect(again.updates).toEqual([]);
    expect(again.outcome()).toBe("already-linked");

    for (const unreadable of ["not json", JSON.stringify({ providerName: "Google" })]) {
      const { handler, links, outcome } = linker({ users: [nativeUser({ attributes: { identities: unreadable } })] });
      await handler(signUpEvent({ claim: "true" }));
      expect(outcome()).toBe("already-linked");
      expect(links).toEqual([]);
    }
    // Entries that aren't Google or Apple identities don't count
    const { handler, outcome } = linker({ users: [nativeUser({ attributes: { identities: JSON.stringify([null, { providerName: "Facebook" }, { providerName: 7 }]) } })] });
    await handler(signUpEvent({ claim: "true" }));
    expect(outcome()).toBe("linked");
  });

  it("links another provider only while the account's email is still the one recorded at its first link", async () => {
    const linkedGoogle = (attributes: Record<string, string>) => nativeUser({ attributes: { email: ICLOUD, identities: identities(["Google", GOOGLE_ID]), ...attributes } });
    const apple = () => signUpEvent({ provider: "SignInWithApple", id: APPLE_ID, claim: "true" });

    const same = linker({ users: [linkedGoogle({ [LINKED_EMAIL_ATTRIBUTE]: ICLOUD.toUpperCase() })] });
    expect(await same.handler(apple())).toEqual({ linked: "SignInWithApple" });

    // Cognito rewrote the email from the linked Google account, which now carries someone else's address
    const recordings: Record<string, string>[] = [{ [LINKED_EMAIL_ATTRIBUTE]: GMAIL }, {}, { [LINKED_EMAIL_ATTRIBUTE]: "" }];
    for (const recorded of recordings) {
      const changed = linker({ users: [linkedGoogle(recorded)] });
      const event = apple();
      expect(answerCognito(await changed.handler(event))).toBe(event);
      expect(changed.updates).toEqual([]);
      expect(changed.links).toEqual([]);
      expect(changed.outcome()).toBe("email-changed");
    }
  });

  it("fails the sign-in, making no account, when Cognito can't be asked or can't link, and logs no email, username or provider ID", async () => {
    const lookupFails = linker({ list: async () => { throw new Error("ListUsers failed: 500 InternalErrorException"); } });
    await expect(lookupFails.handler(signUpEvent({ claim: "true" }))).rejects.toThrow(new Error(FAILED_ERROR));
    expect(lookupFails.logs).toEqual([{ level: "error", message: "Couldn't look for an account to link", data: { provider: "Google", outcome: "lookup-failed", error: "ListUsers failed: 500 InternalErrorException" } }]);

    const recordFails = linker({ users: [nativeUser()], update: async () => { throw new Error("AdminUpdateUserAttributes failed: 400 InvalidParameterException"); } });
    await expect(recordFails.handler(signUpEvent({ claim: "true" }))).rejects.toThrow(new Error(FAILED_ERROR));
    expect(recordFails.links).toEqual([]);
    expect(recordFails.logs).toEqual([{ level: "error", message: "Couldn't record the email being linked", data: { provider: "Google", outcome: "record-failed", error: "AdminUpdateUserAttributes failed: 400 InvalidParameterException" } }]);

    const linkFails = linker({ users: [nativeUser({ attributes: { email: ICLOUD } })], link: async () => { throw new Error("AdminLinkProviderForUser failed: 400 InvalidParameterException"); } });
    await expect(linkFails.handler(signUpEvent({ provider: "SignInWithApple", id: APPLE_ID, claim: "true" }))).rejects.toThrow(new Error(FAILED_ERROR));
    expect(linkFails.logs).toEqual([{ level: "error", message: "Couldn't link the sign-in to the existing account", data: { provider: "SignInWithApple", outcome: "link-failed", error: "AdminLinkProviderForUser failed: 400 InvalidParameterException" } }]);

    const { handler, logs } = linker({ users: [nativeUser()] });
    await handler(signUpEvent({ claim: "true" }));
    const text = JSON.stringify([...logs, ...lookupFails.logs, ...recordFails.logs, ...linkFails.logs]);
    for (const secret of [EMAIL, ICLOUD, NATIVE, GOOGLE_ID, APPLE_ID, "pat", HD]) expect(text).not.toContain(secret);
    expect(FAILED_ERROR).not.toMatch(/Google|Apple|@/);
    expect(linkedError("Google")).toBe("ACCOUNT_LINKED:Google");
  });
});

describe("cognitoLinking", () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "session" };
  const client = (respond: () => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const linking = cognitoLinking({
      region: REGION,
      credentials,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond();
      }) as typeof fetch,
    });
    const first = () => {
      const [call] = calls;
      if (!call) throw new Error("Nothing was sent");
      return call;
    };
    const sent = () => ({ target: (first().init.headers as Record<string, string>)["x-amz-target"], body: JSON.parse(first().init.body as string) });
    return { ...linking, calls, first, sent };
  };

  it("lists users by exact email with a signed ListUsers, reading only well-formed users", async () => {
    const users = [
      { Username: NATIVE, UserStatus: "CONFIRMED", Enabled: true, Attributes: [{ Name: "email", Value: EMAIL }, { Name: "email_verified", Value: "true" }, { Name: 7, Value: "x" }, null] },
      { Username: "google_1", UserStatus: 3, Enabled: "yes" },
      { UserStatus: "CONFIRMED" },
      null,
    ];
    const c = client(() => new Response(JSON.stringify({ Users: users }), { status: 200 }));
    expect(await c.listUsersByEmail(POOL, EMAIL)).toEqual({
      users: [
        { username: NATIVE, status: "CONFIRMED", enabled: true, attributes: { email: EMAIL, email_verified: "true" } },
        { username: "google_1", status: "", enabled: false, attributes: {} },
      ],
      more: false,
    });
    expect(c.first().url).toBe(`https://cognito-idp.${REGION}.amazonaws.com/`);
    expect((c.first().init.headers as Record<string, string>).authorization).toMatch(new RegExp(`/${REGION}/cognito-idp/aws4_request, `));
    expect(c.sent()).toEqual({ target: "AWSCognitoIdentityProviderService.ListUsers", body: { UserPoolId: POOL, Filter: `email = "${EMAIL}"`, Limit: 60 } });
  });

  it("says when there's more than one page, and copes with an answer without users", async () => {
    expect(await client(() => new Response(JSON.stringify({ Users: [], PaginationToken: "next" }))).listUsersByEmail(POOL, EMAIL)).toEqual({ users: [], more: true });
    expect(await client(() => new Response(JSON.stringify({ PaginationToken: "" }))).listUsersByEmail(POOL, EMAIL)).toEqual({ users: [], more: false });
    expect(await client(() => new Response("not json")).listUsersByEmail(POOL, EMAIL)).toEqual({ users: [], more: false });
  });

  it("refuses an email that would need escaping in the filter, without calling Cognito", async () => {
    const c = client(() => new Response("{}"));
    for (const email of ['a"@example.com', "a\\@example.com"]) await expect(c.listUsersByEmail(POOL, email)).rejects.toThrow("can't contain a quotation mark or backslash");
    expect(c.calls).toEqual([]);
  });

  it("records attributes with AdminUpdateUserAttributes", async () => {
    const c = client(() => new Response("{}"));
    await c.updateUserAttributes(POOL, NATIVE, { [LINKED_EMAIL_ATTRIBUTE]: EMAIL });
    expect(c.sent()).toEqual({
      target: "AWSCognitoIdentityProviderService.AdminUpdateUserAttributes",
      body: { UserPoolId: POOL, Username: NATIVE, UserAttributes: [{ Name: LINKED_EMAIL_ATTRIBUTE, Value: EMAIL }] },
    });
  });

  it("links the provider identity to the native user by its username", async () => {
    const c = client(() => new Response("{}"));
    await c.linkProviderForUser(POOL, NATIVE, "Google", GOOGLE_ID);
    expect(c.sent()).toEqual({
      target: "AWSCognitoIdentityProviderService.AdminLinkProviderForUser",
      body: {
        UserPoolId: POOL,
        DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: NATIVE },
        SourceUser: { ProviderName: "Google", ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: GOOGLE_ID },
      },
    });
  });

  it("throws with Cognito's error type only, never its message", async () => {
    const c = client(() => new Response(JSON.stringify({ __type: "com.amazonaws#InvalidParameterException", message: `User ${EMAIL} already linked` }), { status: 400 }));
    await expect(c.linkProviderForUser(POOL, NATIVE, "Google", GOOGLE_ID)).rejects.toThrow(/^AdminLinkProviderForUser failed: 400 InvalidParameterException$/);
    await expect(c.listUsersByEmail(POOL, EMAIL)).rejects.toThrow(/^ListUsers failed: 400 InvalidParameterException$/);
  });
});

// The journey: a Google or Apple sign-in with the email of an existing
// account. A fake Cognito holds the users: the trigger links the identity, the
// first sign-in fails as it does in Cognito, and the retry signs in as the
// existing user, whom the guard and the email_verified trigger treat as native.
describe("signing in with Google or Apple to an existing account", () => {
  type User = { username: string; status: string; enabled: boolean; attributes: Record<string, string> };

  function fakePool(initial: User[]) {
    const users = new Map(initial.map((u) => [u.username, u]));
    const listUsersByEmail: ListUsersByEmail = async (_pool, email) => ({ users: [...users.values()].filter((u) => u.attributes.email === email), more: false });
    const updateUserAttributes: UpdateUserAttributes = async (_pool, username, attributes) => {
      const user = users.get(username);
      if (!user) throw new Error("AdminUpdateUserAttributes failed: 400 UserNotFoundException");
      Object.assign(user.attributes, attributes);
    };
    const linkProviderForUser: LinkProviderForUser = async (_pool, nativeUsername, providerName, providerUserId) => {
      const user = users.get(nativeUsername);
      if (!user) throw new Error("AdminLinkProviderForUser failed: 400 UserNotFoundException");
      const list = JSON.parse(user.attributes.identities ?? "[]") as unknown[];
      user.attributes.identities = JSON.stringify([...list, { userId: providerUserId, providerName, providerType: providerName, issuer: null, primary: false, dateCreated: 1 }]);
    };
    const linkedTo = (provider: string, id: string) =>
      [...users.values()].find((u) => (JSON.parse(u.attributes.identities ?? "[]") as { providerName: string; userId: string }[]).some((i) => i.providerName === provider && i.userId === id));

    /** A provider sign-in as Cognito runs it: an identity it knows signs in as its user; a new one goes through pre sign-up first. */
    async function providerSignIn(provider: string, id: string, email: string, claim: string, hd: string | null = provider === "Google" ? HD : null): Promise<{ user?: User; error?: string; outcome?: unknown }> {
      const existing = linkedTo(provider, id);
      if (existing) {
        // Cognito applies the attribute mapping at every provider sign-in, email included
        existing.attributes[PROVIDER_EMAIL_VERIFIED_ATTRIBUTE] = claim;
        existing.attributes.email = email;
        return { user: existing };
      }
      const logs: Logged[] = [];
      const handler = createAccountLinkHandler({ listUsersByEmail, updateUserAttributes, linkProviderForUser, obs: fakeObservability(logs) });
      try {
        answerCognito(await handler(signUpEvent({ provider, id, email, claim, hd })));
      } catch (error) {
        return { error: `PreSignUp failed with error ${(error as Error).message}.` };
      }
      const outcome = logs.find((l) => l.message === "Account link")?.data.outcome;
      const user: User = { username: `${provider}_${id}`.toLowerCase(), status: "EXTERNAL_PROVIDER", enabled: true, attributes: { sub: "new-sub", email, identities: identities([provider, id]) } };
      users.set(user.username, user);
      return { user, outcome };
    }
    return { users, providerSignIn };
  }

  const existing = (email = EMAIL, username = NATIVE): User => ({ username, status: "CONFIRMED", enabled: true, attributes: { sub: username, email, email_verified: "true" } });

  for (const [provider, id] of PROVIDERS) {
    const email = emailFor(provider);
    it(`lands a ${provider} sign-in in the existing account after one retry, which stays a native user`, async () => {
      const pool = fakePool([existing(email)]);
      const first = await pool.providerSignIn(provider, id, email, "true");
      expect(first).toEqual({ error: `PreSignUp failed with error ACCOUNT_LINKED:${provider}.` });
      expect(pool.users.size).toBe(1);
      expect(pool.users.get(NATIVE)?.attributes[LINKED_EMAIL_ATTRIBUTE]).toBe(email);

      const { user } = await pool.providerSignIn(provider, id, email, "true");
      if (!user) throw new Error("The retry didn't sign in");
      expect(user.username).toBe(NATIVE);
      expect(user.attributes.sub).toBe(NATIVE);

      // Still a native user: native sign-ins (email code, password, passkey) are let through
      const guardLogs: Logged[] = [];
      const guard = createSignInGuardHandler({ obs: fakeObservability(guardLogs) });
      const signIn = { triggerSource: "PreAuthentication_Authentication", userPoolId: POOL, userName: NATIVE, request: { userAttributes: { ...user.attributes, "cognito:user_status": "CONFIRMED" } }, response: {} };
      await expect(guard(signIn as unknown as PreAuthenticationTriggerEvent)).resolves.toBeDefined();
      expect(guardLogs[0]?.data.outcome).toBe("allowed");

      // And the email_verified trigger leaves its Cognito-verified email alone, whatever the provider says
      const updates: unknown[] = [];
      const verifiedLogs: Logged[] = [];
      const emailVerified = createEmailVerifiedHandler({ updateUserAttributes: async (...args) => { updates.push(args); }, obs: fakeObservability(verifiedLogs) });
      const token = { triggerSource: "TokenGeneration_HostedAuth", userPoolId: POOL, userName: NATIVE, request: { userAttributes: { ...user.attributes, [PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]: "false", "cognito:user_status": "CONFIRMED" } }, response: {} };
      await emailVerified(token as unknown as PreTokenGenerationTriggerEvent);
      expect(updates).toEqual([]);
      expect(verifiedLogs[0]?.data.outcome).toBe("not-federated");
    });

    it(`gives a ${provider} sign-in with an unverified email its own account, never the existing one`, async () => {
      const pool = fakePool([existing(email)]);
      const result = await pool.providerSignIn(provider, id, email, "false");
      expect(result.user?.username).toBe(`${provider}_${id}`.toLowerCase());
      expect(pool.users.get(NATIVE)?.attributes.identities).toBeUndefined();
    });
  }

  it("gives an old Google account still carrying a work address its own account, not the address's current owner's", async () => {
    // A former employee's personal Google account, no Workspace hd, still "verified" for the address
    const pool = fakePool([existing()]);
    const result = await pool.providerSignIn("Google", GOOGLE_ID, EMAIL, "true", null);
    expect(result.outcome).toBe("not-authoritative");
    expect(result.user?.username).toBe(`google_${GOOGLE_ID}`);
    expect(pool.users.get(NATIVE)?.attributes.identities).toBeUndefined();
  });

  it("doesn't let an account whose linked provider email changed capture that address's owner's sign-in", async () => {
    const attacker = "8f0e5b1c-0000-4000-8000-00000000000a";
    const pool = fakePool([existing(ICLOUD, attacker)]);
    // The attacker links their Apple ID, whose email then changes to the victim's Gmail address
    expect((await pool.providerSignIn("SignInWithApple", APPLE_ID, ICLOUD, "true")).error).toContain("ACCOUNT_LINKED");
    expect((await pool.providerSignIn("SignInWithApple", APPLE_ID, GMAIL, "true")).user?.username).toBe(attacker);
    expect(pool.users.get(attacker)?.attributes).toMatchObject({ email: GMAIL, email_verified: "true", [LINKED_EMAIL_ATTRIBUTE]: ICLOUD });
    // The victim's first Google sign-in isn't linked into the attacker's account
    const victim = await pool.providerSignIn("Google", GOOGLE_ID, GMAIL, "true", null);
    expect(victim.error).toBeUndefined();
    expect(victim.outcome).toBe("email-changed");
    expect(victim.user?.username).toBe(`google_${GOOGLE_ID}`);
  });

  it("doesn't let an unconfirmed sign-up with someone's address capture their Google sign-in", async () => {
    const squatter: User = { username: NATIVE, status: "UNCONFIRMED", enabled: true, attributes: { sub: NATIVE, email: EMAIL, email_verified: "false" } };
    const pool = fakePool([squatter]);
    const result = await pool.providerSignIn("Google", GOOGLE_ID, EMAIL, "true");
    expect(result.user?.username).toBe(`google_${GOOGLE_ID}`);
    expect(squatter.attributes.identities).toBeUndefined();
  });
});
