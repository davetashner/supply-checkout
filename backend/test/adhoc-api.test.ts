// The ad hoc checkout through the data API's handler (ADR 0017, sections 4,
// 5 and 7), against the in-memory table (memory-table.ts): the quick take onto
// the team's one open ad hoc sheet, its ADHOC pointer through closing,
// reopening and deleting, the refusals on an ad hoc sheet, and moving a whole
// line to a job sheet. adhoc.test.ts runs the races against DynamoDB Local.


import { randomUUID } from "node:crypto";
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


const op = () => randomUUID();
type Line = Record<string, unknown>;
const TEAM = "TEAM#team-a";

function product(key: string, data: Record<string, unknown>, version = 1) {
  table.put({ PK: TEAM, SK: `PRODUCT#${key}`, type: "product", key, version, ...data });
}
function sheet(id: string, data: Record<string, unknown> = {}) {
  table.put({ PK: TEAM, SK: `SHEET#${id}`, type: "sheet", id, version: 1, client: "Echo", date: "2026-10-01", status: "open", items: {}, ...data });
}
function seed() {
  product("ladder", { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, stock: 4 });
  product("0123", { code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, stock: 10 });
  sheet("s1");
}
const doc = (id: string) => table.get(TEAM, `SHEET#${id}`);
const items = (id: string) => doc(id)?.items as Record<string, Line>;
const adhoc = () => table.get(TEAM, "ADHOC");
const stockOf = (key: string) => table.get(TEAM, `PRODUCT#${key}`)?.stock;
const movements = () => [...table.items.values()].filter((i) => String(i.SK).startsWith("MOVE#"));
const take = (body: Record<string, unknown>, user = CONTRIBUTOR) => call("POST", "/teams/team-a/adhoc/checkout", { operationId: op(), ...body }, user);
const patch = (id: string, data: Record<string, unknown>) => call("PATCH", `/teams/team-a/sheets/${id}`, { data, expectedVersion: doc(id)?.version });
const move = (body: Record<string, unknown>, from = "adhoc-1") => call("POST", `/teams/team-a/sheets/${from}/move`, { operationId: op(), ...body });

