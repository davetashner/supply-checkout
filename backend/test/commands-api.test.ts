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
      // Every stock change is a new product version, for the edit screens' conditional writes
      product: { id: "0123", version: 4, data: { stock: 7 } },
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

describe("add lines", () => {
  const LINES = "/teams/team-a/sheets/s1/lines";
  const tape = { productKey: "k-tape", quantity: 2, name: " Painter's tape ", price: 6.25, cost: 6.25 };
  const items = () => table.get("TEAM#team-a", "SHEET#s1")?.items as Record<string, Record<string, unknown>> | undefined;

  it("adds new lines with the request's copy and adds to existing ones, in one transaction, without moving stock", async () => {
    seed({ sheet: { items: { "0123": { code: "0123", name: "Old name", price: 10, out: 2, returned: 1 } } } });
    const id = op();
    const res = await call("POST", LINES, { operationId: id, lines: [{ productKey: "0123", quantity: 4, name: "Ignored", price: 1, code: "0123" }, tape] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      operationId: id,
      replayed: false,
      result: {
        operationId: id,
        command: "addLines",
        sheetId: "s1",
        lines: [
          { productKey: "0123", quantity: 4, lineCreated: false },
          { productKey: "k-tape", quantity: 2, lineCreated: true },
        ],
        userId: CONTRIBUTOR,
        at: "2026-09-26T12:00:00.000Z",
      },
      sheet: { id: "s1", version: 2 },
    });
    expect(res.body.product).toBeUndefined();
    expect(items()).toEqual({
      "0123": { code: "0123", name: "Old name", price: 10, out: 6, returned: 1 },
      "k-tape": { code: "", name: "Painter's tape", price: 6.25, cost: 6.25, out: 2, returned: 0 },
    });
    expect(res.body.sheet.data.items).toEqual(items());
    expect(stock()).toBe(10);
    expect(movements()).toEqual([]);
    expect(table.transactions).toEqual([2]);
    expect(operations()).toEqual([expect.objectContaining({ SK: `OP#${id}`, command: "addLines" })]);
    expect(counts).toMatchObject({ ReceiptLines: 6, Writes: 1 });
    expect(counts).not.toHaveProperty("Checkouts");
  });

  it("changes nothing when replayed, and refuses the ID for a different request", async () => {
    seed();
    const id = op();
    const first = await call("POST", LINES, { operationId: id, lines: [tape] });
    const again = await call("POST", LINES, { operationId: id.toUpperCase(), lines: [tape] });
    expect(again).toMatchObject({ status: 200, body: { ...first.body, replayed: true } });
    expect(items()?.["k-tape"]).toMatchObject({ out: 2 });
    expect(counts).toMatchObject({ ReceiptLines: 2, Writes: 1 });
    expect((await call("POST", LINES, { operationId: id, lines: [{ ...tape, quantity: 3 }] })).status).toBe(400);
    expect((await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: id, productKey: "k-tape", quantity: 2 })).status).toBe(400);
    expect(items()?.["k-tape"]).toMatchObject({ out: 2 });
  });

  it("creates the items map on a sheet that has none, even for a line keyed constructor", async () => {
    seed({ sheet: { items: undefined } });
    await call("POST", LINES, { operationId: op(), lines: [{ ...tape, productKey: "constructor" }, { ...tape, productKey: "k-2" }] });
    expect(Object.keys(items() ?? {})).toEqual(["constructor", "k-2"]);
    expect(Object.hasOwn(items() ?? {}, "constructor")).toBe(true);
  });

  it("refuses a closed or missing sheet, and a malformed line, writing nothing", async () => {
    seed({ sheet: { status: "closed" } });
    expect(await call("POST", LINES, { operationId: op(), lines: [tape] })).toMatchObject({ status: 409, body: { error: { code: "aborted", message: expect.stringMatching(/closed/) } } });
    expect((await call("POST", "/teams/team-a/sheets/nope/lines", { operationId: op(), lines: [tape] })).status).toBe(404);
    seed({ sheet: { items: { "0123": { out: "2" } } } });
    expect(await call("POST", LINES, { operationId: op(), lines: [{ ...tape, productKey: "0123" }] })).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(/whole numbers/) } } });
    seed({ sheet: { items: { "0123": "junk" } } });
    expect((await call("POST", LINES, { operationId: op(), lines: [{ ...tape, productKey: "0123" }] })).status).toBe(400);
    expect(operations()).toEqual([]);
  });

  it("leaves nothing half-saved when another write lands between the read and the transaction, then adds to the fresh copy", async () => {
    seed();
    let once = false;
    table.beforeTransactWrite = () => {
      if (once) return;
      once = true;
      // Someone checks the same item out first: the line now exists
      const s = table.get("TEAM#team-a", "SHEET#s1") as Record<string, unknown>;
      table.put({ ...s, version: 2, items: { "k-tape": { code: "", name: "Tape", price: 5, out: 1, returned: 0 } } });
    };
    const res = await call("POST", LINES, { operationId: op(), lines: [tape] });
    expect(res.body.result.lines).toEqual([{ productKey: "k-tape", quantity: 2, lineCreated: false }]);
    expect(items()?.["k-tape"]).toEqual({ code: "", name: "Tape", price: 5, out: 3, returned: 0 });
  });

  it.each([
    ["no lines", { lines: [] }],
    ["too many lines", { lines: Array.from({ length: 41 }, (_, i) => ({ ...tape, productKey: `k-${i}` })) }],
    ["lines that aren't a list", { lines: { a: tape } }],
    ["a line that isn't an object", { lines: ["k-tape"] }],
    ["an unexpected line field", { lines: [{ ...tape, stock: 1 }] }],
    ["the same product twice", { lines: [tape, { ...tape, quantity: 1 }] }],
    ["a missing name", { lines: [{ ...tape, name: undefined }] }],
    ["a missing price", { lines: [{ ...tape, price: undefined }] }],
    ["a price with more than two decimals", { lines: [{ ...tape, price: 1.001 }] }],
    ["a bad cost", { lines: [{ ...tape, cost: -1 }] }],
    ["a quantity of 0", { lines: [{ ...tape, quantity: 0 }] }],
    ["a __proto__ key", { lines: [{ ...tape, productKey: "__proto__" }] }],
    ["an unexpected body field", { lines: [tape], sheetId: "s2" }],
  ])("refuses %s with 400", async (_, body) => {
    seed();
    expect((await call("POST", LINES, { operationId: op(), ...body })).status).toBe(400);
    expect(operations()).toEqual([]);
  });

  it("takes 40 lines, all new or all existing, within DynamoDB's 4 KB expression limit", async () => {
    const forty = Array.from({ length: 40 }, (_, i) => ({ ...tape, productKey: `k-${i}` }));
    seed();
    await call("POST", LINES, { operationId: op(), lines: forty });
    await call("POST", LINES, { operationId: op(), lines: forty });
    expect(Object.values(items() ?? {}).map((l) => l.out)).toEqual(Array(40).fill(4));
    for (const { input } of table.requests.filter((r) => r.command === "TransactWriteCommand")) {
      const update = ((input.TransactItems as Record<string, Record<string, string>>[])[1] as Record<string, Record<string, string>>).Update as Record<string, string>;
      expect((update.UpdateExpression as string).length).toBeLessThan(4096);
      expect((update.ConditionExpression as string).length).toBeLessThan(4096);
    }
  });

  it("refuses lines that would take the sheet past the document limit, with 413", async () => {
    seed({ sheet: { notes: "x".repeat(MAX_DOCUMENT_BYTES - 100) } });
    expect((await call("POST", LINES, { operationId: op(), lines: [tape] })).status).toBe(413);
  });

  it("gives viewers view-only and keeps other teams out", async () => {
    seed();
    expect(await call("POST", LINES, { operationId: op(), lines: [tape] }, VIEWER)).toMatchObject({ status: 403, body: { error: { reason: "view_only" } } });
    expect((await call("POST", LINES, { operationId: op(), lines: [tape] }, OUTSIDER)).status).toBe(403);
    expect((await call("POST", LINES, { operationId: op(), lines: [tape] }, OWNER)).status).toBe(200);
  });
});

