// Password resets from the app's sign-in screen (supply-checkout-6uw.26):
//
// - the API's routes answer a reset request the same way whatever the
//   address, without looking it up: they count the address's and IP
//   address's limits (429 past one) and only queue it; confirming maps every
//   failed code to one answer;
// - the password reset function sends Cognito's code to an account that can
//   have one, a "sign in with Google" (or Apple) hint to an address only a
//   Google or Apple account has, and nothing to any other address, a disabled
//   account, or past the hints' limits;
// - the limits are all-or-nothing, keyed by hashes, each within its function's IAM policy;
// - no address, IP address, code or password is logged.

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPasswordResetHandler as createApi, meetsPasswordPolicy } from "../src/api/password-reset-handler.js";
import { PASSWORD_RESET_ROUTES, routeKey } from "../src/api/routes.js";
import {
  inviteLimitKey,
  ipv6Prefix,
  PASSWORD_RESET_HINTS_PER_DAY,
  PASSWORD_RESET_LIMITS,
  resetAddressKey,
  resetIpKey,
  takePasswordReset,
  takePasswordResetHint,
} from "../src/data/index.js";
import { PASSWORD_RESET_HINT_PARTITIONS, PASSWORD_RESET_LIMIT_ATTRIBUTES, PASSWORD_RESET_LIMIT_PREFIX, PASSWORD_RESET_REQUEST_PARTITIONS } from "../src/data/schema.js";
import { emailResourceNames, type PasswordResetRequest } from "../src/email/names.js";
import { createPasswordResetHandler, resetRequestOf } from "../src/email/password-reset-handler.js";
import { renderEmail } from "../src/email/templates.js";
import type { PoolUser } from "../src/identity/cognito-admin.js";
import { cognitoResetLookup, type ResetLookup } from "../src/identity/reset-lookup.js";
import { eventInvoker } from "../src/identity/welcome-invoke.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { fakeMailer, REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const APP = "https://app.example.com";
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_AppPool1`;
const ADDRESS = "pat.lee@example.com";
const TYPED = "Pat.Lee@Example.com";
const IP = "203.0.113.7";
const SUPPORT = "support@example.com";
const PASSWORD = "Correct-Horse-9";
const NOW = new Date("2026-10-08T15:30:00Z");

type Logged = { level: string; message: string; data: unknown };
let logs: Logged[];
let metrics: { metric: string; metadata: Record<string, unknown> }[];

beforeEach(() => {
  logs = [];
  metrics = [];
});

function fakeObservability(): Observability {
  const log = (level: string) => (message: string, data: unknown = {}) => logs.push({ level, message, data: data instanceof Error ? { name: data.name, message: data.message } : data });
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric: string, value = 1, metadata: Record<string, unknown> = {}) => {
      expect(value).toBe(1);
      metrics.push({ metric, metadata });
    },
    gauge: () => {},
    flush: () => {},
  } as unknown as Observability;
}

/** No address, IP address, code or password anywhere in the logs or metrics. */
function expectNothingPersonal() {
  const text = JSON.stringify({ logs, metrics });
  expect(text).not.toMatch(/example\.com|pat\.lee|203\.0\.113|2001:db8|123456|Correct-Horse/i);
}

/**
 * The two functions' IAM policies: UpdateItem naming only
 * PASSWORD_RESET_LIMIT_ATTRIBUTES, returning nothing, in the API function's
 * request partitions (api stack) or the worker's hint partitions (email stack).
 */
const like = (patterns: readonly string[]) => (pk: string) => patterns.some((p) => (p.endsWith("*") ? pk.startsWith(p.slice(0, -1)) : pk === p));
const apiPolicy = (command: string, input: Record<string, unknown>) => policyFor(like(PASSWORD_RESET_REQUEST_PARTITIONS), command, input);
const policy = (command: string, input: Record<string, unknown>) => policyFor(like(PASSWORD_RESET_HINT_PARTITIONS), command, input);
function policyFor(partition: (pk: string) => boolean, command: string, input: Record<string, unknown>): boolean {
  const one = (kind: string, body: Record<string, unknown>) => {
    const pk = String(((body.Key ?? {}) as { PK?: unknown }).PK ?? "");
    const names = Object.values((body.ExpressionAttributeNames ?? {}) as Record<string, string>);
    const named = [...names, ...String(body.UpdateExpression ?? "").match(/\b(?<!#)[A-Za-z]+(?= =)/g) ?? []];
    return (
      (kind === "Update" || kind === "UpdateCommand") &&
      pk.startsWith(PASSWORD_RESET_LIMIT_PREFIX) &&
      partition(pk) &&
      named.every((n) => (PASSWORD_RESET_LIMIT_ATTRIBUTES as readonly string[]).includes(n)) &&
      (body.ReturnValues === undefined || body.ReturnValues === "NONE")
    );
  };
  return command === "TransactWriteCommand"
    ? (input.TransactItems as Record<string, Record<string, unknown>>[]).every((op) => Object.entries(op).every(([kind, body]) => one(kind, body)))
    : one(command, input);
}

describe("the limits", () => {
  it("count reset requests per address and IP address, by the hour and the day, all or nothing", async () => {
    const table = new MemoryTable();
    const db = table.guarded(apiPolicy);
    // The worker's role can't count requests, nor the API's hints
    await expect(takePasswordReset(table.guarded(policy), "a".repeat(64), "b".repeat(64), NOW)).rejects.toThrow("not authorized");
    await expect(takePasswordResetHint(db, "a".repeat(64), NOW)).rejects.toThrow("not authorized");
    const address = resetAddressKey(ADDRESS), ip = resetIpKey(IP), other = resetIpKey("198.51.100.1");
    for (let i = 0; i < PASSWORD_RESET_LIMITS.addressPerHour; i++) expect(await takePasswordReset(db, address, ip, NOW)).toBe(true);
    // The address's hour is used up, from any IP address; the refused request counts nowhere
    expect(await takePasswordReset(db, address, other, NOW)).toBe(false);
    expect(table.get(`RESETLIMIT#IP#${other}`, "HOUR#2026-10-08T15")).toBeUndefined();
    expect(table.get(`RESETLIMIT#ADDRESS#${address}`, "HOUR#2026-10-08T15")).toEqual({
      PK: `RESETLIMIT#ADDRESS#${address}`,
      SK: "HOUR#2026-10-08T15",
      count: 3,
      expiresAt: Date.parse("2026-10-08T16:00:00Z") / 1000 + 86_400,
    });
    expect(table.get(`RESETLIMIT#ADDRESS#${address}`, "DAY#2026-10-08")).toMatchObject({ count: 3, expiresAt: Date.parse("2026-10-09T00:00:00Z") / 1000 + 86_400 });
    // The next hour has room, until the day is used up
    const later = new Date("2026-10-08T16:05:00Z");
    for (let i = 0; i < PASSWORD_RESET_LIMITS.addressPerDay - PASSWORD_RESET_LIMITS.addressPerHour; i++) expect(await takePasswordReset(db, address, ip, later)).toBe(true);
    expect(await takePasswordReset(db, address, ip, new Date("2026-10-08T18:00:00Z"))).toBe(false);
    // One IP address asking for many addresses
    const many = Array.from({ length: PASSWORD_RESET_LIMITS.ipPerHour + 1 }, (_, i) => resetAddressKey(`person${i}@example.com`));
    const results = [];
    for (const key of many) results.push(await takePasswordReset(db, key, other, NOW));
    expect(results.filter(Boolean)).toHaveLength(PASSWORD_RESET_LIMITS.ipPerHour);
    expect(results.at(-1)).toBe(false);
    // Nothing stored names an address or an IP address
    expect(JSON.stringify([...table.items.values()])).not.toMatch(/example|203\.0|198\.51/);
  });

  it("count provider hints: one an address a day, and a cap for everyone", async () => {
    const table = new MemoryTable();
    const db = table.guarded(policy);
    const address = resetAddressKey(ADDRESS);
    expect(await takePasswordResetHint(db, address, NOW)).toBe("ok");
    expect(await takePasswordResetHint(db, address, NOW)).toBe("address");
    expect(await takePasswordResetHint(db, address, new Date("2026-10-09T00:00:01Z"))).toBe("ok");
    table.put({ PK: "RESETLIMIT#HINT", SK: "DAY#2026-10-08", count: PASSWORD_RESET_HINTS_PER_DAY });
    expect(await takePasswordResetHint(db, resetAddressKey("someone@example.com"), NOW)).toBe("cap");
    // Both used up reads as the cap
    expect(await takePasswordResetHint(db, address, NOW)).toBe("cap");
    // A cap of 0 sends none
    expect(await takePasswordResetHint(db, resetAddressKey("third@example.com"), new Date("2026-10-10T00:00:00Z"), 0)).toBe("cap");
    expect(table.get(`RESETLIMIT#HINT#${resetAddressKey("someone@example.com")}`, "DAY#2026-10-08")).toBeUndefined();
  });

  it("retries a conflicting transaction, refuses one that keeps conflicting, and throws anything else", async () => {
    const table = new MemoryTable();
    const conflict = () => Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }] });
    let conflicts = 1;
    table.beforeTransactWrite = () => {
      if (conflicts-- > 0) throw conflict();
    };
    expect(await takePasswordResetHint(table.db(), "a".repeat(64), NOW)).toBe("ok");
    table.beforeTransactWrite = () => {
      throw conflict();
    };
    expect(await takePasswordResetHint(table.db(), "a".repeat(64), NOW)).toBe("address");
    expect(await takePasswordReset(table.db(), "a".repeat(64), "b".repeat(64), NOW)).toBe(false);
    table.beforeTransactWrite = () => {
      throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException" });
    };
    await expect(takePasswordResetHint(table.db(), "a".repeat(64), NOW)).rejects.toThrow("Transaction cancelled");
    await expect(takePasswordResetHint(table.guarded(() => false), "a".repeat(64), NOW)).rejects.toThrow("not authorized");
  });

  it("count an address by its mailbox, and an IP address by its network", () => {
    expect(resetAddressKey("pat.lee+reset@gmail.com")).toBe(resetAddressKey("PatLee@googlemail.com")); // public-safety: allow (a made-up mailbox at Gmail, whose dots and +tags fold)
    expect(resetAddressKey(ADDRESS)).toBe(inviteLimitKey(ADDRESS));
    expect(resetAddressKey(ADDRESS)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => resetAddressKey("not an address")).toThrow();
    // IPv6 by its /64, however it's written; an IPv4-mapped address as its IPv4 address
    expect(resetIpKey("2001:db8:0:1::5")).toBe(resetIpKey("2001:0DB8:0000:0001:ffff:1:2:3"));
    expect(resetIpKey("2001:db8:0:1::5")).not.toBe(resetIpKey("2001:db8:0:2::5"));
    expect(resetIpKey("::ffff:203.0.113.7")).toBe(resetIpKey(IP));
    expect(resetIpKey(IP)).not.toBe(resetIpKey("203.0.113.8"));
    expect(ipv6Prefix("::1")).toBe("0:0:0:0");
    expect(ipv6Prefix("2001:db8::")).toBe("2001:db8:0:0");
    expect(ipv6Prefix("fe80::1%eth0")).toBe("fe80:0:0:0");
    expect(ipv6Prefix("64:ff9b::192.0.2.1")).toBe("64:ff9b:0:0");
    expect(ipv6Prefix("1:2:3:4:5:6:7:8")).toBe("1:2:3:4");
    expect(() => resetIpKey("not-an-ip")).toThrow("Not an IP address");
  });

  it("are the schema's", () => {
    expect([...PASSWORD_RESET_LIMIT_ATTRIBUTES]).toEqual(["PK", "SK", "count", "expiresAt"]);
    expect([...PASSWORD_RESET_REQUEST_PARTITIONS]).toEqual(["RESETLIMIT#ADDRESS#*", "RESETLIMIT#IP#*"]);
    expect([...PASSWORD_RESET_HINT_PARTITIONS]).toEqual(["RESETLIMIT#HINT*"]);
    expect(emailResourceNames("prod").passwordResetFunction).toBe("supply-checkout-prod-password-reset");
  });
});

