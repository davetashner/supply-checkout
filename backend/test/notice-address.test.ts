// Recording the address an email change is told to where a verified address
// first appears (supply-checkout-8jc.31): the rule (noticeAddressOf, the same
// as GET /me's), the post confirmation trigger, the pre token generation
// trigger, and the pool listing the owner's backfill reads. The table is the
// in-memory one, behind a stand-in for the triggers' IAM policy.

import type { PostConfirmationTriggerEvent, PreTokenGenerationTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { emailVerifiedFrom } from "../src/api/cognito-user.js";
import { emailSeenHash, hasNoticeAddress, noticeAddress, recordNoticeAddress } from "../src/data/index.js";
import { keys } from "../src/data/keys.js";
import { NOTICE_ADDRESS_CHECK_ATTRIBUTES, NOTICE_ADDRESS_RECORD_ATTRIBUTES, SECURITY_NOTICE_ATTRIBUTES } from "../src/data/schema.js";
import { listPoolUsers } from "../src/identity/cognito-admin.js";
import { createEmailVerifiedHandler, NOTICE_CALL_TIMEOUT_MS, settledAttributes, WRITE_BUDGET_MS } from "../src/identity/email-verified-handler.js";
import { DOWNGRADE_PENDING_ATTRIBUTE, LINKED_EMAIL_ATTRIBUTE, PROVIDER_EMAIL_VERIFIED_ATTRIBUTE } from "../src/identity/names.js";
import { noticeAddressOf, noticeAddressRecorder, type RememberNoticeAddress } from "../src/identity/notice-address.js";
import { createPostConfirmationHandler } from "../src/identity/post-confirmation-handler.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const POOL = "test-local-1_AppPool1";
const SUB = "4f1c2b7e-9a3d-4e5f-8b6a-1c2d3e4f5a6b";
const EMAIL = "Owner@Example.com";
const GOOGLE_ID = "107691234567890123456";
const NOW = Date.parse("2026-10-01T09:00:00Z");

type Logged = { level: string; message: string; data: Record<string, unknown> };

let table: MemoryTable;
let denied: { command: string; input: Record<string, unknown> }[];
let logs: Logged[];
let metrics: { metric: string; metadata: Record<string, unknown> }[];

/**
 * The triggers' IAM policy for NOTICE_ADDRESS: GetItem projected to
 * NOTICE_ADDRESS_CHECK_ATTRIBUTES, UpdateItem naming only
 * NOTICE_ADDRESS_RECORD_ATTRIBUTES and returning nothing, and ConditionCheckItem
 * naming only the keys (the DELETING mark), in USER# partitions only.
 */
function policy(command: string, input: Record<string, unknown>): boolean {
  const one = (kind: string, body: Record<string, unknown>) => {
    const key = (body.Key ?? {}) as { PK?: unknown };
    const names = Object.values((body.ExpressionAttributeNames ?? {}) as Record<string, string>);
    const allowed = new Set<string>(kind === "GetCommand" ? NOTICE_ADDRESS_CHECK_ATTRIBUTES : NOTICE_ADDRESS_RECORD_ATTRIBUTES);
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
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push({ level, message, data });
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1, metadata = {}) => {
      expect(value).toBe(1);
      metrics.push({ metric, metadata });
    },
    gauge: () => {},
    flush: () => {},
  };
}

const native = (over: Record<string, string> = {}): Record<string, string> => ({ sub: SUB, email: EMAIL, email_verified: "true", "cognito:user_status": "CONFIRMED", ...over });
const googleIdentities = JSON.stringify([{ userId: GOOGLE_ID, providerName: "Google", providerType: "Google", issuer: null, primary: true, dateCreated: 1 }]);
const GOOGLE_USER = `google_${GOOGLE_ID}`;

beforeEach(() => {
  table = new MemoryTable();
  denied = [];
  logs = [];
  metrics = [];
});