describe("return", () => {
  beforeEach(() => seed({ sheet: { items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 5, returned: 1 } } } }));

  it("adds to returned and puts stock back", async () => {
    const res = await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 3 });
    expect(res).toMatchObject({ status: 200, body: { replayed: false, result: { command: "return", reason: "return", quantity: 3, stockDelta: 3 } } });
    expect(line()).toMatchObject({ out: 5, returned: 4 });
    expect(stock()).toBe(13);
    expect(table.get("TEAM#team-a", "PRODUCT#0123")?.version).toBe(4);
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
    expect(res.body.product.version).toBe(4);
    expect(movements()).toEqual([expect.objectContaining({ reason: "receipt", delta: 24, unitCost: 0.42, tracked: true })]);
  });

  it("sets a counted level and records the difference", async () => {
    const res = await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "count", count: 4 });
    expect(res.body.result).toMatchObject({ reason: "count", count: 4, stockDelta: -6 });
    expect(stock()).toBe(4);
    expect(res.body.product.version).toBe(4);
    expect(movements()).toEqual([expect.objectContaining({ reason: "count", count: 4, delta: -6 })]);
  });

  it("starts tracking an item that wasn't counted", async () => {
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#nb-1", type: "product", key: "nb-1", version: 1, name: "Rags", price: 1 });
    expect((await call("POST", "/teams/team-a/products/nb-1/stock", { operationId: op(), reason: "count", count: 3 })).body.result.stockDelta).toBe(3);
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#nb-2", type: "product", key: "nb-2", version: 1, name: "Bags", price: 1 });
    expect((await call("POST", "/teams/team-a/products/nb-2/stock", { operationId: op(), reason: "receipt", quantity: 5, unitCost: 1 })).body.product.data.stock).toBe(5);
    // An item stored without a version reads as version 1, so a stock change makes it 2
    table.put({ PK: "TEAM#team-a", SK: "PRODUCT#nb-3", type: "product", key: "nb-3", name: "Mops", price: 1, stock: 1 });
    expect((await call("GET", "/teams/team-a/products/nb-3")).body.version).toBe(1);
    expect((await call("POST", "/teams/team-a/products/nb-3/stock", { operationId: op(), reason: "receipt", quantity: 1, unitCost: 1 })).body.product.version).toBe(2);
  });

  it("needs the item to exist", async () => {
    expect((await call("POST", "/teams/team-a/products/nope/stock", { operationId: op(), reason: "count", count: 1 })).status).toBe(404);
    expect((await call("POST", "/teams/team-a/products/nope/stock", { operationId: op(), reason: "uncount" })).status).toBe(404);
  });

  it("stops counting an item, recording the count it had as the change, once per operation", async () => {
    const id = op();
    const res = await call("POST", "/teams/team-a/products/0123/stock", { operationId: id, reason: "uncount" });
    expect(res).toMatchObject({ status: 200, body: { replayed: false, result: { command: "stockAdjust", reason: "uncount", productKey: "0123", stockDelta: -10 } } });
    expect(res.body.result).not.toHaveProperty("count");
    expect(res.body.product).toMatchObject({ version: 4, data: { code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99 } });
    expect(res.body.product.data).not.toHaveProperty("stock");
    expect(table.get("TEAM#team-a", "PRODUCT#0123")).not.toHaveProperty("stock");
    expect(movements()).toEqual([expect.objectContaining({ reason: "uncount", delta: -10, tracked: true, productKey: "0123", operationId: id })]);
    expect(movements()[0]).not.toHaveProperty("count");
    // A retry replays the first result and changes nothing
    const again = await call("POST", "/teams/team-a/products/0123/stock", { operationId: id, reason: "uncount" });
    expect(again.body).toMatchObject({ replayed: true, result: res.body.result, product: { version: 4 } });
    expect(movements()).toHaveLength(1);
    // The same ID for a count is another request
    expect((await call("POST", "/teams/team-a/products/0123/stock", { operationId: id, reason: "count", count: 1 })).status).toBe(400);
    // Counted again, it starts from 0, so its movements still add up to its stock
    expect((await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "count", count: 4 })).body.result.stockDelta).toBe(4);
    expect(10 + movements().reduce((sum, m) => sum + (m.delta as number), 0)).toBe(stock());
  });

  it("leaves an item that isn't counted as it is when told to stop counting it, with a movement that changed nothing", async () => {
    seed({ product: { code: "0123", name: "Nitrile gloves", price: 12.5 } });
    const res = await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "uncount" });
    expect(res).toMatchObject({ status: 200, body: { result: { reason: "uncount", stockDelta: 0 }, product: { version: 3 } } });
    expect(stock()).toBeUndefined();
    expect(movements()).toEqual([expect.objectContaining({ reason: "uncount", delta: 0, tracked: false })]);
  });

  it("refuses to stop counting an item whose stored stock isn't a number", async () => {
    seed({ product: { ...gloves, stock: "10" } });
    expect(await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "uncount" })).toMatchObject({
      status: 400,
      body: { error: { code: "bad_request", message: "This item's stock isn't a number" } },
    });
    expect(movements()).toEqual([]);
  });
});

