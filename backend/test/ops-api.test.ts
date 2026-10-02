// The ops API (ADR 0015) against the in-memory table. Every DynamoDB call the
// ops handler makes must pass the operator-access role's policy (ops-policy.ts):
// GSI3 queries of the ops partitions only, comp attributes only on the tagged
// team, and puts (never updates or deletes) of operator audit items.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { DataEvent } from "../src/api/data-handler.js";
import { createDataHandler } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { OPS_ROUTES, routeKey } from "../src/api/routes.js";
import {
  CLOSED_TEAM_RETENTION_DAYS,
  closeTeam,
  createTeam,
  latestCompEnd,
  listOpsOwnersOf,
  listTeamsToPurge,
  liveComp,
  memberCap,
  MEMBERS_PER_TEAM,
  MEMBERS_PER_TRIAL_TEAM,
  ESTIMATED_COST_PER_RECEIPT_USD,
  MAX_OPS_TEAMS_READ,
  OPS_REOPEN_CUTOFF_MINUTES,
  OWNER_LOOKUPS_AT_ONCE,
  REOPEN_CUTOFF_MINUTES,
  reopenTeam,
  TeamDeletingError,
} from "../src/data/index.js";
import { OWNER_OPERATOR_AUDIT_ATTRIBUTES } from "../src/data/schema.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import type { OperatorDirectory } from "../src/operator/cognito.js";
import { createOpsHandler, groupsClaim, type OpsEvent } from "../src/operator/ops-handler.js";
import { fakeDb, REGION } from "./helpers.js";
import { connection } from "../src/data/client.js";
import { MemoryTable } from "./memory-table.js";
import { createReopenHandler, type ReopenRequest } from "../src/operator/reopen-handler.js";
import { opsPolicy, reopenPolicy } from "./ops-policy.js";
import Stripe from "stripe";
import { OPS_INVOICE_PAGE, OPS_SUBSCRIPTION_PAGE, type OpsInvoiceLike, type OpsStripe, opsStripeClient, type OpsSubscriptionLike } from "../src/operator/stripe-detail.js";

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
let reopenDenied: { command: string; input: Record<string, unknown> }[];
let reopenCalls: ReopenRequest[];
let reopenTags: string[];
let tags: string[];
let logs: unknown[];
let counted: string[];
let seatSyncs: [string, string][];
let seatQueueDown: boolean;
let directoryCalls: string[];
let revoked: Set<string>;
let groups: Map<string, string[]>;
let handler: ReturnType<typeof createOpsHandler>;
let teamA: string;
let teamB: string;
// The ops Stripe client: a fake, never Stripe. `opsStripe` is what reading the ops restricted key gives
let stripeCalls: [string, Record<string, unknown>][];
let stripeSubs: OpsSubscriptionLike[];
let stripeInvoices: OpsInvoiceLike[];
let opsStripe: (() => Promise<OpsStripe>) | undefined;
const fakeOpsStripe: OpsStripe = {
  subscriptions: {
    list: async (params) => {
      stripeCalls.push(["subscriptions.list", params]);
      return { data: stripeSubs };
    },
  },
  invoices: {
    list: async (params) => {
      stripeCalls.push(["invoices.list", params]);
      return { data: stripeInvoices, has_more: true };
    },
  },
};

