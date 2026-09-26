// The inventory commands through the data API's handler, against the
// in-memory table (memory-table.ts): routes, validation, roles, replay, the
// all-or-nothing transaction, metrics and team isolation. commands.test.ts
// runs the same commands against DynamoDB Local in CI, including concurrency.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { DATA_ROUTES, routeKey } from "../src/api/routes.js";
import { InvalidInputError } from "../src/data/index.js";
import { MAX_DOCUMENT_BYTES } from "../src/data/documents.js";
import type { Observability } from "../src/observability/index.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";

let table: MemoryTable;
let clock: number;
let counts: Record<string, number>;
let handler: ReturnType<typeof createDataHandler>;

beforeEach(() => {
  table = new MemoryTable();
  table.seedTeam("team-a", { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  table.seedTeam("team-b", { [OUTSIDER]: "owner" });
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
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const op = () => randomUUID();
const gloves = { code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, stock: 10 };

function seed(options: { product?: Record<string, unknown> | null; sheet?: Record<string, unknown> } = {}) {
  const product = options.product === undefined ? gloves : options.product;
  if (product) table.put({ PK: "TEAM#team-a", SK: "PRODUCT#0123", type: "product", key: "0123", version: 3, ...product });
  table.put({ PK: "TEAM#team-a", SK: "SHEET#s1", type: "sheet", id: "s1", version: 1, client: "Echo", date: "2026-09-26", status: "open", items: {}, ...options.sheet });
}

const line = () => (table.get("TEAM#team-a", "SHEET#s1")?.items as Record<string, Record<string, unknown>>)["0123"];
const stock = () => table.get("TEAM#team-a", "PRODUCT#0123")?.stock;
const movements = () => [...table.items.values()].filter((i) => String(i.SK).startsWith("MOVE#"));
const operations = () => [...table.items.values()].filter((i) => String(i.SK).startsWith("OP#"));

describe("checkout", () => {
  it("adds a line that copies the product's code, name, price and cost, takes stock down, and logs a movement", async () => {
    seed();
    const id = op();
    const res = await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: id, productKey: "0123", quantity: 3, name: "Ignored", price: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      operationId: id,
      replayed: false,
      result: {
        command: "checkout",
        reason: "checkout",
        productKey: "0123",
        sheetId: "s1",
        quantity: 3,
        stockDelta: -3,
        lineCreated: true,
        snapshot: { code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99 },
        userId: CONTRIBUTOR,
        at: "2026-09-26T12:00:00.000Z",
      },
      sheet: { id: "s1", version: 2 },
      product: { id: "0123", version: 3, data: { stock: 7 } },
    });
    expect(line()).toEqual({ code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, out: 3, returned: 0 });
    expect(res.body.sheet.data.items["0123"]).toEqual(line());
    expect(stock()).toBe(7);
    expect(movements()).toEqual([
      expect.objectContaining({
        SK: `MOVE#0123#2026-09-26T12:00:00.000Z#${id}`,
        type: "movement",
        productKey: "0123",
        reason: "checkout",
        delta: -3,
        tracked: true,
        quantity: 3,
        sheetId: "s1",
        operationId: id,
        userId: CONTRIBUTOR,
      }),
    ]);
    expect(operations()).toEqual([expect.objectContaining({ SK: `OP#${id}`, expiresAt: NOW / 1000 + 7 * 86400 })]);
    expect(counts).toMatchObject({ Checkouts: 3, Writes: 1 });
  });

  it("adds to an existing line and never changes its snapshot", async () => {
    seed({ sheet: { items: { "0123": { code: "0123", name: "Old name", price: 10, out: 2, returned: 1 } } } });
    const res = await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 4 });
    expect(res.body.result).toMatchObject({ lineCreated: false, stockDelta: -4 });
    expect(res.body.result.snapshot).toBeUndefined();
    expect(line()).toEqual({ code: "0123", name: "Old name", price: 10, out: 6, returned: 1 });
    expect(stock()).toBe(6);
  });

  it("uses the request's name and price only for an item that isn't in inventory, and moves no stock", async () => {
    seed({ product: null });
    expect(await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 })).toMatchObject({
      status: 400,
      body: { error: { code: "bad_request", message: expect.stringMatching(/name and price/) } },
    });
    const res = await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 2, name: " Rags ", price: 1.5, code: "0123", cost: 1 });
    expect(res.body).toMatchObject({ result: { stockDelta: 0, lineCreated: true }, product: null });
    expect(line()).toEqual({ code: "0123", name: "Rags", price: 1.5, cost: 1, out: 2, returned: 0 });
    expect(movements()).toEqual([expect.objectContaining({ delta: 0, tracked: false, quantity: 2 })]);
  });

  it("leaves stock alone for an item that doesn't track it, and rounds a legacy price to cents", async () => {
    seed({ product: { code: "0123", name: "Gloves", price: 2.345 } });
    const res = await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 2 });
    expect(res.body.result).toMatchObject({ stockDelta: 0, snapshot: { code: "0123", name: "Gloves", price: 2.35 } });
    expect(res.body.result.snapshot.cost).toBeUndefined();
    expect(stock()).toBeUndefined();
    expect(movements()).toEqual([expect.objectContaining({ delta: 0, tracked: false })]);
  });

  it("creates the items map on a sheet that has none", async () => {
    seed({ sheet: { items: undefined } });
    await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 });
    expect(line()).toMatchObject({ out: 1, returned: 0 });
  });

  it("refuses a closed or missing sheet", async () => {
    seed({ sheet: { status: "closed" } });
    expect(await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 })).toMatchObject({
      status: 409,
      body: { error: { code: "aborted", message: expect.stringMatching(/closed/) } },
    });
    expect((await call("POST", "/teams/team-a/sheets/nope/checkout", { operationId: op(), productKey: "0123", quantity: 1 })).status).toBe(404);
    expect(stock()).toBe(10);
    expect(operations()).toEqual([]);
  });
});

