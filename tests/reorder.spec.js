// Low-stock alerts (supply-checkout-005.8, src/reorder.js): a reorder level per item, the Low
// badge, Running low with its count, the team's acknowledgment, and the reorder list.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, openApp } from "./helpers.js";
import { modal, waitUntilConnected, goToInventory, openProject, enterBarcode, startReturn, saveReturn, inventoryRow, addItem } from "./ui/index.js";
import { usedState, fakeImage } from "./fixtures.js";

const seed = {
  // Low: 2 left, reorder at 5
  "products/GLV": { code: "GLV", name: "Nitrile gloves", brand: "Acme", price: 12.5, stock: 2, reorderAt: 5, reorderQty: 24 },
  // Low, and acknowledged at 3: quiet until it falls below 3
  "products/nb-bins": { code: "", name: "Storage bins", price: 5, stock: 3, reorderAt: 4, ackedAtStock: 3 },
  // Has a level, isn't low
  "products/TWL": { code: "TWL", name: "Paper towels", price: 8.5, stock: 20, reorderAt: 6 },
  // Not counted: never low, whatever its level
  "products/RAG": { code: "RAG", name: "Rags", price: 1, reorderAt: 2 },
};
const doc = (page, path) => page.evaluate((p) => window.__mock.docs.get(p), path);

async function openInventory(page, opts = {}) {
  await openApp(page, { seed, ...opts });
  await waitUntilConnected(page);
  await goToInventory(page);
}
const lowChip = (page) => page.getByRole("button", { name: /^Running low/ });

