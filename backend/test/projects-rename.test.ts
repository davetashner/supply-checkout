// The sheets-to-projects rename's window (supply-checkout-005.6,
// docs/projects-rename-plan.md, "Server release 1"), through the data API's
// handler against the in-memory table: both route spellings, both field
// spellings, items under PROJECT# and SHEET#, lists that merge them, team
// isolation under either spelling, the canonical idempotency fingerprint, the
// LegacySheetsRouteCalls metric, and live updates under both collection names.

import { randomUUID } from "node:crypto";
import type { DynamoDBRecord } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { DATA_ROUTES, routeKey } from "../src/api/routes.js";
import {
  authorizeTeam,
  canonicalCollection,
  canonicalRequest,
  getDocument,
  InvalidInputError,
  layoutOf,
  listDocuments,
  movementWithBothNames,
  projectAttributes,
  withProjectNames,
} from "../src/data/index.js";
import type { Observability } from "../src/observability/index.js";
import type { Audience } from "../src/realtime/audience.js";
import { COLLECTION_EVENT_AFTER, LEGACY_EVENT_COLLECTIONS } from "../src/realtime/channels.js";
import { createPublisherHandler } from "../src/realtime/publisher-handler.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";
const A = "TEAM#team-a";
const B = "TEAM#team-b";

let table: MemoryTable;
let counts: Record<string, number>;
let metadata: Record<string, unknown>[];
let handler: ReturnType<typeof createDataHandler>;