const recorded = () => table.get(`USER#${SUB}`, "NOTICE_ADDRESS");

describe("schema", () => {
  it("lets the triggers read only when an address was recorded, and write only the address record", () => {
    expect([...NOTICE_ADDRESS_CHECK_ATTRIBUTES]).toEqual(["PK", "SK", "noticeAddressAt"]);
    expect([...NOTICE_ADDRESS_RECORD_ATTRIBUTES]).toEqual(["PK", "SK", "noticeAddress", "noticeAddressAt", "noticeSeenHash"]);
    for (const name of [...NOTICE_ADDRESS_CHECK_ATTRIBUTES, ...NOTICE_ADDRESS_RECORD_ATTRIBUTES]) expect(SECURITY_NOTICE_ATTRIBUTES).toContain(name);
  });
});

describe("noticeAddressOf: GET /me's rule", () => {
  it("is the normalized address and the hash of Cognito's own, for a native user with a verified email", () => {
    expect(noticeAddressOf(SUB, native())).toEqual({ userId: SUB, address: "owner@example.com", seen: emailSeenHash(EMAIL) });
    // NFKC folds the fullwidth letter for the address the app uses; the hash keeps Cognito's own
    const folded = noticeAddressOf(SUB, native({ email: "owner@examplｅ.com" }));
    expect(folded?.address).toBe("owner@example.com");
    expect(folded?.seen).not.toBe(emailSeenHash("owner@example.com"));
  });

  it("is undefined whenever the account API wouldn't trust the email", () => {
    const cases: [string, unknown, Record<string, string>][] = [
      ["unverified", SUB, native({ email_verified: "false" })],
      ["downgrade pending", SUB, native({ [DOWNGRADE_PENDING_ATTRIBUTE]: "1" })],
      ["linked, not the recorded email", SUB, native({ identities: googleIdentities, [LINKED_EMAIL_ATTRIBUTE]: "someone@example.com" })],
      ["linked, nothing recorded", SUB, native({ identities: googleIdentities })],
      // The trigger's event says EXTERNAL_PROVIDER, GetUser doesn't: the username isn't the identity's, so the API counts it as linked
      ["EXTERNAL_PROVIDER, not the identity's username", SUB, native({ identities: googleIdentities, "cognito:user_status": "EXTERNAL_PROVIDER" })],
      ["no email", SUB, { sub: SUB, email_verified: "true" }],
      ["an address the app can't normalize", SUB, native({ email: `${"a".repeat(250)}@example.com` })],
      ["not an address", SUB, native({ email: "owner" })],
      ["no sub", SUB, native({ sub: "" })],
      ["a sub that isn't a Cognito sub", SUB, native({ sub: "USER#x" })],
    ];
    for (const [name, username, attributes] of cases) {
      expect(noticeAddressOf(username, attributes), name).toBeUndefined();
      // Never more trusting than the API
      if (attributes.sub === SUB && attributes.email && !name.startsWith("an address") && name !== "not an address") {
        const asGetUser = Object.fromEntries(Object.entries(attributes).filter(([k]) => k !== "cognito:user_status"));
        expect(emailVerifiedFrom(username, asGetUser), name).toBe(false);
      }
    }
  });

  it("trusts a linked user's recorded email and a Google or Apple user's verified one", () => {
    expect(noticeAddressOf(SUB, native({ identities: googleIdentities, [LINKED_EMAIL_ATTRIBUTE]: "owner@example.com" }))?.address).toBe("owner@example.com");
    expect(noticeAddressOf(GOOGLE_USER, native({ identities: googleIdentities, "cognito:user_status": "EXTERNAL_PROVIDER" }))?.address).toBe("owner@example.com");
  });
});

