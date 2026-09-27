// The pre token generation trigger that sets email_verified for Google and
// Apple users from the provider's claim (supply-checkout-6v9), its signed
// Cognito client, and the journey it unlocks: a federated user with a
// verified provider email sees and accepts an invite; one without can't.

import type { PreTokenGenerationTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import type { DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import { type CognitoUser, type EmailCodes, emailVerifiedFrom } from "../src/api/cognito-user.js";
import type { DataEvent } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { ACCOUNT_ROUTES, routeKey } from "../src/api/routes.js";
import { authorizeTeam, createInvite, provenEmailHash, verifiedEmailHash } from "../src/data/index.js";
import { cognitoAdmin, type UpdateUserAttributes } from "../src/identity/cognito-admin.js";
import {
  CALL_TIMEOUT_MS,
  createEmailVerifiedHandler,
  federatedProvider,
  LINKED_FAILED_ERROR,
  logCorrelation,
  providerSaysVerified,
  RETRY_PAUSE_MS,
  WRITE_BUDGET_MS,
} from "../src/identity/email-verified-handler.js";
import { DOWNGRADE_PENDING_ATTRIBUTE, FEDERATED_PROVIDERS, LINKED_EMAIL_ATTRIBUTE, PROVIDER_EMAIL_VERIFIED_ATTRIBUTE } from "../src/identity/names.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { REGION, accountPartitions, fakeMailer, unusedEmailCodes } from "./helpers.js";
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

function trigger(update?: UpdateUserAttributes, options: { correlate?: (sub: string) => string; now?: () => number; provenEmailHash?: (sub: string) => Promise<string | undefined> } = {}) {
  const calls: { pool: string; user: string; attributes: Record<string, string> }[] = [];
  const logs: Logged[] = [];
  const counted: string[] = [];
  const pauses: number[] = [];
  const handler = createEmailVerifiedHandler({
    obs: fakeObservability(logs, counted),
    updateUserAttributes:
      update ??
      (async (pool, user, attributes) => {
        calls.push({ pool, user, attributes: { ...attributes } });
      }),
    sleep: async (ms) => {
      pauses.push(ms);
    },
    provenEmailHash: async () => undefined,
    ...options,
  });
  return { handler, calls, logs, counted, pauses };
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
  const linkedEvent = (options: { email?: string | null; emailVerified?: string; recorded?: string | null; triggerSource?: string; identities?: string; pending?: string } = {}) => {
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
    if (options.pending !== undefined) event.request.userAttributes[DOWNGRADE_PENDING_ATTRIBUTE] = options.pending;
    return event;
  };
  const FLAG = { pool: POOL, user: NATIVE, attributes: { [DOWNGRADE_PENDING_ATTRIBUTE]: "1" } };
  const DOWNGRADE = { pool: POOL, user: NATIVE, attributes: { email_verified: "false", [DOWNGRADE_PENDING_ATTRIBUTE]: "" } };
  const FLAG_THEN_DOWNGRADE = [FLAG, DOWNGRADE];
  /** An update that fails for the calls whose attributes `fails` picks, recording every call. */
  const failing = (fails: (attributes: Readonly<Record<string, string>>, n: number) => boolean) => {
    const tried: Record<string, string>[] = [];
    const update: UpdateUserAttributes = async (_pool, _user, attributes) => {
      tried.push({ ...attributes });
      if (fails(attributes, tried.length)) throw new Error("AdminUpdateUserAttributes failed: 400 TooManyRequestsException");
    };
    return { update, tried };
  };
  const isDowngrade = (attributes: Readonly<Record<string, string>>) => attributes.email_verified === "false";

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
      // The flag first, then the downgrade, which clears it in the same write
      expect(calls, String(claim)).toEqual(FLAG_THEN_DOWNGRADE);
      expect(JSON.stringify(answer)).toBe(before);
      expect(logs).toEqual([{ level: "info", message: "Federated email", data: { triggerSource: "TokenGeneration_HostedAuth", outcome: "linked-unverified" } }]);
      expect(counted).toEqual([]);
    }
  });

  it("treats a missing recorded email, or unreadable identities, as a changed email", async () => {
    for (const event of [linkedEvent({ recorded: null }), linkedEvent({ recorded: "" }), linkedEvent({ identities: "not json", email: "victim@example.org" }), linkedEvent({ identities: "{}", email: "victim@example.org" })]) {
      const { handler, calls } = trigger();
      await handler(event);
      expect(calls).toEqual(FLAG_THEN_DOWNGRADE);
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

  it("fails the sign-in when the flag and both tries of the downgrade fail, logging a handle but no email or username", async () => {
    const { update, tried } = failing(() => true);
    const { handler, logs, counted, pauses } = trigger(update, { correlate: logCorrelation("test-key") });
    await expect(handler(linkedEvent({ email: "victim@example.org" }))).rejects.toThrow(LINKED_FAILED_ERROR);
    expect(tried).toEqual([FLAG.attributes, DOWNGRADE.attributes, DOWNGRADE.attributes]);
    expect(pauses).toEqual([RETRY_PAUSE_MS]);
    expect(logs).toEqual([
      {
        level: "warn",
        message: "Couldn't flag a linked user's downgrade as pending; trying the downgrade anyway",
        data: { outcome: "linked-flag-failed", error: "AdminUpdateUserAttributes failed: 400 TooManyRequestsException" },
      },
      {
        level: "error",
        message: "Couldn't mark a linked user's changed email unverified; the sign-in fails",
        data: { outcome: "linked-downgrade-failed", flagged: false, user: logCorrelation("test-key")(NATIVE), error: "AdminUpdateUserAttributes failed: 400 TooManyRequestsException" },
      },
    ]);
    expect(counted).toEqual([BusinessMetric.EmailUnverifyFailures]);
    const text = JSON.stringify(logs);
    for (const secret of ["victim@example.org", RECORDED, NATIVE, GOOGLE_ID]) expect(text).not.toContain(secret);
  });

  it("tries a failed downgrade once more after a pause, and clears the flag when it works", async () => {
    const { update, tried } = failing((attributes, n) => isDowngrade(attributes) && n === 2);
    const { handler, logs, counted, pauses } = trigger(update);
    await handler(linkedEvent({ email: "victim@example.org" }));
    expect(tried).toEqual([FLAG.attributes, DOWNGRADE.attributes, DOWNGRADE.attributes]);
    expect(pauses).toEqual([RETRY_PAUSE_MS]);
    expect(logs).toEqual([{ level: "info", message: "Federated email", data: { triggerSource: "TokenGeneration_HostedAuth", outcome: "linked-unverified" } }]);
    expect(counted).toEqual([]);
  });

  it("doesn't try again when there's no time left in Cognito's 5 seconds", async () => {
    let clock = 0;
    const { update, tried } = failing((attributes) => {
      // Each call takes a whole timeout
      clock += CALL_TIMEOUT_MS * 2;
      return isDowngrade(attributes);
    });
    const { handler, pauses, logs } = trigger(update, { now: () => clock });
    await expect(handler(linkedEvent({ email: "victim@example.org" }))).rejects.toThrow(LINKED_FAILED_ERROR);
    expect(tried).toEqual([FLAG.attributes, DOWNGRADE.attributes]);
    expect(pauses).toEqual([]);
    expect(logs[0]?.data).toMatchObject({ outcome: "linked-downgrade-failed", flagged: true, user: "unavailable" });
    // The worst case with a retry fits: flag, downgrade, pause, downgrade
    expect(3 * CALL_TIMEOUT_MS + RETRY_PAUSE_MS).toBeLessThanOrEqual(WRITE_BUDGET_MS);
    expect(WRITE_BUDGET_MS).toBeLessThan(5_000);
  });

  it("still downgrades when the flag can't be written", async () => {
    const { update, tried } = failing((attributes) => !isDowngrade(attributes));
    const { handler, logs } = trigger(update);
    await handler(linkedEvent({ email: "victim@example.org" }));
    expect(tried).toEqual([FLAG.attributes, DOWNGRADE.attributes]);
    expect(logs.map((l) => [l.level, l.data.outcome])).toEqual([
      ["warn", "linked-flag-failed"],
      ["info", "linked-unverified"],
    ]);
  });

  it("never records the address after a failed downgrade left the flag set, at any token", async () => {
    // The flag went through, both tries of the downgrade didn't: Cognito's user now has the flag
    const { update, tried } = failing(isDowngrade);
    const { handler: signIn } = trigger(update);
    await expect(signIn(linkedEvent({ email: "victim@example.org" }))).rejects.toThrow(LINKED_FAILED_ERROR);
    expect(tried).toEqual([FLAG.attributes, DOWNGRADE.attributes, DOWNGRADE.attributes]);
    for (const triggerSource of ["TokenGeneration_RefreshTokens", "TokenGeneration_Authentication", "TokenGeneration_NewPasswordChallenge", "TokenGeneration_AuthenticateDevice"]) {
      const { handler, calls, logs } = trigger();
      await handler(linkedEvent({ email: "victim@example.org", pending: "1", triggerSource }));
      expect(calls, triggerSource).toEqual([]);
      expect(logs[0]?.data).toEqual({ triggerSource, outcome: "linked-downgrade-pending" });
    }
    // Nor the API
    const attributes = linkedEvent({ email: "victim@example.org", pending: "1" }).request.userAttributes;
    expect(emailVerifiedFrom(NATIVE, attributes)).toBe(false);
    expect(emailVerifiedFrom(NATIVE, { ...attributes, [LINKED_EMAIL_ATTRIBUTE]: "victim@example.org" })).toBe(false);
    expect(emailVerifiedFrom(NATIVE, { ...attributes, [DOWNGRADE_PENDING_ATTRIBUTE]: "" })).toBe(false);
    expect(emailVerifiedFrom(NATIVE, { ...attributes, [LINKED_EMAIL_ATTRIBUTE]: "victim@example.org", [DOWNGRADE_PENDING_ATTRIBUTE]: " " })).toBe(true);
  });

  it("downgrades a pending user at the next Managed Login token, even if the email is the recorded one, without flagging again", async () => {
    for (const email of ["victim@example.org", RECORDED]) {
      const { handler, calls, logs } = trigger();
      await handler(linkedEvent({ email, pending: "1" }));
      expect(calls, email).toEqual([DOWNGRADE]);
      expect(logs[0]?.data.outcome).toBe("linked-unverified");
    }
  });

  it("clears the flag of a user already unverified, at any token, and leaves it set when that fails", async () => {
    for (const triggerSource of ["TokenGeneration_HostedAuth", "TokenGeneration_RefreshTokens"]) {
      const { handler, calls, logs } = trigger();
      await handler(linkedEvent({ email: "victim@example.org", emailVerified: "false", pending: "1", triggerSource }));
      expect(calls, triggerSource).toEqual([{ pool: POOL, user: NATIVE, attributes: { [DOWNGRADE_PENDING_ATTRIBUTE]: "" } }]);
      expect(logs[0]?.data).toEqual({ triggerSource, outcome: "linked-cleared" });
    }
    const { update } = failing(() => true);
    const { handler, logs, counted } = trigger(update);
    const event = linkedEvent({ email: "victim@example.org", emailVerified: "false", pending: "1", triggerSource: "TokenGeneration_RefreshTokens" });
    expect(await handler(event)).toBe(event);
    expect(logs.map((l) => [l.level, l.data.outcome])).toEqual([
      ["error", "linked-clear-failed"],
      ["info", "linked-clear-failed"],
    ]);
    expect(counted).toEqual([BusinessMetric.EmailVerifyFailures]);
  });

  it("makes a correlation handle that names no user and depends on the key", () => {
    const handle = logCorrelation("key-a")(NATIVE);
    expect(handle).toMatch(/^[0-9a-f]{16}$/);
    expect(logCorrelation("key-a")(NATIVE)).toBe(handle);
    expect(logCorrelation("key-b")(NATIVE)).not.toBe(handle);
    expect(logCorrelation("key-a")(`${NATIVE}x`)).not.toBe(handle);
    expect(NATIVE).not.toContain(handle);
  });

  it("logs the handle as unavailable for an event without a sub", async () => {
    const { update } = failing(() => true);
    const { handler, logs } = trigger(update, { correlate: logCorrelation("test-key") });
    const event = linkedEvent({ email: "victim@example.org" });
    delete event.request.userAttributes.sub;
    await expect(handler(event)).rejects.toThrow(LINKED_FAILED_ERROR);
    expect(logs[1]?.data.user).toBe("unavailable");
  });

  /** A user whose VERIFIED_EMAIL item holds `email`'s hash (POST /me/email/verify), for `sub` only. */
  const provenFor = (email: string, sub = NATIVE) => ({ provenEmailHash: async (s: string) => (s === sub ? verifiedEmailHash(email) : undefined) });

  it("records a code-proven new email at a token that can't follow a provider sign-in, in lower case", async () => {
    for (const triggerSource of ["TokenGeneration_RefreshTokens", "TokenGeneration_Authentication", "TokenGeneration_NewPasswordChallenge", "TokenGeneration_AuthenticateDevice"]) {
      const { handler, calls, logs } = trigger(undefined, provenFor("pat.new@example.com"));
      await handler(linkedEvent({ email: " Pat.New@Example.com ", triggerSource }));
      expect(calls, triggerSource).toEqual([{ pool: POOL, user: NATIVE, attributes: { [LINKED_EMAIL_ATTRIBUTE]: "pat.new@example.com" } }]);
      expect(logs[0]?.data).toEqual({ triggerSource, outcome: "linked-recorded" });
    }
  });

  it("never records a verified-looking email that isn't the one the user last proved (supply-checkout-ytr2)", async () => {
    const cases: [string, Parameters<typeof trigger>[1]][] = [
      ["no item", {}],
      ["another address", provenFor("pat.other@example.com")],
      ["another user's item", provenFor("pat.new@example.com", "8f0e5b1c-0000-4000-8000-00000000ffff")],
    ];
    for (const [name, options] of cases) {
      for (const triggerSource of ["TokenGeneration_RefreshTokens", "TokenGeneration_Authentication"]) {
        const { handler, calls, logs } = trigger(undefined, options);
        await handler(linkedEvent({ email: "pat.new@example.com", triggerSource }));
        expect(calls, `${name} ${triggerSource}`).toEqual([]);
        expect(logs[0]?.data).toEqual({ triggerSource, outcome: "linked-not-proven" });
      }
    }
    // Case folding beyond ASCII doesn't make two addresses one (U+212A KELVIN SIGN)
    const kelvin = trigger(undefined, provenFor("\u212Aat@example.com"));
    await kelvin.handler(linkedEvent({ email: "kat@example.com", triggerSource: "TokenGeneration_RefreshTokens" }));
    expect(kelvin.calls).toEqual([]);
    // Nor for an event without a sub (it's never looked up)
    let looked = 0;
    const { handler, calls } = trigger(undefined, { provenEmailHash: async () => (looked++, verifiedEmailHash("pat.new@example.com")) });
    const event = linkedEvent({ email: "pat.new@example.com", triggerSource: "TokenGeneration_RefreshTokens" });
    delete event.request.userAttributes.sub;
    await handler(event);
    expect([calls, looked]).toEqual([[], 0]);
  });

  it("doesn't look anything up for the recorded email, or at a Managed Login token", async () => {
    let looked = 0;
    const provenEmailHash = async () => (looked++, undefined);
    for (const triggerSource of ["TokenGeneration_RefreshTokens", "TokenGeneration_HostedAuth"]) {
      const { handler } = trigger(undefined, { provenEmailHash });
      await handler(linkedEvent({ triggerSource }));
      await handler(linkedEvent({ email: "pat.new@example.com", triggerSource: "TokenGeneration_HostedAuth" }));
    }
    expect(looked).toBe(0);
  });

  it("clears a pending downgrade with the recording when the email is the proven one, and only then", async () => {
    for (const email of ["pat.new@example.com", RECORDED]) {
      const { handler, calls, logs } = trigger(undefined, provenFor(email));
      await handler(linkedEvent({ email, pending: "1", triggerSource: "TokenGeneration_RefreshTokens" }));
      expect(calls, email).toEqual([{ pool: POOL, user: NATIVE, attributes: { [LINKED_EMAIL_ATTRIBUTE]: email, [DOWNGRADE_PENDING_ATTRIBUTE]: "" } }]);
      expect(logs[0]?.data.outcome).toBe("linked-recorded");
    }
    const { handler, calls, logs } = trigger(undefined, provenFor("pat.other@example.com"));
    await handler(linkedEvent({ email: RECORDED, pending: "1", triggerSource: "TokenGeneration_RefreshTokens" }));
    expect(calls).toEqual([]);
    expect(logs[0]?.data.outcome).toBe("linked-downgrade-pending");
  });

  it("lets the token go ahead when the proven address can't be read, recording nothing", async () => {
    const { handler, calls, logs, counted } = trigger(undefined, {
      provenEmailHash: async () => {
        throw new Error("ProvisionedThroughputExceededException");
      },
    });
    const event = linkedEvent({ email: "pat.new@example.com", triggerSource: "TokenGeneration_RefreshTokens" });
    expect(await handler(event)).toBe(event);
    expect(calls).toEqual([]);
    expect(logs.map((l) => [l.level, l.data.outcome])).toEqual([
      ["error", "linked-lookup-failed"],
      ["info", "linked-lookup-failed"],
    ]);
    expect(counted).toEqual([BusinessMetric.EmailVerifyFailures]);
    expect(JSON.stringify(logs)).not.toContain("pat.new@example.com");
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
    }, provenFor("pat.new@example.com"));
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
  let codesSent: string[];
  let handlerCodes: EmailCodes;

  beforeEach(() => {
    now = Date.now();
    codesSent = [];
    users = new Map([[OWNER, { sub: OWNER, attributes: { email: "owner@example.com", email_verified: "true" } }]]);
    table = new MemoryTable();
    table.seedTeam("team-a", { [OWNER]: "owner" });
    const dbFor: DbForAccount = (scope) =>
      table.scoped(accountPartitions(scope));
    // GetUser, with the access token standing in for the username
    const userInfo = async (token: string): Promise<CognitoUser> => {
      const user = users.get(token.replace(/^token-/, ""));
      if (!user) throw new ApiError(401, "unauthenticated", "Sign in again");
      return {
        sub: user.sub,
        email: user.attributes.email,
        emailVerified: emailVerifiedFrom(token.replace(/^token-/, ""), user.attributes),
        emailVerifiedInCognito: user.attributes.email_verified === "true",
      };
    };
    const emailCodes = {
      ...unusedEmailCodes,
      send: async (token: string) => void codesSent.push(token),
      // VerifyUserAttribute: the right code marks the current email verified
      verify: async (token: string, code: string) => {
        if (code !== "123456") throw new ApiError(400, "bad_request", "That code isn't right", "code_mismatch");
        (users.get(token.replace(/^token-/, "")) as { attributes: Record<string, string> }).attributes.email_verified = "true";
      },
    };
    handlerCodes = emailCodes;
    handler = createAccountHandler({
      dbFor,
      userInfo,
      issuerUrl: ISSUER,
      obs: fakeObservability(),
      mailer: mails.mailer,
      emailCodes: { send: (t) => handlerCodes.send(t), verify: (t, c) => handlerCodes.verify(t, c) },
      now: () => now,
    });
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

  // supply-checkout-ytr2: the whole journey, with the API and the trigger sharing the table
  it("records a linked user's rewritten address only after they prove it with a code in the app, then lists its invites", async () => {
    const { inviteId, token } = await invite();
    const linked = "8f0e5b1c-0000-4000-8000-00000000000d";
    // Cognito rewrote the email to the invitee's at a Google sign-in, and the flag and both downgrades were throttled
    const attributes: Record<string, string> = { sub: linked, email: "pat@example.com", email_verified: "true", identities: identities("Google", GOOGLE_ID), [LINKED_EMAIL_ATTRIBUTE]: "someone@example.net" };
    users.set(linked, { sub: linked, attributes });
    let throttled = true;
    const { handler: onToken, logs } = trigger(
      async (_pool, username, update) => {
        if (throttled) throw new Error("AdminUpdateUserAttributes failed: 400 TooManyRequestsException");
        Object.assign((users.get(username) as { attributes: Record<string, string> }).attributes, update);
      },
      // The trigger's read: its own partition's VERIFIED_EMAIL item, as its role allows
      { provenEmailHash: (sub) => provenEmailHash(table.scoped([`USER#${sub}`]), sub) },
    );
    const refresh = async () => {
      const event = triggerEvent({ userName: linked, status: "CONFIRMED", claim: "true", identities: attributes.identities, triggerSource: "TokenGeneration_RefreshTokens" });
      event.request.userAttributes = { ...attributes, "cognito:user_status": "CONFIRMED" };
      await onToken(event);
      return logs.at(-1)?.data.outcome;
    };
    // Refreshes record nothing, throttled or not, and the API doesn't trust it
    expect(await refresh()).toBe("linked-not-proven");
    throttled = false;
    expect(await refresh()).toBe("linked-not-proven");
    expect((await call("GET", "/me", linked, linked)).body).toMatchObject({ user: { emailVerified: false }, invites: [] });
    // A wrong code records nothing either
    expect((await call("POST", "/me/email/code", linked, linked)).status).toBe(204);
    expect((await call("POST", "/me/email/verify", linked, linked, { code: "654321" })).status).toBe(400);
    expect(table.get(`USER#${linked}`, "VERIFIED_EMAIL")).toBeUndefined();
    expect(await refresh()).toBe("linked-not-proven");
    // The right code: the API records the proven address's hash, never the address
    expect((await call("POST", "/me/email/verify", linked, linked, { code: "123456" })).status).toBe(204);
    const item = table.get(`USER#${linked}`, "VERIFIED_EMAIL");
    expect(item).toMatchObject({ type: "verifiedEmail", verifiedEmailHash: verifiedEmailHash("pat@example.com"), verifiedAt: new Date(now).toISOString() });
    expect(JSON.stringify(item)).not.toContain("pat@");
    // The app's refresh records it, and from then it counts
    expect(await refresh()).toBe("linked-recorded");
    expect(attributes[LINKED_EMAIL_ATTRIBUTE]).toBe("pat@example.com");
    expect((await call("GET", "/me", linked, linked)).body).toMatchObject({ user: { emailVerified: true }, invites: [expect.objectContaining({ id: inviteId })] });
    expect((await call("POST", `/invites/${inviteId}/accept`, linked, linked, { token })).status).toBe(200);
  });

  // supply-checkout-cjw7. This fake Cognito accepts a code for whatever the email is when it's
  // checked, even after a rewrite (undocumented either way): the API mustn't rely on it not doing so.
  describe("a code proves only the address it was sent to", () => {
    const linked = "8f0e5b1c-0000-4000-8000-00000000000e";
    const MINE = "pat.own@example.com";
    const VICTIM = "pat@example.com";
    let attributes: Record<string, string>;
    let checked: number;
    beforeEach(() => {
      attributes = { sub: linked, email: MINE, email_verified: "false", identities: identities("Google", GOOGLE_ID), [LINKED_EMAIL_ATTRIBUTE]: "someone@example.net" };
      users.set(linked, { sub: linked, attributes });
      checked = 0;
      const verify = handlerCodes.verify;
      handlerCodes.verify = async (token, code) => {
        checked++;
        await verify(token, code);
      };
    });
    /** A Google sign-in rewrites the email; the downgrade leaves it unverified. */
    const rewrite = (email = VICTIM) => Object.assign(attributes, { email, email_verified: "false" });
    const proof = () => table.get(`USER#${linked}`, "VERIFIED_EMAIL");
    const sentFor = () => table.get(`USER#${linked}`, "EMAIL_CODE_SENT");
    const refresh = async () => {
      const { handler: onToken, logs } = trigger(async (_pool, _user, update) => void Object.assign(attributes, update), {
        provenEmailHash: (sub) => provenEmailHash(table.scoped([`USER#${sub}`]), sub, { now: () => now }),
      });
      const event = triggerEvent({ userName: linked, status: "CONFIRMED", claim: "true", identities: attributes.identities, triggerSource: "TokenGeneration_RefreshTokens" });
      event.request.userAttributes = { ...attributes, "cognito:user_status": "CONFIRMED" };
      await onToken(event);
      return logs.at(-1)?.data.outcome;
    };
    const emailChanged = { status: 409, body: { error: { code: "aborted", reason: "email_changed" } } };

    it("records nothing when a provider rewrites the email between sending the code and checking it", async () => {
      expect((await call("POST", "/me/email/code", linked, linked)).status).toBe(204);
      expect(sentFor()).toMatchObject({ sentEmailHash: verifiedEmailHash(MINE) });
      rewrite();
      expect(await call("POST", "/me/email/verify", linked, linked, { code: "123456" })).toMatchObject(emailChanged);
      // Cognito wasn't even asked, so it hasn't marked the victim's address verified
      expect(checked).toBe(0);
      expect(attributes.email_verified).toBe("false");
      expect(proof()).toBeUndefined();
      // Even with Cognito showing it verified (say, an operator), nothing records it
      attributes.email_verified = "true";
      expect(await refresh()).toBe("linked-not-proven");
      expect(attributes[LINKED_EMAIL_ATTRIBUTE]).toBe("someone@example.net");
    });

    it("records nothing when a provider rewrites the email between reading it and sending the code", async () => {
      const send = handlerCodes.send;
      handlerCodes.send = async (token) => {
        rewrite();
        await send(token);
      };
      expect(await call("POST", "/me/email/code", linked, linked)).toMatchObject(emailChanged);
      expect(sentFor()).toBeUndefined();
      expect(await call("POST", "/me/email/verify", linked, linked, { code: "123456" })).toMatchObject(emailChanged);
      expect([checked, proof()]).toEqual([0, undefined]);
    });

    it("records nothing when the email changes while the code is checked, or Cognito doesn't mark it verified, and the code's record goes", async () => {
      expect((await call("POST", "/me/email/code", linked, linked)).status).toBe(204);
      const verify = handlerCodes.verify;
      handlerCodes.verify = async (token, code) => {
        await verify(token, code);
        attributes.email = VICTIM;
      };
      expect(await call("POST", "/me/email/verify", linked, linked, { code: "123456" })).toMatchObject(emailChanged);
      expect([proof(), sentFor()]).toEqual([undefined, undefined]);
      // Cognito took the code but GetUser doesn't show the address verified
      Object.assign(attributes, { email: MINE, email_verified: "false" });
      expect((await call("POST", "/me/email/code", linked, linked)).status).toBe(204);
      handlerCodes.verify = async () => {};
      expect(await call("POST", "/me/email/verify", linked, linked, { code: "123456" })).toMatchObject(emailChanged);
      expect([proof(), sentFor()]).toEqual([undefined, undefined]);
    });

    it("records nothing when a code for another address was sent meanwhile", async () => {
      expect((await call("POST", "/me/email/code", linked, linked)).status).toBe(204);
      const verify = handlerCodes.verify;
      handlerCodes.verify = async (token, code) => {
        await verify(token, code);
        // Another session's POST /me/email/code, for another address, lands first
        table.put({ ...(sentFor() as Record<string, unknown>), sentEmailHash: verifiedEmailHash(VICTIM) });
      };
      expect(await call("POST", "/me/email/verify", linked, linked, { code: "123456" })).toMatchObject(emailChanged);
      expect(proof()).toBeUndefined();
    });

    it("counts the same address in another ASCII case, and honours the proof for an hour only", async () => {
      expect((await call("POST", "/me/email/code", linked, linked)).status).toBe(204);
      const verify = handlerCodes.verify;
      handlerCodes.verify = async (token, code) => {
        await verify(token, code);
        attributes.email = "Pat.Own@Example.com";
      };
      expect((await call("POST", "/me/email/verify", linked, linked, { code: "123456" })).status).toBe(204);
      expect(proof()).toMatchObject({ verifiedEmailHash: verifiedEmailHash(MINE) });
      // A refresh more than an hour later doesn't record it; the person verifies again
      now += 60 * 60 * 1000 + 1;
      expect(await refresh()).toBe("linked-not-proven");
      now -= 2;
      expect(await refresh()).toBe("linked-recorded");
      expect(attributes[LINKED_EMAIL_ATTRIBUTE]).toBe("pat.own@example.com");
    });
  });

  it("lets a user whose downgrade is pending ask for a code: they don't count as verified (supply-checkout-0qr8)", async () => {
    const linked = "8f0e5b1c-0000-4000-8000-00000000000c";
    // email_verified still "true" and the email the recorded one, but the downgrade is owed
    users.set(linked, { sub: linked, attributes: { sub: linked, email: "pat@example.com", email_verified: "true", identities: identities("Google", GOOGLE_ID), [LINKED_EMAIL_ATTRIBUTE]: "pat@example.com", [DOWNGRADE_PENDING_ATTRIBUTE]: "1" } });
    expect((await call("GET", "/me", linked, linked)).body).toMatchObject({ user: { emailVerified: false } });
    expect((await call("POST", "/me/email/code", linked, linked)).status).toBe(204);
    expect(codesSent).toEqual([`token-${linked}`]);
    // Without the flag the same user is verified, and is refused as such
    delete users.get(linked)?.attributes[DOWNGRADE_PENDING_ATTRIBUTE];
    expect(await call("POST", "/me/email/code", linked, linked)).toMatchObject({ status: 409, body: { error: { reason: "already_verified" } } });
    expect(codesSent).toHaveLength(1);
  });
});
