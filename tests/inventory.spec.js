import { test, expect, openApp, modal, inventoryRow } from "./helpers.js";
import { usedState } from "./fixtures.js";

const openInventory = async (page, opts = {}) => {
  await openApp(page, { ...usedState, ...opts });
  await page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });
  await page.getByRole("button", { name: "Inventory" }).click();
};

test("lists items with storage counts, value and totals", async ({ page }) => {
  await openInventory(page);
  await expect(page.locator("#main")).toContainText("2 items.");
  await expect(inventoryRow(page, "Paper towels").locator("td").nth(3)).toHaveText("—");
  await expect(inventoryRow(page, "Paper towels").locator("td").nth(4)).toHaveText("$85.00");
  await expect(page.locator("#main tfoot")).toContainText("12");
  await expect(page.locator("#main tfoot")).toContainText("$95.00");
});

test("adds an item with a barcode and a storage count", async ({ page }) => {
  await openInventory(page);
  await page.getByRole("button", { name: "+ Add item" }).click();
  await expect(modal(page).getByRole("heading", { name: "Add item" })).toBeVisible();
  await modal(page).getByPlaceholder("Type, scan, or leave blank").fill("  998877 ");
  await modal(page).getByLabel("Item name").fill("Glass cleaner");
  await modal(page).getByLabel("In storage now").fill("6");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(inventoryRow(page, "Glass cleaner")).toContainText("Barcode 998877");
  await expect(inventoryRow(page, "Glass cleaner").locator("td").nth(1)).toHaveText("6");
  await expect(inventoryRow(page, "Glass cleaner").locator("td").nth(2)).toHaveText("$0.00");
  expect(await page.evaluate(() => window.__mock.docs.has("products/998877"))).toBe(true);
});

test("adds an uncounted item without a barcode", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Inventory" }).click();
  await expect(page.getByText("No items yet.")).toBeVisible();
  await page.getByRole("button", { name: "+ Add item" }).click();
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#overlay")).toBeVisible();
  await modal(page).getByLabel("Item name").fill("Ladder");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#main")).toContainText("1 item.");
  await expect(inventoryRow(page, "Ladder")).toContainText("No barcode");
  await expect(inventoryRow(page, "Ladder").locator("td").nth(1)).toHaveText("—");
  await expect(inventoryRow(page, "Ladder").locator("td").nth(4)).toHaveText("—");
  expect(await page.evaluate(() => Object.keys(window.__mock.docs.get([...window.__mock.docs.keys()].find(k => k.startsWith("products/")))).sort())).toEqual(["code", "name", "price", "updatedAt"]);
});

test("an item's name can't be only spaces", async ({ page }) => {
  await openInventory(page);
  await page.getByRole("button", { name: "+ Add item" }).click();
  await modal(page).getByLabel("Item name").fill("   ");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(modal(page).getByRole("heading", { name: "Add item" })).toBeVisible();
});

