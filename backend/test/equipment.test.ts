// Company equipment against DynamoDB Local (CI), ADR 0017: the transactions
// and conditions as DynamoDB runs them. equipment-api.test.ts covers the
// handler, validation and roles in memory.

import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  acceptInvite,
  addLines,
  ConflictError,
  checkout,
  createInvite,
  createTeam,
  type Db,
  EquipmentOutError,
  ForbiddenError,
  getDocument,
  getTeamSettings,
  InvalidInputError,
  listAudit,
  listMovements,
  markLost,
  returnItems,
  setDocument,
  setTeamSettings,
  type TeamContext,
  updateDocument,
} from "../src/data/index.js";
import { connection } from "../src/data/client.js";
import { keys } from "../src/data/keys.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

describe.skipIf(!endpoint)("company equipment (DynamoDB Local)", () => {
  const table = useTable();
  let db: Db;

  async function team(): Promise<TeamContext> {
    db = table.db;
    const ctx = (await createTeam(db, { userId: newUser() }, { name: "Echo" })).context;
    await stocked(ctx, "ladder", { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, stock: 4 });
    await stocked(ctx, "0123", { code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, stock: 100 });
    await setDocument(db, ctx, "sheets", "s1", { client: "Echo", date: "2026-10-01", status: "open", items: {} });
    return ctx;
  }

  async function member(ctx: TeamContext, role: "contributor" | "viewer"): Promise<TeamContext> {
    const email = `${role}-${randomUUID()}@example.com`;
    const { invite, token } = await createInvite(db, ctx, { email, role });
    return acceptInvite(db, { userId: newUser(), verifiedEmail: email }, invite, token);
  }

  // A product that already tracks stock (a document write can't set stock)
  const stocked = (ctx: TeamContext, key: string, data: Record<string, unknown>) =>
    connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.product(ctx.teamId, key), type: "product", key, version: 1, ...data } }));

  const lines = async (ctx: TeamContext, sheetId = "s1") => (await getDocument(db, ctx, "sheets", sheetId))?.data.items as Record<string, Record<string, unknown>>;
  const stock = async (ctx: TeamContext, key = "ladder") => (await getDocument(db, ctx, "products", key))?.data.stock;
  const version = async (ctx: TeamContext, sheetId = "s1") => (await getDocument(db, ctx, "sheets", sheetId))?.version as number;

  it("checks equipment out with its kind and taker, returns and loses it, and closes the sheet only once it's all accounted for", async () => {
    const ctx = await team();
    const crew = await member(ctx, "contributor");
    const at = new Date("2026-10-01T08:00:00.000Z");
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 2 }, at);
    await checkout(db, crew, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 1 }, new Date("2026-10-01T09:00:00.000Z"));
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "0123", quantity: 5 });
    expect((await lines(ctx)).ladder).toEqual({ code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, out: 3, returned: 0, takenBy: crew.userId, takenAt: "2026-10-01T09:00:00.000Z" });
    expect((await lines(ctx))["0123"]).toEqual({ code: "0123", name: "Nitrile gloves", price: 12.5, cost: 9.99, out: 5, returned: 0 });
    expect(await stock(ctx)).toBe(1);

    await expect(updateDocument(db, ctx, "sheets", "s1", { status: "closed" }, { expectedVersion: await version(ctx) })).rejects.toThrow(EquipmentOutError);
    await returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 1 });
    await markLost(db, crew, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 1, charge: 0.1 });
    await markLost(db, crew, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 1, charge: 0.2 });
    expect((await lines(ctx)).ladder).toMatchObject({ out: 3, returned: 1, lost: 2, lostCharge: 0.3 });
    // Lost doesn't move stock; the return did
    expect(await stock(ctx)).toBe(2);
    await expect(returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 1 })).rejects.toThrow("Only 0 of this item are left to return");
    await expect(markLost(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 1 })).rejects.toThrow("Only 0 of this item are still out");

    const closed = await updateDocument(db, ctx, "sheets", "s1", { status: "closed" }, { expectedVersion: await version(ctx) });
    expect(closed.after.data.status).toBe("closed");

    const history = await listMovements(db, ctx, "ladder");
    expect(history.items.map((m) => [m.reason, m.delta])).toEqual([
      ["lost", 0],
      ["lost", 0],
      ["return", 1],
      ["checkout", -1],
      ["checkout", -2],
    ]);
    // The stock history still adds up: 4 - 3 + 1
    expect(history.items.reduce((n, m) => n + m.delta, 0)).toBe(2 - 4);
  });

  it("never lets concurrent returns and lost records take an equipment line past what went out", async () => {
    const ctx = await team();
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 3 });
    const attempts = await Promise.allSettled([
      ...Array.from({ length: 3 }, () => returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 1 })),
      ...Array.from({ length: 3 }, () => markLost(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 1, charge: 10 })),
    ]);
    // Ones that found nothing left, or lost every race, changed nothing
    for (const a of attempts) if (a.status === "rejected") expect(a.reason instanceof ConflictError || a.reason instanceof InvalidInputError).toBe(true);
    const line = (await lines(ctx)).ladder as Record<string, number>;
    const returned = line.returned ?? 0;
    const lost = line.lost ?? 0;
    expect(returned + lost).toBe(attempts.filter((a) => a.status === "fulfilled").length);
    expect(returned + lost).toBeLessThanOrEqual(3);
    expect(line.lostCharge ?? 0).toBe(lost * 10);
    expect(await stock(ctx)).toBe(1 + returned);
  });

  it("bills equipment bought for a client at the receipt price plus the markup, on its own line, checked against the item and the markup in the transaction", async () => {
    const ctx = await team();
    // No settings yet: 0%
    await addLines(db, ctx, { operationId: randomUUID(), sheetId: "s1", lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", cost: 99.99 }, { productKey: "k-new", quantity: 2, name: "Tape", price: 3, cost: 2 }] });
    expect((await lines(ctx))["ladder:bought"]).toEqual({ code: "", name: "Step ladder", cost: 99.99, price: 99.99, purchased: true, priceSet: "markup", out: 1, returned: 0 });
    expect((await lines(ctx))["k-new"]).toEqual({ code: "", name: "Tape", price: 3, cost: 2, out: 2, returned: 0 });

    await setTeamSettings(db, ctx, { equipmentMarkup: 12.5 }, 0);
    await setDocument(db, ctx, "sheets", "s2", { client: "Delta", date: "2026-10-01", status: "open" });
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s2", productKey: "ladder", quantity: 1 });
    // 10.04 × 1.125 = 11.295: half a cent, up
    const bought = await addLines(db, ctx, { operationId: randomUUID(), sheetId: "s2", lines: [{ productKey: "ladder", quantity: 2, name: "Step ladder", cost: 10.04 }] });
    expect(bought.result.lines).toEqual([{ productKey: "ladder", quantity: 2, lineCreated: true, lineKey: "ladder:bought", purchased: true }]);
    expect(await lines(ctx, "s2")).toMatchObject({ ladder: { kind: "equipment", out: 1 }, "ladder:bought": { price: 11.3, cost: 10.04, out: 2, priceSet: "markup" } });
    await addLines(db, ctx, { operationId: randomUUID(), sheetId: "s2", lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", cost: 50, price: 60, priceSet: "manual" }] });
    expect((await lines(ctx, "s2"))["ladder:bought"]).toMatchObject({ price: 11.3, out: 3, priceSet: "markup" });
    // Only the checkout moved stock
    expect(await stock(ctx)).toBe(3);
    await expect(returnItems(db, ctx, { operationId: randomUUID(), sheetId: "s2", productKey: "ladder:bought", quantity: 1 })).rejects.toThrow("doesn't come back");
    await expect(addLines(db, ctx, { operationId: randomUUID(), sheetId: "s2", lines: [{ productKey: "ladder", quantity: 1, name: "Step ladder", cost: 5, price: 6 }] })).rejects.toThrow(InvalidInputError);
  });

  it("keeps the markup with owners: settings writes are owner-only and audited, and others read none of it", async () => {
    const ctx = await team();
    const crew = await member(ctx, "contributor");
    const viewer = await member(ctx, "viewer");
    expect(await getTeamSettings(db, ctx)).toEqual({ version: 0, settings: { equipmentMarkup: 0 } });
    const now = new Date("2026-10-01T10:00:00.000Z");
    expect(await setTeamSettings(db, ctx, { equipmentMarkup: 25 }, 0, now)).toEqual({ version: 1, settings: { equipmentMarkup: 25 } });
    await expect(setTeamSettings(db, ctx, { equipmentMarkup: 30 }, 0)).rejects.toThrow(ConflictError);
    // Two owners saving at once from the same version: one wins
    const race = await Promise.allSettled([setTeamSettings(db, ctx, { equipmentMarkup: 31 }, 1), setTeamSettings(db, ctx, { equipmentMarkup: 32 }, 1)]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of race) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictError);
    for (const other of [crew, viewer]) {
      await expect(setTeamSettings(db, other, { equipmentMarkup: 50 }, 2)).rejects.toThrow(ForbiddenError);
      expect(await getTeamSettings(db, other)).toEqual({ version: 2, settings: {} });
    }
    const audit = (await listAudit(db, ctx)).items.filter((e) => e.action === "settings.equipment-markup");
    expect(audit.map((e) => e.detail?.from)).toEqual([25, 0]);
    expect(audit.at(-1)).toMatchObject({ userId: ctx.userId, ts: now.toISOString(), detail: { from: 0, to: 25 } });
    expect(await rawItem(db, `TEAM#${ctx.teamId}`, "SETTINGS")).toMatchObject({ type: "settings", version: 2, updatedBy: ctx.userId });
  });

  it("refuses document writes that add bought lines, change a line's kind, or set a sheet's kind", async () => {
    const ctx = await team();
    await checkout(db, ctx, { operationId: randomUUID(), sheetId: "s1", productKey: "ladder", quantity: 1 });
    const v = await version(ctx);
    await expect(updateDocument(db, ctx, "sheets", "s1", { items: { "x:bought": { name: "X", price: 1, purchased: true, out: 1, returned: 0 } } }, { expectedVersion: v })).rejects.toThrow(InvalidInputError);
    await expect(updateDocument(db, ctx, "sheets", "s1", { items: { ladder: { kind: "supply" } } }, { expectedVersion: v })).rejects.toThrow(InvalidInputError);
    await expect(updateDocument(db, ctx, "sheets", "s1", { kind: "adhoc" }, { expectedVersion: v })).rejects.toThrow(InvalidInputError);
    await expect(setDocument(db, ctx, "products", "rope:bought", { name: "Rope" }, { expectedVersion: 0 })).rejects.toThrow(InvalidInputError);
    expect(await version(ctx)).toBe(v);
  });
});