describe("return", () => {
  beforeEach(() => seed({ sheet: { items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 5, returned: 1 } } } }));

  it("adds to returned and puts stock back", async () => {
    const res = await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 3 });
    expect(res).toMatchObject({ status: 200, body: { replayed: false, result: { command: "return", reason: "return", quantity: 3, stockDelta: 3 } } });
    expect(line()).toMatchObject({ out: 5, returned: 4 });
    expect(stock()).toBe(13);
    expect(movements()).toEqual([expect.objectContaining({ reason: "return", delta: 3, sheetId: "s1" })]);
    expect(counts).toMatchObject({ Returns: 3, Writes: 1 });
  });

  it("never returns more than went out", async () => {
    expect(await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 5 })).toMatchObject({
      status: 400,
      body: { error: { code: "bad_request", message: "Only 4 of this item are left to return" } },
    });
    expect((await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "nope", quantity: 1 })).body.error.message).toMatch(/isn't on this sheet/);
    expect(line()).toMatchObject({ out: 5, returned: 1 });
    expect(stock()).toBe(10);
  });

  it("counts a line with no returned yet from zero", async () => {
    table.put({ ...table.get("TEAM#team-a", "SHEET#s1"), items: { "0123": { name: "x", price: 1, out: 2 } } });
    await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 2 });
    expect(line()).toMatchObject({ out: 2, returned: 2 });
  });

  it("isn't taken on a closed sheet", async () => {
    table.put({ ...table.get("TEAM#team-a", "SHEET#s1"), status: "closed" });
    expect((await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 1 })).body.error).toEqual({
      code: "aborted",
      message: "This sheet is closed. Reopen it to record returns.",
    });
  });
});

