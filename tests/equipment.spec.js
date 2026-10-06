// Company equipment (ADR 0017): items that go to a job and come back, listed on the sheet but
// not charged. The item editor's kind and value, the sheet's "Equipment (not charged)" section,
// returns, the line editor, the exports, Inventory's Supplies / Equipment filter and its Out view.
// In both builds, against the claude.ai runtime's mock; the web build's checkout command is
// against tests/fake-aws.js at the end.
import { test, expect, openApp, enterBarcode, modal, modalViolations, lineRow, inventoryRow } from "./helpers.js";
import { FakeBackend, openAws, connected } from "./fake-aws.js";
import { persona } from "./journey-video.js";

const TAKEN = "2026-09-24T13:05:00.000Z";
// The teammate on the seeded sheets: "Sam", or in the marketing clips a full name
const SAM = persona?.crew ?? "Sam";
const ladder = { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, stock: 3 };
const towels = { code: "SKU1", name: "Paper towels, 6 roll", price: 8.5, stock: 10 };
const seed = {
  "products/LAD-1": ladder,
  "products/SKU1": towels,
  "products/vac": { code: "", name: "Shop vacuum", kind: "equipment", cost: 210 },
  "sheets/s1": {
    client: "Echo Studio", date: "2026-09-24", createdBy: "u_test", createdAt: "2026-09-24T12:00:00Z", status: "open",
    items: {
      SKU1: { code: "SKU1", name: "Paper towels, 6 roll", price: 8.5, out: 3, returned: 1 },
      "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, out: 1, returned: 0, takenBy: "u_test", takenAt: TAKEN },
    },
  },
  "sheets/s2": {
    client: "Delta Dental", date: "2026-09-22", createdByName: SAM, status: "open",
    items: { "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, out: 3, returned: 0, lost: 1, takenBy: SAM } },
  },
  "sheets/s3": {
    client: "Foxtrot", date: "2026-09-20", createdByName: SAM, status: "closed",
    items: { vac: { code: "", name: "Shop vacuum", kind: "equipment", cost: 210, out: 1, returned: 1 } },
  },
};

const ready = (page) => page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });
async function open(page, opts = {}) {
  await openApp(page, { seed, ...opts });
  await ready(page);
}
const openSheet = async (page, client) => page.getByRole("button", { name: new RegExp(client) }).click();
const doc = (page, path) => page.evaluate((p) => window.__mock.docs.get(p), path);
const inventory = async (page) => page.getByRole("button", { name: "Inventory" }).click();
const equipmentRow = (page, name) => page.locator("#sheetBody table.equipment tbody tr", { hasText: name });

