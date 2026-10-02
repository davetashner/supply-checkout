// The welcome email (supply-checkout-6uw.25): the user pool's triggers hand a
// new account's sub to the welcome email function, for every sign-up method
// and never for a forgotten password or a later sign-in; the function sends
// exactly one, to the address the account API trusts, worded for a new team or
// an invited one; a failure never reaches sign-up, and is counted; and no
// address or name is logged. The once-only record is also checked against
// DynamoDB Local (npm run test:ddb).

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { PostConfirmationTriggerEvent, PreTokenGenerationTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { claimWelcome, hasLiveInvite, hasTeam, hashEmail, releaseWelcome } from "../src/data/index.js";
import { connection } from "../src/data/client.js";
import { inviteePartition, keys } from "../src/data/keys.js";
import { GSI2, SECURITY_NOTICE_ATTRIBUTES, WELCOME_INVITE_ATTRIBUTES, WELCOME_RECORD_ATTRIBUTES, WELCOME_TEAM_ATTRIBUTES } from "../src/data/schema.js";
import { emailResourceNames, WELCOME_VIA, type WelcomeRequest } from "../src/email/names.js";
import { createWelcomeHandler, welcomeRequest } from "../src/email/welcome-handler.js";
import { cognitoAccounts, type FindAccount, type PoolAccount } from "../src/identity/cognito-accounts.js";
import { createEmailVerifiedHandler, WELCOME_CALL_TIMEOUT_MS, WRITE_BUDGET_MS } from "../src/identity/email-verified-handler.js";
import { PROVIDER_EMAIL_VERIFIED_ATTRIBUTE } from "../src/identity/names.js";
import { createPostConfirmationHandler, WELCOME_BUDGET_MS, WELCOME_INVOKE_TIMEOUT_MS } from "../src/identity/post-confirmation-handler.js";
import { welcomeInvoker } from "../src/identity/welcome-invoke.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { endpoint, fakeDb, fakeMailer, REGION, useTable } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const POOL = "test-local-1_AppPool1";
const SUB = "4f1c2b7e-9a3d-4e5f-8b6a-1c2d3e4f5a6b";
const OTHER_SUB = "9a3d4f1c-2b7e-4e5f-8b6a-6b5a4f3e2d1c";
const EMAIL = "Owner@Example.com";
const ADDRESS = "owner@example.com";
const SUPPORT = "support@supplycheckout.com";
const NAME = "Samantha";
const GOOGLE_ID = "107691234567890123456";
const APPLE_ID = "001234.abcdef0123456789.1234";
const NOW = Date.parse("2026-10-02T09:00:00Z");
const LATER = Math.floor(NOW / 1000) + 7 * 86_400;

type Logged = { level: string; message: string; data: Record<string, unknown> };

let table: MemoryTable;
let denied: { command: string; input: Record<string, unknown> }[];
let logs: Logged[];
let metrics: { metric: string; metadata: Record<string, unknown> }[];

beforeEach(() => {
  table = new MemoryTable();
  denied = [];
  logs = [];
  metrics = [];
});

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

/** No address or name, in any case, anywhere in the logs or metrics. */
function expectNothingPersonal() {
  const text = JSON.stringify({ logs, metrics });
  expect(text).not.toMatch(/example\.com|samantha|owner@/i);
}

/**
 * The welcome email function's IAM policy (email stack): UpdateItem naming
 * only WELCOME_RECORD_ATTRIBUTES and returning nothing, and ConditionCheckItem
 * of the DELETING mark naming only the keys, in USER# partitions; Query of a
 * user's own partition naming only the keys; Query of GSI2's INVITEE#
 * partitions naming only WELCOME_INVITE_ATTRIBUTES; both with Select
 * SPECIFIC_ATTRIBUTES. Nothing else: no GetItem, PutItem or DeleteItem.
 */
function policy(command: string, input: Record<string, unknown>): boolean {
  const names = (body: Record<string, unknown>) => Object.values((body.ExpressionAttributeNames ?? {}) as Record<string, string>);
  const projected = (body: Record<string, unknown>) =>
    String(body.ProjectionExpression ?? "")
      .split(",")
      .map((p) => p.trim())
      .map((p) => ((body.ExpressionAttributeNames ?? {}) as Record<string, string>)[p] ?? p);
  const one = (kind: string, body: Record<string, unknown>) => {
    const key = (body.Key ?? {}) as { PK?: unknown };
    const user = typeof key.PK === "string" && key.PK.startsWith("USER#");
    if (kind === "Update" || kind === "UpdateCommand") {
      return user && names(body).every((n) => (WELCOME_RECORD_ATTRIBUTES as readonly string[]).includes(n)) && (body.ReturnValues === undefined || body.ReturnValues === "NONE");
    }
    if (kind === "ConditionCheck") return user && names(body).length === 0 && body.ConditionExpression === "attribute_not_exists(PK)";
    if (kind === "QueryCommand") {
      const pk = String(((body.ExpressionAttributeValues ?? {}) as Record<string, unknown>)[":pk"]);
      const allowed: readonly string[] = body.IndexName === GSI2 ? WELCOME_INVITE_ATTRIBUTES : WELCOME_TEAM_ATTRIBUTES;
      const partition = body.IndexName === GSI2 ? pk.startsWith("INVITEE#") : body.IndexName === undefined && pk.startsWith("USER#");
      return partition && body.Select === "SPECIFIC_ATTRIBUTES" && [...projected(body), ...names(body)].every((n) => allowed.includes(n));
    }
    return false;
  };
  const ok =
    command === "TransactWriteCommand"
      ? (input.TransactItems as Record<string, Record<string, unknown>>[]).every((op) => Object.entries(op).every(([kind, body]) => one(kind, body)))
      : one(command, input);
  if (!ok) denied.push({ command, input });
  return ok;
}

const account = (over: Partial<PoolAccount> = {}): PoolAccount => ({
  username: SUB,
  email: EMAIL,
  emailVerified: true,
  emailVerifiedInCognito: true,
  totpEnabled: false,
  givenName: NAME,
  ...over,
});

const invite = (over: Record<string, unknown> = {}) => ({
  PK: "TEAM#t1",
  SK: "INVITE#i1",
  type: "invite",
  teamId: "t1",
  teamName: "Echo Cleaning",
  inviteId: "i1",
  email: ADDRESS,
  role: "contributor",
  expiresAt: LATER,
  GSI2PK: inviteePartition(hashEmail(ADDRESS)),
  GSI2SK: "INVITE#i1",
  ...over,
});

describe("schema", () => {
  it("lets the function write only the welcome record, and read only keys, an invite's type, address and expiry", () => {
    expect([...WELCOME_RECORD_ATTRIBUTES]).toEqual(["PK", "SK", "welcomeSentAt"]);
    expect([...WELCOME_TEAM_ATTRIBUTES]).toEqual(["PK", "SK"]);
    expect([...WELCOME_INVITE_ATTRIBUTES]).toEqual(["PK", "SK", "GSI2PK", "GSI2SK", "type", "email", "expiresAt"]);
    // Its own attribute, which no other item in a user's partition has
    expect(SECURITY_NOTICE_ATTRIBUTES).not.toContain("welcomeSentAt");
    expect(keys.welcome(SUB)).toEqual({ PK: `USER#${SUB}`, SK: "WELCOME" });
    expect(emailResourceNames("prod")).toMatchObject({ welcomeFunction: "supply-checkout-prod-welcome-email", welcomeDeadLetterQueue: "supply-checkout-prod-welcome-email-dlq" });
  });
});

describe("the once-only record", () => {
  it("is claimed once; a second claim finds it sent; a released claim can be made again", async () => {
    const db = table.guarded(policy);
    expect(await claimWelcome(db, SUB, new Date(NOW))).toBe("claimed");
    expect(table.get(`USER#${SUB}`, "WELCOME")).toEqual({ PK: `USER#${SUB}`, SK: "WELCOME", welcomeSentAt: new Date(NOW).toISOString() });
    expect(await claimWelcome(db, SUB, new Date(NOW + 1000))).toBe("sent");
    // Only the claim it made: an older one isn't given up
    expect(await releaseWelcome(db, SUB, new Date(NOW - 1000))).toBe(false);
    expect(await releaseWelcome(db, SUB, new Date(NOW))).toBe(true);
    expect(table.get(`USER#${SUB}`, "WELCOME")).toEqual({ PK: `USER#${SUB}`, SK: "WELCOME" });
    expect(await claimWelcome(db, SUB, new Date(NOW + 2000))).toBe("claimed");
    expect(denied).toEqual([]);
  });

  it("is never claimed for an account being deleted, whether or not one was sent", async () => {
    table.put(keys.accountDeletion(SUB));
    expect(await claimWelcome(table.guarded(policy), SUB, new Date(NOW))).toBe("deleting");
    expect(table.get(`USER#${SUB}`, "WELCOME")).toBeUndefined();
    table.put({ ...keys.welcome(SUB), welcomeSentAt: "x" });
    expect(await claimWelcome(table.guarded(policy), SUB, new Date(NOW))).toBe("deleting");
  });

  it("throws what DynamoDB throws otherwise", async () => {
    await expect(claimWelcome(table.guarded(() => false), SUB, new Date(NOW))).rejects.toThrow("not authorized");
    await expect(releaseWelcome(table.guarded(() => false), SUB, new Date(NOW))).rejects.toThrow("not authorized");
    // A transaction cancelled for another reason (a conflict) isn't read as sent or deleting
    table.beforeTransactWrite = () => {
      throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }] });
    };
    await expect(claimWelcome(table.db(), SUB, new Date(NOW))).rejects.toThrow("Transaction cancelled");
    table.beforeTransactWrite = () => {
      throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException" });
    };
    await expect(claimWelcome(table.db(), SUB, new Date(NOW))).rejects.toThrow("Transaction cancelled");
  });

  it("tells whether the user is in a team, and whether a live invite waits for their address", async () => {
    const db = table.guarded(policy);
    expect(await hasTeam(db, SUB)).toBe(false);
    expect(await hasLiveInvite(db, EMAIL, new Date(NOW))).toBe(false);
    table.put({ PK: `USER#${OTHER_SUB}`, SK: "TEAM#t9" });
    table.put({ ...keys.welcome(SUB), welcomeSentAt: "x" });
    expect(await hasTeam(db, SUB)).toBe(false);
    table.put({ PK: `USER#${SUB}`, SK: "TEAM#t1", role: "owner" });
    expect(await hasTeam(db, SUB)).toBe(true);
    // Expired, another address under the same hash, not an invite: none of them count
    table.put(invite({ expiresAt: Math.floor(NOW / 1000) - 1 }));
    table.put(invite({ SK: "INVITE#i2", GSI2SK: "INVITE#i2", email: "other@example.com" }));
    table.put(invite({ SK: "INVITE#i3", GSI2SK: "INVITE#i3", type: "inviteGuard" }));
    table.put(invite({ SK: "INVITE#i4", GSI2SK: "INVITE#i4", expiresAt: "never" }));
    expect(await hasLiveInvite(db, EMAIL, new Date(NOW))).toBe(false);
    table.put(invite({ SK: "INVITE#i5", GSI2SK: "INVITE#i5" }));
    expect(await hasLiveInvite(db, EMAIL, new Date(NOW))).toBe(true);
    expect(denied).toEqual([]);
  });

  it("reads every page of invites", async () => {
    let calls = 0;
    const db = fakeDb(async () => {
      calls++;
      return calls === 1 ? { Items: [], LastEvaluatedKey: { PK: "a", SK: "b" } } : { Items: [invite()] };
    });
    expect(await hasLiveInvite(db, EMAIL, new Date(NOW))).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("welcome email function", () => {
  const request = (over: Partial<Record<keyof WelcomeRequest, unknown>> = {}): WelcomeRequest => ({ userId: SUB, via: "email", ...over }) as WelcomeRequest;

  function welcome(options: { find?: FindAccount; db?: ReturnType<MemoryTable["db"]> } = {}) {
    const mail = fakeMailer();
    const lookups: string[] = [];
    const handler = createWelcomeHandler({
      findAccount:
        options.find ??
        (async (sub) => {
          lookups.push(sub);
          return sub === SUB ? account() : undefined;
        }),
      db: options.db ?? table.guarded(policy),
      mailer: mail.mailer,
      obs: fakeObservability(),
      supportAddress: SUPPORT,
      now: () => NOW,
    });
    return { handler, ...mail, lookups };
  }
  const outcome = () => logs.filter((l) => l.message === "Welcome email").map((l) => l.data.outcome);

  it("sends one welcome, by the account's given name, to its verified address, for every sign-up method", async () => {
    for (const via of WELCOME_VIA) {
      table = new MemoryTable();
      logs = [];
      metrics = [];
      const { handler, sent, lookups } = welcome();
      await handler(request({ via }));
      expect(lookups).toEqual([SUB]);
      expect(sent).toEqual([{ to: ADDRESS, input: { kind: "welcome", givenName: NAME, invited: false, supportAddress: SUPPORT }, tags: {} }]);
      expect(metrics).toEqual([{ metric: BusinessMetric.WelcomeEmails, metadata: { via } }]);
      expect(logs).toContainEqual({ level: "info", message: "Welcome email sent", data: { userId: SUB, via, invited: false } });
      // The same request again (a retried trigger, Lambda trying again, a replay), or the other trigger: nothing more
      await handler(request({ via }));
      await handler(request({ via: "Google" }));
      expect(sent).toHaveLength(1);
      expect(outcome()).toEqual(["sent", "already-sent", "already-sent"]);
      expect(logs.filter((l) => l.message === "Welcome email already claimed").map((l) => l.data)).toEqual([
        { userId: SUB, via },
        { userId: SUB, via: "Google" },
      ]);
      expect(denied).toEqual([]);
      expectNothingPersonal();
    }
  });

  it("greets without a name when the account has none", async () => {
    const { handler, sent } = welcome({ find: async () => account({ givenName: undefined }) });
    await handler(request());
    expect(sent[0]?.input).toEqual({ kind: "welcome", invited: false, supportAddress: SUPPORT });
  });

  it("points someone in a team, or with a live invite waiting, at that team", async () => {
    table.put({ PK: `USER#${SUB}`, SK: "TEAM#t1" });
    const inTeam = welcome();
    await inTeam.handler(request());
    expect(inTeam.sent[0]?.input).toMatchObject({ invited: true });
    table = new MemoryTable();
    table.put(invite());
    const withInvite = welcome();
    await withInvite.handler(request());
    expect(withInvite.sent[0]?.input).toMatchObject({ invited: true });
    expect(denied).toEqual([]);
  });

  it("still sends, saying both, when the team check fails", async () => {
    // A policy that refuses the queries only
    const db = table.guarded((command, input) => command !== "QueryCommand" && policy(command, input));
    const { handler, sent } = welcome({ db });
    await handler(request());
    expect(sent[0]?.input).toMatchObject({ invited: false });
    expect(logs).toContainEqual({ level: "warn", message: "Welcome email's team check failed; it says both", data: { userId: SUB, code: "AccessDeniedException" } });
    expect(metrics.map((m) => m.metric)).toEqual([BusinessMetric.WelcomeEmails]);
  });

  it("sends nothing for an account being deleted, or a user who's gone, and only logs it", async () => {
    table.put(keys.accountDeletion(SUB));
    const deleting = welcome();
    await deleting.handler(request());
    const gone = welcome();
    await gone.handler(request({ userId: OTHER_SUB }));
    expect([...deleting.sent, ...gone.sent]).toEqual([]);
    expect(outcome()).toEqual(["deleting", "no-user"]);
    expect(metrics).toEqual([]);
  });

  it("sends nothing to an address the account API wouldn't trust, and counts it", async () => {
    for (const over of [{ emailVerified: false }, { email: undefined }, { email: "not an address" }]) {
      metrics = [];
      const { handler, sent } = welcome({ find: async () => account(over) });
      await handler(request());
      expect(sent).toEqual([]);
      expect(metrics).toEqual([{ metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "no_address", via: "email" } }]);
    }
    expect(table.get(`USER#${SUB}`, "WELCOME")).toBeUndefined();
    expectNothingPersonal();
  });

  it("ignores a request that isn't the triggers', and counts it", async () => {
    for (const bad of [undefined, null, "x", {}, { userId: SUB }, { userId: "not-a-sub", via: "email" }, { userId: SUB, via: "Facebook" }, { userId: `${SUB}"`, via: "email" }]) {
      expect(welcomeRequest(bad)).toBeUndefined();
    }
    expect(welcomeRequest({ userId: SUB, via: "SignInWithApple", extra: 1 })).toEqual({ userId: SUB, via: "SignInWithApple" });
    const { handler, sent, lookups } = welcome();
    await handler({ userId: "x", via: "email" });
    expect(lookups).toEqual([]);
    expect(sent).toEqual([]);
    expect(metrics).toEqual([{ metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "invalid", via: "unknown" } }]);
    expect(outcome()).toEqual(["invalid"]);
  });

  it("throws on a failed lookup or DynamoDB call, counted, so Lambda tries again", async () => {
    const lookup = welcome({
      find: async () => {
        throw new Error("ListUsers failed: 400 TooManyRequestsException");
      },
    });
    await expect(lookup.handler(request())).rejects.toThrow("Counted");
    const dynamo = welcome({ db: table.guarded(() => false) });
    await expect(dynamo.handler(request())).rejects.toThrow("Counted");
    const odd = welcome({
      find: async () => {
        throw "odd";
      },
    });
    await expect(odd.handler(request())).rejects.toThrow("Counted");
    expect(metrics).toEqual([
      { metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "lookup_failed", via: "email" } },
      { metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "error", via: "email" } },
      { metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "lookup_failed", via: "email" } },
    ]);
    expect(logs.filter((l) => l.level === "warn").map((l) => l.data.code)).toEqual(["Error", "AccessDeniedException", "Unknown"]);
    // A retry after the failed claim sends it
    const retry = welcome();
    await retry.handler(request());
    expect(retry.sent).toHaveLength(1);
  });

  it("gives the claim up when SES refuses, without retrying, so a replay sends it once", async () => {
    const first = welcome();
    first.state.fail = "MessageRejected";
    await first.handler(request());
    expect(first.sent).toEqual([]);
    // Its own metric, so SES's sandbox can't hide real failures behind an alarm that's always on
    expect(metrics).toEqual([{ metric: BusinessMetric.WelcomeEmailsRefused, metadata: { via: "email" } }]);
    expect(logs).toContainEqual({ level: "warn", message: "Welcome email not sent", data: { userId: SUB, via: "email", reason: "refused", code: "MessageRejected" } });
    expect(outcome()).toEqual(["not-sent"]);
    expect(table.get(`USER#${SUB}`, "WELCOME")?.welcomeSentAt).toBeUndefined();
    first.state.fail = undefined;
    await first.handler(request());
    await first.handler(request());
    expect(first.sent).toHaveLength(1);
    expectNothingPersonal();
  });

  it("keeps the claim if it can't give it up, so no second email can follow, and throws on anything but SES's refusal", async () => {
    // Refuses REMOVE only (the release)
    const db = table.guarded((command, input) => !String(input.UpdateExpression ?? "").startsWith("REMOVE") && policy(command, input));
    const handler = createWelcomeHandler({
      findAccount: async () => account(),
      db,
      mailer: {
        send: async () => {
          throw new TypeError("socket hang up");
        },
      },
      obs: fakeObservability(),
      supportAddress: SUPPORT,
      now: () => NOW,
    });
    await expect(handler(request())).rejects.toThrow("Counted");
    expect(logs).toContainEqual({ level: "error", message: "Welcome email claim not given up", data: { userId: SUB, code: "AccessDeniedException" } });
    expect(table.get(`USER#${SUB}`, "WELCOME")?.welcomeSentAt).toBe(new Date(NOW).toISOString());
    expect(metrics).toEqual([{ metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "error", via: "email" } }]);
  });

  it("finds the user's given name in Cognito, and none when they have none", async () => {
    const answers = (given?: string) => ({
      ListUsers: { Users: [{ Username: "u" }] },
      AdminGetUser: { Username: "u", UserAttributes: [{ Name: "sub", Value: SUB }, { Name: "email", Value: EMAIL }, { Name: "email_verified", Value: "true" }, ...(given ? [{ Name: "given_name", Value: given }] : [])] },
    });
    const find = (given?: string) =>
      cognitoAccounts({
        region: REGION,
        userPoolId: POOL,
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
        fetch: (async (_url: string, init: { headers: Record<string, string> }) => {
          const action = String(init.headers["x-amz-target"]).split(".").pop() as keyof ReturnType<typeof answers>;
          return new Response(JSON.stringify(answers(given)[action]), { status: 200 });
        }) as unknown as typeof fetch,
      })(SUB);
    expect(await find(NAME)).toMatchObject({ givenName: NAME, emailVerified: true });
    expect(await find()).not.toHaveProperty("givenName");
  });
});