describe("stock adjust", () => {
  beforeEach(() => seed());

  it("adds a receipt's eaches and records the unit cost, without touching the product's prices", async () => {
    const res = await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "receipt", quantity: 24, unitCost: 0.42 });
    expect(res).toMatchObject({ status: 200, body: { result: { command: "stockAdjust", reason: "receipt", quantity: 24, stockDelta: 24, unitCost: 0.42 }, product: { data: { stock: 34, price: 12.5, cost: 9.99 } } } });
    expect(res.body.sheet).toBeUndefined();
    expect(movements()).toEqual([expect.objectContaining({ reason: "receipt", delta: 24, unitCost: 0.42, tracked: true })]);
  });

  it("sets a counted level and records the difference", async () => {
    const res = await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "count", count: 4 });
    expect(res.body.result).toMatchObject({ reason: "count", count: 4, stockDelta: -6 });
    expect(stock()).toBe(4);
    expect(movements()).toEqual([expect.objectContaining({ reason: "count", count: 4, delta: -6 })]);
  });

  it("starts tracking an item that wasn't counted", async () => {
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#nb-1", type: "product", key: "nb-1", version: 1, name: "Rags", price: 1 });
    expect((await call("POST", "/teams/team-a/products/nb-1/stock", { operationId: op(), reason: "count", count: 3 })).body.result.stockDelta).toBe(3);
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#nb-2", type: "product", key: "nb-2", version: 1, name: "Bags", price: 1 });
    expect((await call("POST", "/teams/team-a/products/nb-2/stock", { operationId: op(), reason: "receipt", quantity: 5, unitCost: 1 })).body.product.data.stock).toBe(5);
  });

  it("needs the item to exist", async () => {
    expect((await call("POST", "/teams/team-a/products/nope/stock", { operationId: op(), reason: "count", count: 1 })).status).toBe(404);
  });
});

describe("retries", () => {
  it("replaying an operation changes nothing and returns the first result", async () => {
    seed();
    const id = op();
    const request = { operationId: id, productKey: "0123", quantity: 3 };
    const first = await call("POST", "/teams/team-a/sheets/s1/checkout", request);
    const before = structuredClone([...table.items.entries()]);
    const again = await call("POST", "/teams/team-a/sheets/s1/checkout", { ...request, operationId: id.toUpperCase() });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect([...table.items.entries()]).toEqual(before);
    // Metrics count the checkout once
    expect(counts).toMatchObject({ Checkouts: 3, Writes: 1 });
  });

  it("replays even after the sheet has closed", async () => {
    seed();
    const request = { operationId: op(), productKey: "0123", quantity: 3 };
    const first = await call("POST", "/teams/team-a/sheets/s1/checkout", request);
    table.put({ ...table.get("TEAM#team-a", "SHEET#s1"), status: "closed" });
    const again = await call("POST", "/teams/team-a/sheets/s1/checkout", request);
    expect(again).toMatchObject({ status: 200, body: { replayed: true, result: first.body.result } });
    expect(line()).toMatchObject({ out: 3 });
  });

  it("refuses an operation ID reused for a different request", async () => {
    seed();
    const id = op();
    await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: id, productKey: "0123", quantity: 3 });
    expect(await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: id, productKey: "0123", quantity: 4 })).toMatchObject({
      status: 400,
      body: { error: { code: "bad_request", message: expect.stringMatching(/already used/) } },
    });
    // Another user reusing it is a different request too
    expect((await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: id, productKey: "0123", quantity: 3 }, OWNER)).status).toBe(400);
    expect((await call("POST", "/teams/team-a/sheets/s1/return", { operationId: id, productKey: "0123", quantity: 3 })).status).toBe(400);
    expect(line()).toMatchObject({ out: 3 });
  });

  it("returns the first result when a concurrent retry commits first", async () => {
    seed();
    const id = op();
    const request = { operationId: id, productKey: "0123", quantity: 2 };
    const first = await call("POST", "/teams/team-a/sheets/s1/checkout", request);
    const record = table.get("TEAM#team-a", `OP#${id}`) as Record<string, unknown>;
    // Start again without the record, and let it land (as a concurrent retry
    // of the same operation would) between this call's reads and its transaction
    table.items.clear();
    table.seedTeam("team-a", { [CONTRIBUTOR]: "contributor" });
    seed();
    table.beforeTransactWrite = () => table.put(record);
    const again = await call("POST", "/teams/team-a/sheets/s1/checkout", request);
    expect(again.body).toMatchObject({ replayed: true, result: first.body.result });
    expect(line()).toBeUndefined();
    expect(stock()).toBe(10);
    expect(movements()).toEqual([]);
  });

  it("leaves nothing half-saved when a condition fails part way, then retries on a fresh read", async () => {
    seed({ sheet: { items: { "0123": { code: "0123", name: "Gloves", price: 1, out: 2, returned: 0 } } } });
    // Another return lands between the read and the transaction: the line's
    // condition fails, the whole transaction is cancelled, and the retry sees it
    let once = false;
    table.beforeTransactWrite = () => {
      if (once) return;
      once = true;
      const s = table.get("TEAM#team-a", "SHEET#s1") as Record<string, unknown>;
      table.put({ ...s, items: { "0123": { code: "0123", name: "Gloves", price: 1, out: 2, returned: 2 } } });
    };
    const res = await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 1 });
    expect(res).toMatchObject({ status: 400, body: { error: { message: "Only 0 of this item are left to return" } } });
    expect(stock()).toBe(10);
    expect(movements()).toEqual([]);
    expect(operations()).toEqual([]);
    expect(line()).toMatchObject({ out: 2, returned: 2 });
  });

  it("gives up with 409 aborted when the item keeps changing, having written nothing", async () => {
    seed();
    let n = 0;
    table.beforeTransactWrite = () => {
      const p = table.get("TEAM#team-a", "PRODUCT#0123") as Record<string, unknown>;
      table.put({ ...p, version: 100 + ++n });
    };
    const res = await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 });
    expect(res).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(n).toBe(6);
    expect(line()).toBeUndefined();
    expect(stock()).toBe(10);
    expect(movements()).toEqual([]);
    expect(operations()).toEqual([]);
    expect(counts.ConditionalWriteConflicts).toBe(1);
  });
});