function fakeObservability(): Observability {
  const log = (...args: unknown[]) => logs.push(args);
  return {
    region: REGION,
    logger: { info: log, warn: log, error: log, addContext: () => {} } as unknown as Observability["logger"],
    count: (metric) => void counted.push(metric),
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
  reopenDenied = [];
  reopenCalls = [];
  reopenTags = [];
  tags = [];
  logs = [];
  counted = [];
  seatSyncs = [];
  seatQueueDown = false;
  directoryCalls = [];
  revoked = new Set();
  groups = new Map([[OPERATOR, ["operators"]]]);
  stripeCalls = [];
  stripeSubs = [];
  stripeInvoices = [];
  opsStripe = async () => fakeOpsStripe;
  const setup = table.db();
  teamA = (await createTeam(setup, { userId: OWNER, email: OWNER_EMAIL }, { name: "Acme Cleaning" }, new Date(NOW - 2 * DAY))).team.teamId;
  teamB = (await createTeam(setup, { userId: "user-b" }, { name: "Bravo Janitorial" }, new Date(NOW - DAY))).team.teamId;
  table.put({ PK: `TEAM#${teamA}`, SK: "SHEET#s1", type: "sheet", id: "s1", version: 1, client: "Secret client", date: "2026-09-26", items: {} });
  handler = createOpsHandler({
    dbFor: (operatorSub, teamId) => {
      tags.push(`${operatorSub} ${teamId ?? "."}`);
      return table.guarded(opsPolicy(teamId ?? ".", denied));
    },
    // The operator reopen function, on its own role's policy, as Lambda would pass it: through JSON
    reopen: async (request) => {
      reopenCalls.push(request);
      const reopen = createReopenHandler({ dbFor: (_sub, teamId) => { reopenTags.push(teamId ?? "."); return table.guarded(reopenPolicy(teamId ?? ".", reopenDenied)); }, obs: fakeObservability(), now: () => now });
      return JSON.parse(JSON.stringify(await reopen(JSON.parse(JSON.stringify(request)))));
    },
    seats: async (customer, reason) => {
      if (seatQueueDown) throw Object.assign(new Error("SQS is down"), { name: "QueueDoesNotExist" });
      seatSyncs.push([customer, reason]);
    },
    directory,
    stripeDeadlineMs: 50,
    stripe: () => (opsStripe ? opsStripe() : Promise.reject(Object.assign(new Error("not configured"), { name: "NotConfigured" }))),
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
      reopen: () => Promise.reject(new Error("not called")),
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
  it("lists every team in team ID order with owners' emails, from the index only", async () => {
    const res = await call("GET", "/ops/teams");
    expect(res.status).toBe(200);
    const byId = [teamA, teamB].sort();
    expect(res.body.teams.map((t: { id: string }) => t.id)).toEqual(byId);
    const acme = res.body.teams.find((t: { id: string }) => t.id === teamA);
    expect(acme).toMatchObject({ id: teamA, plan: "trial", status: "trialing", seats: 1, ownerCount: 1, closedAt: null, version: 1, comp: null });
    expect(acme.owners).toEqual([{ userId: OWNER, email: OWNER_EMAIL, joinedAt: expect.any(String) }]);
    expect(JSON.stringify(res.body)).not.toContain("Secret client");
    // Only what the index projects: never the team's home region
    expect(acme.homeRegion).toBeUndefined();
    expect(Object.keys(teamOf(teamA))).toContain("homeRegion");
    expect(denied).toEqual([]);
    expect(tags.every((t) => t.endsWith(" ."))).toBe(true);
    // Audited like one team's record: it shows owners' emails
    expect(auditItems("PLATFORM")).toEqual([
      expect.objectContaining({ action: "ops.teams.list", operatorSub: OPERATOR, target: "teams", after: { q: null, cursor: null, teams: byId }, GSI3PK: "OPS#AUDIT#2026-09" }),
    ]);
  });

  it("finds a team by its ID in any case it was made with, and audits the search", async () => {
    table.put({ ...teamOf(teamA), PK: "TEAM#MixedCase-1", GSI3SK: "MixedCase-1", name: "Mixed" });
    expect((await call("GET", "/ops/teams", { query: { q: "MixedCase-1" } })).body.teams.map((t: { id: string }) => t.id)).toEqual(["MixedCase-1"]);
    expect(auditItems("PLATFORM").map((a) => (a.after as { q: string }).q)).toEqual(["MixedCase-1"]);
  });

  it("searches by name or ID, and pages", async () => {
    expect((await call("GET", "/ops/teams", { query: { q: "acme" } })).body.teams.map((t: { id: string }) => t.id)).toEqual([teamA]);
    expect((await call("GET", "/ops/teams", { query: { q: teamB } })).body.teams.map((t: { id: string }) => t.id)).toEqual([teamB]);
    const [firstId, secondId] = [teamA, teamB].sort();
    const first = await call("GET", "/ops/teams", { query: { limit: "1" } });
    expect(first.body.teams.map((t: { id: string }) => t.id)).toEqual([firstId]);
    expect(first.body.cursor).toEqual(expect.any(String));
    const second = await call("GET", "/ops/teams", { query: { limit: "1", cursor: first.body.cursor } });
    expect(second.body.teams.map((t: { id: string }) => t.id)).toEqual([secondId]);
    expect(second.body.cursor).toBeUndefined();
    expect(denied).toEqual([]);
  });

  it("lists the team whose ID is the search first, then names that match, never the same team twice", async () => {
    table.put({ ...teamOf(teamA), PK: "TEAM#acme-id", GSI3SK: "acme-id", name: "Zed" });
    table.put({ ...teamOf(teamA), PK: "TEAM#zz-named", GSI3SK: "zz-named", name: "Named acme-id too" });
    // The ID fills a page of 1 on its own: the names come next, from the start of the walk
    const first = await call("GET", "/ops/teams", { query: { q: "acme-id", limit: "1" } });
    expect(first.body.teams.map((t: { id: string }) => t.id)).toEqual(["acme-id"]);
    const second = await call("GET", "/ops/teams", { query: { q: "acme-id", limit: "1", cursor: first.body.cursor } });
    expect(second.body.teams.map((t: { id: string }) => t.id)).toEqual(["zz-named"]);
    expect(second.body.cursor).toBeUndefined();
    const all = await call("GET", "/ops/teams", { query: { q: "acme-id" } });
    expect(all.body.teams.map((t: { id: string }) => t.id)).toEqual(["acme-id", "zz-named"]);
    // Not a valid ID: names only, no lookup
    expect((await call("GET", "/ops/teams", { query: { q: "nothing here" } })).body).toEqual({ teams: [] });
  });

  const cursorOf = (key: Record<string, unknown>) => Buffer.from(JSON.stringify(key)).toString("base64url");
  it.each<Record<string, string>>([
    { limit: "0" },
    { limit: "abc" },
    { cursor: "no-such-team" },
    { cursor: "bad cursor" },
    { q: "x".repeat(201) },
    // Another partition, a key with more or other attributes than a team's index entry, or not a META item
    { cursor: cursorOf({ GSI3PK: "OPS#OWNERS#t1", GSI3SK: "t1", PK: "TEAM#t1", SK: "META" }) },
    { cursor: cursorOf({ GSI3PK: "OPS#TEAMS", GSI3SK: "t1", PK: "TEAM#t1", SK: "META", extra: "x" }) },
    { cursor: cursorOf({ GSI3PK: "OPS#TEAMS", GSI3SK: "t1", PK: "TEAM#t1", SK: "SHEET#s1" }) },
    { cursor: cursorOf({ GSI3PK: "OPS#TEAMS", GSI3SK: "t2", PK: "TEAM#t1", SK: "META" }) },
    { cursor: cursorOf({ GSI3PK: "OPS#TEAMS", GSI3SK: "t1", PK: "USER#t1", SK: "META" }) },
  ])("refuses %o", async (query) => {
    expect((await call("GET", "/ops/teams", { query })).status).toBe(400);
  });

  describe("with more than 5,000 teams (supply-checkout-6uw.8)", () => {
    const TEAMS = 5_300;
    const id = (n: number) => `bulk-${String(n).padStart(5, "0")}`;
    beforeEach(() => {
      for (let n = 0; n < TEAMS; n++) {
        const teamId = id(n);
        table.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: n === TEAMS - 1 ? "Needle Supply" : `Bulk team ${n}`, plan: "trial", seats: 1, status: "trialing", owners: 1, createdAt: "2026-09-01T00:00:00.000Z", version: 1, GSI3PK: "OPS#TEAMS", GSI3SK: teamId });
        table.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#owner-${n}`, type: "member", role: "owner", email: `owner-${n}@example.com`, joinedAt: "2026-09-01T00:00:00.000Z", GSI3PK: `OPS#OWNERS#${teamId}`, GSI3SK: `owner-${n}` });
      }
    });

    /** Index items each request read from the team list's partition. */
    function readPerRequest(from: number): number {
      return table.requests
        .slice(from)
        .filter((r) => r.command === "QueryCommand" && (r.input.ExpressionAttributeValues as Record<string, unknown>)[":pk"] === "OPS#TEAMS" && r.input.KeyConditionExpression === "GSI3PK = :pk")
        .reduce((sum, r) => sum + (r.input.Limit as number), 0);
    }

    it("pages through every team exactly once, each request reading one bounded page and its owners", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      let requests = 0;
      do {
        const from = table.requests.length;
        const res = await call("GET", "/ops/teams", { query: { limit: "100", ...(cursor ? { cursor } : {}) } });
        expect(res.status).toBe(200);
        requests++;
        // One read of at most the page size, and one owners query per team on the page
        expect(readPerRequest(from)).toBeLessThanOrEqual(100);
        const owners = table.requests.slice(from).filter((r) => String((r.input.ExpressionAttributeValues as Record<string, unknown>)?.[":pk"]).startsWith("OPS#OWNERS#"));
        expect(owners).toHaveLength(res.body.teams.length);
        for (const team of res.body.teams) expect(team.owners).toHaveLength(1);
        seen.push(...res.body.teams.map((t: { id: string }) => t.id));
        cursor = res.body.cursor;
      } while (cursor);
      expect(seen).toHaveLength(TEAMS + 2);
      expect(new Set(seen).size).toBe(TEAMS + 2);
      expect(seen).toEqual([...seen].sort());
      expect(requests).toBe(Math.ceil((TEAMS + 2) / 100));
      expect(denied).toEqual([]);
    });

    it("searches in bounded steps: a name near the end takes several requests, each reading at most MAX_OPS_TEAMS_READ items", async () => {
      const found: string[] = [];
      let cursor: string | undefined;
      let requests = 0;
      do {
        const from = table.requests.length;
        const res = await call("GET", "/ops/teams", { query: { q: "needle", ...(cursor ? { cursor } : {}) } });
        expect(res.status).toBe(200);
        requests++;
        expect(readPerRequest(from)).toBeLessThanOrEqual(MAX_OPS_TEAMS_READ);
        found.push(...res.body.teams.map((t: { id: string }) => t.id));
        cursor = res.body.cursor;
      } while (cursor);
      expect(found).toEqual([id(TEAMS - 1)]);
      expect(requests).toBe(Math.ceil((TEAMS + 2) / MAX_OPS_TEAMS_READ));
      // Every step is audited, with what it returned
      expect(auditItems("PLATFORM").filter((a) => a.action === "ops.teams.list")).toHaveLength(requests);
      // A team ID is found at once, however far along it is
      const direct = await call("GET", "/ops/teams", { query: { q: id(TEAMS - 2) } });
      expect(direct.body.teams.map((t: { id: string }) => t.id)).toEqual([id(TEAMS - 2)]);
    });

    it("looks owners up at most OWNER_LOOKUPS_AT_ONCE at a time", async () => {
      let inFlight = 0;
      let most = 0;
      const guarded = table.guarded(opsPolicy(".", denied));
      const slow = fakeDb(async (command) => {
        const owners = String((command.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"]).startsWith("OPS#OWNERS#");
        if (owners) most = Math.max(most, ++inFlight);
        try {
          await new Promise((r) => setTimeout(r, 1));
          return await connection(guarded).doc.send(command as never);
        } finally {
          if (owners) inFlight--;
        }
      });
      const owners = await listOpsOwnersOf(slow, { sub: OPERATOR }, Array.from({ length: 35 }, (_, n) => id(n)));
      expect(owners.size).toBe(35);
      expect(owners.get(id(34))).toEqual([{ userId: "owner-34", email: "owner-34@example.com", joinedAt: "2026-09-01T00:00:00.000Z" }]);
      expect(most).toBe(OWNER_LOOKUPS_AT_ONCE);
    });
  });

  it("shows one team, and audits the read before answering", async () => {
    const res = await call("GET", `/ops/teams/${teamA}`);
    expect(res.status).toBe(200);
    expect(res.body.team).toMatchObject({ id: teamA, name: "Acme Cleaning", owners: [{ userId: OWNER, email: OWNER_EMAIL }] });
    const [audit] = auditItems(teamA);
    expect(audit).toMatchObject({ type: "operatorAudit", action: "ops.team.read", operatorSub: OPERATOR, teamId: teamA, GSI3PK: "OPS#AUDIT#2026-09" });
    // One direct lookup of the team's index entry, not a walk of every team
    const lookups = table.requests.filter((r) => r.command === "QueryCommand" && (r.input.ExpressionAttributeValues as Record<string, unknown>)[":pk"] === "OPS#TEAMS");
    expect(lookups.map((r) => (r.input.ExpressionAttributeValues as Record<string, unknown>)[":sk"])).toEqual([teamA]);
    expect(denied).toEqual([]);
  });

  it("answers 404 for an unknown team and 400 for a bad ID", async () => {
    expect((await call("GET", "/ops/teams/no-such-team")).status).toBe(404);
    expect((await call("GET", "/ops/teams/bad%20id")).status).toBe(400);
  });
});

describe("a team's Stripe subscription and invoices (supply-checkout-6uw.4)", () => {
  const CUSTOMER = "cus_TeamA1";
  const sub = (over: Partial<OpsSubscriptionLike> & { quantity?: number; lookupKey?: string | null } = {}): OpsSubscriptionLike => {
    const { quantity = 3, lookupKey = "supply_checkout_starter_monthly", ...rest } = over;
    return {
      id: "sub_1",
      customer: CUSTOMER,
      status: "active",
      created: Date.parse("2026-08-01T00:00:00Z") / 1000,
      cancel_at_period_end: false,
      cancel_at: null,
      trial_end: null,
      items: { data: [{ quantity, current_period_end: Date.parse("2026-10-01T00:00:00Z") / 1000, price: { lookup_key: lookupKey } }] },
      ...rest,
    };
  };
  const invoice = (over: Partial<OpsInvoiceLike> = {}): OpsInvoiceLike => ({
    id: "in_1",
    customer: CUSTOMER,
    number: "ABC-0001",
    status: "paid",
    created: Date.parse("2026-09-01T00:00:00Z") / 1000,
    currency: "usd",
    total: 2700,
    amount_due: 2700,
    amount_paid: 2700,
    ...over,
  });
  const withCustomer = (customer: string = CUSTOMER) => table.put({ ...teamOf(teamA), stripeCustomerId: customer });

  it("adds the subscription and recent invoices for the team's own customer, with only what an operator needs", async () => {
    withCustomer();
    // What Stripe also sends, and must never come back: the customer's email and name, card details and bearer links
    const extra = { customer_email: "payer@example.com", customer_name: "Pat Payer", hosted_invoice_url: "https://invoice.stripe.com/i/secret", invoice_pdf: "https://pay.stripe.com/invoice/secret/pdf", default_payment_method: { card: { last4: "4242" } } };
    stripeSubs = [{ ...sub({ cancel_at_period_end: true, cancel_at: Date.parse("2026-10-01T00:00:00Z") / 1000 }), ...extra } as OpsSubscriptionLike];
    stripeInvoices = [{ ...invoice(), ...extra } as OpsInvoiceLike, invoice({ id: "in_draft", number: null, status: "draft" }), invoice({ id: "in_other", customer: "cus_Other" })];
    const res = await call("GET", `/ops/teams/${teamA}`);
    expect(res.status).toBe(200);
    expect(res.body.team).toMatchObject({ id: teamA, stripeCustomerId: CUSTOMER });
    expect(res.body.stripe).toEqual({
      customerId: CUSTOMER,
      subscription: {
        id: "sub_1",
        status: "active",
        lookupKey: "supply_checkout_starter_monthly",
        plan: "starter",
        interval: "month",
        seats: 3,
        currentPeriodEnd: "2026-10-01T00:00:00.000Z",
        cancelAtPeriodEnd: true,
        cancelAt: "2026-10-01T00:00:00.000Z",
        trialEnd: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      subscriptionCount: 1,
      invoices: [{ id: "in_1", number: "ABC-0001", status: "paid", createdAt: "2026-09-01T00:00:00.000Z", currency: "usd", total: 2700, amountDue: 2700, amountPaid: 2700 }],
      hasMoreInvoices: true,
    });
    const text = JSON.stringify(res.body);
    for (const leak of ["payer@example.com", "Pat Payer", "stripe.com", "4242", "in_other", "in_draft"]) expect(text).not.toContain(leak);
    // The customer from the team's index entry, never the request; two reads and nothing else
    expect(stripeCalls).toEqual([
      ["subscriptions.list", { customer: CUSTOMER, status: "all", limit: OPS_SUBSCRIPTION_PAGE }],
      ["invoices.list", { customer: CUSTOMER, limit: OPS_INVOICE_PAGE }],
    ]);
    // Still audited, and still only through the operator-access role
    expect(auditItems(teamA)).toEqual([expect.objectContaining({ action: "ops.team.read" })]);
    expect(denied).toEqual([]);
  });

  it("shows the current subscription over a newer one that's over, and the newest when all are over", async () => {
    withCustomer();
    stripeSubs = [sub({ id: "sub_new", status: "canceled" }), sub({ id: "sub_live", status: "past_due", quantity: 5, lookupKey: "not-in-catalog" }), sub({ id: "sub_mixed", customer: { id: "cus_Other" } })];
    const live = (await call("GET", `/ops/teams/${teamA}`)).body.stripe;
    expect(live.subscription).toMatchObject({ id: "sub_live", status: "past_due", seats: 5, lookupKey: "not-in-catalog", plan: null, interval: null });
    expect(live.subscriptionCount).toBe(2);
    stripeSubs = [sub({ id: "sub_b", status: "incomplete_expired" }), sub({ id: "sub_a", status: "canceled", customer: { id: CUSTOMER } })];
    expect((await call("GET", `/ops/teams/${teamA}`)).body.stripe.subscription).toMatchObject({ id: "sub_b" });
    stripeSubs = [sub({ items: { data: [] } })];
    expect((await call("GET", `/ops/teams/${teamA}`)).body.stripe.subscription).toMatchObject({ seats: 0, lookupKey: null, currentPeriodEnd: null });
    stripeSubs = [];
    expect((await call("GET", `/ops/teams/${teamA}`)).body.stripe).toMatchObject({ subscription: null, subscriptionCount: 0, invoices: [] });
  });

  it("answers stripe: null for a team without a Stripe customer, without reading the key or calling Stripe", async () => {
    let reads = 0;
    opsStripe = async () => {
      reads++;
      return fakeOpsStripe;
    };
    const res = await call("GET", `/ops/teams/${teamA}`);
    expect(res.status).toBe(200);
    expect(res.body.stripe).toBeNull();
    expect(reads).toBe(0);
    expect(stripeCalls).toEqual([]);
  });

  const logged = () => JSON.stringify(logs);
  it.each<[string, () => void]>([
    [
      "the ops key isn't stored yet",
      () => {
        opsStripe = () => Promise.reject(Object.assign(new Error("Secrets Manager can't find the specified secret: rk_test_SECRET"), { name: "ResourceNotFoundException" }));
      },
    ],
    [
      "Stripe errors",
      () => {
        opsStripe = async () => ({
          ...fakeOpsStripe,
          invoices: { list: () => Promise.reject(new Stripe.errors.StripePermissionError({ type: "invalid_request_error", message: "The key rk_test_SECRET for payer@example.com lacks rights", code: "permission", statusCode: 403, requestId: "req_9" } as never)) },
        });
      },
    ],
    [
      "Stripe is too slow",
      () => {
        opsStripe = async () => ({ ...fakeOpsStripe, subscriptions: { list: () => new Promise(() => {}) } });
      },
    ],
  ])("still answers with the team when %s, and logs no key, message or email", async (_, arrange) => {
    withCustomer();
    arrange();
    const res = await call("GET", `/ops/teams/${teamA}`);
    expect(res.status).toBe(200);
    expect(res.body.team).toMatchObject({ id: teamA, name: "Acme Cleaning" });
    expect(res.body.stripe).toEqual({ error: "unavailable" });
    expect(logged()).toContain("Stripe detail unavailable");
    for (const leak of ["rk_test_SECRET", "payer@example.com", "lacks rights", "can't find"]) expect(logged()).not.toContain(leak);
  });

  // Built from pieces, so the public-safety check doesn't take them for real keys
  const FULL_KEY = `sk_test_${"F".repeat(24)}`;
  const LIVE_RESTRICTED = `rk_live_${"L".repeat(24)}`;
  const RESTRICTED = `rk_test_${"R".repeat(24)}`;
  it("uses only a restricted key: a full secret key stored by mistake makes the detail unavailable, and is never logged", async () => {
    withCustomer();
    stripeSubs = [sub()];
    const created: string[] = [];
    const client = (value: string) => opsStripeClient({ secretId: "supply-checkout/prod/stripe/test-ops-restricted-key", mode: "test", read: async () => value, create: (key) => (created.push(key), fakeOpsStripe) });
    opsStripe = client(FULL_KEY);
    const refused = await call("GET", `/ops/teams/${teamA}`);
    expect(refused.status).toBe(200);
    expect(refused.body.stripe).toEqual({ error: "unavailable" });
    expect(created).toEqual([]);
    expect(stripeCalls).toEqual([]);
    expect(JSON.stringify(logs)).not.toContain("FFFFFFFF");
    expect(JSON.stringify(refused.body)).not.toContain("FFFFFFFF");
    // A live key where test mode is configured is refused too
    opsStripe = client(LIVE_RESTRICTED);
    expect((await call("GET", `/ops/teams/${teamA}`)).body.stripe).toEqual({ error: "unavailable" });
    expect(created).toEqual([]);
    // A restricted key of the configured mode works
    opsStripe = client(RESTRICTED);
    expect((await call("GET", `/ops/teams/${teamA}`)).body.stripe.subscription).toMatchObject({ id: "sub_1" });
    expect(created).toEqual([RESTRICTED]);
    expect(JSON.stringify(logs)).not.toContain("RRRRRRRR");
  });

  it("never calls Stripe for a customer ID that isn't one", async () => {
    withCustomer("cus_bad id/../x");
    expect((await call("GET", `/ops/teams/${teamA}`)).body.stripe).toEqual({ error: "unavailable" });
    expect(stripeCalls).toEqual([]);
    expect(logged()).toContain("InvalidCustomer");
  });

  it("answers unavailable when the function has no Stripe client at all", async () => {
    withCustomer();
    const bare = createOpsHandler({ dbFor: (_sub, teamId) => table.guarded(opsPolicy(teamId ?? ".", denied)), reopen: async () => { throw new Error("not used"); }, directory, issuerUrl: OPS_ISSUER, clientId: OPS_CLIENT, obs: fakeObservability(), now: () => now });
    const res = await bare(event("GET", `/ops/teams/${teamA}`));
    expect(JSON.parse(res.body as string).stripe).toEqual({ error: "unavailable" });
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

  it("refuses to comp a closed team, or end its comp, and shows it closed", async () => {
    await comp({ plan: "free", until, reason: "Pilot", expectedVersion: 1 });
    table.put({ ...teamOf(teamA), closedAt: "2026-09-26T11:00:00.000Z", purgeAfter: "2026-10-26T11:00:00.000Z" });
    expect((await call("GET", `/ops/teams/${teamA}`)).body.team.closedAt).toBe("2026-09-26T11:00:00.000Z");
    const again = await comp({ plan: "free", until: "2027-01-31", reason: "Extend", expectedVersion: 2 }, "comp-key-0009");
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/closed/);
    expect((await call("DELETE", `/ops/teams/${teamA}/comp`, { body: { reason: "Done", expectedVersion: 2 }, key: "end-key-0009" })).status).toBe(409);
    expect(teamOf(teamA)).toMatchObject({ compUntil: "2026-12-31T00:00:00.000Z", version: 2 });
  });

  it("drops a purged team from the list and answers 404 for it, keeping its operator audit", async () => {
    await comp({ plan: "free", until, reason: "Pilot", expectedVersion: 1 });
    for (const [k, item] of [...table.items.entries()]) if (item.PK === `TEAM#${teamA}`) table.items.delete(k);
    expect((await call("GET", "/ops/teams")).body.teams.map((t: { id: string }) => t.id)).toEqual([teamB]);
    expect((await call("GET", `/ops/teams/${teamA}`)).status).toBe(404);
    expect((await comp({ plan: "free", until, reason: "Pilot", expectedVersion: 2 }, "comp-key-0010")).status).toBe(404);
    expect((await call("GET", "/ops/audit", { query: { teamId: teamA } })).body.events.map((e: { action: string }) => e.action)).toEqual(["ops.comp.set"]);
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

  it("records before and after in the shapes docs/api/openapi.yaml gives them (supply-checkout-6uw.9)", async () => {
    const spec = parse(readFileSync(new URL("../../docs/api/openapi.yaml", import.meta.url), "utf8")) as { components: { schemas: Record<string, { oneOf?: { $ref?: string }[]; required?: string[] }> } };
    const shapes = (spec.components.schemas.AuditRecord?.oneOf ?? []).flatMap((o) => (o.$ref ? [spec.components.schemas[o.$ref.split("/").pop() as string]?.required ?? []] : []));
    const matches = (value: unknown) => (value === null ? 1 : shapes.filter((keys) => JSON.stringify(Object.keys(value as object).sort()) === JSON.stringify([...keys].sort())).length);
    await call("GET", "/ops/teams", { query: { q: "acme" } });
    await call("GET", "/ops/receipts");
    await call("PUT", `/ops/teams/${teamA}/comp`, { body: { plan: "free", until: "2026-12-31", reason: "Pilot", expectedVersion: 1 }, key: "comp-key-0001" });
    await call("DELETE", `/ops/teams/${teamA}/comp`, { body: { reason: "Over", expectedVersion: 2 }, key: "comp-key-0002" });
    table.put({ PK: `TEAM#${teamB}`, SK: "IMPORT#imp-old", GSI1PK: "IMPORTS#COMMITTING", GSI1SK: "2026-09-26T09:00:00.000Z#imp-old", type: "import", status: "committing", committed: 1, total: 2 });
    await call("POST", `/ops/teams/${teamB}/imports/imp-old/clear`, { body: { reason: "Owner re-imported it" }, key: "clear-key-0001" });
    const made = await createTeam(table.db(), { userId: "user-e" }, { name: "Echo Clean" }, new Date(NOW - 2 * DAY));
    await closeTeam(table.db(), made.context, { confirmName: "Echo Clean" }, new Date(NOW - DAY));
    await call("POST", `/ops/teams/${made.team.teamId}/reopen`, { body: { reason: "Closed by mistake", expectedVersion: teamOf(made.team.teamId).version }, key: "reopen-key-0001" });
    const items = [...table.items.values()].filter((i) => String(i.PK).startsWith("OPAUDIT#") && String(i.SK).startsWith("AUDIT#"));
    expect(new Set(items.map((i) => i.action))).toEqual(new Set(["ops.teams.list", "ops.receipts.usage", "ops.comp.set", "ops.comp.end", "ops.import.clear", "ops.team.reopen"]));
    for (const item of items) {
      expect(matches(item.before), `${String(item.action)} before`).toBe(1);
      expect(matches(item.after), `${String(item.action)} after`).toBe(1);
    }
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

describe("stuck imports (supply-checkout-6uw.2)", () => {
  const job = (teamId: string, importId: string, startedAt: string, extra: Record<string, unknown> = {}) =>
    table.put({ PK: `TEAM#${teamId}`, SK: `IMPORT#${importId}`, GSI1PK: "IMPORTS#COMMITTING", GSI1SK: `${startedAt}#${importId}`, type: "import", status: "committing", committed: 49, total: 200, createdBy: OWNER, ...extra });

  beforeEach(() => {
    job(teamA, "imp-old", "2026-09-26T09:00:00.000Z");
    job(teamB, "imp-new", "2026-09-26T11:30:00.000Z");
  });

  it("lists imports stuck more than an hour, with their keys and progress only", async () => {
    const res = await call("GET", "/ops/imports");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imports: [{ teamId: teamA, importId: "imp-old", startedAt: "2026-09-26T09:00:00.000Z", committed: 49, total: 200 }], stuckAfterMinutes: 60 });
    expect(JSON.stringify(res.body)).not.toContain(OWNER);
    expect(denied).toEqual([]);
  });

  it("clears one from the check with an audit entry, leaving the job itself alone", async () => {
    table.requests.length = 0;
    const res = await call("POST", `/ops/teams/${teamA}/imports/imp-old/clear`, { body: { reason: "Owner re-imported it" }, key: "clear-key-0001" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eventId: expect.any(String), replayed: false });
    const item = table.get(`TEAM#${teamA}`, "IMPORT#imp-old") as Record<string, unknown>;
    expect(item.GSI1PK).toBeUndefined();
    expect(item.GSI1SK).toBeUndefined();
    expect(item).toMatchObject({ status: "committing", committed: 49, total: 200 });
    const [write] = table.requests.filter((r) => r.command === "TransactWriteCommand");
    expect((write?.input.TransactItems as Record<string, unknown>[]).map((i) => Object.keys(i)[0])).toEqual(["Update", "Put", "Put"]);
    expect(auditItems(teamA)).toEqual([expect.objectContaining({ action: "ops.import.clear", reason: "Owner re-imported it", before: { importId: "imp-old", committing: true }, after: { importId: "imp-old", committing: false } })]);
    expect(tags).toContain(`${OPERATOR} ${teamA}`);
    expect(denied).toEqual([]);
    expect((await call("GET", "/ops/imports")).body.imports).toEqual([]);
    // A retry replays; the owners see it
    const again = await call("POST", `/ops/teams/${teamA}/imports/imp-old/clear`, { body: { reason: "Owner re-imported it" }, key: "clear-key-0001" });
    expect(again.body).toEqual({ ...res.body, replayed: true });
  });

  it("refuses an import that's still running, finished, or isn't there, and anything that isn't an import", async () => {
    const clear = (path: string, key: string) => call("POST", path, { body: { reason: "Clearing it" }, key });
    expect((await clear(`/ops/teams/${teamB}/imports/imp-new/clear`, "clear-key-0002")).status).toBe(409);
    expect(table.get(`TEAM#${teamB}`, "IMPORT#imp-new")?.GSI1PK).toBe("IMPORTS#COMMITTING");
    job(teamA, "imp-done", "2026-09-26T08:00:00.000Z", { GSI1PK: undefined, GSI1SK: undefined, status: "done" });
    expect((await clear(`/ops/teams/${teamA}/imports/imp-done/clear`, "clear-key-0003")).status).toBe(409);
    expect((await clear(`/ops/teams/${teamA}/imports/nope/clear`, "clear-key-0004")).status).toBe(409);
    expect(auditItems(teamA)).toEqual([]);
    expect(auditItems(teamB)).toEqual([]);
  });

  it.each<[string, Record<string, unknown> | undefined, string | undefined]>([
    ["no reason", {}, "clear-key-0005"],
    ["an extra field", { reason: "Clearing it", GSI1PK: "x" }, "clear-key-0006"],
    ["no Idempotency-Key", { reason: "Clearing it" }, undefined],
  ])("refuses a clear with %s", async (_what, body, key) => {
    expect((await call("POST", `/ops/teams/${teamA}/imports/imp-old/clear`, { body, key })).status).toBe(400);
    expect(table.get(`TEAM#${teamA}`, "IMPORT#imp-old")?.GSI1PK).toBe("IMPORTS#COMMITTING");
  });

  it("refuses a bad import ID", async () => {
    expect((await call("POST", `/ops/teams/${teamA}/imports/bad%20id/clear`, { body: { reason: "Clearing it" }, key: "clear-key-0007" })).status).toBe(400);
  });

  it("can't take a closed team out of the purge queue, or touch any other GSI1-keyed item (supply-checkout-6uw.9)", async () => {
    const setup = table.db();
    const made = await createTeam(setup, { userId: "user-d", email: "d@example.com" }, { name: "Delta Clean" }, new Date(NOW - 40 * DAY));
    const teamD = made.team.teamId;
    await closeTeam(setup, made.context, { confirmName: "Delta Clean" }, new Date(NOW - 35 * DAY));
    const closed = teamOf(teamD);
    expect(closed.GSI1PK).toBe("TEAMS#CLOSED");
    const due = await listTeamsToPurge(table.db(), new Date(NOW + 60 * DAY));
    expect(due.map((t) => t.teamId)).toContain(teamD);
    // An item at an import's key, but in another GSI1 partition with an old sort key (as a closed team's META is)
    table.put({ PK: `TEAM#${teamD}`, SK: "IMPORT#not-committing", GSI1PK: "TEAMS#CLOSED", GSI1SK: "2026-01-01T00:00:00.000Z", type: "import", status: "committing" });
    const clear = (importId: string, key: string) => call("POST", `/ops/teams/${teamD}/imports/${importId}/clear`, { body: { reason: "Clearing it" }, key });
    // The route only ever names IMPORT#<id>, so "META" is IMPORT#META, which doesn't exist; the condition refuses the rest
    for (const [importId, key] of [["META", "clear-key-0010"], ["not-committing", "clear-key-0011"], ["x", "clear-key-0012"]] as const) {
      expect((await clear(importId, key)).status).toBe(409);
    }
    expect(teamOf(teamD)).toEqual(closed);
    expect(table.get(`TEAM#${teamD}`, "IMPORT#not-committing")).toMatchObject({ GSI1PK: "TEAMS#CLOSED", GSI1SK: "2026-01-01T00:00:00.000Z" });
    expect(table.get(`TEAM#${teamD}`, "IMPORT#META")).toBeUndefined();
    expect((await listTeamsToPurge(table.db(), new Date(NOW + 60 * DAY))).map((t) => t.teamId)).toEqual(due.map((t) => t.teamId));
    expect(auditItems(teamD)).toEqual([]);
    expect(denied).toEqual([]);
  });
});

describe("reopening a closed team (supply-checkout-6uw.6)", () => {
  const MINUTE = 60_000;
  let ctx: Awaited<ReturnType<typeof createTeam>>["context"];
  let teamC: string;
  const NAME = "Charlie Custodial";

  /** Team C, closed by its owner so that its purge is `minutes` from now. */
  async function closeC(minutes: number) {
    const setup = table.db();
    const made = await createTeam(setup, { userId: "user-c", email: "c@example.com" }, { name: NAME }, new Date(NOW - 40 * DAY));
    ctx = made.context;
    teamC = made.team.teamId;
    const closedAt = new Date(NOW - CLOSED_TEAM_RETENTION_DAYS * DAY + minutes * MINUTE);
    await closeTeam(setup, ctx, { confirmName: NAME }, closedAt);
    return teamOf(teamC);
  }

  const reopen = (teamId: string, body: Record<string, unknown> | undefined, ...key: [string?]) => call("POST", `/ops/teams/${teamId}/reopen`, { body, key: key.length ? key[0] : "reopen-key-0001" });

  it("removes the closure and the purge index keys, moves the version and audits it in the same transaction, without the ops role touching closure fields", async () => {
    const closed = await closeC(5 * 24 * 60);
    expect(closed.GSI1PK).toBe("TEAMS#CLOSED");
    const version = (await call("GET", `/ops/teams/${teamC}`)).body.team.version as number;
    table.requests.length = 0;
    const res = await reopen(teamC, { reason: "Owner closed it by mistake", expectedVersion: version });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ eventId: expect.any(String), replayed: false, version: version + 1 });
    const meta = teamOf(teamC);
    for (const field of ["closedAt", "closedBy", "purgeAfter", "GSI1PK", "GSI1SK"]) expect(meta[field], field).toBeUndefined();
    // The billing worker resyncs its Stripe subscription from that closure, through the reopen role (supply-checkout-85qp)
    expect(meta).toMatchObject({ name: NAME, version: version + 1, owners: 1, stripeResyncFor: closed.closedAt, stripeReopenedAt: expect.any(String) });
    // One transaction: the META item, the audit item and the idempotency record
    const writes = table.requests.filter((r) => r.command === "TransactWriteCommand");
    expect(writes).toHaveLength(1);
    expect((writes[0]?.input.TransactItems as Record<string, unknown>[]).map((i) => Object.keys(i)[0])).toEqual(["Update", "Put", "Put"]);
    expect(auditItems(teamC).filter((a) => a.action !== "ops.team.read")).toEqual([
      expect.objectContaining({ action: "ops.team.reopen", operatorSub: OPERATOR, reason: "Owner closed it by mistake", before: { closedAt: closed.closedAt, purgeAfter: closed.purgeAfter }, after: null, idempotencyKey: "reopen-key-0001" }),
    ]);
    // The purge no longer finds it, and the owner can write again
    expect(await listTeamsToPurge(table.db(), new Date(NOW + 60 * DAY))).toEqual([]);
    // Every call stayed inside its role: the ops function never got a session for the team, and the reopen function's calls fit its policy
    expect(tags.filter((t) => t.endsWith(` ${teamC}`))).toEqual([]);
    expect(denied).toEqual([]);
    expect(reopenDenied).toEqual([]);
    expect(reopenTags).toEqual([teamC]);
    expect(reopenCalls).toEqual([{ operatorSub: OPERATOR, teamId: teamC, reason: "Owner closed it by mistake", expectedVersion: version, idempotencyKey: "reopen-key-0001" }]);
  });

  it("queues a seat sync for the team's Stripe customer after a reopen, and again on a replay (supply-checkout-8jc.21)", async () => {
    const closed = await closeC(24 * 60);
    table.put({ ...teamOf(teamC), stripeCustomerId: "cus_team_c" });
    expect((await reopen(teamC, { reason: "Disputed closure", expectedVersion: closed.version })).status).toBe(200);
    expect(seatSyncs).toEqual([["cus_team_c", "membership"]]);
    // A retry replays the reopen, and queues another sync: harmless, the worker recomputes the quantity
    expect((await reopen(teamC, { reason: "Disputed closure", expectedVersion: closed.version })).body.replayed).toBe(true);
    expect(seatSyncs).toHaveLength(2);
    // Read from the operators' index on the ops function's own role, never a session for the team
    expect(denied).toEqual([]);
    expect(tags.filter((t) => t.endsWith(` ${teamC}`))).toEqual([]);
  });

  it("queues nothing for a team with no Stripe customer, or when the reopen is refused", async () => {
    const closed = await closeC(24 * 60);
    expect((await reopen(teamC, { reason: "Too early", expectedVersion: (closed.version as number) + 1 })).status).toBe(409);
    expect((await reopen(teamC, { reason: "Disputed closure", expectedVersion: closed.version })).status).toBe(200);
    expect(seatSyncs).toEqual([]);
  });

  it("still reopens when the seat sync can't be queued, and logs and counts it", async () => {
    const closed = await closeC(24 * 60);
    table.put({ ...teamOf(teamC), stripeCustomerId: "cus_team_c" });
    seatQueueDown = true;
    const res = await reopen(teamC, { reason: "Disputed closure", expectedVersion: closed.version });
    expect(res.status).toBe(200);
    expect(teamOf(teamC).closedAt).toBeUndefined();
    expect(counted).toContain(BusinessMetric.SeatSyncQueueFailures);
    expect(logs).toContainEqual(["Seat sync not queued", { teamId: teamC, code: "QueueDoesNotExist" }]);
  });

  it("shows the owners what support did, never who", async () => {
    const closed = await closeC(24 * 60);
    await reopen(teamC, { reason: "Disputed closure", expectedVersion: closed.version });
    const data = createDataHandler({ dbForTeam: (teamId) => table.db(teamId), obs: fakeObservability(), now: () => now });
    const res = await data({
      routeKey: "GET /teams/{teamId}/support-actions",
      rawPath: `/teams/${teamC}/support-actions`,
      headers: {},
      pathParameters: { teamId: teamC },
      requestContext: { authorizer: { jwt: { claims: { iss: CUSTOMER_ISSUER, token_use: "access", exp: Math.floor(now / 1000) + 600, sub: "user-c" }, scopes: [] } } },
    } as unknown as DataEvent);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.actions).toEqual([
      { eventId: expect.any(String), ts: expect.any(String), actor: "Supply Checkout support", action: "ops.team.reopen", reason: "Disputed closure", before: { closedAt: closed.closedAt, purgeAfter: closed.purgeAfter }, after: null },
    ]);
    expect(JSON.stringify(body)).not.toContain(OPERATOR);
  });

  it("replays a retry with the same key, even though the team is open by then, and refuses the key for another body", async () => {
    const closed = await closeC(24 * 60);
    const first = await reopen(teamC, { reason: "Disputed closure", expectedVersion: closed.version });
    const again = await reopen(teamC, { reason: "Disputed closure", expectedVersion: closed.version });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(auditItems(teamC)).toHaveLength(1);
    const other = await reopen(teamC, { reason: "Another reason", expectedVersion: closed.version });
    expect(other.status).toBe(409);
    expect(other.body.error.message).toMatch(/Idempotency-Key/);
    // A new key on an open team
    const open = await reopen(teamC, { reason: "Disputed closure", expectedVersion: closed.version }, "reopen-key-0002");
    expect(open.status).toBe(409);
    expect(open.body.error.message).toBe("This team isn't closed");
  });

  it("restores a closure in its last hour, after the owners' cutoff, until a few minutes before the purge", async () => {
    const minutes = REOPEN_CUTOFF_MINUTES - 30;
    expect(minutes).toBeGreaterThan(OPS_REOPEN_CUTOFF_MINUTES);
    const closed = await closeC(minutes);
    // Too late for the owner
    await expect(reopenTeam(table.db(teamC), ctx, { confirmName: NAME }, new Date(now))).rejects.toBeInstanceOf(TeamDeletingError);
    const res = await reopen(teamC, { reason: "Disputed closure, last hour", expectedVersion: closed.version });
    expect(res.status).toBe(200);
    expect(teamOf(teamC).closedAt).toBeUndefined();
  });

  it.each([OPS_REOPEN_CUTOFF_MINUTES, 1, -1, -60])("refuses a team whose purge is %d minutes away, as being deleted", async (minutes) => {
    const closed = await closeC(minutes);
    const res = await reopen(teamC, { reason: "Too late", expectedVersion: closed.version });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "aborted", reason: "team_deleting" });
    expect(teamOf(teamC).closedAt).toBe(closed.closedAt);
    expect(auditItems(teamC)).toEqual([]);
  });

  it("refuses a team the purge has marked purging, whatever its purgeAfter says", async () => {
    const closed = await closeC(24 * 60);
    table.put({ ...teamOf(teamC), purging: new Date(now).toISOString() });
    const res = await reopen(teamC, { reason: "Too late", expectedVersion: closed.version });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "aborted", reason: "team_deleting" });
    expect(teamOf(teamC).closedAt).toBe(closed.closedAt);
    expect(reopenDenied).toEqual([]);
  });

  it("loses to a purge that marks the team between the read and the write", async () => {
    const closed = await closeC(24 * 60);
    table.afterGet = () => {
      table.afterGet = undefined;
      table.put({ ...teamOf(teamC), purging: new Date(now).toISOString() });
    };
    const res = await reopen(teamC, { reason: "Racing the purge", expectedVersion: closed.version });
    expect(res.status).toBe(409);
    expect(teamOf(teamC).closedAt).toBe(closed.closedAt);
    expect(auditItems(teamC)).toEqual([]);
  });

  it("refuses a stale version, an open team, a team with no owner left, and a team that isn't there", async () => {
    const closed = await closeC(24 * 60);
    expect((await reopen(teamC, { reason: "Stale", expectedVersion: (closed.version as number) - 1 })).status).toBe(409);
    expect((await reopen(teamA, { reason: "Open", expectedVersion: 1 })).body.error.message).toBe("This team isn't closed");
    expect((await reopen("no-such-team", { reason: "Missing", expectedVersion: 1 })).status).toBe(404);
    table.put({ ...teamOf(teamC), owners: 0 });
    const ownerless = await reopen(teamC, { reason: "Nobody to reopen it for", expectedVersion: closed.version }, "reopen-key-0003");
    expect(ownerless.status).toBe(409);
    expect(ownerless.body.error.message).toMatch(/no owner/);
    expect(teamOf(teamC).closedAt).toBe(closed.closedAt);
    expect(auditItems(teamC)).toEqual([]);
  });

  it("refuses when the closure changed between the read and the write", async () => {
    const closed = await closeC(24 * 60);
    // Another writer bumps the version after the reopen function read the team
    table.afterGet = () => {
      table.afterGet = undefined;
      table.put({ ...teamOf(teamC), version: (closed.version as number) + 1 });
    };
    const res = await reopen(teamC, { reason: "Racing", expectedVersion: closed.version });
    expect(res.status).toBe(409);
    expect(teamOf(teamC).closedAt).toBe(closed.closedAt);
    expect(auditItems(teamC)).toEqual([]);
  });

  it.each<[string, Record<string, unknown> | undefined, string | undefined]>([
    ["no reason", { expectedVersion: 2 }, "reopen-key-0004"],
    ["a short reason", { reason: "no", expectedVersion: 2 }, "reopen-key-0004"],
    ["no version", { reason: "Disputed closure" }, "reopen-key-0004"],
    ["an extra field", { reason: "Disputed closure", expectedVersion: 2, closedAt: "x" }, "reopen-key-0004"],
    ["no body", undefined, "reopen-key-0004"],
    ["no Idempotency-Key", { reason: "Disputed closure", expectedVersion: 2 }, undefined],
  ])("refuses a reopen with %s", async (_what, body, key) => {
    const closed = await closeC(24 * 60);
    expect((await reopen(teamC, body, key)).status).toBe(400);
    expect(teamOf(teamC).closedAt).toBe(closed.closedAt);
  });

  it("refuses a bad team ID without invoking the reopen function, and answers 500 when it fails", async () => {
    expect((await reopen("bad%20id", { reason: "Disputed closure", expectedVersion: 2 })).status).toBe(400);
    expect(reopenCalls).toEqual([]);
    const failing = createOpsHandler({
      dbFor: () => table.db(),
      directory,
      reopen: () => Promise.reject(new Error("Reopen function failed: 500")),
      issuerUrl: OPS_ISSUER,
      clientId: OPS_CLIENT,
      obs: fakeObservability(),
      now: () => now,
    });
    const res = await failing(event("POST", `/ops/teams/${teamA}/reopen`, { body: { reason: "Disputed closure", expectedVersion: 2 }, key: "reopen-key-0005" }));
    expect(res.statusCode).toBe(500);
  });

  it("is refused to anyone but an operator", async () => {
    await closeC(24 * 60);
    groups.set("member-only", []);
    const res = await call("POST", `/ops/teams/${teamC}/reopen`, { body: { reason: "Disputed closure", expectedVersion: 2 }, key: "reopen-key-0006", claims: { sub: "member-only" } });
    expect(res.status).toBe(403);
    expect(reopenCalls).toEqual([]);
    expect((await call("POST", `/ops/teams/${teamC}/reopen`, { body: { reason: "Disputed closure", expectedVersion: 2 }, key: "reopen-key-0007", claims: { iss: CUSTOMER_ISSUER, client_id: WEB_CLIENT } })).status).toBe(401);
    expect(teamOf(teamC).closedAt).toBeDefined();
  });
});