describe("welcomeInvoker", () => {
  function lambda(status = 202, errorType?: string) {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const doFetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return new Response(status === 202 ? "" : JSON.stringify({ Message: `no ${EMAIL}` }), { status, headers: errorType ? { "x-amzn-ErrorType": errorType } : {} });
    }) as unknown as typeof fetch;
    const send = welcomeInvoker({ region: REGION, functionName: "supply-checkout-prod-welcome-email", timeoutMs: 800, fetch: doFetch, credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } });
    return { calls, send };
  }

  it("queues the request with an asynchronous, signed invoke of the one function, carrying only the sub and the method", async () => {
    const { calls, send } = lambda();
    await send({ userId: SUB, via: "Google" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://lambda.${REGION}.amazonaws.com/2015-03-31/functions/supply-checkout-prod-welcome-email/invocations`);
    expect(calls[0]?.headers["x-amz-invocation-type"]).toBe("Event");
    expect(calls[0]?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/test-local-1\/lambda\/aws4_request/);
    expect(JSON.parse(calls[0]?.body as string)).toEqual({ userId: SUB, via: "Google" });
  });

  it("throws, naming only the status and Lambda's error type, unless Lambda accepted it", async () => {
    await expect(lambda(404, "ResourceNotFoundException:http://internal.amazon.com/coral/").send({ userId: SUB, via: "email" })).rejects.toMatchObject({
      name: "ResourceNotFoundException",
      message: "Invoke failed: 404 ResourceNotFoundException",
    });
    await expect(lambda(500).send({ userId: SUB, via: "email" })).rejects.toMatchObject({ name: "InvokeFailed", message: "Invoke failed: 500" });
    // 200 is a synchronous answer: not what was asked for
    await expect(lambda(200).send({ userId: SUB, via: "email" })).rejects.toThrow("Invoke failed: 200");
  });

  it("refuses a bad region or function name before calling anything", () => {
    expect(() => welcomeInvoker({ region: `${REGION}/x`, functionName: "f", timeoutMs: 1 })).toThrow("Not an AWS region name");
    expect(() => welcomeInvoker({ region: REGION, functionName: "f/../g", timeoutMs: 1 })).toThrow("Not a Lambda function name");
  });
});