const user = (over: Partial<PoolUser> & { attributes?: Record<string, string> } = {}): PoolUser => ({
  username: "4f1c2b7e-9a3d-4e5f-8b6a-1c2d3e4f5a6b",
  status: "CONFIRMED",
  enabled: true,
  ...over,
  attributes: { email: ADDRESS, email_verified: "true", ...over.attributes },
});
const providerUser = (provider: "Google" | "SignInWithApple", id: string, over: Partial<PoolUser> & { attributes?: Record<string, string> } = {}): PoolUser => ({
  username: `${provider}_${id}`,
  status: "EXTERNAL_PROVIDER",
  enabled: true,
  ...over,
  attributes: { email: ADDRESS, email_verified: "true", identities: JSON.stringify([{ providerName: provider, providerType: provider, userId: id }]), ...over.attributes },
});
const google = (over: Partial<PoolUser> & { attributes?: Record<string, string> } = {}) => providerUser("Google", "107691234567890123456", over);

describe("the password reset function", () => {
  let table: MemoryTable;
  let lookup: { byAlias: ReturnType<typeof vi.fn>; byEmail: ReturnType<typeof vi.fn>; forgotPassword: ReturnType<typeof vi.fn> };
  let mail: ReturnType<typeof fakeMailer>;

  beforeEach(() => {
    table = new MemoryTable();
    lookup = { byAlias: vi.fn(async () => undefined), byEmail: vi.fn(async () => []), forgotPassword: vi.fn(async () => "sent") };
    mail = fakeMailer();
  });

  const run = (event: unknown = { email: TYPED }) =>
    createPasswordResetHandler({ lookup: lookup as unknown as ResetLookup, db: table.guarded(policy), mailer: mail.mailer, obs: fakeObservability(), supportAddress: SUPPORT, now: () => NOW })(event);
  const outcome = () => (logs.findLast((l) => l.message === "Password reset")?.data as { outcome?: string }).outcome;

  it("has Cognito email a code to an account that can have one, and sends nothing else", async () => {
    lookup.byAlias.mockResolvedValue(user());
    await run();
    expect(lookup.byAlias).toHaveBeenCalledWith(ADDRESS);
    expect(lookup.forgotPassword).toHaveBeenCalledWith("4f1c2b7e-9a3d-4e5f-8b6a-1c2d3e4f5a6b");
    expect(lookup.byEmail).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
    expect(outcome()).toBe("code");
    // A RESET_REQUIRED account too
    lookup.byAlias.mockResolvedValue(user({ status: "RESET_REQUIRED" }));
    await run();
    expect(lookup.forgotPassword).toHaveBeenCalledTimes(2);
    expectNothingPersonal();
  });

  it("sends nothing at all to an address with no account (the owner's decision, 2026-10-08)", async () => {
    await run();
    expect(lookup.byEmail).toHaveBeenCalledWith([ADDRESS, TYPED]);
    expect(lookup.forgotPassword).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
    expect(metrics).toEqual([]);
    expect(table.items.size).toBe(0);
    expect(outcome()).toBe("no_code");
    expectNothingPersonal();
  });

  it("sends nothing to an account Cognito won't send a code to: unconfirmed, unverified, or refused", async () => {
    for (const u of [user({ status: "UNCONFIRMED" }), user({ attributes: { email_verified: "false" } }), user({ status: "FORCE_CHANGE_PASSWORD" })]) {
      lookup.byAlias.mockResolvedValue(u);
      await run();
      expect(outcome()).toBe("no_code");
    }
    expect(lookup.forgotPassword).not.toHaveBeenCalled();
    lookup.byAlias.mockResolvedValue(user());
    lookup.forgotPassword.mockResolvedValue("refused");
    await run();
    expect(outcome()).toBe("no_code");
    expect(lookup.byEmail).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
  });

  it("sends nothing to a disabled account", async () => {
    lookup.byAlias.mockResolvedValue(user({ enabled: false }));
    await run();
    expect(outcome()).toBe("disabled");
    expect(lookup.forgotPassword).not.toHaveBeenCalled();
    expect(mail.sent).toEqual([]);
  });

  it("emails a Google or Apple account's verified address a hint to sign in with its provider, once a day", async () => {
    lookup.byEmail.mockResolvedValue([google({ attributes: { email: "PAT.LEE@example.com" } })]);
    await run();
    expect(mail.sent).toEqual([{ to: ADDRESS, input: { kind: "passwordResetProvider", signInWith: "Google", supportAddress: SUPPORT }, tags: {} }]);
    expect(metrics).toEqual([{ metric: BusinessMetric.PasswordResetProviderHints, metadata: { signInWith: "Google" } }]);
    expect(outcome()).toBe("hint");
    // One a day for an address
    metrics = [];
    await run({ email: ADDRESS });
    expect(mail.sent).toHaveLength(1);
    expect(outcome()).toBe("hint_limited");
    expect(metrics).toEqual([{ metric: BusinessMetric.PasswordResetsLimited, metadata: { limit: "hint" } }]);
    // Apple too
    table.items.clear();
    lookup.byEmail.mockResolvedValue([providerUser("SignInWithApple", "001234.abc")]);
    await run({ email: ADDRESS });
    expect(mail.sent.at(-1)?.input).toEqual({ kind: "passwordResetProvider", signInWith: "SignInWithApple", supportAddress: SUPPORT });
    expectNothingPersonal();
  });

  it("sends no hint to a provider user that's disabled or unverified, another address's, or not a provider user", async () => {
    lookup.byEmail.mockResolvedValue([
      google({ enabled: false }),
      providerUser("Google", "2", { attributes: { email_verified: "false" } }),
      providerUser("Google", "3", { attributes: { email: "other@example.com" } }),
      user({ username: "native-unverified", attributes: { email_verified: "true" } }),
    ]);
    await run();
    expect(outcome()).toBe("no_code");
    expect(mail.sent).toEqual([]);
    // One good one among them is enough
    lookup.byEmail.mockResolvedValue([google({ enabled: false }), providerUser("Google", "4")]);
    await run();
    expect(outcome()).toBe("hint");
  });

  it("counts Cognito's own limit on codes, and stops hints at the day's cap", async () => {
    lookup.byAlias.mockResolvedValue(user());
    lookup.forgotPassword.mockResolvedValue("limited");
    await run();
    expect(outcome()).toBe("code_limited");
    expect(metrics).toEqual([{ metric: BusinessMetric.PasswordResetsLimited, metadata: { limit: "cognito" } }]);
    metrics = [];
    lookup.byAlias.mockResolvedValue(undefined);
    lookup.byEmail.mockResolvedValue([google()]);
    table.put({ PK: "RESETLIMIT#HINT", SK: "DAY#2026-10-08", count: PASSWORD_RESET_HINTS_PER_DAY });
    await run();
    expect(outcome()).toBe("hint_capped");
    expect(metrics).toEqual([{ metric: BusinessMetric.PasswordResetHintsCapped, metadata: { limit: "hint" } }]);
    expect(mail.sent).toEqual([]);
  });

  it("logs a hint SES refused and doesn't throw, but throws anything else", async () => {
    lookup.byEmail.mockResolvedValue([google()]);
    mail.state.fail = "MessageRejected";
    await run();
    expect(outcome()).toBe("hint_refused");
    expect(logs).toContainEqual({ level: "warn", message: "Password reset hint not sent", data: { error: "MessageRejected" } });
    const mailer = { send: async () => Promise.reject(new Error("boom")) };
    const handler = createPasswordResetHandler({ lookup: lookup as unknown as ResetLookup, db: table.db(), mailer, obs: fakeObservability(), supportAddress: SUPPORT });
    lookup.byEmail.mockResolvedValue([google({ attributes: { email: "new@example.com" } })]);
    await expect(handler({ email: "new@example.com" })).rejects.toThrow("boom");
    lookup.byAlias.mockRejectedValue(new Error("AdminGetUser failed: 500 InternalErrorException"));
    await expect(handler({ email: "new2@example.com" })).rejects.toThrow("AdminGetUser failed");
  });

  it("does nothing with a request that isn't one", async () => {
    for (const event of [null, {}, { email: 7 }, { email: "x".repeat(321) }, { email: "not an address" }, { email: 'a"b@example.com' }]) {
      logs = [];
      await run(event);
      expect(outcome(), JSON.stringify(event)).toBe("invalid");
    }
    expect(lookup.byAlias).not.toHaveBeenCalled();
    expect(table.items.size).toBe(0);
    expect(resetRequestOf(undefined)).toBeUndefined();
    // Only the address is taken: anything else in the event is dropped
    expect(resetRequestOf({ email: ADDRESS, ip: IP, extra: 1 })).toEqual({ email: ADDRESS });
  });
});

