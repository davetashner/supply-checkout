// The CSV inventory import through the data API's handler, against the
// in-memory table (memory-table.ts): parsing and validation, the preview,
// all-or-nothing, re-imports, resuming, roles and team isolation.
// imports.test.ts runs the import against DynamoDB Local in CI.

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { DATA_ROUTES, routeKey } from "../src/api/routes.js";
import { InvalidInputError, keyOfBarcode, MAX_BRAND_LENGTH, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, parseInventoryCsv, planImport, ROWS_PER_CHUNK } from "../src/data/index.js";
import { parseCsv } from "../src/data/csv.js";
import type { Observability } from "../src/observability/index.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const AT = "2026-09-26T12:00:00.000Z";
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";

let table: MemoryTable;
let counts: Record<string, number>;
/** What the handler logged as warnings. */
let warnings: unknown[][];
let handler: ReturnType<typeof createDataHandler>;

beforeEach(() => {
  table = new MemoryTable();
  table.seedTeam("team-a", { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  table.seedTeam("team-b", { [OUTSIDER]: "owner" });
  counts = {};
  warnings = [];
  const obs = {
    region: "test-local-1",
    logger: { info: () => {}, warn: (...args: unknown[]) => warnings.push(args), error: () => {}, addContext: () => {} },
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
    now: () => NOW,
  });
});

const route = DATA_ROUTES.find((r) => r.operation === "importProducts");

function event(team: string, user: string, body: unknown): DataEvent {
  const path = `/teams/${team}/imports`;
  return {
    version: "2.0",
    routeKey: routeKey(route as { method: string; path: string }),
    rawPath: path,
    rawQueryString: "",
    headers: {},
    pathParameters: { teamId: team },
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method: "POST", path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(NOW / 1000 + 600) }, scopes: null } },
    },
  } as unknown as DataEvent;
}

