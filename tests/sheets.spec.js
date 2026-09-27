import { test, expect, openApp, createSheet, enterBarcode, modal, lineRow } from "./helpers.js";
import { usedState } from "./fixtures.js";

const openEcho = async (page, opts = {}) => {
  await openApp(page, { ...usedState, ...opts });
  // The page draws again once both collections have loaded; wait for that
  await page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
};

test("edits a sheet's client and date", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Edit details" }).click();
  await expect(modal(page).getByRole("heading", { name: "Edit sheet" })).toBeVisible();
  await expect(modal(page).getByLabel("Client", { exact: true })).toHaveValue("Echo Studio");
  await modal(page).getByLabel("Client", { exact: true }).fill("Echo Studios LLC");
  await modal(page).getByLabel("Date").fill("2026-09-26");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "Echo Studios LLC" })).toBeVisible();
  await expect(page.locator(".sheet-head .meta")).toContainText("Sep 26, 2026");
});

test("a new sheet needs a client name, and can be cancelled", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "+ New sheet" }).click();
  await modal(page).getByLabel("Client", { exact: true }).fill("   ");
  await modal(page).getByRole("button", { name: "Create sheet" }).click();
  await expect(page.locator("#overlay")).toBeVisible();
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("modals close with Escape or a tap outside", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "+ New sheet" }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("#overlay")).toBeHidden();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "+ New sheet" }).click();
  await modal(page).click();
  await expect(page.locator("#overlay")).toBeVisible();
  await page.locator("#overlay").click({ position: { x: 5, y: 5 } });
  await expect(page.locator("#overlay")).toBeHidden();
});

test("filters sheets by open and returned, and shows what each is worth", async ({ page }) => {
  await openApp(page, {
    seed: {
      ...usedState.seed,
      "sheets/s2": {
        client: "", date: "2026-09-20", createdBy: "u_other", status: "closed",
        items: { A: { code: "A", name: "Mop heads", price: 3, out: 1, returned: 0 } },
      },
    },
  });
  const list = page.locator(".list");
  await expect(list.locator(".sheet-card")).toHaveCount(1);
  await expect(list).toContainText("2 items · 5 taken · 1 back");
  await expect(list).toContainText("$35.50");

  await page.getByRole("button", { name: "Returned" }).click();
  await expect(list.locator(".sheet-card")).toHaveCount(1);
  await expect(list).toContainText("Untitled");
  await expect(list).toContainText("1 item · 1 taken");
  await expect(list).toContainText("Someone");
  await expect(list.locator(".pill")).toHaveText("Returned");
  await expect(list).toContainText("$3.00");

  await page.getByRole("button", { name: "All" }).click();
  await expect(list.locator(".sheet-card")).toHaveCount(2);
});

test("shows an empty state for filters with no sheets", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Returned" }).click();
  await expect(page.getByText("No sheets here yet.")).toBeVisible();
});

test("reopens a finished sheet", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Finished Return" }).click();
  await expect(page.locator(".sheet-head .pill")).toHaveText("Returned");
  await page.getByRole("button", { name: "Reopen" }).click();
  await expect(page.locator(".sheet-head .pill")).toHaveText("Checked out");
  await expect(page.locator("#toast")).toHaveText("Sheet reopened");
});

test("deleting a sheet takes two taps, and the first tap wears off", async ({ page }) => {
  await page.clock.install();
  await openEcho(page);
  const del = page.getByRole("button", { name: "Delete sheet" });
  await del.click();
  await expect(page.getByRole("button", { name: "Tap again to delete" })).toBeVisible();
  await page.clock.runFor(4000);
  await expect(del).toBeVisible();

  await del.click();
  await page.getByRole("button", { name: "Tap again to delete" }).click();
  await expect(page.locator("#toast")).toHaveText("Sheet deleted");
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await page.clock.runFor(4000);
  await expect(page.locator("#toast")).toBeHidden();
});

test("the back button returns to the list", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "← All sheets" }).first().click();
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
});

test("an empty sheet explains how to start", async ({ page }) => {
  await openApp(page);
  await createSheet(page, "India Inc");
  await expect(page.getByText("No supplies on this sheet yet.")).toBeVisible();
});