describe("validation and roles", () => {
  beforeEach(() => seed());

  it.each([
    ["no operation ID", { productKey: "0123", quantity: 1 }],
    ["an operation ID that isn't a UUID", { operationId: "abc", productKey: "0123", quantity: 1 }],
    ["a zero quantity", { operationId: op(), productKey: "0123", quantity: 0 }],
    ["a fractional quantity", { operationId: op(), productKey: "0123", quantity: 1.5 }],
    ["a quantity as a string", { operationId: op(), productKey: "0123", quantity: "2" }],
    ["a price with three decimals", { operationId: op(), productKey: "nb-9", quantity: 1, name: "x", price: 1.005 }],
    ["a negative price", { operationId: op(), productKey: "nb-9", quantity: 1, name: "x", price: -1 }],
    ["a price over the limit", { operationId: op(), productKey: "nb-9", quantity: 1, name: "x", price: 1_000_000.01 }],
    ["a cost with three decimals", { operationId: op(), productKey: "nb-9", quantity: 1, name: "x", price: 1, cost: 0.001 }],
    ["an empty name", { operationId: op(), productKey: "nb-9", quantity: 1, name: " ", price: 1 }],
    ["an overlong barcode", { operationId: op(), productKey: "nb-9", quantity: 1, name: "x", price: 1, code: "1".repeat(257) }],
    ["no product key", { operationId: op(), quantity: 1 }],
    ["an unknown field", { operationId: op(), productKey: "0123", quantity: 1, expectedVersion: 1 }],
  ])("refuses a checkout with %s", async (_, body) => {
    expect((await call("POST", "/teams/team-a/sheets/s1/checkout", body)).body.error.code).toBe("bad_request");
  });

  it.each([
    ["no reason", { operationId: op(), quantity: 1 }],
    ["an unknown reason", { operationId: op(), reason: "lost", quantity: 1 }],
    ["a receipt without a unit cost", { operationId: op(), reason: "receipt", quantity: 1 }],
    ["a receipt with a count", { operationId: op(), reason: "receipt", quantity: 1, unitCost: 1, count: 3 }],
    ["a receipt cost with three decimals", { operationId: op(), reason: "receipt", quantity: 1, unitCost: 0.425 }],
    ["a negative count", { operationId: op(), reason: "count", count: -1 }],
    ["a count with a quantity", { operationId: op(), reason: "count", count: 1, quantity: 1 }],
  ])("refuses a stock adjustment with %s", async (_, body) => {
    expect((await call("POST", "/teams/team-a/products/0123/stock", body)).body.error.code).toBe("bad_request");
  });

  it("refuses a malformed line rather than adding to it", async () => {
    table.put({ ...table.get("TEAM#team-a", "SHEET#s1"), items: { "0123": { name: "x", price: 1, out: "2" }, bad: "x" } });
    expect((await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 })).status).toBe(400);
    expect((await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 1 })).status).toBe(400);
    expect((await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "bad", quantity: 1 })).status).toBe(400);
    table.put({ ...table.get("TEAM#team-a", "SHEET#s1"), items: [] });
    expect((await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 })).status).toBe(400);
  });

  it("lets contributors and owners run commands, and gives viewers view-only", async () => {
    expect((await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 }, OWNER)).status).toBe(200);
    for (const [path, body] of [
      ["/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 }],
      ["/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 1 }],
      ["/teams/team-a/products/0123/stock", { operationId: op(), reason: "count", count: 1 }],
    ] as const) {
      expect(await call("POST", path, body, VIEWER)).toMatchObject({ status: 403, body: { error: { code: "invalid_argument" } } });
    }
    expect(line()).toMatchObject({ out: 1 });
    // Viewers can read the history
    expect((await call("GET", "/teams/team-a/products/0123/movements", undefined, VIEWER)).status).toBe(200);
  });

  it("refuses another team's members, and every call stays in the team's partition", async () => {
    expect(await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 }, OUTSIDER)).toMatchObject({
      status: 403,
      body: { error: { code: "permission_denied" } },
    });
    table.calls.length = 0;
    await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 1 });
    await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 1 });
    await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "count", count: 1 });
    await call("GET", "/teams/team-a/products/0123/movements");
    expect(table.calls.map((c) => c.command)).toContain("TransactWriteCommand");
    expect(new Set(table.calls.flatMap((c) => c.partitions))).toEqual(new Set(["TEAM#team-a"]));
  });
});