describe("the triggers hand new accounts over", () => {
  const native = (over: Record<string, string> = {}): Record<string, string> => ({ sub: SUB, email: EMAIL, email_verified: "true", given_name: NAME, "cognito:user_status": "CONFIRMED", ...over });
  const identities = (provider: "Google" | "SignInWithApple", id: string) => JSON.stringify([{ userId: id, providerName: provider, providerType: provider, issuer: null, primary: true, dateCreated: 1 }]);
  const federated = (provider: "Google" | "SignInWithApple", id: string, over: Record<string, string> = {}) =>
    native({ identities: identities(provider, id), "cognito:user_status": "EXTERNAL_PROVIDER", email_verified: "false", [PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]: "true", ...over });

  function sender(fail?: unknown) {
    const queued: WelcomeRequest[] = [];
    const send = async (request: WelcomeRequest) => {
      if (fail !== undefined) throw fail;
      queued.push(request);
    };
    return { queued, send };
  }

  describe("post confirmation", () => {
    const event = (attributes: Record<string, string>, triggerSource = "PostConfirmation_ConfirmSignUp", userName = SUB) =>
      ({
        version: "1",
        triggerSource,
        region: REGION,
        userPoolId: POOL,
        userName,
        callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "web" },
        request: { userAttributes: attributes },
        response: {},
      }) as unknown as PostConfirmationTriggerEvent;
    const handler = (send?: ReturnType<typeof sender>["send"], now?: () => number) =>
      createPostConfirmationHandler({ rememberNoticeAddress: async () => "recorded", obs: fakeObservability(), ...(send ? { sendWelcome: send } : {}), ...(now ? { now } : {}) });
    const welcomeLogged = () => logs.filter((l) => l.message === "Notice address").map((l) => l.data.welcome);

    it("hands over a native user's sign-up, and never a forgotten password's confirmation", async () => {
      const { queued, send } = sender();
      const confirmed = event(native());
      expect(await handler(send)(confirmed)).toBe(confirmed);
      await handler(send)(event(native(), "PostConfirmation_ConfirmForgotPassword"));
      expect(queued).toEqual([{ userId: SUB, via: "email" }]);
      expect(welcomeLogged()).toEqual(["queued", "not-new"]);
      expect(metrics).toEqual([]);
      expectNothingPersonal();
    });

    it("leaves Google and Apple users to the sign-in that verifies them, and needs a sub", async () => {
      const { queued, send } = sender();
      // Even if Cognito had their email verified already
      await handler(send)(event(federated("Google", GOOGLE_ID, { email_verified: "true" }), "PostConfirmation_ConfirmSignUp", `Google_${GOOGLE_ID}`));
      await handler(send)(event(native({ sub: "not-a-sub" })));
      const bare = event({});
      (bare as unknown as { request: unknown }).request = undefined;
      await handler(send)(bare);
      expect(queued).toEqual([]);
      expect(welcomeLogged()).toEqual(["not-new", "no-sub", "no-sub"]);
      // Whether this event says the email is verified doesn't matter: the function checks with Cognito before it sends
      await handler(send)(event(native({ email_verified: "false" })));
      expect(queued).toEqual([{ userId: SUB, via: "email" }]);
    });

    it("never fails the confirmation: a failed hand-over is logged with the error's name only and counted", async () => {
      for (const failure of [Object.assign(new Error(`no ${EMAIL}`), { name: "ResourceNotFoundException" }), "odd"]) {
        logs = [];
        metrics = [];
        const { send } = sender(failure);
        const confirmed = event(native());
        expect(await handler(send)(confirmed)).toBe(confirmed);
        expect(logs).toContainEqual({ level: "error", message: "Welcome email not queued", data: { code: failure instanceof Error ? "ResourceNotFoundException" : "Unknown" } });
        expect(welcomeLogged()).toEqual(["failed"]);
        expect(metrics).toEqual([{ metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "invoke", via: "email" } }]);
        expectNothingPersonal();
      }
    });

    it("hands over only while the invoke fits the trigger's budget, and counts it when it doesn't", async () => {
      for (const spent of [WELCOME_BUDGET_MS - WELCOME_INVOKE_TIMEOUT_MS, WELCOME_BUDGET_MS - WELCOME_INVOKE_TIMEOUT_MS + 1]) {
        logs = [];
        metrics = [];
        const times = [NOW, NOW + spent];
        const { queued, send } = sender();
        const confirmed = event(native());
        expect(await handler(send, () => times.shift() ?? NOW)(confirmed)).toBe(confirmed);
        const fits = spent + WELCOME_INVOKE_TIMEOUT_MS <= WELCOME_BUDGET_MS;
        expect(queued).toEqual(fits ? [{ userId: SUB, via: "email" }] : []);
        expect(welcomeLogged()).toEqual([fits ? "queued" : "failed"]);
        expect(metrics).toEqual(fits ? [] : [{ metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "deferred", via: "email" } }]);
      }
      // Well inside Cognito's 5 seconds, with room for a cold start
      expect(WELCOME_BUDGET_MS).toBeLessThanOrEqual(4_000);
      expect(WELCOME_INVOKE_TIMEOUT_MS).toBeLessThanOrEqual(500);
    });

    it("hands nothing over without the welcome function, and doesn't mention it", async () => {
      await handler()(event(native()));
      expect(logs).toEqual([{ level: "info", message: "Notice address", data: { triggerSource: "PostConfirmation_ConfirmSignUp", outcome: "recorded" } }]);
    });
  });

  describe("pre token generation", () => {
    const tokenEvent = (userName: string, attributes: Record<string, string>, triggerSource = "TokenGeneration_HostedAuth") =>
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
    function trigger(options: { send?: ReturnType<typeof sender>["send"]; failUpdates?: boolean; now?: () => number } = {}) {
      return createEmailVerifiedHandler({
        obs: fakeObservability(),
        updateUserAttributes: async () => {
          if (options.failUpdates) throw new Error("AdminUpdateUserAttributes failed: 400 TooManyRequestsException");
        },
        sleep: async () => {},
        provenEmailHash: async () => undefined,
        ...(options.send ? { sendWelcome: options.send } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    }
    const logged = () => logs.filter((l) => l.message === "Federated email").map((l) => l.data);

    it("hands over a Google or Apple account at the first sign-in, when it verifies the email, and never at a later one", async () => {
      const { queued, send } = sender();
      await trigger({ send })(tokenEvent(`Google_${GOOGLE_ID}`, federated("Google", GOOGLE_ID)));
      await trigger({ send })(tokenEvent(`SignInWithApple_${APPLE_ID}`, federated("SignInWithApple", APPLE_ID)));
      // Later: already verified ("unchanged"), a refresh, a native user, a provider that doesn't vouch for the address
      await trigger({ send })(tokenEvent(`Google_${GOOGLE_ID}`, federated("Google", GOOGLE_ID, { email_verified: "true" })));
      await trigger({ send })(tokenEvent(`Google_${GOOGLE_ID}`, federated("Google", GOOGLE_ID), "TokenGeneration_RefreshTokens"));
      await trigger({ send })(tokenEvent(SUB, native(), "TokenGeneration_Authentication"));
      await trigger({ send })(tokenEvent(`Google_${GOOGLE_ID}`, federated("Google", GOOGLE_ID, { [PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]: "false" })));
      expect(queued).toEqual([
        { userId: SUB, via: "Google" },
        { userId: SUB, via: "SignInWithApple" },
      ]);
      expect(logged().map((l) => [l.outcome, l.welcome])).toEqual([
        ["verified", "queued"],
        ["verified", "queued"],
        ["unchanged", undefined],
        ["not-provider-sign-in", undefined],
        ["not-provider-sign-in", undefined],
        ["unchanged", undefined],
      ]);
      expect(metrics).toEqual([]);
      expectNothingPersonal();
    });

    it("hands nothing over when the email couldn't be marked verified, or the event has no sub; the next sign-in does", async () => {
      const { queued, send } = sender();
      await trigger({ send, failUpdates: true })(tokenEvent(`Google_${GOOGLE_ID}`, federated("Google", GOOGLE_ID)));
      const noSub: Record<string, string> = { ...federated("Google", GOOGLE_ID) };
      delete noSub.sub;
      await trigger({ send })(tokenEvent(`Google_${GOOGLE_ID}`, noSub));
      expect(queued).toEqual([]);
      await trigger({ send })(tokenEvent(`Google_${GOOGLE_ID}`, federated("Google", GOOGLE_ID)));
      expect(queued).toEqual([{ userId: SUB, via: "Google" }]);
    });

    it("never fails the token: a failed hand-over, or no time left for it, is logged and counted", async () => {
      const failing = sender(Object.assign(new Error(`no ${EMAIL}`), { name: "TooManyRequestsException" }));
      const event = () => tokenEvent(`Google_${GOOGLE_ID}`, federated("Google", GOOGLE_ID));
      const passed = event();
      expect(await trigger({ send: failing.send })(passed)).toBe(passed);
      await trigger({ send: sender("odd").send })(event());
      // The promotion took all but less than the invoke's timeout of the budget
      const times = [NOW, NOW + WRITE_BUDGET_MS - WELCOME_CALL_TIMEOUT_MS + 1];
      const slow = sender();
      await trigger({ send: slow.send, now: () => times.shift() ?? NOW })(event());
      expect(slow.queued).toEqual([]);
      expect(logs.filter((l) => l.message === "Welcome email not queued").map((l) => l.data)).toEqual([
        { provider: "Google", code: "TooManyRequestsException" },
        { provider: "Google", code: "Unknown" },
        { provider: "Google", code: "NoTimeLeft" },
      ]);
      expect(metrics).toEqual([
        { metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "invoke", via: "Google" } },
        { metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "invoke", via: "Google" } },
        { metric: BusinessMetric.WelcomeEmailFailures, metadata: { reason: "deferred", via: "Google" } },
      ]);
      expect(logged().map((l) => l.welcome)).toEqual(["failed", "failed", "failed"]);
      expectNothingPersonal();
    });
  });
});