test("edits the price and counts on a sheet line", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Paper towels").click();
  await expect(modal(page).getByRole("heading", { name: "Paper towels, 6 roll" })).toBeVisible();
  await modal(page).getByLabel("Price each on this sheet ($)").fill("9");
  await modal(page).getByLabel("Taken").fill("4");
  await modal(page).getByLabel("Returned").fill("9");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(lineRow(page, "Paper towels")).toContainText("$9.00");
  await expect(lineRow(page, "Paper towels").locator("td").nth(3)).toHaveText("4");
});

// WebKit focuses an inserted autofocus field again a frame later, even once focus has moved
// on, so a quick tap into the price typed into the name. The modal focuses its first field
// itself and leaves the browser nothing to refocus.
test("a new item's modal focuses the name without an autofocus attribute", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "NEW3");
  await expect(modal(page).getByLabel("Item name")).toBeFocused();
  await expect(page.locator("[autofocus]")).toHaveCount(0);
});

// ADR 0014: a typed price is saved in whole cents, halves up. The fields' step="0.01" makes a
// browser that validates forms refuse 1.005, so the test lifts it to check the save itself.
const anyStep = (field) => field.evaluate((el) => { el.step = "any"; });

test("a typed price on a sheet line or a new item is saved rounded to cents", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Paper towels").click();
  await anyStep(modal(page).getByLabel("Price each on this sheet ($)"));
  await modal(page).getByLabel("Price each on this sheet ($)").fill("1.005");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(lineRow(page, "Paper towels")).toContainText("$1.01");
  expect(await page.evaluate(() => window.__mock.docs.get("sheets/s1").items.SKU1.price)).toBe(1.01);

  await enterBarcode(page, "NEW3");
  await modal(page).getByLabel("Item name").fill("Sponges");
  await anyStep(modal(page).getByLabel("Price each ($)"));
  await modal(page).getByLabel("Price each ($)").fill("1.005");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Sponges")).toContainText("$1.01");
  const saved = await page.evaluate(() => [window.__mock.docs.get("products/NEW3").price, window.__mock.docs.get("sheets/s1").items.NEW3.price]);
  expect(saved).toEqual([1.01, 1.01]);
});

test("removes a line from a sheet with two taps", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Storage bins").click();
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await expect(page.locator("#toast")).toHaveText("Removed");
  await expect(lineRow(page, "Storage bins")).toHaveCount(0);
  await expect(lineRow(page, "Paper towels")).toBeVisible();
});

test("picks an inventory item without a barcode, with search", async ({ page }) => {
  await openApp(page, {
    seed: {
      ...usedState.seed,
      "products/nb-mop": { code: "", name: "Mop heads", price: 3, cost: 2 },
      "products/7001": { code: "7001", name: "Squeegee", price: 6 },
    },
  });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  const pick = modal(page).locator("#pick");
  await expect(pick.locator("button")).toHaveCount(4);
  await expect(pick).toContainText("10 in storage");
  await expect(pick).toContainText("$3.00");

  await modal(page).getByLabel("Or pick from inventory").fill("zzz");
  await expect(pick).toContainText("No matches");
  await modal(page).getByLabel("Or pick from inventory").fill("700");
  await expect(pick.locator("button")).toHaveCount(1);
  await modal(page).getByLabel("Or pick from inventory").fill("mop");
  await pick.getByRole("button", { name: /Mop heads/ }).click();
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(modal(page)).toContainText("No barcode");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Mop heads")).toBeVisible();
  // A new line copies the item's cost as well as its price (ADR 0014)
  const line = await page.evaluate(() => window.__mock.docs.get("sheets/s1").items["nb-mop"]);
  expect(line).toMatchObject({ name: "Mop heads", price: 3, cost: 2, out: 1 });
});