beforeEach(() => {
  table = new MemoryTable();
  table.seedTeam("team-a", { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  table.seedTeam("team-b", { [OUTSIDER]: "owner" });
  counts = {};
  metadata = [];
  const obs = {
    region: "test-local-1",
    logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} },
    count: (metric: string, value = 1, meta?: Record<string, unknown>) => {
      counts[metric] = (counts[metric] ?? 0) + value;
      if (metric === "LegacySheetsRouteCalls") metadata.push(meta ?? {});
    },
    gauge: () => {},
    flush: () => {},
  } as unknown as Observability;
  handler = createDataHandler({
    dbForTeam: (teamId) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(teamId)) throw new InvalidInputError("Invalid team ID");
      return table.db(teamId);
    },
    obs,
    now: () => NOW,
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
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const op = () => randomUUID();

/** A project stored the old way, before the rename's backfill: SHEET#, the #SHEETS index partition, type "sheet". */
function legacy(team: string, id: string, data: Record<string, unknown> = {}) {
  const date = (data.date as string | undefined) ?? "2026-10-01";
  table.put({ PK: team, SK: `SHEET#${id}`, GSI1PK: `${team}#SHEETS`, GSI1SK: `${date}#${id}`, type: "sheet", id, version: 1, client: "Echo", date, status: "open", items: {}, ...data });
}

/** A project stored the new way: PROJECT#, the #PROJECTS index partition, type "project". */
function current(team: string, id: string, data: Record<string, unknown> = {}) {
  const date = (data.date as string | undefined) ?? "2026-10-01";
  table.put({ PK: team, SK: `PROJECT#${id}`, GSI1PK: `${team}#PROJECTS`, GSI1SK: `${date}#${id}`, type: "project", id, version: 1, client: "Echo", date, status: "open", items: {}, ...data });
}

function gloves(team = A, stock = 10) {
  table.put({ PK: team, SK: "PRODUCT#0123", type: "product", key: "0123", version: 1, code: "0123", name: "Nitrile gloves", price: 12.5, stock });
}

const ids = (body: { documents: { id: string }[] }) => body.documents.map((d) => d.id);

describe("routes: /projects, and /sheets as its old name", () => {
  it("creates a project under PROJECT# through either route, and reads it back through both", async () => {
    for (const [route, id] of [["projects", "p1"], ["sheets", "p2"]] as const) {
      const put = await call("PUT", `/teams/team-a/${route}/${id}`, { data: { client: "Delta", date: "2026-10-02", status: "open", items: {} }, expectedVersion: 0 });
      expect(put, route).toMatchObject({ status: 200, body: { id, version: 1 } });
      expect(table.get(A, `PROJECT#${id}`)).toMatchObject({ type: "project", id, GSI1PK: `${A}#PROJECTS`, GSI1SK: `2026-10-02#${id}`, client: "Delta" });
      expect(table.get(A, `SHEET#${id}`)).toBeUndefined();
      for (const other of ["projects", "sheets"]) expect((await call("GET", `/teams/team-a/${other}/${id}`)).body, `${route} then ${other}`).toMatchObject({ id, version: 1, data: { client: "Delta" } });
    }
  });

  it("reads, changes and deletes a project still under SHEET# where it is, through either route, never moving it", async () => {
    legacy(A, "old", { items: { "0123": { out: 2, returned: 0 } } });
    for (const route of ["projects", "sheets"]) expect((await call("GET", `/teams/team-a/${route}/old`)).body).toMatchObject({ id: "old", version: 1, data: { client: "Echo" } });
    expect(await call("PATCH", "/teams/team-a/projects/old", { data: { client: "Foxtrot", date: "2026-10-05" }, expectedVersion: 1 })).toMatchObject({ status: 200, body: { version: 2 } });
    expect(await call("PUT", "/teams/team-a/sheets/old", { data: { client: "Golf", date: "2026-10-05", status: "open", items: {} }, expectedVersion: 2 })).toMatchObject({ status: 200, body: { version: 3 } });
    // Updated in place: the backfill moves it, never a write
    expect(table.get(A, "SHEET#old")).toMatchObject({ type: "sheet", GSI1PK: `${A}#SHEETS`, GSI1SK: "2026-10-05#old", client: "Golf", version: 3 });
    expect(table.get(A, "PROJECT#old")).toBeUndefined();
    expect((await call("DELETE", "/teams/team-a/projects/old", undefined, CONTRIBUTOR, { expectedVersion: "2" })).status).toBe(409);
    expect((await call("DELETE", "/teams/team-a/projects/old", undefined, CONTRIBUTOR, { expectedVersion: "3" })).status).toBe(204);
    expect(table.get(A, "SHEET#old")).toBeUndefined();
    expect((await call("GET", "/teams/team-a/sheets/old")).status).toBe(404);
    // A create on a gone ID is a new project
    expect((await call("PUT", "/teams/team-a/sheets/old", { data: { client: "Hotel", date: "2026-10-06" }, expectedVersion: 0 })).status).toBe(200);
    expect(table.get(A, "PROJECT#old")).toMatchObject({ type: "project", client: "Hotel" });
  });

  it("refuses a create over a project still under SHEET# (it exists), and expects its version", async () => {
    legacy(A, "old");
    expect((await call("PUT", "/teams/team-a/projects/old", { data: { client: "X" }, expectedVersion: 0 })).status).toBe(409);
    expect(table.get(A, "PROJECT#old")).toBeUndefined();
  });

  it("gives /sheets exactly the roles /projects has: viewers read, only contributors and owners write", async () => {
    legacy(A, "old");
    for (const route of ["projects", "sheets"]) {
      expect((await call("GET", `/teams/team-a/${route}/old`, undefined, VIEWER)).status, route).toBe(200);
      expect((await call("PATCH", `/teams/team-a/${route}/old`, { data: { client: "V" }, expectedVersion: 1 }, VIEWER)).body.error, route).toMatchObject({ code: "permission_denied", reason: "view_only" });
      expect((await call("POST", `/teams/team-a/${route}/old/checkout`, { operationId: op(), productKey: "0123", quantity: 1 }, VIEWER)).status, route).toBe(403);
    }
    expect(table.get(A, "SHEET#old")).toMatchObject({ client: "Echo", version: 1 });
  });

  it("checks the body the same on both: a field neither route takes is refused, and the path names the project", async () => {
    current(A, "p1");
    gloves();
    for (const route of ["projects", "sheets"]) {
      for (const field of ["sheetId", "projectId"]) {
        const res = await call("POST", `/teams/team-a/${route}/p1/checkout`, { operationId: op(), productKey: "0123", quantity: 1, [field]: "elsewhere" });
        expect(res, `${route} ${field}`).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
      }
    }
    expect(table.get(A, "PRODUCT#0123")?.stock).toBe(10);
  });
});

describe("the LegacySheetsRouteCalls metric", () => {
  it("counts every call to an old /sheets route, with its route key and nothing from the request, and none to /projects", async () => {
    current(A, "p1");
    await call("GET", "/teams/team-a/projects");
    await call("GET", "/teams/team-a/projects/p1");
    expect(counts.LegacySheetsRouteCalls).toBeUndefined();
    await call("GET", "/teams/team-a/sheets");
    await call("GET", "/teams/team-a/sheets/p1");
    // Counted before the membership check: a refused call is still an old client
    expect((await call("GET", "/teams/team-a/sheets/p1", undefined, OUTSIDER)).status).toBe(403);
    expect(counts.LegacySheetsRouteCalls).toBe(3);
    expect(metadata).toEqual([
      { route: "GET /teams/{teamId}/sheets" },
      { route: "GET /teams/{teamId}/sheets/{sheetId}" },
      { route: "GET /teams/{teamId}/sheets/{sheetId}" },
    ]);
  });
});

describe("lists across PROJECT# and SHEET#", () => {
  beforeEach(() => {
    current(A, "c", { date: "2026-10-03" });
    legacy(A, "a", { date: "2026-10-05" });
    current(A, "e", { date: "2026-10-01" });
    legacy(A, "b", { date: "2026-10-02" });
    legacy(A, "d", { date: "2026-10-04" });
    // A twin left by a manual mix: the PROJECT# copy wins
    current(A, "t", { date: "2026-10-06", client: "New" });
    legacy(A, "t", { date: "2026-10-06", client: "Old" });
    // Another team's, under both prefixes
    current(B, "x");
    legacy(B, "y");
  });

  it("lists every project once, by ID within each prefix, preferring PROJECT# for a twin, through either route", async () => {
    for (const route of ["projects", "sheets"]) {
      const { body } = await call("GET", `/teams/team-a/${route}`);
      expect(ids(body), route).toEqual(["c", "e", "t", "a", "b", "d"]);
      expect(body.documents.find((d: { id: string }) => d.id === "t").data.client).toBe("New");
      expect(body.cursor).toBeUndefined();
    }
  });

  it("pages through both prefixes with any limit, never repeating or skipping one", async () => {
    for (const limit of [1, 2, 3, 4, 7]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 20; pages++) {
        const { status, body } = await call("GET", "/teams/team-a/projects", undefined, CONTRIBUTOR, { limit: String(limit), ...(cursor ? { cursor } : {}) });
        expect(status).toBe(200);
        expect(body.documents.length).toBeLessThanOrEqual(limit);
        seen.push(...ids(body));
        cursor = body.cursor;
        if (!cursor) break;
      }
      expect(seen, `limit ${limit}`).toEqual(["c", "e", "t", "a", "b", "d"]);
    }
  });

  it("merges both date index partitions in date order, either way, and pages through them", async () => {
    expect(ids((await call("GET", "/teams/team-a/projects", undefined, CONTRIBUTOR, { orderBy: "date" })).body)).toEqual(["e", "b", "c", "d", "a", "t"]);
    expect(ids((await call("GET", "/teams/team-a/sheets", undefined, CONTRIBUTOR, { orderBy: "date", direction: "desc" })).body)).toEqual(["t", "a", "d", "c", "b", "e"]);
    for (const limit of [1, 2, 4]) {
      for (const direction of ["asc", "desc"]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let pages = 0; pages < 20; pages++) {
          const { status, body } = await call("GET", "/teams/team-a/projects", undefined, CONTRIBUTOR, { orderBy: "date", direction, limit: String(limit), ...(cursor ? { cursor } : {}) });
          expect(status).toBe(200);
          expect(body.documents.length).toBeLessThanOrEqual(limit);
          seen.push(...ids(body));
          cursor = body.cursor;
          if (!cursor) break;
        }
        const asc = ["e", "b", "c", "d", "a", "t"];
        expect(seen, `${direction} limit ${limit}`).toEqual(direction === "asc" ? asc : [...asc].reverse());
      }
    }
  });

  it("refuses a cursor from another team, another collection, or another order, under either prefix", async () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const bad = [
      enc({ PK: B, SK: "PROJECT#x" }),
      enc({ PK: B, SK: "SHEET#y" }),
      enc({ PK: A, SK: "PRODUCT#0123" }),
      enc({ PK: A, SK: "PROJECT#c", extra: "x" }),
      enc({ PK: A, SK: 5 }),
      enc({ at: [{ PK: A, SK: "PROJECT#c", GSI1PK: `${A}#PROJECTS`, GSI1SK: "2026-10-03#c" }, "done"] }),
      "not base64 json",
    ];
    for (const cursor of bad) expect((await call("GET", "/teams/team-a/projects", undefined, CONTRIBUTOR, { cursor })).body.error?.code, cursor).toBe("bad_request");
    const dateBad = [
      enc({ at: [{ PK: B, SK: "PROJECT#x", GSI1PK: `${B}#PROJECTS`, GSI1SK: "2026-10-01#x" }, "done"] }),
      enc({ at: ["done", { PK: B, SK: "SHEET#y", GSI1PK: `${B}#SHEETS`, GSI1SK: "2026-10-01#y" }] }),
      // Another team's index partition with this team's base key
      enc({ at: [{ PK: A, SK: "PROJECT#c", GSI1PK: `${B}#PROJECTS`, GSI1SK: "2026-10-03#c" }, "done"] }),
      // The partitions swapped
      enc({ at: [{ PK: A, SK: "SHEET#a", GSI1PK: `${A}#SHEETS`, GSI1SK: "2026-10-05#a" }, "done"] }),
      enc({ at: ["done"] }),
      enc({ at: ["done", "done"], more: 1 }),
      enc({ PK: A, SK: "PROJECT#c" }),
    ];
    for (const cursor of dateBad) expect((await call("GET", "/teams/team-a/projects", undefined, CONTRIBUTOR, { cursor, orderBy: "date" })).body.error?.code, cursor).toBe("bad_request");
  });

  it("only ever names team A's partitions, whichever way it lists", async () => {
    table.calls.length = 0;
    await call("GET", "/teams/team-a/projects");
    await call("GET", "/teams/team-a/sheets", undefined, CONTRIBUTOR, { orderBy: "date" });
    for (const c of table.calls) for (const p of c.partitions) expect([A, `${A}#PROJECTS`, `${A}#SHEETS`]).toContain(p);
  });
});

