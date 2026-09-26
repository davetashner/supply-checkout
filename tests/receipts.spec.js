import { test, expect, openApp, lineRow, inventoryRow } from "./helpers.js";
import { usedState, fakeImage } from "./fixtures.js";

// usedState.receipt: line 0 is 4 × storage bins (suggested match for the
// "Storage bins, 12 qt" inventory item, receipt price $5.50 vs $5.00),
// line 1 is 2 × painter's tape at $6.25 (not in inventory).
// Inventory ids in the prompt follow key order, so i2 is "products/nb-bins"
const receipt = { ...usedState.receipt, items: usedState.receipt.items.map((it, i) => (i === 0 ? { ...it, match: "i2" } : it)) };
const scanReceipt = async (page, opts = {}) => {
  await openApp(page, { ...usedState, receipt, ...opts });
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
};
const line = (page, i) => page.locator(".rline").nth(i);
const saveBtn = (page) => page.getByRole("button", { name: "Save", exact: true });
const toast = (page) => page.locator("#toast");
const docs = (page, prefix) => page.evaluate((p) => Object.fromEntries([...window.__mock.docs].filter(([k]) => k.startsWith(p))), prefix);

// Starts the app with a saved, unfinished receipt review
const seedDraft = async (page, draft, opts = {}) => {
  await page.addInitScript((d) => localStorage.setItem("supplyCheckout.receiptDraft", JSON.stringify(d)), {
    store: "", receiptDate: "2026-09-20", date: "2026-09-25", subtotal: null, tax: null, total: null,
    savePrices: true, by: "", dests: [{ id: "d1", sheetId: "", client: "" }], lines: [], ...draft,
  });
  await openApp(page, { ...usedState, ...opts });
  await page.getByRole("button", { name: "Continue review" }).click();
};
const draftLine = (o) => ({ id: "l" + Math.random().toString(36).slice(2, 7), name: "", raw: "", qty: 1, price: 0, dest: "d1", code: "", match: "", suggested: false, useName: "inv", usePrice: "receipt", ...o });

test("fills in sensible defaults when parts of the receipt can't be read", async ({ page }) => {
  await scanReceipt(page, {
    receipt: { store: null, date: "Sept 20", items: [null, { qty: 1 }, { name: " Tape ", qty: "x", price: "abc", raw: null }], subtotal: "", tax: null, total: "n/a" },
  });
  await expect(page.locator(".rline")).toHaveCount(1);
  await expect(line(page, 0).locator('[data-f="name"]')).toHaveValue("Tape");
  await expect(line(page, 0).locator('[data-f="qty"]')).toHaveValue("1");
  await expect(line(page, 0).locator('[data-f="price"]')).toHaveValue("0");
  await expect(line(page, 0)).not.toContainText("Receipt:");
  await expect(page.locator("#rSum")).not.toContainText("Receipt subtotal");
  await expect(page.locator("#rSum")).not.toContainText("Tax on receipt");
  await expect(page.locator("#rBody .sheet-head .meta span")).toHaveCount(1);
});

test("a reply without a list of items asks for a better photo", async ({ page }) => {
  await openApp(page, { ...usedState, receipt: { items: "none" } });
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.getByText("No line items were found in that photo")).toBeVisible();
});

test("an unexpected reading error gives a general message", async ({ page }) => {
  await openApp(page, { ...usedState, sampleError: "something_new" });
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.getByText("Reading the receipt failed. Check your connection and try again.")).toBeVisible();
});

test("reading can be stopped", async ({ page }) => {
  await openApp(page, { ...usedState, sampleHang: true });
  await page.setInputFiles("#receiptFile", fakeImage);
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue review" })).toHaveCount(0);
});

test("leaving the review keeps it, and discarding takes two taps", async ({ page }) => {
  await scanReceipt(page);
  await page.locator("#rBack").click();
  await page.getByRole("button", { name: "Continue review" }).click();
  await expect(page.locator(".rline")).toHaveCount(2);
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByRole("button", { name: "Tap again to discard" }).click();
  await expect(toast(page)).toHaveText("Receipt discarded");
  await expect(page.getByRole("button", { name: "Continue review" })).toHaveCount(0);
});