describe("quick take", () => {
  it("starts adhoc-1 on the first take and adds to it after, as checkouts that move stock", async () => {
    seed();
    const first = await take({ productKey: "0123", quantity: 2, date: "2026-09-30" });
    expect(first).toMatchObject({ status: 200, body: { replayed: false, result: { command: "quickTake", reason: "checkout", sheetId: "adhoc-1", sheetCreated: true, lineCreated: true, quantity: 2, stockDelta: -2 }, sheet: { id: "adhoc-1", version: 1 } } });
    expect(doc("adhoc-1")).toMatchObject({ kind: "adhoc", client: "", date: "2026-09-30", status: "open", createdBy: CONTRIBUTOR, createdAt: "2026-10-01T12:00:00.000Z", GSI1SK: "2026-09-30#adhoc-1" });
    expect(items("adhoc-1")).toEqual({ "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, out: 2, returned: 0 } });
    expect(adhoc()).toMatchObject({ type: "adhoc", count: 1, open: "adhoc-1", version: 1 });

    const second = await take({ productKey: "ladder", quantity: 1 }, OWNER);
    expect(second.body.result).toMatchObject({ sheetId: "adhoc-1", lineCreated: true, snapshot: { kind: "equipment" } });
    expect(second.body.result.sheetCreated).toBeUndefined();
    expect(items("adhoc-1").ladder).toMatchObject({ kind: "equipment", out: 1, takenBy: OWNER, takenAt: "2026-10-01T12:00:00.000Z" });
    await take({ productKey: "0123", quantity: 3 });
    expect(items("adhoc-1")["0123"]).toMatchObject({ out: 5 });
    expect(doc("adhoc-1")?.version).toBe(3);
    expect(adhoc()).toMatchObject({ count: 1, open: "adhoc-1", version: 1 });
    expect([stockOf("0123"), stockOf("ladder")]).toEqual([5, 3]);
    expect(movements().map((m) => [m.reason, m.sheetId, m.delta])).toEqual(expect.arrayContaining([["checkout", "adhoc-1", -2], ["checkout", "adhoc-1", -1], ["checkout", "adhoc-1", -3]]));
    // Quick takes are checkouts (the Checkouts stopped alarm)
    expect(counts.Checkouts).toBe(6);
  });

  it("takes a one-off item and dates a new sheet today in UTC when no date is sent", async () => {
    seed();
    expect(await take({ productKey: "k-9", quantity: 1 })).toMatchObject({ status: 400, body: { error: { message: "This item isn't in inventory; send its name and price" } } });
    const res = await take({ productKey: "k-9", quantity: 1, name: " Tarp ", price: 7 });
    expect(res.body.result).toMatchObject({ sheetId: "adhoc-1", stockDelta: 0 });
    expect(doc("adhoc-1")?.date).toBe("2026-10-01");
    expect(items("adhoc-1")["k-9"]).toEqual({ code: "", name: "Tarp", price: 7, out: 1, returned: 0 });
  });

  it("replays a retry with the same operation ID, onto the same sheet, without taking twice", async () => {
    seed();
    const body = { operationId: op(), productKey: "0123", quantity: 2 };
    const first = await call("POST", "/teams/team-a/adhoc/checkout", body);
    const again = await call("POST", "/teams/team-a/adhoc/checkout", body);
    expect(again).toMatchObject({ status: 200, body: { replayed: true, result: first.body.result } });
    expect(stockOf("0123")).toBe(8);
    expect(items("adhoc-1")["0123"]?.out).toBe(2);
    // The same ID for another request is refused
    expect(await call("POST", "/teams/team-a/adhoc/checkout", { ...body, quantity: 3 })).toMatchObject({ status: 400 });
  });

  it("refuses a bad date, a bought key, unknown fields and a viewer", async () => {
    seed();
    expect(await take({ productKey: "0123", quantity: 1, date: "2026-13-01" })).toMatchObject({ status: 400, body: { error: { message: "date must be YYYY-MM-DD" } } });
    expect(await take({ productKey: "ladder:bought", quantity: 1 })).toMatchObject({ status: 400 });
    expect(await take({ productKey: "0123", quantity: 1, sheetId: "s1" })).toMatchObject({ status: 400 });
    expect(await take({ productKey: "0123", quantity: 1 }, VIEWER)).toMatchObject({ status: 403, body: { error: { reason: "view_only" } } });
    expect(adhoc()).toBeUndefined();
  });

  it("ends two first takes at once on one sheet: the second's transaction is cancelled, and it adds to the sheet the first made", async () => {
    seed();
    let raced = false;
    table.beforeTransactWrite = () => {
      if (raced) return;
      raced = true;
      // Another person's first take commits between this one's read and its transaction
      table.put({ PK: TEAM, SK: "ADHOC", type: "adhoc", count: 1, open: "adhoc-1", version: 1 });
      sheet("adhoc-1", { kind: "adhoc", client: "", items: { ladder: { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } });
    };
    const res = await take({ productKey: "0123", quantity: 2 });
    expect(res.body.result).toMatchObject({ sheetId: "adhoc-1", lineCreated: true });
    expect(res.body.result.sheetCreated).toBeUndefined();
    expect(Object.keys(items("adhoc-1")).sort()).toEqual(["0123", "ladder"]);
    expect(table.get(TEAM, "SHEET#adhoc-2")).toBeUndefined();
    expect(stockOf("0123")).toBe(8);
  });

  it("starts the next sheet when the pointer names one that's gone or closed, and steps past IDs already taken", async () => {
    seed();
    table.put({ PK: TEAM, SK: "ADHOC", type: "adhoc", count: 2, open: "adhoc-2", version: 4 });
    sheet("adhoc-2", { kind: "adhoc", status: "closed" });
    // Made outside the count (a restore, say)
    sheet("adhoc-3", { kind: "adhoc", status: "closed" });
    const res = await take({ productKey: "0123", quantity: 1 });
    expect(res.body.result).toMatchObject({ sheetId: "adhoc-4", sheetCreated: true });
    expect(adhoc()).toMatchObject({ count: 4, open: "adhoc-4", version: 5 });
    // A pointer naming a sheet that isn't there
    table.put({ PK: TEAM, SK: "ADHOC", type: "adhoc", count: 4, open: "adhoc-9", version: 5 });
    expect((await take({ productKey: "0123", quantity: 1 })).body.result.sheetId).toBe("adhoc-5");
  });

  it("gives up after stepping past too many taken IDs", async () => {
    seed();
    for (let n = 1; n <= 21; n++) sheet(`adhoc-${n}`, { kind: "adhoc", status: "closed" });
    expect(await take({ productKey: "0123", quantity: 1 })).toMatchObject({ status: 409 });
    expect(stockOf("0123")).toBe(10);
  });
});

describe("the ad hoc sheet's rules", () => {
  it("takes no checkouts, receipt lines or lost charges, and no document write makes one or names one adhoc-", async () => {
    seed();
    await take({ productKey: "ladder", quantity: 1 });
    expect(await call("POST", "/teams/team-a/sheets/adhoc-1/checkout", { operationId: op(), productKey: "0123", quantity: 1 })).toMatchObject({ status: 400, body: { error: { message: "Take items for no job with Quick take, not onto the ad hoc sheet" } } });
    expect(await call("POST", "/teams/team-a/sheets/adhoc-1/lines", { operationId: op(), lines: [{ productKey: "0123", quantity: 1, name: "Gloves", price: 1 }] })).toMatchObject({ status: 400, body: { error: { message: "A receipt's lines go on a client's sheet, not the ad hoc sheet" } } });
    expect(await call("POST", "/teams/team-a/sheets/adhoc-1/lost", { operationId: op(), productKey: "ladder", quantity: 1, charge: 5 })).toMatchObject({ status: 400 });
    // Lost without a charge is fine
    expect(await call("POST", "/teams/team-a/sheets/adhoc-1/lost", { operationId: op(), productKey: "ladder", quantity: 1 })).toMatchObject({ status: 200 });
    expect(await call("PUT", "/teams/team-a/sheets/adhoc-2", { data: { client: "", date: "2026-10-01", status: "open", items: {} }, expectedVersion: 0 })).toMatchObject({ status: 400, body: { error: { message: 'Sheet IDs starting "adhoc-" are kept for the ad hoc sheet, which Quick take makes' } } });
    expect(await call("PUT", "/teams/team-a/sheets/s9", { data: { kind: "adhoc", client: "", date: "2026-10-01" }, expectedVersion: 0 })).toMatchObject({ status: 400 });
    expect(await patch("adhoc-1", { kind: null })).toMatchObject({ status: 400 });
    // An ordinary edit of the ad hoc sheet is still a document write
    expect(await patch("adhoc-1", { note: "Van" })).toMatchObject({ status: 200 });
  });

  it("clears the pointer when it's finished, so the next take starts adhoc-2, and closes only once equipment is accounted for", async () => {
    seed();
    await take({ productKey: "ladder", quantity: 1 });
    expect(await patch("adhoc-1", { status: "closed" })).toMatchObject({ status: 409, body: { error: { reason: "equipment_out" } } });
    await call("POST", "/teams/team-a/sheets/adhoc-1/return", { operationId: op(), productKey: "ladder", quantity: 1 });
    expect(await patch("adhoc-1", { status: "closed", closedAt: "2026-10-01T12:00:00.000Z" })).toMatchObject({ status: 200 });
    expect(adhoc()).toEqual({ PK: TEAM, SK: "ADHOC", type: "adhoc", count: 1, version: 2, updatedAt: "2026-10-01T12:00:00.000Z" });
    expect((await take({ productKey: "0123", quantity: 1 })).body.result).toMatchObject({ sheetId: "adhoc-2", sheetCreated: true });
    expect(adhoc()).toMatchObject({ count: 2, open: "adhoc-2" });
  });

  it("reopens a finished one only while no other is open, and points at it", async () => {
    seed();
    await take({ productKey: "0123", quantity: 1 });
    await patch("adhoc-1", { status: "closed" });
    await take({ productKey: "0123", quantity: 1 });
    const refused = await patch("adhoc-1", { status: "open" });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "aborted", reason: "adhoc_open", message: "Another ad hoc sheet is open. Finish it before reopening this one." } } });
    // The refusal working as meant, not a lost race
    expect(counts.ConditionalWriteConflicts).toBeUndefined();
    expect(doc("adhoc-1")?.status).toBe("closed");

    await patch("adhoc-2", { status: "closed" });
    expect(await patch("adhoc-1", { status: "open" })).toMatchObject({ status: 200 });
    expect(adhoc()).toMatchObject({ count: 2, open: "adhoc-1" });
    expect((await take({ productKey: "0123", quantity: 4 })).body.result.sheetId).toBe("adhoc-1");
    expect(items("adhoc-1")["0123"]?.out).toBe(5);
  });

  it("reopens when the pointer names a sheet that's gone, and when the team has no pointer (an import, say)", async () => {
    seed();
    sheet("adhoc-3", { kind: "adhoc", status: "closed" });
    table.put({ PK: TEAM, SK: "ADHOC", type: "adhoc", count: 5, open: "adhoc-5", version: 2 });
    expect(await patch("adhoc-3", { status: "open" })).toMatchObject({ status: 200 });
    expect(adhoc()).toMatchObject({ count: 5, open: "adhoc-3", version: 3 });
    table.delete(TEAM, "ADHOC");
    await patch("adhoc-3", { status: "closed" });
    expect(adhoc()).toBeUndefined();
    expect(await patch("adhoc-3", { status: "open" })).toMatchObject({ status: 200 });
    expect(adhoc()).toMatchObject({ count: 3, open: "adhoc-3", version: 1 });
    // Closing one the pointer doesn't name leaves the pointer alone
    sheet("adhoc-2", { kind: "adhoc" });
    await patch("adhoc-2", { status: "closed" });
    expect(adhoc()).toMatchObject({ open: "adhoc-3", version: 1 });
  });

  it("clears the pointer when the open one is deleted, and the next take starts the one after", async () => {
    seed();
    await take({ productKey: "0123", quantity: 2 });
    expect(await call("DELETE", "/teams/team-a/sheets/adhoc-1", undefined, CONTRIBUTOR, { expectedVersion: "9" })).toMatchObject({ status: 409 });
    expect(await call("DELETE", "/teams/team-a/sheets/adhoc-1", undefined, CONTRIBUTOR, { expectedVersion: "1" })).toMatchObject({ status: 204 });
    expect(doc("adhoc-1")).toBeUndefined();
    expect(adhoc()).toMatchObject({ count: 1, version: 2 });
    expect(adhoc()?.open).toBeUndefined();
    // Stock doesn't change, as for any sheet
    expect(stockOf("0123")).toBe(8);
    expect((await take({ productKey: "0123", quantity: 1 })).body.result.sheetId).toBe("adhoc-2");
    // A closed one, or one that's gone, deletes without touching the pointer
    await patch("adhoc-2", { status: "closed" });
    sheet("adhoc-7", { kind: "adhoc", status: "closed", version: undefined });
    expect(await call("DELETE", "/teams/team-a/sheets/adhoc-7", undefined, CONTRIBUTOR, { expectedVersion: "1" })).toMatchObject({ status: 204 });
    expect(await call("DELETE", "/teams/team-a/sheets/adhoc-2", undefined, CONTRIBUTOR, { expectedVersion: "2" })).toMatchObject({ status: 204 });
    expect(await call("DELETE", "/teams/team-a/sheets/adhoc-2", undefined, CONTRIBUTOR, { expectedVersion: "0" })).toMatchObject({ status: 204 });
    expect(adhoc()).toMatchObject({ count: 2, version: 4 });
  });
});