describe("Cognito for the password reset function", () => {
  type Sent = { url: string; target: string; body: Record<string, unknown>; signed: boolean };
  let sent: Sent[];
  let reply: (target: string, body: Record<string, unknown>) => Response;
  const lookup = () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const target = String(headers.get("x-amz-target")).replace("AWSCognitoIdentityProviderService.", "");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push({ url: String(url), target, body, signed: headers.has("authorization") });
      return reply(target, body);
    }) as unknown as typeof globalThis.fetch;
    return cognitoResetLookup({ region: REGION, userPoolId: "pool-1", clientId: "web-client", fetch, credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } });
  };
  const error = (status: number, type: string) => Response.json({ __type: `com.amazonaws#${type}`, message: `about ${ADDRESS}` }, { status });

  beforeEach(() => {
    sent = [];
    reply = () => Response.json({});
  });

  it("finds the native user by alias, and none when Cognito has none", async () => {
    reply = () => Response.json({ Username: "u-1", UserStatus: "CONFIRMED", Enabled: true, UserAttributes: [{ Name: "email", Value: TYPED }, { Name: "x" }] });
    expect(await lookup().byAlias(ADDRESS)).toEqual({ username: "u-1", status: "CONFIRMED", enabled: true, attributes: { email: TYPED } });
    expect(sent).toEqual([{ url: `https://cognito-idp.${REGION}.amazonaws.com/`, target: "AdminGetUser", body: { UserPoolId: "pool-1", Username: ADDRESS }, signed: true }]);
    reply = () => Response.json({ UserStatus: 7 });
    expect(await lookup().byAlias(ADDRESS)).toBeUndefined();
    reply = () => error(400, "UserNotFoundException");
    expect(await lookup().byAlias(ADDRESS)).toBeUndefined();
    reply = () => error(400, "InternalErrorException");
    await expect(lookup().byAlias(ADDRESS)).rejects.toThrow(/^AdminGetUser failed: 400 InternalErrorException$/);
  });

  it("lists users by each address once, skipping one that can't go in a filter", async () => {
    reply = (_target, body) =>
      Response.json({ Users: [{ Username: "Google_1", UserStatus: "EXTERNAL_PROVIDER", Enabled: true, Attributes: [{ Name: "email", Value: String(body.Filter).slice(9, -1) }] }, null, { Username: 5 }] });
    const users = await lookup().byEmail([ADDRESS, ADDRESS, TYPED, 'a"b@example.com', "back\\slash@example.com"]);
    expect(sent.map((s) => s.body)).toEqual([
      { UserPoolId: "pool-1", Filter: `email = "${ADDRESS}"`, Limit: 60 },
      { UserPoolId: "pool-1", Filter: `email = "${TYPED}"`, Limit: 60 },
    ]);
    // The same user found twice is listed once
    expect(users).toEqual([{ username: "Google_1", status: "EXTERNAL_PROVIDER", enabled: true, attributes: { email: TYPED } }]);
    reply = () => Response.json({});
    expect(await lookup().byEmail([ADDRESS])).toEqual([]);
  });

  it("asks Cognito to send a code with the web client, unsigned, and reads its refusals", async () => {
    expect(await lookup().forgotPassword("u-1")).toBe("sent");
    expect(sent).toEqual([{ url: `https://cognito-idp.${REGION}.amazonaws.com/`, target: "ForgotPassword", body: { ClientId: "web-client", Username: "u-1" }, signed: false }]);
    for (const type of ["LimitExceededException", "TooManyRequestsException"]) {
      reply = () => error(400, type);
      expect(await lookup().forgotPassword("u-1")).toBe("limited");
    }
    for (const type of ["UserNotFoundException", "InvalidParameterException", "NotAuthorizedException"]) {
      reply = () => error(400, type);
      expect(await lookup().forgotPassword("u-1")).toBe("refused");
    }
    reply = () => error(400, "CodeDeliveryFailureException");
    await expect(lookup().forgotPassword("u-1")).rejects.toThrow(/^ForgotPassword failed: 400 CodeDeliveryFailureException$/);
    reply = () => new Response("nope", { status: 500 });
    await expect(lookup().forgotPassword("u-1")).rejects.toThrow(/^ForgotPassword failed: 500$/);
  });
});

