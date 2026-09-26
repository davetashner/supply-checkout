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
  await expect(inventoryRow(page, "Paper towels").locator("td").nth(3)).toHaveText("$85.00");
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
  await expect(inventoryRow(page, "Ladder").locator("td").nth(3)).toHaveText("—");
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
