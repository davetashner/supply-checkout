// The pre sign-up trigger that links a first Google or Apple sign-in to an
// existing account with the same email (supply-checkout-0b1), its Cognito
// calls, and the journey: the retried sign-in lands in the same user, which
// the guard and the email_verified trigger then treat as a native user.

import type { PreAuthenticationTriggerEvent, PreSignUpTriggerEvent, PreTokenGenerationTriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { answerCognito, createAccountLinkHandler, FAILED_ERROR, LINKED_MARKER, linkedError, type LinkResult, providerIdentity } from "../src/identity/account-link-handler.js";
import { cognitoLinking, type LinkProviderForUser, type ListUsersByEmail, type PoolUser } from "../src/identity/cognito-admin.js";
import { createEmailVerifiedHandler } from "../src/identity/email-verified-handler.js";
import { PROVIDER_EMAIL_VERIFIED_ATTRIBUTE } from "../src/identity/names.js";
import { createSignInGuardHandler } from "../src/identity/sign-in-guard-handler.js";
import type { Observability } from "../src/observability/index.js";
import { REGION } from "./helpers.js";

const POOL = `${REGION}_pool`;
const GOOGLE_ID = "107691234567890123456";
const APPLE_ID = "001234.0a1b2c3d4e5f.1234";
const NATIVE = "8f0e5b1c-0000-4000-8000-000000000001";
const EMAIL = "pat@example.com";
const RELAY = "x7k2q9m4ab@privaterelay.appleid.com"; // public-safety: allow (a made-up relay address)
const PROVIDERS = [
  ["Google", GOOGLE_ID],
  ["SignInWithApple", APPLE_ID],
] as const;

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
function signUpEvent(options: { provider?: string; id?: string; userName?: string; claim?: unknown; email?: string | null; triggerSource?: string } = {}): PreSignUpTriggerEvent {
  const provider = options.provider ?? "Google";
  const userAttributes: Record<string, string> = {};
  if (options.email !== null) userAttributes.email = options.email ?? EMAIL;
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

function linker(options: { users?: PoolUser[]; more?: boolean; list?: ListUsersByEmail; link?: LinkProviderForUser } = {}) {
  const lookups: { pool: string; email: string }[] = [];
  const links: { pool: string; user: string; provider: string; id: string }[] = [];
  const logs: Logged[] = [];
  const handler = createAccountLinkHandler({
    obs: fakeObservability(logs),
    listUsersByEmail:
      options.list ??
      (async (pool, email) => {
        lookups.push({ pool, email });
        return { users: options.users ?? [], more: options.more ?? false };
      }),
    linkProviderForUser:
      options.link ??
      (async (pool, user, provider, id) => {
        links.push({ pool, user, provider, id });
      }),
  });
  const outcome = () => logs.find((l) => l.message === "Account link")?.data.outcome;
  return { handler, lookups, links, logs, outcome };
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

describe("pre sign-up trigger", () => {
  for (const [provider, id] of PROVIDERS) {
    const yes = provider === "Google" ? [true, "true"] : ["true", "TRUE"];
    it(`links a ${provider} sign-up with a verified email to the one confirmed, verified account with it, and stops the sign-up`, async () => {
      for (const claim of yes) {
        const { handler, lookups, links, logs, outcome } = linker({ users: [nativeUser()] });
        const result = await handler(signUpEvent({ provider, id, claim }));
        expect(result).toEqual({ linked: provider });
        expect(lookups).toEqual([{ pool: POOL, email: EMAIL }]);
        expect(links).toEqual([{ pool: POOL, user: NATIVE, provider, id }]);
        expect(outcome()).toBe("linked");
        expect(logs.find((l) => l.message === "Account link")?.data).toEqual({ triggerSource: "PreSignUp_ExternalProvider", outcome: "linked", provider });
        // Cognito shows this in error_description; the web app signs in again with that provider
        expect(() => answerCognito(result)).toThrow(new Error(`${LINKED_MARKER}:${provider}`));
      }
    });

    it(`never links a ${provider} sign-up whose provider doesn't say the email is verified`, async () => {
      for (const claim of [false, "false", "", "yes", "1", undefined]) {
        const { handler, lookups, links, outcome } = linker({ users: [nativeUser()] });
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

  it("links an Apple private relay address only for Sign in with Apple", async () => {
    const relayUser = nativeUser({ attributes: { email: RELAY } });
    const google = linker({ users: [relayUser] });
    await google.handler(signUpEvent({ provider: "Google", claim: "true", email: RELAY.toUpperCase() }));
    expect(google.lookups).toEqual([]);
    expect(google.outcome()).toBe("relay-email");

    const apple = linker({ users: [relayUser] });
    expect(await apple.handler(signUpEvent({ provider: "SignInWithApple", id: APPLE_ID, claim: "true", email: RELAY }))).toEqual({ linked: "SignInWithApple" });
    expect(apple.links).toEqual([{ pool: POOL, user: NATIVE, provider: "SignInWithApple", id: APPLE_ID }]);
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
    const { handler, lookups, links } = linker({ users: [nativeUser({ attributes: { email: "Pat@Example.com" } })] });
    expect(await handler(signUpEvent({ claim: "true", email: " pat@example.com " }))).toEqual({ linked: "Google" });
    expect(lookups[0]?.email).toBe(EMAIL);
    expect(links).toHaveLength(1);
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

  it("doesn't link a second identity from the same provider, but links another provider", async () => {
    const withGoogle = nativeUser({ attributes: { identities: identities(["Google", "999"]) } });
    const again = linker({ users: [withGoogle] });
    await again.handler(signUpEvent({ claim: "true" }));
    expect(again.links).toEqual([]);
    expect(again.outcome()).toBe("already-linked");

    const apple = linker({ users: [withGoogle] });
    expect(await apple.handler(signUpEvent({ provider: "SignInWithApple", id: APPLE_ID, claim: "true" }))).toEqual({ linked: "SignInWithApple" });

    for (const unreadable of ["not json", JSON.stringify({ providerName: "Google" })]) {
      const { handler, links, outcome } = linker({ users: [nativeUser({ attributes: { identities: unreadable } })] });
      await handler(signUpEvent({ claim: "true" }));
      expect(outcome()).toBe(unreadable === "not json" ? "already-linked" : "linked");
      expect(links).toHaveLength(unreadable === "not json" ? 0 : 1);
    }
    const { handler, outcome } = linker({ users: [nativeUser({ attributes: { identities: JSON.stringify([null, { providerName: "SignInWithApple" }]) } })] });
    await handler(signUpEvent({ claim: "true" }));
    expect(outcome()).toBe("linked");
  });

  it("fails the sign-in, making no account, when Cognito can't be asked or can't link, and logs no email, username or provider ID", async () => {
    const lookupFails = linker({ list: async () => { throw new Error("ListUsers failed: 500 InternalErrorException"); } });
    await expect(lookupFails.handler(signUpEvent({ claim: "true" }))).rejects.toThrow(new Error(FAILED_ERROR));
    expect(lookupFails.logs).toEqual([{ level: "error", message: "Couldn't look for an account to link", data: { provider: "Google", outcome: "lookup-failed", error: "ListUsers failed: 500 InternalErrorException" } }]);

    const linkFails = linker({ users: [nativeUser()], link: async () => { throw new Error("AdminLinkProviderForUser failed: 400 InvalidParameterException"); } });
    await expect(linkFails.handler(signUpEvent({ provider: "SignInWithApple", id: APPLE_ID, claim: "true" }))).rejects.toThrow(new Error(FAILED_ERROR));
    expect(linkFails.logs).toEqual([{ level: "error", message: "Couldn't link the sign-in to the existing account", data: { provider: "SignInWithApple", outcome: "link-failed", error: "AdminLinkProviderForUser failed: 400 InvalidParameterException" } }]);

    const { handler, logs } = linker({ users: [nativeUser()] });
    await handler(signUpEvent({ claim: "true" }));
    const text = JSON.stringify([...logs, ...lookupFails.logs, ...linkFails.logs]);
    for (const secret of [EMAIL, NATIVE, GOOGLE_ID, APPLE_ID, "pat"]) expect(text).not.toContain(secret);
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
    const linkProviderForUser: LinkProviderForUser = async (_pool, nativeUsername, providerName, providerUserId) => {
      const user = users.get(nativeUsername);
      if (!user) throw new Error("AdminLinkProviderForUser failed: 400 UserNotFoundException");
      const list = JSON.parse(user.attributes.identities ?? "[]") as unknown[];
      user.attributes.identities = JSON.stringify([...list, { userId: providerUserId, providerName, providerType: providerName, issuer: null, primary: false, dateCreated: 1 }]);
    };
    const linkedTo = (provider: string, id: string) =>
      [...users.values()].find((u) => (JSON.parse(u.attributes.identities ?? "[]") as { providerName: string; userId: string }[]).some((i) => i.providerName === provider && i.userId === id));

    /** A provider sign-in as Cognito runs it: an identity it knows signs in as its user; a new one goes through pre sign-up first. */
    async function providerSignIn(provider: string, id: string, email: string, claim: string): Promise<{ user?: User; error?: string }> {
      const existing = linkedTo(provider, id);
      if (existing) {
        // Cognito applies the attribute mapping at every provider sign-in
        existing.attributes[PROVIDER_EMAIL_VERIFIED_ATTRIBUTE] = claim;
        return { user: existing };
      }
      const logs: Logged[] = [];
      const handler = createAccountLinkHandler({ listUsersByEmail, linkProviderForUser, obs: fakeObservability(logs) });
      try {
        answerCognito(await handler(signUpEvent({ provider, id, email, claim })));
      } catch (error) {
        return { error: `PreSignUp failed with error ${(error as Error).message}.` };
      }
      const user: User = { username: `${provider}_${id}`.toLowerCase(), status: "EXTERNAL_PROVIDER", enabled: true, attributes: { sub: "new-sub", email, identities: identities([provider, id]) } };
      users.set(user.username, user);
      return { user };
    }
    return { users, providerSignIn };
  }

  const existing = (): User => ({ username: NATIVE, status: "CONFIRMED", enabled: true, attributes: { sub: NATIVE, email: EMAIL, email_verified: "true" } });

  for (const [provider, id] of PROVIDERS) {
    it(`lands a ${provider} sign-in in the existing account after one retry, which stays a native user`, async () => {
      const pool = fakePool([existing()]);
      const first = await pool.providerSignIn(provider, id, EMAIL, "true");
      expect(first).toEqual({ error: `PreSignUp failed with error ACCOUNT_LINKED:${provider}.` });
      expect(pool.users.size).toBe(1);

      const { user } = await pool.providerSignIn(provider, id, EMAIL, "true");
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
      const pool = fakePool([existing()]);
      const result = await pool.providerSignIn(provider, id, EMAIL, "false");
      expect(result.user?.username).toBe(`${provider}_${id}`.toLowerCase());
      expect(pool.users.get(NATIVE)?.attributes.identities).toBeUndefined();
    });
  }

  it("doesn't let an unconfirmed sign-up with someone's address capture their Google sign-in", async () => {
    const squatter: User = { username: NATIVE, status: "UNCONFIRMED", enabled: true, attributes: { sub: NATIVE, email: EMAIL, email_verified: "false" } };
    const pool = fakePool([squatter]);
    const result = await pool.providerSignIn("Google", GOOGLE_ID, EMAIL, "true");
    expect(result.user?.username).toBe(`google_${GOOGLE_ID}`);
    expect(squatter.attributes.identities).toBeUndefined();
  });
});