describe("the password reset routes", () => {
  let queued: PasswordResetRequest[];
  let queue: (request: PasswordResetRequest) => Promise<void>;
  let confirmed: Record<string, unknown>[];
  let reply: () => Response | Promise<Response>;
  let handler: ReturnType<typeof createApi>;
  let table: MemoryTable;

  beforeEach(() => {
    table = new MemoryTable();
    queued = [];
    confirmed = [];
    queue = async (request) => {
      queued.push(request);
    };
    reply = () => Response.json({});
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`https://cognito-idp.${REGION}.amazonaws.com/`);
      expect(new Headers(init?.headers).get("x-amz-target")).toBe("AWSCognitoIdentityProviderService.ConfirmForgotPassword");
      confirmed.push(JSON.parse(String(init?.body)));
      return reply();
    }) as unknown as typeof globalThis.fetch;
    handler = createApi({ config: { clientId: "web-client", issuerUrl: ISSUER, allowedOrigins: [APP] }, obs: fakeObservability(), queue: (r) => queue(r), fetch, db: table.guarded(apiPolicy), now: () => NOW });
  });

  const event = (path: string, body: unknown, options: { origin?: string | null; ip?: string | null } = {}): APIGatewayProxyEventV2 =>
    ({
      version: "2.0",
      routeKey: `POST ${path}`,
      rawPath: path,
      headers: options.origin === null ? {} : { origin: options.origin ?? APP },
      requestContext: { http: { method: "POST", path, sourceIp: options.ip === undefined ? IP : options.ip } },
      body: typeof body === "string" ? body : JSON.stringify(body),
      isBase64Encoded: false,
    }) as unknown as APIGatewayProxyEventV2;
  const call = async (...args: Parameters<typeof event>) => {
    const response = await handler(event(...args));
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
  };

  it("are POST routes with their own throttles", () => {
    expect(PASSWORD_RESET_ROUTES.map(routeKey)).toEqual(["POST /auth/password-reset", "POST /auth/password-reset/confirm"]);
    for (const r of PASSWORD_RESET_ROUTES) expect(r.throttle.rate).toBeLessThanOrEqual(5);
  });

  it("queue a reset request, counted against the address's and IP address's limits, and answer 204, whatever the address", async () => {
    for (const email of [TYPED, " someone-else@example.org ", "x@example.com"]) {
      expect(await call("/auth/password-reset", { email })).toEqual({ status: 204, body: undefined });
    }
    expect(queued).toEqual([
      { email: TYPED },
      { email: "someone-else@example.org" },
      { email: "x@example.com" },
    ]);
    // Counted by the address's usual form and the IP address, both hashed
    expect(table.get(`RESETLIMIT#ADDRESS#${resetAddressKey(ADDRESS)}`, "DAY#2026-10-08")).toMatchObject({ count: 1 });
    expect(table.get(`RESETLIMIT#IP#${resetIpKey(IP)}`, "DAY#2026-10-08")).toMatchObject({ count: 3 });
    expect(logs.filter((l) => l.message === "Password reset").map((l) => l.data)).toEqual([{ outcome: "queued" }, { outcome: "queued" }, { outcome: "queued" }]);
    expectNothingPersonal();
  });

  it("refuse a bad body, a missing source address and an unknown origin before queueing anything", async () => {
    expect(await call("/auth/password-reset", { email: "not an address" })).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    expect(await call("/auth/password-reset", { email: ADDRESS, extra: 1 })).toMatchObject({ status: 400 });
    expect(await call("/auth/password-reset", "nope")).toMatchObject({ status: 400 });
    expect(await call("/auth/password-reset", { email: 5 })).toMatchObject({ status: 400 });
    expect(await call("/auth/password-reset", { email: ADDRESS }, { ip: null })).toMatchObject({ status: 400, body: { error: { message: "No source address" } } });
    expect(await call("/auth/password-reset", { email: ADDRESS }, { ip: "not-an-ip" })).toMatchObject({ status: 400, body: { error: { message: "No source address" } } });
    expect(await call("/auth/password-reset", { email: ADDRESS }, { origin: "https://evil.example" })).toMatchObject({ status: 403 });
    expect(await call("/auth/password-reset", { email: ADDRESS }, { origin: null })).toMatchObject({ status: 403 });
    const other = await handler({ ...event("/auth/password-reset", {}), routeKey: "POST /auth/other" });
    expect(other.statusCode).toBe(404);
    expect(queued).toEqual([]);
    expect(table.items.size).toBe(0);
  });

  it("answer 429 past the address's or the IP address's limit, pointing at the sign-in page's reset, and queue nothing", async () => {
    const limited = { status: 429, body: { error: { code: "quota_exceeded", reason: "rate_limited", message: "Too many reset requests for now. Try again later, or choose Sign in and use the reset on that page" } } };
    for (let i = 0; i < PASSWORD_RESET_LIMITS.addressPerHour; i++) expect((await call("/auth/password-reset", { email: ADDRESS }, { ip: `198.51.100.${i}` })).status).toBe(204);
    // The address's, from another IP address, whatever its case
    expect(await call("/auth/password-reset", { email: TYPED }, { ip: "198.51.100.200" })).toEqual(limited);
    // The IP address's, for other addresses
    for (let i = 0; i < PASSWORD_RESET_LIMITS.ipPerHour; i++) await call("/auth/password-reset", { email: `person${i}@example.com` }, { ip: "2001:db8:0:1::1" });
    expect(await call("/auth/password-reset", { email: "one-more@example.com" }, { ip: "2001:db8:0:1::99" })).toEqual(limited);
    expect(queued).toHaveLength(PASSWORD_RESET_LIMITS.addressPerHour + PASSWORD_RESET_LIMITS.ipPerHour);
    expect(metrics.filter((m) => m.metric === BusinessMetric.PasswordResetsLimited)).toEqual([
      { metric: BusinessMetric.PasswordResetsLimited, metadata: { limit: "request" } },
      { metric: BusinessMetric.PasswordResetsLimited, metadata: { limit: "request" } },
    ]);
    expectNothingPersonal();
  });

  it("answer 500 when the limits can't be counted, and queue nothing", async () => {
    handler = createApi({ config: { clientId: "web-client", issuerUrl: ISSUER, allowedOrigins: [APP] }, obs: fakeObservability(), queue, db: table.guarded(policy) });
    expect(await call("/auth/password-reset", { email: ADDRESS })).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
    expect(queued).toEqual([]);
  });

  it("answer 503 when the request couldn't be queued, naming only the error", async () => {
    queue = async () => Promise.reject(Object.assign(new Error(`Invoke failed for ${ADDRESS}`), { name: "TooManyRequestsException" }));
    expect(await call("/auth/password-reset", { email: ADDRESS })).toMatchObject({ status: 503, body: { error: { code: "unavailable" } } });
    expect(logs).toContainEqual({ level: "error", message: "Password reset not queued", data: { error: "TooManyRequestsException" } });
    expectNothingPersonal();
  });

  it("confirm a reset with Cognito and the web client", async () => {
    expect(await call("/auth/password-reset/confirm", { email: TYPED, code: "123456", password: PASSWORD })).toEqual({ status: 204, body: undefined });
    expect(confirmed).toEqual([{ ClientId: "web-client", Username: ADDRESS, ConfirmationCode: "123456", Password: PASSWORD }]);
    expectNothingPersonal();
  });

  it("answer every failed code the same way, and a refused password as invalid", async () => {
    const answers: Record<string, unknown> = {};
    for (const type of ["CodeMismatchException", "ExpiredCodeException", "UserNotFoundException", "NotAuthorizedException", "InvalidParameterException", "InvalidPasswordException", "PasswordHistoryPolicyViolationException", "LimitExceededException", "TooManyFailedAttemptsException", "TooManyRequestsException"]) {
      reply = () => Response.json({ __type: type, message: `for ${ADDRESS}` }, { status: 400 });
      answers[type] = await call("/auth/password-reset/confirm", { email: ADDRESS, code: "123456", password: PASSWORD });
    }
    const wrong = { status: 400, body: { error: { code: "bad_request", message: "That code isn't right, or it has expired. Check it, or ask for a new one", reason: "code_mismatch" } } };
    for (const type of ["CodeMismatchException", "ExpiredCodeException", "UserNotFoundException", "NotAuthorizedException", "InvalidParameterException"]) expect(answers[type], type).toEqual(wrong);
    for (const type of ["InvalidPasswordException", "PasswordHistoryPolicyViolationException"]) expect(answers[type]).toMatchObject({ status: 400, body: { error: { reason: "password_invalid" } } });
    for (const type of ["LimitExceededException", "TooManyFailedAttemptsException", "TooManyRequestsException"]) expect(answers[type]).toMatchObject({ status: 429, body: { error: { code: "quota_exceeded" } } });
    // A malformed code is a wrong one, without asking Cognito
    confirmed = [];
    expect(await call("/auth/password-reset/confirm", { email: ADDRESS, code: "12345", password: PASSWORD })).toEqual(wrong);
    expect(await call("/auth/password-reset/confirm", { email: ADDRESS, code: 123456, password: PASSWORD })).toEqual(wrong);
    expect(confirmed).toEqual([]);
    expectNothingPersonal();
  });

  it("check the password against the pool's policy before Cognito sees it", async () => {
    for (const password of ["Short-1a", "alllowercase-123", "ALLUPPERCASE-123", "No-Digits-Here", "NoSymbols1234", " Leading-Space-1", 7, "A-1a".repeat(65)]) {
      expect(await call("/auth/password-reset/confirm", { email: ADDRESS, code: "123456", password }), String(password)).toMatchObject({ status: 400, body: { error: { reason: "password_invalid" } } });
    }
    expect(confirmed).toEqual([]);
    expect(meetsPasswordPolicy(PASSWORD)).toBe(true);
    expect(meetsPasswordPolicy("With a space-1A")).toBe(true);
  });

  it("answer 503 when Cognito fails or can't be reached", async () => {
    reply = () => new Response("nope", { status: 500 });
    expect(await call("/auth/password-reset/confirm", { email: ADDRESS, code: "123456", password: PASSWORD })).toMatchObject({ status: 503 });
    reply = () => Response.json({ __type: "CodeDeliveryFailureException" }, { status: 400 });
    expect(await call("/auth/password-reset/confirm", { email: ADDRESS, code: "123456", password: PASSWORD })).toMatchObject({ status: 503 });
    reply = () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    expect(await call("/auth/password-reset/confirm", { email: ADDRESS, code: "123456", password: PASSWORD })).toMatchObject({ status: 503 });
    expect(logs).toContainEqual({ level: "error", message: "Cognito unreachable", data: { error: "TimeoutError" } });
    expectNothingPersonal();
  });

  it("refuse to start with an issuer that isn't Cognito's", () => {
    expect(() => createApi({ config: { clientId: "c", issuerUrl: "https://evil.example/pool", allowedOrigins: [APP] }, obs: fakeObservability(), queue, db: table.db() })).toThrow(/ISSUER_URL/);
  });
});

