// The CSV inventory import against DynamoDB Local (CI): the staging and
// chunk transactions as DynamoDB runs them, at their real size limits, and
// two imports of one file at once. imports-api.test.ts covers the handler in
// memory.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptInvite, createInvite, createTeam, type Db, ForbiddenError, importProducts, listDocuments, listMovements, MAX_IMPORT_ROWS, setDocument, type TeamContext } from "../src/data/index.js";
import { keys } from "../src/data/keys.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

function sampleCsv(n: number, stock = (i: number) => i * 3): string {
  const lines = ["name,barcode,price,cost,stock,pack_size"];
  for (let i = 1; i <= n; i++) lines.push(`Item ${i},${i % 2 ? `B${i}` : ""},${(i * 1.25).toFixed(2)},${i},${stock(i)},${(i % 4) + 1}`);
  return lines.join("\n");
}

describe.skipIf(!endpoint)("inventory import (DynamoDB Local)", () => {
  const table = useTable();
  let db: Db;

  async function team(): Promise<TeamContext> {
    db = table.db;
    return (await createTeam(db, { userId: newUser() }, { name: "Echo" })).context;
  }

  async function allProducts(ctx: TeamContext) {
    return (await listDocuments(db, ctx, "products")).items;
  }

  it("imports 200 rows in well under a minute, and a re-import changes nothing", async () => {
    const ctx = await team();
    const started = Date.now();
    const outcome = await importProducts(db, ctx, { importId: randomUUID(), csv: sampleCsv(200) });
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(outcome).toMatchObject({ status: "imported", summary: { rows: 200, created: 200 } });
    const items = await allProducts(ctx);
    expect(items).toHaveLength(200);
    expect(items.find((d) => d.id === "B1")?.data).toMatchObject({ code: "B1", name: "Item 1", price: 1.25, cost: 1, stock: 3, packSize: 2 });
    expect((await listMovements(db, ctx, "B1")).items).toEqual([expect.objectContaining({ reason: "import", delta: 3, count: 3 })]);

    const again = await importProducts(db, ctx, { importId: randomUUID(), csv: sampleCsv(200) });
    expect(again).toMatchObject({ summary: { unchanged: 200 } });
    expect(await allProducts(ctx)).toEqual(items);

    const recount = await importProducts(db, ctx, { importId: randomUUID(), csv: sampleCsv(200, () => 5) });
    expect(recount).toMatchObject({ summary: { updated: 200 } });
    expect((await listMovements(db, ctx, "B1")).items[0]).toMatchObject({ delta: 2, count: 5 });
  });

  it("imports the most rows it takes in one request", async () => {
    const ctx = await team();
    const id = randomUUID();
    const outcome = await importProducts(db, ctx, { importId: id, csv: sampleCsv(MAX_IMPORT_ROWS) });
    expect(outcome).toMatchObject({ status: "imported", summary: { created: MAX_IMPORT_ROWS } });
    expect(await rawItem(db, keys.importJob(ctx.teamId, id).PK, keys.importJob(ctx.teamId, id).SK)).toMatchObject({ status: "done", committed: MAX_IMPORT_ROWS, total: MAX_IMPORT_ROWS, chunks: 21 });
  });

  it("updates a chunk of large items in transactions DynamoDB accepts", async () => {
    const ctx = await team();
    const note = "x".repeat(300_000);
    for (let i = 0; i < 30; i++) await setDocument(db, ctx, "products", `k${i}`, { code: `c${i}`, name: `Item ${i}`, price: 1, note }, { expectedVersion: 0 });
    const csv = ["name,barcode,price", ...Array.from({ length: 30 }, (_, i) => `Item ${i},c${i},2`)].join("\n");
    expect(await importProducts(db, ctx, { importId: randomUUID(), csv })).toMatchObject({ status: "imported", summary: { updated: 30 } });
    const items = await allProducts(ctx);
    expect(items.every((d) => d.data.price === 2 && d.data.note === note)).toBe(true);
  });

  it("two imports of the same file at once make one item per row", async () => {
    const ctx = await team();
    const csv = sampleCsv(120);
    const outcomes = await Promise.allSettled([importProducts(db, ctx, { importId: randomUUID(), csv }), importProducts(db, ctx, { importId: randomUUID(), csv })]);
    // Each either finishes, or gives up on items the other kept changing
    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
    expect(await allProducts(ctx)).toHaveLength(120);
  });

  it("writes nothing for a file with a bad row", async () => {
    const ctx = await team();
    const outcome = await importProducts(db, ctx, { importId: randomUUID(), csv: sampleCsv(150) + "\nBad,,-1,,," });
    expect(outcome).toMatchObject({ status: "invalid", errorCount: 1, errors: [{ line: 152, column: "price" }] });
    expect(await allProducts(ctx)).toEqual([]);
  });

  it("is for owners only", async () => {
    const ctx = await team();
    const { invite, token } = await createInvite(db, ctx, { email: "crew@example.com", role: "contributor" });
    const contributor = await acceptInvite(db, { userId: newUser(), verifiedEmail: "crew@example.com" }, invite, token);
    await expect(importProducts(db, contributor, { importId: randomUUID(), csv: "name,price\nA,1" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await allProducts(ctx)).toEqual([]);
  });
});
