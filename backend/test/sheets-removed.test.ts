// The sheets aliases are gone (supply-checkout-005.6.5, docs/projects-rename-plan.md,
// "Server release 2"): no `/sheets` routes, no `sheetId` fields, no second
// live-update event, and nothing reads a `SHEET#` item. Through the data API's
// handler against the in-memory table. The backfill (projects-rename.ts) is
// the only code that still names SHEET#; its tests are
// backfill-projects-rename.test.ts.

import { randomUUID } from "node:crypto";
import type { DynamoDBRecord } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { DATA_ROUTES, routeKey } from "../src/api/routes.js";
import { canonicalCollection, InvalidInputError } from "../src/data/index.js";
import type { Observability } from "../src/observability/index.js";
import type { Audience } from "../src/realtime/audience.js";
import { DOCUMENT_SK_PREFIXES } from "../src/realtime/channels.js";
import { createPublisherHandler, outgoing } from "../src/realtime/publisher-handler.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";
const A = "TEAM#team-a";
const B = "TEAM#team-b";

let table: MemoryTable;
let handler: ReturnType<typeof createDataHandler>;

beforeEach(() => {
  table = new MemoryTable();
  table.seedTeam("team-a", { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  table.seedTeam("team-b", { [OUTSIDER]: "owner" });
  const obs = {
    region: "test-local-1",
    logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} },
    count: () => {},
    gauge: () => {},
    flush: () => {},
  } as unknown as Observability;
  handler = createDataHandler({
    dbForTeam: (teamId) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(teamId)) throw new InvalidInputError("Invalid team ID");
      return table.dataDb(teamId);
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

describe("the old /sheets routes", () => {
  it("are not routes: a 404 for every method, and no route in the table names sheets", async () => {
    current(A, "p1");
    expect(DATA_ROUTES.filter((r) => /sheet/i.test(r.path)).map(routeKey)).toEqual([]);
    for (const [method, path] of [
      ["GET", "/teams/team-a/sheets"],
      ["GET", "/teams/team-a/sheets/p1"],
      ["PUT", "/teams/team-a/sheets/p2"],
      ["PATCH", "/teams/team-a/sheets/p1"],
      ["DELETE", "/teams/team-a/sheets/p1"],
      ["POST", "/teams/team-a/sheets/p1/checkout"],
      ["POST", "/teams/team-a/sheets/p1/move"],
    ] as const) {
      const res = await call(method, path, method === "PUT" ? { data: { client: "X" }, expectedVersion: 0 } : { operationId: op() });
      expect(res, `${method} ${path}`).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    }
    expect(table.get(A, "PROJECT#p2")).toBeUndefined();
    expect(table.get(A, "PROJECT#p1")).toMatchObject({ version: 1, client: "Echo" });
  });
});

describe("the old field names", () => {
  it("are refused like any other field: sheetId and toSheetId name nothing", async () => {
    current(A, "p1");
    gloves();
    for (const field of ["sheetId", "projectId"]) {
      const res = await call("POST", `/teams/team-a/projects/p1/checkout`, { operationId: op(), productKey: "0123", quantity: 1, [field]: "elsewhere" });
      expect(res, field).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    }
    await call("POST", "/teams/team-a/adhoc/checkout", { operationId: op(), productKey: "0123", quantity: 1 });
    const move = await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123", toSheetId: "p1" });
    expect(move).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    expect(table.get(A, "PRODUCT#0123")?.stock).toBe(9);
  });

  it("answer with project and toProject only, and a command's result with the new names only", async () => {
    current(A, "p1");
    gloves();
    const res = await call("POST", "/teams/team-a/projects/p1/checkout", { operationId: op(), productKey: "0123", quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({ id: "p1" });
    expect(res.body).not.toHaveProperty("sheet");
    expect(res.body.result.projectId).toBe("p1");
    expect(res.body.result).not.toHaveProperty("sheetId");
    expect(res.body.result).not.toHaveProperty("sheetCreated");
    const list = await call("GET", "/teams/team-a/products/0123/movements");
    expect(list.body.movements[0]).toMatchObject({ projectId: "p1" });
    expect(list.body.movements[0]).not.toHaveProperty("sheetId");
  });

  it("no longer match a stored request: a retry of an operation recorded with sheetId is a different request", async () => {
    current(A, "p1");
    gloves();
    const id = op();
    table.put({
      PK: A,
      SK: `OP#${id}`,
      type: "operation",
      request: JSON.stringify({ command: "checkout", sheetId: "p1", productKey: "0123", quantity: 1 }),
      result: { operationId: id, command: "checkout", sheetId: "p1", productKey: "0123", stockDelta: -1 },
    });
    const res = await call("POST", "/teams/team-a/projects/p1/checkout", { operationId: id, productKey: "0123", quantity: 1 });
    expect(res.status).toBe(400);
    expect(table.get(A, "PRODUCT#0123")?.stock).toBe(10);
  });
});

describe("a project still stored under SHEET#", () => {
  beforeEach(() => {
    current(A, "c", { date: "2026-10-03" });
    legacy(A, "old", { date: "2026-10-02", client: "Old" });
  });

  it("is not served: not by ID, not in either list, not by date", async () => {
    expect((await call("GET", "/teams/team-a/projects/old")).status).toBe(404);
    expect(ids((await call("GET", "/teams/team-a/projects")).body)).toEqual(["c"]);
    expect(ids((await call("GET", "/teams/team-a/projects", undefined, CONTRIBUTOR, { since: "2026-01-01" })).body)).toEqual(["c"]);
    expect(ids((await call("GET", "/teams/team-a/projects", undefined, CONTRIBUTOR, { limit: "1" })).body)).toEqual(["c"]);
  });

  it("is not changed, deleted or checked out onto, and is left exactly as it was", async () => {
    gloves();
    expect((await call("PATCH", "/teams/team-a/projects/old", { data: { client: "New" }, expectedVersion: 1 })).status).toBe(409);
    expect((await call("DELETE", "/teams/team-a/projects/old", undefined, CONTRIBUTOR, { expectedVersion: "1" })).status).toBe(409);
    expect((await call("POST", "/teams/team-a/projects/old/checkout", { operationId: op(), productKey: "0123", quantity: 1 })).status).toBe(404);
    expect(table.get(A, "PRODUCT#0123")?.stock).toBe(10);
    expect(table.get(A, "SHEET#old")).toMatchObject({ type: "sheet", client: "Old", version: 1 });
    expect(table.get(A, "PROJECT#old")).toBeUndefined();
  });

  it("does not stop a create under the same ID, which is a new project beside it", async () => {
    expect((await call("PUT", "/teams/team-a/projects/old", { data: { client: "Fresh", date: "2026-10-04" }, expectedVersion: 0 })).status).toBe(200);
    expect(table.get(A, "PROJECT#old")).toMatchObject({ type: "project", client: "Fresh", version: 1 });
    expect(table.get(A, "SHEET#old")).toMatchObject({ client: "Old", version: 1 });
  });
});

describe("team isolation", () => {
  beforeEach(() => {
    current(B, "x", { client: "Secret" });
    legacy(B, "y", { client: "Secret" });
    gloves(B);
  });

  it("never reaches another team's project by ID", async () => {
    for (const id of ["x", "y"]) {
      expect((await call("GET", `/teams/team-a/projects/${id}`)).status, id).toBe(404);
      // Not there in team A: the version it names isn't the (missing) one's
      expect((await call("PATCH", `/teams/team-a/projects/${id}`, { data: { client: "Mine" }, expectedVersion: 1 })).status).toBe(409);
      expect((await call("POST", `/teams/team-a/projects/${id}/checkout`, { operationId: op(), productKey: "0123", quantity: 1 })).status).toBe(404);
      // Team B's own route refuses team A's user
      expect((await call("GET", `/teams/team-b/projects/${id}`)).body.error).toMatchObject({ code: "permission_denied", reason: "not_member" });
    }
    expect(table.get(B, "PROJECT#x")).toMatchObject({ client: "Secret", version: 1 });
    expect(table.get(B, "SHEET#y")).toMatchObject({ client: "Secret", version: 1 });
    expect(table.get(B, "PRODUCT#0123")?.stock).toBe(10);
    expect(table.get(A, "PROJECT#x")).toBeUndefined();
  });

  it("refuses an ID that tries to name a key: a '#', a prefix, or the other team's partition", async () => {
    for (const id of ["x%23y", "PROJECT%23x", "SHEET%23y", "TEAM%23team-b", "..", "a%2Fb"]) {
      expect((await call("GET", `/teams/team-a/projects/${id}`)).status, id).toBe(400);
    }
    expect((await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123", toProjectId: "x#y" })).status).toBe(400);
  });

  it("moves a line only to a project in the path's team", async () => {
    gloves();
    await call("POST", "/teams/team-a/adhoc/checkout", { operationId: op(), productKey: "0123", quantity: 1 });
    for (const to of ["x", "y"]) expect((await call("POST", "/teams/team-a/projects/adhoc-1/move", { operationId: op(), productKey: "0123", toProjectId: to })).status, to).toBe(404);
    expect(table.get(B, "PROJECT#x")?.items).toEqual({});
    expect(table.get(B, "SHEET#y")?.items).toEqual({});
  });
});

describe("the data layer's collection names", () => {
  it("knows products and projects, and refuses sheets and any other name", () => {
    expect(canonicalCollection("products")).toBe("products");
    expect(canonicalCollection("projects")).toBe("projects");
    for (const name of ["sheets", "teams", ""]) expect(() => canonicalCollection(name as "projects"), name).toThrow(InvalidInputError);
  });
});

describe("live updates", () => {
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

  const run = async (records: DynamoDBRecord[]) => {
    const published: Record<string, unknown>[] = [];
    const audience: Audience = { recipients: async () => ["u1"], forget: () => {} };
    const obs = {
      region: "test-local-1",
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      count: () => {},
      gauge: () => {},
      flush: () => {},
    } as unknown as Observability;
    const publish = async (_channel: string, events: readonly string[]) => {
      published.push(...events.map((e) => JSON.parse(e) as Record<string, unknown>));
      return { successful: events.map((_, i) => i), failed: [] };
    };
    expect(await createPublisherHandler({ publish, audience, obs })({ Records: records })).toEqual({ batchItemFailures: [] });
    return published;
  };

  it("filters the stream on products and projects only", () => {
    expect([...DOCUMENT_SK_PREFIXES]).toEqual(["PRODUCT#", "PROJECT#"]);
  });

  it("publishes one event for a project change, under projects", async () => {
    const records = [record("MODIFY", "PROJECT#p1", 2)];
    expect(outgoing(records).map((e) => e.collection)).toEqual(["projects"]);
    const published = await run(records);
    expect(published.map((e) => [e.collection, e.id, e.op, e.eventId])).toEqual([["projects", "p1", "put", records[0]?.eventID]]);
  });

  it("publishes nothing for a SHEET# item, which is no longer a document", async () => {
    const records = [record("MODIFY", "SHEET#s1", 2), record("REMOVE", "SHEET#s2", 3)];
    expect(outgoing(records)).toEqual([]);
    expect(await run(records)).toEqual([]);
  });
});