describe("handing a request over", () => {
  it("is an asynchronous invoke of the function by name, with the request as its event", async () => {
    const calls: { url: string; headers: Headers; body: string }[] = [];
    let status = 202;
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response(null, { status, headers: status === 202 ? {} : { "x-amzn-errortype": "TooManyRequestsException:http://internal" } });
    }) as unknown as typeof globalThis.fetch;
    const invoke = eventInvoker({ region: REGION, functionName: "supply-checkout-prod-password-reset", timeoutMs: 1000, fetch, credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } });
    await invoke({ email: ADDRESS });
    expect(calls[0]?.url).toBe(`https://lambda.${REGION}.amazonaws.com/2015-03-31/functions/supply-checkout-prod-password-reset/invocations`);
    expect(calls[0]?.headers.get("x-amz-invocation-type")).toBe("Event");
    expect(JSON.parse(calls[0]?.body as string)).toEqual({ email: ADDRESS });
    status = 429;
    await expect(invoke({})).rejects.toMatchObject({ name: "TooManyRequestsException", message: "Invoke failed: 429 TooManyRequestsException" });
  });
});

describe("the provider hint", () => {
  it("says to sign in with the provider, linking only to the app", () => {
    const google = renderEmail({ kind: "passwordResetProvider", signInWith: "Google", supportAddress: SUPPORT }, { appUrl: APP });
    expect(google.subject).toBe("Sign in to Supply Checkout with Google");
    expect(google.text).toContain("This address signs in to Supply Checkout with Google, so it has no Supply Checkout password to reset");
    expect(google.text).toContain(`Write to us at ${SUPPORT}`);
    expect(google.text).toContain("which signs in with Google");
    const apple = renderEmail({ kind: "passwordResetProvider", signInWith: "SignInWithApple", supportAddress: SUPPORT }, { appUrl: APP });
    expect(apple.subject).toBe("Sign in to Supply Checkout with Apple");
    expect(apple.text).toContain("choose Apple and use this address");
    expect(() => renderEmail({ kind: "passwordResetProvider", signInWith: "Google", supportAddress: "<x>" }, { appUrl: APP })).toThrow();
    expect(() => renderEmail({ kind: "passwordResetProvider", signInWith: "Facebook" as "Google", supportAddress: SUPPORT }, { appUrl: APP })).toThrow();
  });
});
