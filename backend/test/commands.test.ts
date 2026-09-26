// The inventory commands against DynamoDB Local (CI): the transactions as
// DynamoDB runs them, including concurrent checkouts on one line.
// commands-api.test.ts covers the handler in memory.

import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  adjustStockCommand,
  checkout,
  ConflictError,
  createInvite,
  createSheet,
  createTeam,
  type Db,
  ForbiddenError,
  getDocument,
  InvalidInputError,
  listMovements,
  type Movement,
  NotFoundError,
  returnItems,
  setDocument,
  type TeamContext,
  TooLargeError,
  updateDocument,
} from "../src/data/index.js";
import { connection } from "../src/data/client.js";
import { keys } from "../src/data/keys.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

describe.skipIf(!endpoint)("inventory commands (DynamoDB Local)", () => {
  const table = useTable();
  let db: Db;

  async function team(): Promise<TeamContext> {
    db = table.db;
    const ctx = (await createTeam(db, { userId: newUser() }, { name: "Echo" })).context;
    await setDocument(db, ctx, "products", "0123", { code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, stock: 100 });
    await setDocument(db, ctx, "sheets", "s1", { client: "Echo", date: "2026-09-26", status: "open", items: {} });
    return ctx;
  }

  const line = async (ctx: TeamContext, key = "0123") => ((await getDocument(db, ctx, "sheets", "s1"))?.data.items as Record<string, Record<string, unknown>>)[key];
  const stock = async (ctx: TeamContext) => (await getDocument(db, ctx, "products", "0123"))?.data.stock;
  async function history(ctx: TeamContext, key = "0123"): Promise<Movement[]> {
    const out: Movement[] = [];
    let cursor: string | undefined;
    do {
      const page = await listMovements(db, ctx, key, { limit: 7, cursor });
      out.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return out;
  }

  it("checks out, returns and adjusts stock in one transaction each, with a movement for every change", async () => {
    const ctx = await team();
    // A second apart each, so the history's order is certain
    let clock = Date.parse("2026-09-26T12:00:00.000Z");
    const tick = () => new Date((clock += 1000));
    const out = await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 5 }, tick());
    expect(out).toMatchObject({ replayed: false, result: { lineCreated: true, stockDelta: -5, snapshot: { code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99 } } });
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 2 }, tick());
    await returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 3 }, tick());
    await adjustStockCommand(db, ctx, { operationId: randomUUID(), productKey: "0123", reason: "receipt", quantity: 12, unitCost: 0.75 }, tick());
    expect(await line(ctx)).toEqual({ code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, out: 7, returned: 3 });
    expect(await stock(ctx)).toBe(100 - 7 + 3 + 12);
    await adjustStockCommand(db, ctx, { operationId: randomUUID(), productKey: "0123", reason: "count", count: 90 }, tick());
    expect(await stock(ctx)).toBe(90);

    // Movements sum to the stock change, and the line's sum to its counts
    const moves = await history(ctx);
    expect(moves.map((m) => m.reason)).toEqual(["count", "receipt", "return", "checkout", "checkout"]);
    expect(moves.reduce((sum, m) => sum + m.delta, 0)).toBe(90 - 100);
    expect(moves.find((m) => m.reason === "receipt")).toMatchObject({ unitCost: 0.75, quantity: 12, delta: 12 });
    // The sheet's version moved with every line change, for the edit screens' conditional writes
    expect((await getDocument(db, ctx, "sheets", "s1"))?.version).toBe(1 + 3);
    // Operation records expire after a week
    const op = await rawItem(db, `TEAM#${ctx.teamId}`, `OP#${out.result.operationId}`);
    expect(op?.expiresAt).toBe(Date.parse("2026-09-26T12:00:01.000Z") / 1000 + 7 * 86400);
  });

  it("changes nothing when an operation is replayed, and returns the first result", async () => {
    const ctx = await team();
    const input = { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 4 };
    const first = await checkout(db, ctx, input);
    const sheetBefore = await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#s1");
    const productBefore = await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#0123");
    const again = await checkout(db, ctx, input, new Date(Date.now() + 60_000));
    expect(again).toEqual({ result: first.result, replayed: true });
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#s1")).toEqual(sheetBefore);
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#0123")).toEqual(productBefore);
    expect(await history(ctx)).toHaveLength(1);
    // The same ID for a different request is refused
    await expect(checkout(db, ctx, { ...input, quantity: 5 })).rejects.toThrow(InvalidInputError);
    await expect(returnItems(db, ctx, input)).rejects.toThrow(InvalidInputError);
  });

  it("applies a double tap once, however many copies arrive at the same moment", async () => {
    const ctx = await team();
    const input = { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 3 };
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, () => checkout(db, ctx, input)));
    const done = outcomes.filter((o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof checkout>>> => o.status === "fulfilled");
    // Copies that lost every race give up with a conflict, having changed nothing
    for (const o of outcomes) if (o.status === "rejected") expect(o.reason).toBeInstanceOf(ConflictError);
    expect(done.filter((o) => !o.value.replayed)).toHaveLength(1);
    expect(await line(ctx)).toMatchObject({ out: 3 });
    expect(await stock(ctx)).toBe(97);
    expect(await history(ctx)).toHaveLength(1);
  });

  it("never loses a count when checkouts on one line run concurrently", async () => {
    const ctx = await team();
    const inputs = Array.from({ length: 12 }, (_, i) => ({ operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: (i % 3) + 1 }));
    const total = inputs.reduce((sum, i) => sum + i.quantity, 0);
    const first = await Promise.allSettled(inputs.map((input) => checkout(db, ctx, input)));
    for (const o of first) if (o.status === "rejected") expect(o.reason).toBeInstanceOf(ConflictError);
    // What succeeded is all there: nothing lost, nothing doubled
    const applied = inputs.filter((_, i) => first[i]?.status === "fulfilled").reduce((sum, i) => sum + i.quantity, 0);
    expect(await line(ctx)).toMatchObject({ out: applied, returned: 0 });
    expect(await stock(ctx)).toBe(100 - applied);
    // The client retries the rest with the same IDs; replays of the others change nothing
    for (const input of inputs) await checkout(db, ctx, input);
    expect(await line(ctx)).toMatchObject({ out: total, returned: 0 });
    expect(await stock(ctx)).toBe(100 - total);
    const moves = await history(ctx);
    expect(moves).toHaveLength(inputs.length);
    expect(moves.reduce((sum, m) => sum + m.delta, 0)).toBe(-total);
  });

  it("never lets concurrent returns take a line past what went out", async () => {
    const ctx = await team();
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 5 });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 1 })));
    const returned = outcomes.filter((o) => o.status === "fulfilled").length;
    expect(returned).toBeLessThanOrEqual(5);
    for (const o of outcomes) if (o.status === "rejected") expect([InvalidInputError, ConflictError].some((E) => o.reason instanceof E)).toBe(true);
    expect(await line(ctx)).toMatchObject({ out: 5, returned });
    expect(await stock(ctx)).toBe(95 + returned);
  });

  it("leaves nothing half-saved when one part of the transaction fails", async () => {
    const ctx = await team();
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 2 });
    const sheetBefore = await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#s1");
    // The movement item this return will write already exists, so its
    // condition (history is never overwritten) fails on every attempt, after
    // the operation record, the line and the stock have been staged
    const operationId = randomUUID();
    const now = new Date("2026-09-26T12:00:00.000Z");
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.movement(ctx.teamId, "0123", now.toISOString(), operationId), type: "movement" } }));
    await expect(returnItems(db, ctx, { operationId, sheetId: "s1", productKey: "0123", quantity: 1 }, now)).rejects.toThrow(ConflictError);
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, `OP#${operationId}`)).toBeUndefined();
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#s1")).toEqual(sheetBefore);
    expect(await stock(ctx)).toBe(98);
  });

  it("enforces the sheet's state and the line's counts inside the transaction", async () => {
    const ctx = await team();
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 2 });
    await expect(returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 3 })).rejects.toThrow(InvalidInputError);
    await updateDocument(db, ctx, "sheets", "s1", { status: "closed" });
    await expect(checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 1 })).rejects.toThrow(ConflictError);
    await expect(returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 1 })).rejects.toThrow(ConflictError);
    await expect(checkout(db, ctx, { operationId: randomUUID(), sheetId: "nope", productKey: "0123", quantity: 1 })).rejects.toThrow(NotFoundError);
    await expect(adjustStockCommand(db, ctx, { operationId: randomUUID(), productKey: "nope", reason: "count", count: 1 })).rejects.toThrow(NotFoundError);
    expect(await line(ctx)).toMatchObject({ out: 2, returned: 0 });
    expect(await stock(ctx)).toBe(98);
  });

  it("adds a one-off line, creates a missing items map, and leaves untracked stock alone", async () => {
    const ctx = await team();
    await setDocument(db, ctx, "sheets", "s1", { client: "Echo", date: "2026-09-26", status: "open" });
    await setDocument(db, ctx, "products", "nb-1", { code: "", name: "Rags", price: 1 });
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "nb-1", quantity: 2 });
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "one-off", quantity: 1, name: "Bins", price: 4, code: "" });
    await returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "nb-1", quantity: 1 });
    expect(await line(ctx, "nb-1")).toEqual({ code: "", name: "Rags", price: 1, out: 2, returned: 1 });
    expect(await line(ctx, "one-off")).toEqual({ code: "", name: "Bins", price: 4, out: 1, returned: 0 });
    expect((await getDocument(db, ctx, "products", "nb-1"))?.data.stock).toBeUndefined();
    expect((await history(ctx, "nb-1")).map((m) => m.delta)).toEqual([0, 0]);
  });

  it("refuses viewers", async () => {
    const ctx = await team();
    const { invite, token } = await createInvite(db, ctx, { email: "viewer@example.com", role: "viewer" });
    const viewer = await acceptInvite(db, { userId: newUser(), verifiedEmail: "viewer@example.com" }, invite, token);
    await expect(checkout(db, viewer, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 1 })).rejects.toThrow(ForbiddenError);
    await expect(adjustStockCommand(db, viewer, { operationId: randomUUID(), productKey: "0123", reason: "count", count: 1 })).rejects.toThrow(ForbiddenError);
    expect(await history(viewer)).toEqual([]);
  });
  it("refuses __proto__ as a product key, and handles other built-in names like any key", async () => {
    const ctx = await team();
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 1 });
    await expect(checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "__proto__", quantity: 1, name: "x", price: 1 })).rejects.toThrow(InvalidInputError);
    await expect(returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "__proto__", quantity: 1 })).rejects.toThrow(InvalidInputError);
    await expect(adjustStockCommand(db, ctx, { operationId: randomUUID(), productKey: "__proto__", reason: "count", count: 1 })).rejects.toThrow(InvalidInputError);
    await expect(setDocument(db, ctx, "products", "__proto__", { name: "x", price: 1 })).rejects.toThrow(InvalidInputError);
    expect((await getDocument(db, ctx, "sheets", "s1"))?.version).toBe(2);

    // Named "String": the SDK would store a map with its own `constructor` field as a string
    for (const key of ["constructor", "toString"]) {
      await setDocument(db, ctx, "products", key, { code: key, name: "String", price: 2, stock: 20 });
      await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: key, quantity: 2 });
      await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: key, quantity: 3 });
      await returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: key, quantity: 4 });
      expect(await line(ctx, key)).toEqual({ code: key, name: "String", price: 2, out: 5, returned: 4 });
      expect((await getDocument(db, ctx, "products", key))?.data.stock).toBe(19);
      expect((await history(ctx, key)).map((m) => m.delta)).toEqual([4, -3, -2]);
    }
    expect(await line(ctx)).toMatchObject({ out: 1, returned: 0 });
    // The whole sheet saves and merges as a document with those lines in it
    await updateDocument(db, ctx, "sheets", "s1", { items: { constructor: { out: 6 } } });
    expect(await line(ctx, "constructor")).toEqual({ code: "constructor", name: "String", price: 2, out: 6, returned: 4 });
    const sheet = await getDocument(db, ctx, "sheets", "s1");
    await setDocument(db, ctx, "sheets", "s1", sheet?.data);
    expect((await getDocument(db, ctx, "sheets", "s1"))?.data.items).toEqual(sheet?.data.items);

    // A new items map whose only line is keyed constructor, from a command and from createSheet
    await setDocument(db, ctx, "sheets", "s1", { client: "Echo", date: "2026-09-26", status: "open" });
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "constructor", quantity: 1 });
    expect((await getDocument(db, ctx, "sheets", "s1"))?.data.items).toEqual({ constructor: { code: "constructor", name: "String", price: 2, out: 1, returned: 0 } });
    const created = await createSheet(db, ctx, { client: "Echo", date: "2026-09-26", items: { constructor: { name: "String", price: 1, out: 1, returned: 0 } } });
    expect((await getDocument(db, ctx, "sheets", created.id))?.data.items).toEqual({ constructor: { name: "String", price: 1, out: 1, returned: 0 } });
  });

  it("refuses with TooLargeError, having written nothing, a change that takes a sheet past DynamoDB's item limit", async () => {
    const ctx = await team();
    const Key = keys.sheet(ctx.teamId, "s1");
    const put = (pad: number) =>
      connection(db).doc.send(
        new PutCommand({
          TableName: db.tableName,
          Item: { ...Key, type: "sheet", id: "s1", version: 1, status: "open", items: { "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 1 } }, pad: "x".repeat(pad) },
        }),
      );
    // The largest sheet DynamoDB takes, to the byte: a line's first return adds a field to it
    let [fits, tooBig] = [390_000, 410_000];
    while (tooBig - fits > 1) {
      const mid = Math.floor((fits + tooBig) / 2);
      try {
        await put(mid);
        fits = mid;
      } catch {
        tooBig = mid;
      }
    }
    await put(fits);
    const before = await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#s1");
    await expect(returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 1 })).rejects.toThrow(TooLargeError);
    // A new line is refused before the transaction
    await expect(checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "one-off", quantity: 1, name: "Bins", price: 4 })).rejects.toThrow(TooLargeError);
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#s1")).toEqual(before);
    expect(await stock(ctx)).toBe(100);
    expect(await history(ctx)).toEqual([]);
  });
});
