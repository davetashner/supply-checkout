// The pre token generation trigger that sets email_verified for Google and
// Apple users from the provider's claim (supply-checkout-6v9), its signed
// Cognito client, and the journey it unlocks: a federated user with a
// verified provider email sees and accepts an invite; one without can't.

import type { PreTokenGenerationTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import type { DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import { type CognitoUser, emailVerifiedFrom } from "../src/api/cognito-user.js";
import type { DataEvent } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { ACCOUNT_ROUTES, routeKey } from "../src/api/routes.js";
import { authorizeTeam, createInvite } from "../src/data/index.js";
import { cognitoAdmin, type UpdateUserAttributes } from "../src/identity/cognito-admin.js";
import { createEmailVerifiedHandler, federatedProvider, LINKED_FAILED_ERROR, providerSaysVerified } from "../src/identity/email-verified-handler.js";
import { FEDERATED_PROVIDERS, LINKED_EMAIL_ATTRIBUTE, PROVIDER_EMAIL_VERIFIED_ATTRIBUTE } from "../src/identity/names.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { REGION, accountPartitions, fakeMailer } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const mails = fakeMailer();
const POOL = `${REGION}_pool`;
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;
const GOOGLE_ID = "107691234567890123456";
const APPLE_ID = "001234.0a1b2c3d4e5f.1234";

type Logged = { level: string; message: string; data: Record<string, unknown> };

function fakeObservability(logs: Logged[] = [], counted: string[] = []): Observability {
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push({ level, message, data });
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1) => {
      for (let i = 0; i < value; i++) counted.push(metric);
    },
    gauge: () => {},
    flush: () => {},
  };
}

const identities = (providerName: string, userId: string, providerType = providerName) =>
  JSON.stringify([{ userId, providerName, providerType, issuer: null, primary: true, dateCreated: 1_700_000_000_000 }]);

/** A trigger event for a federated-only user, as Cognito sends it after applying the attribute mapping. */
function triggerEvent(options: {
  provider?: "Google" | "SignInWithApple";
  userName?: string;
  claim?: unknown;
  emailVerified?: string;
  email?: string | null;
  identities?: string;
  triggerSource?: string;
  /** `cognito:user_status`; null leaves it out. */
  status?: string | null;
}): PreTokenGenerationTriggerEvent {
  const provider = options.provider ?? "Google";
  const id = provider === "Google" ? GOOGLE_ID : APPLE_ID;
  const userAttributes: Record<string, string> = {
    sub: "8f0e5b1c-0000-4000-8000-000000000001",
    identities: options.identities ?? identities(provider, id),
  };
  if (options.status !== null) userAttributes["cognito:user_status"] = options.status ?? "EXTERNAL_PROVIDER";
  if (options.email !== null) userAttributes.email = options.email ?? "pat@example.com";
  // Cognito passes attribute values as strings; a test may pass a raw boolean to check the parser
  if (options.claim !== undefined) userAttributes[PROVIDER_EMAIL_VERIFIED_ATTRIBUTE] = options.claim as string;
  if (options.emailVerified !== undefined) userAttributes.email_verified = options.emailVerified;
  return {
    version: "1",
    triggerSource: options.triggerSource ?? "TokenGeneration_HostedAuth",
    region: REGION,
    userPoolId: POOL,
    // A case-insensitive pool stores federated usernames in lower case
    userName: options.userName ?? `${provider}_${id}`.toLowerCase(),
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "web" },
    request: { userAttributes, groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] } },
    response: { claimsOverrideDetails: {} },
  } as unknown as PreTokenGenerationTriggerEvent;
}

function trigger(update?: UpdateUserAttributes) {
  const calls: { pool: string; user: string; attributes: Record<string, string> }[] = [];
  const logs: Logged[] = [];
  const counted: string[] = [];
  const handler = createEmailVerifiedHandler({
    obs: fakeObservability(logs, counted),
    updateUserAttributes:
      update ??
      (async (pool, user, attributes) => {
        calls.push({ pool, user, attributes: { ...attributes } });
      }),
  });
  return { handler, calls, logs, counted };
}

