// Test accounts and test teams (supply-checkout-o60.2, src/data/test-accounts.ts):
// who counts as a test account, that only POST /teams marks a team and only
// from Cognito's verified email, that nothing can set or clear the mark, that
// it only leaves customer-activity metrics out, and that it grants nothing.

import { beforeEach, describe, expect, it } from "vitest";
import type { DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import type { CognitoUser } from "../src/api/cognito-user.js";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { ACCOUNT_ROUTES, DATA_ROUTES, routeKey } from "../src/api/routes.js";
import { authorizeTeam, isAtDomain, isTestAccount, MEMBERS_PER_TRIAL_TEAM, TEAMS_PER_USER_PER_DAY, TRIAL_DAYS, testMailDomain } from "../src/data/index.js";
import { BusinessMetric, type BusinessMetricName, type Metadata, type Observability, skippedForTest, TEST_SKIPPED_METRICS } from "../src/observability/index.js";
import { accountPartitions, fakeMailer, unusedDeleteUser, unusedDeletionLog } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const DOMAIN = "e2e.example.test";
const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const DAY = 86400_000;

describe("testMailDomain", () => {
  it("is unset without a value, and refuses anything but a lowercase ASCII domain name", () => {
    expect(testMailDomain(undefined)).toBeUndefined();
    expect(testMailDomain("")).toBeUndefined();
    expect(testMailDomain(DOMAIN)).toBe(DOMAIN);
    expect(testMailDomain("xn--e2e-abc.example.test")).toBe("xn--e2e-abc.example.test");
    for (const bad of ["E2E.example.test", "e2e.example.test.", " e2e.example.test", "example", "*.example.test", "e2e..example.test", "-e2e.example.test", "\u04352\u0435.example.test", "e2e.example.test/x"]) {
      expect(() => testMailDomain(bad), bad).toThrow("TEST_MAIL_DOMAIN must be a lowercase domain name");
    }
  });
});

describe("isAtDomain and isTestAccount", () => {
  const verified = (email: unknown) => ({ email: email as string, emailVerified: true });

  it("matches the whole domain exactly, ignoring only ASCII letter case", () => {
    expect(isAtDomain(`run-1-owner@${DOMAIN}`, DOMAIN)).toBe(true);
    expect(isAtDomain("Run-1@E2E.Example.TEST", DOMAIN)).toBe(true); // public-safety: allow: made-up look-alikes
    // A dotted local part is still the domain's
    expect(isAtDomain(`evil.test@${DOMAIN}`, DOMAIN)).toBe(true);
  });

  it("refuses a subdomain, a parent, a look-alike, and a suffix or prefix match", () => {
    for (const address of [
      `a@x.${DOMAIN}`, // subdomain of the subdomain
      `a@x.y.${DOMAIN}`,
      "a@example.test", // the parent
      `a@${DOMAIN}.evil.test`, // the domain as a prefix
      `a@${DOMAIN}evil.test`,
      `a@evil${DOMAIN}`, // as a suffix
      "a@e2e-example.test", // public-safety: allow: made-up look-alikes
      "a@e2eexample.test", // public-safety: allow: made-up look-alikes
      "a@e2e.example.tes", // public-safety: allow: made-up look-alikes
      "a@e2e.examp1e.test", // public-safety: allow: made-up look-alikes
      `a@${DOMAIN}.`, // trailing dot
    ]) {
      expect(isAtDomain(address, DOMAIN), address).toBe(false);
    }
  });

  it("refuses Unicode look-alikes, invisible characters, spaces and anything that isn't one plain address", () => {
    for (const address of [
      "a@\u04352\u0435.example.test", // Cyrillic \u0435
      "a@\uff452\uff45.example.test", // fullwidth letters, which NFKC folds to ASCII
      "a@e2e\uff0eexample.test", // fullwidth full stop
      "a@e2e\u3002example.test", // ideographic full stop
      "a@e2e.exam\u200bple.test", // zero-width space (public-safety: allow: made-up look-alikes)
      "a@e2e.example.test\u200d", // public-safety: allow: made-up look-alikes
      "a@E2E.EXAMPLE.TEST\u0307", // a combining mark after the case fold (public-safety: allow: made-up look-alikes)
      "a@e2e.\u212aexample.test", // Kelvin sign, which lowercases to k
      ` a@${DOMAIN}`,
      `a@${DOMAIN} `,
      `a@${DOMAIN}\n`,
      `a@${DOMAIN}@evil.test`, // two @
      `"x@evil.test"@${DOMAIN}`, // public-safety: allow: made-up look-alikes
      `@${DOMAIN}`, // no local part
      DOMAIN,
      "",
    ]) {
      expect(isAtDomain(address, DOMAIN), JSON.stringify(address)).toBe(false);
    }
    for (const value of [undefined, null, 42, { toString: () => `a@${DOMAIN}` }, [`a@${DOMAIN}`]]) expect(isAtDomain(value, DOMAIN)).toBe(false);
  });

  it("needs a configured domain", () => {
    expect(isAtDomain(`a@${DOMAIN}`, undefined)).toBe(false);
    expect(isAtDomain(`a@${DOMAIN}`, "")).toBe(false);
    expect(isTestAccount(verified(`a@${DOMAIN}`), undefined)).toBe(false);
  });

  it("is a test account only with a verified address there, as Cognito says it", () => {
    expect(isTestAccount(verified(`a@${DOMAIN}`), DOMAIN)).toBe(true);
    expect(isTestAccount({ email: `a@${DOMAIN}`, emailVerified: false }, DOMAIN)).toBe(false);
    // Exactly true: never a truthy string or anything else
    expect(isTestAccount({ email: `a@${DOMAIN}`, emailVerified: "true" as unknown as boolean }, DOMAIN)).toBe(false);
    expect(isTestAccount({ emailVerified: true }, DOMAIN)).toBe(false);
    expect(isTestAccount(undefined, DOMAIN)).toBe(false);
    expect(isTestAccount(verified("a@example.test"), DOMAIN)).toBe(false);
  });
});

describe("skippedForTest", () => {
  it("skips only customer-activity metrics, and only for test: true exactly", () => {
    expect(skippedForTest(BusinessMetric.SignUps, { teamId: "t", test: true })).toBe(true);
    expect(skippedForTest(BusinessMetric.SignUps, { teamId: "t" })).toBe(false);
    expect(skippedForTest(BusinessMetric.SignUps)).toBe(false);
    expect(skippedForTest(BusinessMetric.SignUps, { test: "true" })).toBe(false);
    expect(skippedForTest(BusinessMetric.SignUps, { test: 1 })).toBe(false);
    // A failure a test hits is a real failure, and it's counted
    for (const metric of [BusinessMetric.ReceiptReadFailures, BusinessMetric.InvitesFailed, BusinessMetric.CheckoutSessionErrors, BusinessMetric.SeatSyncQueueFailures, BusinessMetric.TeamClosedNoticeFailures, BusinessMetric.ConditionalWriteConflicts, BusinessMetric.ReceiptTrialCapReached]) {
      expect(skippedForTest(metric, { test: true }), metric).toBe(false);
    }
    for (const metric of TEST_SKIPPED_METRICS) expect(metric).not.toMatch(/Fail|Error|Drift|Refused|Bounce|Complaint|Conflict|Cap/);
    // A failure's denominator is sent too (infra/test/observability.test.ts checks every ratio alarm)
    for (const metric of [BusinessMetric.Writes, BusinessMetric.ReceiptReads]) expect(skippedForTest(metric, { test: true }), metric).toBe(false);
  });
});

// The API, as a test account and as anyone else

const OWNER = "user-owner"; // a customer, owner of team-a
const PROBE = "user-probe"; // a test account
const PROBE_UNVERIFIED = "user-probe-unverified";
const LOOKALIKE = "user-lookalike";
const MOVER = "user-mover"; // a customer who later moves their address to the test domain
const BASE_USERS: Record<string, CognitoUser> = {
  [OWNER]: { sub: OWNER, email: "owner@example.test", emailVerified: true, emailVerifiedInCognito: true, totp: false, federated: false },
  [PROBE]: { sub: PROBE, email: `run-1-owner@${DOMAIN}`, emailVerified: true, emailVerifiedInCognito: true, totp: false, federated: false },
  [PROBE_UNVERIFIED]: { sub: PROBE_UNVERIFIED, email: `run-2-owner@${DOMAIN}`, emailVerified: false, emailVerifiedInCognito: false, totp: false, federated: false },
  [LOOKALIKE]: { sub: LOOKALIKE, email: `run-3-owner@${DOMAIN}.evil.test`, emailVerified: true, emailVerifiedInCognito: true, totp: false, federated: false },
  [MOVER]: { sub: MOVER, email: "mover@example.test", emailVerified: true, emailVerifiedInCognito: true, totp: false, federated: false },
};

let USERS: Record<string, CognitoUser>;
let table: MemoryTable;
let now: number;
/** Every count() call, and whether the real count() would send it. */
let metrics: { metric: BusinessMetricName; value: number; metadata: Metadata; sent: boolean }[];
let account: ReturnType<typeof createAccountHandler>;
let data: ReturnType<typeof createDataHandler>;

function recordingObservability(): Observability {
  return {
    region: "test-local-1",
    logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1, metadata = {}) => {
      metrics.push({ metric, value, metadata, sent: !skippedForTest(metric, metadata) });
    },
    gauge: () => {},
    flush: () => {},
  };
}