test("view-only users don't see the unfinished review", async ({ page }) => {
  await seedDraftOnly(page);
  await openApp(page, { ...usedState, canWrite: false });
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue review" })).toHaveCount(0);
});
async function seedDraftOnly(page) {
  await page.addInitScript(() => localStorage.setItem("supplyCheckout.receiptDraft", JSON.stringify({ dests: [], lines: [] })));
}

test("splits a trip between two new clients and saves both sheets", async ({ page }) => {
  await scanReceipt(page);
  await expect(line(page, 1).locator('[data-f="dest"] option').first()).toHaveText("Client 1");
  await page.getByRole("button", { name: "+ Add another client" }).click();
  await expect(page.locator("[data-dname]").nth(1)).toBeFocused();
  await page.locator("[data-dname]").nth(0).fill("Oscar Co");
  await page.locator("[data-dname]").nth(1).fill("Papa Inc");
  await expect(line(page, 1).locator('[data-f="dest"] option').nth(1)).toHaveText("Papa Inc");
  await line(page, 1).locator('[data-f="dest"]').selectOption({ label: "Papa Inc" });
  await expect(page.locator("#rSum")).toContainText("Papa Inc");

  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Saved to 2 sheets");
  await expect(page.getByRole("button", { name: /Oscar Co/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Papa Inc/ })).toBeVisible();
  const saved = Object.values(await docs(page, "sheets/")).filter((s) => s.source);
  expect(saved.map((s) => s.source.store)).toEqual(["Hardware Co", "Hardware Co"]);
});