test.describe("J13. Take company equipment to a job and bring it back", { tag: ["@J13"] }, () => {
  test("an item can be company equipment: no client price, and its cost is its value", { tag: ["@J13.1"] }, async ({ page }) => {
    await open(page);
    await inventory(page);
    await page.getByRole("button", { name: "+ Add item" }).click();
    await expect(modal(page).getByLabel("Supply (used up, charged)")).toBeChecked();
    await expect(modal(page).getByLabel("Price each ($)")).toBeVisible();
    await modal(page).getByLabel("Company equipment (reused, not charged)").check();
    await expect(modal(page).getByLabel("Price each ($)")).toBeHidden();
    await expect(modal(page).getByLabel("Value each ($)")).toBeVisible();
    await expect(modal(page)).toContainText("It's listed on sheets but not charged.");
    await modal(page).getByPlaceholder("Type, scan, or leave blank").fill("CORD-50");
    await modal(page).getByLabel("Item name").fill("Extension cord, 50 ft");
    await modal(page).getByLabel("Value each ($)").fill("34.99");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(inventoryRow(page, "Extension cord")).toContainText("Company equipment");
    await expect(inventoryRow(page, "Extension cord").locator("td").nth(2)).toHaveText("Not charged");
    await expect(inventoryRow(page, "Extension cord").locator("td").nth(3)).toHaveText("$34.99");
    const saved = await doc(page, "products/CORD-50");
    expect(saved).toMatchObject({ code: "CORD-50", name: "Extension cord, 50 ft", kind: "equipment", cost: 34.99 });
    expect(saved).not.toHaveProperty("price");

    // Back to a supply: the price field again, and the item has no kind
    await inventoryRow(page, "Step ladder").click();
    await expect(modal(page).getByLabel("Company equipment (reused, not charged)")).toBeChecked();
    await expect(modal(page).getByLabel("Value each ($)")).toHaveValue("120");
    await modal(page).getByLabel("Supply (used up, charged)").check();
    await expect(modal(page).getByLabel("Cost each ($)")).toBeVisible();
    await expect(modal(page)).toContainText("Price is what a client is charged.");
    await modal(page).getByLabel("Price each ($)").fill("15");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    const supply = await doc(page, "products/LAD-1");
    expect(supply).toMatchObject({ name: "Step ladder", price: 15, cost: 120 });
    expect(supply).not.toHaveProperty("kind");
  });

  test("equipment checked out goes in its own section, not in the totals or the client's CSV", { tag: ["@J13.2", "@J6.2"] }, async ({ page }) => {
    await open(page);
    // The sheet card counts supplies, and says what equipment is out
    await expect(page.getByRole("button", { name: /Echo Studio/ })).toContainText("1 item · 3 taken · 1 back · 1 equipment out");
    await openSheet(page, "Echo Studio");
    await expect(page.locator("#sheetBody")).toContainText("Equipment (not charged)");
    await expect(equipmentRow(page, "Step ladder").locator("td")).toHaveText(["Step ladderBarcode LAD-1", "1", "0", "1"]);
    await expect(page.locator("#sheetBody .totals")).toContainText("Taken3");
    await expect(page.locator("#sheetBody .totals .charge")).toHaveText("$17.00");

    // Taking another: the item says it isn't charged, and the line keeps no price
    await enterBarcode(page, "LAD-1");
    await expect(modal(page)).toContainText("Company equipment · not charged");
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(page.locator("#toast")).toHaveText("Checked out 1 × Step ladder");
    await expect(equipmentRow(page, "Step ladder").locator("td").last()).toHaveText("2");
    await expect(page.locator("#sheetBody .totals .charge")).toHaveText("$17.00");
    const line = (await doc(page, "sheets/s1")).items["LAD-1"];
    expect(line).toMatchObject({ kind: "equipment", out: 2, returned: 0, takenBy: "u_test", takenAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });
    expect(line).not.toHaveProperty("price");
    expect(line.takenAt).not.toBe(TAKEN);

    // The client's CSV has no equipment rows
    await page.getByRole("button", { name: "Download CSV" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    const csv = await page.evaluate(() => window.__mock.saves[0].data);
    expect(csv).not.toContain("Step ladder");
    expect(csv.split("\n").at(-1)).toBe("Total,,,3,1,2,17.00");
  });

  test("a new piece of equipment from the pick list starts its own line with who took it", { tag: ["@J13.2"] }, async ({ page }) => {
    await open(page);
    await openSheet(page, "Echo Studio");
    await page.getByRole("button", { name: "Add item without a barcode" }).click();
    await expect(modal(page).locator("[data-k=vac]")).toContainText("Equipment");
    await modal(page).locator("[data-k=vac]").click();
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(equipmentRow(page, "Shop vacuum")).toBeVisible();
    expect((await doc(page, "sheets/s1")).items.vac).toEqual({ code: "", name: "Shop vacuum", kind: "equipment", cost: 210, out: 1, returned: 0, takenBy: "u_test", takenAt: expect.any(String), ops: expect.any(Array) });
  });

  test("returning equipment counts what's still out, not what's used", { tag: ["@J13.3"] }, async ({ page }) => {
    await open(page);
    await openSheet(page, "Delta Dental");
    // Out 3, lost 1: two can come back
    await expect(equipmentRow(page, "Step ladder").locator("td")).toHaveText(["Step ladderBarcode LAD-1", "3", "0", "1", "2"]);
    await expect(page.locator("#sheetBody thead").last()).toContainText("Lost or broken");
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await enterBarcode(page, "LAD-1");
    await expect(modal(page).locator("#sum")).toHaveText("Returned 1 of 3Still out 1");
    await modal(page).getByRole("button", { name: "More" }).click();
    await expect(modal(page).locator("#sum")).toHaveText("Returned 2 of 3Still out 0");
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(page.locator("#toast")).toHaveText("2 returned · 2 of 3 back");
    await expect(equipmentRow(page, "Step ladder").locator("td").last()).toHaveText("0");
    expect((await doc(page, "sheets/s2")).items["LAD-1"]).toMatchObject({ out: 3, returned: 2, lost: 1 });
    expect((await doc(page, "products/LAD-1")).stock).toBe(5);
    // Nothing more is out
    await enterBarcode(page, "LAD-1");
    await expect(modal(page)).toContainText("None of Step ladder is still out.");
  });

  test("the line editor has no price for equipment, and keeps returned and lost within taken", { tag: ["@J13.2"] }, async ({ page }) => {
    await open(page);
    await openSheet(page, "Delta Dental");
    await equipmentRow(page, "Step ladder").click();
    await expect(modal(page)).toContainText("Company equipment: not charged.");
    await expect(modal(page).locator("#fPrice")).toHaveCount(0);
    await modal(page).getByLabel("Taken").fill("0");
    await modal(page).getByLabel("Returned").fill("9");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    // Taken can't go below the one lost, and nothing else is left to have come back
    const line = (await doc(page, "sheets/s2")).items["LAD-1"];
    expect(line).toMatchObject({ out: 1, returned: 0, lost: 1 });
    expect(line).not.toHaveProperty("price");
  });

  test("Inventory filters supplies and equipment, and shows where equipment is out", { tag: ["@J13.5"] }, async ({ page }) => {
    await open(page);
    await inventory(page);
    await expect(page.locator("#main")).toContainText("3 items.");
    await page.getByRole("button", { name: "Supplies" }).click();
    await expect(page.locator("#main")).toContainText("1 item.");
    await expect(inventoryRow(page, "Paper towels")).toBeVisible();
    await expect(page.getByRole("button", { name: "Out on jobs" })).toHaveCount(0);
    await page.getByRole("button", { name: "Equipment", exact: true }).click();
    await expect(page.locator("#main")).toContainText("2 items.");
    await expect(page.locator("#main thead")).toContainText("Value each");
    await expect(inventoryRow(page, "Step ladder").locator("td").nth(4)).toHaveText("$360.00");

    // Out: each open sheet with equipment still out, who took it last and when
    await page.getByRole("button", { name: "Out on jobs" }).click();
    const rows = page.locator("#main table.out tbody tr");
    await expect(rows).toHaveCount(2);
    // As the browser formats it (WebKit says "Sep 24 at 9:05 AM", Chromium "Sep 24, 9:05 AM")
    const when = await page.evaluate((t) => new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), TAKEN);
    // By item, then the oldest sheet first. The artifact build saves a typed name when there's no
    // user, and an older line has no time
    // (The web build's lines name a user, and someone it has no profile for is "Someone")
    await expect(rows.nth(0).locator("td")).toHaveText(["Step ladderBarcode LAD-1", "2", "Delta DentalSep 22, 2026", persona?.crew ?? "Someone", "—"]);
    await expect(rows.nth(1).locator("td")).toHaveText(["Step ladderBarcode LAD-1", "1", "Echo StudioSep 24, 2026", persona?.user ?? "Test User", when]);
    // The closed sheet's vacuum came back, so it isn't listed; a row opens its sheet
    await rows.nth(0).click();
    await expect(page.getByRole("heading", { name: "Delta Dental" })).toBeVisible();
    await page.getByRole("button", { name: "Inventory" }).click();
    await page.locator("#main table.out tbody tr").last().press("Enter");
    await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
    await page.getByRole("button", { name: "Inventory" }).click();
    await page.getByRole("button", { name: "In storage" }).click();
    await expect(inventoryRow(page, "Shop vacuum")).toBeVisible();
  });

  test("the Out view lists each piece by name, and lines from before who took it was kept", { tag: ["@J13.5"] }, async ({ page }) => {
    await open(page, { seed: {
      "products/vac": seed["products/vac"],
      "sheets/s1": { client: "Echo", date: "2026-09-24", status: "open", items: {
        vac: { name: "Shop vacuum", kind: "equipment", out: 1, returned: 0 },
        cord: { name: "Extension cord", kind: "equipment", out: 2, returned: 0, takenAt: "soon" },
      } },
      "sheets/s2": { date: "2026-09-25", status: "open", items: { z: { code: "", kind: "equipment", out: 1, returned: 0 } } },
    } });
    await inventory(page);
    await page.getByRole("button", { name: "Equipment", exact: true }).click();
    await page.getByRole("button", { name: "Out on jobs" }).click();
    const rows = page.locator("#main table.out tbody tr");
    await expect(rows.nth(0).locator("td")).toHaveText(["Extension cordNo barcode", "2", "EchoSep 24, 2026", "—", "—"]);
    await expect(rows.nth(1).locator("td")).toHaveText(["Shop vacuumNo barcode", "1", "EchoSep 24, 2026", "—", "—"]);
    // A line or sheet without a name, as older data may have
    await expect(rows.nth(2).locator("td")).toHaveText(["Unnamed itemNo barcode", "1", "UntitledSep 25, 2026", "—", "—"]);
  });

  test("without a signed-in user, equipment names who prepared the sheet, or no one", { tag: ["@J13.2"] }, async ({ page }) => {
    await open(page, { userErrors: ["id"], seed: { ...seed, "sheets/s4": { client: "Golf", date: "2026-09-25", status: "open", items: {} } } });
    for (const [client, sheet, taker] of [["Delta Dental", "s2", "Sam"], ["Golf", "s4", ""]]) {
      await page.getByRole("button", { name: "Sheets", exact: true }).click();
      await openSheet(page, client);
      await page.getByRole("button", { name: "Add item without a barcode" }).click();
      await modal(page).locator("[data-k=vac]").click();
      await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
      await expect(equipmentRow(page, "Shop vacuum")).toBeVisible();
      expect((await doc(page, `sheets/${sheet}`)).items.vac.takenBy).toBe(taker);
    }
  });

  test("Inventory says when there's no equipment, none out, or no supplies", { tag: ["@J13.5"] }, async ({ page }) => {
    await open(page, { seed: { "products/SKU1": towels, "sheets/s1": { client: "Echo", date: "2026-09-24", status: "open", items: { x: { name: "Old", kind: "equipment", out: 1, returned: 1 } } } } });
    await inventory(page);
    await page.getByRole("button", { name: "Equipment", exact: true }).click();
    await expect(page.locator("#main")).toContainText("No company equipment yet. Edit an item and choose Company equipment.");
    await page.getByRole("button", { name: "Out on jobs" }).click();
    await expect(page.locator("#main")).toContainText("No company equipment is out on a job right now.");
    await page.evaluate(() => { window.__mock.docs.set("products/SKU1", { ...window.__mock.docs.get("products/SKU1"), kind: "equipment" }); window.__mock.notify(); });
    await page.getByRole("button", { name: "Supplies" }).click();
    await expect(page.locator("#main")).toContainText("No supplies yet.");
  });

  test("the owner's export keeps equipment, with its kind; the inventory export values it at cost", { tag: ["@J13", "@J6"] }, async ({ page }) => {
    // Charged for what was lost: the ladder, and a piece without a name or barcode
    const s2 = seed["sheets/s2"];
    await open(page, { seed: { ...seed, "sheets/s2": { ...s2, items: { "LAD-1": { ...s2.items["LAD-1"], lostCharge: 50 }, odd: { kind: "equipment", out: 1, returned: 0, lost: 1, lostCharge: 5 } } } } });
    await page.getByRole("button", { name: "Export data" }).click();
    await modal(page).getByRole("button", { name: "Sheets (CSV)" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    const sheets = (await page.evaluate(() => window.__mock.saves[0].data)).split("\n");
    expect(sheets).toContain("Delta Dental,2026-09-22,Sam,Checked out,Step ladder,LAD-1,,3,0,,,s2,Equipment");
    expect(sheets).toContain("Delta Dental,2026-09-22,Sam,Checked out,Step ladder (lost or broken),LAD-1,,,,1,50.00,s2,Equipment");
    expect(sheets).toContain("Echo Studio,2026-09-24,Test User,Checked out,\"Paper towels, 6 roll\",SKU1,8.50,3,1,2,17.00,s1,Supply");
    await modal(page).getByRole("button", { name: "Inventory (CSV)" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(2);
    const items = (await page.evaluate(() => window.__mock.saves[1].data)).split("\n");
    expect(items).toContain("Step ladder,LAD-1,3,,360.00,Equipment");
    expect(items).toContain("Shop vacuum,,,,,Equipment");
    // The client's file has the charges, and the total
    await modal(page).getByRole("button", { name: "Close" }).click();
    await openSheet(page, "Delta Dental");
    await page.getByRole("button", { name: "Download CSV" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(3);
    const csv = (await page.evaluate(() => window.__mock.saves[2].data)).split("\n");
    expect(csv.slice(-3)).toEqual(["Step ladder (lost or broken),LAD-1,,,,1,50.00", "Unnamed item (lost or broken),,,,,1,5.00", "Total,,,0,0,2,55.00"]);
  });

  test("a receipt's equipment bought for storage sets its value, never a price", { tag: ["@J13"] }, async ({ page }) => {
    await page.addInitScript((d) => {
      if (sessionStorage.getItem("draftSeeded")) return;
      sessionStorage.setItem("draftSeeded", "1");
      localStorage.setItem("supplyCheckout.receiptDraft", JSON.stringify(d));
    }, {
      store: "", receiptDate: "2026-09-20", date: "2026-09-25", subtotal: null, tax: null, total: null, savePrices: true, by: "",
      dests: [{ id: "d1", sheetId: "", client: "" }],
      lines: [{ id: "l1", name: "Ladder", raw: "", qty: 1, price: 130, dest: "stock", code: "", match: "LAD-1", suggested: false, useName: "inv", usePrice: "receipt" }],
    });
    await open(page);
    await page.getByRole("button", { name: "Continue review" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("#toast")).toHaveText("1 added to storage");
    const saved = await doc(page, "products/LAD-1");
    expect(saved).toMatchObject({ kind: "equipment", cost: 130, stock: 4 });
    expect(saved).not.toHaveProperty("price");
  });
});

test.describe("the web build's checkout command", () => {

  test("snapshots equipment on the server, and the sheet shows it apart", { tag: ["@J13.2"] }, async ({ page }) => {
    const docs = Object.fromEntries(Object.entries(seed).map(([k, v]) => [`t1/${k}`, v]));
    const backend = new FakeBackend({ docs });
    await openAws(page, backend);
    await connected(page);
    await openSheet(page, "Delta Dental");
    // A new line: the server copies the kind and value, and who took it
    await page.getByRole("button", { name: "Add item without a barcode" }).click();
    await modal(page).locator("[data-k=vac]").click();
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(equipmentRow(page, "Shop vacuum")).toBeVisible();
    const [checkout] = backend.requests("POST", "/teams/t1/sheets/s2/checkout");
    expect(checkout.body).toEqual({ operationId: expect.any(String), productKey: "vac", quantity: 1 });
    expect(backend.doc("t1", "sheets", "s2").data.items.vac).toEqual({ code: "", name: "Shop vacuum", kind: "equipment", cost: 210, out: 1, returned: 0, takenBy: "u-pat", takenAt: expect.any(String) });
    // More of a line someone else took: the latest person to take more
    await enterBarcode(page, "LAD-1");
    await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
    await expect(equipmentRow(page, "Step ladder").locator("td").last()).toHaveText("3");
    expect(backend.doc("t1", "sheets", "s2").data.items["LAD-1"]).toMatchObject({ out: 4, lost: 1, takenBy: "u-pat" });
    // Only the server wrote the sheet: no document write from the page
    expect(backend.requests("PATCH", /^\/teams\/t1\/sheets\//)).toEqual([]);
    await expect(lineRow(page, "Step ladder")).toHaveCount(1);
  });

  test("Finished Return sends the return and the lost command, then closes the sheet", { tag: ["@J13.4", "@J4.3"] }, async ({ page }) => {
    const docs = Object.fromEntries(Object.entries(seed).map(([k, v]) => [`t1/${k}`, v]));
    const backend = new FakeBackend({ docs });
    await openAws(page, backend);
    await connected(page);
    await openSheet(page, "Delta Dental");
    await page.getByRole("button", { name: "Finished Return" }).click();
    await finishBox(page, 0).locator("[data-step='1']").first().click();
    await finishBox(page, 0).locator("[data-step='1']").last().click();
    await modal(page).getByLabel(/Charge the client/).fill("80");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("Return finished");
    expect(backend.requests("POST", "/teams/t1/sheets/s2/return").map((r) => r.body)).toEqual([{ operationId: expect.any(String), productKey: "LAD-1", quantity: 1 }]);
    expect(backend.requests("POST", "/teams/t1/sheets/s2/lost").map((r) => r.body)).toEqual([{ operationId: expect.any(String), productKey: "LAD-1", quantity: 1, charge: 80 }]);
    expect(backend.doc("t1", "sheets", "s2").data).toMatchObject({ status: "closed", items: { "LAD-1": { out: 3, returned: 1, lost: 2, lostCharge: 80 } } });
    // The return put one back in storage; the lost one didn't move it
    expect(backend.doc("t1", "products", "LAD-1").data.stock).toBe(4);
  });

  test("a sheet someone took more equipment on meanwhile isn't finished, and says so", { tag: ["@J13.4"] }, async ({ page }) => {
    const docs = Object.fromEntries(Object.entries(seed).map(([k, v]) => [`t1/${k}`, v]));
    docs["t1/sheets/s2"] = { ...seed["sheets/s2"], items: { "LAD-1": { ...seed["sheets/s2"].items["LAD-1"], returned: 2 } } };
    const backend = new FakeBackend({ docs });
    await openAws(page, backend);
    await connected(page);
    await openSheet(page, "Delta Dental");
    await expect(equipmentRow(page, "Step ladder").locator("td").last()).toHaveText("0");
    // Another phone took one more, and this page hasn't heard yet
    backend.doc("t1", "sheets", "s2").data.items["LAD-1"].out = 4;
    await page.getByRole("button", { name: "Finished Return" }).click();
    await expect(page.locator("#toast")).toHaveText("Equipment is still out on this sheet, so it wasn't finished. Tap Finished Return again to say where each piece is.");
    expect(backend.doc("t1", "sheets", "s2").data.status).toBe("open");
    // The latest is showing: one still out
    await expect(equipmentRow(page, "Step ladder").locator("td").last()).toHaveText("1");
  });
});

const finishBox = (page, i) => modal(page).locator(`fieldset.finish[data-i="${i}"]`);

test.describe("J13.4 Finished Return asks about each piece of equipment still out", { tag: ["@J13.4", "@J4.3"] }, () => {
  test("pieces back go into storage, the rest stay out at the job, and the sheet stays open", async ({ page }) => {
    await open(page);
    await openSheet(page, "Delta Dental");
    await page.getByRole("button", { name: "Finished Return" }).click();
    await expect(modal(page).getByRole("heading", { name: "Before you finish" })).toBeVisible();
    await expect(finishBox(page, 0).locator("legend")).toHaveText("Step ladder · 2 still out");
    await expect(finishBox(page, 0).locator("[data-left]")).toHaveText("Still at the job: 2");
    await expect(finishBox(page, 0).locator("[data-charge]")).toBeHidden();
    await finishBox(page, 0).getByLabel("It's back").fill("1");
    await expect(finishBox(page, 0).locator("[data-left]")).toHaveText("Still at the job: 1");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("Saved. 1 still at the job, so the sheet stays open.");
    await expect(page.locator(".sheet-head .pill")).toHaveText("Checked out");
    expect((await doc(page, "sheets/s2")).items["LAD-1"]).toMatchObject({ out: 3, returned: 1, lost: 1 });
    expect((await doc(page, "products/LAD-1")).stock).toBe(4);
    await expect(page.getByRole("button", { name: "Inventory" })).toBeVisible();
  });

  test("lost or broken, with a charge, goes on the sheet's total and the client's CSV, and then it closes", async ({ page }) => {
    await open(page);
    await openSheet(page, "Delta Dental");
    await page.getByRole("button", { name: "Finished Return" }).click();
    await finishBox(page, 0).getByLabel("It's back").fill("1");
    await finishBox(page, 0).getByLabel("Lost or broken", { exact: true }).fill("1");
    await finishBox(page, 0).getByLabel("Lost or broken", { exact: true }).dispatchEvent("input");
    await expect(finishBox(page, 0).locator("[data-charge]")).toBeVisible();
    await expect(finishBox(page, 0)).toContainText("Worth $120.00 each. The amount is for all of them, not each.");
    await finishBox(page, 0).getByLabel(/Charge the client/).fill("75.5");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("Return finished");
    await expect(page.locator(".sheet-head .pill")).toHaveText("Returned");
    const line = (await doc(page, "sheets/s2")).items["LAD-1"];
    expect(line).toMatchObject({ out: 3, returned: 1, lost: 2, lostCharge: 75.5 });
    // The charge is its own row with the supplies, and in the total; stock didn't move for the lost one
    const row = page.locator("#sheetBody table:not(.equipment) tbody tr", { hasText: "Step ladder (lost or broken)" });
    await expect(row.locator("td")).toHaveText(["Step ladder (lost or broken)Barcode LAD-1", "", "", "", "2", "$75.50"]);
    await expect(page.locator("#sheetBody .totals .charge")).toHaveText("$75.50");
    await expect(equipmentRow(page, "Step ladder").locator("td")).toHaveText(["Step ladderBarcode LAD-1", "3", "1", "2", "0"]);
    expect((await doc(page, "products/LAD-1")).stock).toBe(4);
    // Its row opens the equipment line
    await row.click();
    await expect(modal(page)).toContainText("Company equipment: not charged.");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Download CSV" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    const csv = (await page.evaluate(() => window.__mock.saves[0].data)).split("\n");
    expect(csv.slice(-2)).toEqual(["Step ladder (lost or broken),LAD-1,,,,2,75.50", "Total,,,0,0,2,75.50"]);
    // The closed card shows what's charged
    await page.getByRole("button", { name: "Sheets", exact: true }).click();
    await page.getByRole("button", { name: "Returned" }).click();
    await expect(page.getByRole("button", { name: /Delta Dental/ })).toContainText("$75.50");
  });

  test("asks about each line on its own, refuses more than are out, and can be cancelled", async ({ page }) => {
    const s1 = seed["sheets/s1"];
    await open(page, { seed: { ...seed, "sheets/s1": { ...s1, items: { ...s1.items, cord: { code: "", name: "Extension cord", kind: "equipment", out: 2, returned: 0 } } } } });
    await openSheet(page, "Echo Studio");
    await page.getByRole("button", { name: "Finished Return" }).click();
    await expect(modal(page).locator("fieldset.finish")).toHaveCount(2);
    // The order of the sheet: the cord, then the ladder; each box's steppers move only its own count
    await expect(finishBox(page, 0).locator("legend")).toHaveText("Extension cord · 2 still out");
    await finishBox(page, 1).locator("[data-step='1']").first().click();
    await expect(finishBox(page, 1).getByLabel("It's back")).toHaveValue("1");
    await expect(finishBox(page, 0).getByLabel("It's back")).toHaveValue("0");
    await finishBox(page, 0).getByLabel("It's back").fill("2");
    await finishBox(page, 0).getByLabel("Lost or broken", { exact: true }).fill("1");
    await finishBox(page, 0).getByLabel("Lost or broken", { exact: true }).dispatchEvent("input");
    await expect(finishBox(page, 0).locator("[data-left]")).toHaveText("That's more than the 2 still out.");
    await expect(finishBox(page, 0)).toContainText("Its value isn't known.");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("That's more Extension cord than are still out.");
    expect((await doc(page, "sheets/s1")).items.cord).toMatchObject({ returned: 0 });
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(page.locator(".sheet-head .pill")).toHaveText("Checked out");
  });

  test("Try again after a failed save records each piece once, and a sheet without equipment out closes at once", async ({ page }) => {
    await open(page);
    await openSheet(page, "Delta Dental");
    await page.getByRole("button", { name: "Finished Return" }).click();
    await finishBox(page, 0).getByLabel("It's back").fill("1");
    await finishBox(page, 0).getByLabel("Lost or broken", { exact: true }).fill("1");
    // The sheet's writes fail for the connection, then work on Try again
    await page.evaluate(() => { window.__mock.failWrites = { prefix: "sheets/s2", code: "unavailable" }; });
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
    await page.evaluate(() => { window.__mock.failWrites = null; });
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(page.locator("#toast")).toHaveText("Return finished");
    expect((await doc(page, "sheets/s2")).items["LAD-1"]).toMatchObject({ out: 3, returned: 1, lost: 2 });
    expect((await doc(page, "sheets/s2")).items["LAD-1"]).not.toHaveProperty("lostCharge");
    expect((await doc(page, "products/LAD-1")).stock).toBe(4);

    // A sheet whose equipment is all back finishes as before
    await page.getByRole("button", { name: "Sheets", exact: true }).click();
    await page.getByRole("button", { name: "Out now" }).click();
    await page.evaluate(() => { const s = window.__mock.docs.get("sheets/s1"); s.items["LAD-1"].returned = 1; window.__mock.notify(); });
    await openSheet(page, "Echo Studio");
    await expect(equipmentRow(page, "Step ladder").locator("td").last()).toHaveText("0");
    await page.getByRole("button", { name: "Finished Return" }).click();
    await expect(page.locator("#toast")).toHaveText("Return finished");
  });
  // Owner's report from an iPhone in portrait: side by side, each number box shrank to a sliver
  test("on a phone in portrait the two steppers stack, and each shows 3 digits with 44px buttons", async ({ page }) => {
    const s2 = seed["sheets/s2"];
    await open(page, { seed: { ...seed, "sheets/s2": { ...s2, items: { "LAD-1": { ...s2.items["LAD-1"], out: 250, lost: 0 } } } } });
    await openSheet(page, "Delta Dental");
    await page.getByRole("button", { name: "Finished Return" }).click();
    const box = finishBox(page, 0);
    await expect(box.locator("legend")).toHaveText("Step ladder · 250 still out");
    await box.getByLabel("It's back").fill("120");
    await box.getByLabel("Lost or broken", { exact: true }).fill("100");
    await box.getByLabel("Lost or broken", { exact: true }).dispatchEvent("input");
    await expect(box.locator("[data-left]")).toHaveText("Still at the job: 30");
    await expect(box.locator("[data-charge]")).toBeVisible();
    // Sizes of everything in the box, and whether anything scrolls sideways
    const measure = () => box.evaluate((el) => {
      const ctx = document.createElement("canvas").getContext("2d");
      const inputs = [...el.querySelectorAll(".stepper input")].map((i) => {
        // Room inside the box from its border box: Firefox reports an input's clientWidth without its padding
        const cs = getComputedStyle(i), r = i.getBoundingClientRect();
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        return { width: r.width, top: r.top, bottom: r.bottom, room: r.width - ["borderLeftWidth", "borderRightWidth", "paddingLeft", "paddingRight"].reduce((n, p) => n + parseFloat(cs[p]), 0), text: ctx.measureText(i.value).width };
      });
      const buttons = [...el.querySelectorAll(".stepper button")].map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); });
      const modalEl = document.getElementById("modal"), m = modalEl.getBoundingClientRect();
      const inside = [...el.querySelectorAll("input, [data-left], label")].every((n) => { const r = n.getBoundingClientRect(); return r.left >= m.left - 0.5 && r.right <= m.right + 0.5; });
      return { inputs, buttons, inside, modalScrolls: modalEl.scrollWidth > modalEl.clientWidth, pageScrolls: document.documentElement.scrollWidth > window.innerWidth };
    });
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 740 });
      const m = await measure();
      for (const i of m.inputs) {
        expect(i.width, `number box at ${width}px`).toBeGreaterThanOrEqual(44);
        expect(i.room, `room for "${i.text}" at ${width}px`).toBeGreaterThanOrEqual(i.text);
      }
      for (const b of m.buttons) expect(b, `button at ${width}px`).toBeGreaterThanOrEqual(44);
      // Lost or broken is under It's back
      expect(m.inputs[1].top).toBeGreaterThanOrEqual(m.inputs[0].bottom);
      expect(m.inside, `fields inside the dialog at ${width}px`).toBe(true);
      expect(m.modalScrolls, `dialog scrolls sideways at ${width}px`).toBe(false);
      expect(m.pageScrolls, `page scrolls sideways at ${width}px`).toBe(false);
    }
    expect(await modalViolations(page)).toEqual([]);
    // In landscape, the dialog is wide enough for them side by side, as before
    await page.setViewportSize({ width: 844, height: 390 });
    const wide = await measure();
    expect(wide.inputs[1].top).toBeLessThan(wide.inputs[0].bottom);
    for (const i of wide.inputs) expect(i.room).toBeGreaterThanOrEqual(i.text);
    for (const b of wide.buttons) expect(b).toBeGreaterThanOrEqual(44);
    expect(wide.modalScrolls).toBe(false);
  });
});