describe("providerSaysVerified", () => {
  it("is true only for the provider saying yes, as a boolean or text", () => {
    for (const yes of [true, "true", "TRUE", " True "]) expect(providerSaysVerified(yes), String(yes)).toBe(true);
    for (const no of [false, "false", "False", "", "1", "yes", 1, null, undefined, {}, ["true"]]) expect(providerSaysVerified(no), String(no)).toBe(false);
  });
});

describe("federatedProvider", () => {
  it("names the provider of a federated-only user, whatever the username's case", () => {
    expect(federatedProvider(`google_${GOOGLE_ID}`, identities("Google", GOOGLE_ID))).toBe("Google");
    expect(federatedProvider(`Google_${GOOGLE_ID}`, identities("Google", GOOGLE_ID))).toBe("Google");
    expect(federatedProvider(`signinwithapple_${APPLE_ID}`, identities("SignInWithApple", APPLE_ID))).toBe("SignInWithApple");
    expect(FEDERATED_PROVIDERS).toEqual(["Google", "SignInWithApple"]);
  });

  it("is undefined for a native user, a linked native user, another provider, or anything malformed", () => {
    const linked = JSON.stringify([
      { userId: GOOGLE_ID, providerName: "Google", providerType: "Google" },
      null,
      "Google",
    ]);
    const cases: [unknown, unknown][] = [
      ["8f0e5b1c-0000-4000-8000-000000000001", undefined],
      // A native user with Google linked (supply-checkout-0b1): the username isn't the identity's
      ["8f0e5b1c-0000-4000-8000-000000000001", linked],
      [`facebook_${GOOGLE_ID}`, identities("Facebook", GOOGLE_ID)],
      [`corp_${GOOGLE_ID}`, identities("corp", GOOGLE_ID, "OIDC")],
      // Name and type must both be the provider's
      [`google_${GOOGLE_ID}`, identities("Google", GOOGLE_ID, "OIDC")],
      [`google_${GOOGLE_ID}`, identities("Google", "someone-else")],
      ["google_", identities("Google", "")],
      [`google_${GOOGLE_ID}`, JSON.stringify([{ providerName: "Google", providerType: "Google", userId: 107 }])],
      [`google_${GOOGLE_ID}`, "not json"],
      [`google_${GOOGLE_ID}`, JSON.stringify({ providerName: "Google" })],
      [undefined, identities("Google", GOOGLE_ID)],
    ];
    for (const [user, ids] of cases) expect(federatedProvider(user, ids), `${String(user)} ${String(ids)}`).toBeUndefined();
  });
});