test("removing a client moves its items to the first client", async ({ page }) => {
  await scanReceipt(page);
  await page.getByRole("button", { name: "+ Add another client" }).click();
  await page.locator("[data-dname]").nth(1).fill("Romeo LLC");
  await line(page, 0).locator('[data-f="dest"]').selectOption({ label: "Romeo LLC" });
  await page.getByRole("button", { name: "Remove this client" }).nth(1).click();
  await expect(page.locator("[data-dname]")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove this client" })).toHaveCount(0);
  await expect(line(page, 0).locator('[data-f="dest"] option:checked')).toHaveText("Client 1");
});

test("adds receipt items to an existing sheet, merging with what's already there", async ({ page }) => {
  await scanReceipt(page);
  await page.locator("[data-dsel]").selectOption({ label: "Add to Echo Studio (Sep 24, 2026)" });
  await expect(page.locator("[data-dname]")).toHaveCount(0);
  await expect(line(page, 0).locator('[data-f="dest"] option').first()).toHaveText("Echo Studio (existing sheet)");
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Saved to 1 sheet");
  await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
  // 2 already taken + 4 from the receipt, keeping the sheet's name and price
  await expect(lineRow(page, "Storage bins, 12 qt").locator("td").nth(2)).toHaveText("6");
  await expect(lineRow(page, "Storage bins, 12 qt").locator("td").nth(1)).toHaveText("$5.00");
  await expect(lineRow(page, "Painter's tape")).toContainText("$6.25");
  // A line from before costs were kept stays without one; a new line gets the receipt's cost
  const items = (await docs(page, "sheets/s1"))["sheets/s1"].items;
  expect(items["nb-bins"]).not.toHaveProperty("cost");
  expect(Object.values(items).find((it) => it.name.startsWith("Painter")).cost).toBe(6.25);
});

test("a sheet deleted during the review is reported on save", async ({ page }) => {
  await seedDraft(page, {
    dests: [{ id: "d1", sheetId: "gone", client: "" }],
    lines: [draftLine({ name: "Mop", qty: 1, price: 2 })],
  });
  await expect(line(page, 0).locator('[data-f="dest"] option').first()).toHaveText("Missing sheet");
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("One of the chosen sheets was deleted. Pick another and save again.");
  await expect(saveBtn(page)).toBeEnabled();
});

test("chooses between the inventory and receipt name and price", async ({ page }) => {
  await scanReceipt(page);
  const bins = line(page, 0);
  await expect(bins).toContainText("2 in storage now");
  // No cost known, so the receipt price is charged by default (ADR 0014)
  await expect(bins.getByRole("button", { name: /Charge the receipt price/ })).toHaveAttribute("aria-pressed", "true");
  await bins.getByRole("button", { name: /From receipt/ }).click();
  await expect(line(page, 0).getByRole("button", { name: /From receipt/ })).toHaveAttribute("aria-pressed", "true");
  await line(page, 0).getByRole("button", { name: /Charge the receipt price/ }).click();
  await expect(line(page, 0).locator("[data-total]")).toHaveText("$22.00");
  await line(page, 0).getByRole("button", { name: /Keep the client price/ }).click();
  await expect(line(page, 0).locator("[data-total]")).toHaveText("$20.00");
  await line(page, 0).getByRole("button", { name: /Inventory name/ }).click();

  await page.getByLabel("Client name").fill("Sierra Co");
  await saveBtn(page).click();
  await expect(lineRow(page, "Storage bins, 12 qt")).toContainText("$5.00");
});

test("the receipt name is saved when chosen", async ({ page }) => {
  await scanReceipt(page);
  await line(page, 0).getByRole("button", { name: /From receipt/ }).click();
  await page.getByLabel("Client name").fill("Tango Co");
  await saveBtn(page).click();
  await expect(lineRow(page, "Sterilite 12 qt storage bin")).toContainText("$5.50");
});

test("changing the inventory match updates the line", async ({ page }) => {
  await scanReceipt(page);
  await line(page, 0).locator('[data-f="match"]').selectOption({ label: "New item (not in inventory yet)" });
  await expect(line(page, 0).locator('[data-f="name"]')).toHaveValue("Sterilite 12 qt storage bin");
  await expect(line(page, 0)).not.toContainText("Suggested match");

  await line(page, 1).locator('[data-f="match"]').selectOption({ label: "Paper towels, 6 roll · SKU1" });
  await expect(line(page, 1).locator('[data-f="code"]')).toHaveValue("SKU1");
  await expect(line(page, 1).locator('[data-f="code"]')).toHaveAttribute("readonly", "");
  await expect(line(page, 1).locator("[data-scan]")).toHaveCount(0);
});

test("typing a known barcode matches the inventory item", async ({ page }) => {
  await scanReceipt(page);
  const code = line(page, 1).locator('[data-f="code"]');
  await code.fill("  ");
  await code.dispatchEvent("change");
  await code.fill("999");
  await code.dispatchEvent("change");
  await expect(line(page, 1).locator('[data-f="name"]')).toBeVisible();
  await line(page, 1).locator('[data-f="code"]').fill("SKU1");
  await line(page, 1).locator('[data-f="code"]').dispatchEvent("change");
  await expect(toast(page)).toHaveText("Barcode found in inventory: Paper towels, 6 roll");
  await expect(line(page, 1)).toContainText("Price changed");
});

test("warns when a line's barcode doesn't match the chosen inventory item", async ({ page }) => {
  await scanReceipt(page);
  await line(page, 1).locator('[data-f="code"]').fill("ABC123");
  await line(page, 1).locator('[data-f="code"]').dispatchEvent("change");
  await line(page, 1).locator('[data-f="match"]').selectOption({ label: "Paper towels, 6 roll · SKU1" });
  await expect(line(page, 1)).toContainText("already has barcode SKU1");
});

test("scans a barcode for a receipt line", async ({ page }) => {
  await page.addInitScript(() => { window.BarcodeDetector = class { async detect() { return [{ rawValue: "SKU1" }]; } }; });
  await scanReceipt(page);
  const chooser = page.waitForEvent("filechooser");
  await line(page, 1).getByRole("button", { name: "Scan" }).click();
  await (await chooser).setFiles({
    name: "b.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
  });
  await expect(toast(page)).toHaveText("Barcode found in inventory: Paper towels, 6 roll");
  await expect(line(page, 1).locator('[data-f="code"]')).toHaveValue("SKU1");
});

test("cancelling the receipt photo picker changes nothing", async ({ page }) => {
  await openApp(page, usedState);
  await page.setInputFiles("#receiptFile", []);
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeHidden();
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
});

test("a line barcode photo with no barcode leaves the line alone", async ({ page }) => {
  await page.addInitScript(() => { window.BarcodeDetector = class { async detect() { return []; } }; });
  await scanReceipt(page);
  const chooser = page.waitForEvent("filechooser");
  await line(page, 1).getByRole("button", { name: "Scan" }).click();
  await (await chooser).setFiles({ name: "b.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") });
  await expect(toast(page)).toContainText("No barcode found");
  await expect(line(page, 1).locator('[data-f="code"]')).toHaveValue("");
});

