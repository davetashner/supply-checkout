// The document functions behind the data API, against DynamoDB Local (CI).
// data-api.test.ts covers the same behaviour through the handler in memory.

import { BatchWriteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { connection } from "../src/data/client.js";
import { keys } from "../src/data/keys.js";
import {
  adjustStock,
  ConflictError,
  createProject,
  createTeam,
  deleteDocument,
  ForbiddenError,
  getDocument,
  getProduct,
  getProject,
  InvalidInputError,
  listDocuments,
  listMovements,
  NotFoundError,
  projectItem,
  setDocument,
  TooLargeError,
  updateDocument,
  type Db,
  MAX_DOCUMENT_BYTES,
} from "../src/data/index.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

describe.skipIf(!endpoint)("documents (DynamoDB Local)", () => {
  const table = useTable();
  let db: Db;

  async function team() {
    db = table.db;
    return (await createTeam(db, { userId: newUser() }, { name: "Echo" })).context;
  }

  it("stores documents as the typed items, with keys, index attributes and a version", async () => {
    const ctx = await team();
    const { after } = await setDocument(db, ctx, "projects", "s1", { client: "Echo", date: "2026-09-01", status: "open", items: { a: { out: 2, returned: 0, name: "Gloves", price: 1, code: "A" } } });
    expect(after.version).toBe(1);
    // A project's item: PROJECT#, in the #PROJECTS date index partition (supply-checkout-005.6)
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#s1")).toBeUndefined();
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PROJECT#s1")).toMatchObject({
      GSI1PK: `TEAM#${ctx.teamId}#PROJECTS`,
      GSI1SK: "2026-09-01#s1",
      type: "project",
      id: "s1",
      version: 1,
      client: "Echo",
    });
    // The typed functions read it, and documents read what they write
    expect(await getProject(db, ctx, "s1")).toMatchObject({ id: "s1", client: "Echo", version: 1 });
    const typed = await createProject(db, ctx, { client: "Typed", date: "2026-09-02" });
    expect(await getDocument(db, ctx, "projects", typed.id)).toMatchObject({ id: typed.id, version: 1, data: { client: "Typed", date: "2026-09-02", status: "open" } });
  });

  it("deep-merges updates and bumps the version", async () => {
    const ctx = await team();
    await setDocument(db, ctx, "projects", "s1", { client: "Echo", date: "2026-09-01", items: { a: { out: 2, returned: 0 } } });
    const { before, after } = await updateDocument(db, ctx, "projects", "s1", { items: { a: { returned: 1 }, b: { out: 1, returned: 0 } } });
    expect(before?.data.items).toEqual({ a: { out: 2, returned: 0 } });
    expect(after).toEqual({ id: "s1", version: 2, data: { client: "Echo", date: "2026-09-01", items: { a: { out: 2, returned: 1 }, b: { out: 1, returned: 0 } } } });
    expect(await getDocument(db, ctx, "projects", "s1")).toEqual(after);
    await expect(updateDocument(db, ctx, "projects", "missing", { a: 1 })).rejects.toThrow(NotFoundError);
  });

  it("stamps a project's closedAt with the server's time when it's finished, ignoring the app's (supply-checkout-1dg.16)", async () => {
    const ctx = await team();
    const now = (iso: string) => ({ now: new Date(iso) });
    await setDocument(db, ctx, "projects", "s1", { client: "Echo", date: "2020-01-05", status: "open", items: {}, closedAt: "2026-01-05T00:00:00.000Z" }, now("2026-01-05T09:00:00Z"));
    expect((await getDocument(db, ctx, "projects", "s1"))?.data).not.toHaveProperty("closedAt");
    await updateDocument(db, ctx, "projects", "s1", { status: "closed", closedAt: "2025-02-01T09:00:00.000Z" }, now("2026-02-01T09:00:00Z"));
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PROJECT#s1")).toMatchObject({ status: "closed", closedAt: "2026-02-01T09:00:00.000Z" });
    // So the list since a day keeps the old project finished on it
    expect((await listDocuments(db, ctx, "projects", { since: "2026-02-01" })).items.map((d) => d.id)).toEqual(["s1"]);
    await updateDocument(db, ctx, "projects", "s1", { status: "open", closedAt: "2027-01-01T00:00:00.000Z" }, now("2026-03-01T09:00:00Z"));
    expect((await getDocument(db, ctx, "projects", "s1"))?.data).toMatchObject({ status: "open", closedAt: "2026-02-01T09:00:00.000Z" });
  });

  it("keeps each project line's barcode through set and deep-merge update", async () => {
    const ctx = await team();
    const gloves = { code: "0123456789", name: "Gloves", price: 12.5, out: 3, returned: 0 };
    await setDocument(db, ctx, "projects", "s1", { client: "Echo", date: "2026-09-01", status: "open", items: { "0123456789": gloves } });
    expect((await getDocument(db, ctx, "projects", "s1"))?.data.items).toEqual({ "0123456789": gloves });
    // A checkout adds a line; a return changes one field and leaves the code
    await updateDocument(db, ctx, "projects", "s1", { items: { "nb-1": { code: "", name: "Rags", price: 1, out: 1, returned: 0 } } });
    await updateDocument(db, ctx, "projects", "s1", { items: { "0123456789": { returned: 2 } } });
    expect((await getDocument(db, ctx, "projects", "s1"))?.data.items).toEqual({ "0123456789": { ...gloves, returned: 2 }, "nb-1": { code: "", name: "Rags", price: 1, out: 1, returned: 0 } });
    // The typed functions read it too
    expect((await getProject(db, ctx, "s1"))?.items["0123456789"]?.code).toBe("0123456789");
    // A barcode is bounded like a product key, in either write
    await expect(setDocument(db, ctx, "projects", "s2", { items: { a: { ...gloves, code: "1".repeat(257) } } })).rejects.toThrow(InvalidInputError);
    await expect(updateDocument(db, ctx, "projects", "s1", { items: { a: { code: 5 } } })).rejects.toThrow(InvalidInputError);
    // So is a line's cost each (ADR 0014): kept as written, refused unless it's an amount in whole cents
    await updateDocument(db, ctx, "projects", "s1", { items: { "nb-1": { cost: 0.75 } } });
    expect((await getDocument(db, ctx, "projects", "s1"))?.data.items).toMatchObject({ "nb-1": { name: "Rags", cost: 0.75 } });
    expect((await getProject(db, ctx, "s1"))?.items["nb-1"]?.cost).toBe(0.75);
    await expect(setDocument(db, ctx, "projects", "s2", { items: { a: { ...gloves, cost: -1 } } })).rejects.toThrow(InvalidInputError);
    await expect(updateDocument(db, ctx, "projects", "s1", { items: { a: { cost: 0.001 } } })).rejects.toThrow(InvalidInputError);
  });

  it("lists by ID (consistent) or by date (the index), a page at a time", async () => {
    const ctx = await team();
    await setDocument(db, ctx, "projects", "s1", { date: "2026-09-01" });
    await setDocument(db, ctx, "projects", "s2", { date: "2026-09-20" });
    await setDocument(db, ctx, "projects", "s3", { client: "undated" });
    await setDocument(db, ctx, "products", "p1", { name: "Gloves" });
    const ids = (docs: { id: string }[]) => docs.map((d) => d.id);
    expect(ids((await listDocuments(db, ctx, "projects")).items)).toEqual(["s1", "s2", "s3"]);
    expect(ids((await listDocuments(db, ctx, "products")).items)).toEqual(["p1"]);
    const first = await listDocuments(db, ctx, "projects", { orderBy: "date", descending: true, limit: 2 });
    expect(ids(first.items)).toEqual(["s2", "s1"]);
    const second = await listDocuments(db, ctx, "projects", { orderBy: "date", descending: true, limit: 2, cursor: first.cursor });
    expect(ids(second.items)).toEqual(["s3"]);
    // A cursor from one listing can't be used on another
    const products = await listDocuments(db, ctx, "projects", { limit: 1 });
    await expect(listDocuments(db, ctx, "products", { cursor: products.cursor })).rejects.toThrow(InvalidInputError);
    await expect(listDocuments(db, ctx, "products", { orderBy: "date" })).rejects.toThrow(InvalidInputError);
  });

  it("checks expected versions, including 0 for create-only", async () => {
    const ctx = await team();
    await setDocument(db, ctx, "products", "p1", { name: "A" }, { expectedVersion: 0 });
    await expect(setDocument(db, ctx, "products", "p1", { name: "B" }, { expectedVersion: 0 })).rejects.toThrow(ConflictError);
    await expect(updateDocument(db, ctx, "products", "p1", { name: "B" }, { expectedVersion: 2 })).rejects.toThrow(ConflictError);
    await updateDocument(db, ctx, "products", "p1", { name: "B" }, { expectedVersion: 1 });
    await expect(deleteDocument(db, ctx, "products", "p1", { expectedVersion: 1 })).rejects.toThrow(ConflictError);
    await expect(deleteDocument(db, ctx, "products", "p1", { expectedVersion: 0 })).rejects.toThrow(ConflictError);
    expect((await deleteDocument(db, ctx, "products", "p1", { expectedVersion: 2 })).before?.data).toEqual({ name: "B" });
    expect(await deleteDocument(db, ctx, "products", "p1")).toEqual({ before: undefined });
  });

  it("doesn't lose an atomic stock change that lands between a read and a write", async () => {
    const ctx = await team();
    await setDocument(db, ctx, "products", "p1", { name: "Gloves" });
    await adjustStock(db, ctx, "p1", 5);
    await adjustStock(db, ctx, "p1", -2);
    // A new version, so a write made against the old one conflicts
    await expect(updateDocument(db, ctx, "products", "p1", { price: 2 }, { expectedVersion: 2 })).rejects.toThrow(ConflictError);
    // The write sees stock 3, not the 5 it might have read before
    const { after } = await updateDocument(db, ctx, "products", "p1", { price: 2 });
    expect(after.data).toEqual({ name: "Gloves", stock: 3, price: 2 });
    expect((await getProduct(db, ctx, "p1"))?.stock).toBe(3);
  });

  it("keeps a product's stock through set and update, and refuses a write that changes it", async () => {
    const ctx = await team();
    await expect(setDocument(db, ctx, "products", "p1", { name: "Gloves", stock: 5 })).rejects.toThrow(InvalidInputError);
    expect(await getDocument(db, ctx, "products", "p1")).toBeUndefined();
    await setDocument(db, ctx, "products", "p1", { name: "Gloves" });
    await expect(updateDocument(db, ctx, "products", "p1", { stock: 5 })).rejects.toThrow(InvalidInputError);
    await adjustStock(db, ctx, "p1", 5);
    // A replace that leaves stock out keeps it; one that repeats it is fine
    expect((await setDocument(db, ctx, "products", "p1", { name: "Blue gloves" }, { expectedVersion: 2 })).after).toEqual({ id: "p1", version: 3, data: { name: "Blue gloves", stock: 5 } });
    expect((await updateDocument(db, ctx, "products", "p1", { stock: 5, price: 2 })).after.data).toEqual({ name: "Blue gloves", stock: 5, price: 2 });
    await expect(setDocument(db, ctx, "products", "p1", { name: "Blue gloves", stock: 6 })).rejects.toThrow(InvalidInputError);
    await expect(updateDocument(db, ctx, "products", "p1", { stock: 4 })).rejects.toThrow(InvalidInputError);
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#p1")).toMatchObject({ version: 4, stock: 5 });
  });

  it("saves a project with a legacy line cost when another line changes, rounding it to cents", async () => {
    const ctx = await team();
    const oldLine = { code: "A", name: "Gloves", price: 2.345, cost: 1.005, out: 2, returned: 0 };
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.project(ctx.teamId, "s1"), type: "project", id: "s1", version: 1, client: "Echo", items: { a: oldLine } } }));
    const { after } = await updateDocument(db, ctx, "projects", "s1", { items: { b: { code: "B", name: "Rags", price: 1, out: 1, returned: 0 } } });
    expect(after.data.items).toMatchObject({ a: { price: 2.35, cost: 1.01 }, b: { price: 1 } });
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PROJECT#s1")).toMatchObject({ version: 2, items: { a: { price: 2.35, cost: 1.01 } } });
    await expect(updateDocument(db, ctx, "projects", "s1", { items: { a: { cost: 1.006 } } })).rejects.toThrow(InvalidInputError);
    await expect(updateDocument(db, ctx, "projects", "s1", { items: { b: { price: 1.001 } } })).rejects.toThrow(InvalidInputError);
  });

  it("saves a product with legacy price and cost when another field changes, rounding them to cents", async () => {
    const ctx = await team();
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.product(ctx.teamId, "p1"), type: "product", key: "p1", version: 1, code: "A", name: "Gloves", price: 2.345, cost: 1.005 } }));
    const { after } = await updateDocument(db, ctx, "products", "p1", { name: "Nitrile gloves" });
    expect(after.data).toMatchObject({ name: "Nitrile gloves", price: 2.35, cost: 1.01 });
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#p1")).toMatchObject({ version: 2, price: 2.35, cost: 1.01 });
    await expect(updateDocument(db, ctx, "products", "p1", { cost: 1.006 })).rejects.toThrow(InvalidInputError);
    await expect(setDocument(db, ctx, "products", "p2", { code: "B", name: "Rags", price: 1.001 })).rejects.toThrow(InvalidInputError);
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#p2")).toBeUndefined();
  });

  it("stores a product's brand trimmed, removes a blank one, and refuses a bad one (supply-checkout-005.9)", async () => {
    const ctx = await team();
    await setDocument(db, ctx, "products", "p1", { code: "", name: "Gloves", price: 1, brand: " Ansell " });
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#p1")).toMatchObject({ name: "Gloves", brand: "Ansell", version: 1 });
    await updateDocument(db, ctx, "products", "p1", { price: 2 });
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#p1")).toMatchObject({ brand: "Ansell", price: 2, version: 2 });
    await updateDocument(db, ctx, "products", "p1", { brand: "" });
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#p1")).not.toHaveProperty("brand");
    await expect(updateDocument(db, ctx, "products", "p1", { brand: "a\nb" })).rejects.toBeInstanceOf(InvalidInputError);
    await expect(setDocument(db, ctx, "products", "p1", { code: "", name: "Gloves", brand: "x".repeat(101) })).rejects.toBeInstanceOf(InvalidInputError);
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#p1")).toMatchObject({ version: 3 });
  });

  it("maps DynamoDB's own item-size refusal to TooLargeError", async () => {
    const ctx = await team();
    // Under the document limit as JSON, but over 400 KB as DynamoDB counts it (each number in a list takes more than its 2 bytes of JSON)
    const counts = Array.from({ length: 170_000 }, () => 1);
    expect(Buffer.byteLength(JSON.stringify({ counts }), "utf8")).toBeLessThan(MAX_DOCUMENT_BYTES);
    await expect(setDocument(db, ctx, "products", "p1", { code: "A", name: "Gloves", counts })).rejects.toThrow(new TooLargeError("This document is too large to save"));
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#p1")).toBeUndefined();
  });

  it("edits a product whose stored stock isn't a number, dropping it", async () => {
    const ctx = await team();
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.product(ctx.teamId, "p1"), type: "product", key: "p1", version: 1, name: "Gloves", stock: "5" } }));
    expect((await setDocument(db, ctx, "products", "p1", { name: "Blue gloves", stock: "5" })).after.data).toEqual({ name: "Blue gloves" });
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PRODUCT#p1")).not.toHaveProperty("stock");
  });

  it("records a delete movement for a product that tracks stock, in the same transaction", async () => {
    const ctx = await team();
    await setDocument(db, ctx, "products", "p1", { name: "Gloves" });
    await adjustStock(db, ctx, "p1", 5);
    expect((await deleteDocument(db, ctx, "products", "p1", { expectedVersion: 2 })).before?.data).toEqual({ name: "Gloves", stock: 5 });
    expect(await getDocument(db, ctx, "products", "p1")).toBeUndefined();
    expect((await listMovements(db, ctx, "p1")).items).toEqual([expect.objectContaining({ reason: "delete", delta: -5, tracked: true, count: 0, userId: ctx.userId })]);
    // Without stock, there's nothing to record
    await setDocument(db, ctx, "products", "p2", { name: "Rags" });
    await deleteDocument(db, ctx, "products", "p2");
    expect((await listMovements(db, ctx, "p2")).items).toEqual([]);
  });

  it("refuses viewers, reserved fields and oversized documents", async () => {
    const owner = await team();
    const { createInvite, acceptInvite } = await import("../src/data/index.js");
    const { invite, token } = await createInvite(db, owner, { email: "v@example.com", role: "viewer" });
    const viewer = await acceptInvite(db, { userId: newUser(), verifiedEmail: "v@example.com" }, invite, token);
    await expect(setDocument(db, viewer, "products", "p1", { name: "x" })).rejects.toThrow(ForbiddenError);
    await expect(deleteDocument(db, viewer, "products", "p1")).rejects.toThrow(ForbiddenError);
    expect(await getDocument(db, viewer, "products", "p1")).toBeUndefined();
    await expect(setDocument(db, owner, "products", "p1", { teamId: "other" })).rejects.toThrow(InvalidInputError);
    await expect(setDocument(db, owner, "projects", "s1", { big: "x".repeat(MAX_DOCUMENT_BYTES) })).rejects.toThrow(TooLargeError);
  });
  // supply-checkout-1dg.11: the app's first load reads open and recent projects, not every project the team ever had
  it("lists only the open and recent projects of 2,000, since a day, a page at a time", async () => {
    const ctx = await team();
    const other = await team();
    // About 2 KB of lines each, so the team's 4 MB of projects take several 1 MB reads
    const items = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, { code: `c${i}`, name: `Item ${i} `.padEnd(120, "x"), price: 1, out: 1, returned: 1 }]));
    const kinds = (n: number) => (n % 40 === 0 ? "open" : n % 40 === 1 ? "recent" : "old");
    const data = (kind: string) => ({ client: "Echo", date: kind === "recent" ? "2026-08-01" : "2023-05-01", status: kind === "open" ? "open" : "closed", items });
    const ids = Array.from({ length: 2000 }, (_, n) => `p${String(n).padStart(4, "0")}`);
    for (let i = 0; i < ids.length; i += 25) {
      const chunk = ids.slice(i, i + 25).map((id, j) => projectItem(ctx.teamId, id, data(kinds(i + j)), 1));
      await connection(db).doc.send(new BatchWriteCommand({ RequestItems: { [db.tableName]: chunk.map((Item) => ({ PutRequest: { Item } })) } }));
    }
    // Another team's open project never shows
    await setDocument(db, other, "projects", "p0000x", { client: "Other", date: "2026-09-01", status: "open", items: {} });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listDocuments(db, ctx, "projects", { since: "2026-01-01", cursor });
      seen.push(...page.items.map((d) => d.id));
      cursor = page.cursor;
      pages++;
    } while (cursor && pages < 50);
    // Unfiltered, the same projects take several 1 MB pages. DynamoDB Local applies a filtered
    // read's 1 MB to what matches, not to what it read as DynamoDB does, so here the filtered
    // list may be one page; data-api.test.ts pages it as DynamoDB would.
    const plain = await listDocuments(db, ctx, "projects", {});
    expect(plain.cursor).toEqual(expect.any(String));
    expect(plain.items.length).toBeLessThan(1000);
    expect(seen.sort()).toEqual(ids.filter((_, n) => kinds(n) !== "old"));
    expect(seen).toHaveLength(100);
    await expect(listDocuments(db, ctx, "projects", { since: "2026-01-01", limit: 5 })).rejects.toThrow(InvalidInputError);
    await expect(listDocuments(db, ctx, "products", { since: "2026-01-01" })).rejects.toThrow(InvalidInputError);
  }, 120_000);

  it("lists only PROJECT# items, by ID and by date, in pages of any size, and serves no SHEET# item (supply-checkout-005.6.5)", async () => {
    const ctx = await team();
    const other = await team();
    const put = (Item: Record<string, unknown>) => connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item }));
    // An item the rename's backfill hasn't moved: nothing reads it any more
    const old = (t: string, id: string, date: string, client = "Old") =>
      put({ PK: `TEAM#${t}`, SK: `SHEET#${id}`, GSI1PK: `TEAM#${t}#SHEETS`, GSI1SK: `${date}#${id}`, type: "sheet", id, version: 1, client, date });
    for (const [id, date] of [["c", "2026-10-03"], ["e", "2026-10-01"], ["t", "2026-10-06"]] as const) await setDocument(db, ctx, "projects", id, { client: "New", date });
    for (const [id, date] of [["a", "2026-10-05"], ["b", "2026-10-02"], ["d", "2026-10-04"], ["t", "2026-10-06"]] as const) await old(ctx.teamId, id, date);
    await old(other.teamId, "z", "2026-10-03");
    await setDocument(db, other, "projects", "y", { client: "Other", date: "2026-10-03" });

    const all = async (options: { orderBy?: "date"; descending?: boolean; limit?: number }) => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 30; pages++) {
        const page = await listDocuments(db, ctx, "projects", { ...options, cursor });
        if (options.limit !== undefined) expect(page.items.length).toBeLessThanOrEqual(options.limit);
        seen.push(...page.items.map((d) => d.id));
        cursor = page.cursor;
        if (!cursor) break;
      }
      return seen;
    };
    const byDate = ["e", "c", "t"];
    for (const limit of [undefined, 1, 2, 3]) {
      expect(await all({ limit }), `limit ${limit}`).toEqual(["c", "e", "t"]);
      // GSI1 is eventually consistent: DynamoDB Local is not, so the order is exact here
      expect(await all({ orderBy: "date", limit }), `date limit ${limit}`).toEqual(byDate);
      expect(await all({ orderBy: "date", descending: true, limit }), `date desc limit ${limit}`).toEqual([...byDate].reverse());
    }
    // An old item is not served by ID, and is not a twin of anything
    expect(await getDocument(db, ctx, "projects", "a")).toBeUndefined();
    expect((await getDocument(db, ctx, "projects", "t"))?.data.client).toBe("New");
    // Another team's is out of reach
    expect(await getDocument(db, ctx, "projects", "z")).toBeUndefined();
    expect(await getDocument(db, ctx, "projects", "y")).toBeUndefined();
    // A change to it finds nothing, and leaves it as it was
    await expect(updateDocument(db, ctx, "projects", "a", { client: "Changed" }, { expectedVersion: 1 })).rejects.toThrow(ConflictError);
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#a")).toMatchObject({ type: "sheet", client: "Old", version: 1 });
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PROJECT#a")).toBeUndefined();
    // Deleted without a version, only the PROJECT# item goes
    await deleteDocument(db, ctx, "projects", "t");
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "PROJECT#t")).toBeUndefined();
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#t")).toMatchObject({ client: "Old", version: 1 });
    // The old collection name is no collection
    await expect(listDocuments(db, ctx, "sheets" as "projects", {})).rejects.toThrow(InvalidInputError);
  });
});
