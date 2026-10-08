// Refusing a session that began before the account's password was reset
// (supply-checkout-6uw.33): the shared check (api/session-reset.ts), the
// record it reads (data/password-reset-time.ts, against a fake DynamoDB here;
// access-patterns.test.ts runs it against DynamoDB Local), and that every
// handler the app's tokens reach runs it before anything else.

import { describe, expect, it } from "vitest";
import { createAccountHandler } from "../src/api/account-handler.js";
import { createBillingHandler } from "../src/api/billing-handler.js";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { createReceiptsHandler } from "../src/api/receipts-handler.js";
import { ACCOUNT_ROUTES, BILLING_ROUTES, DATA_ROUTES, RECEIPT_ROUTES, routeKey } from "../src/api/routes.js";
import { beganBeforeReset, createSessionCheck, passwordReset, RESET_CACHE_MS, RESET_SKEW_MS, type SessionCheck, sessionCheckFromEnv } from "../src/api/session-reset.js";
import { passwordResetAt, recordPasswordReset } from "../src/data/index.js";
import type { Observability } from "../src/observability/index.js";
import { fakeDb, offlineDb } from "./helpers.js";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const USER = "user-1";
const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_Pool";

const event = (claims: Record<string, unknown> = {}, routeKeyValue = "GET /me", pathParameters: Record<string, string> = {}) =>
  ({
    routeKey: routeKeyValue,
    rawPath: "/",
    headers: { authorization: "Bearer token" },
    pathParameters,
    requestContext: { authorizer: { jwt: { claims: { sub: USER, token_use: "access", exp: String(NOW / 1000 + 600), iss: ISSUER, ...claims }, scopes: null } } },
  }) as unknown as DataEvent;

describe("beganBeforeReset", () => {
  const reset = NOW;
  it("refuses a session that began more than the skew before the reset, in whole seconds or their string", () => {
    const before = Math.floor((reset - RESET_SKEW_MS) / 1000) - 1;
    expect(beganBeforeReset(before, reset)).toBe(true);
    expect(beganBeforeReset(String(before), reset)).toBe(true);
    expect(beganBeforeReset(0, reset)).toBe(true);
  });
  it("lets through a session from the skew before it on, and any after", () => {
    expect(beganBeforeReset((reset - RESET_SKEW_MS) / 1000, reset)).toBe(false);
    expect(beganBeforeReset(Math.floor(reset / 1000) - 1, reset)).toBe(false);
    expect(beganBeforeReset(String(reset / 1000 + 60), reset)).toBe(false);
  });
  it("counts a missing or malformed auth_time as before", () => {
    for (const value of [undefined, null, "", "abc", "1.5", "-1", 1.5, Number.NaN, {}, [], "1e12"]) expect(beganBeforeReset(value, reset), String(value)).toBe(true);
  });
});

describe("createSessionCheck", () => {
  function setup(found: (userId: string) => number | undefined | Error) {
    let clock = NOW;
    const lookups: string[] = [];
    const check = createSessionCheck({
      lookup: async (userId) => {
        lookups.push(userId);
        const value = found(userId);
        if (value instanceof Error) throw value;
        return value;
      },
      now: () => clock,
      maxUsers: 2,
    });
    return { check, lookups, advance: (ms: number) => (clock += ms) };
  }
  const old = { auth_time: String(NOW / 1000 - 3600) };
  const fresh = { auth_time: String(NOW / 1000 + 1) };

  it("lets anyone through whose password was never reset, with or without auth_time", async () => {
    const { check } = setup(() => undefined);
    await expect(check(event(old), USER)).resolves.toBeUndefined();
    await expect(check(event(), USER)).resolves.toBeUndefined();
  });

  it("answers 401 password_reset to a session from before the reset, and lets one from after through", async () => {
    const { check } = setup(() => NOW);
    await expect(check(event(old), USER)).rejects.toEqual(passwordReset());
    await expect(check(event(), USER)).rejects.toMatchObject({ status: 401, code: "unauthenticated", reason: "password_reset" });
    await expect(check(event(fresh), USER)).resolves.toBeUndefined();
    const refused = passwordReset();
    expect(refused).toMatchObject({ status: 401, code: "unauthenticated", reason: "password_reset" });
  });

  it("reads each user's record once per cache time, and again after it", async () => {
    const { check, lookups, advance } = setup(() => NOW);
    await expect(check(event(fresh), USER)).resolves.toBeUndefined();
    advance(RESET_CACHE_MS - 1);
    await expect(check(event(fresh), USER)).resolves.toBeUndefined();
    expect(lookups).toEqual([USER]);
    advance(1);
    await expect(check(event(old), USER)).rejects.toMatchObject({ reason: "password_reset" });
    expect(lookups).toEqual([USER, USER]);
  });

  it("keeps a bounded number of users, dropping the least recently read", async () => {
    const { check, lookups } = setup(() => undefined);
    for (const user of ["a", "b", "a", "c", "a", "b"]) await check(event({ sub: user }), user);
    // a and b are read; a again from the cache; c pushes b out; a is still kept; b is read again
    expect(lookups).toEqual(["a", "b", "c", "b"]);
  });

  it("refuses the request when the record can't be read, and doesn't keep the failure", async () => {
    let fail = true;
    const { check, lookups } = setup(() => (fail ? Object.assign(new Error("down"), { name: "ProvisionedThroughputExceededException" }) : undefined));
    await expect(check(event(fresh), USER)).rejects.toThrow("down");
    fail = false;
    await expect(check(event(fresh), USER)).resolves.toBeUndefined();
    expect(lookups).toEqual([USER, USER]);
  });
});