test("splits, removes and adds lines", async ({ page }) => {
  await scanReceipt(page);
  await line(page, 0).getByRole("button", { name: "Split" }).click();
  await expect(page.locator(".rline")).toHaveCount(3);
  await expect(line(page, 0).locator('[data-f="qty"]')).toHaveValue("2");
  await expect(line(page, 1).locator('[data-f="qty"]')).toHaveValue("2");
  await expect(line(page, 1).locator('[data-f="qty"]')).toBeFocused();

  // With two clients, the split-off half goes to the other one
  await page.getByRole("button", { name: "+ Add another client" }).click();
  await page.locator("[data-dname]").nth(1).fill("Uniform Co");
  await line(page, 2).getByRole("button", { name: "Split" }).click();
  await expect(line(page, 3).locator('[data-f="dest"] option:checked')).toHaveText("Uniform Co");

  await line(page, 3).getByRole("button", { name: "Remove" }).click();
  await expect(page.locator(".rline")).toHaveCount(3);
  await page.getByRole("button", { name: "+ Add item" }).click();
  await expect(page.locator(".rline")).toHaveCount(4);
  await expect(line(page, 3).locator('[data-f="name"]')).toBeFocused();
  await expect(page.locator(".rhead")).toHaveText("Items (4)");
});

test("editing quantity and price updates the line and the summary", async ({ page }) => {
  await scanReceipt(page);
  await line(page, 1).locator('[data-f="qty"]').fill("3");
  await line(page, 1).locator('[data-f="price"]').fill("2");
  await expect(line(page, 1).locator("[data-total]")).toHaveText("$6.00");
  await line(page, 1).locator('[data-f="name"]').fill("Blue tape");
  await expect(page.locator("#rSum")).toContainText("Items total doesn't match the receipt subtotal");
  await line(page, 1).locator('[data-f="price"]').fill("");
  await expect(line(page, 1).locator("[data-total]")).toHaveText("$0.00");
});

// Coverage stops at a reload, so what's edited before it is tested above
test("review choices survive a reload", async ({ page }) => {
  await scanReceipt(page);
  await line(page, 1).locator('[data-f="name"]').fill("Blue tape");
  await page.locator("#rDate").fill("2026-09-21");
  await page.locator("#rSavePrices").uncheck();
  await page.reload();
  await page.getByRole("button", { name: "Continue review" }).click();
  await expect(page.locator("#rDate")).toHaveValue("2026-09-21");
  await expect(page.locator("#rSavePrices")).not.toBeChecked();
  await expect(line(page, 1).locator('[data-f="name"]')).toHaveValue("Blue tape");
});

test("save checks for items, client names, a date and who prepared it", async ({ page }) => {
  await scanReceipt(page, { unavailable: ["user"] });
  await line(page, 0).locator('[data-f="qty"]').fill("0");
  await line(page, 1).locator('[data-f="qty"]').fill("0");
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Add at least one item with a name and a quantity.");

  await line(page, 1).locator('[data-f="qty"]').fill("2");
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Enter a client name for each new sheet.");
  await expect(page.getByLabel("Client name")).toBeFocused();

  await page.getByLabel("Client name").fill("Victor Co");
  await page.locator("#rDate").fill("");
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Choose a date for the new sheets.");

  await page.locator("#rDate").fill("2026-09-22");
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Enter who prepared these sheets.");
  await expect(page.getByLabel("Prepared by")).toBeFocused();

  await page.getByLabel("Prepared by").fill("Robin");
  await saveBtn(page).click();
  await expect(page.locator("#sheetHead")).toContainText("Prepared by Robin");
});

test("says there's nothing to save when no item is assigned anywhere", async ({ page }) => {
  await seedDraft(page, { lines: [draftLine({ name: "Rags", dest: "elsewhere" })] });
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Nothing to save. Assign each item to a client or to General inventory.");
});