describe("noticeAddressRecorder", () => {
  const remember = () => noticeAddressRecorder(table.guarded(policy), { now: () => NOW, timeoutMs: 1_000 });

  it("records the address once, with the hash of Cognito's address, reading only when one was recorded", async () => {
    expect(await remember()(SUB, native())).toBe("recorded");
    expect(recorded()).toMatchObject({ noticeAddress: "owner@example.com", noticeSeenHash: emailSeenHash(EMAIL), noticeAddressAt: new Date(NOW).toISOString() });
    expect(await remember()(SUB, native({ email: "new@example.com" }))).toBe("present");
    expect(denied).toEqual([]);
    // No read ever asked for the address itself
    const reads = table.requests.filter((r) => r.command === "GetCommand").map((r) => JSON.stringify(r.input));
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(read).not.toContain('"noticeAddress"');
    expect((await noticeAddress(table.db(), SUB))?.address).toBe("owner@example.com");
  });

  it("never records an address the API doesn't trust, or for an account being deleted", async () => {
    expect(await remember()(SUB, native({ email_verified: "false" }))).toBe("untrusted");
    expect(table.requests).toEqual([]);
    table.put({ ...keys.accountDeletion(SUB), type: "accountDeletion" });
    expect(await remember()(SUB, native())).toBe("not-recorded");
    expect(recorded()).toBeUndefined();
    expect(denied).toEqual([]);
  });

  it("never overwrites an address recorded between its read and its write", async () => {
    table.afterGet = () => {
      table.afterGet = undefined;
      table.put({ ...keys.noticeAddress(SUB), noticeAddress: "first@example.com", noticeAddressAt: "then", noticeSeenHash: emailSeenHash("first@example.com") });
    };
    expect(await remember()(SUB, native())).toBe("not-recorded");
    expect(recorded()?.noticeAddress).toBe("first@example.com");
  });

  it("counts a cancelled write as not recorded only when a condition failed, and throws a conflict or throttle", async () => {
    const cancelled = (codes: string[] | undefined) => Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", ...(codes ? { CancellationReasons: codes.map((Code) => ({ Code })) } : {}) });
    const attempt = (error: Error) => {
      table.beforeTransactWrite = () => {
        table.beforeTransactWrite = undefined;
        throw error;
      };
      return recordNoticeAddress(table.db(), SUB, "owner@example.com", emailSeenHash(EMAIL), new Date(NOW));
    };
    expect(await attempt(cancelled(["ConditionalCheckFailed", "None"]))).toBe(false);
    expect(await attempt(cancelled(["None", "ConditionalCheckFailed"]))).toBe(false);
    for (const codes of [["None", "TransactionConflict"], ["ConditionalCheckFailed", "ThrottlingError"], ["None", "None"], [], undefined]) {
      await expect(attempt(cancelled(codes)), JSON.stringify(codes)).rejects.toThrow("Transaction cancelled");
    }
    await expect(attempt(Object.assign(new Error("slow down"), { name: "ProvisionedThroughputExceededException" }))).rejects.toThrow("slow down");
    expect(recorded()).toBeUndefined();
  });

  it("has hasNoticeAddress say no for a record without its time, so the conditional write decides", async () => {
    table.put({ ...keys.noticeAddress(SUB) });
    expect(await hasNoticeAddress(table.db(), SUB)).toBe(false);
    expect(await recordNoticeAddress(table.db(), SUB, "owner@example.com", emailSeenHash(EMAIL), new Date(NOW), { timeoutMs: 1_000 })).toBe(true);
    expect(await hasNoticeAddress(table.db(), SUB, { timeoutMs: 1_000 })).toBe(true);
  });
});

