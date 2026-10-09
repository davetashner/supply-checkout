// Several people use the app at once. These tests change the shared data
// "from another device" while a form is open, and check nothing breaks.
import { test, expect, openApp } from "./helpers.js";
import { modal, waitUntilConnected, goToInventory, openProject, enterBarcode, addToProject, startReturn, saveReturn, lineRow, inventoryRow } from "./ui/index.js";
import { usedState } from "./fixtures.js";

// Acts as another user: changes the stored data, then fires live updates
const elsewhere = (page, fn) => page.evaluate(`(${fn})(window.__mock.docs); window.__mock.notify();`);

const openEcho = async (page) => {
  await openApp(page, usedState);
  await waitUntilConnected(page);
  await openProject(page, "Echo Studio");
};

test("a project deleted by someone else closes and returns to the list", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page);
  await elsewhere(page, (docs) => docs.delete("projects/s1"));
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
});

test("checking out again adds to the latest count", { tag: ["@J4.2"] }, async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await elsewhere(page, (docs) => { docs.get("projects/s1").items.SKU1.out = 5; });
  await addToProject(page);
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("6");
});

test("a return saved after someone else removed the line says so, and doesn't make a partial line", { tag: ["@J4.3"] }, async ({ page }) => {
  await openEcho(page);
  await startReturn(page);
  await enterBarcode(page, "SKU1");
  await elsewhere(page, (docs) => { delete docs.get("projects/s1").items.SKU1; });
  await expect(lineRow(page, "Paper towels")).toHaveCount(0);
  await saveReturn(page);
  await expect(page.locator("#toast")).toHaveText("This item isn't on this project. The latest is showing.");
  await expect(page.locator("#overlay")).toBeHidden();
  const [line, stock] = await page.evaluate(() => [window.__mock.docs.get("projects/s1").items.SKU1, window.__mock.docs.get("products/SKU1").stock]);
  expect(line).toBeUndefined();
  expect(stock).toBe(10);
  await expect(lineRow(page, "Paper towels")).toHaveCount(0);
});

const DELETED = "Someone else deleted this project, so your change wasn't saved.";
// The project stays deleted, and the page can still make changes. A checkout or return is
// refused with the command's own message.
const stillDeleted = async (page, message = DELETED) => {
  await expect(page.locator("#toast")).toHaveText(message);
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.locator("#notice")).toBeHidden();
  await expect(page.getByRole("button", { name: "+ New project" })).toBeVisible();
  expect(await page.evaluate(() => window.__mock.docs.has("projects/s1"))).toBe(false);
};

test("removing a line from a project someone else deleted says so, and doesn't make the project again", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  await elsewhere(page, (docs) => docs.delete("projects/s1"));
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await stillDeleted(page);
});

test("saving a line on a project someone else deleted says so", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  await elsewhere(page, (docs) => docs.delete("projects/s1"));
  await modal(page).getByRole("button", { name: "Save" }).click();
  await stillDeleted(page);
});

test("removing a line keeps what someone else changed on the project meanwhile", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  // Changed before this page hears of it
  await page.evaluate(() => { window.__mock.docs.get("projects/s1").client = "Echo Studio West"; });
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("Removed");
  const doc = await page.evaluate(() => window.__mock.docs.get("projects/s1"));
  expect(doc.client).toBe("Echo Studio West");
  expect(Object.keys(doc.items)).toEqual(["SKU1"]);
  await expect(lineRow(page, "Storage bins")).toHaveCount(0);
  await expect(lineRow(page, "Paper towels")).toHaveCount(1);
});

