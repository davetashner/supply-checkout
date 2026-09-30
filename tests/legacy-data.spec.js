// Sheets and items saved by older versions, or edited elsewhere, can be
// missing fields. The app fills in sensible defaults instead of breaking.
import { test, expect, openApp, enterBarcode, modal, lineRow, inventoryRow } from "./helpers.js";
import { fakeImage } from "./fixtures.js";

const bare = {
  seed: {
    "sheets/old": { client: "Old Sheet", createdBy: "u_test", status: "open" },
    "sheets/nameless": {
      client: "Nameless Lines", date: "2026-09-02", createdBy: "u_test", status: "open",
      items: { k1: { code: "", out: 2 } },
    },
    "products/np": { code: "NP1" },
  },
};

test("a sheet with no date or items opens and takes checkouts", { tag: ["@J4"] }, async ({ page }) => {
  await openApp(page, bare);
  await page.getByRole("button", { name: /Old Sheet/ }).click();
  await expect(page.getByText("No supplies on this sheet yet.")).toBeVisible();

  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "NP1");
  await expect(modal(page).getByRole("heading", { name: "Not on this sheet" })).toBeVisible();
  await modal(page).getByRole("button", { name: "Check it out instead" }).click();
  await expect(modal(page)).toContainText("$0.00 each");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(page.locator("#sheetBody tbody tr")).toHaveCount(1);
  await expect(page.locator("#sheetBody tbody tr")).toContainText("Unnamed item");

  await page.getByRole("button", { name: "Download CSV" }).click();
  const save = await page.evaluate(() => window.__mock.saves[0]);
  expect(save.filename).toBe("Old Sheet.csv");
  expect(save.data).toContain("Date,\n");
});

test("lines and items without names or prices use placeholders", { tag: ["@J4"] }, async ({ page }) => {
  await openApp(page, bare);
  await page.getByRole("button", { name: /Nameless Lines/ }).click();
  await lineRow(page, "Unnamed item").click();
  await expect(modal(page).getByRole("heading", { name: "Item", exact: true })).toBeVisible();
  await expect(modal(page).getByLabel("Price each on this sheet ($)")).toHaveValue("0");
  await modal(page).getByLabel("Price each on this sheet ($)").fill("");
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(lineRow(page, "Unnamed item")).toContainText("$0.00");

  await page.getByRole("button", { name: "Return", exact: true }).click();
  await page.getByRole("button", { name: "Return item without a barcode" }).click();
  await modal(page).locator(".pick button").click();
  await expect(modal(page).locator("#sum")).toContainText("Charge $0.00");
  await modal(page).getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Inventory" }).click();
  await expect(inventoryRow(page, "Unnamed item")).toContainText("Barcode NP1");
  await inventoryRow(page, "Unnamed item").click();
  await expect(modal(page).getByLabel("Price each ($)")).toHaveValue("0");
});

test("receipt reading works with an empty inventory", { tag: ["@J5"] }, async ({ page }) => {
  await openApp(page, { receipt: { items: [{ name: "Rags", qty: 1, price: 2 }] } });
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
  expect(await page.evaluate(() => window.__mock.sampleCalls[0])).toContain("(empty)");
});

test("receipt reading works with unnamed, unpriced inventory items", { tag: ["@J5"] }, async ({ page }) => {
  await openApp(page, { ...bare, receipt: { items: [{ name: "Rags", qty: 1, price: 2, match: "i1" }] } });
  await page.setInputFiles("#receiptFile", fakeImage);
  expect(await page.evaluate(() => window.__mock.sampleCalls[0])).toContain("i1 |  | $0.00");
  // The matched item has no price, so the receipt price differs
  await expect(page.locator(".rline").first()).toContainText("Price changed");
  await page.locator(".rline").first().getByRole("button", { name: /Keep the client price/ }).click();
  await expect(page.locator(".rline").first().locator("[data-total]")).toHaveText("$0.00");
  await expect(page.locator(".rline").first()).not.toContainText("in storage now");
  await page.getByLabel("Client name").fill("Bravo Two");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bravo Two" })).toBeVisible();
});

test("adds receipt items to an existing sheet that has no items yet", { tag: ["@J5"] }, async ({ page }) => {
  await openApp(page, { ...bare, receipt: { items: [{ name: "Rags", qty: 3, price: 2 }] } });
  await page.setInputFiles("#receiptFile", fakeImage);
  await page.locator("[data-dsel]").selectOption({ label: "Add to Old Sheet ()" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(lineRow(page, "Rags").locator("td").nth(2)).toHaveText("3");
});

test("a receipt line that matches inventory exactly needs no choices", { tag: ["@J5"] }, async ({ page }) => {
  await openApp(page, {
    seed: { "products/p1": { code: "", name: "Rags", price: 2 }, "products/p2": { code: "", name: "Free samples", price: 0 } },
    receipt: { items: [{ name: "rags", qty: 1, price: 2, match: "i1" }, { name: "Free samples", qty: 1, price: 0, match: "i2" }] },
  });
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.locator(".rline")).toHaveCount(2);
  await expect(page.locator(".rline .choice")).toHaveCount(0);
  await expect(page.locator(".rline").first()).toContainText("Suggested match");
});

test("a barcode made only of dots still gets a safe key", { tag: ["@J4"] }, async ({ page }) => {
  await openApp(page, bare);
  await page.getByRole("button", { name: /Old Sheet/ }).click();
  await enterBarcode(page, "...");
  await modal(page).getByLabel("Item name").fill("Dots");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Dots")).toContainText("Barcode ...");
  expect(await page.evaluate(() => window.__mock.docs.has("products/x..."))).toBe(true);
});

const otherSheet = { "sheets/o": { client: "Other", date: "2026-09-03", createdBy: "u_other", status: "open", items: {} } };

test("sheets by people without a profile name export as Someone", { tag: ["@J6"] }, async ({ page }) => {
  await openApp(page, { seed: otherSheet });
  await page.getByRole("button", { name: /Other/ }).click();
  await page.getByRole("button", { name: "Download CSV" }).click();
  expect(await page.evaluate(() => window.__mock.saves[0].data)).toContain("Prepared by,Someone");
});

test("sheets export as Someone when profiles can't be loaded", { tag: ["@J6"] }, async ({ page }) => {
  await openApp(page, {
    userErrors: ["profiles"],
    seed: otherSheet,
  });
  await page.getByRole("button", { name: /Other/ }).click();
  await page.getByRole("button", { name: "Download CSV" }).click();
  expect(await page.evaluate(() => window.__mock.saves[0].data)).toContain("Prepared by,Someone");
});

test("a saved review missing newer fields still opens", { tag: ["@J5"] }, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("supplyCheckout.receiptDraft", JSON.stringify({
    store: "", receiptDate: "2026-09-20", date: "2026-09-25", subtotal: null, tax: null, savePrices: true,
    dests: [{ id: "d1", sheetId: "", client: "" }],
    lines: [{ id: "l1", name: "Rags", raw: "", qty: 1, price: 2, dest: "d1", code: "", match: "", useName: "inv", usePrice: "receipt" }],
  })));
  await openApp(page);
  await page.getByRole("button", { name: "Continue review" }).click();
  await expect(page.locator(".rline")).toHaveCount(1);
});
