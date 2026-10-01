// Security notices for changes made directly against Cognito (supply-checkout-8jc.28,
// supply-checkout-8jc.29): the function EventBridge invokes with CloudTrail's records of
// ChangePassword, VerifySoftwareToken, SetUserMFAPreference, UpdateUserAttributes and
// VerifyUserAttribute on the app pool.
//
// The events are shaped as CloudTrail records user-token Cognito calls (AWS's
// "Amazon Cognito logging in AWS CloudTrail"): no IAM caller (`userIdentity` is
// "Unknown"), the token and passwords HIDDEN_DUE_TO_SECURITY_REASONS, and the user's
// sub, not their username, in additionalEventData. The table is the in-memory one,
// behind a stand-in for the function's IAM policy.

import { beforeEach, describe, expect, it } from "vitest";
import { claimEmailChangeNotice, claimNotice, EMAIL_CHANGE_CLAIM_MS, emailSeenHash, markNoticeSent, moveNoticeAddress, NOTICE_DEDUPE_MS, noticeAddress, recordNoticeAddress, releaseEmailChangeNotice } from "../src/data/index.js";
import { SECURITY_NOTICE_ATTRIBUTES } from "../src/data/schema.js";
import { cognitoAccounts, type PoolAccount } from "../src/identity/cognito-accounts.js";
import { SECURITY_NOTICE_EVENTS } from "../src/identity/names.js";
import { createSecurityNoticesHandler } from "../src/identity/security-notices-handler.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { fakeMailer, REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const POOL = "test-local-1_AppPool1";
const OPS_POOL = "test-local-1_OpsPool1";
const SUB = "4f1c2b7e-9a3d-4e5f-8b6a-1c2d3e4f5a6b";
const OTHER_SUB = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const NOW = Date.parse("2026-09-30T14:06:00Z");
const EVENT_TIME = "2026-09-30T14:05:09Z";
const HIDDEN = "HIDDEN_DUE_TO_SECURITY_REASONS";
const OWNER_EMAIL = "owner@example.com";
const ATTACKER_EMAIL = "attacker@example.net";

const REQUESTS: Record<string, Record<string, unknown>> = {
  ChangePassword: { previousPassword: HIDDEN, proposedPassword: HIDDEN, accessToken: HIDDEN },
  VerifySoftwareToken: { accessToken: HIDDEN, userCode: HIDDEN, friendlyDeviceName: "phone" },
  SetUserMFAPreference: { accessToken: HIDDEN, softwareTokenMfaSettings: { enabled: true, preferredMfa: true } },
  UpdateUserAttributes: { accessToken: HIDDEN, userAttributes: HIDDEN },
  VerifyUserAttribute: { accessToken: HIDDEN, attributeName: "email", code: HIDDEN },
};

/** An EventBridge event for one CloudTrail record of a user-token Cognito call. */
function cloudTrail(eventName: string, detail: Record<string, unknown> = {}) {
  return {
    version: "0",
    id: "7bf73129-1428-4cd3-a780-95db273d1602",
    "detail-type": "AWS API Call via CloudTrail",
    source: "aws.cognito-idp",
    time: EVENT_TIME,
    region: REGION,
    resources: [],
    detail: {
      eventVersion: "1.08",
      userIdentity: { type: "Unknown", principalId: "Anonymous" },
      eventTime: EVENT_TIME,
      eventSource: "cognito-idp.amazonaws.com",
      eventName,
      awsRegion: REGION,
      sourceIPAddress: "192.0.2.1",
      userAgent: "aws-cli/2.17.0 md/command#cognito-idp",
      requestParameters: REQUESTS[eventName] ?? { accessToken: HIDDEN },
      responseElements: null,
      additionalEventData: { sub: SUB, userPoolId: POOL },
      requestID: "5f3e8b2a-7c1d-4e9f-a6b5-3c2d1e0f9a8b",
      eventID: "9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      readOnly: false,
      eventType: "AwsApiCall",
      managementEvent: true,
      eventCategory: "Management",
      ...detail,
    },
  };
}