describe("post confirmation trigger", () => {
  const event = (attributes: Record<string, string>, triggerSource = "PostConfirmation_ConfirmSignUp") =>
    ({
      version: "1",
      triggerSource,
      region: REGION,
      userPoolId: POOL,
      userName: SUB,
      callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "web" },
      request: { userAttributes: attributes },
      response: {},
    }) as unknown as PostConfirmationTriggerEvent;

  it("records a native user's address when they confirm their sign-up, before they have a token, logging no email or sub", async () => {
    const handler = createPostConfirmationHandler({ rememberNoticeAddress: noticeAddressRecorder(table.guarded(policy), { now: () => NOW }), obs: fakeObservability() });
    const confirmed = event(native());
    expect(await handler(confirmed)).toBe(confirmed);
    expect(recorded()?.noticeAddress).toBe("owner@example.com");
    expect(logs).toEqual([{ level: "info", message: "Notice address", data: { triggerSource: "PostConfirmation_ConfirmSignUp", outcome: "recorded" } }]);
    await handler(event(native(), "PostConfirmation_ConfirmForgotPassword"));
    expect(logs[1]?.data).toEqual({ triggerSource: "PostConfirmation_ConfirmForgotPassword", outcome: "present" });
    expect(JSON.stringify(logs)).not.toMatch(/example\.com|4f1c2b7e/i);
    expect(metrics).toEqual([]);
  });

  it("records nothing for an email not verified yet, or an event without attributes", async () => {
    const handler = createPostConfirmationHandler({ rememberNoticeAddress: noticeAddressRecorder(table.guarded(policy)), obs: fakeObservability() });
    await handler(event(native({ email_verified: "false" })));
    const bare = event({});
    (bare as unknown as { request: unknown }).request = undefined;
    await handler(bare);
    expect(recorded()).toBeUndefined();
    expect(logs.map((l) => l.data.outcome)).toEqual(["untrusted", "untrusted"]);
  });

  it("never fails the confirmation: a failure is logged with the error's name only and counted", async () => {
    for (const failure of [Object.assign(new Error("owner@example.com went wrong"), { name: "ProvisionedThroughputExceededException" }), "odd"]) {
      logs = [];
      metrics = [];
      const handler = createPostConfirmationHandler({
        rememberNoticeAddress: async () => {
          throw failure;
        },
        obs: fakeObservability(),
      });
      const confirmed = event(native());
      expect(await handler(confirmed)).toBe(confirmed);
      expect(logs).toEqual([
        { level: "error", message: "Notice address not recorded", data: { code: failure instanceof Error ? "ProvisionedThroughputExceededException" : "Unknown" } },
        { level: "info", message: "Notice address", data: { triggerSource: "PostConfirmation_ConfirmSignUp", outcome: "failed" } },
      ]);
      expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "emailChanged", reason: "record_address", via: "sign-up" } }]);
    }
  });
});