test("items bought for storage only go to inventory", async ({ page }) => {
  await scanReceipt(page);
  await line(page, 0).locator('[data-f="dest"]').selectOption({ label: "General inventory (storage)" });
  await line(page, 1).locator('[data-f="dest"]').selectOption({ label: "General inventory (storage)" });
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("6 added to storage");
  await expect(page.getByRole("button", { name: "Inventory" })).toHaveAttribute("aria-pressed", "true");
  await expect(inventoryRow(page, "Storage bins, 12 qt").locator("td").nth(1)).toHaveText("6");
  await expect(inventoryRow(page, "Painter's tape").locator("td").nth(1)).toHaveText("2");
});

test("client items can be kept out of inventory", async ({ page }) => {
  await scanReceipt(page);
  await page.locator("#rSavePrices").uncheck();
  await page.getByLabel("Client name").fill("Whiskey Bar");
  await saveBtn(page).click();
  await expect(page.getByRole("heading", { name: "Whiskey Bar" })).toBeVisible();
  const products = await docs(page, "products/");
  expect(Object.values(products).map((p) => p.name)).not.toContain("Painter's tape, 1.88 in");
});

test("reuses inventory items by barcode or name, and doesn't duplicate new ones", async ({ page }) => {
  await seedDraft(page, {
    dests: [{ id: "d1", sheetId: "", client: "X-ray Co" }],
    lines: [
      draftLine({ name: "Towels", code: "SKU1", qty: 1, price: 9 }),
      draftLine({ name: "storage bins, 12 qt", qty: 1, price: 5 }),
      draftLine({ name: "Sponges", qty: 1, price: 1, dest: "stock" }),
      draftLine({ name: "sponges", qty: 2, price: 1, dest: "stock" }),
    ],
  });
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Saved to 1 sheet · 3 added to storage");
  const products = await docs(page, "products/");
  expect(Object.keys(products)).toHaveLength(3);
  expect(products["products/SKU1"].price).toBe(9);
  expect(products["products/SKU1"].stock).toBe(10);
  expect(Object.values(products).find((p) => p.name === "Sponges").stock).toBe(3);
});

test("barcodes and names that are built-in object keys save as ordinary items", async ({ page }) => {
  // A product saved as "__proto__" by an older version stays out of the way
  const seed = { ...usedState.seed, "products/__proto__": { code: "__proto__", name: "Old proto item", price: 1 } };
  await seedDraft(page, {
    dests: [{ id: "d1", sheetId: "", client: "Built-ins Co" }, { id: "d2", sheetId: "s1", client: "" }],
    lines: [
      draftLine({ name: "Widget A", code: "constructor", qty: 2, price: 1 }),
      draftLine({ name: "Widget B", code: "toString", qty: 1, price: 2 }),
      draftLine({ name: "Widget C", code: "__proto__", qty: 3, price: 3 }),
      draftLine({ name: "constructor", qty: 1, price: 4 }),
      draftLine({ name: "Widget A", code: "constructor", qty: 1, price: 1, dest: "d2" }),
      draftLine({ name: "Widget D", code: "hasOwnProperty", qty: 5, price: 5, dest: "stock" }),
    ],
  }, { seed });
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Saved to 2 sheets · 5 added to storage");

  const products = await docs(page, "products/");
  expect(products["products/constructor"]).toMatchObject({ code: "constructor", name: "Widget A", price: 1 });
  expect(products["products/toString"]).toMatchObject({ code: "toString", name: "Widget B", price: 2 });
  // "__proto__" gets a safe key, and keeps its barcode
  expect(products["products/x__proto__"]).toMatchObject({ code: "__proto__", name: "Widget C", price: 3 });
  expect(products["products/__proto__"].name).toBe("Old proto item");
  expect(products["products/hasOwnProperty"]).toMatchObject({ name: "Widget D", stock: 5 });
  const named = Object.entries(products).find(([, p]) => p.name === "constructor");
  expect(named[0]).toMatch(/^products\/nb-/);

  const sheets = await docs(page, "sheets/");
  const [, fresh] = Object.entries(sheets).find(([, s]) => s.client === "Built-ins Co");
  expect(Object.fromEntries(Object.entries(fresh.items).map(([k, it]) => [k.startsWith("nb-") ? "nb" : k, [it.code, it.name, it.out]]))).toEqual({
    constructor: ["constructor", "Widget A", 2],
    toString: ["toString", "Widget B", 1],
    x__proto__: ["__proto__", "Widget C", 3],
    nb: ["", "constructor", 1],
  });
  expect(sheets["sheets/s1"].items.constructor).toMatchObject({ code: "constructor", name: "Widget A", out: 1, returned: 0 });
  expect(Object.keys(sheets["sheets/s1"].items)).toEqual(["SKU1", "nb-bins", "constructor"]);

  // No built-in object was changed
  expect(await page.evaluate(() => [Object.prototype.out, Object.out, Object.prototype.toString.out, Object.prototype.hasOwnProperty.out, Function.prototype.out, Object.getPrototypeOf({}) === Object.prototype])).toEqual([undefined, undefined, undefined, undefined, undefined, true]);

  // They show like any other item, and the old "__proto__" product stays hidden
  await page.getByRole("button", { name: "Inventory" }).click();
  for (const name of ["Widget A", "Widget B", "Widget C", "Widget D"]) await expect(inventoryRow(page, name)).toBeVisible();
  await expect(page.getByRole("row", { name: /^constructor No barcode/ })).toBeVisible();
  // The two seeded items, five new ones, and not the old "__proto__" product
  await expect(page.locator("#main tbody tr")).toHaveCount(7);
  await expect(page.getByText("Old proto item")).toHaveCount(0);
});