test("edits an item's name, price and count", async ({ page }) => {
  await openInventory(page);
  await inventoryRow(page, "Storage bins").click();
  await expect(modal(page).getByRole("heading", { name: "Edit item" })).toBeVisible();
  await expect(modal(page)).toContainText("No barcode");
  await expect(modal(page)).toContainText("Price changes apply to new checkouts");
  await modal(page).getByLabel("Item name").fill("Storage bins, 16 qt");
  await modal(page).getByLabel("Price each ($)").fill("7");
  await modal(page).getByLabel("In storage now").fill("");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(inventoryRow(page, "Storage bins, 16 qt").locator("td").nth(1)).toHaveText("—");
  await expect(inventoryRow(page, "Storage bins, 16 qt").locator("td").nth(2)).toHaveText("$7.00");

  await inventoryRow(page, "Paper towels").click();
  await expect(modal(page)).toContainText("Barcode SKU1");
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("deletes an item with two taps", async ({ page }) => {
  await openInventory(page);
  await inventoryRow(page, "Storage bins").click();
  await modal(page).getByRole("button", { name: "Delete" }).click();
  await modal(page).getByRole("button", { name: "Tap to delete" }).click();
  await expect(page.locator("#toast")).toHaveText("Item deleted");
  await expect(inventoryRow(page, "Storage bins")).toHaveCount(0);
});

test("view-only users see inventory but can't change it", async ({ page }) => {
  await openInventory(page, { canWrite: false });
  await expect(page.getByRole("button", { name: "+ Add item" })).toHaveCount(0);
  await inventoryRow(page, "Paper towels").click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("without shared storage, lists say they're loading and saves explain why they failed", async ({ page }) => {
  await openApp(page, { unavailable: ["db"] });
  await expect(page.getByText("Loading sheets…")).toBeVisible();
  await page.getByRole("button", { name: "Inventory" }).click();
  await expect(page.getByText("Loading…")).toBeVisible();
  await page.getByRole("button", { name: "+ Add item" }).click();
  await modal(page).getByLabel("Item name").fill("Brooms");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText("Not connected to shared storage.");
});

test("keys other than Enter don't open an item", async ({ page }) => {
  await openInventory(page);
  await inventoryRow(page, "Paper towels").press("a");
  await expect(page.locator("#overlay")).toBeHidden();
});

// ADR 0014: cost each and pack size, kept apart from the client price
const costed = {
  seed: {
    "products/SKU1": { code: "SKU1", name: "Paper towels, 6 roll", price: 8.5, cost: 6.25, packSize: 12, stock: 10, note: "keep me" },
    "products/nb-bins": { code: "", name: "Storage bins, 12 qt", price: 2.675, cost: 1.005, stock: 2 },
    "products/nb-free": { code: "", name: "Free samples", stock: 3 },
  },
};

test("shows cost each, and values storage at cost where it's known", async ({ page }) => {
  await openInventory(page, costed);
  await expect(page.locator("#main thead")).toContainText("Cost each");
  const towels = inventoryRow(page, "Paper towels").locator("td");
  await expect(towels.nth(2)).toHaveText("$8.50");
  await expect(towels.nth(3)).toHaveText("$6.25");
  await expect(towels.nth(4)).toHaveText("$62.50");
  // Money is rounded to cents, halves up: 1.005 is $1.01
  await expect(inventoryRow(page, "Storage bins").locator("td").nth(3)).toHaveText("$1.01");
  await expect(inventoryRow(page, "Storage bins").locator("td").nth(4)).toHaveText("$2.02");
  // No cost and no price: unknown cost, valued at nothing
  await expect(inventoryRow(page, "Free samples").locator("td").nth(3)).toHaveText("—");
  await expect(inventoryRow(page, "Free samples").locator("td").nth(4)).toHaveText("$0.00");
  await expect(page.locator("#main tfoot td").nth(4)).toHaveText("$64.52");
});

test("editing an item keeps its cost, pack size and any other fields", async ({ page }) => {
  await openInventory(page, costed);
  await inventoryRow(page, "Paper towels").click();
  await expect(modal(page).getByLabel("Cost each ($)")).toHaveValue("6.25");
  await expect(modal(page).getByLabel("Comes in packs of")).toHaveValue("12");
  await modal(page).getByLabel("Item name").fill("Paper towels, 8 roll");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(inventoryRow(page, "Paper towels, 8 roll")).toBeVisible();
  expect(await page.evaluate(() => window.__mock.docs.get("products/SKU1"))).toEqual({
    code: "SKU1", name: "Paper towels, 8 roll", price: 8.5, cost: 6.25, packSize: 12, stock: 10, note: "keep me", updatedAt: expect.any(String),
  });
});

test("edits cost and pack size, rounds old money values, and clears them when blank", async ({ page }) => {
  await openInventory(page, costed);
  await inventoryRow(page, "Storage bins").click();
  // Values saved before rounding show, and save, rounded to cents
  await expect(modal(page).getByLabel("Price each ($)")).toHaveValue("2.68");
  await expect(modal(page).getByLabel("Cost each ($)")).toHaveValue("1.01");
  await expect(modal(page).getByLabel("Comes in packs of")).toHaveValue("");
  await modal(page).getByLabel("Comes in packs of").fill("6");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
  expect(await page.evaluate(() => window.__mock.docs.get("products/nb-bins"))).toMatchObject({ price: 2.68, cost: 1.01, packSize: 6, stock: 2 });

  await inventoryRow(page, "Storage bins").click();
  await modal(page).getByLabel("Cost each ($)").fill("");
  await modal(page).getByLabel("Comes in packs of").fill("");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(inventoryRow(page, "Storage bins").locator("td").nth(3)).toHaveText("—");
  const bins = await page.evaluate(() => window.__mock.docs.get("products/nb-bins"));
  expect(bins.cost).toBeUndefined();
  expect(bins.packSize).toBeUndefined();

  // A new item with a cost and a pack size
  await page.getByRole("button", { name: "+ Add item" }).click();
  await expect(modal(page).getByLabel("Cost each ($)")).toHaveValue("");
  await modal(page).getByLabel("Item name").fill("Trash bags, case");
  await modal(page).getByLabel("Price each ($)").fill("0.75");
  await modal(page).getByLabel("Cost each ($)").fill("0.5");
  await modal(page).getByLabel("In storage now").fill("90");
  await modal(page).getByLabel("Comes in packs of").fill("45");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(inventoryRow(page, "Trash bags").locator("td").nth(4)).toHaveText("$45.00");
  const bags = await page.evaluate(() => [...window.__mock.docs.entries()].find(([, d]) => d.name === "Trash bags, case")[1]);
  expect(bags).toEqual({ code: "", name: "Trash bags, case", price: 0.75, cost: 0.5, stock: 90, packSize: 45, updatedAt: expect.any(String) });
});