let table: MemoryTable;
let denied: { command: string; input: Record<string, unknown> }[];
let accounts: Map<string, PoolAccount>;
let lookups: string[];
let lookupFailure: Error | undefined;
let mails: ReturnType<typeof fakeMailer>;
let counts: Record<string, number>;
let metrics: { metric: string; metadata: Record<string, unknown> }[];
let logs: unknown[][];
let now: number;
let handle: ReturnType<typeof createSecurityNoticesHandler>;

/**
 * The function's IAM policy: GetItem (projected) and UpdateItem (nothing returned), SECURITY_NOTICE_ATTRIBUTES
 * only, USER# partitions only, and ConditionCheckItem naming no attribute but the keys (the DELETING mark).
 */
function policy(command: string, input: Record<string, unknown>): boolean {
  const allowed = new Set<string>(SECURITY_NOTICE_ATTRIBUTES);
  const one = (kind: string, body: Record<string, unknown>) => {
    const key = (body.Key ?? {}) as { PK?: unknown };
    const names = Object.values((body.ExpressionAttributeNames ?? {}) as Record<string, string>);
    return (
      ["GetCommand", "UpdateCommand", "Update", "ConditionCheck"].includes(kind) &&
      typeof key.PK === "string" &&
      key.PK.startsWith("USER#") &&
      names.every((n) => allowed.has(n)) &&
      (kind !== "ConditionCheck" || (names.length === 0 && /^attribute_not_exists\(PK\)$/.test(String(body.ConditionExpression)))) &&
      (kind !== "GetCommand" || typeof body.ProjectionExpression === "string") &&
      (body.ReturnValues === undefined || body.ReturnValues === "NONE")
    );
  };
  const ok =
    command === "TransactWriteCommand"
      ? (input.TransactItems as Record<string, Record<string, unknown>>[]).every((op) => Object.entries(op).every(([kind, body]) => one(kind, body)))
      : one(command, input);
  if (!ok) denied.push({ command, input });
  return ok;
}

function fakeObservability(): Observability {
  counts = {};
  metrics = [];
  return {
    region: REGION,
    logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1, metadata = {}) => {
      counts[metric] = (counts[metric] ?? 0) + value;
      metrics.push({ metric, metadata });
    },
    gauge: () => {},
    flush: () => {},
  };
}

const account = (over: Partial<PoolAccount> = {}): PoolAccount => ({ username: SUB, email: OWNER_EMAIL, emailVerified: true, emailVerifiedInCognito: true, totpEnabled: false, ...over });

beforeEach(() => {
  table = new MemoryTable();
  denied = [];
  accounts = new Map([[SUB, account()]]);
  lookups = [];
  lookupFailure = undefined;
  mails = fakeMailer();
  logs = [];
  now = NOW;
  handle = createSecurityNoticesHandler({
    userPoolId: POOL,
    findAccount: async (sub) => {
      lookups.push(sub);
      if (lookupFailure) throw lookupFailure;
      return accounts.get(sub);
    },
    db: table.guarded(policy),
    mailer: mails.mailer,
    obs: fakeObservability(),
    now: () => now,
  });
});

/** Nothing personal in a log line or a metric. */
function expectNothingPersonal() {
  const text = JSON.stringify([logs, metrics]);
  for (const secret of [OWNER_EMAIL, ATTACKER_EMAIL, "owner@", "attacker@", HIDDEN]) expect(text).not.toContain(secret);
}