test("a failed inventory write stops the save so it can be retried", async ({ page }) => {
  await scanReceipt(page, { writeErrorFor: { prefix: "products/", code: "unavailable" } });
  await page.getByLabel("Client name").fill("Yankee Co");
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  await expect(saveBtn(page)).toBeEnabled();
  await expect(page.locator(".rline")).toHaveCount(2);
});

test("if one sheet fails to save, only its items stay in the review", async ({ page }) => {
  await scanReceipt(page, { writeErrorFor: { prefix: "sheets/s1", code: "unavailable" } });
  await page.getByLabel("Client name").fill("Zulu Co");
  await page.getByRole("button", { name: "+ Add another client" }).click();
  await page.locator("[data-dsel]").nth(1).selectOption({ label: "Add to Echo Studio (Sep 24, 2026)" });
  await line(page, 1).locator('[data-f="dest"]').selectOption({ label: "Echo Studio (existing sheet)" });
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("That didn't save. Check your connection and try again.");
  await expect(page.locator(".rline")).toHaveCount(1);
  await expect(line(page, 0)).toContainText("PTR TAPE");
  await expect(saveBtn(page)).toBeEnabled();
});

// ADR 0014: cost and client price, and packs converted to eaches (J5)
const gloves = { code: "GL", name: "Gloves, box", price: 2, cost: 1, packSize: 12, stock: 5 };

test("keeps the client price by default when the item is marked up, and saves the receipt price as its cost", async ({ page }) => {
  const seed = { ...usedState.seed, "products/nb-bins": { code: "", name: "Storage bins, 12 qt", price: 5, cost: 4, packSize: 1, stock: 2 }, "products/SKU1": { ...usedState.seed["products/SKU1"], cost: 9 } };
  await seedDraft(page, {
    dests: [{ id: "d1", sheetId: "", client: "Markup Co" }],
    lines: [draftLine({ name: "Bins", match: "nb-bins", qty: 2, price: 4.5, usePrice: "" }), draftLine({ name: "Towels", match: "SKU1", qty: 1, price: 9.5, usePrice: "" })],
  }, { seed });
  // A cost below the price is a markup, so it's kept
  await expect(line(page, 0).getByRole("button", { name: /Keep the client price/ })).toHaveAttribute("aria-pressed", "true");
  await expect(line(page, 0).getByRole("button", { name: /Charge the receipt price/ })).toContainText("$4.50");
  await expect(line(page, 0).locator("[data-total]")).toHaveText("$10.00");
  // A pack size of 1 is no pack
  await expect(line(page, 0)).not.toContainText("1 case");
  // A cost above the price isn't a markup, so the receipt price is charged
  await expect(line(page, 1).getByRole("button", { name: /Charge the receipt price/ })).toHaveAttribute("aria-pressed", "true");
  await saveBtn(page).click();
  await expect(page.getByRole("heading", { name: "Markup Co" })).toBeVisible();
  const products = await docs(page, "products/");
  expect(products["products/nb-bins"]).toMatchObject({ price: 5, cost: 4.5, stock: 2 });
  expect(products["products/SKU1"]).toMatchObject({ price: 9.5, cost: 9.5 });
  const [sheet] = Object.values(await docs(page, "sheets/")).filter((s) => s.client === "Markup Co");
  expect(sheet.items["nb-bins"]).toMatchObject({ price: 5, cost: 4.5, out: 2 });
  expect(sheet.items.SKU1).toMatchObject({ price: 9.5, cost: 9.5, out: 1 });
});