/** A request to another data route, such as a contributor's PUT. */
function write(method: string, path: string, user: string, body: unknown): DataEvent {
  const segments = path.split("/");
  const r = DATA_ROUTES.find((d) => {
    const parts = d.path.split("/");
    return d.method === method && parts.length === segments.length && parts.every((p, i) => p.startsWith("{") || p === segments[i]);
  }) as { method: string; path: string };
  return {
    ...event("team-a", user, body),
    routeKey: routeKey(r),
    rawPath: path,
    pathParameters: { teamId: "team-a" },
    requestContext: { ...event("team-a", user, body).requestContext, http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" } },
  } as unknown as DataEvent;
}

async function post(body: unknown, user = OWNER, team = "team-a") {
  const response = await handler(event(team, user, body));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const products = () => [...table.items.values()].filter((i) => i.PK === "TEAM#team-a" && String(i.SK).startsWith("PRODUCT#"));
const product = (key: string) => table.get("TEAM#team-a", `PRODUCT#${key}`);
const movements = () => [...table.items.values()].filter((i) => String(i.SK).startsWith("MOVE#"));
const importItems = () => [...table.items.values()].filter((i) => String(i.SK).startsWith("IMPORT#"));
const seedProduct = (key: string, data: Record<string, unknown>, version = 1) =>
  table.put({ PK: "TEAM#team-a", SK: `PRODUCT#${key}`, type: "product", key, version, ...data });

/** A sample onboarding file: `n` items, every other one with a barcode, all counted. */
function sampleCsv(n: number): string {
  const lines = ["Name,Barcode,Price,Cost,Stock,Pack Size"];
  for (let i = 1; i <= n; i++) {
    const code = i % 2 ? `0${String(100000 + i)}` : "";
    lines.push(`"Item ${i}, large",${code},$${(i * 1.25).toFixed(2)},${i},${i * 3},${(i % 4) + 1}`);
  }
  return lines.join("\r\n") + "\r\n";
}

describe("importing a file", () => {
  it("never writes an index key from the file, and drops a stray one from an item it updates (ADR 0015)", async () => {
    // An item written before index keys were refused, with a forged GSI3 entry
    seedProduct("0123", { code: "0123", name: "Nitrile gloves", price: 12.5, stock: 10, GSI3PK: "OPS#TEAMS", GSI3SK: "9999#x" }, 4);
    const res = await post({ importId: randomUUID(), csv: "name,barcode,price,GSI3PK,GSI3SK\nNitrile gloves,0123,13.00,OPS#TEAMS,9999#y\nRags,,1.50,OPS#TEAMS,9999#z\n" });
    expect(res.status).toBe(200);
    for (const item of products()) {
      expect(item.GSI3PK, String(item.SK)).toBeUndefined();
      expect(item.GSI3SK, String(item.SK)).toBeUndefined();
    }
    expect(product("0123")).toMatchObject({ price: 13 });
  });

  it("writes an item whose barcode ends in :bought under a key that doesn't, which the API keeps for lines bought for a client", async () => {
    const res = await post({ importId: randomUUID(), csv: "name,barcode,kind,price,cost\nStep ladder,LAD-1:bought,equipment,,120\nRope,ROPE:bought,,4,\n" });
    expect(res.status).toBe(200);
    expect(product(keyOfBarcode("LAD-1:bought"))).toMatchObject({ code: "LAD-1:bought", kind: "equipment" });
    expect(product(keyOfBarcode("ROPE:bought"))).toMatchObject({ code: "ROPE:bought", price: 4 });
    expect(products().map((p) => String(p.SK)).filter((sk) => sk.endsWith(":bought"))).toEqual([]);
    expect(products().map((p) => String(p.key)).sort()).toEqual(["LAD-1_bought", "ROPE_bought"]);
  });

  it("imports company equipment without a price, its value in cost, and makes an item a supply again", async () => {
    expect((await post({ importId: randomUUID(), csv: "name,barcode,kind,price,cost,stock\nStep ladder,LAD-1,equipment,,120,3\nRags,R1,,1.50,,\n" })).status).toBe(200);
    expect(product("LAD-1")).toMatchObject({ code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, stock: 3 });
    expect(product("LAD-1")?.price).toBeUndefined();
    expect(product("R1")?.kind).toBeUndefined();
    expect((await post({ importId: randomUUID(), csv: "name,barcode,price\nStep ladder,LAD-1,15\n" })).status).toBe(200);
    expect(product("LAD-1")).toMatchObject({ price: 15, cost: 120, stock: 3 });
    expect(product("LAD-1")?.kind).toBeUndefined();
  });

  it("imports 200 rows in one request: items, stock movements, a finished job, and the summary", async () => {
    const id = randomUUID();
    const started = Date.now();
    const res = await post({ importId: id, csv: sampleCsv(200) });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(res).toEqual({ status: 200, body: { status: "imported", importId: id, replayed: false, summary: { rows: 200, created: 200, updated: 0, unchanged: 0 } } });
    expect(products()).toHaveLength(200);
    expect(product(keyOfBarcode("0100001"))).toMatchObject({ type: "product", version: 1, code: "0100001", name: "Item 1, large", price: 1.25, cost: 1, stock: 3, packSize: 2, updatedAt: AT });
    // Without a barcode the key comes from the name, so a re-import finds the same one
    const unnamed = products().find((p) => p.name === "Item 2, large");
    expect(unnamed).toMatchObject({ code: "", price: 2.5, stock: 6, packSize: 3 });
    expect(String(unnamed?.key)).toMatch(/^nb-[0-9a-f]{16}$/);
    expect(movements()).toHaveLength(200);
    expect(movements()[0]).toMatchObject({ type: "movement", reason: "import", tracked: true, operationId: id, userId: OWNER, at: AT });
    const job = table.get("TEAM#team-a", `IMPORT#${id}`);
    expect(job).toMatchObject({ type: "import", status: "done", total: 200, chunks: Math.ceil(200 / ROWS_PER_CHUNK), committed: 200, userId: OWNER, expiresAt: NOW / 1000 + 7 * 86400 });
    expect(counts).toMatchObject({ Writes: 200 });
    // Everything stayed in the team's partition (the LeadingKeys scope)
    expect(new Set(table.calls.flatMap((c) => c.partitions))).toEqual(new Set(["TEAM#team-a"]));
  });

  it("previews without writing: what each row creates or changes", async () => {
    seedProduct("0123", { code: "0123", name: "Nitrile gloves", price: 12.5, stock: 10 }, 4);
    const before = table.items.size;
    const res = await post({ dryRun: true, csv: "name,barcode,price,stock,Notes\nNitrile gloves,0123,13.00,10,x\nRags,,1.005,,y\n" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "preview",
      rows: [
        { line: 2, name: "Nitrile gloves", barcode: "0123", price: 13, stock: 10, key: "0123", action: "update", changes: ["price"] },
        { line: 3, name: "Rags", barcode: "", price: 1.01, key: expect.stringMatching(/^nb-/), action: "create", changes: ["name", "price"] },
      ],
      errors: [],
      errorCount: 0,
      ignoredColumns: ["Notes"],
      summary: { rows: 2, created: 1, updated: 1, unchanged: 0 },
    });
    expect(table.items.size).toBe(before);
    // A dry run may name its import ID too
    expect((await post({ dryRun: true, importId: randomUUID(), csv: "name,price\nA,1\n" })).body.status).toBe("preview");
  });

  it("reports every bad row and imports nothing", async () => {
    const csv = [
      "name,barcode,price,cost,stock,pack_size",
      "Good,1,1,1,1,1",
      ",2,1,,,",
      "No price,3,,,,",
      "Negative,4,-1,,,",
      "Bad amount,5,12.5.0,,,",
      "Fraction,6,1,,2.5,",
      "Zero pack,7,1,,,0",
      "Too much,8,1000001,,,",
      "Neg cost,9,1,$-2,,",
      "Neg stock,10,1,,(3),",
      "Huge stock,11,1,,2000000,",
      "Dup,1,1,,,",
      `${"x".repeat(201)},12,1,,,`,
      "Extra,13,1,,,,surplus",
      "Tab\tname,14,1,,,",
    ].join("\n");
    const res = await post({ importId: randomUUID(), csv });
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "bad_request", message: "14 rows have problems; nothing was imported" });
    expect(res.body.errorCount).toBe(14);
    expect(res.body.errors).toEqual([
      { line: 3, column: "name", message: "name is required" },
      { line: 4, column: "price", message: "price is required" },
      { line: 5, column: "price", message: "price can't be negative" },
      { line: 6, column: "price", message: "price isn't an amount (for example 12.50 or $1,200)" },
      { line: 7, column: "stock", message: "stock must be a whole number" },
      { line: 8, column: "pack_size", message: "pack_size must be from 1 to 10,000" },
      { line: 9, column: "price", message: "price can't be more than 1,000,000" },
      { line: 10, column: "cost", message: "cost can't be negative" },
      { line: 11, column: "stock", message: "stock can't be negative" },
      { line: 12, column: "stock", message: "stock must be from 0 to 1,000,000" },
      { line: 13, column: "barcode", message: "Line 2 has the same barcode" },
      { line: 14, column: "name", message: "name is longer than 200 characters" },
      { line: 15, message: "This row has more cells than the header has columns" },
      { line: 16, column: "name", message: "name has a control character in it" },
    ]);
    expect(products()).toEqual([]);
    expect(importItems()).toEqual([]);
    expect(movements()).toEqual([]);
    // The same file as a dry run: 200, with the problems and the rows that are fine
    const dry = await post({ dryRun: true, csv });
    expect(dry).toMatchObject({ status: 200, body: { status: "invalid", errorCount: 14, rows: [{ line: 2 }] } });
  });

  it("says one row when one row has a problem, and returns at most MAX_ERRORS problems", async () => {
    expect((await post({ importId: randomUUID(), csv: "name,price\nA,x\n" })).body.error.message).toBe("1 row has a problem; nothing was imported");
    const many = ["name,price", ...Array.from({ length: 250 }, (_, i) => `Item ${i},free`)].join("\n");
    const res = await post({ importId: randomUUID(), csv: many });
    expect(res.body.errorCount).toBe(250);
    expect(res.body.errors).toHaveLength(200);
  });

  it("reads money with $, spaces and thousands separators, and rounds to cents", async () => {
    const res = await post({ dryRun: true, csv: 'name,price,cost\nA,"$1,234.50",$ 2\nB,.5,1.005\nC,3.,0\n' });
    expect(res.body.rows.map((r: { price: number; cost?: number }) => [r.price, r.cost])).toEqual([[1234.5, 2], [0.5, 1.01], [3, 0]]);
    const bad = await post({ dryRun: true, csv: `name,price\nA,"1,23"\nB,${"1".repeat(40)}\nC,−3\nD,$(4)\nE,1e3\n` });
    expect(bad.body.errors.map((e: { message: string }) => e.message)).toEqual([
      "price isn't an amount (for example 12.50 or $1,200)",
      "price isn't an amount (for example 12.50 or $1,200)",
      "price can't be negative",
      "price can't be negative",
      "price isn't an amount (for example 12.50 or $1,200)",
    ]);
  });

  it("matches headers without regard to case or spacing, with common names for columns", async () => {
    const res = await post({ dryRun: true, csv: "ITEM NAME,UPC,Price Each,unit-cost,On Hand,case_size\nGloves,0123,2,1,5,10\n" });
    expect(res.body.rows[0]).toMatchObject({ name: "Gloves", barcode: "0123", price: 2, cost: 1, stock: 5, packSize: 10 });
  });

  it("reads quoted cells, doubled quotes, CRLF and a byte-order mark, and skips blank lines", async () => {
    const res = await post({ dryRun: true, csv: '﻿name,price\r\n\r\n"Bins, ""large""",4\r\n,\r\n  \r\nMop" head,5' });
    expect(res.body.rows.map((r: { name: string; line: number }) => [r.line, r.name])).toEqual([[3, 'Bins, "large"'], [6, 'Mop" head']]);
  });
});