describe("pre token generation trigger", () => {
  const tokenEvent = (userName: string, attributes: Record<string, string>, triggerSource = "TokenGeneration_RefreshTokens") =>
    ({
      version: "1",
      triggerSource,
      region: REGION,
      userPoolId: POOL,
      userName,
      callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "web" },
      request: { userAttributes: attributes, groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] } },
      response: { claimsOverrideDetails: {} },
    }) as unknown as PreTokenGenerationTriggerEvent;

  function trigger(options: { remember?: RememberNoticeAddress; now?: () => number; proven?: string; failUpdates?: boolean } = {}) {
    const seen: { username: unknown; attributes: Record<string, string | undefined> }[] = [];
    const real = noticeAddressRecorder(table.guarded(policy), { now: () => NOW });
    const remember: RememberNoticeAddress = async (username, attributes) => {
      seen.push({ username, attributes: { ...attributes } });
      return (options.remember ?? real)(username, attributes);
    };
    const handler = createEmailVerifiedHandler({
      obs: fakeObservability(),
      updateUserAttributes: async () => {
        if (options.failUpdates) throw new Error("AdminUpdateUserAttributes failed: 400 TooManyRequestsException");
      },
      sleep: async () => {},
      provenEmailHash: async () => options.proven,
      rememberNoticeAddress: remember,
      ...(options.now ? { now: options.now } : {}),
    });
    return { handler, seen };
  }
  const logged = () => logs.find((l) => l.message === "Federated email")?.data;

  it("records a native user's verified address at any token, and the log says so without the email", async () => {
    const { handler } = trigger();
    await handler(tokenEvent(SUB, native(), "TokenGeneration_Authentication"));
    expect(recorded()?.noticeAddress).toBe("owner@example.com");
    expect(logged()).toEqual({ triggerSource: "TokenGeneration_Authentication", outcome: "not-provider-sign-in", noticeAddress: "recorded" });
    logs = [];
    await handler(tokenEvent(SUB, native()));
    expect(logged()?.noticeAddress).toBe("present");
    expect(JSON.stringify(logs)).not.toContain("example.com");
    expect(denied).toEqual([]);
  });

  it("records a Google user's address once the trigger has verified it, and not when that write failed", async () => {
    const federated = () => native({ identities: googleIdentities, "cognito:user_status": "EXTERNAL_PROVIDER", email_verified: "false", [PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]: "true" });
    const failing = trigger({ failUpdates: true });
    await failing.handler(tokenEvent(GOOGLE_USER, federated(), "TokenGeneration_HostedAuth"));
    expect(logged()).toMatchObject({ outcome: "failed", noticeAddress: "untrusted" });
    expect(recorded()).toBeUndefined();
    logs = [];
    const { handler } = trigger();
    await handler(tokenEvent(GOOGLE_USER, federated(), "TokenGeneration_HostedAuth"));
    expect(logged()).toMatchObject({ outcome: "verified", noticeAddress: "recorded" });
    expect(recorded()?.noticeAddress).toBe("owner@example.com");
  });

  it("never records an address the trigger has just unverified, or tried to", async () => {
    const vouched = native({ identities: googleIdentities, "cognito:user_status": "EXTERNAL_PROVIDER", [PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]: "false" });
    for (const failUpdates of [false, true]) {
      logs = [];
      const { handler, seen } = trigger({ failUpdates });
      await handler(tokenEvent(GOOGLE_USER, vouched, "TokenGeneration_HostedAuth"));
      expect(logged()).toMatchObject({ outcome: failUpdates ? "downgrade-failed" : "unverified", noticeAddress: "untrusted" });
      expect(seen).toEqual([]);
    }
    // A linked user's rewritten email at a Managed Login sign-in
    logs = [];
    const { handler, seen } = trigger();
    await handler(tokenEvent(SUB, native({ identities: googleIdentities, [LINKED_EMAIL_ATTRIBUTE]: "first@example.com" }), "TokenGeneration_HostedAuth"));
    expect(logged()).toMatchObject({ outcome: "linked-unverified", noticeAddress: "untrusted" });
    expect(seen).toEqual([]);
    expect(recorded()).toBeUndefined();
  });

  it("records a linked user's address once it's the one they proved, and never one they haven't", async () => {
    const linked = native({ identities: googleIdentities, [LINKED_EMAIL_ATTRIBUTE]: "first@example.com", [DOWNGRADE_PENDING_ATTRIBUTE]: "1" });
    const notProven = trigger({ proven: "0".repeat(64) });
    await notProven.handler(tokenEvent(SUB, linked));
    expect(logged()).toMatchObject({ outcome: "linked-downgrade-pending", noticeAddress: "untrusted" });
    expect(recorded()).toBeUndefined();
    logs = [];
    const { verifiedEmailHash } = await import("../src/data/index.js");
    const proven = trigger({ proven: verifiedEmailHash("owner@example.com") });
    await proven.handler(tokenEvent(SUB, linked));
    expect(logged()).toMatchObject({ outcome: "linked-recorded", noticeAddress: "recorded" });
    expect(recorded()?.noticeAddress).toBe("owner@example.com");
  });

  it("leaves it to a later token when there isn't time for both calls in Cognito's 5 seconds", async () => {
    let t = NOW;
    const { handler, seen } = trigger({
      now: () => {
        const at = t;
        t += WRITE_BUDGET_MS - 2 * NOTICE_CALL_TIMEOUT_MS + 1;
        return at;
      },
    });
    await handler(tokenEvent(SUB, native()));
    expect(logged()?.noticeAddress).toBe("deferred");
    expect(seen).toEqual([]);
  });

  it("never fails the token: a failure is logged with the error's name only and counted", async () => {
    const { handler } = trigger({
      remember: async () => {
        throw Object.assign(new Error("owner@example.com"), { name: "TimeoutError" });
      },
    });
    const event = tokenEvent(SUB, native());
    expect(await handler(event)).toBe(event);
    expect(logs).toEqual([
      { level: "error", message: "Notice address not recorded", data: { outcome: "notice-address-failed", code: "TimeoutError" } },
      { level: "info", message: "Federated email", data: { triggerSource: "TokenGeneration_RefreshTokens", outcome: "not-provider-sign-in", noticeAddress: "failed" } },
    ]);
    expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "emailChanged", reason: "record_address", via: "sign-in" } }]);
    // Something thrown that isn't an error
    logs = [];
    const odd = trigger({
      remember: async () => {
        throw "odd";
      },
    });
    await odd.handler(event);
    expect(logs[0]?.data.code).toBe("Unknown");
  });

  it("settles the attributes as this token's writes left them", () => {
    const a = native({ email_verified: "false" });
    expect(settledAttributes("verified", a)).toMatchObject({ email_verified: "true" });
    expect(settledAttributes("linked-recorded", native({ email: " Owner@Example.com ", [DOWNGRADE_PENDING_ATTRIBUTE]: "1" }))).toMatchObject({ [LINKED_EMAIL_ATTRIBUTE]: "owner@example.com", [DOWNGRADE_PENDING_ATTRIBUTE]: "" });
    expect(settledAttributes("linked-recorded", { sub: SUB })).toMatchObject({ [LINKED_EMAIL_ATTRIBUTE]: "" });
    for (const outcome of ["unverified", "downgrade-failed", "linked-unverified"] as const) expect(settledAttributes(outcome, a)).toBeUndefined();
    expect(settledAttributes("unchanged", a)).toBe(a);
  });
});

