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
    await setDocument(db, ctx, "products", "p1", { name: "Gloves", stock: 5 });
    await adjustStock(db, ctx, "p1", -2);
    // The write sees stock 3, not the 5 it might have read before
    const { after } = await updateDocument(db, ctx, "products", "p1", { price: 2 });
    expect(after.data).toEqual({ name: "Gloves", stock: 3, price: 2 });
    expect((await getProduct(db, ctx, "p1"))?.stock).toBe(3);
  });

  it("refuses viewers, reserved fields and oversized documents", async () => {
    const owner = await team();
    const { createInvite, acceptInvite } = await import("../src/data/index.js");
    const { invite } = await createInvite(db, owner, { email: "v@example.com", role: "viewer" });
    const viewer = await acceptInvite(db, { userId: newUser(), verifiedEmail: "v@example.com" }, invite);
    await expect(setDocument(db, viewer, "products", "p1", { name: "x" })).rejects.toThrow(ForbiddenError);
    await expect(deleteDocument(db, viewer, "products", "p1")).rejects.toThrow(ForbiddenError);
    expect(await getDocument(db, viewer, "products", "p1")).toBeUndefined();
    await expect(setDocument(db, owner, "products", "p1", { teamId: "other" })).rejects.toThrow(InvalidInputError);
    await expect(setDocument(db, owner, "sheets", "s1", { big: "x".repeat(MAX_DOCUMENT_BYTES) })).rejects.toThrow(TooLargeError);
  });
});