describe("stock history", () => {
  it("lists one item's movements, newest first, a page at a time, and they sum to the stock change", async () => {
    seed();
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#0123#x", type: "product", key: "0123#x", version: 1, name: "Look-alike", price: 1, stock: 0 });
    const steps: [string, unknown][] = [
      ["/teams/team-a/sheets/s1/checkout", { productKey: "0123", quantity: 4 }],
      ["/teams/team-a/sheets/s1/return", { productKey: "0123", quantity: 1 }],
      ["/teams/team-a/products/0123/stock", { reason: "receipt", quantity: 12, unitCost: 0.5 }],
      ["/teams/team-a/sheets/s1/checkout", { productKey: "0123", quantity: 2 }],
      ["/teams/team-a/products/0123/stock", { reason: "count", count: 15 }],
      ["/teams/team-a/products/0123%23x/stock", { reason: "receipt", quantity: 1, unitCost: 1 }],
    ];
    for (const [path, body] of steps) {
      clock += 1000;
      expect((await call("POST", path, { ...(body as object), operationId: op() })).status).toBe(200);
    }
    const first = await call("GET", "/teams/team-a/products/0123/movements", undefined, VIEWER, { limit: "3" });
    expect(first.status).toBe(200);
    expect(first.body.movements).toHaveLength(3);
    expect(first.body.cursor).toBeTruthy();
    const rest = await call("GET", "/teams/team-a/products/0123/movements", undefined, VIEWER, { cursor: first.body.cursor });
    const all = [...first.body.movements, ...rest.body.movements];
    expect(rest.body.cursor).toBeUndefined();
    expect(all).toHaveLength(5);
    expect(all.every((m: { productKey: string }) => m.productKey === "0123")).toBe(true);
    expect(all.map((m: { reason: string }) => m.reason)).toEqual(["count", "checkout", "receipt", "return", "checkout"]);
    expect(all.reduce((sum: number, m: { delta: number }) => sum + m.delta, 0)).toBe((stock() as number) - 10);
    expect(all[0]).not.toHaveProperty("PK");

    const other = await call("GET", "/teams/team-a/products/0123%23x/movements");
    expect(other.body.movements).toHaveLength(1);
    // A cursor from one item's history doesn't page another's
    expect((await call("GET", "/teams/team-a/products/0123%23x/movements", undefined, CONTRIBUTOR, { cursor: first.body.cursor })).status).toBe(400);
    expect((await call("GET", "/teams/team-a/products/0123/movements", undefined, CONTRIBUTOR, { limit: "0" })).status).toBe(400);
    expect((await call("GET", "/teams/team-a/products/0123/movements", undefined, CONTRIBUTOR, { limit: "abc" })).status).toBe(400);
    expect((await call("GET", "/teams/team-a/products/0123/movements", undefined, CONTRIBUTOR, { limit: "101" })).status).toBe(400);
  });
});

