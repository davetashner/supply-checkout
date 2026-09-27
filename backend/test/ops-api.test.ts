// The ops API (ADR 0015) against the in-memory table. Every DynamoDB call the
// ops handler makes must pass the operator-access role's policy (ops-policy.ts):
// GSI3 queries of the ops partitions only, comp attributes only on the tagged
// team, and puts (never updates or deletes) of operator audit items.

import { beforeEach, describe, expect, it } from "vitest";
import type { DataEvent } from "../src/api/data-handler.js";
import { createDataHandler } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { OPS_ROUTES, routeKey } from "../src/api/routes.js";
import { createTeam, latestCompEnd, liveComp, memberCap, MEMBERS_PER_TEAM, MEMBERS_PER_TRIAL_TEAM } from "../src/data/index.js";
import { OWNER_OPERATOR_AUDIT_ATTRIBUTES } from "../src/data/schema.js";
import type { Observability } from "../src/observability/index.js";
import type { OperatorDirectory } from "../src/operator/cognito.js";
import { createOpsHandler, groupsClaim, type OpsEvent } from "../src/operator/ops-handler.js";
import { REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";
import { opsPolicy } from "./ops-policy.js";

const OPS_ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_ops";
const CUSTOMER_ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const OPS_CLIENT = "ops-client";
const WEB_CLIENT = "web-client";
const NOW = Date.parse("2026-09-26T12:00:00Z");
const DAY = 86_400_000;
const OPERATOR = "op-sub-1";
const OWNER = "user-owner";
const OWNER_EMAIL = "owner@example.com";

let table: MemoryTable;
let now: number;
let denied: { command: string; input: Record<string, unknown> }[];
let tags: string[];
let logs: unknown[];
let directoryCalls: string[];
let revoked: Set<string>;
let groups: Map<string, string[]>;
let handler: ReturnType<typeof createOpsHandler>;
let teamA: string;
let teamB: string;

function fakeObservability(): Observability {
  const log = (...args: unknown[]) => logs.push(args);
  return {
    region: REGION,
    logger: { info: log, warn: log, error: log, addContext: () => {} } as unknown as Observability["logger"],
    count: () => {},
    gauge: () => {},
    flush: () => {},
  };
}

const directory: OperatorDirectory = {
  async getUser(token) {
    directoryCalls.push("getUser");
    const sub = token.replace(/^token-/, "");
    if (revoked.has(sub) || !groups.has(sub)) throw new ApiError(401, "unauthenticated", "Sign in again");
    return { username: `name-${sub}`, sub };
  },
  async groupsFor(username) {
    directoryCalls.push("groupsFor");
    return groups.get(username.replace(/^name-/, "")) ?? [];
  },
};

interface Claims {
  readonly iss?: string;
  readonly client_id?: string;
  readonly token_use?: string;
  readonly exp?: number;
  readonly sub?: string;
  readonly "cognito:groups"?: string;
}

function event(method: string, path: string, options: { body?: unknown; query?: Record<string, string>; claims?: Claims; key?: string; token?: string } = {}): OpsEvent {
  const segments = path.split("/");
  const route = OPS_ROUTES.find((r) => r.method === method && r.path.split("/").length === segments.length && r.path.split("/").every((s, i) => s.startsWith("{") || s === segments[i]));
  const params: Record<string, string> = {};
  route?.path.split("/").forEach((s, i) => {
    if (s.startsWith("{")) params[s.slice(1, -1)] = segments[i] as string;
  });
  const sub = options.claims?.sub ?? OPERATOR;
  const claims = { iss: OPS_ISSUER, client_id: OPS_CLIENT, token_use: "access", exp: Math.floor(now / 1000) + 900, sub, "cognito:groups": "[operators]", ...options.claims };
  return {
    routeKey: route ? routeKey(route) : `${method} ${path}`,
    rawPath: path,
    headers: { authorization: `Bearer ${options.token ?? `token-${sub}`}`, ...(options.key ? { "idempotency-key": options.key } : {}) },
    queryStringParameters: options.query,
    pathParameters: params,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims, scopes: [] } } },
  } as unknown as OpsEvent;
}