describe("edits after a command", () => {
  it("refuse a product write made against the version before a checkout, return or stock change, so none of them is overwritten", async () => {
    seed({ sheet: { items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 5, returned: 1 } } } });
    const edit = (expectedVersion: number) => call("PATCH", "/teams/team-a/products/0123", { data: { price: 13 }, expectedVersion });
    await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 2 });
    expect((await edit(3)).body.error.code).toBe("aborted");
    await call("POST", "/teams/team-a/sheets/s1/return", { operationId: op(), productKey: "0123", quantity: 1 });
    expect((await edit(4)).body.error.code).toBe("aborted");
    await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "count", count: 20 });
    expect((await edit(5)).body.error.code).toBe("aborted");
    expect(stock()).toBe(20);
    // Made against the latest version, it saves
    expect((await edit(6)).body).toMatchObject({ version: 7, data: { stock: 20, price: 13 } });
  });

  it("keep the stock the commands set through a product PUT or PATCH that leaves it out, and refuse one that changes it", async () => {
    seed({ sheet: { items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 5, returned: 1 } } } });
    await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 2 });
    expect(stock()).toBe(8);
    const put = await call("PUT", "/teams/team-a/products/0123", { data: { code: "0123", name: "Gloves", price: 13 }, expectedVersion: 4 });
    expect(put.body).toMatchObject({ version: 5, data: { name: "Gloves", stock: 8 } });
    expect((await call("PUT", "/teams/team-a/products/0123", { data: { code: "0123", name: "Gloves", price: 13, stock: 10 }, expectedVersion: 5 })).status).toBe(400);
    expect((await call("PATCH", "/teams/team-a/products/0123", { data: { stock: 7 }, expectedVersion: 5 })).status).toBe(400);
    expect(stock()).toBe(8);
    expect(movements().map((m) => m.reason)).toEqual(["checkout"]);
  });

  it("refuse, with 400 and nothing written, a stock change to a product whose stored version isn't a number", async () => {
    seed({ product: { ...gloves, version: "x" }, sheet: { items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 5, returned: 1 } } } });
    for (const [path, body] of [
      ["/teams/team-a/sheets/s1/checkout", { productKey: "0123", quantity: 1 }],
      ["/teams/team-a/sheets/s1/return", { productKey: "0123", quantity: 1 }],
      ["/teams/team-a/products/0123/stock", { reason: "count", count: 3 }],
      ["/teams/team-a/products/0123/stock", { reason: "receipt", quantity: 1, unitCost: 1 }],
      ["/teams/team-a/products/0123/stock", { reason: "uncount" }],
    ] as const) {
      expect(await call("POST", path, { operationId: op(), ...body })).toMatchObject({ status: 400, body: { error: { code: "bad_request", message: "This item's version isn't a number" } } });
    }
    expect(stock()).toBe(10);
    expect(movements()).toEqual([]);
  });

  it("refuse, with 400, a new line for an untracked product whose stored version isn't a number, and add to an existing line", async () => {
    seed({ product: { code: "0123", name: "Nitrile gloves", price: 12.5, version: "x" } });
    const path = "/teams/team-a/sheets/s1/checkout";
    expect(await call("POST", path, { operationId: op(), productKey: "0123", quantity: 1 })).toMatchObject({ status: 400, body: { error: { code: "bad_request", message: "This item's version isn't a number" } } });
    expect(line()).toBeUndefined();
    expect(movements()).toEqual([]);
    // A line already on the sheet doesn't need the product's version
    seed({ product: { code: "0123", name: "Nitrile gloves", price: 12.5, version: "x" }, sheet: { items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 5, returned: 1 } } } });
    expect(await call("POST", path, { operationId: op(), productKey: "0123", quantity: 1 })).toMatchObject({ status: 200 });
    expect(line().out).toBe(6);
  });

  it("leave an untracked product's version alone, since its stock didn't change", async () => {
    seed({ product: { code: "0123", name: "Nitrile gloves", price: 12.5 } });
    await call("POST", "/teams/team-a/sheets/s1/checkout", { operationId: op(), productKey: "0123", quantity: 2 });
    expect(table.get("TEAM#team-a", "PRODUCT#0123")?.version).toBe(3);
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
    ["an uncount with a count", { operationId: op(), reason: "uncount", count: 0 }],
    ["an uncount with a quantity", { operationId: op(), reason: "uncount", quantity: 1 }],
    ["an uncount with a unit cost", { operationId: op(), reason: "uncount", unitCost: 1 }],
    ["an uncount with a null count", { operationId: op(), reason: "uncount", count: null }],
    ["a reason in another case", { operationId: op(), reason: "Uncount" }],
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
      ["/teams/team-a/products/0123/stock", { operationId: op(), reason: "uncount" }],
    ] as const) {
      expect(await call("POST", path, body, VIEWER)).toMatchObject({ status: 403, body: { error: { code: "permission_denied", reason: "view_only" } } });
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
    await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "uncount" });
    expect(await call("POST", "/teams/team-a/products/0123/stock", { operationId: op(), reason: "uncount" }, OUTSIDER)).toMatchObject({ status: 403 });
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
      ["/teams/team-a/products/0123/stock", { reason: "uncount" }],
      ["/teams/team-a/products/0123/stock", { reason: "count", count: 6 }],
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
    expect(all).toHaveLength(7);
    expect(all.every((m: { productKey: string }) => m.productKey === "0123")).toBe(true);
    expect(all.map((m: { reason: string }) => m.reason)).toEqual(["count", "uncount", "count", "checkout", "receipt", "return", "checkout"]);
    // Across an uncount and a new count too
    expect(stock()).toBe(6);
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
      ["PUT", "/teams/team-a/products/__proto__", { data: { code: "", name: "x", price: 1 }, expectedVersion: 0 }],
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
    const put = await call("PUT", "/teams/team-a/sheets/s1", { data: { client: "Echo", date: "2026-09-26", status: "open", items }, expectedVersion: 1 });
    expect(put.status).toBe(200);
    expect(sheet().items).toEqual(items);
    // The merge adds to the stored line, not to Object
    const patch = await call("PATCH", "/teams/team-a/sheets/s1", { data: { items: { constructor: { out: 3 }, toString: { name: "Rags", price: 1, out: 1, returned: 0 } } }, expectedVersion: 2 });
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
