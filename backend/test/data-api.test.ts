// The data API's handler against an in-memory table (memory-table.ts): the
// document semantics the app relies on (src/main.js, tests/mock-claude.js),
// and the negative tests for team isolation. test/documents.test.ts runs the
// same document functions against DynamoDB Local in CI.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDataHandler, type DataEvent, sheetMovement } from "../src/api/data-handler.js";
import { DATA_ROUTES, routeKey } from "../src/api/routes.js";
import type { DbForTeam } from "../src/api/team-db.js";
import { deleteDocument, InvalidInputError, MAX_DOCUMENT_BYTES } from "../src/data/index.js";
import type { Observability } from "../src/observability/index.js";
import { contextFor, REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";

let table: MemoryTable;
let counts: Record<string, number>;
let handler: ReturnType<typeof createDataHandler>;

function fakeObservability(): Observability {
  counts = {};
  return {
    region: "test-local-1",
    logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1) => {
      counts[metric] = (counts[metric] ?? 0) + value;
    },
    gauge: () => {},
    flush: () => {},
  };
}

beforeEach(() => {
  table = new MemoryTable();
  table.seedTeam("team-a", { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  table.seedTeam("team-b", { [OUTSIDER]: "owner" });
  // Like teamScopedDbs: one handle per team, allowed only that team's partitions
  const dbForTeam: DbForTeam = (teamId) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(teamId)) throw new InvalidInputError("Invalid team ID");
    return table.db(teamId);
  };
  handler = createDataHandler({ dbForTeam, obs: fakeObservability(), now: () => NOW });
});