describe("pre token generation trigger", () => {
  for (const provider of ["Google", "SignInWithApple"] as const) {
    // Google's claim is a boolean; Apple's is a boolean or the string "true"/"false". Mapped into a string attribute, each arrives as text.
    const yes = provider === "Google" ? [true, "true"] : ["true", true];
    const no = provider === "Google" ? [false, "false"] : ["false", false];

    it(`marks a ${provider} user's email verified when the provider says it is`, async () => {
      for (const claim of yes) {
        const { handler, calls, logs } = trigger();
        const event = triggerEvent({ provider, claim });
        const before = JSON.stringify(event);
        const answer = await handler(event);
        expect(calls, String(claim)).toEqual([{ pool: POOL, user: event.userName, attributes: { email_verified: "true" } }]);
        // The event goes back as it came: no token claims are changed
        expect(JSON.stringify(answer)).toBe(before);
        expect(logs).toEqual([{ level: "info", message: "Federated email", data: { triggerSource: "TokenGeneration_HostedAuth", outcome: "verified", provider } }]);
      }
    });

    it(`leaves a ${provider} user's email unverified when the provider says it isn't, or doesn't say`, async () => {
      for (const claim of [...no, undefined, "", "yes"]) {
        const { handler, calls, logs } = trigger();
        await handler(triggerEvent({ provider, claim }));
        expect(calls, String(claim)).toEqual([]);
        expect(logs[0]?.data.outcome).toBe("unchanged");
      }
    });

    it(`unverifies a ${provider} user whose provider no longer vouches for the email`, async () => {
      for (const claim of [...no, undefined]) {
        const { handler, calls } = trigger();
        const event = triggerEvent({ provider, claim, emailVerified: "true" });
        await handler(event);
        expect(calls, String(claim)).toEqual([{ pool: POOL, user: event.userName, attributes: { email_verified: "false" } }]);
      }
    });

    it(`writes nothing when a ${provider} user's email_verified already matches`, async () => {
      const { handler, calls, logs } = trigger();
      await handler(triggerEvent({ provider, claim: "true", emailVerified: "true" }));
      await handler(triggerEvent({ provider, claim: "false", emailVerified: "false" }));
      expect(calls).toEqual([]);
      expect(logs.map((l) => l.data.outcome)).toEqual(["unchanged", "unchanged"]);
    });
  }

  it("trusts the attribute only at a Managed Login sign-in, not a refresh or an API sign-in", async () => {
    // After sign-in the user can write custom:idp_email_verified themselves; a refresh must not act on it
    for (const triggerSource of ["TokenGeneration_RefreshTokens", "TokenGeneration_Authentication", "TokenGeneration_NewPasswordChallenge", "TokenGeneration_AuthenticateDevice"]) {
      const { handler, calls, logs } = trigger();
      await handler(triggerEvent({ claim: "true", triggerSource }));
      expect(calls, triggerSource).toEqual([]);
      expect(logs[0]?.data).toEqual({ triggerSource, outcome: "not-provider-sign-in" });
    }
  });

  it("leaves native users and linked native users alone, whatever they wrote to the attribute", async () => {
    const native = "8f0e5b1c-0000-4000-8000-000000000001";
    const linked = identities("Google", GOOGLE_ID);
    for (const event of [
      triggerEvent({ claim: "true", userName: native, identities: "[]" }),
      triggerEvent({ claim: "true", userName: native, identities: linked }),
      triggerEvent({ claim: "true", identities: identities("Facebook", GOOGLE_ID), userName: `facebook_${GOOGLE_ID}` }),
    ]) {
      const { handler, calls, logs } = trigger();
      await handler(event);
      expect(calls).toEqual([]);
      expect(logs[0]?.data.outcome).toBe("not-federated");
    }
    const { handler, calls } = trigger();
    const noAttributes = triggerEvent({});
    (noAttributes as unknown as { request: unknown }).request = undefined;
    await handler(noAttributes);
    expect(calls).toEqual([]);
  });

  it("logs a failed downgrade as its own outcome: the user stays verified until a later sign-in", async () => {
    const { handler, logs, counted } = trigger(async () => {
      throw new Error("AdminUpdateUserAttributes failed: 500 InternalErrorException");
    });
    await handler(triggerEvent({ provider: "SignInWithApple", claim: "false", emailVerified: "true" }));
    expect(logs.map((l) => [l.level, l.message, l.data.outcome])).toEqual([
      ["error", "Couldn't mark email unverified; it stays verified", "downgrade-failed"],
      ["info", "Federated email", "downgrade-failed"],
    ]);
    // Its own metric, for the "Email verification not saved" alarm
    expect(counted).toEqual([BusinessMetric.EmailUnverifyFailures]);
  });

  it("acts only for users Cognito marks EXTERNAL_PROVIDER", async () => {
    // A native user named like a provider identity (usernames are email addresses here, but defense in depth)
    for (const status of ["CONFIRMED", "UNCONFIRMED", "FORCE_CHANGE_PASSWORD", "", null]) {
      const { handler, calls, logs } = trigger();
      await handler(triggerEvent({ claim: "true", status }));
      expect(calls, String(status)).toEqual([]);
      expect(logs[0]?.data.outcome).toBe("not-federated");
    }
  });

  it("uses the attribute's last value when a provider sign-in leaves the claim out (accepted risk: Google and Apple always send it)", async () => {
    // Cognito keeps an attribute the provider didn't send, so the event carries whatever was last written.
    // Here that's a stale "true": the trigger can't tell it from the provider's, and promotes.
    const { handler, calls, counted } = trigger();
    const stale = triggerEvent({ claim: "true", emailVerified: "false" });
    await handler(stale);
    expect(calls).toEqual([{ pool: POOL, user: stale.userName, attributes: { email_verified: "true" } }]);
    // A saved update counts no failure
    expect(counted).toEqual([]);
    // A claim that was never mapped at all counts as unverified
    const { handler: again, calls: none } = trigger();
    await again(triggerEvent({ emailVerified: "false" }));
    expect(none).toEqual([]);
  });

  it("does nothing without an email", async () => {
    const { handler, calls, logs } = trigger();
    await handler(triggerEvent({ claim: "true", email: null }));
    expect(calls).toEqual([]);
    expect(logs[0]?.data).toMatchObject({ outcome: "no-email", provider: "Google" });
  });

  it("lets the sign-in go ahead unverified when Cognito refuses, logging no email or username", async () => {
    const { handler, logs, counted } = trigger(async () => {
      throw new Error("AdminUpdateUserAttributes failed: 400 TooManyRequestsException");
    });
    const event = triggerEvent({ claim: "true" });
    expect(await handler(event)).toBe(event);
    expect(counted).toEqual([BusinessMetric.EmailVerifyFailures]);
    expect(logs).toEqual([
      {
        level: "error",
        message: "Couldn't mark email verified",
        data: { provider: "Google", outcome: "failed", error: "AdminUpdateUserAttributes failed: 400 TooManyRequestsException" },
      },
      { level: "info", message: "Federated email", data: { triggerSource: "TokenGeneration_HostedAuth", outcome: "failed", provider: "Google" } },
    ]);
    const text = JSON.stringify(logs);
    expect(text).not.toContain("pat@example.com");
    expect(text).not.toContain(GOOGLE_ID);
  });
});

