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

const DELETED = "Someone else deleted this sheet, so your change wasn't saved.";
// The sheet stays deleted, and the page can still make changes
const stillDeleted = async (page) => {
  await expect(page.locator("#toast")).toHaveText(DELETED);
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.locator("#notice")).toBeHidden();
  await expect(page.getByRole("button", { name: "+ New sheet" })).toBeVisible();
  expect(await page.evaluate(() => window.__mock.docs.has("sheets/s1"))).toBe(false);
};

test("removing a line from a sheet someone else deleted says so, and doesn't make the sheet again", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  await elsewhere(page, (docs) => docs.delete("sheets/s1"));
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await stillDeleted(page);
});

test("saving a line on a sheet someone else deleted says so", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  await elsewhere(page, (docs) => docs.delete("sheets/s1"));
  await modal(page).getByRole("button", { name: "Save" }).click();
  await stillDeleted(page);
});

test("a checkout on a sheet someone else deleted says so, not that access is view-only", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await elsewhere(page, (docs) => docs.delete("sheets/s1"));
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await stillDeleted(page);
  // The storage count didn't move for a checkout that didn't save
  expect(await page.evaluate(() => window.__mock.docs.get("products/SKU1").stock)).toBe(10);
});

test("a return on a sheet someone else deleted says so, not that access is view-only", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await elsewhere(page, (docs) => docs.delete("sheets/s1"));
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await stillDeleted(page);
});

test("removing a line keeps what someone else changed on the sheet meanwhile", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  // Changed before this page hears of it
  await page.evaluate(() => { window.__mock.docs.get("sheets/s1").client = "Echo Studio West"; });
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("Removed");
  const doc = await page.evaluate(() => window.__mock.docs.get("sheets/s1"));
  expect(doc.client).toBe("Echo Studio West");
  expect(Object.keys(doc.items)).toEqual(["SKU1"]);
});

test("picking an item someone else just deleted still opens checkout", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  await elsewhere(page, (docs) => docs.delete("products/nb-bins"));
  await modal(page).getByRole("button", { name: /Storage bins/ }).click();
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(modal(page)).toContainText("No barcode");
});