test("a case on a receipt goes into storage as eaches, at the case price divided by its pack size", async ({ page }) => {
  await seedDraft(page, {
    subtotal: 30,
    lines: [draftLine({ name: "Gloves", match: "GL", qty: 2, price: 15, dest: "stock", usePrice: "" })],
  }, { seed: { ...usedState.seed, "products/GL": gloves } });
  const gl = line(page, 0);
  await expect(gl).toContainText("1 case = 12 each");
  await expect(gl.locator("[data-note]")).toHaveText("24 each, cost $1.25 each");
  await expect(gl.getByLabel("Cases")).toHaveValue("2");
  await expect(gl.getByLabel("Per case ($)")).toHaveValue("15");
  await expect(gl.getByRole("button", { name: /Keep the client price/ })).toHaveAttribute("aria-pressed", "true");
  await expect(gl.locator("[data-total]")).toHaveText("$48.00");
  // Storage counts eaches; the receipt comparison uses the receipt's prices
  await expect(page.locator("#rSum")).toContainText("24 items");
  await expect(page.locator("#rSum")).not.toContainText("doesn't match");
  await gl.getByLabel("Cases").fill("3");
  await expect(gl.locator("[data-note]")).toHaveText("36 each, cost $1.25 each");
  await expect(page.locator("#rSum")).toContainText("doesn't match");
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("36 added to storage");
  const products = await docs(page, "products/");
  expect(products["products/GL"]).toMatchObject({ price: 2, cost: 1.25, packSize: 12, stock: 41 });
});

test("a pack item priced per each isn't converted", async ({ page }) => {
  await seedDraft(page, {
    dests: [{ id: "d1", sheetId: "", client: "Singles Co" }],
    lines: [draftLine({ name: "Gloves", match: "GL", qty: 3, price: 1.5, usePrice: "" })],
  }, { seed: { ...usedState.seed, "products/GL": gloves } });
  await line(page, 0).getByLabel("Priced per each").check();
  const gl = line(page, 0);
  await expect(gl.getByLabel("Priced per each")).toBeChecked();
  await expect(gl.locator("[data-note]")).toBeHidden();
  await expect(gl.getByLabel("Qty")).toHaveValue("3");
  await expect(gl.getByLabel("Each ($)")).toHaveValue("1.5");
  await gl.getByRole("button", { name: /Charge the receipt price/ }).click();
  await expect(line(page, 0).locator("[data-total]")).toHaveText("$4.50");
  await saveBtn(page).click();
  await expect(page.getByRole("heading", { name: "Singles Co" })).toBeVisible();
  const [sheet] = Object.values(await docs(page, "sheets/")).filter((s) => s.client === "Singles Co");
  expect(sheet.items.GL).toMatchObject({ code: "GL", price: 1.5, cost: 1.5, out: 3, returned: 0 });
  expect((await docs(page, "products/"))["products/GL"]).toMatchObject({ price: 1.5, cost: 1.5, stock: 5 });
});

test("cases added to an existing sheet line add eaches and keep the line's price and cost", async ({ page }) => {
  const s1 = usedState.seed["sheets/s1"];
  const seed = { ...usedState.seed, "products/GL": gloves, "sheets/s1": { ...s1, items: { ...s1.items, GL: { code: "GL", name: "Gloves, box", price: 1.8, cost: 0.9, out: 4, returned: 1 } } } };
  await seedDraft(page, {
    dests: [{ id: "d1", sheetId: "s1", client: "" }],
    lines: [draftLine({ name: "Gloves", match: "GL", qty: 1, price: 18 })],
  }, { seed });
  await saveBtn(page).click();
  await expect(toast(page)).toHaveText("Saved to 1 sheet");
  const sheets = await docs(page, "sheets/");
  expect(sheets["sheets/s1"].items.GL).toEqual({ code: "GL", name: "Gloves, box", price: 1.8, cost: 0.9, out: 16, returned: 1 });
});