// supply-checkout-kgw: a native user with Google or Apple linked. Cognito
// rewrites its email from the provider at each provider sign-in and leaves
// email_verified "true"; the trigger keeps email_verified to the recorded address.
describe("pre token generation trigger for a linked user", () => {
  const NATIVE = "8f0e5b1c-0000-4000-8000-000000000001";
  const RECORDED = "pat@example.com";
  const linkedEvent = (options: { email?: string | null; emailVerified?: string; recorded?: string | null; triggerSource?: string; identities?: string } = {}) => {
    const event = triggerEvent({
      userName: NATIVE,
      status: "CONFIRMED",
      claim: "true",
      identities: options.identities ?? identities("Google", GOOGLE_ID),
      email: options.email === undefined ? RECORDED : options.email,
      emailVerified: options.emailVerified ?? "true",
      triggerSource: options.triggerSource,
    });
    if (options.recorded !== null) event.request.userAttributes[LINKED_EMAIL_ATTRIBUTE] = options.recorded ?? RECORDED;
    return event;
  };

  it("leaves a linked user alone while its email is the recorded one, whatever the provider claims, at any token", async () => {
    for (const triggerSource of ["TokenGeneration_HostedAuth", "TokenGeneration_RefreshTokens", "TokenGeneration_Authentication"]) {
      for (const email of [RECORDED, "Pat@Example.COM", ` ${RECORDED} `]) {
        const { handler, calls, logs } = trigger();
        const event = linkedEvent({ email, triggerSource });
        event.request.userAttributes[PROVIDER_EMAIL_VERIFIED_ATTRIBUTE] = "false";
        await handler(event);
        expect(calls, `${triggerSource} ${email}`).toEqual([]);
        expect(logs).toEqual([{ level: "info", message: "Federated email", data: { triggerSource, outcome: "linked-unchanged" } }]);
      }
    }
  });

  it("unverifies a changed email at a Managed Login sign-in, whether or not the provider says it's verified", async () => {
    for (const claim of ["true", "false", undefined]) {
      const { handler, calls, logs, counted } = trigger();
      const event = linkedEvent({ email: "victim@example.org" });
      const attributes = Object.entries(event.request.userAttributes).filter(([name]) => name !== PROVIDER_EMAIL_VERIFIED_ATTRIBUTE);
      if (claim !== undefined) attributes.push([PROVIDER_EMAIL_VERIFIED_ATTRIBUTE, claim]);
      event.request.userAttributes = Object.fromEntries(attributes);
      const before = JSON.stringify(event);
      const answer = await handler(event);
      expect(calls, String(claim)).toEqual([{ pool: POOL, user: NATIVE, attributes: { email_verified: "false" } }]);
      expect(JSON.stringify(answer)).toBe(before);
      expect(logs).toEqual([{ level: "info", message: "Federated email", data: { triggerSource: "TokenGeneration_HostedAuth", outcome: "linked-unverified" } }]);
      expect(counted).toEqual([]);
    }
  });

  it("treats a missing recorded email, or unreadable identities, as a changed email", async () => {
    for (const event of [linkedEvent({ recorded: null }), linkedEvent({ recorded: "" }), linkedEvent({ identities: "not json", email: "victim@example.org" }), linkedEvent({ identities: "{}", email: "victim@example.org" })]) {
      const { handler, calls } = trigger();
      await handler(event);
      expect(calls).toEqual([{ pool: POOL, user: NATIVE, attributes: { email_verified: "false" } }]);
    }
  });

  it("writes nothing for a changed email that's already unverified, or no email", async () => {
    for (const triggerSource of ["TokenGeneration_HostedAuth", "TokenGeneration_RefreshTokens"]) {
      const { handler, calls, logs } = trigger();
      await handler(linkedEvent({ email: "victim@example.org", emailVerified: "false", triggerSource }));
      await handler(linkedEvent({ email: null, triggerSource }));
      expect(calls).toEqual([]);
      expect(logs.map((l) => l.data.outcome)).toEqual(["linked-unchanged", "no-email"]);
    }
  });

  it("fails the sign-in when the downgrade fails, logging no email or username", async () => {
    const { handler, logs, counted } = trigger(async () => {
      throw new Error("AdminUpdateUserAttributes failed: 400 TooManyRequestsException");
    });
    await expect(handler(linkedEvent({ email: "victim@example.org" }))).rejects.toThrow(LINKED_FAILED_ERROR);
    expect(logs).toEqual([
      {
        level: "error",
        message: "Couldn't mark a linked user's changed email unverified; the sign-in fails",
        data: { outcome: "linked-downgrade-failed", error: "AdminUpdateUserAttributes failed: 400 TooManyRequestsException" },
      },
    ]);
    expect(counted).toEqual([BusinessMetric.EmailUnverifyFailures]);
    const text = JSON.stringify(logs);
    for (const secret of ["victim@example.org", RECORDED, NATIVE, GOOGLE_ID]) expect(text).not.toContain(secret);
  });

  it("records a verified new email at a token that can't follow a provider sign-in, in lower case", async () => {
    for (const triggerSource of ["TokenGeneration_RefreshTokens", "TokenGeneration_Authentication", "TokenGeneration_NewPasswordChallenge", "TokenGeneration_AuthenticateDevice"]) {
      const { handler, calls, logs } = trigger();
      await handler(linkedEvent({ email: " Pat.New@Example.com ", triggerSource }));
      expect(calls, triggerSource).toEqual([{ pool: POOL, user: NATIVE, attributes: { [LINKED_EMAIL_ATTRIBUTE]: "pat.new@example.com" } }]);
      expect(logs[0]?.data).toEqual({ triggerSource, outcome: "linked-recorded" });
    }
  });

  it("does nothing at a token source it doesn't know", async () => {
    const { handler, calls, logs } = trigger();
    await handler(linkedEvent({ email: "pat.new@example.com", triggerSource: "TokenGeneration_Future" }));
    expect(calls).toEqual([]);
    expect(logs[0]?.data.outcome).toBe("linked-unchanged");
  });

  it("lets the token go ahead when recording fails, and the API keeps treating the email as unverified", async () => {
    const { handler, logs, counted } = trigger(async () => {
      throw new Error("AdminUpdateUserAttributes failed: 500 InternalErrorException");
    });
    const event = linkedEvent({ email: "pat.new@example.com", triggerSource: "TokenGeneration_RefreshTokens" });
    expect(await handler(event)).toBe(event);
    expect(logs.map((l) => [l.level, l.data.outcome])).toEqual([
      ["error", "linked-record-failed"],
      ["info", "linked-record-failed"],
    ]);
    expect(counted).toEqual([BusinessMetric.EmailVerifyFailures]);
    expect(JSON.stringify(logs)).not.toContain("pat.new@example.com");
  });
});