describe("moving an ad hoc line to a job sheet", () => {
  it("moves the whole line with its snapshot to a sheet without one, in one transaction, without moving stock", async () => {
    seed();
    await take({ productKey: "0123", quantity: 5 });
    await call("POST", "/teams/team-a/sheets/adhoc-1/return", { operationId: op(), productKey: "0123", quantity: 1 });
    // The item's price changes after the take; the moved line keeps the price it was taken at
    product("0123", { code: "0123", name: "Nitrile gloves", price: 20, stock: 6 }, 3);
    const res = await move({ productKey: "0123", toSheetId: "s1" });
    expect(res).toMatchObject({
      status: 200,
      body: {
        replayed: false,
        result: { command: "move", reason: "move", productKey: "0123", sheetId: "adhoc-1", toSheetId: "s1", quantity: 5, returned: 1, lost: 0, stockDelta: 0, lineCreated: true },
        sheet: { id: "adhoc-1", version: 3 },
        toSheet: { id: "s1", version: 2 },
        product: null,
      },
    });
    expect(items("adhoc-1")).toEqual({});
    expect(items("s1")["0123"]).toEqual({ code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, out: 5, returned: 1 });
    expect(stockOf("0123")).toBe(6);
    const moved = movements().find((m) => m.reason === "move");
    expect(moved).toMatchObject({ productKey: "0123", delta: 0, tracked: true, quantity: 5, returned: 1, lost: 0, sheetId: "s1", fromSheetId: "adhoc-1", userId: CONTRIBUTOR });
    expect(counts.Writes).toBeGreaterThan(0);
  });

  it("adds the counts to the job sheet's line, keeping its price, and names the later taker of equipment", async () => {
    seed();
    sheet("s1", {
      items: {
        "0123": { code: "0123", name: "Gloves (job)", price: 11, out: 2, returned: 1 },
        ladder: { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0, takenBy: OWNER, takenAt: "2026-09-30T08:00:00.000Z" },
      },
    });
    await take({ productKey: "0123", quantity: 3 });
    await take({ productKey: "ladder", quantity: 2 });
    await call("POST", "/teams/team-a/sheets/adhoc-1/lost", { operationId: op(), productKey: "ladder", quantity: 1 });
    expect((await move({ productKey: "0123", toSheetId: "s1" })).body.result).toMatchObject({ lineCreated: false, quantity: 3, returned: 0 });
    expect(items("s1")["0123"]).toEqual({ code: "0123", name: "Gloves (job)", price: 11, out: 5, returned: 1 });
    expect((await move({ productKey: "ladder", toSheetId: "s1" })).body.result).toMatchObject({ quantity: 2, lost: 1 });
    expect(items("s1").ladder).toEqual({ code: "LAD-1", name: "Step ladder", kind: "equipment", out: 3, returned: 0, lost: 1, takenBy: CONTRIBUTOR, takenAt: "2026-10-01T12:00:00.000Z" });
    expect(items("adhoc-1")).toEqual({});
  });

  it("keeps the job sheet's taker when it's the later one, and records one with none", async () => {
    seed();
    sheet("s1", { items: { ladder: { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0, takenBy: OWNER, takenAt: "2026-10-02T08:00:00.000Z" } } });
    sheet("s2", { items: { ladder: { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } });
    await take({ productKey: "ladder", quantity: 1 });
    await move({ productKey: "ladder", toSheetId: "s1" });
    expect(items("s1").ladder).toMatchObject({ out: 2, takenBy: OWNER, takenAt: "2026-10-02T08:00:00.000Z" });
    await take({ productKey: "ladder", quantity: 1 });
    await move({ productKey: "ladder", toSheetId: "s2" });
    expect(items("s2").ladder).toMatchObject({ out: 2, takenBy: CONTRIBUTOR });
  });

  it("moves onto a job sheet with no items yet", async () => {
    seed();
    sheet("s3", { items: undefined });
    await take({ productKey: "0123", quantity: 1 });
    expect(await move({ productKey: "0123", toSheetId: "s3" })).toMatchObject({ status: 200 });
    expect(items("s3")).toEqual({ "0123": expect.objectContaining({ out: 1 }) });
  });

  it("applies a retry once", async () => {
    seed();
    await take({ productKey: "0123", quantity: 4 });
    const body = { operationId: op(), productKey: "0123", toSheetId: "s1" };
    const first = await call("POST", "/teams/team-a/sheets/adhoc-1/move", body);
    const again = await call("POST", "/teams/team-a/sheets/adhoc-1/move", body);
    expect(again).toMatchObject({ status: 200, body: { replayed: true, result: first.body.result } });
    expect(items("s1")["0123"]?.out).toBe(4);
    expect(movements().filter((m) => m.reason === "move")).toHaveLength(1);
    expect(await call("POST", "/teams/team-a/sheets/adhoc-1/move", { ...body, toSheetId: "s2" })).toMatchObject({ status: 400 });
  });

  it("reads again when the ad hoc sheet changes between the read and the transaction, and moves the counts as they are then", async () => {
    seed();
    await take({ productKey: "0123", quantity: 4 });
    let raced = false;
    table.beforeTransactWrite = () => {
      if (raced) return;
      raced = true;
      // A return lands on the ad hoc line meanwhile
      const s = doc("adhoc-1") as Record<string, unknown>;
      table.put({ ...s, version: (s.version as number) + 1, items: { "0123": { ...(s.items as Record<string, Line>)["0123"], returned: 1 } } });
    };
    expect((await move({ productKey: "0123", toSheetId: "s1" })).body.result).toMatchObject({ quantity: 4, returned: 1 });
    expect(items("s1")["0123"]).toMatchObject({ out: 4, returned: 1 });
  });

  it("refuses moves that aren't from the open ad hoc sheet to an open job sheet, or that don't fit", async () => {
    seed();
    sheet("s1", { items: { ladder: { code: "LAD-1", name: "Step ladder", price: 9, out: 1, returned: 0 } } });
    sheet("closed", { status: "closed" });
    await take({ productKey: "0123", quantity: 1 });
    await take({ productKey: "ladder", quantity: 1 });
    const refusals: [Record<string, unknown>, string, number, string?][] = [
      [{ productKey: "0123", toSheetId: "adhoc-1" }, "adhoc-1", 400, "A line moves to a client's sheet only"],
      [{ productKey: "0123", toSheetId: "s1" }, "s1", 400, "Only a line on the open ad hoc sheet moves to a job sheet"],
      [{ productKey: "0123", toSheetId: "nope" }, "adhoc-1", 404, "No such job sheet"],
      [{ productKey: "0123", toSheetId: "closed" }, "adhoc-1", 409],
      [{ productKey: "0123", toSheetId: "s1" }, "gone", 404],
      [{ productKey: "rope", toSheetId: "s1" }, "adhoc-1", 400, "This item isn't on this sheet"],
      [{ productKey: "ladder", toSheetId: "s1" }, "adhoc-1", 400, "The job sheet has this item as a supply; correct the lines by hand"],
      [{ productKey: "0123", toSheetId: "bad/id" }, "adhoc-1", 400],
      [{ productKey: "0123" }, "adhoc-1", 400],
      [{ productKey: "0123", toSheetId: "s1", quantity: 1 }, "adhoc-1", 400],
    ];
    for (const [body, from, status, message] of refusals) {
      const res = await move(body, from);
      expect(res.status, JSON.stringify(body)).toBe(status);
      if (message) expect(res.body.error.message).toBe(message);
    }
    sheet("s2", { items: { "0123": { code: "0123", name: "Gloves", kind: "equipment", out: 1, returned: 0 } } });
    expect(await move({ productKey: "0123", toSheetId: "s2" })).toMatchObject({ status: 400, body: { error: { message: "The job sheet has this item as company equipment; correct the lines by hand" } } });
    expect(await call("POST", "/teams/team-a/sheets/adhoc-1/move", { operationId: op(), productKey: "0123", toSheetId: "s1" }, VIEWER)).toMatchObject({ status: 403 });
    expect(Object.keys(items("adhoc-1")).sort()).toEqual(["0123", "ladder"]);
  });

  it("moves only from the ad hoc sheet the team's pointer names, checked in the transaction", async () => {
    seed();
    await take({ productKey: "0123", quantity: 1 });
    // An open ad hoc sheet the pointer doesn't name (a restore, say)
    sheet("adhoc-7", { kind: "adhoc", client: "", items: { "0123": { name: "Gloves", price: 1, out: 1, returned: 0 } } });
    expect(await move({ productKey: "0123", toSheetId: "s1" }, "adhoc-7")).toMatchObject({ status: 400, body: { error: { message: "Only a line on the open ad hoc sheet moves to a job sheet" } } });
    // The pointer moves away between the read and the transaction: it reads again and refuses
    let raced = false;
    table.beforeTransactWrite = () => {
      if (raced) return;
      raced = true;
      table.put({ PK: TEAM, SK: "ADHOC", type: "adhoc", count: 7, open: "adhoc-7", version: 9 });
    };
    expect(await move({ productKey: "0123", toSheetId: "s1" })).toMatchObject({ status: 400 });
    expect(items("adhoc-1")["0123"]).toBeDefined();
    expect(items("s1")).toEqual({});
  });

  it("checks in the transaction that the job sheet's line is still the kind it was read as", async () => {
    seed();
    sheet("s1", { items: { "0123": { code: "0123", name: "Gloves", price: 11, out: 1, returned: 0 } } });
    await take({ productKey: "0123", quantity: 2 });
    let raced = false;
    table.beforeTransactWrite = () => {
      if (raced) return;
      raced = true;
      // The job line is replaced by an equipment line meanwhile
      sheet("s1", { items: { "0123": { code: "0123", name: "Gloves", kind: "equipment", out: 1, returned: 0 } } });
    };
    expect(await move({ productKey: "0123", toSheetId: "s1" })).toMatchObject({ status: 400, body: { error: { message: "The job sheet has this item as company equipment; correct the lines by hand" } } });
    expect(items("s1")["0123"]?.out).toBe(1);
  });

  it("refuses a closed ad hoc sheet, a bought or malformed line, and a job sheet it would take past the size limit", async () => {
    seed();
    table.put({ PK: TEAM, SK: "ADHOC", type: "adhoc", count: 1, open: "adhoc-1", version: 1 });
    sheet("adhoc-1", { kind: "adhoc", client: "", items: { "x:bought": { name: "X", price: 1, purchased: true, out: 1, returned: 0 }, bad: "nope", odd: { name: "Odd", price: 1, out: 1.5, returned: 0 }, big: { name: "Big", price: 1, out: 1, returned: 0 } } });
    sheet("s2", { items: { big: "nope" } });
    expect(await move({ productKey: "x:bought", toSheetId: "s1" })).toMatchObject({ status: 400, body: { error: { message: "This line was bought for a client and doesn't move" } } });
    expect(await move({ productKey: "bad", toSheetId: "s1" })).toMatchObject({ status: 400 });
    expect(await move({ productKey: "odd", toSheetId: "s1" })).toMatchObject({ status: 400 });
    expect(await move({ productKey: "big", toSheetId: "s2" })).toMatchObject({ status: 400, body: { error: { message: "The job sheet's line for this item is malformed; correct it first" } } });
    sheet("s3", { padding: "x".repeat(349_990) });
    expect(await move({ productKey: "big", toSheetId: "s3" })).toMatchObject({ status: 413 });
    sheet("adhoc-1", { kind: "adhoc", status: "closed", items: { big: { name: "Big", price: 1, out: 1, returned: 0 } } });
    expect(await move({ productKey: "big", toSheetId: "s1" })).toMatchObject({ status: 409 });
  });
});