describe("security notices from CloudTrail", () => {
  it("matches the events the rule sends, each to its notice", () => {
    expect(SECURITY_NOTICE_EVENTS).toEqual({
      ChangePassword: "passwordSet",
      VerifySoftwareToken: "twoStepOn",
      SetUserMFAPreference: "twoStepOn",
      UpdateUserAttributes: "emailChanged",
      VerifyUserAttribute: "emailChanged",
    });
  });

  it("emails the verified address when a password is set directly, with the event's time", async () => {
    await handle(cloudTrail("ChangePassword"));
    expect(lookups).toEqual([SUB]);
    expect(mails.sent).toEqual([{ to: OWNER_EMAIL, input: { kind: "passwordSet", at: "2026-09-30T14:05:09.000Z" }, tags: {} }]);
    expect(counts[BusinessMetric.SecurityNotices]).toBe(1);
    expect(metrics[0]).toEqual({ metric: BusinessMetric.SecurityNotices, metadata: { kind: "passwordSet", via: "cloudtrail" } });
    expect(denied).toEqual([]);
    expectNothingPersonal();
  });

  it("finds the pool ID in requestParameters too, and goes on when the event names none", async () => {
    await handle(cloudTrail("ChangePassword", { requestParameters: { userPoolId: POOL, accessToken: HIDDEN }, additionalEventData: { sub: SUB } }));
    now += NOTICE_DEDUPE_MS + 1000;
    await handle(cloudTrail("ChangePassword", { additionalEventData: { sub: SUB } }));
    expect(mails.sent).toHaveLength(2);
  });

  it("uses the time it runs when the event's time isn't a date", async () => {
    await handle(cloudTrail("ChangePassword", { eventTime: "soon" }));
    expect(mails.sent[0]?.input).toEqual({ kind: "passwordSet", at: new Date(NOW).toISOString() });
  });

  it("turns two-step on only when an authenticator is among the user's MFA methods, once for the two calls of one setup", async () => {
    await handle(cloudTrail("VerifySoftwareToken"));
    expect(mails.sent).toEqual([]);
    accounts.set(SUB, account({ totpEnabled: true }));
    await handle(cloudTrail("SetUserMFAPreference"));
    await handle(cloudTrail("VerifySoftwareToken"));
    expect(mails.sent).toEqual([{ to: OWNER_EMAIL, input: { kind: "twoStepOn", at: "2026-09-30T14:05:09.000Z" }, tags: {} }]);
    expect(logs.some((l) => l[0] === "Security notice already sent")).toBe(true);
    expect(denied).toEqual([]);
  });

  it("sends nothing for a change the account API already emailed, and again once the window has passed", async () => {
    // POST /me/password marks the kind as soon as Cognito has made the change
    await markNoticeSent(table.db(), SUB, "passwordSet", new Date(NOW - 60_000));
    await handle(cloudTrail("ChangePassword"));
    expect(mails.sent).toEqual([]);
    now = NOW - 60_000 + NOTICE_DEDUPE_MS + 1;
    await handle(cloudTrail("ChangePassword"));
    expect(mails.sent).toHaveLength(1);
  });

  it("ignores failed calls, other events, other services and other pools", async () => {
    await handle(cloudTrail("ChangePassword", { errorCode: "NotAuthorizedException", errorMessage: "Incorrect username or password." }));
    await handle(cloudTrail("GetUser"));
    await handle(cloudTrail("constructor"));
    await handle(cloudTrail("ChangePassword", { eventSource: "iam.amazonaws.com" }));
    await handle(cloudTrail("ChangePassword", { additionalEventData: { sub: SUB, userPoolId: OPS_POOL } }));
    await handle(cloudTrail("ChangePassword", { requestParameters: { userPoolId: OPS_POOL } }));
    await handle({});
    expect(lookups).toEqual([]);
    expect(mails.sent).toEqual([]);
    expect(counts).toEqual({});
  });

  it("counts an event with no user (CloudTrail's shape changed) without sending", async () => {
    await handle(cloudTrail("ChangePassword", { additionalEventData: { userPoolId: POOL } }));
    await handle(cloudTrail("ChangePassword", { additionalEventData: null }));
    await handle(cloudTrail("ChangePassword", { additionalEventData: { sub: 'x" or sub = "y', userPoolId: POOL } }));
    expect(lookups).toEqual([]);
    expect(counts[BusinessMetric.SecurityNoticeFailures]).toBe(3);
    expect(metrics.every((m) => m.metadata.reason === "no_user")).toBe(true);
  });

  it("ignores a sub that isn't an app user (the operator pool's, or deleted)", async () => {
    await handle(cloudTrail("ChangePassword", { additionalEventData: { sub: OTHER_SUB } }));
    expect(lookups).toEqual([OTHER_SUB]);
    expect(mails.sent).toEqual([]);
    expect(counts).toEqual({});
  });

  it("counts a failed lookup by its error only, and throws so Lambda tries again", async () => {
    lookupFailure = new Error("ListUsers failed: 400 TooManyRequestsException");
    await expect(handle(cloudTrail("ChangePassword"))).rejects.toThrow("TooManyRequestsException");
    lookupFailure = Object.assign(new Error(`fetch to ${OWNER_EMAIL} failed`), { name: "TypeError" });
    await expect(handle(cloudTrail("ChangePassword"))).rejects.toThrow();
    expect(metrics.map((m) => m.metadata.reason)).toEqual(["lookup_failed", "lookup_failed"]);
    expect(logs.map((l) => (l[1] as { code: string }).code)).toEqual(["ListUsers failed: 400 TooManyRequestsException", "TypeError"]);
    // Nothing claimed: the retry still sends
    lookupFailure = undefined;
    await handle(cloudTrail("ChangePassword"));
    expect(mails.sent).toHaveLength(1);
    expectNothingPersonal();
  });

  it("counts an account with no verified address, and claims nothing", async () => {
    accounts.set(SUB, account({ emailVerified: false }));
    await handle(cloudTrail("ChangePassword"));
    accounts.set(SUB, account({ email: undefined }));
    await handle(cloudTrail("ChangePassword"));
    accounts.set(SUB, account({ email: "not an address" }));
    await handle(cloudTrail("ChangePassword"));
    expect(mails.sent).toEqual([]);
    expect(metrics.map((m) => m.metadata)).toEqual(Array(3).fill({ kind: "passwordSet", reason: "no_address", via: "cloudtrail" }));
    accounts.set(SUB, account());
    await handle(cloudTrail("ChangePassword"));
    expect(mails.sent).toHaveLength(1);
  });

  it("logs a send SES refused with the user ID, kind and error name only", async () => {
    mails.state.fail = "MessageRejected";
    await handle(cloudTrail("ChangePassword"));
    expect(logs).toContainEqual(["Security notice not sent", { userId: SUB, kind: "passwordSet", code: "MessageRejected", via: "cloudtrail" }]);
    expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "passwordSet", reason: "not_sent", via: "cloudtrail" } }]);
    expectNothingPersonal();
  });

  it("keeps only the name of an error that isn't SES's", async () => {
    const mailer = { send: async () => Promise.reject(Object.assign(new Error(`bad ${OWNER_EMAIL}`), { name: "RangeError" })) };
    const h = createSecurityNoticesHandler({ userPoolId: POOL, findAccount: async () => account(), db: table.guarded(policy), mailer, obs: fakeObservability(), now: () => NOW });
    await h(cloudTrail("ChangePassword"));
    expect(logs).toContainEqual(["Security notice not sent", { userId: SUB, kind: "passwordSet", code: "RangeError", via: "cloudtrail" }]);
    const unnamed = { send: async () => Promise.reject(null) };
    const h2 = createSecurityNoticesHandler({ userPoolId: POOL, findAccount: async () => account(), db: new MemoryTable().guarded(policy), mailer: unnamed, obs: fakeObservability(), now: () => NOW });
    await h2(cloudTrail("ChangePassword"));
    expect(logs).toContainEqual(["Security notice not sent", { userId: SUB, kind: "passwordSet", code: "Unknown", via: "cloudtrail" }]);
    expectNothingPersonal();
  });

  describe("email changes (supply-checkout-8jc.29)", () => {
    /** What GET /me records: the trusted address, and Cognito's own as it was. */
    const recorded = (address = OWNER_EMAIL) => recordNoticeAddress(table.db(), SUB, address, emailSeenHash(address));

    it("tells the address the account had before, once, even when the change finished before its events arrived", async () => {
      await recorded();
      // The attacker changed it and verified the new one before CloudTrail's events came
      accounts.set(SUB, account({ email: "Attacker@Example.net" }));
      await handle(cloudTrail("UpdateUserAttributes"));
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent).toEqual([{ to: OWNER_EMAIL, input: { kind: "emailChanged", at: "2026-09-30T14:05:09.000Z" }, tags: {} }]);
      // The record moved on to the new address, so a later change tells it
      expect(await noticeAddress(table.db(), SUB)).toEqual({ address: "attacker@example.net", seen: emailSeenHash(ATTACKER_EMAIL) });
      expect(denied).toEqual([]);
      expectNothingPersonal();
    });

    it("checks on every event, so a password change catches an email change whose own events were missed", async () => {
      await recorded();
      accounts.set(SUB, account({ email: ATTACKER_EMAIL }));
      await handle(cloudTrail("ChangePassword"));
      expect(mails.sent.map((m) => [m.to, m.input.kind])).toEqual([
        [OWNER_EMAIL, "emailChanged"],
        [ATTACKER_EMAIL, "passwordSet"],
      ]);
    });

    it("sends nothing while the new address isn't verified (the pool keeps the old one), or when nothing changed", async () => {
      await recorded();
      await handle(cloudTrail("UpdateUserAttributes"));
      accounts.set(SUB, account({ email: ATTACKER_EMAIL, emailVerified: false, emailVerifiedInCognito: false }));
      await handle(cloudTrail("UpdateUserAttributes"));
      accounts.set(SUB, account({ email: " OWNER@example.com " }));
      await handle(cloudTrail("VerifyUserAttribute"));
      accounts.set(SUB, account({ email: "  " }));
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent).toEqual([]);
      expect(await noticeAddress(table.db(), SUB)).toEqual({ address: OWNER_EMAIL, seen: emailSeenHash(OWNER_EMAIL) });
    });

    it("tells the old address when a linked user's email is changed directly, though the account API doesn't trust the new one", async () => {
      await recorded();
      accounts.set(SUB, account({ email: ATTACKER_EMAIL, emailVerified: false, emailVerifiedInCognito: true }));
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent).toEqual([{ to: OWNER_EMAIL, input: { kind: "emailChanged", at: "2026-09-30T14:05:09.000Z" }, tags: {} }]);
      // A password or two-step notice still goes only where the account API would send it
      await handle(cloudTrail("ChangePassword"));
      expect(mails.sent).toHaveLength(1);
      expect(metrics.at(-1)).toEqual({ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "passwordSet", reason: "no_address", via: "cloudtrail" } });
    });

    // Cognito takes addresses up to 2,048 characters; the app's normalizeEmail refuses over 254
    it("tells the old address of a change to one the app can't normalize, once, and keeps telling the old address", async () => {
      await recorded();
      const long = `${"a".repeat(260)}@example.net`;
      accounts.set(SUB, account({ email: long, emailVerified: false }));
      await handle(cloudTrail("VerifyUserAttribute"));
      await handle(cloudTrail("UpdateUserAttributes"));
      expect(mails.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
      // Marked as told, but the address to tell is still the old, good one
      expect(await noticeAddress(table.db(), SUB)).toEqual({ address: OWNER_EMAIL, seen: emailSeenHash(long) });
      now += NOTICE_DEDUPE_MS + 1000;
      accounts.set(SUB, account({ email: ATTACKER_EMAIL }));
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent.map((m) => m.to)).toEqual([OWNER_EMAIL, OWNER_EMAIL]);
    });

    // NFKC would fold the fullwidth ｏ into the recorded address; Cognito sends to it as it is
    it("tells the old address of a change to one that only normalizes to it", async () => {
      await recorded();
      accounts.set(SUB, account({ email: "\uFF4Fwner@example.com" }));
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent.map((m) => [m.to, m.input.kind])).toEqual([[OWNER_EMAIL, "emailChanged"]]);
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent).toHaveLength(1);
    });

    it("records only an address the account API trusts when it has none", async () => {
      accounts.set(SUB, account({ emailVerified: false, emailVerifiedInCognito: true }));
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(await noticeAddress(table.db(), SUB)).toBeUndefined();
      expect(mails.sent).toEqual([]);
    });

    it("records the address of an account it hasn't seen, and tells nobody", async () => {
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent).toEqual([]);
      expect(await noticeAddress(table.db(), SUB)).toEqual({ address: OWNER_EMAIL, seen: emailSeenHash(OWNER_EMAIL) });
      expect(denied).toEqual([]);
      accounts.set(SUB, account({ email: ATTACKER_EMAIL }));
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
    });

    it("records nothing for an account being deleted", async () => {
      table.put({ PK: `USER#${SUB}`, SK: "DELETING", type: "accountDeletion" });
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(await noticeAddress(table.db(), SUB)).toBeUndefined();
    });

    it("tells the old address once when two events race for the same change; the loser counts it pending and its retry finds it sent", async () => {
      await recorded();
      accounts.set(SUB, account({ email: ATTACKER_EMAIL }));
      const results = await Promise.allSettled([handle(cloudTrail("UpdateUserAttributes")), handle(cloudTrail("VerifyUserAttribute"))]);
      expect(mails.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
      for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toContain("claimed but not sent");
      // Lambda's retry of either finds the record moved on, and sends nothing
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent).toHaveLength(1);
    });

    // An attempt that died between the claim and the send (or a send that hung to the function's timeout)
    it("doesn't take a claim left by an attempt that died for a sent notice: it counts and throws, and the retry after the claim lapses sends", async () => {
      await recorded();
      accounts.set(SUB, account({ email: ATTACKER_EMAIL }));
      expect(await claimEmailChangeNotice(table.db(), SUB, emailSeenHash(ATTACKER_EMAIL), new Date(now))).toBe(true);
      now += 20_000;
      await expect(handle(cloudTrail("VerifyUserAttribute"))).rejects.toThrow("claimed but not sent");
      expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "emailChanged", reason: "pending", via: "cloudtrail" } }]);
      expect(mails.sent).toEqual([]);
      // Lambda's first retry comes about a minute later
      now += EMAIL_CHANGE_CLAIM_MS;
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
      expectNothingPersonal();
    });

    it("gives the claim up when SES takes too long, counts it, and throws for the retry", async () => {
      await recorded();
      accounts.set(SUB, account({ email: ATTACKER_EMAIL }));
      const hanging = createSecurityNoticesHandler({
        userPoolId: POOL,
        findAccount: async (sub) => accounts.get(sub),
        db: table.guarded(policy),
        mailer: { send: () => new Promise(() => {}) },
        obs: fakeObservability(),
        sendTimeoutMs: 5,
        now: () => now,
      });
      await expect(hanging(cloudTrail("VerifyUserAttribute"))).rejects.toMatchObject({ name: "EmailNotSentError", code: "Timeout" });
      expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "emailChanged", reason: "not_sent", via: "cloudtrail" } }]);
      // Released at once: the retry sends
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
      expect(denied).toEqual([]);
    });

    it("still gets the notice out when SES refused it and the claim couldn't be given up", async () => {
      await recorded();
      accounts.set(SUB, account({ email: ATTACKER_EMAIL }));
      mails.state.fail = "TooManyRequestsException";
      table.failingUpdates = (input) => String(input.UpdateExpression).startsWith("REMOVE");
      await expect(handle(cloudTrail("VerifyUserAttribute"))).rejects.toMatchObject({ code: "TooManyRequestsException" });
      mails.state.fail = undefined;
      table.failingUpdates = undefined;
      // The claim is still held: the next try counts it pending, and the one after it lapses sends
      await expect(handle(cloudTrail("VerifyUserAttribute"))).rejects.toThrow("claimed but not sent");
      now += EMAIL_CHANGE_CLAIM_MS + 1;
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
      expect(metrics.map((m) => m.metadata.reason)).toEqual(["not_sent", "pending", undefined]);
    });

    it("counts a notice SES refused and throws, keeping the record, so Lambda's retry (or a later event) still tells the old address", async () => {
      await recorded();
      accounts.set(SUB, account({ email: ATTACKER_EMAIL }));
      mails.state.fail = "TooManyRequestsException";
      await expect(handle(cloudTrail("VerifyUserAttribute"))).rejects.toMatchObject({ name: "EmailNotSentError", code: "TooManyRequestsException" });
      expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "emailChanged", reason: "not_sent", via: "cloudtrail" } }]);
      expect(await noticeAddress(table.db(), SUB)).toEqual({ address: OWNER_EMAIL, seen: emailSeenHash(OWNER_EMAIL) });
      mails.state.fail = undefined;
      await handle(cloudTrail("VerifyUserAttribute"));
      expect(mails.sent.map((m) => m.to)).toEqual([OWNER_EMAIL]);
      expectNothingPersonal();
    });
  });

  it("counts anything else thrown, such as DynamoDB refusing a call, by its name, and throws it on", async () => {
    const refusing = createSecurityNoticesHandler({
      userPoolId: POOL,
      findAccount: async () => account(),
      db: table.guarded(() => false),
      mailer: mails.mailer,
      obs: fakeObservability(),
      now: () => NOW,
    });
    await expect(refusing(cloudTrail("ChangePassword"))).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "passwordSet", reason: "error", via: "cloudtrail" } }]);
    expect(logs).toContainEqual(["Security notice not sent", { userId: SUB, kind: "passwordSet", code: "AccessDeniedException", via: "cloudtrail" }]);
  });
});