test.describe("low-stock alerts", { tag: ["@J15"] }, () => {
  test("flags low items, counts the ones nobody has acknowledged, and shows the count on the Inventory tab", { tag: ["@J15.2"] }, async ({ page }) => {
    await openApp(page, { seed });
    // From the project list too: the tab says how many
    await expect(page.locator("#tab-prices")).toHaveAccessibleName("Inventory, 1 running low");
    await expect(page.locator("#tab-prices .tab-count")).toHaveText("1");
    await page.locator("#tab-prices").click();
    await expect(inventoryRow(page, "Nitrile gloves").locator(".low-badge")).toHaveText("Low");
    await expect(inventoryRow(page, "Storage bins").locator(".low-badge")).toHaveText("Low, acknowledged");
    await expect(inventoryRow(page, "Paper towels").locator(".low-badge")).toHaveCount(0);
    await expect(inventoryRow(page, "Rags").locator(".low-badge")).toHaveCount(0);
    await expect(lowChip(page)).toHaveText("Running low (1)");

    // Another member's checkout takes the acknowledged item below where it was acknowledged: it's back
    await page.evaluate(() => { window.__mock.docs.get("products/nb-bins").stock = 2; window.__mock.notify(); });
    await expect(lowChip(page)).toHaveText("Running low (2)");
    await expect(page.locator("#tab-prices")).toHaveAccessibleName("Inventory, 2 running low");
    await expect(inventoryRow(page, "Storage bins").locator(".low-badge")).toHaveText("Low");
  });

  test("offers Running low only once an item has a reorder level", { tag: ["@J15.2"] }, async ({ page }) => {
    await openInventory(page, { seed: { "products/TWL": { code: "TWL", name: "Paper towels", price: 8.5, stock: 20 } } });
    await expect(page.getByRole("button", { name: "Supplies" })).toBeVisible();
    await expect(lowChip(page)).toHaveCount(0);
    await expect(page.locator("#tab-prices")).toHaveText("Inventory");
    await page.evaluate(() => { window.__mock.docs.get("products/TWL").reorderAt = 6; window.__mock.notify(); });
    // Nothing is low: no count
    await expect(lowChip(page)).toHaveText("Running low");
    await lowChip(page).click();
    await expect(page.locator("#main")).toContainText("Nothing is running low.");
    await expect(page.getByRole("button", { name: "Copy list" })).toHaveCount(0);
    // The level removed while it's showing: it stays until another view is picked
    await page.evaluate(() => { delete window.__mock.docs.get("products/TWL").reorderAt; window.__mock.notify(); });
    await expect(page.locator("#main")).toContainText("Nothing is running low.");
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(lowChip(page)).toHaveCount(0);
  });

  test("lists what's running low, unacknowledged first, and acknowledges an item for the team", { tag: ["@J15.3"] }, async ({ page }) => {
    await openInventory(page);
    await lowChip(page).click();
    await expect(page.locator("#main")).toContainText("2 items are low or on order.");
    const rows = page.locator("#main table.reorder tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Nitrile gloves");
    await expect(rows.nth(0)).toContainText("Acme");
    await expect(rows.nth(0).locator("td")).toHaveText([/Nitrile gloves/, "2", "5", "24", "AcknowledgeMark ordered"]);
    await expect(rows.nth(1).locator("td")).toHaveText([/Storage bins/, "3", "4", "—", "AcknowledgedMark ordered"]);

    await page.getByRole("button", { name: "Acknowledge Nitrile gloves" }).click();
    await expect(page.locator("#toast")).toContainText("Acknowledged. It's flagged again if stock falls below 2.");
    expect(await doc(page, "products/GLV")).toMatchObject({ stock: 2, reorderAt: 5, reorderQty: 24, ackedAtStock: 2 });
    await expect(lowChip(page)).toHaveText("Running low");
    await expect(page.locator("#tab-prices")).toHaveText("Inventory");
    await expect(rows.nth(0)).toContainText("Nitrile gloves");
    await expect(rows.nth(0).locator("td").nth(4)).toHaveText("AcknowledgedMark ordered");
    await expect(page.locator("#main")).toContainText("2 items are low or on order.");
  });

  test("Enter on Acknowledge acknowledges, and Enter on the row opens the item", { tag: ["@J15.3"] }, async ({ page }) => {
    await openInventory(page);
    await lowChip(page).click();
    await page.getByRole("button", { name: "Acknowledge Nitrile gloves" }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await doc(page, "products/GLV")).ackedAtStock).toBe(2);
    await expect(page.locator("#overlay")).toBeHidden();
    await page.locator("#main table.reorder tbody tr", { hasText: "Storage bins" }).focus();
    await page.keyboard.press("Enter");
    await expect(modal(page).getByRole("heading", { name: "Edit item" })).toBeVisible();
    await expect(modal(page).getByLabel("Reorder at (optional)")).toHaveValue("4");
    await expect(modal(page).getByLabel("Usual order (optional)")).toHaveValue("");
  });

  test("an Acknowledge for an item deleted or no longer low since the list was drawn does nothing", { tag: ["@J15.3"] }, async ({ page }) => {
    await openInventory(page);
    await lowChip(page).click();
    await expect(page.getByRole("button", { name: "Acknowledge Nitrile gloves" })).toBeVisible();
    // As if the redraw hadn't happened yet: the button names an item that's gone, then one that isn't low
    await page.evaluate(() => { const b = document.querySelector("[data-ack]"); b.dataset.ack = "gone"; b.click(); b.dataset.ack = "TWL"; b.click(); });
    expect(await page.evaluate(() => window.__mock.writes)).toBe(0);
    expect((await doc(page, "products/GLV")).ackedAtStock).toBeUndefined();
  });

  test("an acknowledgment made on an item someone else changed meanwhile isn't saved, and the latest shows", { tag: ["@J15.3"] }, async ({ page }) => {
    await openInventory(page, { writeErrorFor: { prefix: "products/GLV", code: "aborted" } });
    await lowChip(page).click();
    await page.getByRole("button", { name: "Acknowledge Nitrile gloves" }).click();
    await expect(page.locator("#toast")).toContainText("Someone else changed this just now");
    expect((await doc(page, "products/GLV")).ackedAtStock).toBeUndefined();
  });

  test("copies and downloads the reorder list", { tag: ["@J15.3"] }, async ({ page }) => {
    await page.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { if (window.__copyFails) throw new Error("denied"); window.__copied.push(t); } } });
    });
    await openInventory(page);
    await lowChip(page).click();
    await page.getByRole("button", { name: "Copy list" }).click();
    await expect(page.locator("#toast")).toContainText("Reorder list copied");
    expect(await page.evaluate(() => window.__copied)).toEqual(["Nitrile gloves (Acme): 2 left, reorder at 5, order 24\nStorage bins: 3 left, reorder at 4"]);
    await page.evaluate(() => { window.__copyFails = true; });
    await page.getByRole("button", { name: "Copy list" }).click();
    await expect(page.locator("#toast")).toContainText("Couldn't copy here. Download the CSV instead.");

    await page.getByRole("button", { name: "Download CSV" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    expect(await page.evaluate(() => window.__mock.saves[0])).toEqual({
      filename: "Reorder list.csv",
      data: "Item,Brand,Barcode,In storage,Reorder at,Usual order,Status\nNitrile gloves,Acme,GLV,2,5,24,Low\nStorage bins,,,3,4,,Acknowledged",
    });
  });

  test("leaves the Brand column out when no item has one", { tag: ["@J15.3"] }, async ({ page }) => {
    await openInventory(page, { seed: { "products/=X": { code: "=X", name: "=SUM(A1)", price: 1, stock: 0, reorderAt: 0, brand: "  " }, "products/nb-x": { code: "", price: 1, stock: 1, reorderAt: 1 } } });
    await lowChip(page).click();
    await expect(page.locator("#main table.reorder tbody tr")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Acknowledge Unnamed item" })).toBeVisible();
    await page.getByRole("button", { name: "Mark ordered: Unnamed item" }).click();
    await expect(modal(page)).toContainText("Unnamed item");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    await page.evaluate(() => { window.__mock.docs.delete("products/nb-x"); window.__mock.notify(); });
    await expect(page.locator("#main table.reorder tbody tr")).toHaveCount(1);
    await expect(page.locator("#main")).toContainText("1 item is low or on order.");
    await page.getByRole("button", { name: "Download CSV" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    // A formula-looking name is written as text (src/export.js cell)
    expect((await page.evaluate(() => window.__mock.saves[0])).data).toBe("Item,Barcode,In storage,Reorder at,Usual order,Status\n'=SUM(A1),'=X,0,0,,Low");
  });

  test("view-only members see what's low and the list, but can't acknowledge", { tag: ["@J15.2", "@J9"] }, async ({ page }) => {
    await openInventory(page, { canWrite: false });
    await lowChip(page).click();
    await expect(page.getByRole("button", { name: /^Acknowledge/ })).toHaveCount(0);
    const rows = page.locator("#main table.reorder tbody tr");
    await expect(rows.nth(0).locator("td").nth(4)).toHaveText("Low");
    await expect(rows.nth(1).locator("td").nth(4)).toHaveText("Acknowledged");
    await rows.nth(0).click();
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(page.getByRole("button", { name: "Copy list" })).toBeVisible();
  });
});

test.describe("a restock in the app's own storage (src/moves.js)", { tag: ["@J15.3"] }, () => {
  // The mock runtime's writes end an acknowledgment as the server's commands do
  test("a return above the reorder level ends it, and one at or below keeps it", async ({ page }) => {
    const project = usedState.seed["projects/s1"];
    await openApp(page, {
      seed: {
        "products/SKU1": { ...usedState.seed["products/SKU1"], stock: 5, reorderAt: 5, ackedAtStock: 5 },
        "products/GLV": { code: "GLV", name: "Nitrile gloves", price: 12.5, stock: 2, reorderAt: 5, ackedAtStock: 2 },
        "projects/s1": { ...project, items: { SKU1: project.items.SKU1, GLV: { code: "GLV", name: "Nitrile gloves", price: 12.5, out: 2, returned: 0 } } },
      },
    });
    await openProject(page, "Echo Studio");
    for (const code of ["SKU1", "GLV"]) {
      await startReturn(page);
      await enterBarcode(page, code);
      await saveReturn(page);
      await expect(page.locator("#overlay")).toBeHidden();
    }
    await expect.poll(async () => (await doc(page, "products/GLV")).stock).toBe(3);
    expect(await doc(page, "products/SKU1")).toMatchObject({ stock: 6, reorderAt: 5 });
    expect(await doc(page, "products/SKU1")).not.toHaveProperty("ackedAtStock");
    expect(await doc(page, "products/GLV")).toMatchObject({ stock: 3, ackedAtStock: 2 });
  });

  test("a receipt into storage above the reorder level ends it", async ({ page }) => {
    // Line 0 of the receipt is 4 storage bins, matched to nb-bins (i2)
    const receipt = { ...usedState.receipt, items: usedState.receipt.items.slice(0, 1).map((it) => ({ ...it, match: "i2" })) };
    await openApp(page, { ...usedState, receipt, seed: { ...usedState.seed, "products/nb-bins": { ...usedState.seed["products/nb-bins"], reorderAt: 4, ackedAtStock: 2 } } });
    await page.setInputFiles("#receiptFile", fakeImage);
    await page.locator(".rline").nth(0).locator('[data-f="dest"]').selectOption({ label: "General inventory (storage)" });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#toast")).toHaveText("4 added to storage");
    expect(await doc(page, "products/nb-bins")).toMatchObject({ stock: 6, reorderAt: 4 });
    expect(await doc(page, "products/nb-bins")).not.toHaveProperty("ackedAtStock");
  });

  test("a count above the level, a count with no level, and no count at all end it; a count at the level keeps it", async ({ page }) => {
    await openInventory(page, { seed: { ...seed, "products/OLD": { code: "OLD", name: "Old stock", price: 1, stock: 1, ackedAtStock: 1 } } });
    const count = async (name, value) => {
      await inventoryRow(page, name).click();
      await modal(page).getByLabel("Single items in storage now").fill(value);
      await modal(page).getByRole("button", { name: "Save" }).click();
      await expect(page.locator("#overlay")).toBeHidden();
    };
    await count("Storage bins", "4");
    expect(await doc(page, "products/nb-bins")).toMatchObject({ stock: 4, ackedAtStock: 3 });
    await count("Storage bins", "9");
    expect(await doc(page, "products/nb-bins")).not.toHaveProperty("ackedAtStock");
    await count("Old stock", "2");
    expect(await doc(page, "products/OLD")).not.toHaveProperty("ackedAtStock");
    // Uncounting an acknowledged item
    await page.evaluate(() => { window.__mock.docs.get("products/GLV").ackedAtStock = 2; window.__mock.notify(); });
    await expect(inventoryRow(page, "Nitrile gloves").locator(".low-badge")).toHaveText("Low, acknowledged");
    await count("Nitrile gloves", "");
    expect(await doc(page, "products/GLV")).not.toHaveProperty("ackedAtStock");
    expect(await doc(page, "products/GLV")).not.toHaveProperty("stock");
  });
});

test.describe("orders (supply-checkout-005.14)", { tag: ["@J15.4"] }, () => {
  const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  test("marks an item ordered with its usual order and today, quiets it until it's cancelled, and replaces the acknowledgment", async ({ page }) => {
    await openInventory(page);
    await lowChip(page).click();
    await page.getByRole("button", { name: "Mark ordered: Nitrile gloves" }).click();
    await expect(modal(page).getByRole("heading", { name: "Mark ordered" })).toBeVisible();
    await expect(modal(page)).toContainText("Nitrile gloves");
    await expect(modal(page).getByLabel("How many ordered")).toHaveValue("24");
    await expect(modal(page).getByLabel("Ordered on")).toHaveValue(today());
    await modal(page).getByLabel("Ordered on").fill("2026-10-01");
    await modal(page).getByRole("button", { name: "Mark ordered" }).click();
    await expect(page.locator("#toast")).toHaveText("Marked 24 ordered");
    expect(await doc(page, "products/GLV")).toMatchObject({ stock: 2, reorderAt: 5, reorderQty: 24, orderedQty: 24, orderedOn: "2026-10-01" });

    const rows = page.locator("#main table.reorder tbody tr");
    // On order sorts after what still needs looking at, and isn't counted
    await expect(lowChip(page)).toHaveText("Running low");
    await expect(page.locator("#tab-prices")).toHaveText("Inventory");
    await expect(rows.nth(0).locator("td").nth(4)).toHaveText("On order: 24 since Oct 1, 2026Cancel order");
    // Falling further doesn't bring it back while it's on order
    await page.evaluate(() => { window.__mock.docs.get("products/GLV").stock = 0; window.__mock.notify(); });
    await expect(rows.nth(0).locator("td").nth(1)).toHaveText("0");
    await expect(lowChip(page)).toHaveText("Running low");

    // The acknowledged item, ordered: the order replaces the acknowledgment; a quantity is needed
    await page.getByRole("button", { name: "Mark ordered: Storage bins" }).click();
    await expect(modal(page).getByLabel("How many ordered")).toHaveValue("");
    await modal(page).getByRole("button", { name: "Mark ordered" }).click();
    await expect(modal(page).getByRole("heading", { name: "Mark ordered" })).toBeVisible();
    await modal(page).getByLabel("How many ordered").fill("6");
    await modal(page).getByRole("button", { name: "Mark ordered" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    const bins = await doc(page, "products/nb-bins");
    expect(bins).toMatchObject({ orderedQty: 6, orderedOn: today() });
    expect(bins).not.toHaveProperty("ackedAtStock");

    // Inventory says so too
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(inventoryRow(page, "Nitrile gloves").locator(".low-badge")).toHaveText("On order");
    await lowChip(page).click();

    // Cancelling brings the alert back
    await page.getByRole("button", { name: "Cancel the order of Nitrile gloves" }).click();
    await expect(page.locator("#toast")).toHaveText("Order cancelled. It's flagged again while it's low.");
    await expect(lowChip(page)).toHaveText("Running low (1)");
    const gloves = await doc(page, "products/GLV");
    expect(gloves).not.toHaveProperty("orderedQty");
    expect(gloves).not.toHaveProperty("orderedOn");
    expect(gloves).toMatchObject({ stock: 0, reorderQty: 24, brand: "Acme" });
  });

  test("lists, copies and downloads what's on order, even when it isn't counted or has no level", async ({ page }) => {
    await page.addInitScript(() => {
      window.__copied = [];
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
    });
    await openInventory(page, { seed: { "products/A": { code: "A", name: "Aprons", price: 3, orderedQty: 10, orderedOn: "2026-10-02" }, "products/B": { code: "B", name: "Bleach", price: 4, stock: 1, reorderAt: 1, reorderQty: 6, orderedQty: 6, orderedOn: "2026-10-03" } } });
    await lowChip(page).click();
    const rows = page.locator("#main table.reorder tbody tr");
    await expect(rows.nth(0).locator("td")).toHaveText([/Aprons/, "—", "—", "—", "On order: 10 since Oct 2, 2026Cancel order"]);
    await page.getByRole("button", { name: "Copy list" }).click();
    await expect(page.locator("#toast")).toContainText("Reorder list copied");
    expect(await page.evaluate(() => window.__copied[0])).toBe("Aprons: not counted left, reorder at none, on order: 10 since Oct 2, 2026\nBleach: 1 left, reorder at 1, order 6, on order: 6 since Oct 3, 2026");
    await page.getByRole("button", { name: "Download CSV" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    expect((await page.evaluate(() => window.__mock.saves[0])).data).toBe("Item,Barcode,In storage,Reorder at,Usual order,Status\nAprons,A,,,,10 ordered 2026-10-02\nBleach,B,1,1,6,6 ordered 2026-10-03");
  });

  test("view-only members see what's on order, without the buttons", async ({ page }) => {
    await openInventory(page, { canWrite: false, seed: { ...seed, "products/GLV": { ...seed["products/GLV"], orderedQty: 24, orderedOn: "2026-10-01" } } });
    await lowChip(page).click();
    await expect(page.locator("#main table.reorder tbody tr", { hasText: "Nitrile gloves" }).locator("td").nth(4)).toHaveText("On order: 24 since Oct 1, 2026");
    await expect(page.getByRole("button", { name: /Mark ordered|Cancel the order/ })).toHaveCount(0);
  });

  test("a mark or cancel for an item deleted since the list was drawn does nothing", async ({ page }) => {
    await openInventory(page, { seed: { ...seed, "products/GLV": { ...seed["products/GLV"], orderedQty: 24, orderedOn: "2026-10-01" } } });
    await lowChip(page).click();
    await expect(page.getByRole("button", { name: "Cancel the order of Nitrile gloves" })).toBeVisible();
    await page.evaluate(() => {
      for (const b of document.querySelectorAll("[data-order], [data-cancel-order]")) { if (b.dataset.order) b.dataset.order = "gone"; else b.dataset.cancelOrder = "gone"; b.click(); }
    });
    expect(await page.evaluate(() => window.__mock.writes)).toBe(0);
    await expect(page.locator("#overlay")).toBeHidden();
  });

  test("a count above the level ends the order, and an editor save that leaves an item uncounted keeps its marks", async ({ page }) => {
    await openInventory(page, { seed: { ...seed, "products/GLV": { ...seed["products/GLV"], orderedQty: 24, orderedOn: "2026-10-01" }, "products/OLD": { code: "OLD", name: "Old stock", price: 1, reorderAt: 3, ackedAtStock: 1, orderedQty: 2, orderedOn: "2026-10-01" } } });
    await inventoryRow(page, "Old stock").click();
    await modal(page).getByLabel("Item name").fill("Old stock, boxed");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    expect(await doc(page, "products/OLD")).toMatchObject({ name: "Old stock, boxed", ackedAtStock: 1, orderedQty: 2, orderedOn: "2026-10-01" });
    await inventoryRow(page, "Nitrile gloves").click();
    await modal(page).getByLabel("Single items in storage now").fill("30");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    const gloves = await doc(page, "products/GLV");
    expect(gloves).toMatchObject({ stock: 30 });
    expect(gloves).not.toHaveProperty("orderedQty");
  });
});

test.describe("the reorder level in the item editor", { tag: ["@J15.1"] }, () => {
  test("sets a new item's reorder level and usual order", async ({ page }) => {
    await openInventory(page, { seed: {} });
    await addItem(page, { barcode: "SPR", name: "Spray bottles", reorderAt: "3", usualOrder: "24", stock: "3" });
    await expect(inventoryRow(page, "Spray bottles").locator(".low-badge")).toHaveText("Low");
    expect(await doc(page, "products/SPR")).toMatchObject({ reorderAt: 3, reorderQty: 24, stock: 3 });
  });

  test("keeps the acknowledgment when the level stays, and starts afresh when it changes or is cleared", async ({ page }) => {
    await openInventory(page);
    await inventoryRow(page, "Storage bins").click();
    await expect(modal(page).getByLabel("Reorder at (optional)")).toHaveValue("4");
    await modal(page).getByLabel("Usual order (optional)").fill("12");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    expect(await doc(page, "products/nb-bins")).toMatchObject({ reorderAt: 4, reorderQty: 12, ackedAtStock: 3 });

    await inventoryRow(page, "Storage bins").click();
    await modal(page).getByLabel("Reorder at (optional)").fill("6");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(inventoryRow(page, "Storage bins").locator(".low-badge")).toHaveText("Low");
    expect((await doc(page, "products/nb-bins")).ackedAtStock).toBeUndefined();

    await inventoryRow(page, "Nitrile gloves").click();
    await modal(page).getByLabel("Reorder at (optional)").fill("");
    await modal(page).getByLabel("Usual order (optional)").fill("");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(inventoryRow(page, "Nitrile gloves").locator(".low-badge")).toHaveCount(0);
    const gloves = await doc(page, "products/GLV");
    expect(gloves).not.toHaveProperty("reorderAt");
    expect(gloves).not.toHaveProperty("reorderQty");
    expect(gloves.brand).toBe("Acme");
  });
});

for (const colorScheme of ["light", "dark"]) {
  test(`Running low is accessible and fits a phone (${colorScheme})`, { tag: ["@J15.3"] }, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    await page.setViewportSize({ width: 375, height: 740 });
    await openInventory(page);
    const axe = async () => (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
    await expect(inventoryRow(page, "Nitrile gloves").locator(".low-badge")).toBeVisible();
    expect(await axe()).toEqual([]);
    await lowChip(page).click();
    await expect(page.locator("#main table.reorder")).toBeVisible();
    expect(await axe()).toEqual([]);
    const { overflow, culprits } = await page.evaluate(() => {
      const width = window.innerWidth;
      const culprits = [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > width + 0.5 && !el.closest(".table-wrap, [hidden]"))
        .slice(-5).map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).trim()}`);
      return { overflow: document.documentElement.scrollWidth - width, culprits };
    });
    expect(overflow, `elements past the edge: ${culprits.join(", ")}`).toBeLessThanOrEqual(0);
    await inventoryRow(page, "Nitrile gloves").click();
    await expect(modal(page).getByLabel("Reorder at (optional)")).toBeVisible();
    await expect(modal(page)).toHaveCSS("opacity", "1");
    expect(await axe()).toEqual([]);
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // Mark ordered, and the row on order
    await page.getByRole("button", { name: "Mark ordered: Nitrile gloves" }).click();
    await expect(modal(page).getByLabel("How many ordered")).toBeVisible();
    await expect(modal(page)).toHaveCSS("opacity", "1");
    expect(await axe()).toEqual([]);
    await modal(page).getByRole("button", { name: "Mark ordered" }).click();
    await expect(page.getByRole("button", { name: "Cancel the order of Nitrile gloves" })).toBeVisible();
    expect(await axe()).toEqual([]);
  });
}