async function call(method: string, path: string, options: Parameters<typeof event>[2] = {}) {
  const response = await handler(event(method, path, options));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const teamOf = (teamId: string) => table.get(`TEAM#${teamId}`, "META") as Record<string, unknown>;
const auditItems = (teamId: string) => [...table.items.values()].filter((i) => i.PK === `OPAUDIT#${teamId}` && String(i.SK).startsWith("AUDIT#"));

beforeEach(async () => {
  now = NOW;
  table = new MemoryTable();
  denied = [];
  tags = [];
  logs = [];
  directoryCalls = [];
  revoked = new Set();
  groups = new Map([[OPERATOR, ["operators"]]]);
  const setup = table.db();
  teamA = (await createTeam(setup, { userId: OWNER, email: OWNER_EMAIL }, { name: "Acme Cleaning" }, new Date(NOW - 2 * DAY))).team.teamId;
  teamB = (await createTeam(setup, { userId: "user-b" }, { name: "Bravo Janitorial" }, new Date(NOW - DAY))).team.teamId;
  table.put({ PK: `TEAM#${teamA}`, SK: "SHEET#s1", type: "sheet", id: "s1", version: 1, client: "Secret client", date: "2026-09-26", items: {} });
  handler = createOpsHandler({
    dbFor: (operatorSub, teamId) => {
      tags.push(`${operatorSub} ${teamId ?? "."}`);
      return table.guarded(opsPolicy(teamId ?? ".", denied));
    },
    directory,
    issuerUrl: OPS_ISSUER,
    clientId: OPS_CLIENT,
    obs: fakeObservability(),
    now: () => now,
  });
});

describe("who gets in", () => {
  it("refuses a customer-pool token without asking Cognito or touching the table", async () => {
    const before = table.calls.length;
    const res = await call("GET", "/ops/teams", { claims: { iss: CUSTOMER_ISSUER, client_id: WEB_CLIENT } });
    expect(res.status).toBe(401);
    expect(directoryCalls).toEqual([]);
    expect(table.calls.length).toBe(before);
  });

  it.each<[string, Claims, number]>([
    ["another client of the ops pool", { client_id: WEB_CLIENT }, 401],
    ["an ID token", { token_use: "id" }, 401],
    ["an expired token", { exp: Math.floor(NOW / 1000) - 1 }, 401],
    ["a malformed sub", { sub: "not a sub!" }, 401],
    ["a token without the group", { "cognito:groups": "" }, 403],
    ["a token in another group", { "cognito:groups": "[support]" }, 403],
  ])("refuses %s", async (_what, claims, status) => {
    const res = await call("GET", "/ops/teams", { claims });
    expect(res.status).toBe(status);
    expect(directoryCalls).toEqual([]);
  });

  it("refuses a request with no token in the header", async () => {
    expect((await call("GET", "/ops/teams", { token: " " })).status).toBe(401);
  });

  it("refuses a request with no claims at all", async () => {
    const e = event("GET", "/ops/teams");
    (e.requestContext as unknown as { authorizer: unknown }).authorizer = undefined;
    expect((await handler(e)).statusCode).toBe(401);
  });

  it("asks Cognito on every request, and refuses a signed-out or disabled operator on the next one", async () => {
    expect((await call("GET", "/ops/teams")).status).toBe(200);
    expect(directoryCalls).toEqual(["getUser", "groupsFor"]);
    // admin-user-global-sign-out or admin-disable-user: GetUser refuses the same token
    revoked.add(OPERATOR);
    expect((await call("GET", "/ops/teams")).status).toBe(401);
  });

  it("refuses an operator removed from the group on the next request, though their token still says operators", async () => {
    expect((await call("GET", "/ops/teams")).status).toBe(200);
    groups.set(OPERATOR, []);
    const res = await call("GET", "/ops/teams");
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: "permission_denied", message: "Operators only" });
  });

  it("refuses a token whose user isn't the one Cognito names", async () => {
    groups.set("someone-else", ["operators"]);
    expect((await call("GET", "/ops/teams", { token: "token-someone-else" })).status).toBe(401);
  });

  it("refuses a pool member who isn't an operator (never in the group)", async () => {
    groups.set("member-only", []);
    expect((await call("GET", "/ops/teams", { claims: { sub: "member-only", "cognito:groups": "[operators]" } })).status).toBe(403);
  });

  it("answers 404 for a route it doesn't serve, and 500 without details when Cognito fails", async () => {
    expect((await call("GET", "/ops/nothing")).status).toBe(404);
    const broken = createOpsHandler({
      dbFor: () => table.db(),
      directory: { getUser: () => Promise.reject(new Error("GetUser failed: 500")), groupsFor: async () => [] },
      issuerUrl: OPS_ISSUER,
      clientId: OPS_CLIENT,
      obs: fakeObservability(),
      now: () => now,
    });
    const res = await broken(event("GET", "/ops/teams"));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body as string).error.message).toBe("Something went wrong");
  });

  it("reads the group claim as API Gateway hands it over, or as an array", () => {
    expect(groupsClaim("[operators]")).toEqual(["operators"]);
    expect(groupsClaim("[support operators]")).toEqual(["support", "operators"]);
    expect(groupsClaim(["operators", 1])).toEqual(["operators"]);
    expect(groupsClaim(undefined)).toEqual([]);
  });
});