describe.skipIf(!endpoint)("the once-only record (DynamoDB Local)", () => {
  const holder = useTable();

  it("is claimed once per account, never for one being deleted, and can be given up only by its own claim", async () => {
    const { db } = holder;
    const user = "5b6a1c2d-3e4f-4a6b-8c7d-9e0f1a2b3c4d";
    expect(await claimWelcome(db, user, new Date(NOW))).toBe("claimed");
    expect(await claimWelcome(db, user, new Date(NOW + 1))).toBe("sent");
    expect(await releaseWelcome(db, user, new Date(NOW + 1))).toBe(false);
    expect(await releaseWelcome(db, user, new Date(NOW))).toBe(true);
    expect(await claimWelcome(db, user, new Date(NOW + 2))).toBe("claimed");

    const deleting = "6c7d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: keys.accountDeletion(deleting) }));
    expect(await claimWelcome(db, deleting, new Date(NOW))).toBe("deleting");
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.welcome(deleting), welcomeSentAt: "x" } }));
    expect(await claimWelcome(db, deleting, new Date(NOW))).toBe("deleting");
  });

  it("finds a team row and a live invite by the address's hash", async () => {
    const { db } = holder;
    const user = "7d8e3f4a-5b6c-4d7e-8f9a-1b2c3d4e5f6a";
    const address = "invitee@example.com";
    expect(await hasTeam(db, user)).toBe(false);
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.welcome(user), welcomeSentAt: "x" } }));
    expect(await hasTeam(db, user)).toBe(false);
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { PK: `USER#${user}`, SK: "TEAM#t1", role: "owner" } }));
    expect(await hasTeam(db, user)).toBe(true);
    expect(await hasLiveInvite(db, address, new Date(NOW))).toBe(false);
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: invite({ email: address, GSI2PK: inviteePartition(hashEmail(address)), expiresAt: Math.floor(NOW / 1000) - 1 }) }));
    expect(await hasLiveInvite(db, address, new Date(NOW))).toBe(false);
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: invite({ SK: "INVITE#i2", GSI2SK: "INVITE#i2", email: address, GSI2PK: inviteePartition(hashEmail(address)) }) }));
    expect(await hasLiveInvite(db, "Invitee@Example.com", new Date(NOW))).toBe(true);
  });
});