// Data saved by the retired claude.ai artifact (imported) can hold a removed line as null, and
// the marker of a line moved off the General Use project
test("a line removed as a null line, or a moved line's marker, doesn't show or count", { tag: ["@J4"] }, async ({ page }) => {
  const seed = structuredClone(usedState.seed);
  seed["projects/s1"].items["nb-bins"] = null;
  // ...and the marker of a line it moved to another project
  seed["projects/s1"].items.gone = { moved: "s2", out: 0, returned: 0, lost: 0 };
  await openApp(page, { ...usedState, seed });
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toContainText("1 item · 3 taken");
  await openProject(page, "Echo Studio");
  await expect(lineRow(page, "Paper towels")).toHaveCount(1);
  await expect(page.locator("#projectBody tbody tr")).toHaveCount(1);
  // Checking the item out again makes a new line
  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  await modal(page).getByRole("button", { name: /Storage bins/ }).click();
  await addToProject(page);
  await expect(lineRow(page, "Storage bins").locator("td").nth(2)).toHaveText("1");
  expect(await page.evaluate(() => window.__mock.docs.get("projects/s1").items["nb-bins"])).toMatchObject({ out: 1, returned: 0 });
});

test("removing a line that fails for the connection keeps it", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  await page.evaluate(() => { window.__mock.failWrites = "unavailable"; });
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("That didn't save. Check your connection and try again.");
  expect(await page.evaluate(() => window.__mock.docs.get("projects/s1").items["nb-bins"])).toMatchObject({ out: 2 });
});

// A checkout or return adds to the line as it's saved now, even before this page hears of
// someone else's change: the commands add on the server.
test("a checkout adds to the saved line when this page hasn't heard of a change yet", { tag: ["@J4.2"] }, async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await page.evaluate(() => { window.__mock.docs.get("projects/s1").items.SKU1.out = 5; });
  await addToProject(page);
  await expect(page.locator("#toast")).toHaveText("Checked out 1 × Paper towels, 6 roll");
  expect(await page.evaluate(() => window.__mock.docs.get("projects/s1").items.SKU1)).toMatchObject({ out: 6, returned: 1 });
  await expect(lineRow(page, "Paper towels").locator("td").nth(2)).toHaveText("6");
});

test("a return adds to the saved line when this page hasn't heard of a change yet", { tag: ["@J4.3"] }, async ({ page }) => {
  await openEcho(page);
  await startReturn(page);
  await enterBarcode(page, "SKU1");
  await page.evaluate(() => { window.__mock.docs.get("projects/s1").items.SKU1.returned = 2; });
  await saveReturn(page);
  await expect(page.locator("#toast")).toHaveText("1 returned · 3 of 3 back");
  expect(await page.evaluate(() => [window.__mock.docs.get("projects/s1").items.SKU1.returned, window.__mock.docs.get("products/SKU1").stock])).toEqual([3, 11]);
});

test("picking an item someone else just deleted still opens checkout", { tag: ["@J4.2"] }, async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  await elsewhere(page, (docs) => docs.delete("products/nb-bins"));
  await modal(page).getByRole("button", { name: /Storage bins/ }).click();
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(modal(page)).toContainText("No barcode");
});

// The checkout and return forms save against the latest copy of the project, or the one they
// opened on if it's gone. Neither brings back a project someone else deleted, or moves stock.
test("a checkout on a project someone else deleted doesn't bring it back or move stock", { tag: ["@J4.2"] }, async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  const stock = await page.evaluate(() => window.__mock.docs.get("products/SKU1").stock);
  await elsewhere(page, (docs) => docs.delete("projects/s1"));
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await addToProject(page);
  // It says the project is gone, and the page stays writable
  await stillDeleted(page, "No such project. The latest is showing.");
  expect(await page.evaluate(() => [window.__mock.docs.has("projects/s1"), window.__mock.docs.get("products/SKU1").stock])).toEqual([false, stock]);
});

test("a return on a project someone else deleted doesn't bring it back or move stock", { tag: ["@J4.3"] }, async ({ page }) => {
  await openEcho(page);
  await startReturn(page);
  await enterBarcode(page, "SKU1");
  const stock = await page.evaluate(() => window.__mock.docs.get("products/SKU1").stock);
  await elsewhere(page, (docs) => docs.delete("projects/s1"));
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await saveReturn(page);
  // It says the project is gone, and the page stays writable
  await stillDeleted(page, "No such project. The latest is showing.");
  expect(await page.evaluate(() => [window.__mock.docs.has("projects/s1"), window.__mock.docs.get("products/SKU1").stock])).toEqual([false, stock]);
});