interface Request {
  readonly user?: string | null;
  readonly claims?: Record<string, unknown>;
  readonly query?: Record<string, string>;
  readonly body?: unknown;
  readonly rawBody?: string;
  /** Send a write as is. Otherwise a write without expectedVersion gets the stored one. */
  readonly unversioned?: boolean;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** An HTTP API (payload 2.0) event as API Gateway would send it after the JWT authorizer. */
function event(method: string, path: string, request: Request = {}): DataEvent {
  const segments = path.split("/");
  const route = DATA_ROUTES.find((r) => {
    const parts = r.path.split("/");
    return r.method === method && parts.length === segments.length && parts.every((p, i) => p.startsWith("{") || p === segments[i]);
  });
  const user = request.user === undefined ? OWNER : request.user;
  const claims = request.claims ?? { sub: user, token_use: "access", exp: String(NOW / 1000 + 600), client_id: "web" };
  const pathParameters: Record<string, string> = {};
  route?.path.split("/").forEach((p, i) => {
    if (p.startsWith("{")) pathParameters[p.slice(1, -1)] = safeDecode(segments[i] as string);
  });
  const body = request.rawBody ?? (request.body === undefined ? undefined : JSON.stringify(request.body));
  return {
    version: "2.0",
    routeKey: route ? routeKey(route) : `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: {},
    queryStringParameters: request.query,
    pathParameters,
    body,
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: user === null ? undefined : { principalId: "", integrationLatency: 0, jwt: { claims, scopes: null } },
    },
  } as unknown as DataEvent;
}

const WRITES = ["PUT", "PATCH", "DELETE"];

/** The stored version of the document at `path` (0 if there's none), read from the table. */
function storedVersion(path: string): number {
  const [, , team, collection, id] = path.split("/");
  const sk = `${collection === "products" ? "PRODUCT" : "SHEET"}#${safeDecode(id ?? "")}`;
  const version = table.get(`TEAM#${team}`, sk)?.version;
  return typeof version === "number" ? version : 0;
}

/**
 * Every write needs an expected version (ADR 0006). Most tests are about something else,
 * so a write that doesn't name one is sent with the stored version, as the app would.
 */
function versioned(method: string, path: string, request: Request): Request {
  if (request.unversioned || !WRITES.includes(method) || request.rawBody !== undefined) return request;
  if (method === "DELETE") return request.query?.expectedVersion === undefined ? { ...request, query: { ...request.query, expectedVersion: String(storedVersion(path)) } } : request;
  const body = request.body;
  if (typeof body !== "object" || body === null || Array.isArray(body) || "expectedVersion" in body) return request;
  return { ...request, body: { ...body, expectedVersion: storedVersion(path) } };
}

async function call(method: string, path: string, request: Request = {}) {
  const response = await handler(event(method, path, versioned(method, path, request)));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const product = { code: "0123", name: "Nitrile gloves", price: 12.5, updatedAt: "2026-09-26T00:00:00.000Z" };
const sheet = (date: string, items: Record<string, unknown> = {}) => ({ client: "Echo", date, createdBy: OWNER, status: "open", items });

describe("documents (the app's db contract)", () => {
  it("sets, gets and lists products, with a version on every write", async () => {
    expect(await call("PUT", "/teams/team-a/products/0123", { body: { data: product } })).toEqual({
      status: 200,
      body: { id: "0123", version: 1, data: product },
    });
    expect((await call("PUT", "/teams/team-a/products/0123", { body: { data: { ...product, price: 13 } } })).body.version).toBe(2);
    expect(await call("GET", "/teams/team-a/products/0123")).toEqual({ status: 200, body: { id: "0123", version: 2, data: { ...product, price: 13 } } });
    await call("PUT", "/teams/team-a/products/nb-1", { body: { data: { code: "", name: "Rags", price: 1 } } });
    const list = await call("GET", "/teams/team-a/products");
    expect(list.status).toBe(200);
    expect(list.body.documents.map((d: { id: string }) => d.id)).toEqual(["0123", "nb-1"]);
    expect(list.body.cursor).toBeUndefined();
    // The stored item has the key attributes; the document never shows them
    expect(table.get("TEAM#team-a", "PRODUCT#0123")).toMatchObject({ type: "product", key: "0123", version: 2, price: 13 });
  });

  it("replaces the whole document on set, except a product's stock", async () => {
    await call("PUT", "/teams/team-a/products/0123", { body: { data: { ...product, cost: 9 } } });
    const { body } = await call("PUT", "/teams/team-a/products/0123", { body: { data: { code: "0123", name: "Gloves" } } });
    expect(body.data).toEqual({ code: "0123", name: "Gloves" });
  });

  describe("a product's stock, which only the stock commands change", () => {
    const stored = () => table.get("TEAM#team-a", "PRODUCT#0123");
    beforeEach(async () => {
      await call("PUT", "/teams/team-a/products/0123", { body: { data: product } });
      table.put({ ...(stored() as Record<string, unknown>), stock: 7 });
    });
    const refused = { status: 400, body: { error: { code: "bad_request", message: "Stock changes only through the stock command (POST /teams/{teamId}/products/{key}/stock)" } } };

    it("keeps the stored stock through a PUT or PATCH that leaves it out", async () => {
      expect((await call("PUT", "/teams/team-a/products/0123", { body: { data: { ...product, name: "Gloves" } } })).body).toEqual({ id: "0123", version: 2, data: { ...product, name: "Gloves", stock: 7 } });
      expect((await call("PATCH", "/teams/team-a/products/0123", { body: { data: { price: 13 } } })).body).toEqual({ id: "0123", version: 3, data: { ...product, name: "Gloves", price: 13, stock: 7 } });
      expect(stored()).toMatchObject({ version: 3, stock: 7 });
    });

    it("takes a body that repeats the stored stock", async () => {
      expect((await call("PUT", "/teams/team-a/products/0123", { body: { data: { ...product, stock: 7 } } })).body.data.stock).toBe(7);
      expect((await call("PATCH", "/teams/team-a/products/0123", { body: { data: { stock: 7 } } })).body).toMatchObject({ version: 3, data: { stock: 7 } });
    });

    it("refuses, with nothing written, a PUT or PATCH whose stock differs from what's stored", async () => {
      for (const [method, data] of [
        ["PUT", { ...product, stock: 8 }],
        ["PUT", { ...product, stock: 0 }],
        ["PATCH", { stock: 6 }],
        ["PATCH", { stock: 7.5 }],
      ] as const) {
        expect(await call(method, "/teams/team-a/products/0123", { body: { data } })).toEqual(refused);
      }
      expect(stored()).toMatchObject({ version: 1, stock: 7 });
    });

    it("refuses stock on a new product and on one that doesn't track stock, which start counting with the stock command", async () => {
      expect(await call("PUT", "/teams/team-a/products/0456", { body: { data: { ...product, code: "0456", stock: 3 } } })).toEqual(refused);
      expect(table.get("TEAM#team-a", "PRODUCT#0456")).toBeUndefined();
      await call("PUT", "/teams/team-a/products/0456", { body: { data: { ...product, code: "0456" } } });
      expect(await call("PATCH", "/teams/team-a/products/0456", { body: { data: { stock: 3 } } })).toEqual(refused);
      expect(await call("PUT", "/teams/team-a/products/0456", { body: { data: { ...product, code: "0456", stock: 0 } } })).toEqual(refused);
      expect(table.get("TEAM#team-a", "PRODUCT#0456")).toMatchObject({ version: 1 });
      expect(table.get("TEAM#team-a", "PRODUCT#0456")?.stock).toBeUndefined();
    });

    it("drops a stored stock that isn't a number (legacy), so the item can still be edited and stays untracked", async () => {
      for (const legacy of ["7", null, { n: 7 }]) {
        table.put({ ...(stored() as Record<string, unknown>), stock: legacy });
        // A PUT that leaves stock out, or repeats what a GET returned
        const got = (await call("GET", "/teams/team-a/products/0123")).body.data;
        expect(got.stock).toEqual(legacy);
        const put = await call("PUT", "/teams/team-a/products/0123", { body: { data: { ...got, name: "Gloves" } } });
        expect(put.status).toBe(200);
        expect(put.body.data).not.toHaveProperty("stock");
        table.put({ ...(stored() as Record<string, unknown>), stock: legacy });
        const patch = await call("PATCH", "/teams/team-a/products/0123", { body: { data: { price: 13 } } });
        expect(patch.status).toBe(200);
        expect(patch.body.data).not.toHaveProperty("stock");
        expect(stored()).not.toHaveProperty("stock");
        // It isn't a count to change, either
        table.put({ ...(stored() as Record<string, unknown>), stock: legacy });
        expect(await call("PATCH", "/teams/team-a/products/0123", { body: { data: { stock: 3 } } })).toEqual(refused);
      }
    });

    it("records a delete movement taking stock to 0, so a product made again under the key starts from 0", async () => {
      const moves = () => [...table.items.values()].filter((i) => String(i.SK).startsWith("MOVE#"));
      expect((await call("DELETE", "/teams/team-a/products/0123")).status).toBe(204);
      expect(stored()).toBeUndefined();
      expect(moves()).toEqual([
        expect.objectContaining({ type: "movement", productKey: "0123", reason: "delete", delta: -7, tracked: true, count: 0, userId: OWNER }),
      ]);
      expect((await call("GET", "/teams/team-a/products/0123/movements")).body.movements).toEqual([expect.objectContaining({ reason: "delete", delta: -7 })]);
      // Made again, it doesn't track stock, and a count adds up from the history
      expect((await call("PUT", "/teams/team-a/products/0123", { body: { data: product } })).body.data).toEqual(product);
      expect(stored()).not.toHaveProperty("stock");
      const counted = await call("POST", "/teams/team-a/products/0123/stock", { body: { operationId: "00000000-0000-4000-8000-000000000001", reason: "count", count: 4 } });
      expect(counted.status).toBe(200);
      // The history adds up to the change since the stock of 7 it started from: 7 - 7 + 4
      expect(stored()).toMatchObject({ stock: 4 });
      expect(7 + moves().reduce((sum, m) => sum + (m.delta as number), 0)).toBe(4);
      // A product that doesn't track stock is deleted without one
      await call("PUT", "/teams/team-a/products/0456", { body: { data: { ...product, code: "0456" } } });
      expect((await call("DELETE", "/teams/team-a/products/0456")).status).toBe(204);
      expect(moves()).toHaveLength(2);
      // Deleting one that isn't there still succeeds, and records nothing
      expect((await call("DELETE", "/teams/team-a/products/0456", { query: { expectedVersion: "0" } })).status).toBe(204);
      expect(moves()).toHaveLength(2);
    });

    it("answers 409 and deletes nothing when stock moves between a delete's read and its write", async () => {
      table.afterGet = (item) => {
        if (item?.SK !== "PRODUCT#0123") return;
        table.afterGet = undefined;
        table.put({ ...item, stock: 9 });
      };
      expect((await call("DELETE", "/teams/team-a/products/0123")).status).toBe(409);
      expect(stored()).toMatchObject({ stock: 9 });
      expect([...table.items.values()].filter((i) => String(i.SK).startsWith("MOVE#"))).toEqual([]);
    });

    it("retries a delete without an expected version on the fresh product (backend callers)", async () => {
      table.afterGet = (item) => {
        if (item?.SK !== "PRODUCT#0123") return;
        table.afterGet = undefined;
        table.put({ ...item, stock: 9, version: 2 });
      };
      const ctx = await contextFor("owner", REGION, "team-a", OWNER);
      expect((await deleteDocument(table.db("team-a"), ctx, "products", "0123")).before).toMatchObject({ version: 2, data: { stock: 9 } });
      expect(stored()).toBeUndefined();
      expect([...table.items.values()].filter((i) => String(i.SK).startsWith("MOVE#"))).toEqual([expect.objectContaining({ reason: "delete", delta: -9 })]);
    });

    it("leaves sheets alone: a field called stock is only data there", async () => {
      expect((await call("PUT", "/teams/team-a/sheets/s1", { body: { data: { ...sheet("2026-09-01"), stock: 3 } } })).body.data.stock).toBe(3);
      expect((await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { stock: 4 } } })).body.data.stock).toBe(4);
    });
  });

  it("deep-merges nested maps on update, as the app's runtime does", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01", { a: { code: "A", name: "Gloves", price: 2, out: 3, returned: 0 } }) } });
    // A return: one field of one line
    let { body } = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { a: { returned: 2 } } } } });
    expect(body.data.items.a).toEqual({ code: "A", name: "Gloves", price: 2, out: 3, returned: 2 });
    // A new line leaves the others alone
    ({ body } = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { b: { name: "Rags", out: 1, returned: 0 } } } } }));
    expect(Object.keys(body.data.items)).toEqual(["a", "b"]);
    // Top-level fields merge too, and a non-map value replaces
    ({ body } = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { status: "closed", closedAt: "2026-09-02T00:00:00Z", items: { b: null } } } }));
    expect(body).toMatchObject({ version: 4, data: { client: "Echo", status: "closed", closedAt: "2026-09-02T00:00:00Z", items: { b: null } } });
    expect(body.data.items.a.returned).toBe(2);
    await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { tags: ["x"] } } });
    ({ body } = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { tags: ["y"] } } }));
    expect(body.data.tags).toEqual(["y"]);
  });

  it("keeps each sheet line's barcode through PUT and PATCH", async () => {
    const gloves = { code: "0123", name: "Gloves", price: 2, out: 3, returned: 0 };
    expect((await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01", { "0123": gloves }) } })).body.data.items["0123"]).toEqual(gloves);
    // checkoutModal: the whole line, with its code
    await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { "0123": { ...gloves, out: 5 } } } } });
    // The line edit: out, returned and price only
    await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { "0123": { out: 5, returned: 1, price: 3 } } } } });
    const { body } = await call("GET", "/teams/team-a/sheets/s1");
    expect(body.data.items["0123"]).toEqual({ code: "0123", name: "Gloves", price: 3, out: 5, returned: 1 });
  });

  it("keeps each sheet line's cost, and refuses one that isn't an amount in whole cents (ADR 0014)", async () => {
    // A receipt's client items go on the sheet with the receipt's cost each
    const towels = { code: "", name: "Towels", price: 3, cost: 2.25, out: 2, returned: 0 };
    expect((await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01", { "nb-1": towels }) } })).body.data.items["nb-1"]).toEqual(towels);
    await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { "nb-1": { out: 3 }, "nb-2": { ...towels, cost: 1_000_000 } } } } });
    const { body } = await call("GET", "/teams/team-a/sheets/s1");
    expect(body.data.items).toEqual({ "nb-1": { ...towels, out: 3 }, "nb-2": { ...towels, cost: 1_000_000 } });
    for (const cost of [-1, "2.25", 2.255, 1_000_000.01, null]) {
      const put = await call("PUT", "/teams/team-a/sheets/s2", { body: { data: sheet("2026-09-01", { a: { ...towels, cost } }) } });
      expect(put.body.error.code).toBe("bad_request");
      const patch = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { "nb-1": { cost } } } } });
      expect(patch.body.error.code).toBe("bad_request");
    }
    expect((await call("GET", "/teams/team-a/sheets/s1")).body.data.items["nb-1"].cost).toBe(2.25);
  });

  it("refuses a line price that isn't an amount in whole cents (ADR 0014)", async () => {
    const rags = { code: "", name: "Rags", price: 1.5, out: 2, returned: 0 };
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01", { "nb-1": rags }) } });
    for (const price of [-1, "1.50", 1.505, 1_000_000.01, null]) {
      expect((await call("PUT", "/teams/team-a/sheets/s2", { body: { data: sheet("2026-09-01", { a: { ...rags, price } }) } })).body.error.code).toBe("bad_request");
      expect((await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { "nb-1": { price } } } } })).body.error.code).toBe("bad_request");
    }
    expect((await call("GET", "/teams/team-a/sheets/s1")).body.data.items["nb-1"]).toEqual(rags);
  });

  it("checks a product's price and cost with the money rule, like a sheet line's (ADR 0014)", async () => {
    for (const money of [{ price: 1.234 }, { price: -1 }, { price: "3" }, { price: null }, { price: 1_000_001 }, { cost: 0.001 }, { cost: -0.5 }, { cost: "2" }]) {
      const res = await call("PUT", "/teams/team-a/products/p1", { body: { data: { ...product, ...money } } });
      expect(res.body.error?.code, JSON.stringify(money)).toBe("bad_request");
    }
    expect(table.get("TEAM#team-a", "PRODUCT#p1")).toBeUndefined();
    // Whole cents, and no price or cost at all, save
    expect((await call("PUT", "/teams/team-a/products/p1", { body: { data: { ...product, price: 0, cost: 1_000_000 } } })).status).toBe(200);
    expect((await call("PUT", "/teams/team-a/products/p2", { body: { data: { code: "p2", name: "Rags" } } })).status).toBe(200);
    expect((await call("PATCH", "/teams/team-a/products/p1", { body: { data: { price: 2.5, cost: 1.25 } } })).body.data).toMatchObject({ price: 2.5, cost: 1.25 });
    expect((await call("PATCH", "/teams/team-a/products/p1", { body: { data: { cost: 1.255 } } })).body.error.code).toBe("bad_request");
  });

  it("saves a product holding legacy money the write doesn't change, rounding it to cents (ADR 0014)", async () => {
    // Written before the money rule: a price and cost with three decimals
    const legacy = { ...product, price: 2.345, cost: 1.005 };
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#p1", type: "product", key: "p1", version: 1, ...legacy });
    // A PATCH to another field saves, rounding them
    const patch = await call("PATCH", "/teams/team-a/products/p1", { body: { data: { name: "Gloves" } } });
    expect(patch.status).toBe(200);
    expect(patch.body.data).toMatchObject({ name: "Gloves", price: 2.35, cost: 1.01 });
    expect(table.get("TEAM#team-a", "PRODUCT#p1")).toMatchObject({ version: 2, price: 2.35, cost: 1.01 });
    // So does a PUT that repeats them as they were stored
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#p1", type: "product", key: "p1", version: 3, ...legacy });
    expect((await call("PUT", "/teams/team-a/products/p1", { body: { data: { ...legacy, name: "Gloves" } } })).status).toBe(200);
    expect(table.get("TEAM#team-a", "PRODUCT#p1")).toMatchObject({ version: 4, name: "Gloves", price: 2.35, cost: 1.01 });
    // One that isn't an amount at all is kept as it is
    const odd = { ...product, price: "3", cost: -2 };
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#p1", type: "product", key: "p1", version: 5, ...odd });
    expect((await call("PATCH", "/teams/team-a/products/p1", { body: { data: { name: "Tape" } } })).body.data).toMatchObject({ name: "Tape", price: "3", cost: -2 });
    // A write that changes the money must follow the rule, legacy or not
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#p1", type: "product", key: "p1", version: 7, ...legacy });
    for (const data of [{ price: 2.344 }, { cost: 1.006 }, { price: "4" }]) {
      expect((await call("PATCH", "/teams/team-a/products/p1", { body: { data } })).body.error.code, JSON.stringify(data)).toBe("bad_request");
    }
    expect(table.get("TEAM#team-a", "PRODUCT#p1")).toMatchObject({ version: 7, price: 2.345, cost: 1.005 });
    // Correcting it saves
    expect((await call("PATCH", "/teams/team-a/products/p1", { body: { data: { price: 2.34 } } })).body.data).toMatchObject({ price: 2.34, cost: 1.01 });
  });

  it("saves a sheet holding legacy money on a line the write doesn't change, rounding it to cents (ADR 0014)", async () => {
    // Written before the money rule: a price and cost with three decimals, and one that isn't an amount
    const legacy = { code: "A", name: "Gloves", price: 2.345, cost: 1.005, out: 2, returned: 0 };
    const odd = { code: "B", name: "Tape", price: "3", cost: -2, out: 1, returned: 0 };
    table.put({ PK: "TEAM#team-a", SK: "SHEET#s1", type: "sheet", id: "s1", version: 1, ...sheet("2026-09-01", { a: legacy, b: odd }) });
    // A PATCH to another line saves
    const patch = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { c: { code: "C", name: "Rags", price: 1, out: 1, returned: 0 } } } } });
    expect(patch.status).toBe(200);
    expect(patch.body.data.items.a).toEqual({ ...legacy, price: 2.35, cost: 1.01 });
    expect(patch.body.data.items.b).toEqual(odd);
    // So does a PUT that repeats a legacy line as it was stored
    table.put({ PK: "TEAM#team-a", SK: "SHEET#s1", type: "sheet", id: "s1", version: 3, ...sheet("2026-09-01", { a: legacy, b: odd }) });
    const put = await call("PUT", "/teams/team-a/sheets/s1", { body: { data: { ...sheet("2026-09-01", { a: legacy, b: odd }), client: "Echo Ltd" } } });
    expect(put.status).toBe(200);
    expect(table.get("TEAM#team-a", "SHEET#s1")).toMatchObject({ version: 4, client: "Echo Ltd", items: { a: { price: 2.35, cost: 1.01 }, b: odd } });
    // A write that changes a line's money must follow the rule, legacy or not
    table.put({ PK: "TEAM#team-a", SK: "SHEET#s1", type: "sheet", id: "s1", version: 5, ...sheet("2026-09-01", { a: legacy, b: odd }) });
    for (const items of [{ a: { cost: 1.006 } }, { a: { price: 2.344 } }, { b: { price: "4" } }, { b: { cost: -3 } }, { d: { ...legacy } }]) {
      expect((await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items } } })).body.error.code, JSON.stringify(items)).toBe("bad_request");
    }
    expect(table.get("TEAM#team-a", "SHEET#s1")).toMatchObject({ version: 5, items: { a: legacy, b: odd } });
    // Correcting it saves
    expect((await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { a: { cost: 1 }, b: { price: 3, cost: 0 } } } } })).body.data.items).toMatchObject({ a: { price: 2.35, cost: 1 }, b: { price: 3, cost: 0 } });
  });

  it("keeps every other field the app writes on sheets and products", async () => {
    // The receipt save and the new-sheet form, without a signed-in user
    const receiptSheet = {
      client: "Echo",
      date: "2026-09-01",
      createdBy: null,
      createdByName: "Dana",
      createdAt: "2026-09-01T10:00:00.000Z",
      status: "open",
      items: { "nb-1": { code: "", name: "Rags", price: 1, out: 2, returned: 0 } },
      source: { store: "Hardware Co", receiptDate: "2026-08-31" },
    };
    expect((await call("PUT", "/teams/team-a/sheets/s1", { body: { data: receiptSheet } })).body.data).toEqual(receiptSheet);
    await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { status: "closed", closedAt: "2026-09-02T00:00:00.000Z" } } });
    expect((await call("GET", "/teams/team-a/sheets/s1")).body.data).toEqual({ ...receiptSheet, status: "closed", closedAt: "2026-09-02T00:00:00.000Z" });
    const full = { ...product, cost: 9, packSize: 12, notes: "Blue box" };
    expect((await call("PUT", "/teams/team-a/products/0123", { body: { data: full } })).body.data).toEqual(full);
    expect((await call("PATCH", "/teams/team-a/products/0123", { body: { data: { cost: 8 } } })).body.data).toEqual({ ...full, cost: 8 });
  });

  it("refuses to update a document that doesn't exist", async () => {
    expect(await call("PATCH", "/teams/team-a/sheets/nope", { body: { data: { status: "open" } } })).toMatchObject({
      status: 404,
      body: { error: { code: "not_found" } },
    });
    expect(table.get("TEAM#team-a", "SHEET#nope")).toBeUndefined();
  });

  it("answers 404 for a missing document, and deletes idempotently", async () => {
    expect((await call("GET", "/teams/team-a/sheets/s1")).status).toBe(404);
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01") } });
    expect(await call("DELETE", "/teams/team-a/sheets/s1")).toEqual({ status: 204, body: undefined });
    expect((await call("GET", "/teams/team-a/sheets/s1")).status).toBe(404);
    expect((await call("DELETE", "/teams/team-a/sheets/s1")).status).toBe(204);
  });

  it("lists sheets newest first by date, undated sheets last", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01") } });
    await call("PUT", "/teams/team-a/sheets/s2", { body: { data: sheet("2026-09-20") } });
    await call("PUT", "/teams/team-a/sheets/s3", { body: { data: { client: "Old", status: "open" } } });
    await call("PUT", "/teams/team-a/sheets/s4", { body: { data: sheet("2026-09-10") } });
    const ids = async (query: Record<string, string>) => (await call("GET", "/teams/team-a/sheets", { query })).body.documents.map((d: { id: string }) => d.id);
    expect(await ids({ orderBy: "date", direction: "desc" })).toEqual(["s2", "s4", "s1", "s3"]);
    expect(await ids({ orderBy: "date" })).toEqual(["s3", "s1", "s4", "s2"]);
    expect(await ids({})).toEqual(["s1", "s2", "s3", "s4"]);
    // Changing the date moves the sheet
    await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { date: "2026-09-30" } } });
    expect(await ids({ orderBy: "date", direction: "desc" })).toEqual(["s1", "s2", "s4", "s3"]);
  });

  it("pages with limit and an opaque cursor", async () => {
    for (const id of ["s1", "s2", "s3"]) await call("PUT", `/teams/team-a/sheets/${id}`, { body: { data: sheet("2026-09-01") } });
    const first = await call("GET", "/teams/team-a/sheets", { query: { limit: "2" } });
    expect(first.body.documents).toHaveLength(2);
    expect(first.body.cursor).toEqual(expect.any(String));
    const second = await call("GET", "/teams/team-a/sheets", { query: { limit: "2", cursor: first.body.cursor } });
    expect(second.body.documents.map((d: { id: string }) => d.id)).toEqual(["s3"]);
    expect(second.body.cursor).toBeUndefined();
  });

  it("round-trips product keys with any characters the app's keyOf makes, and more", async () => {
    for (const key of ["a.b~c:d@e+f", "50%off", "x..", "with space"]) {
      const path = `/teams/team-a/products/${encodeURIComponent(key)}`;
      expect((await call("PUT", path, { body: { data: product } })).body.id).toBe(key);
      expect((await call("GET", path)).body.id).toBe(key);
    }
    expect((await call("GET", "/teams/team-a/products/a%2Fb")).status).toBe(400);
    expect((await call("GET", "/teams/team-a/products/%E0%A4%A")).status).toBe(400);
  });

  it("applies an expected version, and counts the conflict", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01"), expectedVersion: 0 } });
    expect((await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-02"), expectedVersion: 0 } })).body.error.code).toBe("aborted");
    expect(await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { client: "X" }, expectedVersion: 1 } })).toMatchObject({ status: 200, body: { version: 2 } });
    const stale = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { client: "Y" }, expectedVersion: 1 } });
    expect(stale).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect((await call("DELETE", "/teams/team-a/sheets/s1", { query: { expectedVersion: "1" } })).status).toBe(409);
    expect((await call("DELETE", "/teams/team-a/sheets/s1", { query: { expectedVersion: "2" } })).status).toBe(204);
    expect(counts.ConditionalWriteConflicts).toBe(3);
    expect((await call("DELETE", "/teams/team-a/sheets/s1", { query: { expectedVersion: "x" } })).status).toBe(400);
  });

  it("refuses a write without an expected version", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01") } });
    const required = { status: 400, body: { error: { code: "bad_request", message: "expectedVersion is required" } } };
    expect(await call("PUT", "/teams/team-a/sheets/s2", { unversioned: true, body: { data: sheet("2026-09-01") } })).toEqual(required);
    expect(await call("PUT", "/teams/team-a/sheets/s1", { unversioned: true, body: { data: sheet("2026-09-02") } })).toEqual(required);
    expect(await call("PATCH", "/teams/team-a/sheets/s1", { unversioned: true, body: { data: { client: "X" } } })).toEqual(required);
    expect(await call("DELETE", "/teams/team-a/sheets/s1", { unversioned: true })).toEqual(required);
    expect(await call("DELETE", "/teams/team-a/sheets/s1", { unversioned: true, query: { other: "1" } })).toEqual(required);
    // Nothing was written
    expect(table.get("TEAM#team-a", "SHEET#s1")).toMatchObject({ client: "Echo", date: "2026-09-01", version: 1 });
    expect(table.get("TEAM#team-a", "SHEET#s2")).toBeUndefined();
    // Membership and role are still checked first: another team's route is refused as before
    expect((await call("PATCH", "/teams/team-b/sheets/b1", { unversioned: true, body: { data: { client: "X" } } })).body.error.code).toBe("permission_denied");
    expect((await call("DELETE", "/teams/team-a/sheets/s1", { unversioned: true, user: VIEWER })).body.error).toMatchObject({ code: "permission_denied", reason: "view_only" });
  });

  it("answers 409 when another write lands between the read and the put, without retrying", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01", { a: { out: 1, returned: 0 } }) } });
    let raced = 0;
    table.afterGet = (item) => {
      if (raced++ || !item) return;
      // Another user's write lands between our read and our put
      table.put({ ...item, version: 2, items: { a: { out: 1, returned: 0 }, b: { out: 5, returned: 0 } } });
    };
    const lost = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { a: { returned: 1 } } }, expectedVersion: 1 } });
    expect(lost).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(raced).toBe(1);
    // The other user's write stands; ours can be made again on their version
    expect(table.get("TEAM#team-a", "SHEET#s1")).toMatchObject({ version: 2, items: { a: { out: 1, returned: 0 }, b: { out: 5, returned: 0 } } });
    const { body } = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { a: { returned: 1 } } }, expectedVersion: 2 } });
    expect(body).toMatchObject({ version: 3, data: { items: { a: { out: 1, returned: 1 }, b: { out: 5, returned: 0 } } } });
  });

  it("never loses a count when two people check out the same line at once", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01", { a: { out: 2, returned: 0 } }) } });
    // Both read version 1 with 2 taken, and each adds their own to it, as the app does
    const [first, second] = await Promise.all([
      call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { a: { out: 3 } } }, expectedVersion: 1 } }),
      call("PATCH", "/teams/team-a/sheets/s1", { user: CONTRIBUTOR, body: { data: { items: { a: { out: 5 } } }, expectedVersion: 1 } }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    // The loser reads the latest and adds to it
    const latest = (await call("GET", "/teams/team-a/sheets/s1")).body;
    const add = first.status === 409 ? 1 : 3;
    const retry = await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { a: { out: latest.data.items.a.out + add } } }, expectedVersion: latest.version } });
    expect(retry.body).toMatchObject({ version: 3, data: { items: { a: { out: 6 } } } });
  });

  it("rejects malformed input with bad_request, which the app doesn't mistake for view-only", async () => {
    const bad = async (method: string, path: string, request: Request) => (await call(method, path, request)).body.error.code;
    expect(await bad("PUT", "/teams/team-a/products/p", { rawBody: "{not json" })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/products/p", { body: [product] })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/products/p", { body: product })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/products/p", { body: { data: "text" } })).toBe("bad_request");
    expect(await bad("PATCH", "/teams/team-a/products/p", { body: { data: [1] } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/products/p", { body: { data: { ...product, version: 9 } } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/products/p", { body: { data: { ...product, stock: "4" } } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/sheets/s1", { body: { data: { date: 20260901 } } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/sheets/s1", { body: { data: { items: [] } } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01", { a: { code: "1".repeat(257) } }) } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01", { a: { code: 123 } }) } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/products/p", { body: { data: { ...product, code: "1".repeat(257) } } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/products/p", { body: { data: { ...product, code: null } } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/sheets/s#1", { body: { data: sheet("2026-09-01") } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/sheets/s1", { body: { data: { a: { "": 1 } } } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/sheets/s1", { rawBody: '{"data":{"__proto__":{"x":1}}}' })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/sheets/s1", { body: { data: { n: 1e200 } } })).toBe("bad_request");
    let deep: unknown = 1;
    for (let i = 0; i < 20; i++) deep = { deep };
    expect(await bad("PUT", "/teams/team-a/sheets/s1", { body: { data: { deep } } })).toBe("bad_request");
    expect(await bad("GET", "/teams/team-a/products", { query: { orderBy: "date" } })).toBe("bad_request");
    expect(await bad("GET", "/teams/team-a/sheets", { query: { orderBy: "client" } })).toBe("bad_request");
    expect(await bad("GET", "/teams/team-a/sheets", { query: { direction: "desc" } })).toBe("bad_request");
    expect(await bad("GET", "/teams/team-a/sheets", { query: { orderBy: "date", direction: "up" } })).toBe("bad_request");
    expect(await bad("GET", "/teams/team-a/sheets", { query: { limit: "0" } })).toBe("bad_request");
    expect(await bad("GET", "/teams/team-a/sheets", { query: { limit: "ten" } })).toBe("bad_request");
    expect(await bad("GET", "/teams/team-a/sheets", { query: { cursor: "not-a-cursor" } })).toBe("bad_request");
    expect(await bad("PUT", "/teams/team-a/sheets/s1", { body: { data: {}, expectedVersion: -1 } })).toBe("bad_request");
  });

  it("answers 400, not 500, for a body nested far too deeply", async () => {
    const depth = 200_000;
    const rawBody = `{"expectedVersion":0,"data":{"a":${"[".repeat(depth)}${"]".repeat(depth)}}}`;
    for (const method of ["PUT", "PATCH"]) {
      const response = await call(method, "/teams/team-a/sheets/s1", { rawBody });
      expect(response, method).toMatchObject({ status: 400, body: { error: { code: "bad_request", message: "Document is nested too deeply" } } });
    }
  });

  it("never lets a document write set the index keys", async () => {
    for (const field of ["GSI1PK", "GSI1SK"]) {
      const data = { ...sheet("2026-09-01"), [field]: "TEAM#team-b#SHEETS" };
      expect((await call("PUT", "/teams/team-a/sheets/s1", { body: { data } })).status, field).toBe(400);
    }
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01") } });
    expect((await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { GSI1SK: "9999-12-31#x" } } })).status).toBe(400);
    expect((await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { GSI1PK: "TEAM#team-b#SHEETS" } } })).status).toBe(400);
    expect(table.get("TEAM#team-a", "SHEET#s1")).toMatchObject({ GSI1PK: "TEAM#team-a#SHEETS", GSI1SK: "2026-09-01#s1" });
  });

  it("never lets a document put itself in the operators' index (GSI3) or any other index, by PUT or PATCH", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01"), expectedVersion: 0 } });
    const forged = [
      { GSI3PK: "OPS#TEAMS", GSI3SK: "9999-12-31T00:00:00.000Z#forged", name: "Forged team", plan: "enterprise" },
      { GSI3PK: "OPS#AUDIT#2026-09" },
      { GSI3SK: "x" },
      { GSI9PK: "OPS#TEAMS" },
      { GSI12SK: "x" },
    ];
    for (const extra of forged) {
      expect((await call("PUT", "/teams/team-a/sheets/s2", { body: { data: { ...sheet("2026-09-02"), ...extra }, expectedVersion: 0 } })).status, JSON.stringify(extra)).toBe(400);
      expect((await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: extra, expectedVersion: 1 } })).status, JSON.stringify(extra)).toBe(400);
      expect((await call("PUT", "/teams/team-a/products/p1", { body: { data: { code: "p1", name: "P", price: 1, ...extra }, expectedVersion: 0 } })).status, JSON.stringify(extra)).toBe(400);
    }
    expect([...table.items.values()].filter((i) => Object.keys(i).some((k) => /^GSI([3-9]|\d{2,})/.test(k)))).toEqual([]);
    // Names that merely start like one are still document fields
    expect((await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { GSI3PKnote: "fine", gsi3pk: "fine" }, expectedVersion: 1 } })).status).toBe(200);
  });

  it("refuses documents over the size limit with quota_exceeded, the app's \"storage is full\"", async () => {
    const big = { client: "x".repeat(MAX_DOCUMENT_BYTES) };
    expect(await call("PUT", "/teams/team-a/sheets/s1", { body: { data: big } })).toMatchObject({ status: 413, body: { error: { code: "quota_exceeded" } } });
    const huge = "x".repeat(1_000_001);
    expect((await call("PUT", "/teams/team-a/sheets/s1", { rawBody: huge })).status).toBe(413);
    // Growing past the limit through updates is refused too
    await call("PUT", "/teams/team-a/sheets/s2", { body: { data: { a: "x".repeat(MAX_DOCUMENT_BYTES - 100) } } });
    expect((await call("PATCH", "/teams/team-a/sheets/s2", { body: { data: { b: "x".repeat(200) } } })).status).toBe(413);
  });

  it("treats only DynamoDB's item-size refusal as too large; any other ValidationException is a 500", async () => {
    const refuse = (message: string) => {
      table.beforePut = () => {
        throw Object.assign(new Error(message), { name: "ValidationException" });
      };
    };
    // DynamoDB's message, and the same with anything it adds after it
    for (const message of ["Item size has exceeded the maximum allowed size", "Item size has exceeded the maximum allowed size (400 KB)"]) {
      refuse(message);
      expect(await call("PUT", "/teams/team-a/products/p1", { body: { data: product } }), message).toMatchObject({ status: 413, body: { error: { code: "quota_exceeded" } } });
    }
    // Messages the old pattern (any mention of size) matched, which are bugs rather than a document too large
    for (const message of ["One or more parameter values were invalid: Size of hashkey has exceeded the maximum size limit of 2048 bytes", "Invalid size", "The item size is fine: Item size has exceeded the maximum allowed size"]) {
      refuse(message);
      const res = await call("PUT", "/teams/team-a/products/p1", { body: { data: product } });
      expect(res.status, message).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(message);
    }
    table.beforePut = undefined;
    expect((await call("PUT", "/teams/team-a/products/p1", { body: { data: product } })).status).toBe(200);
  });

  it("reads a base64-encoded body", async () => {
    const e = event("PUT", "/teams/team-a/products/p", { body: { data: product, expectedVersion: 0 } });
    const response = await handler({ ...e, body: Buffer.from(e.body as string).toString("base64"), isBase64Encoded: true });
    expect(response.statusCode).toBe(200);
  });

  it("answers 404 for a route it doesn't serve", async () => {
    expect(await call("POST", "/teams/team-a/products")).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  });

  it("counts writes, checkouts and returns for the dashboard", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01", { a: { out: 3, returned: 0 } }) } });
    await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { a: { out: 5 }, b: { out: 2, returned: 0 } } } } });
    await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { items: { a: { returned: 4 } } } } });
    await call("PUT", "/teams/team-a/products/p", { body: { data: product } });
    await call("DELETE", "/teams/team-a/products/p");
    expect(counts).toEqual({ Writes: 5, Checkouts: 7, Returns: 4 });
  });
});