describe("listPoolUsers", () => {
  it("lists every page of the pool, signed for cognito-idp, with each user's attributes", async () => {
    const bodies: Record<string, unknown>[] = [];
    const pages = [
      { Users: [{ Username: "u1", UserStatus: "CONFIRMED", Enabled: true, Attributes: [{ Name: "sub", Value: SUB }, { Name: "email", Value: EMAIL }, { Name: 7 }] }, null, { Username: 3 }], PaginationToken: "next" },
      { Users: [{ Username: "u2", Enabled: false }], PaginationToken: "" },
    ];
    const fetchStub = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      expect((init.headers as Record<string, string>)["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.ListUsers");
      return new Response(JSON.stringify(pages[bodies.length - 1]), { status: 200 });
    }) as unknown as typeof fetch;
    const users = [];
    for await (const user of listPoolUsers({ region: REGION, userPoolId: POOL, credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }, fetch: fetchStub })) users.push(user);
    expect(users).toEqual([
      { username: "u1", status: "CONFIRMED", enabled: true, attributes: { sub: SUB, email: EMAIL } },
      { username: "u2", status: "", enabled: false, attributes: {} },
    ]);
    expect(bodies).toEqual([
      { UserPoolId: POOL, Limit: 60 },
      { UserPoolId: POOL, Limit: 60, PaginationToken: "next" },
    ]);
  });

  it("stops with Cognito's error type only", async () => {
    const fetchStub = (async () => new Response(JSON.stringify({ __type: "com.amazonaws#NotAuthorizedException", message: "owner@example.com" }), { status: 400 })) as unknown as typeof fetch;
    const users = listPoolUsers({ region: REGION, userPoolId: POOL, credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" }, fetch: fetchStub });
    await expect(users.next()).rejects.toThrow(/^ListUsers failed: 400 NotAuthorizedException$/);
  });
});