beforeEach(() => {
  now = Date.parse("2026-10-07T12:00:00Z");
  metrics = [];
  USERS = structuredClone(BASE_USERS);
  table = new MemoryTable();
  table.seedTeam("team-a", { [OWNER]: "owner" });
  table.put({ PK: `USER#${OWNER}`, SK: "TEAM#team-a", type: "userTeam", userId: OWNER, teamId: "team-a", teamName: "team-a", role: "owner" });
  const dbFor: DbForAccount = (scope) => table.scoped(accountPartitions(scope));
  const userInfo = async (token: string) => {
    const user = USERS[token.replace(/^token-/, "")];
    if (!user) throw new ApiError(401, "unauthenticated", "Sign in again");
    return user;
  };
  const unused = async () => {
    throw new Error("unused");
  };
  const obs = recordingObservability();
  account = createAccountHandler({
    dbFor,
    userInfo,
    emailCodes: { send: unused, verify: unused },
    totp: { setPassword: unused, associate: unused, verify: unused, signOutEverywhere: unused },
    issuerUrl: ISSUER,
    obs,
    mailer: fakeMailer().mailer,
    deleteUser: unusedDeleteUser,
    deletions: unusedDeletionLog,
    testMailDomain: DOMAIN,
    now: () => now,
  });
  data = createDataHandler({ dbForTeam: (teamId) => table.dataDb(teamId), obs, now: () => now });
});