// The inventory form while someone else changes the item's stock: the form keeps the count it
// opened with, and only a count the person changed is saved (saveItem in src/aws/db.js)
test.describe("an item's count changed while its form is open", { tag: ["@J4"] }, () => {
  const STOCK = "Single items in storage now";
  const openItem = async (page) => {
    await openEcho(page);
    await goToInventory(page);
    await inventoryRow(page, "Paper towels").click();
    await expect(modal(page).getByLabel(STOCK)).toHaveValue("10");
  };
  const save = (page) => modal(page).getByRole("button", { name: "Save" }).click();
  const saved = (page) => page.evaluate(() => window.__mock.docs.get("products/SKU1"));

  test("an edit that doesn't touch the count keeps someone else's checkout", async ({ page }) => {
    await openItem(page);
    await elsewhere(page, (docs) => { docs.get("products/SKU1").stock = 8; });
    await expect(inventoryRow(page, "Paper towels").locator("td").nth(1)).toHaveText("8");
    await modal(page).getByLabel("Price each ($)").fill("9");
    await save(page);
    await expect(page.locator("#toast")).toHaveText("Saved");
    expect(await saved(page)).toMatchObject({ price: 9, stock: 8 });
  });

  test("an edit that doesn't touch the count keeps a change this page hasn't heard of yet", async ({ page }) => {
    await openItem(page);
    // Saved, but the live update hasn't arrived
    await page.evaluate(() => { delete window.__mock.docs.get("products/SKU1").stock; });
    await modal(page).getByLabel("Price each ($)").fill("9");
    await save(page);
    await expect(page.locator("#toast")).toHaveText("Saved");
    const item = await saved(page);
    expect(item.price).toBe(9);
    expect(item).not.toHaveProperty("stock");
  });

  test("a new count over stock that moved is refused, and the rest of the edit saves", async ({ page }) => {
    await openItem(page);
    await elsewhere(page, (docs) => { docs.get("products/SKU1").stock = 8; });
    await modal(page).getByLabel("Price each ($)").fill("9");
    await modal(page).getByLabel(STOCK).fill("12");
    await save(page);
    await expect(page.locator("#toast")).toHaveText("The count changed while you were editing: it's now 8, so your count wasn't saved. The latest is showing.");
    await expect(page.locator("#overlay")).toBeHidden();
    expect(await saved(page)).toMatchObject({ price: 9, stock: 8 });
  });

  test("a new count on an item someone stopped counting meanwhile is refused", async ({ page }) => {
    await openItem(page);
    await elsewhere(page, (docs) => { delete docs.get("products/SKU1").stock; });
    await modal(page).getByLabel(STOCK).fill("12");
    await save(page);
    await expect(page.locator("#toast")).toHaveText("The count changed while you were editing: it's no longer counted, so your count wasn't saved. The latest is showing.");
    expect(await saved(page)).not.toHaveProperty("stock");
  });

  test("a new count that's what the stock moved to saves, as does one over stock that didn't move", async ({ page }) => {
    await openItem(page);
    await elsewhere(page, (docs) => { docs.get("products/SKU1").stock = 8; });
    await modal(page).getByLabel(STOCK).fill("8");
    await save(page);
    await expect(page.locator("#toast")).toHaveText("Saved");
    expect((await saved(page)).stock).toBe(8);
    await inventoryRow(page, "Paper towels").click();
    await modal(page).getByLabel(STOCK).fill("6");
    await save(page);
    await expect(page.locator("#toast")).toHaveText("Saved");
    expect((await saved(page)).stock).toBe(6);
  });
});