describe("sessionCheckFromEnv", () => {
  it("reads the function's own table, and won't start without one", () => {
    expect(() => sessionCheckFromEnv({})).toThrow("TABLE_NAME is not set");
    expect(typeof sessionCheckFromEnv({ TABLE_NAME: "app", AWS_REGION: "test-local-1" })).toBe("function");
  });
});

describe("the password reset record", () => {
  it("reads only passwordResetAt in the user's own partition, strongly consistent", async () => {
    const inputs: Record<string, unknown>[] = [];
    const answers: unknown[] = [{ Item: { passwordResetAt: "2026-10-08T11:59:00.000Z" } }, {}, { Item: { passwordResetAt: "garbage" } }, { Item: { passwordResetAt: 5 } }];
    const db = fakeDb(async (command) => {
      inputs.push(command.input);
      return answers.shift();
    });
    expect(await passwordResetAt(db, USER)).toBe(Date.parse("2026-10-08T11:59:00.000Z"));
    expect(await passwordResetAt(db, USER)).toBeUndefined();
    expect(await passwordResetAt(db, USER)).toBeUndefined();
    expect(await passwordResetAt(db, USER)).toBeUndefined();
    expect(inputs[0]).toEqual({
      TableName: "fake",
      Key: { PK: `USER#${USER}`, SK: "PASSWORD_RESET" },
      ProjectionExpression: "#at",
      ExpressionAttributeNames: { "#at": "passwordResetAt" },
      ConsistentRead: true,
    });
  });

  it("writes only the record, only ever later, returning nothing, with a deadline when asked", async () => {
    const sent: { input: Record<string, unknown>; options: unknown }[] = [];
    const db = fakeDb(async (command, options) => {
      sent.push({ input: command.input, options });
      return {};
    });
    const at = new Date(NOW);
    expect(await recordPasswordReset(db, USER, at)).toBe(true);
    expect(await recordPasswordReset(db, USER, at, { timeoutMs: 1000 })).toBe(true);
    expect(sent[0]?.input).toEqual({
      TableName: "fake",
      Key: { PK: `USER#${USER}`, SK: "PASSWORD_RESET" },
      UpdateExpression: "SET #at = :at",
      ConditionExpression: "(attribute_not_exists(#pk) OR #sk = :sk) AND (attribute_not_exists(#at) OR #at < :at)",
      ExpressionAttributeNames: { "#pk": "PK", "#sk": "SK", "#at": "passwordResetAt" },
      ExpressionAttributeValues: { ":sk": "PASSWORD_RESET", ":at": at.toISOString() },
    });
    expect(sent[0]?.options).toBeUndefined();
    expect((sent[1]?.options as { abortSignal?: unknown }).abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("says when a later time is already there, and throws anything else", async () => {
    const failing = (error: unknown) => fakeDb(async () => Promise.reject(error));
    expect(await recordPasswordReset(failing(Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" })), USER, new Date(NOW))).toBe(false);
    await expect(recordPasswordReset(failing(Object.assign(new Error("denied"), { name: "AccessDeniedException" })), USER, new Date(NOW))).rejects.toThrow("denied");
    await expect(recordPasswordReset(failing(null), USER, new Date(NOW))).rejects.toBeNull();
    await expect(recordPasswordReset(offlineDb(), USER, new Date(Number.NaN))).rejects.toThrow("Not a time");
    await expect(recordPasswordReset(offlineDb(), "not a user", new Date(NOW))).rejects.toThrow();
    await expect(passwordResetAt(offlineDb(), "USER#x/../")).rejects.toThrow();
  });
});

describe("every handler the app's tokens reach", () => {
  const obs: Observability = {
    region: "test-local-1",
    logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} } as unknown as Observability["logger"],
    count: () => {},
    gauge: () => {},
    flush: () => {},
  };
  const never = () => {
    throw new Error("reached past the session check");
  };
  const refuse: (seen: string[]) => SessionCheck = (seen) => async (_event, userId) => {
    seen.push(userId);
    throw passwordReset();
  };
  const handlers = {
    data: (sessionCheck: SessionCheck) => createDataHandler({ dbForTeam: never, obs, now: () => NOW, sessionCheck }),
    account: (sessionCheck: SessionCheck) =>
      createAccountHandler({ dbFor: never, userInfo: never, emailCodes: {} as never, totp: {} as never, issuerUrl: ISSUER, obs, mailer: {} as never, deleteUser: never, deletions: {} as never, now: () => NOW, sessionCheck }),
    billing: (sessionCheck: SessionCheck) =>
      createBillingHandler({ dbFor: never, stripe: never, priceFor: never, portalConfiguration: never, issuerUrl: ISSUER, userInfo: never, appUrl: "https://app.example.test", obs, now: () => NOW, sessionCheck } as never),
    receipts: (sessionCheck: SessionCheck) => createReceiptsHandler({ dbFor: never, obs, model: {} as never, modelId: "model", now: () => NOW, sessionCheck } as never),
  };
  const routes = { data: DATA_ROUTES, account: ACCOUNT_ROUTES, billing: BILLING_ROUTES, receipts: RECEIPT_ROUTES };

  for (const [name, make] of Object.entries(handlers)) {
    it(`${name}: refuses every route with 401 password_reset before anything else runs`, async () => {
      for (const route of routes[name as keyof typeof routes]) {
        const seen: string[] = [];
        const response = await make(refuse(seen))(event({}, routeKey(route), { teamId: "t1", userId: "u2", inviteId: "i1", key: "k", projectId: "p" }));
        expect(response.statusCode, routeKey(route)).toBe(401);
        expect(JSON.parse(String(response.body))).toEqual({ error: { code: "unauthenticated", message: passwordReset().message, reason: "password_reset" } });
        expect(seen).toEqual([USER]);
      }
    });
  }
});
