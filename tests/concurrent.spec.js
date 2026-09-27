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

test("a return saved after someone else removed the line says so, and doesn't make a partial line", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await elsewhere(page, (docs) => { delete docs.get("sheets/s1").items.SKU1; });
  await expect(lineRow(page, "Paper towels")).toHaveCount(0);
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(page.locator("#toast")).toHaveText("Someone else removed this item from the sheet, so the return wasn't saved.");
  await expect(page.locator("#overlay")).toBeHidden();
  const [line, stock] = await page.evaluate(() => [window.__mock.docs.get("sheets/s1").items.SKU1, window.__mock.docs.get("products/SKU1").stock]);
  expect(line).toBeUndefined();
  expect(stock).toBe(10);
  await expect(lineRow(page, "Paper towels")).toHaveCount(0);
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
  // Removed as a null line, in one update (removeLine in src/main.js)
  expect(Object.keys(doc.items)).toEqual(["SKU1", "nb-bins"]);
  expect(doc.items["nb-bins"]).toBeNull();
  await expect(lineRow(page, "Storage bins")).toHaveCount(0);
  await expect(lineRow(page, "Paper towels")).toHaveCount(1);
});

// claude.ai's db has no conditional writes, so a read and then a write could save a sheet
// deleted in between. Removing a line writes without reading first.
test("removing a line from a sheet deleted as it saves doesn't make the sheet again", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  await page.evaluate(() => window.__mock.hold("sheets/"));
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.writes)).toBe(1);
  // Deleted after the page asked to remove the line, before the write arrives
  await elsewhere(page, (docs) => docs.delete("sheets/s1"));
  await page.evaluate(() => window.__mock.release());
  await stillDeleted(page);
});

test("a line removed as a null line doesn't show or count", async ({ page }) => {
  const seed = structuredClone(usedState.seed);
  seed["sheets/s1"].items["nb-bins"] = null;
  await openApp(page, { ...usedState, seed });
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toContainText("1 item · 3 taken");
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await expect(lineRow(page, "Paper towels")).toHaveCount(1);
  await expect(page.locator("#sheetBody tbody tr")).toHaveCount(1);
  // Checking the item out again makes a new line
  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  await modal(page).getByRole("button", { name: /Storage bins/ }).click();
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Storage bins").locator("td").nth(2)).toHaveText("1");
  expect(await page.evaluate(() => window.__mock.docs.get("sheets/s1").items["nb-bins"])).toMatchObject({ out: 1, returned: 0 });
});

test("where the runtime refuses a null value, removing a line saves the sheet without it", async ({ page }) => {
  await openApp(page, { ...usedState, rejectsNull: true });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await lineRow(page, "Storage bins").click();
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("Removed");
  expect(Object.keys(await page.evaluate(() => window.__mock.docs.get("sheets/s1").items))).toEqual(["SKU1"]);
  await expect(lineRow(page, "Storage bins")).toHaveCount(0);
});

test("removing a line that fails for the connection keeps it", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  await page.evaluate(() => { window.__mock.failWrites = "unavailable"; });
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("That didn't save. Check your connection and try again.");
  expect(await page.evaluate(() => window.__mock.docs.get("sheets/s1").items["nb-bins"])).toMatchObject({ out: 2 });
});

// The artifact adds a checkout or return to the line as it's saved now, even before this page
// hears of someone else's change (src/moves.js). The web build's commands add on the server.
test("a checkout adds to the saved line when this page hasn't heard of a change yet", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await page.evaluate(() => { window.__mock.docs.get("sheets/s1").items.SKU1.out = 5; });
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(page.locator("#toast")).toHaveText("Checked out 1 × Paper towels, 6 roll");
  expect(await page.evaluate(() => window.__mock.docs.get("sheets/s1").items.SKU1)).toMatchObject({ out: 6, returned: 1 });
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("6");
});

test("a return adds to the saved line when this page hasn't heard of a change yet", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await page.evaluate(() => { window.__mock.docs.get("sheets/s1").items.SKU1.returned = 2; });
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(page.locator("#toast")).toHaveText("1 returned · 3 of 3 back");
  expect(await page.evaluate(() => [window.__mock.docs.get("sheets/s1").items.SKU1.returned, window.__mock.docs.get("products/SKU1").stock])).toEqual([3, 11]);
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
  // It says the sheet was deleted, and the page stays writable
  await stillDeleted(page);
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
  // It says the sheet was deleted, and the page stays writable
  await stillDeleted(page);
  expect(await page.evaluate(() => [window.__mock.docs.has("sheets/s1"), window.__mock.docs.get("products/SKU1").stock])).toEqual([false, stock]);
});
