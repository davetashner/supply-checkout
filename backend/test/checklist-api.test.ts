// The first-run checklist's progress through the data API's handler
// (supply-checkout-fs56, data/checklist.ts), against the in-memory table
// (memory-table.ts): owners mark a step or the whole checklist done, only ever
// to true, on the team's META item and nothing else. GET /me's side is in
// account-api.test.ts; access-patterns.test.ts runs it against DynamoDB Local.

import { beforeEach, describe, expect, it } from "vitest";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { DATA_ROUTES, routeKey } from "../src/api/routes.js";
import { InvalidInputError } from "../src/data/index.js";
import type { Observability } from "../src/observability/index.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";

let table: MemoryTable;
let clock: number;
let counts: Record<string, number>;
let handler: ReturnType<typeof createDataHandler>;

beforeEach(() => {
  table = new MemoryTable();
  table.seedTeam("team-a", { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  counts = {};
  clock = NOW;
  const obs = {
    region: "test-local-1",
    logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} },
    count: (metric: string, value = 1) => {
      counts[metric] = (counts[metric] ?? 0) + value;
    },
    flush: () => {},
  } as unknown as Observability;
  handler = createDataHandler({
    dbForTeam: (teamId) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(teamId)) throw new InvalidInputError("Invalid team ID");
      return table.db(teamId);
    },
    obs,
    now: () => clock,
  });
});

function event(method: string, path: string, user: string, body?: unknown, query?: Record<string, string>): DataEvent {
  const segments = path.split("/");
  const route = DATA_ROUTES.find((r) => {
    const parts = r.path.split("/");
    return r.method === method && parts.length === segments.length && parts.every((p, i) => p.startsWith("{") || p === segments[i]);
  });
  const pathParameters: Record<string, string> = {};
  route?.path.split("/").forEach((p, i) => {
    if (p.startsWith("{")) pathParameters[p.slice(1, -1)] = decodeURIComponent(segments[i] as string);
  });
  return {
    version: "2.0",
    routeKey: route ? routeKey(route) : `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    queryStringParameters: query,
    pathParameters,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(NOW / 1000 + 600) }, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function call(method: string, path: string, body?: unknown, user = CONTRIBUTOR, query?: Record<string, string>) {
  const response = await handler(event(method, path, user, body, query));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined, text: response.body ?? "" };
}


const CHECKLIST = "/teams/team-a/checklist";
const meta = () => table.get("TEAM#team-a", "META") as Record<string, unknown>;
const STARTED = "2026-09-30T08:00:00.000Z";
const start = () => table.put({ ...meta(), checklistStartedAt: STARTED });

describe("PATCH /teams/{teamId}/checklist", () => {
  it("marks the receipt step and then the whole checklist done, keeping when it started", async () => {
    start();
    expect(await call("PATCH", CHECKLIST, { receipt: true }, OWNER)).toEqual({ status: 200, body: { checklist: { receipt: true, done: false } }, text: expect.any(String) });
    expect(await call("PATCH", CHECKLIST, { done: true }, OWNER)).toMatchObject({ status: 200, body: { checklist: { receipt: true, done: true } } });
    // Again is the same: a step done stays done
    expect(await call("PATCH", CHECKLIST, { receipt: true, done: true }, OWNER)).toMatchObject({ status: 200, body: { checklist: { receipt: true, done: true } } });
    expect(meta()).toMatchObject({ checklistStartedAt: STARTED, checklistReceipt: true, checklistDone: true });
  });

  it("changes nothing else on the team's META item, and no other item", async () => {
    start();
    const before = structuredClone(table.items);
    await call("PATCH", CHECKLIST, { receipt: true, done: true }, OWNER);
    const { checklistReceipt, checklistDone, ...rest } = meta();
    expect({ checklistReceipt, checklistDone }).toEqual({ checklistReceipt: true, checklistDone: true });
    expect(rest).toEqual(before.get("TEAM#team-a\u0000META"));
    expect([...table.items.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it("starts a checklist for a team that never had one, only with a field the app sends", async () => {
    expect(meta().checklistStartedAt).toBeUndefined();
    expect(await call("PATCH", CHECKLIST, { started: true }, OWNER)).toMatchObject({ status: 200, body: { checklist: { receipt: false, done: false } } });
    expect(meta().checklistStartedAt).toBe(new Date(NOW).toISOString());
    clock = NOW + 60_000;
    await call("PATCH", CHECKLIST, { started: true, receipt: true }, OWNER);
    expect(meta()).toMatchObject({ checklistStartedAt: new Date(NOW).toISOString(), checklistReceipt: true });
  });

  it("takes only true for started, receipt and done, and writes nothing otherwise", async () => {
    start();
    const before = structuredClone(meta());
    for (const body of [{}, { done: false }, { receipt: "true" }, { done: 1 }, { done: null }, { started: false }, { done: true, invited: true }, { checklistDone: true }, { PK: "TEAM#team-b" }, [], "done", null]) {
      expect(await call("PATCH", CHECKLIST, body, OWNER), JSON.stringify(body)).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    }
    expect((await call("PATCH", CHECKLIST, undefined, OWNER)).status).toBe(400);
    expect(meta()).toEqual(before);
  });

  it("is owners only: contributors, viewers and outsiders change nothing", async () => {
    start();
    for (const user of [CONTRIBUTOR, VIEWER]) {
      expect(await call("PATCH", CHECKLIST, { done: true }, user)).toMatchObject({ status: 403, body: { error: { code: "permission_denied", reason: "owners_only" } } });
    }
    expect((await call("PATCH", CHECKLIST, { done: true }, "user-stranger")).status).toBe(403);
    // Another team's owner, naming this team
    table.seedTeam("team-b", { "user-b": "owner" });
    expect((await call("PATCH", CHECKLIST, { done: true }, "user-b")).status).toBe(403);
    expect(meta().checklistDone).toBeUndefined();
  });

  it("refuses a closed team, and one closed meanwhile, and writes nothing", async () => {
    start();
    table.put({ ...meta(), closedAt: "2026-09-30T09:00:00.000Z", purgeAfter: "2026-10-30T09:00:00.000Z" });
    expect(await call("PATCH", CHECKLIST, { done: true }, OWNER)).toMatchObject({ status: 403, body: { error: { code: "permission_denied", reason: "team_closed" } } });
    expect(meta().checklistDone).toBeUndefined();

    table.put({ ...meta(), closedAt: undefined, purgeAfter: undefined });
    table.failingUpdates = (input) => {
      // Another owner closes it between the membership check and the write
      if ((input.Key as { SK?: string }).SK === "META") table.put({ ...meta(), closedAt: "2026-10-01T11:59:00.000Z" });
      return false;
    };
    expect(await call("PATCH", CHECKLIST, { done: true }, OWNER)).toMatchObject({ status: 403, body: { error: { code: "permission_denied", reason: "team_closed" } } });
    expect(meta().checklistDone).toBeUndefined();
  });

  it("rethrows a DynamoDB error it doesn't expect, as a 500", async () => {
    start();
    table.failingUpdates = () => true;
    expect((await call("PATCH", CHECKLIST, { done: true }, OWNER)).status).toBe(500);
  });
});