function apiEvent(routes: readonly { method: string; path: string }[], method: string, path: string, user: string, body?: unknown, headers: Record<string, string> = {}): DataEvent {
  const segments = path.split("/");
  const route = routes.find((r) => {
    const parts = r.path.split("/");
    return r.method === method && parts.length === segments.length && parts.every((p, i) => p.startsWith("{") || p === segments[i]);
  });
  const pathParameters: Record<string, string> = {};
  route?.path.split("/").forEach((p, i) => {
    if (p.startsWith("{")) pathParameters[p.slice(1, -1)] = segments[i] as string;
  });
  const claims = { sub: user, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER, client_id: "web" };
  return {
    version: "2.0",
    routeKey: route ? routeKey(route as Parameters<typeof routeKey>[0]) : `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: { authorization: `Bearer token-${user}`, ...headers },
    pathParameters,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function callAccount(method: string, path: string, user: string, body?: unknown, headers?: Record<string, string>) {
  const response = await account(apiEvent(ACCOUNT_ROUTES, method, path, user, body, headers));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

async function callData(method: string, path: string, user: string, body?: unknown) {
  const response = await data(apiEvent(DATA_ROUTES, method, path, user, body));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

let keys = 0;
async function newTeam(user: string, name = "Probe Team", body: Record<string, unknown> = { name }) {
  const res = await callAccount("POST", "/teams", user, body, { "Idempotency-Key": `create-key-${++keys}` });
  return { ...res, id: res.body?.team?.id as string };
}

const meta = (teamId: string) => table.get(`TEAM#${teamId}`, "META") as Record<string, unknown>;
const signUps = () => metrics.filter((m) => m.metric === BusinessMetric.SignUps);

describe("POST /teams marks a test account's team, and only that", () => {
  it("marks the team a verified test-domain account creates, and leaves its sign-up out of SignUps", async () => {
    const { status, id } = await newTeam(PROBE);
    expect(status).toBe(201);
    expect(meta(id).test).toBe(true);
    expect((await authorizeTeam(table.db(id), PROBE, id)).test).toBe(true);
    expect(signUps()).toEqual([{ metric: "SignUps", value: 1, metadata: { teamId: id, test: true }, sent: false }]);
  });

  it("doesn't mark a customer's team, and counts its sign-up", async () => {
    const { status, id } = await newTeam(OWNER, "Echo");
    expect(status).toBe(201);
    expect(meta(id)).not.toHaveProperty("test");
    expect((await authorizeTeam(table.db(id), OWNER, id)).test).toBe(false);
    expect(signUps()).toEqual([{ metric: "SignUps", value: 1, metadata: { teamId: id }, sent: true }]);
  });

  it("doesn't mark a team made by an unverified test-domain address or a look-alike domain", async () => {
    // The API lets an unverified account make a team, just not a test one
    const unverified = await newTeam(PROBE_UNVERIFIED);
    expect(unverified.status).toBe(201);
    expect(meta(unverified.id)).not.toHaveProperty("test");
    const lookalike = await newTeam(LOOKALIKE);
    expect(lookalike.status).toBe(201);
    expect(meta(lookalike.id)).not.toHaveProperty("test");
    expect(signUps().every((m) => m.sent)).toBe(true);
  });

  it("refuses a body that names the mark, from anyone", async () => {
    for (const [user, test] of [
      [OWNER, true],
      [PROBE, false],
      [PROBE, null],
    ] as const) {
      const res = await newTeam(user, "Named", { name: "Named", test });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe('Unexpected field "test"');
    }
    for (const user of [OWNER, PROBE]) expect((await callAccount("GET", "/me", user)).body.teams.map((t: { name: string }) => t.name)).not.toContain("Named");
  });

  it("isn't changed by headers that look like test markers that look like test markers", async () => {
    const res = await callAccount("POST", "/teams", OWNER, { name: "Headers" }, { "Idempotency-Key": "header-key-1", "x-test": "true", "x-test-account": "1" });
    expect(res.status).toBe(201);
    expect(meta(res.body.team.id)).not.toHaveProperty("test");
  });

  it("keeps the mark as it was made when the owner's address changes afterwards, either way", async () => {
    // A customer's team stays a customer's when they move to the test domain
    const customer = await newTeam(MOVER, "Mover Co");
    USERS[MOVER] = { ...(USERS[MOVER] as CognitoUser), email: `mover@${DOMAIN}` };
    expect((await callAccount("GET", "/me", MOVER)).status).toBe(200);
    expect(meta(customer.id)).not.toHaveProperty("test");
    // And a test team stays one when its owner moves away
    const probe = await newTeam(PROBE);
    USERS[PROBE] = { ...(USERS[PROBE] as CognitoUser), email: "probe@example.test" };
    expect((await callAccount("GET", "/me", PROBE)).status).toBe(200);
    expect(meta(probe.id).test).toBe(true);
  });

  it("isn't set or cleared by any route that writes the team: rename, members, invites, settings, close, reopen", async () => {
    const probe = await newTeam(PROBE);
    const customer = await newTeam(OWNER, "Customer");
    for (const id of [probe.id, customer.id]) {
      const user = id === probe.id ? PROBE : OWNER;
      expect((await callAccount("POST", `/teams/${id}/invites`, user, { email: "crew@example.test", role: "viewer" })).status).toBe(201);
      expect((await callData("PUT", `/teams/${id}/settings`, user, { equipmentMarkup: 10, expectedVersion: 0 })).status).toBe(200);
      const name = id === probe.id ? "Probe Team" : "Customer";
      expect((await callAccount("POST", `/teams/${id}/close`, user, { name })).status).toBe(200);
      expect((await callAccount("POST", `/teams/${id}/reopen`, user, { name })).status).toBe(200);
    }
    expect(meta(probe.id).test).toBe(true);
    expect(meta(customer.id)).not.toHaveProperty("test");
  });
});

describe("the mark grants nothing", () => {
  it("gives a test team the same trial, member cap and billing state as a customer's", async () => {
    const probe = await newTeam(PROBE, "Same");
    const customer = await newTeam(OWNER, "Same");
    const withoutId = (team: Record<string, unknown>) => Object.fromEntries(Object.entries(team).filter(([k]) => k !== "id"));
    const probeTeam = withoutId(probe.body.team);
    const customerTeam = withoutId(customer.body.team);
    expect(probeTeam).toEqual(customerTeam);
    expect(probeTeam).not.toHaveProperty("test");
    expect(probeTeam).toMatchObject({ plan: "trial", status: "trialing", memberCap: MEMBERS_PER_TRIAL_TEAM, trialEndsAt: new Date(now + TRIAL_DAYS * DAY).toISOString() });
    // /me shows the teams the same way, without the mark
    const me = (await callAccount("GET", "/me", PROBE)).body;
    expect(JSON.stringify(me)).not.toMatch(/"test"/);
  });

  it("holds a test account to the same daily team limit", async () => {
    for (let i = 0; i < TEAMS_PER_USER_PER_DAY; i++) expect((await newTeam(PROBE, `Probe ${i}`)).status).toBe(201);
    const over = await newTeam(PROBE, "One too many");
    expect(over.status).toBe(429);
  });

  it("makes a test team read-only when its trial ends, like any team", async () => {
    const probe = await newTeam(PROBE);
    now += (TRIAL_DAYS + 1) * DAY;
    const ctx = await authorizeTeam(table.db(probe.id), PROBE, probe.id, new Date(now));
    expect(ctx).toMatchObject({ test: true, subscriptionEnded: true, readOnlyReason: "trial_ended" });
    const write = await callData("PUT", `/teams/${probe.id}/settings`, PROBE, { equipmentMarkup: 10, expectedVersion: 0 });
    expect(write.status).toBe(403);
    expect(write.body.error.reason).toBe("subscription_ended");
  });

  it("gives a test team's owner no way into another team", async () => {
    const probe = await newTeam(PROBE);
    expect(probe.status).toBe(201);
    expect((await callData("GET", "/teams/team-a/settings", PROBE)).status).toBe(403);
    expect((await callAccount("GET", "/teams/team-a/members", PROBE)).status).toBe(403);
  });
});

describe("customer-activity metrics leave test teams out", () => {
  it("doesn't send a test team's sign-up, invites, closure and reopening; sends its writes and conflicts (a ratio alarm's two sides), marked; sends a customer's", async () => {
    const probe = await newTeam(PROBE);
    const customer = await newTeam(OWNER, "Customer");
    for (const [id, user, name] of [
      [probe.id, PROBE, "Probe Team"],
      [customer.id, OWNER, "Customer"],
    ] as const) {
      expect((await callData("PUT", `/teams/${id}/settings`, user, { equipmentMarkup: 10, expectedVersion: 0 })).status).toBe(200);
      // A stale version: a 409, counted as a conflict
      expect((await callData("PUT", `/teams/${id}/settings`, user, { equipmentMarkup: 12, expectedVersion: 0 })).status).toBe(409);
      expect((await callAccount("POST", `/teams/${id}/invites`, user, { email: "crew@example.test", role: "viewer" })).status).toBe(201);
      expect((await callAccount("POST", `/teams/${id}/close`, user, { name })).status).toBe(200);
      expect((await callAccount("POST", `/teams/${id}/reopen`, user, { name })).status).toBe(200);
    }
    const of = (teamId: string) => metrics.filter((m) => m.metadata.teamId === teamId);
    const expected = [BusinessMetric.SignUps, BusinessMetric.Writes, BusinessMetric.ConditionalWriteConflicts, BusinessMetric.InvitesSent, BusinessMetric.TeamsClosed, BusinessMetric.TeamClosedNotices, BusinessMetric.TeamsReopened, BusinessMetric.TeamReopenedNotices];
    expect(of(probe.id).map((m) => m.metric)).toEqual(expected);
    expect(of(customer.id).map((m) => m.metric)).toEqual(expected);
    expect(of(probe.id).every((m) => m.metadata.test === true)).toBe(true);
    // Writes and ConditionalWriteConflicts are the "Writes rejected" alarm's two sides: both sent, marked
    expect(of(probe.id).filter((m) => m.sent).map((m) => m.metric)).toEqual([BusinessMetric.Writes, BusinessMetric.ConditionalWriteConflicts]);
    expect(of(customer.id).every((m) => !("test" in m.metadata) && m.sent)).toBe(true);
  });

  it("still counts a failure a test team hits, marked test", async () => {
    const probe = await newTeam(PROBE);
    // An invite SES won't take
    const refusing = fakeMailer();
    refusing.state.fail = "MessageRejected";
    const failing = createAccountHandler({
      dbFor: (scope) => table.scoped(accountPartitions(scope)),
      userInfo: async (token) => USERS[token.replace(/^token-/, "")] as CognitoUser,
      emailCodes: { send: async () => {}, verify: async () => {} },
      totp: { setPassword: async () => {}, associate: async () => "", verify: async () => {}, signOutEverywhere: async () => {} },
      issuerUrl: ISSUER,
      obs: recordingObservability(),
      mailer: refusing.mailer,
      deleteUser: unusedDeleteUser,
      deletions: unusedDeletionLog,
      testMailDomain: DOMAIN,
      now: () => now,
    });
    const res = await failing(apiEvent(ACCOUNT_ROUTES, "POST", `/teams/${probe.id}/invites`, PROBE, { email: "crew@example.test", role: "viewer" }));
    expect(res.statusCode).toBe(201);
    expect(metrics.filter((m) => m.metric === BusinessMetric.InvitesFailed)).toEqual([{ metric: "InvitesFailed", value: 1, metadata: { teamId: probe.id, reason: "not_sent", test: true }, sent: true }]);
  });
});

describe("who reads the mark", () => {
  // A guard for reviewers and later changes: every read of a test mark either feeds a metric's
  // metadata (testMark) or is one of the few known places that make or carry it. A new reader
  // (a limit, a check, billing) fails here until it's looked at.
  it("is only the metrics' metadata, the issuers that carry it, and the ops badge", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../src/", import.meta.url).pathname;
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    const readers: string[] = [];
    for (const file of files) {
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*\*)/.test(line)) return;
          // A property read of `test` (not RegExp's .test(...)), or the account check itself
          if (!/\w\.test\b(?!\s*\()|isTestAccount\(/.test(line)) return;
          // Into a metric's metadata, and nowhere else on the line
          const rest = line.replace(/testMark\(isTestAccount\(/g, "").replace(/testMark\(\w+\.test\)/g, "");
          if (/testMark\(/.test(line) && !/\w\.test\b(?!\s*\()|isTestAccount\(/.test(rest)) return;
          readers.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    const allowed: [string, RegExp][] = [
      // The issuers: authorizeTeam and createTeam carry it from META into TeamContext.test
      ["data/team-context.ts", /^this\.test = test;$/],
      ["data/team-context.ts", /meta\.test === true\);$/],
      ["data/team-context.ts", /^\.\.\.\(owner\.test === true \? \{ test: true as const \} : \{\}\),$/],
      ["data/team-context.ts", /team\.test === true\), created: true \};$/],
      // count() skips a customer-activity metric whose metadata says test: true
      ["observability/index.ts", /^return metadata\.test === true && TEST_SKIPPED_METRICS\.has\(metric\);$/],
      // The ops badge
      ["data/operator.ts", /item\.test === true\) test\.add\(teamId\);$/],
      // The background jobs carry it from META into what they read, for their metrics only (supply-checkout-o60.12)
      ["data/billing.ts", /^\.\.\.\(Item\.test === true \? \{ test: true as const \} : \{\}\),$/],
      ["data/team-lapse.ts", /^if \(Item\.test === true\) team\.test = true;$/],
      ["data/team-purge.ts", /, \.\.\.\(item\.test === true \? \{ test: true as const \} : \{\}\) \};$/],
      ["data/team-purge.ts", /^const mark = meta\.test === true \? \{ test: true as const \} : \{\};$/],
      // The purge counts its test teams' TeamsPurged apart, to send the rest
      ["ops/team-purge-handler.ts", /^if \(result\.test\) testPurged\+\+;$/],
      // POST /teams (into createTeam's owner.test) and DELETE /me (into AccountsDeleted's metadata)
      ["api/account-handler.ts", /^const test = isTestAccount\(user, deps\.testMailDomain\);$/],
      ["data/test-accounts.ts", /^export function isTestAccount\(/],
    ];
    const unknown = readers.filter((r) => !allowed.some(([file, pattern]) => r.startsWith(`${file}:`) && pattern.test(r.slice(r.indexOf(": ") + 2))));
    expect(unknown).toEqual([]);
  });
});