describe("sheetMovement", () => {
  const doc = (items: unknown) => ({ id: "s", version: 1, data: { items } });
  it("counts only increases, and tolerates odd lines", () => {
    expect(sheetMovement({ after: doc({ a: { out: 2, returned: 1 } }) })).toEqual({ checkouts: 2, returns: 1 });
    expect(sheetMovement({ before: doc({ a: { out: 5, returned: 3 } }), after: doc({ a: { out: 2, returned: 1 } }) })).toEqual({ checkouts: 0, returns: 0 });
    expect(sheetMovement({ before: doc("junk"), after: doc({ a: null, b: { out: "3" }, c: { out: 1.7 } }) })).toEqual({ checkouts: 1, returns: 0 });
    expect(sheetMovement({ after: doc([1]) })).toEqual({ checkouts: 0, returns: 0 });
  });
});

describe("team isolation (negative tests)", () => {
  beforeEach(async () => {
    table.seedTeam("team-a", { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
    table.put({ PK: "TEAM#team-b", SK: "PRODUCT#secret", type: "product", key: "secret", name: "B's item", version: 1 });
    table.put({ PK: "TEAM#team-b", SK: "SHEET#b1", GSI1PK: "TEAM#team-b#SHEETS", GSI1SK: "2026-09-01#b1", type: "sheet", id: "b1", client: "B", version: 1 });
  });

  const denied = { status: 403, body: { error: { code: "permission_denied", message: expect.any(String), reason: "not_member" } } };

  it("refuses every route on another team's ID in the path, and reveals nothing", async () => {
    for (const [method, path] of [
      ["GET", "/teams/team-b/products"],
      ["GET", "/teams/team-b/products/secret"],
      ["PUT", "/teams/team-b/products/secret"],
      ["PATCH", "/teams/team-b/products/secret"],
      ["DELETE", "/teams/team-b/products/secret"],
      ["GET", "/teams/team-b/sheets"],
      ["GET", "/teams/team-b/sheets/b1"],
      ["PUT", "/teams/team-b/sheets/b1"],
      ["PATCH", "/teams/team-b/sheets/b1"],
      ["DELETE", "/teams/team-b/sheets/b1"],
    ] as const) {
      const response = await call(method, path, { body: { data: { name: "overwritten" } } });
      expect(response, `${method} ${path}`).toEqual(denied);
      expect(JSON.stringify(response.body)).not.toContain("B's item");
    }
    expect(table.get("TEAM#team-b", "PRODUCT#secret")).toMatchObject({ name: "B's item", version: 1 });
    expect(table.get("TEAM#team-b", "SHEET#b1")).toMatchObject({ client: "B", version: 1 });
  });

  it("answers a team that doesn't exist exactly as one the caller isn't in", async () => {
    expect(await call("GET", "/teams/no-such-team/products")).toEqual(denied);
    expect((await call("GET", "/teams/TEAM%23b/products")).status).toBe(400);
  });

  it("ignores no forged team in the body: it's refused, and the path's team is the only one written", async () => {
    const forged = await call("PUT", "/teams/team-a/products/p", { body: { data: product, teamId: "team-b" } });
    expect(forged).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    const inData = await call("PUT", "/teams/team-a/products/p", { body: { data: { ...product, teamId: "team-b" } } });
    expect(inData).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    const keysInData = await call("PUT", "/teams/team-a/products/p", { body: { data: { ...product, PK: "TEAM#team-b", SK: "PRODUCT#secret" } } });
    expect(keysInData.status).toBe(400);
    expect(table.get("TEAM#team-a", "PRODUCT#p")).toBeUndefined();
    expect(table.get("TEAM#team-b", "PRODUCT#p")).toBeUndefined();
    expect(table.get("TEAM#team-b", "PRODUCT#secret")).toMatchObject({ name: "B's item" });
  });

  it("refuses a cursor from another team's listing", async () => {
    const cursor = Buffer.from(JSON.stringify({ PK: "TEAM#team-b", SK: "SHEET#b1" })).toString("base64url");
    expect((await call("GET", "/teams/team-a/sheets", { query: { cursor } })).body.error.code).toBe("bad_request");
    const indexCursor = Buffer.from(JSON.stringify({ PK: "TEAM#team-b", SK: "SHEET#b1", GSI1PK: "TEAM#team-b#SHEETS", GSI1SK: "2026-09-01#b1" })).toString("base64url");
    expect((await call("GET", "/teams/team-a/sheets", { query: { cursor: indexCursor, orderBy: "date" } })).body.error.code).toBe("bad_request");
  });

  it("lets a viewer read but not write, with the reason the web runtime reads as view-only", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01") } });
    expect((await call("GET", "/teams/team-a/sheets/s1", { user: VIEWER })).status).toBe(200);
    expect((await call("GET", "/teams/team-a/sheets", { user: VIEWER })).status).toBe(200);
    const viewOnly = { status: 403, body: { error: { code: "permission_denied", message: expect.any(String), reason: "view_only" } } };
    expect(await call("PUT", "/teams/team-a/sheets/s2", { user: VIEWER, body: { data: sheet("2026-09-01") } })).toEqual(viewOnly);
    expect(await call("PATCH", "/teams/team-a/sheets/s1", { user: VIEWER, body: { data: { client: "Viewer" } } })).toEqual(viewOnly);
    expect(await call("DELETE", "/teams/team-a/sheets/s1", { user: VIEWER })).toEqual(viewOnly);
    expect(table.get("TEAM#team-a", "SHEET#s1")).toMatchObject({ client: "Echo", version: 1 });
    expect(table.get("TEAM#team-a", "SHEET#s2")).toBeUndefined();
    // Contributors can
    expect((await call("PATCH", "/teams/team-a/sheets/s1", { user: CONTRIBUTOR, body: { data: { client: "C" } } })).status).toBe(200);
  });

  it("takes a role change on the next request", async () => {
    table.put({ PK: "TEAM#team-a", SK: `MEMBER#${CONTRIBUTOR}`, type: "member", role: "viewer" });
    expect((await call("PUT", "/teams/team-a/sheets/s1", { user: CONTRIBUTOR, body: { data: sheet("2026-09-01") } })).status).toBe(403);
    table.put({ PK: "TEAM#team-a", SK: `MEMBER#${CONTRIBUTOR}`, type: "member", role: "contributor" });
    expect((await call("PUT", "/teams/team-a/sheets/s1", { user: CONTRIBUTOR, body: { data: sheet("2026-09-01") } })).status).toBe(200);
  });

  it("treats a MEMBER item with a missing or unknown role as no membership", async () => {
    table.put({ PK: "TEAM#team-a", SK: "MEMBER#user-norole", type: "member" });
    table.put({ PK: "TEAM#team-a", SK: "MEMBER#user-bogus", type: "member", role: "superuser" });
    for (const user of ["user-norole", "user-bogus"]) {
      expect(await call("GET", "/teams/team-a/products", { user }), user).toEqual(denied);
      expect(await call("PUT", "/teams/team-a/sheets/s9", { user, body: { data: sheet("2026-09-01") } }), user).toEqual(denied);
      expect(await call("DELETE", "/teams/team-a/sheets/s9", { user }), user).toEqual(denied);
    }
    expect(table.get("TEAM#team-a", "SHEET#s9")).toBeUndefined();
  });

  it("refuses a missing token, an expired one, an ID token and a bad subject, before touching the table", async () => {
    const unauthenticated = { status: 401, body: { error: { code: "unauthenticated", message: expect.any(String) } } };
    const exp = String(NOW / 1000 + 600);
    expect(await call("GET", "/teams/team-a/products", { user: null })).toEqual(unauthenticated);
    expect(await call("GET", "/teams/team-a/products", { claims: { sub: OWNER, token_use: "access", exp: String(NOW / 1000 - 1) } })).toEqual(unauthenticated);
    expect(await call("GET", "/teams/team-a/products", { claims: { sub: OWNER, token_use: "access", exp: NOW / 1000 } })).toEqual(unauthenticated);
    expect(await call("GET", "/teams/team-a/products", { claims: { sub: OWNER, token_use: "access" } })).toEqual(unauthenticated);
    expect(await call("GET", "/teams/team-a/products", { claims: { sub: OWNER, token_use: "id", exp } })).toEqual(unauthenticated);
    expect(await call("GET", "/teams/team-a/products", { claims: { sub: "a#b", token_use: "access", exp } })).toEqual(unauthenticated);
    expect(await call("GET", "/teams/team-a/products", { claims: { token_use: "access", exp } })).toEqual(unauthenticated);
    expect(table.calls).toEqual([]);
  });

  it("only ever names the path team's partitions (what the LeadingKeys policy allows)", async () => {
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-01") } });
    await call("PATCH", "/teams/team-a/sheets/s1", { body: { data: { client: "X" } } });
    await call("GET", "/teams/team-a/sheets", { query: { orderBy: "date", direction: "desc" } });
    await call("GET", "/teams/team-a/products");
    await call("DELETE", "/teams/team-a/sheets/s1");
    await call("GET", "/teams/team-b/products");
    expect(table.calls.length).toBeGreaterThan(5);
    for (const c of table.calls.slice(0, -1)) {
      for (const p of c.partitions) expect(["TEAM#team-a", "TEAM#team-a#SHEETS"]).toContain(p);
    }
    // The refused request checked membership in team B's partition, and stopped there
    expect(table.calls.at(-1)).toEqual({ command: "TransactGetCommand", partitions: ["TEAM#team-b", "TEAM#team-b"] });
  });

  it("fails closed when the scoped handle is refused by IAM", async () => {
    // A handle scoped to team B used for team A's request stands in for a
    // bug that crossed teams: the LeadingKeys layer refuses it
    const crossed = createDataHandler({ dbForTeam: () => table.db("team-b"), obs: fakeObservability(), now: () => NOW });
    const response = await crossed(event("GET", "/teams/team-a/products"));
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body as string)).toEqual({ error: { code: "internal", message: "Something went wrong" } });
  });

  it("refuses an invalid team ID before any call", async () => {
    expect((await call("GET", "/teams/a.b/products")).status).toBe(400);
    const e = event("GET", "/teams/team-a/products");
    expect((await handler({ ...e, pathParameters: {} })).statusCode).toBe(400);
    expect(table.calls).toEqual([]);
  });
});