describe("cognitoAdmin", () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "session" };
  const client = (respond: () => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const update = cognitoAdmin({
      region: REGION,
      credentials,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond();
      }) as typeof fetch,
    });
    return { update, calls };
  };

  it("POSTs AdminUpdateUserAttributes to the region's Cognito endpoint, signed for cognito-idp", async () => {
    const { update, calls } = client(() => new Response("{}", { status: 200 }));
    await update(POOL, "google_1", { email_verified: "true" });
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }];
    expect(url).toBe(`https://cognito-idp.${REGION}.amazonaws.com/`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.AdminUpdateUserAttributes");
    expect(headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/\\d{8}/${REGION}/cognito-idp/aws4_request, `));
    expect(headers["x-amz-security-token"]).toBe("session");
    expect(JSON.parse(init.body as string)).toEqual({ UserPoolId: POOL, Username: "google_1", UserAttributes: [{ Name: "email_verified", Value: "true" }] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws with Cognito's error type only, never its message", async () => {
    const { update } = client(() => new Response(JSON.stringify({ __type: "com.amazonaws#UserNotFoundException", message: "User google_1 does not exist" }), { status: 400 }));
    await expect(update(POOL, "google_1", { email_verified: "true" })).rejects.toThrow(/^AdminUpdateUserAttributes failed: 400 UserNotFoundException$/);
    const { update: broken } = client(() => new Response("<html>", { status: 503 }));
    await expect(broken(POOL, "google_1", { email_verified: "true" })).rejects.toThrow(/^AdminUpdateUserAttributes failed: 503$/);
    const { update: odd } = client(() => new Response(JSON.stringify({ __type: 42 }), { status: 500 }));
    await expect(odd(POOL, "google_1", { email_verified: "true" })).rejects.toThrow(/^AdminUpdateUserAttributes failed: 500$/);
  });

  it("refuses a region that isn't a region name, and defaults to the Lambda's credentials", () => {
    expect(() => cognitoAdmin({ region: "evil.example.com/" })).toThrow("Not an AWS region name");
    expect(typeof cognitoAdmin({ region: REGION })).toBe("function");
  });
});

// The journey: sign in with Google or Apple, then see and accept an invite.
// A fake Cognito holds each user's attributes: the trigger writes them, and
// the account API reads them back with GetUser, as in production.
describe("invites for Google and Apple users", () => {
  const OWNER = "user-owner";
  let users: Map<string, { sub: string; attributes: Record<string, string> }>;
  let table: MemoryTable;
  let handler: ReturnType<typeof createAccountHandler>;
  let now: number;

  beforeEach(() => {
    now = Date.now();
    users = new Map([[OWNER, { sub: OWNER, attributes: { email: "owner@example.com", email_verified: "true" } }]]);
    table = new MemoryTable();
    table.seedTeam("team-a", { [OWNER]: "owner" });
    const dbFor: DbForAccount = (scope) =>
      table.scoped(accountPartitions(scope));
    // GetUser, with the access token standing in for the username
    const userInfo = async (token: string): Promise<CognitoUser> => {
      const user = users.get(token.replace(/^token-/, ""));
      if (!user) throw new ApiError(401, "unauthenticated", "Sign in again");
      return { sub: user.sub, email: user.attributes.email, emailVerified: emailVerifiedFrom(token.replace(/^token-/, ""), user.attributes) };
    };
    handler = createAccountHandler({ dbFor, userInfo, issuerUrl: ISSUER, obs: fakeObservability(), mailer: mails.mailer, now: () => now });
  });

  /** A first sign-in through Managed Login: Cognito creates the user from the provider's claims, then runs the trigger. */
  async function signIn(provider: "Google" | "SignInWithApple", claim: unknown) {
    const event = triggerEvent({ provider, claim });
    const sub = event.request.userAttributes.sub as string;
    users.set(event.userName, { sub, attributes: { ...event.request.userAttributes } });
    const { handler: onToken } = trigger(async (pool, username, attributes) => {
      expect(pool).toBe(POOL);
      Object.assign((users.get(username) as { attributes: Record<string, string> }).attributes, attributes);
    });
    await onToken(event);
    return { username: event.userName, sub };
  }

  async function call(method: string, path: string, username: string, sub: string, body?: unknown) {
    const segments = path.split("/");
    const route = ACCOUNT_ROUTES.find((r) => {
      const parts = r.path.split("/");
      return r.method === method && parts.length === segments.length && parts.every((p, i) => p.startsWith("{") || p === segments[i]);
    });
    const pathParameters: Record<string, string> = {};
    route?.path.split("/").forEach((p, i) => {
      if (p.startsWith("{")) pathParameters[p.slice(1, -1)] = segments[i] as string;
    });
    const claims = { sub, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER, client_id: "web" };
    const response = await handler({
      version: "2.0",
      routeKey: route ? routeKey(route) : `${method} ${path}`,
      rawPath: path,
      rawQueryString: "",
      headers: { authorization: `Bearer token-${username}` },
      pathParameters,
      body: body === undefined ? undefined : JSON.stringify(body),
      isBase64Encoded: false,
      requestContext: {
        http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
        authorizer: { principalId: "", integrationLatency: 0, jwt: { claims, scopes: null } },
      },
    } as unknown as DataEvent);
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
  }

  async function invite() {
    const owner = await authorizeTeam(table.db(), OWNER, "team-a");
    const { invite: made, token } = await createInvite(table.db(), owner, { email: "pat@example.com", role: "contributor" });
    return { inviteId: made.inviteId, token };
  }

  for (const provider of ["Google", "SignInWithApple"] as const) {
    it(`lets a ${provider} user with a verified provider email see and accept an invite`, async () => {
      const { inviteId, token } = await invite();
      const { username, sub } = await signIn(provider, provider === "Google" ? true : "true");
      const me = await call("GET", "/me", username, sub);
      expect(me.body).toMatchObject({ user: { emailVerified: true }, invites: [expect.objectContaining({ id: inviteId, role: "contributor" })] });
      const accepted = await call("POST", `/invites/${inviteId}/accept`, username, sub, { token });
      expect(accepted).toMatchObject({ status: 200, body: { team: { id: "team-a", role: "contributor" } } });
      expect(table.get("TEAM#team-a", `MEMBER#${sub}`)).toMatchObject({ role: "contributor" });
    });

    it(`keeps a ${provider} user with an unverified provider email from seeing or accepting it`, async () => {
      const { inviteId, token } = await invite();
      const { username, sub } = await signIn(provider, provider === "Google" ? false : "false");
      const me = await call("GET", "/me", username, sub);
      expect(me.body).toMatchObject({ user: { emailVerified: false }, invites: [] });
      const refused = await call("POST", `/invites/${inviteId}/accept`, username, sub, { token });
      expect(refused).toMatchObject({ status: 403, body: { error: { code: "permission_denied" } } });
      expect(table.get("TEAM#team-a", `MEMBER#${sub}`)).toBeUndefined();
    });
  }

  it("doesn't show a linked user the invites of the address its provider email was rewritten to (supply-checkout-kgw)", async () => {
    const { inviteId, token } = await invite();
    const linked = "8f0e5b1c-0000-4000-8000-00000000000b";
    // A native user with Google linked; Cognito rewrote its email to the invitee's at a Google sign-in, email_verified still "true"
    const attributes = { sub: linked, email: "pat@example.com", email_verified: "true", identities: identities("Google", GOOGLE_ID), [LINKED_EMAIL_ATTRIBUTE]: "someone@example.net" };
    users.set(linked, { sub: linked, attributes });
    // Even before the trigger has run (or if its write failed), the API doesn't trust it
    expect((await call("GET", "/me", linked, linked)).body).toMatchObject({ user: { emailVerified: false }, invites: [] });
    // The trigger unverifies it at the sign-in
    const { handler: onToken } = trigger(async (_pool, username, update) => {
      Object.assign((users.get(username) as { attributes: Record<string, string> }).attributes, update);
    });
    const event = triggerEvent({ userName: linked, status: "CONFIRMED", identities: attributes.identities, email: attributes.email, emailVerified: "true", claim: "true" });
    event.request.userAttributes[LINKED_EMAIL_ATTRIBUTE] = attributes[LINKED_EMAIL_ATTRIBUTE];
    await onToken(event);
    expect(users.get(linked)?.attributes.email_verified).toBe("false");
    expect((await call("POST", `/invites/${inviteId}/accept`, linked, linked, { token })).status).toBe(403);
  });
});