describe("team isolation, under either spelling", () => {
  beforeEach(() => {
    current(B, "x", { client: "Secret" });
    legacy(B, "y", { client: "Secret" });
    gloves(B);
  });

  it("never reaches another team's project by ID, under PROJECT# or SHEET#, through either route", async () => {
    for (const route of ["projects", "sheets"]) {
      for (const id of ["x", "y"]) {
        expect((await call("GET", `/teams/team-a/${route}/${id}`)).status, `${route} ${id}`).toBe(404);
        // Not there in team A: the version it names isn't the (missing) one's
        expect((await call("PATCH", `/teams/team-a/${route}/${id}`, { data: { client: "Mine" }, expectedVersion: 1 })).status).toBe(409);
        expect((await call("POST", `/teams/team-a/${route}/${id}/checkout`, { operationId: op(), productKey: "0123", quantity: 1 })).status).toBe(404);
        // Team B's own route refuses team A's user
        expect((await call("GET", `/teams/team-b/${route}/${id}`)).body.error).toMatchObject({ code: "permission_denied", reason: "not_member" });
      }
    }
    expect(table.get(B, "PROJECT#x")).toMatchObject({ client: "Secret", version: 1 });
    expect(table.get(B, "SHEET#y")).toMatchObject({ client: "Secret", version: 1 });
    expect(table.get(B, "PRODUCT#0123")?.stock).toBe(10);
    expect(table.get(A, "PROJECT#x")).toBeUndefined();
  });

  it("refuses an ID that tries to name a key: a '#', a prefix, or the other team's partition", async () => {
    for (const id of ["x%23y", "PROJECT%23x", "SHEET%23y", "TEAM%23team-b", "..", "a%2Fb"]) {
      for (const route of ["projects", "sheets"]) expect((await call("GET", `/teams/team-a/${route}/${id}`)).status, `${route} ${id}`).toBe(400);
    }
    expect((await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123", toProjectId: "x#y" })).status).toBe(400);
    expect((await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123", toSheetId: "TEAM#team-b" })).status).toBe(400);
  });

  it("moves a line only to a project in the path's team, whichever field names it", async () => {
    gloves();
    await call("POST", "/teams/team-a/adhoc/checkout", { operationId: op(), productKey: "0123", quantity: 1 });
    for (const field of ["toProjectId", "toSheetId"]) {
      for (const to of ["x", "y"]) expect((await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123", [field]: to })).status, `${field} ${to}`).toBe(404);
    }
    expect(table.get(B, "PROJECT#x")?.items).toEqual({});
    expect(table.get(B, "SHEET#y")?.items).toEqual({});
  });
});

describe("commands under either spelling", () => {
  beforeEach(() => gloves());

  it("checks out onto a project under PROJECT# or SHEET#, through either route, answering with both names", async () => {
    current(A, "p1");
    legacy(A, "s1");
    for (const [route, id, sk] of [["projects", "p1", "PROJECT#p1"], ["sheets", "p1", "PROJECT#p1"], ["projects", "s1", "SHEET#s1"], ["sheets", "s1", "SHEET#s1"]] as const) {
      const res = await call("POST", `/teams/team-a/${route}/${id}/checkout`, { operationId: op(), productKey: "0123", quantity: 1 });
      expect(res.status, `${route} ${id}`).toBe(200);
      expect(res.body.result).toMatchObject({ projectId: id, sheetId: id, command: "checkout" });
      expect(res.body.project).toMatchObject({ id, data: { items: { "0123": { out: expect.any(Number) } } } });
      expect(res.body.sheet).toEqual(res.body.project);
      expect(table.get(A, sk)?.type).toBe(sk.startsWith("SHEET") ? "sheet" : "project");
    }
    // Each stayed where it was
    expect(table.get(A, "SHEET#s1")?.items).toMatchObject({ "0123": { out: 2 } });
    expect(table.get(A, "PROJECT#p1")?.items).toMatchObject({ "0123": { out: 2 } });
    expect(table.get(A, "PROJECT#s1")).toBeUndefined();
    expect(table.get(A, "PRODUCT#0123")?.stock).toBe(6);
    // Return and lost on the old item, too
    expect((await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 1 })).body.result).toMatchObject({ projectId: "s1", sheetId: "s1" });
    expect(table.get(A, "SHEET#s1")?.items).toMatchObject({ "0123": { out: 2, returned: 1 } });
  });

  it("writes new movements with the new names, and lists every movement with both", async () => {
    current(A, "p1");
    await call("POST", "/teams/team-a/projects/p1/checkout", { operationId: op(), productKey: "0123", quantity: 1 });
    // One recorded before the rename
    table.put({ PK: A, SK: "MOVE#0123#2026-09-01T00:00:00.000Z#11111111-1111-4111-8111-111111111111", type: "movement", productKey: "0123", reason: "move", delta: 0, tracked: true, sheetId: "s9", fromSheetId: "adhoc-1", operationId: "11111111-1111-4111-8111-111111111111", userId: OWNER, at: "2026-09-01T00:00:00.000Z" });
    const stored = [...table.items.values()].filter((i) => String(i.SK).startsWith("MOVE#") && i.at === "2026-10-06T12:00:00.000Z");
    expect(stored).toEqual([expect.objectContaining({ projectId: "p1" })]);
    expect(stored[0]?.sheetId).toBeUndefined();
    const { body } = await call("GET", "/teams/team-a/products/0123/movements");
    expect(body.movements).toEqual([
      expect.objectContaining({ reason: "checkout", projectId: "p1", sheetId: "p1" }),
      expect.objectContaining({ reason: "move", projectId: "s9", sheetId: "s9", fromProjectId: "adhoc-1", fromSheetId: "adhoc-1" }),
    ]);
  });

  it("moves a line with toProjectId or toSheetId (or both, the same), across an old ad hoc project and a new job project", async () => {
    legacy(A, "adhoc-1", { kind: "adhoc", client: "" });
    table.put({ PK: A, SK: "ADHOC", type: "adhoc", count: 1, open: "adhoc-1", version: 1 });
    current(A, "job");
    legacy(A, "job2");
    const take = () => call("POST", "/teams/team-a/adhoc/checkout", { operationId: op(), productKey: "0123", quantity: 1 });
    expect((await take()).body.result).toMatchObject({ projectId: "adhoc-1", sheetId: "adhoc-1" });
    // The quick take added to the old ad hoc project where it is
    expect(table.get(A, "SHEET#adhoc-1")?.items).toMatchObject({ "0123": { out: 1 } });

    const moved = await call("POST", "/teams/team-a/sheets/adhoc-1/move", { operationId: op(), productKey: "0123", toProjectId: "job" });
    expect(moved.status).toBe(200);
    expect(moved.body.result).toMatchObject({ projectId: "adhoc-1", sheetId: "adhoc-1", toProjectId: "job", toSheetId: "job" });
    expect(moved.body.toProject).toMatchObject({ id: "job", data: { items: { "0123": { out: 1 } } } });
    expect(moved.body.toSheet).toEqual(moved.body.toProject);
    expect(moved.body.project).toEqual(moved.body.sheet);
    const movement = [...table.items.values()].find((i) => i.reason === "move");
    expect(movement).toMatchObject({ projectId: "job", fromProjectId: "adhoc-1" });

    await take();
    expect((await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123", toSheetId: "job2" })).status).toBe(200);
    expect(table.get(A, "SHEET#job2")?.items).toMatchObject({ "0123": { out: 1 } });
    await take();
    expect((await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123", toProjectId: "job", toSheetId: "job" })).status).toBe(200);
    expect(table.get(A, "PROJECT#job")?.items).toMatchObject({ "0123": { out: 2 } });
    await take();
    const both = await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123", toProjectId: "job", toSheetId: "job2" });
    expect(both).toMatchObject({ status: 400, body: { error: { message: "Send toProjectId (or toSheetId) once" } } });
    expect((await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123" })).status).toBe(400);
  });

  it("adds a receipt's lines to an old project in place, answering with project and sheet", async () => {
    legacy(A, "s1");
    const res = await call("POST", "/teams/team-a/projects/s1/lines", { operationId: op(), lines: [{ productKey: "k-1", quantity: 2, name: "Rags", price: 1.5 }] });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ projectId: "s1", sheetId: "s1" });
    expect(res.body.project).toMatchObject({ id: "s1", data: { items: { "k-1": { out: 2 } } } });
    expect(res.body.sheet).toEqual(res.body.project);
    expect(table.get(A, "SHEET#s1")?.items).toMatchObject({ "k-1": { out: 2 } });
  });

  it("starts a new ad hoc project under PROJECT#, stepping past a number an old one still has", async () => {
    legacy(A, "adhoc-1", { kind: "adhoc", client: "", status: "closed" });
    const res = await call("POST", "/teams/team-a/adhoc/checkout", { operationId: op(), productKey: "0123", quantity: 1 });
    expect(res.body.result).toMatchObject({ projectId: "adhoc-2", sheetId: "adhoc-2", projectCreated: true, sheetCreated: true });
    expect(table.get(A, "PROJECT#adhoc-2")).toMatchObject({ type: "project", kind: "adhoc", GSI1PK: `${A}#PROJECTS` });
    expect(table.get(A, "SHEET#adhoc-1")).toMatchObject({ status: "closed" });
  });

  it("fails a write that raced the backfill moving the project, instead of putting the old item back", async () => {
    legacy(A, "s1");
    let moved = false;
    table.afterGet = (item) => {
      if (moved || item?.SK !== "SHEET#s1") return;
      moved = true;
      // The backfill's transaction: the copy under PROJECT#, the old item gone
      table.put({ ...item, SK: "PROJECT#s1", GSI1PK: `${A}#PROJECTS`, type: "project" });
      table.delete(A, "SHEET#s1");
    };
    expect((await call("PATCH", "/teams/team-a/projects/s1", { data: { client: "Late" }, expectedVersion: 1 })).status).toBe(409);
    expect(table.get(A, "SHEET#s1")).toBeUndefined();
    expect(table.get(A, "PROJECT#s1")).toMatchObject({ client: "Echo", version: 1 });
    // Read again, it's the moved one
    expect(await call("PATCH", "/teams/team-a/projects/s1", { data: { client: "Late" }, expectedVersion: 1 })).toMatchObject({ status: 200, body: { version: 2 } });
    expect(table.get(A, "PROJECT#s1")).toMatchObject({ client: "Late" });

    // A checkout the same way: refused by its conditions on the old key, then done on the new one
    legacy(A, "s2");
    moved = false;
    table.afterGet = (item) => {
      if (moved || item?.SK !== "SHEET#s2") return;
      moved = true;
      table.put({ ...item, SK: "PROJECT#s2", GSI1PK: `${A}#PROJECTS`, type: "project" });
      table.delete(A, "SHEET#s2");
    };
    expect((await call("POST", "/teams/team-a/projects/s2/checkout", { operationId: op(), productKey: "0123", quantity: 1 })).status).toBe(200);
    expect(table.get(A, "SHEET#s2")).toBeUndefined();
    expect(table.get(A, "PROJECT#s2")?.items).toMatchObject({ "0123": { out: 1 } });
  });
});

describe("the idempotency fingerprint", () => {
  beforeEach(() => {
    gloves();
    current(A, "p1");
  });

  it("maps the old field names to the new ones, in place, and leaves anything else as it is", () => {
    const old = JSON.stringify({ command: "move", userId: "u", sheetId: "a", key: "k", toSheetId: "b" });
    const now = JSON.stringify({ command: "move", userId: "u", projectId: "a", key: "k", toProjectId: "b" });
    expect(canonicalRequest(old)).toBe(now);
    expect(canonicalRequest(now)).toBe(now);
    expect(canonicalRequest(JSON.stringify({ command: "move", userId: "u", sheetId: "a", key: "k", toSheetId: "c" }))).not.toBe(now);
    for (const odd of ["not json", "[1,2]", "null", "3"]) expect(canonicalRequest(odd)).toBe(odd);
    expect(canonicalRequest(undefined)).toBeUndefined();
  });

  it("replays an operation recorded before the rename (sheetId) for a retry after it (projectId), through either route", async () => {
    const id = op();
    const first = await call("POST", "/teams/team-a/projects/p1/checkout", { operationId: id, productKey: "0123", quantity: 2 });
    expect(first.status).toBe(200);
    // Make the record look like the old server's: the old field name, and a result with only old names
    const record = table.get(A, `OP#${id}`) as Record<string, unknown>;
    expect(record.request).toContain('"projectId":"p1"');
    const { projectId: _p, projectCreated: _c, toProjectId: _t, ...oldResult } = record.result as Record<string, unknown>;
    void _p; void _c; void _t;
    table.put({ ...record, request: String(record.request).replace('"projectId"', '"sheetId"'), result: { ...oldResult, sheetId: "p1" } });
    for (const route of ["projects", "sheets"]) {
      const retry = await call("POST", `/teams/team-a/${route}/p1/checkout`, { operationId: id, productKey: "0123", quantity: 2 });
      expect(retry, route).toMatchObject({ status: 200, body: { replayed: true, result: { projectId: "p1", sheetId: "p1", quantity: 2 } } });
    }
    expect(table.get(A, "PRODUCT#0123")?.stock).toBe(8);
    // A different request under the same ID is still refused, whatever the spelling
    expect((await call("POST", "/teams/team-a/sheets/p1/checkout", { operationId: id, productKey: "0123", quantity: 3 })).status).toBe(400);
  });

  it("replays a retry on /sheets of an operation first run on /projects, and the other way round", async () => {
    current(A, "p2");
    const a = op();
    await call("POST", "/teams/team-a/projects/p1/checkout", { operationId: a, productKey: "0123", quantity: 1 });
    expect((await call("POST", "/teams/team-a/sheets/p1/checkout", { operationId: a, productKey: "0123", quantity: 1 })).body).toMatchObject({ replayed: true });
    const b = op();
    await call("POST", "/teams/team-a/sheets/p2/checkout", { operationId: b, productKey: "0123", quantity: 1 });
    expect((await call("POST", "/teams/team-a/projects/p2/checkout", { operationId: b, productKey: "0123", quantity: 1 })).body).toMatchObject({ replayed: true });
    // The same operation ID on another project is another request
    expect((await call("POST", "/teams/team-a/projects/p2/checkout", { operationId: a, productKey: "0123", quantity: 1 })).status).toBe(400);
    expect(table.get(A, "PRODUCT#0123")?.stock).toBe(8);
  });

  it("adds whichever name a stored result lacks, and leaves other values alone", () => {
    expect(withProjectNames({ sheetId: "s", toSheetId: "t", sheetCreated: true })).toEqual({ sheetId: "s", toSheetId: "t", sheetCreated: true, projectId: "s", toProjectId: "t", projectCreated: true });
    expect(withProjectNames({ projectId: "p" })).toEqual({ projectId: "p", sheetId: "p" });
    expect(withProjectNames({ productKey: "k" })).toEqual({ productKey: "k" });
    expect(withProjectNames(null)).toBeNull();
    expect(withProjectNames("x")).toBe("x");
    const m = movementWithBothNames({ type: "movement", productKey: "k", reason: "move", delta: 0, tracked: false, projectId: "j", fromSheetId: "a", operationId: "o", userId: "u", at: "t" });
    expect(m).toMatchObject({ projectId: "j", sheetId: "j", fromProjectId: "a", fromSheetId: "a" });
  });
});

describe("the data layer's collection names and layouts", () => {
  it("treats sheets as projects, and refuses any other name", async () => {
    expect(canonicalCollection("sheets")).toBe("projects");
    expect(canonicalCollection("projects")).toBe("projects");
    expect(canonicalCollection("products")).toBe("products");
    expect(() => canonicalCollection("teams" as never)).toThrow(InvalidInputError);
    const ctx = await authorizeTeam(table.db("team-a"), OWNER, "team-a");
    current(A, "p1");
    legacy(A, "s1");
    expect((await getDocument(table.db("team-a"), ctx, "sheets", "p1"))?.id).toBe("p1");
    expect((await getDocument(table.db("team-a"), ctx, "projects", "s1"))?.id).toBe("s1");
    await expect(listDocuments(table.db("team-a"), ctx, "products", { orderBy: "date" })).rejects.toThrow(InvalidInputError);
  });

  it("names a layout by its sort key, and builds each layout's keys", () => {
    expect(layoutOf({ SK: "SHEET#a" })).toBe("sheet");
    expect(layoutOf({ SK: "PROJECT#a" })).toBe("project");
    expect(layoutOf(undefined)).toBe("project");
    expect(projectAttributes("team-a", "a", "2026-10-01", "sheet")).toEqual({ PK: A, SK: "SHEET#a", GSI1PK: `${A}#SHEETS`, GSI1SK: "2026-10-01#a", type: "sheet" });
    expect(projectAttributes("team-a", "a", "not a date", "project")).toEqual({ PK: A, SK: "PROJECT#a", GSI1PK: `${A}#PROJECTS`, GSI1SK: "#a", type: "project" });
    expect(() => projectAttributes("team-a", "a#b", "2026-10-01", "project")).toThrow(InvalidInputError);
  });
});

describe("live updates under both collection names", () => {
  const TEAM = "team-a";
  let n = 0;
  const record = (eventName: "INSERT" | "MODIFY" | "REMOVE", sk: string, version = 1): DynamoDBRecord => {
    n++;
    return {
      eventID: `e${n}`,
      eventName,
      dynamodb: {
        Keys: { PK: { S: `TEAM#${TEAM}` }, SK: { S: sk } },
        ApproximateCreationDateTime: 1_790_000_000,
        SequenceNumber: String(1000 + n),
        ...(eventName === "REMOVE" ? { OldImage: { version: { N: String(version) } } } : { NewImage: { version: { N: String(version) } } }),
      },
    } as DynamoDBRecord;
  };

  it("names projects' old collection for the second event, and products' none", () => {
    expect(LEGACY_EVENT_COLLECTIONS).toEqual({ projects: "sheets" });
  });

  it("sends a 'list' event under each name for more than COLLECTION_EVENT_AFTER project changes, counting the changes once", async () => {
    const published: Record<string, unknown>[] = [];
    const counted: Record<string, number> = {};
    const audience: Audience = { recipients: async () => ["u1"], forget: () => {} };
    const obs = {
      region: "test-local-1",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      count: (metric: string, value = 1) => {
        counted[metric] = (counted[metric] ?? 0) + value;
      },
      gauge: () => {},
      flush: () => {},
    } as unknown as Observability;
    const publish = async (_channel: string, events: readonly string[]) => {
      published.push(...events.map((e) => JSON.parse(e) as Record<string, unknown>));
      return { successful: events.map((_, i) => i), failed: [] };
    };
    // The backfill moving projects: a SHEET# REMOVE and a PROJECT# INSERT each
    const records = Array.from({ length: COLLECTION_EVENT_AFTER }, (_, i) => [record("REMOVE", `SHEET#s${i}`, 2), record("INSERT", `PROJECT#s${i}`, 2)]).flat();
    expect(await createPublisherHandler({ publish, audience, obs })({ Records: records })).toEqual({ batchItemFailures: [] });
    expect(published.map((e) => [e.v, e.collection, e.op, e.changes])).toEqual([
      [2, "projects", "list", records.length],
      [2, "sheets", "list", records.length],
    ]);
    expect(published[0]?.eventId).toBe(published[1]?.eventId);
    expect(counted).toEqual({ LiveUpdates: records.length });
  });
});