describe("the file as a whole", () => {
  const refused = async (body: unknown, message: RegExp) => {
    const res = await post(body);
    expect(res).toMatchObject({ status: 400, body: { error: { code: "bad_request", message: expect.stringMatching(message) } } });
  };

  it("refuses a file without the columns it needs, or with nothing in it", async () => {
    await refused({ importId: randomUUID(), csv: "" }, /empty/);
    await refused({ importId: randomUUID(), csv: "\n  \n" }, /empty/);
    await refused({ importId: randomUUID(), csv: "barcode,price\n1,2\n" }, /needs a name column/);
    await refused({ importId: randomUUID(), csv: "name,cost\nA,2\n" }, /needs a price column/);
    await refused({ importId: randomUUID(), csv: "name,price,Price\nA,1,2\n" }, /price column appears twice/);
    await refused({ importId: randomUUID(), csv: "name,price\n" }, /no rows/);
    await refused({ importId: randomUUID(), csv: 'name,price\n"A,1\n' }, /quote that starts on line 2 never closes/);
    expect(products()).toEqual([]);
  });

  it("caps the file's size, rows and columns", async () => {
    await refused({ importId: randomUUID(), csv: "name,price\n" + "x".repeat(MAX_IMPORT_BYTES) }, /larger than 300 KB/);
    await refused({ importId: randomUUID(), csv: sampleCsv(MAX_IMPORT_ROWS + 1) }, /more than 1000 rows/);
    await refused({ importId: randomUUID(), csv: "name,price" + ",x".repeat(60) + "\n" }, /more than 50 columns/);
  });

  it("checks the request body", async () => {
    await refused({ importId: randomUUID(), csv: "name,price\nA,1\n", extra: 1 }, /Unexpected field "extra"/);
    await refused({ importId: randomUUID(), csv: 5 }, /csv must be the file's text/);
    await refused({ importId: randomUUID() }, /csv must be the file's text/);
    await refused({ importId: "not-a-uuid", csv: "name,price\nA,1\n" }, /importId must be a UUID/);
    await refused({ csv: "name,price\nA,1\n" }, /importId must be a UUID/);
    await refused({ importId: randomUUID(), csv: "name,price\nA,1\n", dryRun: "yes" }, /dryRun must be true or false/);
    await refused("[1]", /JSON object/);
  });
});

describe("importing again", () => {
  it("re-importing the same file duplicates nothing and writes nothing", async () => {
    const csv = sampleCsv(60);
    expect((await post({ importId: randomUUID(), csv })).status).toBe(200);
    const snapshot = JSON.stringify(products());
    const moves = movements().length;
    const again = await post({ importId: randomUUID(), csv });
    expect(again.body).toMatchObject({ status: "imported", replayed: false, summary: { rows: 60, created: 0, updated: 0, unchanged: 60 } });
    expect(JSON.stringify(products())).toBe(snapshot);
    expect(movements()).toHaveLength(moves);
  });

  it("updates price, cost and pack size, sets stock to the file's count, and keeps everything else", async () => {
    seedProduct("0123", { code: "0123", name: "Gloves", price: 10, cost: 7, packSize: 12, stock: 40, note: "keep" }, 5);
    seedProduct("nb-old", { code: "", name: "Rags", price: 1 }, 2);
    seedProduct("nb-bins", { name: "Bins", price: 3, stock: 2 }, 1);
    const id = randomUUID();
    const res = await post({ importId: id, csv: "name,barcode,price,cost,stock,pack_size\nNitrile gloves,0123,11,8,25,10\nrags,,1.5,,4,\nBins,,3,,,\n" });
    expect(res.body.summary).toEqual({ rows: 3, created: 0, updated: 2, unchanged: 1 });
    expect(product("0123")).toMatchObject({ version: 6, code: "0123", name: "Nitrile gloves", price: 11, cost: 8, packSize: 10, stock: 25, note: "keep" });
    // Matched by name; a blank cost keeps none, and stock starts being tracked
    expect(product("nb-old")).toMatchObject({ version: 3, name: "rags", price: 1.5, stock: 4 });
    expect(product("nb-old")?.cost).toBeUndefined();
    // Nothing changed: not written, and no code added
    expect(product("nb-bins")).toEqual(expect.objectContaining({ version: 1, name: "Bins", price: 3, stock: 2 }));
    expect(product("nb-bins")?.code).toBeUndefined();
    expect(movements().map((m) => [m.productKey, m.delta, m.count])).toEqual([["0123", -15, 25], ["nb-old", 4, 4]]);
  });

  it("imports a brand, keeps an item's brand on a blank cell, and leaves items without one unchanged (supply-checkout-005.9)", async () => {
    seedProduct("0123", { code: "0123", name: "Gloves", brand: "Ansell", price: 10 }, 3);
    seedProduct("nb-rags", { code: "", name: "Rags", price: 1 }, 2);
    const res = await post({ importId: randomUUID(), csv: "name,brand,barcode,price\nGloves,,0123,10\nRags,,,1\nBags, Glad ,555,4\n" });
    expect(res.body.summary).toEqual({ rows: 3, created: 1, updated: 0, unchanged: 2 });
    expect(product("0123")).toMatchObject({ version: 3, brand: "Ansell" });
    expect(product("nb-rags")).not.toHaveProperty("brand");
    expect(product("555")).toMatchObject({ name: "Bags", brand: "Glad", price: 4, version: 1 });
    await post({ importId: randomUUID(), csv: "name,brand,barcode,price\nGloves,Showa,0123,10\n" });
    expect(product("0123")).toMatchObject({ version: 4, brand: "Showa" });
  });

  it("gives an item without a barcode the file's barcode when their names match", async () => {
    seedProduct("nb-1", { code: "", name: "Mop heads", price: 4 });
    await post({ importId: randomUUID(), csv: "name,barcode,price\nMop Heads,999,4\n" });
    expect(products()).toHaveLength(1);
    expect(product("nb-1")).toMatchObject({ code: "999", name: "Mop Heads" });
  });

  it("makes a new item for a barcode it doesn't know, even when an item with a barcode has the name", async () => {
    seedProduct("111", { code: "111", name: "Gloves", price: 4 });
    await post({ importId: randomUUID(), csv: "name,barcode,price\nGloves,222,5\n" });
    expect(products()).toHaveLength(2);
    expect(product("222")).toMatchObject({ code: "222", name: "Gloves", price: 5 });
  });

  it("refuses rows that match more than one item, or the same item as another row", async () => {
    seedProduct("a", { code: "", name: "Rags", price: 1 });
    seedProduct("b", { code: "", name: "rags", price: 1 });
    seedProduct("c", { code: "55", name: "Cloth", price: 1 });
    seedProduct("d", { code: "55", name: "Cloth 2", price: 1 });
    seedProduct("e", { code: "77", name: "Sponge", price: 1 });
    const res = await post({ importId: randomUUID(), csv: "name,barcode,price\nRags,,1\nRags,88,1\nCloth,55,1\nSponge,77,1\nsponge,,1\nMop,,1\nMOP,,2\n" });
    expect(res.body.errors).toEqual([
      { line: 2, column: "name", message: "2 items in inventory match this row; delete or rename the extra ones first" },
      { line: 3, column: "name", message: "2 items in inventory match this row; delete or rename the extra ones first" },
      { line: 4, column: "barcode", message: "2 items in inventory match this row; delete or rename the extra ones first" },
      { line: 6, message: "Line 5 already updates the same item" },
      { line: 8, column: "name", message: "Line 7 has the same name, and neither has a barcode" },
    ]);
    expect(importItems()).toEqual([]);
  });

  it("finds a free key when a new item's key is taken", async () => {
    seedProduct("A_B", { code: "A B", name: "Old", price: 1 });
    await post({ importId: randomUUID(), csv: "name,barcode,price\nNew,A/B,2\nNewer,A:B,3\n" });
    expect(product("A_B-2")).toMatchObject({ code: "A/B", name: "New" });
    expect(product("A:B")).toMatchObject({ code: "A:B" });
  });
});

describe("retries and resuming", () => {
  it("replays a finished import's summary for the same importId, and refuses it for another file", async () => {
    const id = randomUUID();
    const csv = sampleCsv(10);
    const first = await post({ importId: id, csv });
    const size = table.items.size;
    const again = await post({ importId: id.toUpperCase(), csv });
    expect(again.body).toEqual({ ...first.body, replayed: true });
    expect(table.items.size).toBe(size);
    expect(counts.Writes).toBe(10);
    expect(await post({ importId: id, csv: sampleCsv(11) })).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(/already used for a different file/) } } });
    // The job is the file's, not the owner's: another owner gets the same summary
    table.put({ PK: "TEAM#team-a", SK: "MEMBER#user-owner-2", type: "member", teamId: "team-a", userId: "user-owner-2", role: "owner" });
    expect(await post({ importId: id, csv }, "user-owner-2")).toMatchObject({ status: 200, body: { replayed: true } });
  });

  it("finishes an import that stopped part-way when the same request comes again, without doubling anything", async () => {
    const id = randomUUID();
    const csv = sampleCsv(200);
    let transactions = 0;
    table.beforeTransactWrite = () => {
      // Staging, then two chunks, then the connection drops
      if (++transactions === 4) throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    };
    const failed = await post({ importId: id, csv });
    expect(failed).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
    expect(products()).toHaveLength(2 * ROWS_PER_CHUNK);
    // Listed for the stuck-import check while it's committing
    expect(table.get("TEAM#team-a", `IMPORT#${id}`)).toMatchObject({
      status: "committing",
      committed: 2 * ROWS_PER_CHUNK,
      GSI1PK: "IMPORTS#COMMITTING",
      GSI1SK: expect.stringMatching(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT[^#]+#${id}$`)),
    });

    const done = await post({ importId: id, csv });
    expect(done.body).toMatchObject({ status: "imported", replayed: false, summary: { created: 200 } });
    // and not once it's done
    const job = table.get("TEAM#team-a", `IMPORT#${id}`);
    expect(job).toMatchObject({ status: "done" });
    expect(job).not.toHaveProperty("GSI1PK");
    expect(job).not.toHaveProperty("GSI1SK");
    expect(products()).toHaveLength(200);
    expect(movements()).toHaveLength(200);
    expect(new Set(movements().map((m) => m.productKey)).size).toBe(200);
  });

  it("carries on when a concurrent retry of the same import committed the chunk first", async () => {
    const id = randomUUID();
    let raced = false;
    table.beforeTransactWrite = () => {
      const job = table.get("TEAM#team-a", `IMPORT#${id}`);
      if (!raced && job && job.committed === 0) {
        raced = true;
        table.put({ ...job, committed: 1, status: "done" });
      }
    };
    const res = await post({ importId: id, csv: "name,price\nA,1\n" });
    expect(res.body).toMatchObject({ status: "imported" });
    // The other request wrote the item; this one didn't write it again
    expect(products()).toEqual([]);
  });

  it("uses the plan a concurrent request staged first", async () => {
    const id = randomUUID();
    const csv = "name,price\nA,1\n";
    let staged = false;
    table.beforeTransactWrite = () => {
      if (staged) return;
      staged = true;
      table.put({ PK: "TEAM#team-a", SK: `IMPORT#${id}`, type: "import", importId: id, request: "other", status: "committing", chunks: 1, committed: 0, summary: {} });
    };
    // Staged by someone with a different file: refused
    expect(await post({ importId: id, csv })).toMatchObject({ status: 400, body: { error: { message: expect.stringMatching(/different file/) } } });
    expect(products()).toEqual([]);
  });

  it("re-reads and retries a chunk when an item changes under it", async () => {
    seedProduct("0123", { code: "0123", name: "Gloves", price: 10, stock: 5 }, 2);
    let bumped = 0;
    table.beforeTransactWrite = () => {
      const p = product("0123");
      // Someone checks one out after the import read the item, twice
      if (p && p.price === 10 && bumped < 2 && table.get("TEAM#team-a", `IMPORT#${id}`)) {
        bumped++;
        table.put({ ...p, stock: (p.stock as number) - 1 });
      }
    };
    const id = randomUUID();
    const res = await post({ importId: id, csv: "name,barcode,price,stock\nGloves,0123,11,20\n" });
    expect(res.body).toMatchObject({ status: "imported" });
    expect(product("0123")).toMatchObject({ price: 11, stock: 20, version: 3 });
    // The movement's delta is from the stock the committed transaction saw
    expect(movements().map((m) => m.delta)).toEqual([17]);
  });

  it("gives up with 409 when items keep changing, and can be finished later", async () => {
    seedProduct("0123", { code: "0123", name: "Gloves", price: 10, stock: 5 }, 2);
    const id = randomUUID();
    let busy = true;
    table.beforeTransactWrite = () => {
      const p = product("0123") as Record<string, unknown>;
      if (busy && table.get("TEAM#team-a", `IMPORT#${id}`)) table.put({ ...p, version: (p.version as number) + 1 });
    };
    const res = await post({ importId: id, csv: "name,barcode,price\nGloves,0123,11\n" });
    expect(res).toMatchObject({ status: 409, body: { error: { code: "aborted", message: expect.stringMatching(/try again to finish/) } } });
    expect(product("0123")?.price).toBe(10);
    busy = false;
    expect((await post({ importId: id, csv: "name,barcode,price\nGloves,0123,11\n" })).body.status).toBe("imported");
    expect(product("0123")?.price).toBe(11);
  });

  it("says so when an unfinished import's plan has expired", async () => {
    const id = randomUUID();
    const csv = "name,price\nA,1\n";
    table.beforeTransactWrite = () => {
      throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    };
    table.put({ PK: "TEAM#team-a", SK: `IMPORT#${id}`, type: "import", importId: id, status: "committing", total: 1, chunks: 1, committed: 0, summary: {} });
    // A job whose request doesn't match is someone else's
    expect((await post({ importId: id, csv })).status).toBe(400);
    table.beforeTransactWrite = undefined;
    const request = createHash("sha256").update(csv, "utf8").digest("hex");
    table.put({ PK: "TEAM#team-a", SK: `IMPORT#${id}`, type: "import", importId: id, request, status: "committing", total: 1, chunks: 1, committed: 0, summary: {} });
    expect(await post({ importId: id, csv })).toMatchObject({ status: 409, body: { error: { message: expect.stringMatching(/expired/) } } });
  });

  it("refuses, before writing anything, a row whose item would be too large to save", async () => {
    seedProduct("0123", { code: "0123", name: "Gloves", price: 10, notes: "x".repeat(349_900) });
    const res = await post({ importId: randomUUID(), csv: "name,barcode,price\nOther,1,1\nGloves,0123,11\n" });
    expect(res).toMatchObject({ status: 400, body: { errors: [{ line: 3, message: "This item is too large to update; shorten its other fields in the app first" }] } });
    expect(importItems()).toEqual([]);
    expect(products()).toHaveLength(1);
  });

  it("splits a chunk of large items across transactions so none passes DynamoDB's 4 MB", async () => {
    const note = "x".repeat(300_000);
    for (let i = 0; i < ROWS_PER_CHUNK; i++) seedProduct(`k${i}`, { code: `c${i}`, name: `Item ${i}`, price: 1, note });
    const csv = ["name,barcode,price", ...Array.from({ length: ROWS_PER_CHUNK }, (_, i) => `Item ${i},c${i},2`)].join("\n");
    const res = await post({ importId: randomUUID(), csv });
    expect(res.body).toMatchObject({ status: "imported", summary: { updated: ROWS_PER_CHUNK } });
    expect(products().every((p) => p.price === 2 && p.note === note)).toBe(true);
    // Staging, then 8 rows (2.4 MB) at a time
    expect(table.transactions).toEqual([2, 9, 9, 9, 9, 9, 9, 2]);
  });

  it("measures maps with a constructor key as DynamoDB stores them", async () => {
    // A contributor saves items through the API whose data holds maps with a "constructor"
    // key, which the document client sends as Maps (storable in client.ts)
    for (let i = 0; i < 20; i++) {
      const key = keyOfBarcode(`c${i}`);
      const put = await handler(write("PUT", `/teams/team-a/products/${key}`, CONTRIBUTOR, { data: { code: `c${i}`, name: `Item ${i}`, price: 1, x: { constructor: 1, pad: "y".repeat(340_000) } }, expectedVersion: 0 }));
      expect(put.statusCode).toBe(200);
    }
    const csv = ["name,barcode,price", ...Array.from({ length: 20 }, (_, i) => `Item ${i},c${i},2`)].join("\n");
    const res = await post({ importId: randomUUID(), csv });
    expect(res.body).toMatchObject({ status: "imported", summary: { updated: 20 } });
    expect(products().every((p) => p.price === 2 && (p.x as { pad: string }).pad.length === 340_000)).toBe(true);
    // Staging, then 7 rows (2.4 MB) at a time
    expect(table.transactions).toEqual([2, 8, 8, 7]);
  });

  it("retries a batch DynamoDB refuses as too large with half the rows", async () => {
    for (let i = 0; i < 10; i++) seedProduct(`k${i}`, { code: `c${i}`, name: `Item ${i}`, price: 1, note: "x".repeat(200_000) });
    table.maxTransactionBytes = 900_000;
    const csv = ["name,barcode,price", ...Array.from({ length: 10 }, (_, i) => `Item ${i},c${i},2`)].join("\n");
    const res = await post({ importId: randomUUID(), csv });
    expect(res.body).toMatchObject({ status: "imported", summary: { updated: 10 } });
    // Refused batches aren't recorded: 10 and 5 rows were, then 3 went in; then 7, and 4 went in; then the last 3
    expect(table.transactions).toEqual([2, 4, 5, 4]);
    // A single row that still can't fit is too large to save
    table.maxTransactionBytes = 100_000;
    const stopped = randomUUID();
    expect(await post({ importId: stopped, csv: "name,barcode,price\nItem 0,c0,3\n" })).toMatchObject({ status: 413, body: { error: { code: "quota_exceeded", message: "The item on line 2 is too large to save" } } });
    // The logs say what DynamoDB said: its error's name and message, never the item
    expect(warnings).toEqual([["Refused as too large", { cause: { name: "ValidationException", message: "Transaction request cannot be larger than 4 MB" } }]]);
    // No retry gets past it, so it leaves the stuck-import check; the job stays
    const job = table.get("TEAM#team-a", `IMPORT#${stopped}`);
    expect(job).toMatchObject({ status: "committing" });
    expect(job).not.toHaveProperty("GSI1PK");
    expect(job).not.toHaveProperty("GSI1SK");
  });

  it("treats only DynamoDB's two size messages as too large; any other ValidationException is a 500", async () => {
    const refuse = (message: string) => {
      table.beforeTransactWrite = () => {
        // Staging goes through; the commit is refused
        if (table.get("TEAM#team-a", `IMPORT#${id}`)) throw Object.assign(new Error(message), { name: "ValidationException" });
      };
    };
    let id = randomUUID();
    refuse("Item size has exceeded the maximum allowed size");
    expect(await post({ importId: id, csv: "name,barcode,price\nItem 0,c0,3\n" })).toMatchObject({ status: 413, body: { error: { message: "The item on line 2 is too large to save" } } });
    expect(warnings).toEqual([["Refused as too large", { cause: { name: "ValidationException", message: "Item size has exceeded the maximum allowed size" } }]]);
    // Matched from the start, so anything DynamoDB adds after its message still matches
    id = randomUUID();
    refuse("Item size has exceeded the maximum allowed size (400 KB)");
    expect((await post({ importId: id, csv: "name,barcode,price\nItem 0,c0,3\n" })).status).toBe(413);
    warnings.length = 0;
    // Messages the old pattern (size, large, 4 MB) matched, which are bugs rather than a batch too large, and one that only contains DynamoDB's
    for (const message of ["One or more parameter values were invalid: Size of hashkey has exceeded the maximum size limit of 2048 bytes", "Transaction request cannot include multiple operations on one item", "Request too large: 4 MB", "Not this: Item size has exceeded the maximum allowed size"]) {
      id = randomUUID();
      refuse(message);
      const res = await post({ importId: id, csv: "name,barcode,price\nItem 0,c0,3\n" });
      expect(res.status, message).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(message);
    }
    expect(warnings).toEqual([]);
  });

  it("treats a transaction cancelled for an item's size as too large, and only that ValidationError", async () => {
    const cancel = (message: string) => {
      table.beforeTransactWrite = () => {
        if (table.get("TEAM#team-a", `IMPORT#${id}`)) {
          throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ValidationError", Message: message }, { Code: "None" }] });
        }
      };
    };
    let id = randomUUID();
    cancel("Item size has exceeded the maximum allowed size");
    expect(await post({ importId: id, csv: "name,barcode,price\nItem 0,c0,3\n" })).toMatchObject({ status: 413, body: { error: { message: "An item on line 2 or after is too large to save" } } });
    for (const message of ["One or more parameter values were invalid: Size of hashkey has exceeded the maximum size limit of 2048 bytes", "Invalid size"]) {
      id = randomUUID();
      cancel(message);
      const res = await post({ importId: id, csv: "name,barcode,price\nItem 0,c0,3\n" });
      expect(res.status, message).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain(message);
    }
  });

  it("the test table measures maps with a constructor key as DynamoDB gets them", () => {
    const pad = "y".repeat(1000);
    expect(MemoryTable.bytes({ x: new Map([["constructor", pad]]) })).toBe(MemoryTable.bytes({ x: { constructor: pad } }));
    expect(MemoryTable.bytes({ x: new Map([["constructor", pad]]) })).toBeGreaterThan(1000);
  });

  it("measures items when it commits, so items that grew after staging still fit", async () => {
    const id = randomUUID();
    const csv = ["name,barcode,price", ...Array.from({ length: 20 }, (_, i) => `Item ${i},c${i},2`)].join("\n");
    let grown = false;
    table.beforeTransactWrite = () => {
      if (grown || !table.get("TEAM#team-a", `IMPORT#${id}`)) return;
      grown = true;
      // A contributor fills every item up to the document limit after the import was staged
      for (let i = 0; i < 20; i++) seedProduct(keyOfBarcode(`c${i}`), { code: `c${i}`, name: `Item ${i}`, price: 1, note: "x".repeat(340_000) }, 2);
    };
    const res = await post({ importId: id, csv });
    expect(res.body).toMatchObject({ status: "imported" });
    expect(products().every((p) => p.price === 2 && typeof p.note === "string")).toBe(true);
    expect(table.get("TEAM#team-a", `IMPORT#${id}`)).toMatchObject({ status: "done", committed: 20 });
  });

  it("refuses a staged new item whose key another item took, and choosing the file again imports it", async () => {
    const id = randomUUID();
    const csv = "name,barcode,price\nFirst,1,1\nWidget,A#B,2\n";
    table.beforeTransactWrite = () => {
      if (table.get("TEAM#team-a", `IMPORT#${id}`) && !product("A_B")) seedProduct("A_B", { code: "A_B", name: "Someone else's", price: 9 });
    };
    const res = await post({ importId: id, csv });
    expect(res).toMatchObject({ status: 409, body: { error: { code: "aborted", message: expect.stringMatching(/line 3's key.*Choose the file again/) } } });
    expect(product("A_B")).toMatchObject({ code: "A_B", name: "Someone else's", price: 9 });
    expect(product("1")).toBeUndefined();
    // Stopped for good: out of the stuck-import check
    expect(table.get("TEAM#team-a", `IMPORT#${id}`)).toMatchObject({ status: "committing" });
    expect(table.get("TEAM#team-a", `IMPORT#${id}`)).not.toHaveProperty("GSI1PK");
    table.beforeTransactWrite = undefined;
    // The same request can't get past it; a new import plans around it
    expect((await post({ importId: id, csv })).status).toBe(409);
    expect((await post({ importId: randomUUID(), csv })).body).toMatchObject({ status: "imported", summary: { created: 2 } });
    expect(product("A_B-2")).toMatchObject({ code: "A#B", name: "Widget" });
  });

  it("applies a staged new item as an update when the same barcode got there first", async () => {
    const id = randomUUID();
    table.beforeTransactWrite = () => {
      if (table.get("TEAM#team-a", `IMPORT#${id}`) && !product("77")) seedProduct("77", { code: "77", name: "Sponge", price: 1 });
    };
    expect((await post({ importId: id, csv: "name,barcode,price\nSponge,77,3\n" })).body.status).toBe("imported");
    expect(product("77")).toMatchObject({ price: 3, version: 2 });
  });

  it("says the import expired when its job disappears mid-commit", async () => {
    const id = randomUUID();
    let dropped = false;
    table.beforeTransactWrite = () => {
      if (!dropped && table.get("TEAM#team-a", `IMPORT#${id}`)) {
        dropped = true;
        table.items.delete(`TEAM#team-a\u0000IMPORT#${id}`);
      }
    };
    expect(await post({ importId: id, csv: "name,price\nA,1\n" })).toMatchObject({ status: 409, body: { error: { message: expect.stringMatching(/expired/) } } });
  });

  it("lets another owner finish an import whose owner was demoted part-way", async () => {
    const id = randomUUID();
    const csv = sampleCsv(120);
    let transactions = 0;
    table.beforeTransactWrite = () => {
      if (++transactions === 3) throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
    };
    expect((await post({ importId: id, csv })).status).toBe(500);
    expect(products()).toHaveLength(ROWS_PER_CHUNK);
    table.beforeTransactWrite = undefined;
    table.put({ PK: "TEAM#team-a", SK: `MEMBER#${OWNER}`, type: "member", teamId: "team-a", userId: OWNER, role: "contributor" });
    table.put({ PK: "TEAM#team-a", SK: "MEMBER#user-owner-2", type: "member", teamId: "team-a", userId: "user-owner-2", role: "owner" });
    // The demoted owner can't; the other owner can, with the same file
    expect((await post({ importId: id, csv })).status).toBe(403);
    expect((await post({ importId: id, csv }, "user-owner-2")).body).toMatchObject({ status: "imported", summary: { created: 120 } });
    expect(products()).toHaveLength(120);
    expect(table.get("TEAM#team-a", `IMPORT#${id}`)).toMatchObject({ status: "done", userId: OWNER });
  });
});

describe("who can import", () => {
  it("is owners only: contributors and viewers are refused, and nothing is read or written", async () => {
    const body = { importId: randomUUID(), csv: "name,price\nA,1\n" };
    expect(await post(body, CONTRIBUTOR)).toMatchObject({ status: 403, body: { error: { code: "permission_denied", message: "Only the team's owners can do this", reason: "owners_only" } } });
    expect(await post({ ...body, dryRun: true }, CONTRIBUTOR)).toMatchObject({ status: 403 });
    expect(await post(body, VIEWER)).toMatchObject({ status: 403, body: { error: { code: "permission_denied", reason: "owners_only" } } });
    expect(products()).toEqual([]);
    expect(table.calls.filter((c) => c.command !== "TransactGetCommand")).toEqual([]);
  });

  it("can't reach another team: a non-member is refused, and an owner's import stays in their team", async () => {
    expect(await post({ importId: randomUUID(), csv: "name,price\nA,1\n" }, OUTSIDER, "team-a")).toMatchObject({ status: 403, body: { error: { code: "permission_denied" } } });
    const res = await post({ importId: randomUUID(), csv: "name,price\nA,1\n" }, OUTSIDER, "team-b");
    expect(res.status).toBe(200);
    expect(products()).toEqual([]);
    expect([...table.items.values()].filter((i) => i.PK === "TEAM#team-b" && String(i.SK).startsWith("PRODUCT#"))).toHaveLength(1);
  });
});

describe("parsing", () => {
  it("parseCsv keeps line numbers for records with line breaks in quotes, and CR line ends", () => {
    expect(parseCsv('a,b\r"x\ny",2\rz,3', { maxRecords: 10, maxFields: 5 })).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["x\ny", "2"] },
      { line: 4, cells: ["z", "3"] },
    ]);
    expect(parseCsv('"a\r\nb",1\nc,2', { maxRecords: 10, maxFields: 5 })[1]).toEqual({ line: 3, cells: ["c", "2"] });
  });

  it("parseInventoryCsv needs text, and a line break inside a name is a problem", () => {
    expect(() => parseInventoryCsv(undefined)).toThrow(/csv must be/);
    expect(parseInventoryCsv('name,price\n"A\nB",1').errors).toEqual([{ line: 2, column: "name", message: "name has a control character in it" }]);
  });

  it("the import dialog's template (src/aws/import-template.csv) passes as it is", () => {
    const template = readFileSync(new URL("../../src/aws/import-template.csv", import.meta.url), "utf8");
    const parsed = parseInventoryCsv(template);
    expect(parsed.errors).toEqual([]);
    expect(parsed.ignoredColumns).toEqual([]);
    expect(parsed.rows).toEqual([
      { line: 2, name: "EXAMPLE Glass cleaner (sample row)", brand: "EXAMPLE Brand", barcode: "EXAMPLE-0001", price: 6.5, cost: 4.25, stock: 24, packSize: 12 },
      { line: 3, name: "EXAMPLE Trash bags (sample row)", barcode: "", price: 0.4, cost: 0.25, stock: 90, packSize: 45 },
      { line: 4, name: "EXAMPLE Step ladder (sample row)", barcode: "EXAMPLE-0002", kind: "equipment", cost: 120, stock: 2 },
    ]);
    const { planned, errors } = planImport(parsed.rows, []);
    expect(errors).toEqual([]);
    expect(planned.map((r) => r.action)).toEqual(["create", "create", "create"]);
  });

  it("reads an optional kind column: blank or supply is a supply, equipment has no price and its cost is its value", () => {
    const parsed = parseInventoryCsv(
      "Name,Type,Price,Cost\nGloves,,12.5,9\nRags,Supply,2,\nLadder,Equipment,,120\nMat, company  equipment ,,35\nVacuum,equipment,199,150\nCord,tool,5,\nBins,supply,,\n",
    );
    expect(parsed.rows).toEqual([
      { line: 2, name: "Gloves", barcode: "", price: 12.5, cost: 9 },
      { line: 3, name: "Rags", barcode: "", price: 2 },
      { line: 4, name: "Ladder", barcode: "", kind: "equipment", cost: 120 },
      { line: 5, name: "Mat", barcode: "", kind: "equipment", cost: 35 },
    ]);
    expect(parsed.errors).toEqual([
      { line: 6, column: "price", message: "Company equipment has no price; leave price blank, and put what one is worth in cost" },
      { line: 7, column: "kind", message: "kind is supply or equipment (or blank for a supply)" },
      { line: 8, column: "price", message: "price is required" },
    ]);
    // A kind that isn't one is the row's one problem, even with its price blank
    expect(parseInventoryCsv("name,kind,price\nLadder,equipmentx,\n").errors).toEqual([{ line: 2, column: "kind", message: "kind is supply or equipment (or blank for a supply)" }]);
    // A bad price is reported once, not also as missing
    expect(parseInventoryCsv("name,price\nGloves,abc\n").errors).toEqual([{ line: 2, column: "price", message: expect.stringMatching(/isn't an amount/) }]);
  });

  it("planImport makes equipment of an item, and a supply of it again, and says the kind changed", () => {
    const supply = { key: "lad", code: "LAD", name: "Ladder", price: 9, cost: 120 };
    const toEquipment = planImport([{ line: 2, name: "Ladder", barcode: "LAD", kind: "equipment", cost: 120 }], [supply]).planned[0];
    expect(toEquipment).toMatchObject({ action: "update", changes: ["kind", "price"] });
    const equipment = { key: "lad", code: "LAD", name: "Ladder", kind: "equipment", cost: 120 };
    expect(planImport([{ line: 2, name: "Ladder", barcode: "LAD", kind: "equipment", cost: 120 }], [equipment]).planned[0]).toMatchObject({ action: "unchanged", changes: [] });
    expect(planImport([{ line: 2, name: "Ladder", barcode: "LAD", price: 9 }], [equipment]).planned[0]).toMatchObject({ action: "update", changes: ["kind", "price"] });
    // One that says it's a supply stays as it is
    expect(planImport([{ line: 2, name: "Rags", barcode: "", price: 2 }], [{ key: "r", code: "", name: "Rags", kind: "supply", price: 2 }]).planned[0]).toMatchObject({ action: "unchanged" });
  });

  it("reads an optional brand column (brand, make or manufacturer): trimmed, blank keeps the item's, and checked like a name (supply-checkout-005.9)", () => {
    const parsed = parseInventoryCsv(`Name,Make,Price\nGloves,  Ansell ,12.5\nRags,,2\nBags,${"b".repeat(MAX_BRAND_LENGTH)},1\nMops,${"b".repeat(MAX_BRAND_LENGTH + 1)},1\nBins,"Ster\nilite",3\n`);
    expect(parsed.rows).toEqual([
      { line: 2, name: "Gloves", brand: "Ansell", barcode: "", price: 12.5 },
      { line: 3, name: "Rags", barcode: "", price: 2 },
      { line: 4, name: "Bags", brand: "b".repeat(MAX_BRAND_LENGTH), barcode: "", price: 1 },
    ]);
    expect(parsed.errors).toEqual([
      { line: 5, column: "brand", message: `brand is longer than ${MAX_BRAND_LENGTH} characters` },
      { line: 6, column: "brand", message: "brand has a control character in it" },
    ]);
    expect(parseInventoryCsv("manufacturer,name,price\nGlad,Bags,1\n").rows[0]).toMatchObject({ brand: "Glad", name: "Bags" });
    // A brand sets the item's and says it changed; a blank one keeps it
    const gloves = { key: "g", code: "", name: "Gloves", brand: "Ansell", price: 12.5 };
    expect(planImport([{ line: 2, name: "Gloves", brand: "Showa", barcode: "", price: 12.5 }], [gloves]).planned[0]).toMatchObject({ action: "update", changes: ["brand"] });
    expect(planImport([{ line: 2, name: "Gloves", barcode: "", price: 12.5 }], [gloves]).planned[0]).toMatchObject({ action: "unchanged", changes: [] });
    expect(planImport([{ line: 2, name: "Gloves", brand: "Ansell", barcode: "", price: 12.5 }], [gloves]).planned[0]).toMatchObject({ action: "unchanged" });
    expect(planImport([{ line: 2, name: "Rags", brand: "Acme", barcode: "", price: 2 }], []).planned[0]).toMatchObject({ action: "create", changes: ["name", "brand", "price"] });
  });

  it("planImport skips an item without a usable name or barcode when indexing", () => {
    const { planned } = planImport([{ line: 2, name: "A", barcode: "", price: 1 }], [{ key: "x", name: 5, code: 7 }, { key: "y", name: " " }]);
    expect(planned[0]).toMatchObject({ action: "create" });
  });

  it("keyOfBarcode makes the app's keys", () => {
    expect(keyOfBarcode(" 0123 ")).toBe("0123");
    expect(keyOfBarcode("a b/c")).toBe("a_b_c");
    expect(keyOfBarcode("..")).toBe("x..");
    expect(keyOfBarcode("__proto__")).toBe("x__proto__");
    expect(keyOfBarcode("9".repeat(200))).toHaveLength(150);
    // Never a key the API keeps for lines bought for a client (ADR 0017), as keyOf in src/format.js
    expect(keyOfBarcode("LAD-1:bought")).toBe("LAD-1_bought");
    expect(keyOfBarcode(":bought:bought")).toBe(":bought_bought");
    expect(keyOfBarcode("bought:x")).toBe("bought:x");
  });

  it("planImport never plans a new item under a key ending in :bought", () => {
    const { planned, errors } = planImport([{ line: 2, name: "Ladder", barcode: "LAD-1:bought", price: 1 }], []);
    expect(errors).toEqual([]);
    expect(planned[0]).toMatchObject({ action: "create", barcode: "LAD-1:bought" });
    expect(planned[0]?.key).toBe(keyOfBarcode("LAD-1:bought"));
    expect(keyOfBarcode("LAD-1:bought").endsWith(":bought")).toBe(false);
  });
});