describe("receipt usage (supply-checkout-wxx)", () => {
  const usage = (teamId: string, sk: string, receipts: number) => table.put({ PK: `TEAM#${teamId}`, SK: sk, receipts });

  it("shows a team's reads for the last six months and its trial, with the estimated cost, as part of its audited record", async () => {
    usage(teamA, "USAGE#2026-09", 40);
    usage(teamA, "USAGE#2026-07", 3);
    usage(teamA, "USAGE#2026-03", 99);
    usage(teamA, "USAGE#TRIAL", 25);
    usage(teamB, "USAGE#2026-09", 7);
    const res = await call("GET", `/ops/teams/${teamA}`);
    expect(res.status).toBe(200);
    expect(res.body.receipts).toEqual({
      months: [
        { month: "2026-09", receipts: 40, estimatedCostUsd: 0.28 },
        { month: "2026-08", receipts: 0, estimatedCostUsd: 0 },
        { month: "2026-07", receipts: 3, estimatedCostUsd: 0.021 },
        { month: "2026-06", receipts: 0, estimatedCostUsd: 0 },
        { month: "2026-05", receipts: 0, estimatedCostUsd: 0 },
        { month: "2026-04", receipts: 0, estimatedCostUsd: 0 },
      ],
      trialReceipts: 25,
    });
    expect(ESTIMATED_COST_PER_RECEIPT_USD).toBe(0.007);
    // Only the counters, by key, projected: nothing else of the team's partition
    const reads = table.requests.filter((r) => r.command === "BatchGetCommand");
    expect(reads).toHaveLength(1);
    const request = Object.values(reads[0]?.input.RequestItems as Record<string, { Keys: { PK: string; SK: string }[]; ProjectionExpression: string }>)[0];
    expect(request?.ProjectionExpression).toBe("PK, SK, receipts");
    expect(request?.Keys.every((k) => k.PK === `TEAM#${teamA}` && /^USAGE#(\d{4}-\d{2}|TRIAL)$/.test(k.SK))).toBe(true);
    // The read is the record's, audited once
    expect(auditItems(teamA).map((a) => a.action)).toEqual(["ops.team.read"]);
    expect(denied).toEqual([]);
    expect(JSON.stringify(res.body.receipts)).not.toContain("Secret client");
  });

  it("still shows the record, with receipts: null, when the counters can't be read", async () => {
    // The counters' read refused (a throttle, say): only the batch read fails
    const failing = createOpsHandler({
      dbFor: (_operatorSub, teamId) => table.guarded((command, input) => command !== "BatchGetCommand" && opsPolicy(teamId ?? ".", denied)(command, input)),
      directory,
      reopen: async () => { throw new Error("unused"); },
      issuerUrl: OPS_ISSUER,
      clientId: OPS_CLIENT,
      obs: fakeObservability(),
      now: () => now,
    });
    const res = await failing(event("GET", `/ops/teams/${teamA}`));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string);
    expect(body.receipts).toBeNull();
    expect(body.team).toMatchObject({ id: teamA, name: "Acme Cleaning" });
    expect(JSON.stringify(logs)).toContain('"Receipt usage unavailable",{"teamId":"' + teamA + '","code":"AccessDeniedException"}');
    expect(auditItems(teamA).map((a) => a.action)).toEqual(["ops.team.read"]);
  });

  it("goes across a year's start", async () => {
    now = Date.parse("2027-02-10T00:00:00Z");
    usage(teamA, "USAGE#2026-12", 5);
    const res = await call("GET", `/ops/teams/${teamA}`, { claims: { exp: Math.floor(now / 1000) + 900 } });
    expect(res.body.receipts.months.map((m: { month: string }) => m.month)).toEqual(["2027-02", "2027-01", "2026-12", "2026-11", "2026-10", "2026-09"]);
    expect(res.body.receipts.months[2].receipts).toBe(5);
  });

  it("lists the teams that read the most in a month, most first, with their trial reads and plan, and audits it", async () => {
    usage(teamA, "USAGE#2026-09", 12);
    usage(teamA, "USAGE#TRIAL", 12);
    usage(teamB, "USAGE#2026-09", 150);
    usage(teamB, "USAGE#2026-08", 400);
    const res = await call("GET", "/ops/receipts", { query: { month: "2026-09" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      month: "2026-09",
      teams: [
        { teamId: teamB, name: "Bravo Janitorial", status: "trialing", plan: "trial", compLive: false, receipts: 150, trialReceipts: 0, estimatedCostUsd: 1.05 },
        { teamId: teamA, name: "Acme Cleaning", status: "trialing", plan: "trial", compLive: false, receipts: 12, trialReceipts: 12, estimatedCostUsd: 0.084 },
      ],
      teamsRead: 2,
      complete: true,
      estimatedCostPerReceiptUsd: 0.007,
    });
    expect((await call("GET", "/ops/receipts", { query: { month: "2026-09", limit: "1" } })).body.teams.map((t: { teamId: string }) => t.teamId)).toEqual([teamB]);
    // This month by default; a team with no reads isn't listed
    expect((await call("GET", "/ops/receipts", { query: { month: "2026-08" } })).body.teams.map((t: { teamId: string }) => t.teamId)).toEqual([teamB]);
    expect((await call("GET", "/ops/receipts")).body.month).toBe("2026-09");
    const audits = auditItems("PLATFORM").filter((a) => a.action === "ops.receipts.usage");
    expect(audits[0]).toMatchObject({ operatorSub: OPERATOR, target: "teams", after: { month: "2026-09", teams: [teamB, teamA] } });
    expect(audits).toHaveLength(4);
    expect(denied).toEqual([]);
    // Logged by IDs and status only
    expect(JSON.stringify(logs)).not.toContain("Bravo Janitorial");
  });

  it("asks again for keys DynamoDB leaves unprocessed, reads at most MAX_OPS_TEAMS_READ teams, and refuses bad input", async () => {
    usage(teamB, "USAGE#2026-09", 2);
    table.unprocessed = 2;
    expect((await call("GET", "/ops/receipts", { query: { month: "2026-09" } })).body.teams).toMatchObject([{ teamId: teamB, receipts: 2 }]);
    expect(table.requests.filter((r) => r.command === "BatchGetCommand")).toHaveLength(2);
    for (const [query, status] of [[{ month: "2026-13" }, 400], [{ month: "Sept" }, 400], [{ month: "2026-09", limit: "0" }, 400], [{ month: "2026-09", limit: "101" }, 400]] as const) {
      expect((await call("GET", "/ops/receipts", { query })).status).toBe(status);
    }
    // More teams than one request reads: ranked from those it read, and says so
    for (let i = 0; i < MAX_OPS_TEAMS_READ; i++) table.put({ PK: `TEAM#bulk-${String(i).padStart(4, "0")}`, SK: "META", GSI3PK: "OPS#TEAMS", GSI3SK: `bulk-${String(i).padStart(4, "0")}`, name: `Bulk ${i}`, plan: "trial", status: "trialing", seats: 1, owners: 1, createdAt: "2026-09-01T00:00:00.000Z", version: 1 });
    const big = await call("GET", "/ops/receipts", { query: { month: "2026-09" } });
    expect(big.body).toMatchObject({ teamsRead: MAX_OPS_TEAMS_READ, complete: false });
  });

  it("keeps it to operators", async () => {
    groups.set("member-only", []);
    expect((await call("GET", "/ops/receipts", { claims: { sub: "member-only" } })).status).toBe(403);
    expect((await call("GET", "/ops/receipts", { claims: { iss: CUSTOMER_ISSUER, client_id: WEB_CLIENT } })).status).toBe(401);
    expect(table.requests.filter((r) => r.command === "BatchGetCommand")).toEqual([]);
  });
});
