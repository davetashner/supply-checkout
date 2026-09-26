// Several people use the app at once. These tests change the shared data
// "from another device" while a form is open, and check nothing breaks.
import { test, expect, openApp, enterBarcode, modal, lineRow } from "./helpers.js";
import { usedState } from "./fixtures.js";

// Acts as another user: changes the stored data, then fires live updates
const elsewhere = (page, fn) => page.evaluate(`(${fn})(window.__mock.docs); window.__mock.notify();`);

const openEcho = async (page) => {
  await openApp(page, usedState);
  await page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
};

test("a sheet deleted by someone else closes and returns to the list", async ({ page }) => {
  await openEcho(page);
  await elsewhere(page, (docs) => docs.delete("sheets/s1"));
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
});

test("checking out again adds to the latest count", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await elsewhere(page, (docs) => { docs.get("sheets/s1").items.SKU1.out = 5; });
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("6");
});

test("a return saved after someone else removed the line still records it", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await elsewhere(page, (docs) => { delete docs.get("sheets/s1").items.SKU1; });
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(page.locator("#toast")).toContainText("returned");
});

test("editing a line on a sheet someone else deleted doesn't crash", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  await elsewhere(page, (docs) => docs.delete("sheets/s1"));
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("Removed");
});

test("picking an item someone else just deleted still opens checkout", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  await elsewhere(page, (docs) => docs.delete("products/nb-bins"));
  await modal(page).getByRole("button", { name: /Storage bins/ }).click();
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(modal(page)).toContainText("No barcode");
});

// The checkout and return forms save against the latest copy of the sheet, or the one they
// opened on if it's gone. Neither brings back a sheet someone else deleted, or moves stock.
test("a checkout on a sheet someone else deleted doesn't bring it back or move stock", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  const stock = await page.evaluate(() => window.__mock.docs.get("products/SKU1").stock);
  await elsewhere(page, (docs) => docs.delete("sheets/s1"));
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(page.locator("#toast")).toBeVisible();
  expect(await page.evaluate(() => [window.__mock.docs.has("sheets/s1"), window.__mock.docs.get("products/SKU1").stock])).toEqual([false, stock]);
});

test("a return on a sheet someone else deleted doesn't bring it back or move stock", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  const stock = await page.evaluate(() => window.__mock.docs.get("products/SKU1").stock);
  await elsewhere(page, (docs) => docs.delete("sheets/s1"));
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(page.locator("#toast")).toBeVisible();
  expect(await page.evaluate(() => [window.__mock.docs.has("sheets/s1"), window.__mock.docs.get("products/SKU1").stock])).toEqual([false, stock]);
});
