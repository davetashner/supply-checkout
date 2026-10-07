// Low-stock alerts (supply-checkout-005.8, src/reorder.js): a reorder level per item, the Low
// badge, Running low with its count, the team's acknowledgment, and the reorder list.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, openApp, modal, inventoryRow } from "./helpers.js";

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
  await page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });
  await page.getByRole("button", { name: "Inventory" }).click();
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
    await expect(page.locator("#main")).toContainText("2 items are at or below the reorder level.");
    const rows = page.locator("#main table.reorder tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Nitrile gloves");
    await expect(rows.nth(0)).toContainText("Acme");
    await expect(rows.nth(0).locator("td")).toHaveText([/Nitrile gloves/, "2", "5", "24", "Acknowledge"]);
    await expect(rows.nth(1).locator("td")).toHaveText([/Storage bins/, "3", "4", "—", "Acknowledged"]);

    await page.getByRole("button", { name: "Acknowledge Nitrile gloves" }).click();
    await expect(page.locator("#toast")).toContainText("Acknowledged. It's flagged again if stock falls below 2.");
    expect(await doc(page, "products/GLV")).toMatchObject({ stock: 2, reorderAt: 5, reorderQty: 24, ackedAtStock: 2 });
    await expect(lowChip(page)).toHaveText("Running low");
    await expect(page.locator("#tab-prices")).toHaveText("Inventory");
    await expect(rows.nth(0)).toContainText("Nitrile gloves");
    await expect(rows.nth(0).locator("td").nth(4)).toHaveText("Acknowledged");
    await expect(page.locator("#main")).toContainText("2 items are at or below the reorder level.");
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
      data: "Item,Brand,Barcode,In storage,Reorder at,Usual order,Acknowledged\nNitrile gloves,Acme,GLV,2,5,24,No\nStorage bins,,,3,4,,Yes",
    });
  });

  test("leaves the Brand column out when no item has one", { tag: ["@J15.3"] }, async ({ page }) => {
    await openInventory(page, { seed: { "products/=X": { code: "=X", name: "=SUM(A1)", price: 1, stock: 0, reorderAt: 0, brand: "  " }, "products/nb-x": { code: "", price: 1, stock: 1, reorderAt: 1 } } });
    await lowChip(page).click();
    await expect(page.locator("#main table.reorder tbody tr")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Acknowledge Unnamed item" })).toBeVisible();
    await page.evaluate(() => { window.__mock.docs.delete("products/nb-x"); window.__mock.notify(); });
    await expect(page.locator("#main table.reorder tbody tr")).toHaveCount(1);
    await expect(page.locator("#main")).toContainText("1 item is at or below the reorder level.");
    await page.getByRole("button", { name: "Download CSV" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    // A formula-looking name is written as text (src/export.js cell)
    expect((await page.evaluate(() => window.__mock.saves[0])).data).toBe("Item,Barcode,In storage,Reorder at,Usual order,Acknowledged\n'=SUM(A1),'=X,0,0,,No");
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

test.describe("the reorder level in the item editor", { tag: ["@J15.1"] }, () => {
  test("sets a new item's reorder level and usual order", async ({ page }) => {
    await openInventory(page, { seed: {} });
    await page.getByRole("button", { name: "+ Add item" }).click();
    await modal(page).getByPlaceholder("Type, scan, or leave blank").fill("SPR");
    await modal(page).getByLabel("Item name").fill("Spray bottles");
    await modal(page).getByLabel("Reorder at (optional)").fill("3");
    await modal(page).getByLabel("Usual order (optional)").fill("24");
    await modal(page).getByLabel("Single items in storage now").fill("3");
    await modal(page).getByRole("button", { name: "Save" }).click();
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
  });
}