describe("security notice records", () => {
  it("claims a kind once per window, and each kind on its own", async () => {
    const db = table.db();
    const at = new Date(NOW);
    expect(await claimNotice(db, SUB, "passwordSet", at)).toBe(true);
    expect(await claimNotice(db, SUB, "passwordSet", new Date(NOW + NOTICE_DEDUPE_MS - 1))).toBe(false);
    expect(await claimNotice(db, SUB, "twoStepOn", at)).toBe(true);
    expect(await claimNotice(db, SUB, "passwordSet", new Date(NOW + NOTICE_DEDUPE_MS + 1))).toBe(true);
    expect(table.get(`USER#${SUB}`, "NOTICE#passwordSet")).toEqual({ PK: `USER#${SUB}`, SK: "NOTICE#passwordSet", noticeSentAt: new Date(NOW + NOTICE_DEDUPE_MS + 1).toISOString() });
  });

  it("claims an email change notice once per new address while an attempt sends, and gives a claim up only for its address", async () => {
    const db = table.db();
    const at = new Date(NOW);
    expect(await claimEmailChangeNotice(db, SUB, "a", at)).toBe(true);
    expect(await claimEmailChangeNotice(db, SUB, "a", at)).toBe(false);
    expect(await claimEmailChangeNotice(db, SUB, "b", at)).toBe(true);
    await releaseEmailChangeNotice(db, SUB, "a");
    expect(await claimEmailChangeNotice(db, SUB, "b", at)).toBe(false);
    await releaseEmailChangeNotice(db, SUB, "b");
    expect(await claimEmailChangeNotice(db, SUB, "b", at)).toBe(true);
    expect(await claimEmailChangeNotice(db, SUB, "b", new Date(NOW + EMAIL_CHANGE_CLAIM_MS - 1))).toBe(false);
    expect(await claimEmailChangeNotice(db, SUB, "b", new Date(NOW + EMAIL_CHANGE_CLAIM_MS + 1))).toBe(true);
  });

  it("records an address once, and moves it only from the Cognito address it last accounted for", async () => {
    const db = table.db();
    expect(await noticeAddress(db, SUB)).toBeUndefined();
    expect(await recordNoticeAddress(db, SUB, OWNER_EMAIL, "seen-1")).toBe(true);
    expect(await recordNoticeAddress(db, SUB, ATTACKER_EMAIL, "seen-2")).toBe(false);
    expect(await moveNoticeAddress(db, SUB, "seen-2", "seen-3", "x@example.com")).toBe(false);
    expect(await moveNoticeAddress(db, SUB, "seen-1", "seen-2", ATTACKER_EMAIL)).toBe(true);
    expect(await noticeAddress(db, SUB)).toEqual({ address: ATTACKER_EMAIL, seen: "seen-2" });
    await expect(recordNoticeAddress(db, SUB, "", "s")).rejects.toThrow("No address");
    await expect(moveNoticeAddress(db, SUB, "", "s", OWNER_EMAIL)).rejects.toThrow("No address");
    // A record from before the seen hash compares as its own address
    table.put({ PK: `USER#${OTHER_SUB}`, SK: "NOTICE_ADDRESS", noticeAddress: OWNER_EMAIL });
    expect(await noticeAddress(db, OTHER_SUB)).toEqual({ address: OWNER_EMAIL, seen: emailSeenHash(OWNER_EMAIL) });
  });

  it("hashes Cognito's address only trimmed and lowered", () => {
    expect(emailSeenHash(" Owner@Example.COM ")).toBe(emailSeenHash("owner@example.com"));
    expect(emailSeenHash("\uFF4Fwner@example.com")).not.toBe(emailSeenHash("owner@example.com"));
  });

  it("passes on errors other than a failed condition", async () => {
    const broken = table.guarded(() => false);
    await expect(claimNotice(broken, SUB, "passwordSet")).rejects.toThrow("not authorized");
    await expect(claimEmailChangeNotice(broken, SUB, "a")).rejects.toThrow("not authorized");
    await expect(releaseEmailChangeNotice(broken, SUB, "a")).rejects.toThrow("not authorized");
    await expect(recordNoticeAddress(broken, SUB, OWNER_EMAIL, "s")).rejects.toThrow("not authorized");
    await expect(moveNoticeAddress(broken, SUB, "s", "t", ATTACKER_EMAIL)).rejects.toThrow("not authorized");
  });
});

