// Low-stock alerts (supply-checkout-005.8, data/reorder.ts): the reorder
// fields' validation on the product routes, who may set them, and the stock
// changes that end the team's acknowledgment, through the data API's handler
// against the in-memory table. commands.test.ts runs the same commands on
// DynamoDB Local in CI.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { DATA_ROUTES, routeKey } from "../src/api/routes.js";
import { InvalidInputError } from "../src/data/index.js";
import { ackEnds, ackOnCount, ackOnRaise, ackRemoval, checkReorderFields } from "../src/data/reorder.js";
import type { Observability } from "../src/observability/index.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";

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

function event(method: string, path: string, user: string, body?: unknown): DataEvent {
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
    pathParameters,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(NOW / 1000 + 600) }, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function call(method: string, path: string, body?: unknown, user = CONTRIBUTOR) {
  const response = await handler(event(method, path, user, body));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const PRODUCT = "/teams/team-a/products/0123";
const gloves = { code: "0123", name: "Nitrile gloves", price: 12.5, stock: 3, reorderAt: 5, reorderQty: 24, ackedAtStock: 3 };

function seed(product: Record<string, unknown> = gloves, project: Record<string, unknown> = {}) {
  table.put({ PK: "TEAM#team-a", SK: "PRODUCT#0123", type: "product", key: "0123", version: 3, ...product });
  table.put({ PK: "TEAM#team-a", SK: "PROJECT#s1", type: "project", id: "s1", version: 1, client: "Echo", date: "2026-10-06", status: "open", items: {}, ...project });
}
const stored = () => table.get("TEAM#team-a", "PRODUCT#0123") as Record<string, unknown>;
const op = () => randomUUID();

describe("the rules (reorder.ts)", () => {
  it("checks each reorder field as a whole number in its range, and lets an unchanged stored value through", () => {
    expect(() => checkReorderFields({ reorderAt: 0, reorderQty: 1, ackedAtStock: 0 })).not.toThrow();
    expect(() => checkReorderFields({ reorderAt: 1_000_000, reorderQty: 1_000_000, ackedAtStock: 1_000_000 })).not.toThrow();
    expect(() => checkReorderFields({ name: "No reorder fields" })).not.toThrow();
    for (const bad of [-1, 1.5, "5", null, true, 1_000_001, Number.NaN, [5], { n: 5 }]) {
      expect(() => checkReorderFields({ reorderAt: bad }), String(bad)).toThrow(/reorderAt must be a whole number from 0 to 1000000/);
      expect(() => checkReorderFields({ ackedAtStock: bad }), String(bad)).toThrow(/ackedAtStock must be a whole number from 0/);
    }
    expect(() => checkReorderFields({ reorderQty: 0 })).toThrow(/reorderQty must be a whole number from 1/);
    // A stray value already stored doesn't block the item's other edits; a changed one is checked
    expect(() => checkReorderFields({ reorderAt: "5" }, { reorderAt: "5" })).not.toThrow();
    expect(() => checkReorderFields({ reorderAt: "6" }, { reorderAt: "5" })).toThrow(InvalidInputError);
    expect(() => checkReorderFields({ reorderAt: "6" }, { name: "x" })).toThrow(InvalidInputError);
  });

  it("ends an acknowledgment only when stock goes above the reorder level, or the item has no level", () => {
    expect(ackEnds(undefined, 10)).toBe(false);
    expect(ackEnds({ reorderAt: 5 }, 10)).toBe(false);
    expect(ackEnds({ reorderAt: 5, ackedAtStock: 3 }, 5)).toBe(false);
    expect(ackEnds({ reorderAt: 5, ackedAtStock: 3 }, 6)).toBe(true);
    expect(ackEnds({ ackedAtStock: 3 }, 0)).toBe(true);
    expect(ackEnds({ reorderAt: "5", ackedAtStock: 3 }, 0)).toBe(true);
  });

  it("conditions a raising stock change on what its decision was made on, and leaves checkouts alone", () => {
    const level = { names: { "#reorderAt": "reorderAt" }, values: { ":readLevel": 5 }, clauses: ["#reorderAt = :readLevel"] };
    expect(ackOnRaise(undefined, 5)).toBeUndefined();
    // A checkout (or nothing) adds nothing, acknowledged or not
    expect(ackOnRaise({ stock: 3, reorderAt: 5, ackedAtStock: 3 }, -1)).toBeUndefined();
    expect(ackOnRaise({ stock: 3, reorderAt: 5, ackedAtStock: 3 }, 0)).toBeUndefined();
    // None read: still none when it commits
    expect(ackOnRaise({ stock: 3, reorderAt: 5 }, 5)).toEqual({ remove: false, names: { "#ackedAtStock": "ackedAtStock" }, values: {}, clauses: ["attribute_not_exists(#ackedAtStock)"] });
    // One read: the level as read, and the side of it the new stock lands on (3 + 2 = 5 stays; 3 + 3 = 6 crosses)
    expect(ackOnRaise({ stock: 3, reorderAt: 5, ackedAtStock: 3 }, 2)).toEqual({ remove: false, names: level.names, values: { ...level.values, ":threshold": 3 }, clauses: [...level.clauses, "#stock <= :threshold"] });
    expect(ackOnRaise({ stock: 3, reorderAt: 5, ackedAtStock: 3 }, 3)).toEqual({
      remove: true,
      names: { ...level.names, "#ackedAtStock": "ackedAtStock" },
      values: { ...level.values, ":threshold": 2 },
      clauses: [...level.clauses, "#stock > :threshold"],
    });
    // Not counted yet: a receipt starts the count at delta, if it's still not counted
    expect(ackOnRaise({ reorderAt: 5, ackedAtStock: 0 }, 6)).toEqual({ remove: true, names: { ...level.names, "#ackedAtStock": "ackedAtStock" }, values: level.values, clauses: [...level.clauses, "attribute_not_exists(#stock)"] });
    expect(ackOnRaise({ reorderAt: 5, ackedAtStock: 0 }, 5)).toEqual({ remove: false, names: level.names, values: level.values, clauses: [...level.clauses, "attribute_not_exists(#stock)"] });
    // No level, or a stray one: always removed, while the level is still as read
    expect(ackOnRaise({ stock: 3, ackedAtStock: 3 }, 1)).toEqual({ remove: true, names: { "#reorderAt": "reorderAt", "#ackedAtStock": "ackedAtStock" }, values: {}, clauses: ["attribute_not_exists(#reorderAt)"] });
    expect(ackOnRaise({ stock: 3, reorderAt: "5", ackedAtStock: 3 }, 1)).toEqual({ remove: true, names: { "#reorderAt": "reorderAt", "#ackedAtStock": "ackedAtStock" }, values: { ":readLevel": "5" }, clauses: ["#reorderAt = :readLevel"] });
    expect(ackRemoval(undefined)).toBe("");
    expect(ackRemoval({ remove: false })).toBe("");
    expect(ackRemoval({ remove: true })).toBe(" REMOVE #ackedAtStock");
  });

  it("conditions a count on the acknowledgment and level as read", () => {
    expect(ackOnCount({ stock: 3, reorderAt: 5 }, 9)).toEqual({ remove: false, names: { "#ackedAtStock": "ackedAtStock" }, values: {}, clauses: ["attribute_not_exists(#ackedAtStock)"] });
    expect(ackOnCount({ stock: 3, reorderAt: 5, ackedAtStock: 3 }, 5)).toEqual({ remove: false, names: { "#reorderAt": "reorderAt" }, values: { ":readLevel": 5 }, clauses: ["#reorderAt = :readLevel"] });
    expect(ackOnCount({ stock: 3, reorderAt: 5, ackedAtStock: 3 }, 6)).toMatchObject({ remove: true, names: { "#ackedAtStock": "ackedAtStock" } });
  });

  it("drops an acknowledgment carried over unchanged when the level changes, and keeps one the write sets", () => {
    const stored = { reorderAt: 5, ackedAtStock: 3 };
    const write = (data: Record<string, unknown>) => (checkReorderFields(data, stored), data);
    expect(write({ reorderAt: 5, ackedAtStock: 3 })).toEqual({ reorderAt: 5, ackedAtStock: 3 });
    expect(write({ reorderAt: 8, ackedAtStock: 3 })).toEqual({ reorderAt: 8 });
    expect(write({ ackedAtStock: 3 })).toEqual({});
    expect(write({ reorderAt: 8, ackedAtStock: 2 })).toEqual({ reorderAt: 8, ackedAtStock: 2 });
    expect(write({ reorderAt: 8 })).toEqual({ reorderAt: 8 });
    // A new item's are as written
    const created = { reorderAt: 8, ackedAtStock: 3 };
    checkReorderFields(created);
    expect(created).toEqual({ reorderAt: 8, ackedAtStock: 3 });
  });
});

describe("the product routes", () => {
  it("save a reorder level, usual order and acknowledgment, and refuse ones out of range", async () => {
    seed({ code: "0123", name: "Nitrile gloves", price: 12.5, stock: 3 });
    const set = await call("PUT", PRODUCT, { data: { code: "0123", name: "Nitrile gloves", price: 12.5, stock: 3, reorderAt: 5, reorderQty: 24 }, expectedVersion: 3 });
    expect(set).toMatchObject({ status: 200, body: { version: 4, data: { reorderAt: 5, reorderQty: 24 } } });
    // Acknowledging is a PATCH of the stock as the person saw it
    const ack = await call("PATCH", PRODUCT, { data: { ackedAtStock: 3 }, expectedVersion: 4 });
    expect(ack).toMatchObject({ status: 200, body: { version: 5, data: { stock: 3, reorderAt: 5, reorderQty: 24, ackedAtStock: 3 } } });
    for (const data of [{ reorderAt: -1 }, { reorderAt: 2.5 }, { reorderAt: "5" }, { reorderQty: 0 }, { ackedAtStock: null }, { ackedAtStock: 2_000_000 }]) {
      expect(await call("PATCH", PRODUCT, { data, expectedVersion: 5 }), JSON.stringify(data)).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    }
    expect(stored()).toMatchObject({ version: 5, reorderAt: 5, reorderQty: 24, ackedAtStock: 3 });
  });

  it("never compare the acknowledgment with the stock, so an old one can't block an edit; an old version still conflicts", async () => {
    // Acknowledged at 3, and the stock has moved since (to 9, above the level, as a write from before this change could leave it)
    seed({ ...gloves, stock: 9, ackedAtStock: 3 });
    const edit = await call("PUT", PRODUCT, { data: { ...gloves, stock: 9, name: "Gloves, large" }, expectedVersion: 3 });
    expect(edit).toMatchObject({ status: 200, body: { version: 4, data: { name: "Gloves, large", ackedAtStock: 3 } } });
    // An acknowledgment made on the version before is refused like any stale write: the app shows the latest
    expect(await call("PATCH", PRODUCT, { data: { ackedAtStock: 9 }, expectedVersion: 3 })).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
  });

  it("drop the acknowledgment when a write changes the level and carries the old one over, as the app's editor does", async () => {
    seed();
    const patch = await call("PATCH", PRODUCT, { data: { reorderAt: 8 }, expectedVersion: 3 });
    expect(patch).toMatchObject({ status: 200, body: { version: 4, data: { reorderAt: 8, reorderQty: 24, stock: 3 } } });
    expect(patch.body.data).not.toHaveProperty("ackedAtStock");
    // Setting a level and a new acknowledgment together keeps the new one
    expect(await call("PATCH", PRODUCT, { data: { reorderAt: 4, ackedAtStock: 3 }, expectedVersion: 4 })).toMatchObject({ status: 200, body: { data: { reorderAt: 4, ackedAtStock: 3 } } });
    // A PUT with the level unchanged keeps it; removing the level drops it
    const rest: Record<string, unknown> = { ...gloves };
    delete rest.reorderAt;
    expect(await call("PUT", PRODUCT, { data: { ...gloves, reorderAt: 4 }, expectedVersion: 5 })).toMatchObject({ status: 200, body: { data: { ackedAtStock: 3 } } });
    const removed = await call("PUT", PRODUCT, { data: rest, expectedVersion: 6 });
    expect(removed.status).toBe(200);
    expect(removed.body.data).not.toHaveProperty("ackedAtStock");
    expect(removed.body.data).not.toHaveProperty("reorderAt");
  });

  it("let contributors and owners set levels and acknowledge, and not viewers or other teams", async () => {
    seed();
    expect((await call("PATCH", PRODUCT, { data: { ackedAtStock: 3 }, expectedVersion: 3 }, VIEWER)).status).toBe(403);
    expect((await call("PATCH", PRODUCT, { data: { reorderAt: 2 }, expectedVersion: 3 }, VIEWER)).status).toBe(403);
    expect((await call("PATCH", PRODUCT, { data: { reorderAt: 2 }, expectedVersion: 3 }, OUTSIDER)).status).toBe(403);
    expect((await call("PATCH", PRODUCT, { data: { reorderAt: 4 }, expectedVersion: 3 }, CONTRIBUTOR)).status).toBe(200);
    expect((await call("PATCH", PRODUCT, { data: { ackedAtStock: 3 }, expectedVersion: 4 }, OWNER)).status).toBe(200);
    expect(stored()).toMatchObject({ reorderAt: 4, ackedAtStock: 3, version: 5 });
  });
});

describe("stock changes and the acknowledgment", () => {
  const PROJECT = "/teams/team-a/projects/s1";
  const out = (n: number) => ({ items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: n, returned: 0 } } });

  it("a checkout never changes it", async () => {
    seed();
    const res = await call("POST", `${PROJECT}/checkout`, { operationId: op(), productKey: "0123", quantity: 2 });
    expect(res.status).toBe(200);
    expect(stored()).toMatchObject({ stock: 1, ackedAtStock: 3, version: 4 });
  });

  it("a return that stays at or below the reorder level keeps it; one that goes above ends it", async () => {
    seed(gloves, out(5));
    await call("POST", `${PROJECT}/return`, { operationId: op(), productKey: "0123", quantity: 2 });
    expect(stored()).toMatchObject({ stock: 5, ackedAtStock: 3 });
    await call("POST", `${PROJECT}/return`, { operationId: op(), productKey: "0123", quantity: 1 });
    expect(stored().stock).toBe(6);
    expect(stored()).not.toHaveProperty("ackedAtStock");
    expect(stored()).toMatchObject({ reorderAt: 5, reorderQty: 24 });
  });

  it("a receipt above the reorder level ends it, from a count or from none", async () => {
    seed();
    await call("POST", `${PRODUCT}/stock`, { operationId: op(), reason: "receipt", quantity: 1, unitCost: 9 });
    expect(stored()).toMatchObject({ stock: 4, ackedAtStock: 3 });
    await call("POST", `${PRODUCT}/stock`, { operationId: op(), reason: "receipt", quantity: 24, unitCost: 9 });
    expect(stored().stock).toBe(28);
    expect(stored()).not.toHaveProperty("ackedAtStock");

    seed({ code: "0123", name: "Nitrile gloves", price: 12.5, reorderAt: 5, ackedAtStock: 0 });
    await call("POST", `${PRODUCT}/stock`, { operationId: op(), reason: "receipt", quantity: 6, unitCost: 9 });
    expect(stored().stock).toBe(6);
    expect(stored()).not.toHaveProperty("ackedAtStock");
  });

  it("a count above the reorder level ends it, and one at or below keeps it", async () => {
    seed();
    await call("POST", `${PRODUCT}/stock`, { operationId: op(), reason: "count", count: 4, expectedStock: 3 });
    expect(stored()).toMatchObject({ stock: 4, ackedAtStock: 3 });
    await call("POST", `${PRODUCT}/stock`, { operationId: op(), reason: "count", count: 40, expectedStock: 4 });
    expect(stored().stock).toBe(40);
    expect(stored()).not.toHaveProperty("ackedAtStock");
  });

  it("decides on the stock the change applies to: one that lost a race is read again", async () => {
    seed(gloves, out(5));
    // Someone returns 3 more just before this return of 1 commits: 3 + 3 + 1 = 7 is above the level
    let raced = false;
    table.beforeTransactWrite = () => {
      if (raced) return;
      raced = true;
      table.put({ ...stored(), stock: 6, version: 4 });
    };
    const res = await call("POST", `${PROJECT}/return`, { operationId: op(), productKey: "0123", quantity: 1 });
    expect(res.status).toBe(200);
    expect(stored().stock).toBe(7);
    expect(stored()).not.toHaveProperty("ackedAtStock");
  });

  it("an import that sets stock above the reorder level ends it, and keeps the level and usual order", async () => {
    seed();
    const post = (csv: string) => call("POST", "/teams/team-a/imports", { importId: randomUUID(), csv }, OWNER);
    expect((await post("name,barcode,price,stock\nNitrile gloves,0123,12.50,4\n")).status).toBe(200);
    expect(stored()).toMatchObject({ stock: 4, ackedAtStock: 3, reorderAt: 5, reorderQty: 24 });
    expect((await post("name,barcode,price,stock\nNitrile gloves,0123,12.50,30\n")).status).toBe(200);
    expect(stored()).toMatchObject({ stock: 30, reorderAt: 5, reorderQty: 24 });
    expect(stored()).not.toHaveProperty("ackedAtStock");
  });
});