describe("teams", () => {
  it("lists every team newest first with owners' emails, from the index only", async () => {
    const res = await call("GET", "/ops/teams");
    expect(res.status).toBe(200);
    expect(res.body.teams.map((t: { name: string }) => t.name)).toEqual(["Bravo Janitorial", "Acme Cleaning"]);
    const acme = res.body.teams[1];
    expect(acme).toMatchObject({ id: teamA, plan: "trial", status: "trialing", seats: 1, ownerCount: 1, version: 1, comp: null });
    expect(acme.owners).toEqual([{ userId: OWNER, email: OWNER_EMAIL, joinedAt: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toContain("Secret client");
    // Only what the index projects: never the team's home region
    expect(acme.homeRegion).toBeUndefined();
    expect(Object.keys(teamOf(teamA))).toContain("homeRegion");
    expect(denied).toEqual([]);
    expect(tags.every((t) => t.endsWith(" ."))).toBe(true);
  });

  it("searches by name or ID, and pages", async () => {
    expect((await call("GET", "/ops/teams", { query: { q: "acme" } })).body.teams.map((t: { id: string }) => t.id)).toEqual([teamA]);
    expect((await call("GET", "/ops/teams", { query: { q: teamB } })).body.teams.map((t: { id: string }) => t.id)).toEqual([teamB]);
    const first = await call("GET", "/ops/teams", { query: { limit: "1" } });
    expect(first.body.teams).toHaveLength(1);
    expect(first.body.cursor).toBe(teamB);
    const second = await call("GET", "/ops/teams", { query: { limit: "1", cursor: first.body.cursor } });
    expect(second.body.teams.map((t: { id: string }) => t.id)).toEqual([teamA]);
    expect(second.body.cursor).toBeUndefined();
  });

  it.each<Record<string, string>>([{ limit: "0" }, { limit: "abc" }, { cursor: "no-such-team" }, { cursor: "bad cursor" }, { q: "x".repeat(201) }])("refuses %o", async (query) => {
    expect((await call("GET", "/ops/teams", { query })).status).toBe(400);
  });

  it("shows one team, and audits the read before answering", async () => {
    const res = await call("GET", `/ops/teams/${teamA}`);
    expect(res.status).toBe(200);
    expect(res.body.team).toMatchObject({ id: teamA, name: "Acme Cleaning", owners: [{ userId: OWNER, email: OWNER_EMAIL }] });
    const [audit] = auditItems(teamA);
    expect(audit).toMatchObject({ type: "operatorAudit", action: "ops.team.read", operatorSub: OPERATOR, teamId: teamA, GSI3PK: "OPS#AUDIT#2026-09" });
    expect(denied).toEqual([]);
  });

  it("answers 404 for an unknown team and 400 for a bad ID", async () => {
    expect((await call("GET", "/ops/teams/no-such-team")).status).toBe(404);
    expect((await call("GET", "/ops/teams/bad%20id")).status).toBe(400);
  });
});

describe("comps", () => {
  const until = "2026-12-31";
  const comp = (body: Record<string, unknown>, key = "comp-key-0001") => call("PUT", `/ops/teams/${teamA}/comp`, { body, key });

  it("comps a team free: comp attributes and version only, with the audit in the same transaction", async () => {
    const before = teamOf(teamA);
    table.requests.length = 0;
    const res = await comp({ plan: "free", until, reason: "Pilot, 90 days", expectedVersion: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replayed: false, version: 2, comp: { plan: "free", until: "2026-12-31T00:00:00.000Z" } });
    const after = teamOf(teamA);
    expect(after).toMatchObject({ compPlan: "free", compUntil: "2026-12-31T00:00:00.000Z", compReason: "Pilot, 90 days", compBy: OPERATOR, version: 2 });
    // ADR 0009: only billing writes plan and status
    expect([after.plan, after.status, after.name]).toEqual([before.plan, before.status, before.name]);
    const writes = table.requests.filter((r) => r.command === "TransactWriteCommand");
    expect(writes).toHaveLength(1);
    const items = (writes[0]?.input.TransactItems ?? []) as Record<string, { Item?: Record<string, unknown> }>[];
    expect(items.map((i) => Object.keys(i)[0])).toEqual(["Update", "Put", "Put"]);
    const [audit] = auditItems(teamA);
    expect(audit).toMatchObject({ action: "ops.comp.set", before: null, after: { plan: "free", seats: null, until: "2026-12-31T00:00:00.000Z", reason: "Pilot, 90 days" }, idempotencyKey: "comp-key-0001" });
    expect(JSON.stringify(audit?.after)).not.toContain(OPERATOR);
    expect(tags).toContain(`${OPERATOR} ${teamA}`);
    expect(denied).toEqual([]);
    // The comp makes the team count as paying
    expect(memberCap(after, new Date(NOW))).toBe(MEMBERS_PER_TEAM);
  });

  it("replays a retry with the same key, and refuses the key for a different body", async () => {
    const body = { plan: "free", seats: 5, until, reason: "Pilot", expectedVersion: 1 };
    const first = await comp(body);
    const again = await comp(body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(auditItems(teamA)).toHaveLength(1);
    expect(teamOf(teamA).version).toBe(2);
    const other = await comp({ ...body, seats: 6 });
    expect(other.status).toBe(409);
    expect(other.body.error.message).toMatch(/Idempotency-Key/);
  });

  it("extends a comp, and records what it was before", async () => {
    await comp({ plan: "free", seats: 3, until, reason: "Pilot", expectedVersion: 1 });
    const res = await comp({ plan: "free", until: "2027-03-31", reason: "Pilot ran long", expectedVersion: 2 }, "comp-key-0002");
    expect(res.status).toBe(200);
    expect(teamOf(teamA)).toMatchObject({ compUntil: "2027-03-31T00:00:00.000Z", version: 3 });
    expect(teamOf(teamA).compSeats).toBeUndefined();
    const latest = auditItems(teamA).find((a) => a.reason === "Pilot ran long");
    expect(latest?.before).toEqual({ plan: "free", seats: 3, until: "2026-12-31T00:00:00.000Z", reason: "Pilot" });
  });

  it("refuses a stale version without changing anything", async () => {
    const res = await comp({ plan: "free", until, reason: "Pilot", expectedVersion: 7 });
    expect(res.status).toBe(409);
    expect(teamOf(teamA).compPlan).toBeUndefined();
    expect(auditItems(teamA)).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["more than 12 months ahead", { plan: "free", until: "2027-09-27", reason: "Pilot", expectedVersion: 1 }],
    ["in the past", { plan: "free", until: "2026-09-01", reason: "Pilot", expectedVersion: 1 }],
    ["not a date", { plan: "free", until: "soon", reason: "Pilot", expectedVersion: 1 }],
    ["not a real date", { plan: "free", until: "2026-13-45", reason: "Pilot", expectedVersion: 1 }],
    ["no reason", { plan: "free", until, expectedVersion: 1 }],
    ["a reason with a newline", { plan: "free", until, reason: "a\nb c", expectedVersion: 1 }],
    ["a bad plan", { plan: "Free Plan", until, reason: "Pilot", expectedVersion: 1 }],
    ["too many seats", { plan: "free", seats: 101, until, reason: "Pilot", expectedVersion: 1 }],
    ["no version", { plan: "free", until, reason: "Pilot" }],
    ["an extra field", { plan: "free", until, reason: "Pilot", expectedVersion: 1, status: "active" }],
  ])("refuses a comp with %s", async (_what, body) => {
    const res = await comp(body);
    expect(res.status).toBe(400);
    expect(teamOf(teamA).compPlan).toBeUndefined();
  });

  it("allows exactly 12 months, and needs an Idempotency-Key", async () => {
    expect(latestCompEnd(new Date(NOW)).toISOString()).toBe("2027-09-26T12:00:00.000Z");
    expect((await call("PUT", `/ops/teams/${teamA}/comp`, { body: { plan: "free", until: "2027-09-26T12:00:00Z", reason: "Pilot", expectedVersion: 1 } })).status).toBe(400);
    expect((await comp({ plan: "free", until: "2027-09-26T12:00:00Z", reason: "Pilot", expectedVersion: 1 })).status).toBe(200);
  });

  it("answers 404 for a team that isn't there", async () => {
    expect((await call("PUT", "/ops/teams/no-such-team/comp", { body: { plan: "free", until, reason: "Pilot", expectedVersion: 1 }, key: "comp-key-0001" })).status).toBe(404);
    expect((await call("DELETE", "/ops/teams/no-such-team/comp", { body: { reason: "Done", expectedVersion: 1 }, key: "end-key-0001" })).status).toBe(404);
  });

  it("ends a comp early, and refuses to end one that isn't there", async () => {
    expect((await call("DELETE", `/ops/teams/${teamA}/comp`, { body: { reason: "Done", expectedVersion: 1 }, key: "end-key-0001" })).status).toBe(409);
    await comp({ plan: "free", until, reason: "Pilot", expectedVersion: 1 });
    const res = await call("DELETE", `/ops/teams/${teamA}/comp`, { body: { reason: "Pilot over", expectedVersion: 2 }, key: "end-key-0002" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ comp: null, version: 3 });
    expect(Object.keys(teamOf(teamA)).filter((k) => k.startsWith("comp"))).toEqual([]);
    expect(auditItems(teamA).map((a) => a.action).sort()).toEqual(["ops.comp.end", "ops.comp.set"]);
    expect(denied).toEqual([]);
  });

  it("logs IDs and statuses, never emails", async () => {
    await call("GET", "/ops/teams");
    await call("GET", `/ops/teams/${teamA}`);
    await comp({ plan: "free", until, reason: "Pilot", expectedVersion: 1 });
    const text = JSON.stringify(logs);
    expect(text).not.toContain(OWNER_EMAIL);
    expect(text).not.toContain("token-");
    expect(text).toContain(`"operator":"${OPERATOR}"`);
  });
});

describe("the operator audit", () => {
  it("lists one team's, or a month's, newest first", async () => {
    await call("GET", `/ops/teams/${teamA}`);
    now += 1000;
    await call("PUT", `/ops/teams/${teamA}/comp`, { body: { plan: "free", until: "2026-12-31", reason: "Pilot", expectedVersion: 1 }, key: "comp-key-0001" });
    const byTeam = await call("GET", "/ops/audit", { query: { teamId: teamA } });
    expect(byTeam.body.events.map((e: { action: string }) => e.action)).toEqual(["ops.comp.set", "ops.team.read"]);
    expect(byTeam.body.events[0].expiresAt).toBeUndefined();
    const byMonth = await call("GET", "/ops/audit");
    // A summary: what the index projects, and the team and time from the keys
    expect(byMonth.body.events).toEqual([
      { eventId: byTeam.body.events[0].eventId, ts: byTeam.body.events[0].ts, teamId: teamA, action: "ops.comp.set", operatorSub: OPERATOR },
      { eventId: byTeam.body.events[1].eventId, ts: byTeam.body.events[1].ts, teamId: teamA, action: "ops.team.read", operatorSub: OPERATOR },
    ]);
    expect((await call("GET", "/ops/audit", { query: { month: "2026-08" } })).body.events).toEqual([]);
    const paged = await call("GET", "/ops/audit", { query: { teamId: teamA, limit: "1" } });
    expect(paged.body.cursor).toEqual(expect.any(String));
    expect(denied).toEqual([]);
  });

  it.each([{ teamId: "TEAM_A", month: "2026-09" }, { month: "2026-9" }, { teamId: "bad id" }, { limit: "101" }])("refuses %o", async (query) => {
    const q = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v === "TEAM_A" ? teamA : v]));
    expect((await call("GET", "/ops/audit", { query: q })).status).toBe(400);
  });

  it("shows owners what support did, as Supply Checkout support, never who", async () => {
    await call("PUT", `/ops/teams/${teamA}/comp`, { body: { plan: "free", until: "2026-12-31", reason: "Pilot", expectedVersion: 1 }, key: "comp-key-0001" });
    const data = createDataHandler({ dbForTeam: (teamId) => table.db(teamId), obs: fakeObservability(), now: () => now });
    const request = (userId: string) =>
      ({
        routeKey: "GET /teams/{teamId}/support-actions",
        rawPath: `/teams/${teamA}/support-actions`,
        headers: {},
        pathParameters: { teamId: teamA },
        requestContext: { authorizer: { jwt: { claims: { iss: CUSTOMER_ISSUER, token_use: "access", exp: Math.floor(now / 1000) + 600, sub: userId }, scopes: [] } } },
      }) as unknown as DataEvent;
    table.requests.length = 0;
    const res = await data(request(OWNER));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.actions).toEqual([
      { eventId: expect.any(String), ts: expect.any(String), actor: "Supply Checkout support", action: "ops.comp.set", reason: "Pilot", before: null, after: { plan: "free", seats: null, until: "2026-12-31T00:00:00.000Z", reason: "Pilot" } },
    ]);
    expect(JSON.stringify(body)).not.toContain(OPERATOR);
    // The data-access role may read only these attributes there
    const query = table.requests.find((r) => r.command === "QueryCommand" && (r.input.ExpressionAttributeValues as Record<string, unknown>)[":pk"] === `OPAUDIT#${teamA}`);
    expect(query?.input.Select).toBe("SPECIFIC_ATTRIBUTES");
    expect(Object.values(query?.input.ExpressionAttributeNames as Record<string, string>).sort()).toEqual([...OWNER_OPERATOR_AUDIT_ATTRIBUTES].sort());
    // Nobody outside the team does
    expect((await data(request("user-b"))).statusCode).toBe(403);
  });
});

describe("comps and entitlement", () => {
  it("counts a comp only while it's live", () => {
    const at = new Date(NOW);
    expect(liveComp({ compPlan: "free", compUntil: "2026-12-31T00:00:00.000Z", compSeats: 4 }, at)).toEqual({ plan: "free", seats: 4, until: "2026-12-31T00:00:00.000Z" });
    expect(liveComp({ compPlan: "free", compUntil: "2026-09-01T00:00:00.000Z" }, at)).toBeUndefined();
    expect(liveComp({ compPlan: "free", compUntil: "garbage" }, at)).toBeUndefined();
    expect(liveComp({ compPlan: "free" }, at)).toBeUndefined();
    expect(memberCap({ status: "canceled", compPlan: "free", compUntil: "2026-12-31T00:00:00.000Z" }, at)).toBe(MEMBERS_PER_TEAM);
    expect(memberCap({ status: "trialing", compPlan: "free", compUntil: "2026-09-01T00:00:00.000Z" }, at)).toBe(MEMBERS_PER_TRIAL_TEAM);
  });
});