describe("cognitoAccounts", () => {
  /** A fake Cognito endpoint: the calls it got, and its answers by action. */
  function cognito(answers: Record<string, unknown>, status = 200) {
    const calls: { action: string; body: Record<string, unknown> }[] = [];
    const doFetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const action = String(init.headers["x-amz-target"]).split(".").pop() as string;
      calls.push({ action, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify(answers[action] ?? {}), { status });
    }) as unknown as typeof fetch;
    const find = cognitoAccounts({ region: REGION, userPoolId: POOL, fetch: doFetch, credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } });
    return { calls, find };
  }
  const attrs = (o: Record<string, string>) => Object.entries(o).map(([Name, Value]) => ({ Name, Value }));

  it("finds the user by sub, then reads their address and MFA methods", async () => {
    const { calls, find } = cognito({
      ListUsers: { Users: [{ Username: "native-user", Attributes: attrs({ sub: SUB }) }] },
      AdminGetUser: { Username: "native-user", UserAttributes: attrs({ sub: SUB, email: OWNER_EMAIL, email_verified: "true" }), UserMFASettingList: ["SOFTWARE_TOKEN_MFA"] },
    });
    expect(await find(SUB)).toEqual({ username: "native-user", email: OWNER_EMAIL, emailVerified: true, emailVerifiedInCognito: true, totpEnabled: true });
    expect(calls).toEqual([
      { action: "ListUsers", body: { UserPoolId: POOL, Filter: `sub = "${SUB}"`, Limit: 1 } },
      { action: "AdminGetUser", body: { UserPoolId: POOL, Username: "native-user" } },
    ]);
  });

  it("says no user when there's none, or AdminGetUser found someone else, and no authenticator without one", async () => {
    expect(await cognito({ ListUsers: { Users: [] } }).find(SUB)).toBeUndefined();
    expect(await cognito({ ListUsers: {} }).find(SUB)).toBeUndefined();
    const other = cognito({ ListUsers: { Users: [{ Username: "u" }] }, AdminGetUser: { Username: "u", UserAttributes: attrs({ sub: OTHER_SUB }) } });
    expect(await other.find(SUB)).toBeUndefined();
    const plain = cognito({ ListUsers: { Users: [{ Username: "u" }] }, AdminGetUser: { Username: "u", UserAttributes: [{ Name: "sub", Value: SUB }, { Name: 1 }, null] } });
    expect(await plain.find(SUB)).toEqual({ username: "u", email: undefined, emailVerified: false, emailVerifiedInCognito: false, totpEnabled: false });
    // A linked user whose email isn't the recorded one: verified in Cognito, not for the account API
    const linked = cognito({
      ListUsers: { Users: [{ Username: "u" }] },
      AdminGetUser: { Username: "u", UserAttributes: attrs({ sub: SUB, email: ATTACKER_EMAIL, email_verified: "true", identities: '[{"providerName":"Google","userId":"1"}]', "custom:linked_email": OWNER_EMAIL }) },
    });
    expect(await linked.find(SUB)).toMatchObject({ emailVerified: false, emailVerifiedInCognito: true });
  });

  it("refuses anything but a sub, before calling Cognito, and names only the action and error on failure", async () => {
    const { calls, find } = cognito({ ListUsers: { __type: "com.amazonaws#TooManyRequestsException", message: `slow down ${OWNER_EMAIL}` } }, 400);
    await expect(find('x" or email = "y')).rejects.toThrow("Not a Cognito sub");
    expect(calls).toEqual([]);
    await expect(find(SUB)).rejects.toThrow(/^ListUsers failed: 400 TooManyRequestsException$/);
  });
});
