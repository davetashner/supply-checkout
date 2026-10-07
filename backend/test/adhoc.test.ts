// The ad hoc checkout against DynamoDB Local (CI), ADR 0017 sections 4, 5
// and 7: the races as DynamoDB runs them. Two people's first quick takes at
// once end on one project; takes racing a Finished Return never land on a
// closed project; a move counts once, retried or racing a return.
// adhoc-api.test.ts covers the handler, validation and roles in memory.

import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  AdhocOpenError,
  ConflictError,
  createTeam,
  type Db,
  deleteDocument,
  getDocument,
  InvalidInputError,
  listMovements,
  moveLine,
  quickTake,
  returnItems,
  setDocument,
  type TeamContext,
  updateDocument,
} from "../src/data/index.js";
import { connection } from "../src/data/client.js";
import { keys } from "../src/data/keys.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

describe.skipIf(!endpoint)("the ad hoc checkout (DynamoDB Local)", () => {
  const table = useTable();
  let db: Db;

  async function team(): Promise<TeamContext> {
    db = table.db;
    const ctx = (await createTeam(db, { userId: newUser() }, { name: "Echo" })).context;
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.product(ctx.teamId, "0123"), type: "product", key: "0123", version: 1, code: "0123", name: "Nitrile gloves", price: 12.5, stock: 100 } }));
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.product(ctx.teamId, "tape"), type: "product", key: "tape", version: 1, code: "", name: "Tape", price: 3, stock: 100 } }));
    await setDocument(db, ctx, "projects", "s1", { client: "Echo", date: "2026-10-01", status: "open", items: {} });
    return ctx;
  }

  const project = async (ctx: TeamContext, id: string) => (await getDocument(db, ctx, "projects", id))?.data;
  const lines = async (ctx: TeamContext, id: string) => (await project(ctx, id))?.items as Record<string, Record<string, number>>;
  const stock = async (ctx: TeamContext, key: string) => (await getDocument(db, ctx, "products", key))?.data.stock;
  const pointer = (ctx: TeamContext) => rawItem(db, `TEAM#${ctx.teamId}`, "ADHOC");
  const take = (ctx: TeamContext, productKey: string, quantity: number) => quickTake(db, ctx, { operationId: randomUUID(), productKey, quantity, date: "2026-10-01" });

  it("ends two people's first takes at once on one project, with both lines and the stock right", async () => {
    const ctx = await team();
    const [a, b] = await Promise.all([take(ctx, "0123", 2), take(ctx, "tape", 3)]);
    expect(a.result.projectId).toBe("adhoc-1");
    expect(b.result.projectId).toBe("adhoc-1");
    // Exactly one of them started it
    expect([a.result.projectCreated, b.result.projectCreated].filter(Boolean)).toHaveLength(1);
    expect(await lines(ctx, "adhoc-1")).toMatchObject({ "0123": { out: 2 }, tape: { out: 3 } });
    expect(await getDocument(db, ctx, "projects", "adhoc-2")).toBeUndefined();
    expect(await pointer(ctx)).toMatchObject({ count: 1, open: "adhoc-1", version: 1 });
    expect([await stock(ctx, "0123"), await stock(ctx, "tape")]).toEqual([98, 97]);
  });

  it("puts many takes at once of the same item on one line without losing a count", async () => {
    const ctx = await team();
    const results = await Promise.all(Array.from({ length: 5 }, () => take(ctx, "0123", 1)));
    expect(new Set(results.map((r) => r.result.projectId))).toEqual(new Set(["adhoc-1"]));
    expect((await lines(ctx, "adhoc-1"))["0123"]?.out).toBe(5);
    expect(await stock(ctx, "0123")).toBe(95);
    const history = await listMovements(db, ctx, "0123");
    expect(history.items.filter((m) => m.reason === "checkout" && m.projectId === "adhoc-1")).toHaveLength(5);
  });

  it("never lands a take on a project being finished: it goes on that one before it closes, or on the next", async () => {
    const ctx = await team();
    await take(ctx, "0123", 1);
    const version = (await getDocument(db, ctx, "projects", "adhoc-1"))?.version as number;
    const [closed, taken] = await Promise.allSettled([updateDocument(db, ctx, "projects", "adhoc-1", { status: "closed" }, { expectedVersion: version }), take(ctx, "tape", 2)]);
    expect(taken.status).toBe("fulfilled");
    const projectId = taken.status === "fulfilled" ? (taken.value.result.projectId ?? "") : "";
    if (closed.status === "fulfilled") {
      // Finished first: the take started the next project
      expect(projectId).toBe("adhoc-2");
      expect(await pointer(ctx)).toMatchObject({ count: 2, open: "adhoc-2" });
    } else {
      // The take got in first, so the close (made against the old version) was refused
      expect(closed.reason).toBeInstanceOf(ConflictError);
      expect(projectId).toBe("adhoc-1");
    }
    expect((await lines(ctx, projectId)).tape?.out).toBe(2);
    expect(await stock(ctx, "tape")).toBe(98);
  });

  it("keeps the pointer through finishing, reopening and deleting, in the project write's transaction", async () => {
    const ctx = await team();
    await take(ctx, "0123", 1);
    await updateDocument(db, ctx, "projects", "adhoc-1", { status: "closed" });
    expect((await pointer(ctx))?.open).toBeUndefined();
    await take(ctx, "0123", 1);
    await expect(updateDocument(db, ctx, "projects", "adhoc-1", { status: "open" })).rejects.toThrow(AdhocOpenError);
    await deleteDocument(db, ctx, "projects", "adhoc-2");
    expect(await pointer(ctx)).toMatchObject({ count: 2 });
    expect((await pointer(ctx))?.open).toBeUndefined();
    await updateDocument(db, ctx, "projects", "adhoc-1", { status: "open" });
    expect(await pointer(ctx)).toMatchObject({ count: 2, open: "adhoc-1" });
    expect((await take(ctx, "tape", 1)).result.projectId).toBe("adhoc-1");
    await expect(setDocument(db, ctx, "projects", "adhoc-3", { client: "", date: "2026-10-01" })).rejects.toThrow(InvalidInputError);
  });

  it("lets only one of two finished General Use projects be reopened at once", async () => {
    const ctx = await team();
    await take(ctx, "0123", 1);
    await updateDocument(db, ctx, "projects", "adhoc-1", { status: "closed" });
    await take(ctx, "0123", 1);
    await updateDocument(db, ctx, "projects", "adhoc-2", { status: "closed" });
    const reopened = await Promise.allSettled([updateDocument(db, ctx, "projects", "adhoc-1", { status: "open" }), updateDocument(db, ctx, "projects", "adhoc-2", { status: "open" })]);
    expect(reopened.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of reopened) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictError);
    const open = [await project(ctx, "adhoc-1"), await project(ctx, "adhoc-2")].filter((s) => s?.status === "open");
    expect(open).toHaveLength(1);
  });

  it("moves a line once, retried or not, with both projects changing together and stock untouched", async () => {
    const ctx = await team();
    await take(ctx, "0123", 4);
    await returnItems(db, ctx, { operationId: randomUUID(), projectId: "adhoc-1", productKey: "0123", quantity: 1 });
    const operationId = randomUUID();
    const input = { operationId, projectId: "adhoc-1", productKey: "0123", toProjectId: "s1" };
    // The same move sent three times at once (a retry racing the first)
    const runs = await Promise.all([moveLine(db, ctx, input), moveLine(db, ctx, input), moveLine(db, ctx, input)]);
    expect(runs.filter((r) => !r.replayed)).toHaveLength(1);
    for (const r of runs) expect(r.result).toEqual(runs[0]?.result);
    expect(await lines(ctx, "s1")).toEqual({ "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 4, returned: 1 } });
    expect(await lines(ctx, "adhoc-1")).toEqual({});
    expect(await stock(ctx, "0123")).toBe(97);
    const moves = (await listMovements(db, ctx, "0123")).items.filter((m) => m.reason === "move");
    expect(moves).toEqual([expect.objectContaining({ delta: 0, quantity: 4, returned: 1, lost: 0, projectId: "s1", fromProjectId: "adhoc-1", operationId })]);
    // A move with a new ID finds no line left
    await expect(moveLine(db, ctx, { ...input, operationId: randomUUID() })).rejects.toThrow("This item isn't on this project");
  });

  it("never splits counts between a move and a return that race on the ad hoc line", async () => {
    const ctx = await team();
    await take(ctx, "0123", 3);
    const [moved, returned] = await Promise.allSettled([
      moveLine(db, ctx, { operationId: randomUUID(), projectId: "adhoc-1", productKey: "0123", toProjectId: "s1" }),
      returnItems(db, ctx, { operationId: randomUUID(), projectId: "adhoc-1", productKey: "0123", quantity: 1 }),
    ]);
    expect(moved.status).toBe("fulfilled");
    const jobLine = (await lines(ctx, "s1"))["0123"];
    expect(jobLine?.out).toBe(3);
    if (returned.status === "fulfilled") {
      // Whichever went first, the return is counted once: on the moved line, or on the ad hoc line before the move
      expect(jobLine?.returned).toBe(1);
      expect(await stock(ctx, "0123")).toBe(98);
    } else {
      expect(jobLine?.returned).toBe(0);
      expect(await stock(ctx, "0123")).toBe(97);
    }
    expect(await lines(ctx, "adhoc-1")).toEqual({});
  });
});