describe("product keys that are built-in object names", () => {
  const sheet = () => table.get("TEAM#team-a", "SHEET#s1") as Record<string, unknown> & { items: Record<string, Record<string, unknown>> };
  const stockOf = (key: string) => table.get("TEAM#team-a", `PRODUCT#${key}`)?.stock;
  const addProduct = (key: string, name: string) => table.put({ PK: "TEAM#team-a", SK: `PRODUCT#${key}`, type: "product", key, version: 1, code: key, name, price: 2, stock: 20 });

  it("refuses __proto__, which would be the items map's prototype rather than a line", async () => {
    seed({ sheet: { items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 1, returned: 0 } } } });
    for (const [method, path, body] of [
      ["POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "__proto__", quantity: 1, name: "x", price: 1 }],
      ["POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "__proto__", quantity: 1 }],
      ["POST", "/teams/team-a/products/__proto__/stock", { operationId: op(), reason: "count", count: 1 }],
      ["GET", "/teams/team-a/products/__proto__/movements", undefined],
      ["PUT", "/teams/team-a/products/__proto__", { data: { code: "", name: "x", price: 1 } }],
    ] as const) {
      expect(await call(method, path, body)).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    }
    expect(sheet().version).toBe(1);
    expect(movements()).toEqual([]);
    expect(operations()).toEqual([]);
  });

  it.each(["constructor", "toString", "hasOwnProperty"])("checks out and returns a product keyed %s on a sheet that already has lines", async (key) => {
    seed({ sheet: { items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 1, returned: 0 } } } });
    // Named "String": the SDK would store a map with its own `constructor` field as a string
    addProduct(key, "String");
    const checkout = (quantity: number) => call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: key, quantity });
    expect((await checkout(2)).body.result).toMatchObject({ lineCreated: true, stockDelta: -2 });
    expect((await checkout(3)).body.result).toMatchObject({ lineCreated: false, stockDelta: -3 });
    const ret = await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: key, quantity: 4 });
    expect(ret).toMatchObject({ status: 200, body: { result: { stockDelta: 4 } } });
    expect(ret.body.sheet.data.items[key]).toEqual({ code: key, name: "String", price: 2, out: 5, returned: 4 });
    expect(sheet().items[key]).toEqual({ code: key, name: "String", price: 2, out: 5, returned: 4 });
    expect(sheet().items["0123"]).toEqual({ code: "0123", name: "Nitrile gloves", price: 12.5, out: 1, returned: 0 });
    expect(sheet().version).toBe(4);
    expect(stockOf(key)).toBe(19);
    expect(movements().map((m) => m.delta)).toEqual([-2, -3, 4]);
    expect(await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: key, quantity: 2 })).toMatchObject({
      status: 400,
      body: { error: { message: expect.stringMatching(/Only 1 of this item is left/) } },
    });
  });

  it("creates the items map with a line keyed constructor", async () => {
    seed({ sheet: { items: undefined } });
    addProduct("constructor", "String");
    expect((await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "constructor", quantity: 1 })).status).toBe(200);
    expect(sheet().items).toEqual({ constructor: { code: "constructor", name: "String", price: 2, out: 1, returned: 0 } });
  });

  it("refuses a return of a built-in name that isn't on the sheet", async () => {
    seed();
    addProduct("toString", "Rags");
    expect(await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "toString", quantity: 1 })).toMatchObject({
      status: 400,
      body: { error: { message: expect.stringMatching(/isn't on this sheet/) } },
    });
  });

  it("saves and merges sheet documents with a line keyed constructor", async () => {
    seed();
    const items = { constructor: { code: "c", name: "String", price: 1, out: 2, returned: 0 } };
    const put = await call("PUT", "/teams/team-a/sheets/s1", { data: { client: "Echo", date: "2026-09-26", status: "open", items } });
    expect(put.status).toBe(200);
    expect(sheet().items).toEqual(items);
    // The merge adds to the stored line, not to Object
    const patch = await call("PATCH", "/teams/team-a/sheets/s1", { data: { items: { constructor: { out: 3 }, toString: { name: "Rags", price: 1, out: 1, returned: 0 } } } });
    expect(patch.status).toBe(200);
    expect(sheet().items).toEqual({ constructor: { code: "c", name: "String", price: 1, out: 3, returned: 0 }, toString: { name: "Rags", price: 1, out: 1, returned: 0 } });
    expect(counts).toMatchObject({ Checkouts: 4 });
  });
});