test("a sheet's total is the sum of its rows rounded to cents", async ({ page }) => {
  // Prices with more than two decimals (typed before rounding existed) round when shown
  await openApp(page, { seed: { "sheets/r": { client: "Round Co", date: "2026-09-01", status: "open", items: {
    a: { code: "", name: "Wipes", price: 0.335, out: 3, returned: 0 },
    b: { code: "", name: "Xylene", price: 1.005, out: 1, returned: 0 },
    c: { code: "", name: "Zip ties", price: 0.1, out: 3, returned: 0 },
  } } } });
  await expect(page.getByRole("button", { name: /Round Co/ })).toContainText("$2.33");
  await page.getByRole("button", { name: /Round Co/ }).click();
  await expect(lineRow(page, "Wipes").locator(".charge")).toHaveText("$1.02");
  await expect(lineRow(page, "Xylene").locator(".charge")).toHaveText("$1.01");
  await expect(lineRow(page, "Zip ties").locator(".charge")).toHaveText("$0.30");
  await expect(page.locator("#sheetBody tfoot")).toContainText("$2.33");
  await page.getByRole("button", { name: "Download CSV" }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
  const { data } = await page.evaluate(() => window.__mock.saves[0]);
  expect(data).toContain("Wipes,,0.34,3,0,3,1.02\nXylene,,1.01,1,0,1,1.01\nZip ties,,0.10,3,0,3,0.30\nTotal,,,7,0,7,2.33");
});

test("picking with an empty inventory goes straight to a new item", async ({ page }) => {
  await openApp(page);
  await createSheet(page, "Juliet Co");
  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  await expect(modal(page).locator("#pick")).toHaveCount(0);
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("a new item without a barcode can skip saving to inventory", async ({ page }) => {
  await openApp(page);
  await createSheet(page, "Kilo Co");
  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  await modal(page).getByRole("button", { name: "+ New item" }).click();
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(page.locator("#overlay")).toBeVisible();
  await modal(page).getByLabel("Item name").fill("One-off ladder rental");
  await modal(page).getByLabel("Save to inventory for next time").uncheck();
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "One-off ladder rental")).toContainText("$0.00");
  const saved = await page.evaluate(() => [...window.__mock.docs.keys()].filter((k) => k.startsWith("products/")));
  expect(saved).toEqual([]);
});

test("a new item's name can't be only spaces", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "NEW2");
  await modal(page).getByLabel("Item name").fill("   ");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  expect(await page.evaluate(() => window.__mock.docs.has("products/NEW2"))).toBe(false);
});

test("a sheet created while updates arrive instantly appears once", async ({ page }) => {
  await openApp(page, { instantUpdates: true });
  await createSheet(page, "Oscar Two");
  await page.getByRole("button", { name: "← All sheets" }).first().click();
  await expect(page.getByRole("button", { name: /Oscar Two/ })).toHaveCount(1);
});

test("the quantity stepper counts up and down and won't check out zero", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await expect(modal(page)).toContainText("Already on this sheet");
  await expect(modal(page)).toContainText("3 taken");
  await modal(page).getByRole("button", { name: "More" }).click();
  await expect(modal(page).getByRole("button", { name: "Add 2 to sheet" })).toBeVisible();
  await modal(page).getByRole("button", { name: "Fewer" }).click();
  await modal(page).getByRole("button", { name: "Fewer" }).click();
  await modal(page).getByRole("button", { name: "Add 0 to sheet" }).click();
  await expect(page.locator("#toast")).toHaveText("Choose at least 1.");
  await modal(page).getByRole("button", { name: "Cancel" }).click();
});

test("scanning a barcode stored under a different key finds the item", async ({ page }) => {
  await openApp(page, {
    seed: { "products/legacy-1": { code: "0042", name: "Sponges", price: 1 }, ...usedState.seed },
  });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await enterBarcode(page, "0042");
  await expect(modal(page)).toContainText("Sponges");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Sponges")).toBeVisible();
  // Items without a storage count stay uncounted
  expect(await page.evaluate(() => window.__mock.docs.get("products/legacy-1").stock)).toBeUndefined();
});

test("typing nothing in the barcode box does nothing", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "  ");
  await expect(page.locator("#overlay")).toBeHidden();
});

test("returns an item without a barcode by picking it", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await expect(page.locator("#scanLabel")).toHaveText("Scan to return");
  await page.getByRole("button", { name: "Return item without a barcode" }).click();
  await modal(page).getByRole("button", { name: /Storage bins/ }).click();
  await expect(modal(page).getByRole("heading", { name: "Return" })).toBeVisible();
  await expect(modal(page)).toContainText("2 taken");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(lineRow(page, "Storage bins").locator("td").nth(3)).toHaveText("1");
});

test("returning from an empty sheet says nothing was taken", async ({ page }) => {
  await openApp(page);
  await createSheet(page, "Lima Ltd");
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await page.getByRole("button", { name: "Return item without a barcode" }).click();
  await expect(modal(page)).toContainText("Nothing has been checked out on this sheet yet.");
  await modal(page).getByRole("button", { name: "Cancel" }).click();
});

