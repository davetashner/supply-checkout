// The document functions behind the data API, against DynamoDB Local (CI).
// data-api.test.ts covers the same behaviour through the handler in memory.

import { describe, expect, it } from "vitest";
import {
  adjustStock,
  ConflictError,
  createSheet,
  createTeam,
  deleteDocument,
  ForbiddenError,
  getDocument,
  getProduct,
  getSheet,
  InvalidInputError,
  listDocuments,
  NotFoundError,
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
    const { after } = await setDocument(db, ctx, "sheets", "s1", { client: "Echo", date: "2026-09-01", status: "open", items: { a: { out: 2, returned: 0, name: "Gloves", price: 1, code: "A" } } });
    expect(after.version).toBe(1);
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "SHEET#s1")).toMatchObject({
      GSI1PK: `TEAM#${ctx.teamId}#SHEETS`,
      GSI1SK: "2026-09-01#s1",
      type: "sheet",
      id: "s1",
      version: 1,
      client: "Echo",
    });
    // The typed functions read it, and documents read what they write
    expect(await getSheet(db, ctx, "s1")).toMatchObject({ id: "s1", client: "Echo", version: 1 });
    const typed = await createSheet(db, ctx, { client: "Typed", date: "2026-09-02" });
    expect(await getDocument(db, ctx, "sheets", typed.id)).toMatchObject({ id: typed.id, version: 1, data: { client: "Typed", date: "2026-09-02", status: "open" } });
  });

  it("deep-merges updates and bumps the version", async () => {
    const ctx = await team();
    await setDocument(db, ctx, "sheets", "s1", { client: "Echo", date: "2026-09-01", items: { a: { out: 2, returned: 0 } } });
    const { before, after } = await updateDocument(db, ctx, "sheets", "s1", { items: { a: { returned: 1 }, b: { out: 1, returned: 0 } } });
    expect(before?.data.items).toEqual({ a: { out: 2, returned: 0 } });
    expect(after).toEqual({ id: "s1", version: 2, data: { client: "Echo", date: "2026-09-01", items: { a: { out: 2, returned: 1 }, b: { out: 1, returned: 0 } } } });
    expect(await getDocument(db, ctx, "sheets", "s1")).toEqual(after);
    await expect(updateDocument(db, ctx, "sheets", "missing", { a: 1 })).rejects.toThrow(NotFoundError);
  });

  it("keeps each sheet line's barcode through set and deep-merge update", async () => {
    const ctx = await team();
    const gloves = { code: "0123456789", name: "Gloves", price: 12.5, out: 3, returned: 0 };
    await setDocument(db, ctx, "sheets", "s1", { client: "Echo", date: "2026-09-01", status: "open", items: { "0123456789": gloves } });
    expect((await getDocument(db, ctx, "sheets", "s1"))?.data.items).toEqual({ "0123456789": gloves });
    // A checkout adds a line; a return changes one field and leaves the code
    await updateDocument(db, ctx, "sheets", "s1", { items: { "nb-1": { code: "", name: "Rags", price: 1, out: 1, returned: 0 } } });
    await updateDocument(db, ctx, "sheets", "s1", { items: { "0123456789": { returned: 2 } } });
    expect((await getDocument(db, ctx, "sheets", "s1"))?.data.items).toEqual({ "0123456789": { ...gloves, returned: 2 }, "nb-1": { code: "", name: "Rags", price: 1, out: 1, returned: 0 } });
    // The typed functions read it too
    expect((await getSheet(db, ctx, "s1"))?.items["0123456789"]?.code).toBe("0123456789");
    // A barcode is bounded like a product key, in either write
    await expect(setDocument(db, ctx, "sheets", "s2", { items: { a: { ...gloves, code: "1".repeat(257) } } })).rejects.toThrow(InvalidInputError);
    await expect(updateDocument(db, ctx, "sheets", "s1", { items: { a: { code: 5 } } })).rejects.toThrow(InvalidInputError);
    // So is a line's cost each (ADR 0014): kept as written, refused unless it's an amount in whole cents
    await updateDocument(db, ctx, "sheets", "s1", { items: { "nb-1": { cost: 0.75 } } });
    expect((await getDocument(db, ctx, "sheets", "s1"))?.data.items).toMatchObject({ "nb-1": { name: "Rags", cost: 0.75 } });
    expect((await getSheet(db, ctx, "s1"))?.items["nb-1"]?.cost).toBe(0.75);
    await expect(setDocument(db, ctx, "sheets", "s2", { items: { a: { ...gloves, cost: -1 } } })).rejects.toThrow(InvalidInputError);
    await expect(updateDocument(db, ctx, "sheets", "s1", { items: { a: { cost: 0.001 } } })).rejects.toThrow(InvalidInputError);
  });

  it("lists by ID (consistent) or by date (the index), a page at a time", async () => {
    const ctx = await team();
    await setDocument(db, ctx, "sheets", "s1", { date: "2026-09-01" });
    await setDocument(db, ctx, "sheets", "s2", { date: "2026-09-20" });
    await setDocument(db, ctx, "sheets", "s3", { client: "undated" });
    await setDocument(db, ctx, "products", "p1", { name: "Gloves" });
    const ids = (docs: { id: string }[]) => docs.map((d) => d.id);
    expect(ids((await listDocuments(db, ctx, "sheets")).items)).toEqual(["s1", "s2", "s3"]);
    expect(ids((await listDocuments(db, ctx, "products")).items)).toEqual(["p1"]);
    const first = await listDocuments(db, ctx, "sheets", { orderBy: "date", descending: true, limit: 2 });
    expect(ids(first.items)).toEqual(["s2", "s1"]);
    const second = await listDocuments(db, ctx, "sheets", { orderBy: "date", descending: true, limit: 2, cursor: first.cursor });
    expect(ids(second.items)).toEqual(["s3"]);
    // A cursor from one listing can't be used on another
    const products = await listDocuments(db, ctx, "sheets", { limit: 1 });
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

  it("refuses viewers, reserved fields and oversized documents", async () => {
    const owner = await team();
    const { createInvite, acceptInvite } = await import("../src/data/index.js");
    const { invite, token } = await createInvite(db, owner, { email: "v@example.com", role: "viewer" });
    const viewer = await acceptInvite(db, { userId: newUser(), verifiedEmail: "v@example.com" }, invite, token);
    await expect(setDocument(db, viewer, "products", "p1", { name: "x" })).rejects.toThrow(ForbiddenError);
    await expect(deleteDocument(db, viewer, "products", "p1")).rejects.toThrow(ForbiddenError);
    expect(await getDocument(db, viewer, "products", "p1")).toBeUndefined();
    await expect(setDocument(db, owner, "products", "p1", { teamId: "other" })).rejects.toThrow(InvalidInputError);
    await expect(setDocument(db, owner, "sheets", "s1", { big: "x".repeat(MAX_DOCUMENT_BYTES) })).rejects.toThrow(TooLargeError);
  });
});