describe("sheet size", () => {
  const sheetBytes = () => Buffer.byteLength(JSON.stringify(table.get("TEAM#team-a", "SHEET#s1")), "utf8");
  /** Pads the sheet to exactly `bytes` of JSON. */
  function padSheet(bytes: number) {
    table.put({ ...table.get("TEAM#team-a", "SHEET#s1"), pad: "" });
    table.put({ ...table.get("TEAM#team-a", "SHEET#s1"), pad: "x".repeat(bytes - sheetBytes()) });
    expect(sheetBytes()).toBe(bytes);
  }

  it("refuses a new line that would take the sheet past the document limit, with 413 and nothing written", async () => {
    seed();
    padSheet(MAX_DOCUMENT_BYTES - 200);
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#nb-1", type: "product", key: "nb-1", version: 1, code: "nb-1", name: "N".repeat(200), price: 1, stock: 5 });
    expect(await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "nb-1", quantity: 1 })).toMatchObject({
      status: 413,
      body: { error: { code: "quota_exceeded", message: expect.stringMatching(/start another sheet/) } },
    });
    expect(table.get("TEAM#team-a", "PRODUCT#nb-1")?.stock).toBe(5);
    expect(table.get("TEAM#team-a", "SHEET#s1")?.version).toBe(1);
    expect(movements()).toEqual([]);
    expect(operations()).toEqual([]);
    // A small line still fits
    expect((await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "x", quantity: 1, name: "x", price: 1 })).status).toBe(200);
  });

  it("maps DynamoDB's item size refusal to 413, not 500", async () => {
    // A sheet already at DynamoDB's limit, which a line's count growing by a digit passes
    seed({ sheet: { items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 1 } } } });
    padSheet(MemoryTable.MAX_ITEM_BYTES);
    for (const [path, quantity] of [["/teams/team-a/sheets/s1/checkout", 9], ["/teams/team-a/sheets/s1/return", 1]] as const) {
      const res = await call("POST", path, { operationId: op(), productKey: "0123", quantity });
      expect({ status: res.status, code: res.body.error?.code }).toEqual({ status: 413, code: "quota_exceeded" });
    }
    expect(stock()).toBe(10);
    expect(line()).toEqual({ code: "0123", name: "Nitrile gloves", price: 12.5, out: 1 });
    expect(movements()).toEqual([]);
    expect(operations()).toEqual([]);
  });
});