describe("errors", () => {
  it("logs unexpected failures and answers 500 without details", async () => {
    const obs = fakeObservability();
    const error = vi.spyOn(obs.logger, "error");
    const broken = createDataHandler({
      dbForTeam: () => {
        throw new Error("boom");
      },
      obs,
      now: () => NOW,
    });
    const response = await broken(event("GET", "/teams/team-a/products"));
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("boom");
    expect(error).toHaveBeenCalled();
  });
});

describe("billing access (ADR 0009, supply-checkout-qdx): reads stay open for export, writes follow billingAccess", () => {
  const DAY_MS = 86400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const patchMeta = (fields: Record<string, unknown>) => table.put({ ...(table.get("TEAM#team-a", "META") as Record<string, unknown>), ...fields });
  const refused = (message: string) => ({ status: 403, body: { error: { code: "permission_denied", message, reason: "subscription_ended" } } });
  const TRIAL = "This team's free trial ended, so it's read-only. An owner can subscribe to make changes.";
  const ENDED = "This team's subscription ended, so it's read-only. An owner can subscribe again to make changes.";
  const OVERDUE = "This team's payment is overdue, so it's read-only. An owner can update the payment method in Billing to make changes.";

  beforeEach(async () => {
    await call("PUT", "/teams/team-a/products/0123", { body: { data: product } });
    await call("PUT", "/teams/team-a/sheets/s1", { body: { data: sheet("2026-09-20") } });
  });

  /** Every member can still list and read everything (the app's Export data), and nobody can write. */
  async function readOnly(message: string) {
    const before = table.get("TEAM#team-a", "PRODUCT#0123");
    for (const user of [OWNER, CONTRIBUTOR, VIEWER]) {
      expect((await call("GET", "/teams/team-a/products", { user })).body.documents).toHaveLength(1);
      expect((await call("GET", "/teams/team-a/sheets", { user })).body.documents).toHaveLength(1);
      expect((await call("GET", "/teams/team-a/products/0123", { user })).status).toBe(200);
    }
    for (const user of [OWNER, CONTRIBUTOR]) {
      expect(await call("PUT", "/teams/team-a/products/0123", { user, body: { data: { ...product, price: 99 } } })).toEqual(refused(message));
      expect(await call("PUT", "/teams/team-a/sheets/s2", { user, body: { data: sheet("2026-09-26") } })).toEqual(refused(message));
      expect(await call("DELETE", "/teams/team-a/products/0123", { user })).toEqual(refused(message));
    }
    expect(table.get("TEAM#team-a", "PRODUCT#0123")).toEqual(before);
    expect(table.get("TEAM#team-a", "SHEET#s2")).toBeUndefined();
  }

  const writable = async () => expect((await call("PUT", "/teams/team-a/products/0123", { body: { data: { ...product, price: 13 } } })).status).toBe(200);

  it("a trial that ended without a subscription: read-only from its end", async () => {
    patchMeta({ status: "trialing", trialEndsAt: iso(NOW + 1000) });
    await writable();
    patchMeta({ trialEndsAt: iso(NOW) });
    await readOnly(TRIAL);
  });

  it("a team from before trials: its trial ends TRIAL_DAYS after it was made", async () => {
    patchMeta({ status: "trialing", createdAt: iso(NOW - 13 * DAY_MS) });
    await writable();
    patchMeta({ createdAt: iso(NOW - 14 * DAY_MS) });
    await readOnly(TRIAL);
  });

  it("a Stripe trial (a subscription) is Stripe's to end, so it stays writable past the app's date", async () => {
    patchMeta({ status: "trialing", trialEndsAt: iso(NOW - DAY_MS), stripeSubscriptionId: "sub_1" });
    await writable();
  });

  it("an ended subscription, with its date or without", async () => {
    for (const status of ["canceled", "incomplete_expired"]) {
      patchMeta({ status, stripeSubscriptionId: "sub_1", subscriptionEndedAt: iso(NOW - DAY_MS) });
      await readOnly(ENDED);
    }
    patchMeta({ subscriptionEndedAt: undefined });
    await readOnly(ENDED);
  });

  it("an unpaid subscription: read-only as an overdue payment until it's paid", async () => {
    patchMeta({ status: "unpaid", stripeSubscriptionId: "sub_1" });
    await readOnly(OVERDUE);
    patchMeta({ status: "active" });
    await writable();
  });

  it("a past-due payment: full access through the 7-day grace, then read-only until it's paid", async () => {
    patchMeta({ status: "past_due", stripeSubscriptionId: "sub_1", pastDueSince: iso(NOW - 7 * DAY_MS + 1000) });
    await writable();
    patchMeta({ pastDueSince: iso(NOW - 7 * DAY_MS) });
    await readOnly(OVERDUE);
    // Paid
    patchMeta({ status: "active", pastDueSince: undefined });
    await writable();
  });

  it("a live comp keeps any of them writable", async () => {
    patchMeta({ status: "canceled", stripeSubscriptionId: "sub_1", subscriptionEndedAt: iso(NOW - 90 * DAY_MS), compPlan: "starter", compUntil: iso(NOW + DAY_MS) });
    await writable();
    patchMeta({ status: "trialing", stripeSubscriptionId: undefined, trialEndsAt: iso(NOW - 90 * DAY_MS) });
    await writable();
    patchMeta({ compUntil: iso(NOW) });
    await readOnly(TRIAL);
  });
});