test("a return needs at least one, and can be cancelled", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await expect(modal(page)).toContainText("3 taken · 1 back");
  await modal(page).locator("#fRet").fill("0");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(page.locator("#toast")).toHaveText("Choose at least 1.");
  await modal(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("returning an item that isn't on the sheet offers to check it out", async ({ page }) => {
  await openApp(page, { seed: { ...usedState.seed, "products/SKU9": { code: "SKU9", name: "Bleach", price: 4, stock: 3 } } });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await page.getByRole("button", { name: "Return", exact: true }).click();

  await enterBarcode(page, "UNKNOWN");
  await expect(modal(page).getByRole("heading", { name: "Not on this sheet" })).toBeVisible();
  await expect(modal(page)).toContainText("This item wasn't checked out");
  await modal(page).getByRole("button", { name: "Close" }).click();

  await enterBarcode(page, "SKU9");
  await expect(modal(page)).toContainText("Bleach wasn't checked out");
  await modal(page).getByRole("button", { name: "Check it out instead" }).click();
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(page.locator("#scanLabel")).toHaveText("Scan to check out");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Bleach")).toBeVisible();
});

test("a sheet made without a signed-in user records who prepared it", async ({ page }) => {
  await openApp(page, { unavailable: ["user"] });
  await page.getByRole("button", { name: "+ New sheet" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Mike's Diner");
  await page.getByLabel("Prepared by").fill("Sam");
  await page.getByRole("button", { name: "Create sheet" }).click();
  await expect(page.locator(".sheet-head")).toContainText("Prepared by Sam");
  await page.getByRole("button", { name: "Download CSV" }).click();
  expect(await page.evaluate(() => window.__mock.saves[0].data)).toContain("Prepared by,Sam");
});

test("sheets from before sign-in show who prepared them, or Unknown", async ({ page }) => {
  await openApp(page, {
    unavailable: ["user"],
    seed: {
      "sheets/a": { client: "Named", date: "2026-09-01", createdByName: "Pat", status: "open", items: {} },
      "sheets/b": { client: "Anon", date: "2026-09-02", status: "open", items: {} },
    },
  });
  await expect(page.getByRole("button", { name: /Named/ })).toContainText("Pat");
  await expect(page.getByRole("button", { name: /Anon/ })).toContainText("Unknown");
  await page.getByRole("button", { name: /Anon/ }).click();
  await page.getByRole("button", { name: "Download CSV" }).click();
  expect(await page.evaluate(() => window.__mock.saves[0].data)).toContain("Prepared by,Unknown");
});

test("any other failed save asks the user to check their connection", async ({ page }) => {
  await openEcho(page, { writeError: "unavailable" });
  await page.getByRole("button", { name: "Finished Return" }).click();
  await expect(page.locator("#toast")).toHaveText("That didn't save. Check your connection and try again.");
});

test("view-only users can open a sheet but not change it", async ({ page }) => {
  await openEcho(page, { canWrite: false });
  await expect(page.locator("#scanbar")).toBeHidden();
  await expect(page.getByRole("button", { name: "Edit details" })).toHaveCount(0);
  await lineRow(page, "Paper towels").click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("keys other than Enter don't open a line; the return count can't exceed what's left", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Paper towels").press("a");
  await expect(page.locator("#overlay")).toBeHidden();

  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  const count = modal(page).locator("#fRet");
  await count.fill("99");
  await count.dispatchEvent("change");
  await expect(count).toHaveValue("2");
  await expect(modal(page).locator("#sum")).toContainText("Returned 3 of 3");
});

test("barcodes that are built-in object keys check out and return like any other", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "constructor");
  await expect(modal(page).getByRole("heading", { name: "Not on this sheet" })).toBeVisible();
  await expect(modal(page)).toContainText("This item wasn't checked out");
  await modal(page).getByRole("button", { name: "Check it out instead" }).click();

  await expect(modal(page)).toContainText("New barcode.");
  await expect(modal(page)).not.toContainText("Already on this sheet");
  await modal(page).getByLabel("Item name").fill("Widget A");
  await modal(page).getByLabel("Price each ($)").fill("2");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Widget A")).toBeVisible();

  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "constructor");
  await expect(modal(page).getByRole("heading", { name: "Return" })).toBeVisible();
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(lineRow(page, "Widget A").locator("td").nth(3)).toHaveText("1");
  const doc = await page.evaluate(() => window.__mock.docs.get("sheets/s1").items.constructor);
  expect(doc).toMatchObject({ code: "constructor", name: "Widget A", price: 2, out: 1, returned: 1 });
  expect(await page.evaluate(() => [Object.prototype.out, Object.out])).toEqual([undefined, undefined]);
});

test("a tap on the list survives a redraw, and a snapshot with no changes leaves the list alone", async ({ page }) => {
  await openApp(page, usedState);
  await page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });
  const echo = page.getByRole("button", { name: /Echo Studio/ });
  await expect(echo).toBeVisible();
  const card = await echo.elementHandle();

  // Press + New sheet; another user adds a sheet, which redraws the list mid-tap
  const box = await page.getByRole("button", { name: "+ New sheet" }).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => {
    window.__mock.docs.set("sheets/late", { client: "Late job", date: "2026-08-01", status: "open", items: {} });
    window.__mock.notify();
  });
  await expect(page.getByRole("button", { name: /Late job/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Out now (2)" })).toBeVisible();
  // The cards that didn't change are the same elements
  expect(await card.evaluate((el) => el.isConnected)).toBe(true);
  await page.mouse.up();
  await expect(modal(page).getByRole("heading", { name: "New sheet" })).toBeVisible();
  await modal(page).getByRole("button", { name: "Cancel" }).click();

  // A snapshot with nothing new doesn't touch the list
  await page.evaluate(() => {
    window.__mutations = 0;
    new MutationObserver((m) => { window.__mutations += m.length; }).observe(document.getElementById("main"), { subtree: true, childList: true, attributes: true, characterData: true });
    window.__mock.notify();
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  expect(await page.evaluate(() => window.__mutations)).toBe(0);

  // Clicks on the list outside its buttons do nothing
  await page.locator("#main .bar").click({ position: { x: 1, y: 1 } });
  await expect(page.locator("#overlay")).toBeHidden();
});

test("a tap on a line survives a redraw, and a snapshot with no changes leaves the sheet alone", async ({ page }) => {
  await openEcho(page);
  const row = lineRow(page, "Paper towels");
  await expect(row).toBeVisible();
  const tapped = await row.elementHandle();
  const head = await page.getByRole("button", { name: "Finished Return" }).elementHandle();

  // Press a line; another user checks out more of the other line, which redraws the sheet mid-tap
  await row.scrollIntoViewIfNeeded();
  const box = await row.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => {
    window.__mock.docs.get("sheets/s1").items["nb-bins"].out = 5;
    window.__mock.notify();
  });
  await expect(page.locator(".totals")).toContainText("Taken8");
  // What didn't change is the same elements
  expect(await tapped.evaluate((el) => el.isConnected)).toBe(true);
  expect(await head.evaluate((el) => el.isConnected)).toBe(true);
  await page.mouse.up();
  await expect(modal(page).getByRole("heading", { name: "Paper towels, 6 roll" })).toBeVisible();
  await modal(page).getByRole("button", { name: "Cancel" }).click();

  // A snapshot with nothing new doesn't touch the sheet view
  await page.evaluate(() => {
    window.__mutations = 0;
    new MutationObserver((m) => { window.__mutations += m.length; }).observe(document.getElementById("sheetView"), { subtree: true, childList: true, attributes: true, characterData: true });
    window.__mock.notify();
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  expect(await page.evaluate(() => window.__mutations)).toBe(0);

  // Clicks on the sheet outside its buttons and lines do nothing
  await page.locator("#sheetHead h2").click();
  await page.locator("#sheetBody .totals").click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("the sheet's buttons act on the latest copy of the sheet", async ({ page }) => {
  await openEcho(page);
  await page.evaluate(() => {
    window.__mock.docs.get("sheets/s1").client = "Echo Studio West";
    window.__mock.notify();
  });
  await expect(page.getByRole("heading", { name: "Echo Studio West" })).toBeVisible();
  await page.getByRole("button", { name: "Edit details" }).click();
  await expect(modal(page).getByLabel("Client", { exact: true })).toHaveValue("Echo Studio West");
});

test("a refused write to a sheet that's still there switches the page to view-only", async ({ page }) => {
  await openEcho(page, { writeError: "invalid_argument" });
  await page.getByRole("button", { name: "Finished Return" }).click();
  await expect(page.locator("#notice")).toContainText("view-only access");
  await expect(page.locator("#scanbar")).toBeHidden();
});
