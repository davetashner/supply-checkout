// The ad hoc checkout (ADR 0017, sections 4 to 6): Quick take onto the team's ad hoc sheet, its
// card and screen, Return from the sheet list, a job sheet's "Not on this sheet" offering where
// the item is out, moving an ad hoc line to a job sheet, and finishing the ad hoc sheet. In both
// builds against the claude.ai runtime's mock (the artifact build's writes, section 6), then the
// web build's commands against tests/fake-aws.js.
import { test, expect, openApp, modal, lineRow } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { FakeBackend, openAws, connected } from "./fake-aws.js";

const gloves = { code: "G1", name: "Nitrile gloves", price: 12.5, cost: 9, stock: 50 };
const towels = { code: "SKU1", name: "Paper towels", price: 8.5, stock: 10 };
const ladder = { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, stock: 3 };
const products = { "products/G1": gloves, "products/SKU1": towels, "products/LAD-1": ladder, "products/rags": { code: "", name: "Rags", price: 1 } };
const echo = { client: "Echo Studio", date: "2026-09-24", createdBy: "u_test", status: "open", items: { SKU1: { code: "SKU1", name: "Paper towels", price: 9, out: 2, returned: 0 } } };
const delta = { client: "Delta Dental", date: "2026-09-25", createdByName: "Sam", status: "open", items: {} };
const adhoc1 = (items, extra = {}) => ({ kind: "adhoc", client: "", date: "2026-09-30", createdBy: "u_test", status: "open", items, ...extra });
const seed = { ...products, "sheets/s1": echo, "sheets/s2": delta };

const ready = (page) => page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });
async function open(page, opts = {}) {
  await openApp(page, { seed, ...opts });
  await ready(page);
}
const doc = (page, path) => page.evaluate((p) => window.__mock.docs.get(p), path);
const toast = (page) => page.locator("#toast");
const card = (page, name) => page.locator("#main .sheet-card", { hasText: name });
const typeCode = async (page, code) => {
  await modal(page).getByPlaceholder("Or type the barcode").fill(code);
  await modal(page).getByPlaceholder("Or type the barcode").press("Enter");
};
async function take(page, code, qty = 1) {
  await page.getByRole("button", { name: "Quick take" }).click();
  await typeCode(page, code);
  for (let i = 1; i < qty; i++) await modal(page).locator("[data-step='1']").click();
  await modal(page).getByRole("button", { name: `Take ${qty}` }).click();
}
const openAdhoc = (page) => card(page, "Ad hoc").click();

test.describe("J14. Take supplies without a job sheet", { tag: ["@J14"] }, () => {
  test("Quick take starts the team's ad hoc sheet, adds to it after, and takes stock down", { tag: ["@J14.1"] }, async ({ page }) => {
    await open(page);
    await take(page, "G1", 2);
    await expect(toast(page)).toHaveText("Took 2 × Nitrile gloves (ad hoc)");
    const sheet = await doc(page, "sheets/adhoc-1");
    expect(sheet).toMatchObject({ kind: "adhoc", client: "", status: "open", createdBy: "u_test", items: { G1: { code: "G1", name: "Nitrile gloves", price: 12.5, cost: 9, out: 2, returned: 0 } } });
    expect(sheet.date).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect((await doc(page, "products/G1")).stock).toBe(48);
    // Its card is above the job sheets, with no money
    await expect(page.locator("#main .sheet-card").first()).toHaveClass(/adhoc/);
    await expect(card(page, "Ad hoc")).toContainText("2 items out");
    await expect(card(page, "Ad hoc")).not.toContainText("$");

    // Again: onto the same sheet, which the form says
    await page.getByRole("button", { name: "Quick take" }).click();
    await typeCode(page, "G1");
    await expect(modal(page).locator("h2")).toHaveText("Quick take");
    await expect(modal(page)).toContainText("Already on the ad hoc sheet");
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    await expect(toast(page)).toHaveText("Took 1 × Nitrile gloves (ad hoc)");
    expect((await doc(page, "sheets/adhoc-1")).items.G1.out).toBe(3);

    // An item without a barcode, from the pick list, and company equipment
    await page.getByRole("button", { name: "Quick take" }).click();
    await modal(page).getByRole("button", { name: "Item without a barcode" }).click();
    await modal(page).locator("[data-k=rags]").click();
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    await expect(toast(page)).toHaveText("Took 1 × Rags (ad hoc)");
    await take(page, "LAD-1");
    expect((await doc(page, "sheets/adhoc-1")).items["LAD-1"]).toMatchObject({ kind: "equipment", out: 1, takenBy: "u_test" });
    await expect(card(page, "Ad hoc")).toContainText("5 items out");
    expect(await doc(page, "sheets/adhoc-2")).toBeUndefined();
  });

  test("a new barcode taken ad hoc is named and priced, and saved to inventory", { tag: ["@J14.1"] }, async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Quick take" }).click();
    await typeCode(page, "NEW-9");
    await modal(page).getByLabel("Item name").fill("Box fan");
    await modal(page).getByLabel("Price each ($)").fill("20");
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    await expect(toast(page)).toHaveText("Took 1 × Box fan (ad hoc)");
    expect(await doc(page, "products/NEW-9")).toMatchObject({ name: "Box fan", price: 20 });
    // A new item that isn't saved to inventory
    await page.getByRole("button", { name: "Quick take" }).click();
    await modal(page).getByRole("button", { name: "Item without a barcode" }).click();
    await modal(page).getByRole("button", { name: "+ New item" }).click();
    await modal(page).getByLabel("Item name").fill("Leftover bins");
    await modal(page).getByLabel("Save to inventory for next time").uncheck();
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    await expect(toast(page)).toHaveText("Took 1 × Leftover bins (ad hoc)");
    const items = Object.values((await doc(page, "sheets/adhoc-1")).items);
    expect(items.map((l) => l.name).sort()).toEqual(["Box fan", "Leftover bins"]);
  });

  test("the ad hoc sheet takes returns but not checkouts, edits or money, and finishes like a job sheet", { tag: ["@J14.4"] }, async ({ page }) => {
    await open(page, { seed: { ...seed, "sheets/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 4, returned: 0 }, "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } }) } });
    await openAdhoc(page);
    await expect(page.locator(".sheet-head h2")).toHaveText("Ad hoc");
    await expect(page.locator(".sheet-head")).toContainText("Since Sep 30, 2026");
    await expect(page.getByRole("button", { name: "Edit details" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(0);
    await expect(page.locator(".mode")).toBeHidden();
    await expect(page.locator("#scanLabel")).toHaveText("Scan to return");
    await expect(page.locator("#sheetBody .totals")).not.toContainText("Charge");
    await expect(page.locator("#sheetBody table").first().locator("thead th")).toHaveText(["Item", "Taken", "Returned", "Used"]);

    // A return, by barcode, says nothing of a charge
    await page.locator("#manualCode").fill("G1");
    await page.locator("#manualCode").press("Enter");
    await expect(modal(page).locator("h2")).toHaveText("Return");
    await expect(modal(page).locator("#sum")).not.toContainText("Charge");
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(toast(page)).toHaveText("1 returned · 1 of 4 back");
    // Something not on it can't be checked out onto it
    await page.locator("#manualCode").fill("SKU1");
    await page.locator("#manualCode").press("Enter");
    await expect(modal(page).locator("h2")).toHaveText("Not on this sheet");
    await expect(modal(page).getByRole("button", { name: "Check it out instead" })).toHaveCount(0);
    await modal(page).getByRole("button", { name: "Return it to Echo Studio, Sep 24, 2026" }).click();
    await expect(modal(page).locator("h2")).toHaveText("Return to Echo Studio, Sep 24, 2026");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // Without a barcode: the sheet's own pick list of returns
    await page.getByRole("button", { name: "Return item without a barcode" }).click();
    await expect(modal(page).locator("[data-k]")).toHaveCount(2);
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // The line editor has no price
    await lineRow(page, "Nitrile gloves").click();
    await expect(modal(page)).toContainText("Taken for no job: not charged.");
    await expect(modal(page).getByLabel("Price each on this sheet ($)")).toHaveCount(0);
    await modal(page).getByLabel("Taken").fill("5");
    await modal(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toHaveText("Saved");
    expect((await doc(page, "sheets/adhoc-1")).items.G1).toMatchObject({ out: 5, returned: 1, price: 12.5 });

    // Finished Return asks about the ladder, with no charge to anyone
    await page.getByRole("button", { name: "Finished Return" }).click();
    await expect(modal(page).locator("fieldset.finish")).toHaveCount(1);
    await modal(page).getByLabel("Lost or broken", { exact: true }).fill("1");
    await modal(page).getByLabel("Lost or broken", { exact: true }).dispatchEvent("input");
    await expect(modal(page).getByLabel(/Charge the client/)).toHaveCount(0);
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("Return finished");
    expect((await doc(page, "sheets/adhoc-1")).items["LAD-1"]).toMatchObject({ lost: 1 });
    expect((await doc(page, "sheets/adhoc-1")).items["LAD-1"]).not.toHaveProperty("lostCharge");

    // Finished: the next take starts adhoc-2, and the finished one is under Returned as "Ad hoc"
    await page.getByRole("button", { name: "Sheets", exact: true }).click();
    await expect(card(page, "Ad hoc")).toHaveCount(0);
    await take(page, "G1");
    await expect(card(page, "Ad hoc")).toContainText("1 item out");
    expect((await doc(page, "sheets/adhoc-2")).items.G1.out).toBe(1);
    await page.getByRole("button", { name: "Returned" }).click();
    await expect(card(page, "Ad hoc")).toContainText("Returned");
    await expect(card(page, "Ad hoc")).not.toContainText("$");
    // Not reopened while adhoc-2 is open
    await card(page, "Ad hoc").click();
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(toast(page)).toHaveText("Another ad hoc sheet is open. Finish it before reopening this one.");
    expect((await doc(page, "sheets/adhoc-1")).status).toBe("closed");
  });

  test("a finished ad hoc sheet reopens when none is open, and takes go on it again", { tag: ["@J14.4"] }, async ({ page }) => {
    await open(page, { seed: { ...seed, "sheets/adhoc-3": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 2, returned: 2 } }, { status: "closed" }) } });
    await page.getByRole("button", { name: "All" }).click();
    await card(page, "Ad hoc").click();
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(toast(page)).toHaveText("Sheet reopened");
    await page.getByRole("button", { name: "Sheets", exact: true }).click();
    await take(page, "G1");
    expect((await doc(page, "sheets/adhoc-3")).items.G1.out).toBe(3);
    // Deleting the open one: the next take starts the one after
    await openAdhoc(page);
    await page.getByRole("button", { name: "Delete sheet" }).click();
    await page.getByRole("button", { name: "Tap again to delete" }).click();
    await expect(toast(page)).toHaveText("Sheet deleted");
    await take(page, "G1");
    expect(await doc(page, "sheets/adhoc-1")).toMatchObject({ kind: "adhoc", items: { G1: { out: 1 } } });
  });

  test("Return on the sheet list finds where the item is out: one sheet, a pick of several (ad hoc first), or none", { tag: ["@J14.2"] }, async ({ page }) => {
    // A finished sheet, and a line bought for a client, aren't returned to
    const bought = { ...echo, items: { ...echo.items, "LAD-1:bought": { code: "LAD-1", name: "Step ladder", price: 150, purchased: true, out: 1, returned: 0 } } };
    const finished = { ...delta, client: "Foxtrot", status: "closed", items: { G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 5, returned: 0 } } };
    await open(page, { seed: { ...seed, "sheets/s1": bought, "sheets/s9": finished, "sheets/adhoc-1": adhoc1({ SKU1: { code: "SKU1", name: "Paper towels", price: 8.5, out: 3, returned: 0 }, G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 2, returned: 0 }, rags: { code: "", name: "Rags", price: 1, out: 4, returned: 0 } }) } });
    // Out on one sheet: its return form, named
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await typeCode(page, "G1");
    await expect(modal(page).locator("h2")).toHaveText("Return to Ad hoc, Sep 30, 2026");
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(toast(page)).toHaveText("1 returned · 1 of 2 back");
    // The sheet it went to opens
    await expect(page.locator(".sheet-head h2")).toHaveText("Ad hoc");
    await page.getByRole("button", { name: "Sheets", exact: true }).click();

    // Out on two: pick one, the ad hoc sheet first
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await typeCode(page, "SKU1");
    await expect(modal(page).locator("h2")).toHaveText("Which sheet?");
    await expect(modal(page).locator("[data-i]")).toHaveText([/Ad hoc.*3 out/, /Echo Studio.*2 out/]);
    await modal(page).locator("[data-i='1']").click();
    await expect(modal(page).locator("h2")).toHaveText("Return to Echo Studio, Sep 24, 2026");
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(toast(page)).toHaveText("1 returned · 1 of 2 back");
    expect((await doc(page, "sheets/s1")).items.SKU1.returned).toBe(1);
    await page.getByRole("button", { name: "Sheets", exact: true }).click();

    // From the pick list, without a barcode
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await expect(modal(page).locator(".pick [data-k]")).toHaveText([/Nitrile gloves/, /Paper towels/, /Rags/]);
    await modal(page).locator(".pick [data-k='G1']").click();
    await expect(modal(page).locator("h2")).toHaveText("Return to Ad hoc, Sep 30, 2026");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await modal(page).locator(".pick [data-k='rags']").click();
    await expect(modal(page).locator(".code")).toHaveText("No barcode");
    await modal(page).getByRole("button", { name: "Cancel" }).click();

    // Out nowhere
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await typeCode(page, "LAD-1");
    await expect(toast(page)).toHaveText("Nothing of this is checked out right now.");
    await expect(page.locator("#overlay")).toBeHidden();
  });

  test("Return with nothing out says so, and a scanned photo works as a typed barcode", { tag: ["@J14.2"] }, async ({ page }) => {
    // The browser's barcode detector, answering window.__code (nothing when it's unset)
    await page.addInitScript(() => {
      window.BarcodeDetector = class { async detect() { return window.__code ? [{ rawValue: window.__code }] : []; } };
      window.createImageBitmap = async () => Object.assign(document.createElement("canvas"), { width: 10, height: 10 });
    });
    await open(page, { seed: products });
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await expect(modal(page)).toContainText("Nothing is checked out right now.");
    // A photo that isn't a barcode finds nothing, and the form stays
    await modal(page).locator("#qScan").setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
    await expect(modal(page).locator("h2")).toHaveText("Return");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Quick take" }).click();
    await modal(page).locator("#qScan").setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
    // An empty barcode does nothing
    await modal(page).getByPlaceholder("Or type the barcode").press("Enter");
    await expect(modal(page).locator("h2")).toHaveText("Quick take");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // No open sheets at all: no ad hoc card, and the empty list
    await expect(page.locator("#main .list")).toContainText("Nothing is checked out right now.");
    // A barcode photo: the item's quick take form
    await page.evaluate(() => { window.__code = "G1"; });
    await page.getByRole("button", { name: "Quick take" }).click();
    await modal(page).locator("#qScan").setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("photo") });
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    // Only the ad hoc sheet is out: its card, and no empty message
    await expect(card(page, "Ad hoc")).toContainText("1 item out");
    await expect(page.locator("#main .list .empty")).toHaveCount(0);
  });

  test("a job sheet's \"Not on this sheet\" offers to return it where it's out", { tag: ["@J14.2"] }, async ({ page }) => {
    await open(page, { seed: { ...seed, "sheets/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 2, returned: 0 }, SKU1: { code: "SKU1", name: "Paper towels", price: 8.5, out: 1, returned: 0 } }) } });
    await card(page, "Delta Dental").click();
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await page.locator("#manualCode").fill("G1");
    await page.locator("#manualCode").press("Enter");
    await expect(modal(page)).toContainText("It's out on another sheet.");
    await modal(page).getByRole("button", { name: "Return it to Ad hoc, Sep 30, 2026" }).click();
    await modal(page).getByRole("button", { name: "Save return" }).click();
    await expect(toast(page)).toHaveText("1 returned · 1 of 2 back");
    await expect(page.locator(".sheet-head h2")).toHaveText("Ad hoc");
    // Out on two others: a pick list
    await page.getByRole("button", { name: "← All sheets" }).click();
    await card(page, "Delta Dental").click();
    await page.locator("#manualCode").fill("SKU1");
    await page.locator("#manualCode").press("Enter");
    await modal(page).getByRole("button", { name: "Return it from another sheet" }).click();
    await expect(modal(page).locator("[data-i]")).toHaveCount(2);
    await modal(page).locator("[data-i='0']").click();
    await expect(modal(page).locator("h2")).toHaveText("Return to Ad hoc, Sep 30, 2026");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // Out nowhere else: only checking it out
    await page.locator("#manualCode").fill("LAD-1");
    await page.locator("#manualCode").press("Enter");
    await expect(modal(page)).not.toContainText("It's out on another sheet.");
    await modal(page).getByRole("button", { name: "Check it out instead" }).click();
    await expect(modal(page).locator("h2")).toHaveText("Check out");
  });

  test("moves an ad hoc line to a job sheet, whole, at the price it was taken at, without moving stock", { tag: ["@J14.3"] }, async ({ page }) => {
    const s1 = { ...echo, items: { ...echo.items, "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } };
    await open(page, { seed: { ...seed, "sheets/s1": s1, "sheets/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 11, cost: 9, out: 3, returned: 1 }, SKU1: { code: "SKU1", name: "Paper towels", price: 8, out: 2, returned: 0 }, "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 2, returned: 0, lost: 1, takenBy: "u_test" } }) } });
    await openAdhoc(page);
    await lineRow(page, "Nitrile gloves").click();
    await expect(modal(page).getByLabel("Job sheet").locator("option")).toHaveText(["Delta Dental, Sep 25, 2026", "Echo Studio, Sep 24, 2026"]);
    await modal(page).getByLabel("Job sheet").selectOption("s2");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Moved to Delta Dental");
    // Gone from the ad hoc sheet, kept as a hidden marker, and on the job sheet as it was
    await expect(lineRow(page, "Nitrile gloves")).toHaveCount(0);
    expect((await doc(page, "sheets/adhoc-1")).items.G1).toMatchObject({ moved: "s2", out: 0 });
    expect((await doc(page, "sheets/s2")).items.G1).toMatchObject({ code: "G1", name: "Nitrile gloves", price: 11, cost: 9, out: 3, returned: 1 });
    expect((await doc(page, "products/G1")).stock).toBe(50);
    // Onto a line the job sheet already has: the counts add, its price stays
    await lineRow(page, "Paper towels").click();
    await modal(page).getByLabel("Job sheet").selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Moved to Echo Studio");
    expect((await doc(page, "sheets/s1")).items.SKU1).toMatchObject({ price: 9, out: 4, returned: 0 });
    // Equipment, with what was lost
    await page.locator("#sheetBody table.equipment tbody tr", { hasText: "Step ladder" }).click();
    await modal(page).getByLabel("Job sheet").selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Moved to Echo Studio");
    expect((await doc(page, "sheets/s1")).items["LAD-1"]).toMatchObject({ kind: "equipment", out: 3, returned: 0, lost: 1 });
    await expect(page.locator("#sheetBody")).toContainText("Nothing on the ad hoc sheet.");
    // The exports leave the markers out, and name the ad hoc sheet
    await page.getByRole("button", { name: "Sheets", exact: true }).click();
    await page.getByRole("button", { name: "Export data" }).click();
    await modal(page).getByRole("button", { name: "Everything (JSON)" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    const all = JSON.parse(await page.evaluate(() => window.__mock.saves[0].data));
    expect(all.sheets.find((s) => s.id === "adhoc-1").items).toEqual({});
    await modal(page).getByRole("button", { name: "Sheets (CSV)" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(2);
    expect(await page.evaluate(() => window.__mock.saves[1].data)).toContain("Ad hoc,2026-09-30");
    // A line taken again after it moved starts afresh
    await modal(page).getByRole("button", { name: "Close" }).click();
    await take(page, "G1");
    expect((await doc(page, "sheets/adhoc-1")).items.G1).toMatchObject({ out: 1, returned: 0, lost: 0, moved: false });
    await openAdhoc(page);
    await expect(lineRow(page, "Nitrile gloves").locator("td").nth(1)).toHaveText("1");
  });

  test("a retried move counts once, and a move the job sheet can't take is refused", { tag: ["@J14.3"] }, async ({ page }) => {
    const s1 = { ...echo, items: { ...echo.items, "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } };
    await open(page, { seed: { ...seed, "sheets/s1": s1, "sheets/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 11, out: 3, returned: 0 }, "LAD-1": { code: "LAD-1", name: "Step ladder", price: 4, out: 1, returned: 0 } }) } });
    await openAdhoc(page);
    // The job sheet saves, then the ad hoc sheet's write fails: Try again finishes it, once
    await page.evaluate(() => { window.__mock.failWrites = { prefix: "sheets/adhoc-1", code: "unavailable" }; });
    await lineRow(page, "Nitrile gloves").click();
    await modal(page).getByLabel("Job sheet").selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
    expect((await doc(page, "sheets/s1")).items.G1.out).toBe(3);
    // Then the ad hoc sheet saves, but the answer is lost: Try again finds the move done
    await page.evaluate(() => { window.__mock.failWrites = null; window.__mock.loseWrites = "sheets/adhoc-1"; });
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
    await page.evaluate(() => { window.__mock.loseWrites = null; });
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Moved to Echo Studio");
    expect((await doc(page, "sheets/s1")).items.G1.out).toBe(3);
    expect((await doc(page, "sheets/adhoc-1")).items.G1.moved).toBe("s1");

    // A supply where the job sheet has the item as equipment
    await lineRow(page, "Step ladder").click();
    await modal(page).getByLabel("Job sheet").selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("That sheet has this item as the other kind (a supply, or company equipment), so it wasn't moved. Correct the lines by hand.");
    // Someone else moved it meanwhile
    await page.evaluate(() => { window.__mock.docs.get("sheets/adhoc-1").items["LAD-1"].moved = "s2"; });
    await lineRow(page, "Step ladder").click();
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Someone else moved or removed this line, so it wasn't moved.");
  });

  test("a move says when there's no job sheet to move to, or the job sheet is gone", async ({ page }) => {
    await open(page, { seed: { ...products, "sheets/s2": delta, "sheets/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 11, out: 3, returned: 0 } }) } });
    await openAdhoc(page);
    await lineRow(page, "Nitrile gloves").click();
    // Delta Dental is deleted meanwhile, without this page hearing
    await page.evaluate(() => { window.__mock.docs.delete("sheets/s2"); });
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Someone else deleted this sheet, so your change wasn't saved.");
    await page.evaluate(() => window.__mock.notify());
    await lineRow(page, "Nitrile gloves").click();
    await expect(modal(page)).toContainText("There's no open job sheet to move it to.");
    await expect(modal(page).getByRole("button", { name: "Move", exact: true })).toHaveCount(0);
  });

  test("two first takes at once end on one sheet: a line another page's set wiped is written again", { tag: ["@J14.1"] }, async ({ page }) => {
    await open(page);
    // The storage count waits, so another person's first take can land meanwhile
    await page.evaluate(() => window.__mock.hold("products/"));
    await page.getByRole("button", { name: "Quick take" }).click();
    await typeCode(page, "G1");
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    await expect.poll(async () => (await doc(page, "sheets/adhoc-1"))?.items?.G1?.out).toBe(1);
    // Theirs read no sheet, so its set replaces this one's, line and all, then adds its own line
    await page.evaluate(() => {
      window.__mock.docs.set("sheets/adhoc-1", { kind: "adhoc", client: "", date: "2026-09-30", status: "open", createdByName: "Sam", items: { SKU1: { code: "SKU1", name: "Paper towels", price: 8.5, out: 2, returned: 0 } } });
      window.__mock.release();
    });
    await expect(toast(page)).toHaveText("Took 1 × Nitrile gloves (ad hoc)");
    const items = (await doc(page, "sheets/adhoc-1")).items;
    expect(items.SKU1.out).toBe(2);
    expect(items.G1.out).toBe(1);
    // The storage count went down once
    expect((await doc(page, "products/G1")).stock).toBe(49);
  });

  test("a take onto an ad hoc sheet someone finished meanwhile starts the next one", { tag: ["@J14.1"] }, async ({ page }) => {
    await open(page, { seed: { ...seed, "sheets/adhoc-1": adhoc1({}) } });
    await expect(card(page, "Ad hoc")).toContainText("0 items out");
    await page.evaluate(() => { window.__mock.docs.get("sheets/adhoc-1").status = "closed"; });
    await take(page, "G1");
    expect((await doc(page, "sheets/adhoc-2")).items.G1.out).toBe(1);
    expect((await doc(page, "sheets/adhoc-1")).items).toEqual({});
  });

  test("receipts list job sheets only, and Inventory's Out view names the ad hoc sheet", async ({ page }) => {
    const draft = { store: "", receiptDate: "2026-09-30", date: "2026-09-30", savePrices: true, by: "", dests: [{ id: "d1", sheetId: "", client: "" }], lines: [{ id: "l1", name: "Tape", raw: "", qty: 1, price: 2, dest: "d1", code: "", match: "", suggested: false, useName: "inv", usePrice: "", perEach: false }] };
    await page.addInitScript((d) => localStorage.setItem("supplyCheckout.receiptDraft", JSON.stringify(d)), draft);
    await open(page, { seed: { ...seed, "sheets/adhoc-1": adhoc1({ "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } }) } });
    await page.getByRole("button", { name: "Inventory" }).click();
    await page.getByRole("button", { name: "Equipment", exact: true }).click();
    await page.getByRole("button", { name: "Out on jobs" }).click();
    await expect(page.locator("#main table.out tbody tr")).toContainText("Ad hoc");
    await page.getByRole("button", { name: "Sheets", exact: true }).click();
    await page.getByRole("button", { name: "Continue review" }).click();
    await expect(page.locator("#rBody [data-dsel] option")).toHaveText(["New sheet", "Add to Delta Dental (Sep 25, 2026)", "Add to Echo Studio (Sep 24, 2026)"]);
  });
});

test.describe("the web build's quick take and move commands", { tag: ["@J14"] }, () => {
  test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");
  const docs = () => Object.fromEntries(Object.entries(seed).map(([k, v]) => [`t1/${k}`, v]));

  test("Quick take goes on the sheet the server picks, and a retry is applied once", { tag: ["@J14.1"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: docs() });
    await openAws(page, backend);
    await connected(page);
    // The first answer is lost: the same operation again, which the server replays
    backend.on("POST", "/teams/t1/adhoc/checkout", { lost: true });
    await take(page, "G1", 2);
    await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Took 2 × Nitrile gloves (ad hoc)");
    const sent = backend.requests("POST", "/teams/t1/adhoc/checkout").map((r) => r.body);
    expect(sent).toEqual([expect.objectContaining({ productKey: "G1", quantity: 2, date: expect.stringMatching(/^\d{4}-/) }), sent[0]]);
    expect(backend.doc("t1", "sheets", "adhoc-1").data).toMatchObject({ kind: "adhoc", items: { G1: { out: 2 } } });
    expect(backend.doc("t1", "products", "G1").data.stock).toBe(48);
    await expect(card(page, "Ad hoc")).toContainText("2 items out");
    // Busy once on the server: sent again, as it is
    backend.on("POST", "/teams/t1/adhoc/checkout", { status: 409, body: { error: { code: "aborted", message: "busy" } } });
    await take(page, "G1");
    await expect(toast(page)).toHaveText("Took 1 × Nitrile gloves (ad hoc)");
    expect(backend.doc("t1", "sheets", "adhoc-1").data.items.G1.out).toBe(3);
    // Refused: the server's message
    backend.on("POST", "/teams/t1/adhoc/checkout", { status: 400, body: { error: { code: "bad_request", message: "Invalid product key" } } });
    await take(page, "G1");
    await expect(toast(page)).toHaveText("Invalid product key. The latest is showing.");
    // Busy twice: someone else's change
    backend.on("POST", "/teams/t1/adhoc/checkout", { status: 409, body: { error: { code: "aborted", message: "busy" } } }, 2);
    await take(page, "G1");
    await expect(toast(page)).toHaveText(/Someone else changed this just now/);
  });

  test("a move is one command, applied once when retried, and refusals show the server's message", { tag: ["@J14.3"] }, async ({ page }) => {
    const all = docs();
    all["t1/sheets/adhoc-1"] = adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 11, out: 3, returned: 1 }, SKU1: { code: "SKU1", name: "Paper towels", price: 8, out: 1, returned: 0 }, rope: { code: "", name: "Rope", price: 2, out: 1, returned: 0 } });
    const backend = new FakeBackend({ docs: all });
    await openAws(page, backend);
    await connected(page);
    await openAdhoc(page);
    backend.on("POST", "/teams/t1/sheets/adhoc-1/move", { lost: true });
    await lineRow(page, "Nitrile gloves").click();
    await modal(page).getByLabel("Job sheet").selectOption("s2");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Moved to Delta Dental");
    const sent = backend.requests("POST", "/teams/t1/sheets/adhoc-1/move").map((r) => r.body);
    expect(sent).toEqual([{ operationId: expect.any(String), productKey: "G1", toSheetId: "s2" }, sent[0]]);
    expect(backend.doc("t1", "sheets", "s2").data.items.G1).toMatchObject({ price: 11, out: 3, returned: 1 });
    expect(backend.doc("t1", "sheets", "adhoc-1").data.items).not.toHaveProperty("G1");
    await expect(lineRow(page, "Nitrile gloves")).toHaveCount(0);
    // Busy once: sent again
    backend.on("POST", "/teams/t1/sheets/adhoc-1/move", { status: 409, body: { error: { code: "aborted", message: "busy" } } });
    await lineRow(page, "Paper towels").click();
    await modal(page).getByLabel("Job sheet").selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Moved to Echo Studio");
    expect(backend.doc("t1", "sheets", "s1").data.items.SKU1).toMatchObject({ price: 9, out: 3 });
    // Refused by the server: its message, with the latest showing
    backend.on("POST", "/teams/t1/sheets/adhoc-1/move", { status: 400, body: { error: { code: "bad_request", message: "The job sheet has this item as a supply; correct the lines by hand" } } });
    await lineRow(page, "Rope").click();
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("The job sheet has this item as a supply; correct the lines by hand. The latest is showing.");
    backend.on("POST", "/teams/t1/sheets/adhoc-1/move", { status: 409, body: { error: { code: "aborted", message: "busy" } } }, 2);
    await lineRow(page, "Rope").click();
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText(/Someone else changed this just now/);
  });

  test("the server refuses to reopen an ad hoc sheet while another is open", { tag: ["@J14.4"] }, async ({ page }) => {
    const all = docs();
    all["t1/sheets/adhoc-1"] = adhoc1({}, { status: "closed" });
    const backend = new FakeBackend({ docs: all });
    await openAws(page, backend);
    await connected(page);
    // Someone else started adhoc-2, and this page hasn't heard
    backend.write("t1", "sheets", "adhoc-2", adhoc1({}));
    await page.getByRole("button", { name: "Returned" }).click();
    await card(page, "Ad hoc").click();
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(toast(page)).toHaveText("Another ad hoc sheet is open. Finish it before reopening this one.");
    expect(backend.doc("t1", "sheets", "adhoc-1").data.status).toBe("closed");
    // The server refuses a checkout onto the ad hoc sheet too
    expect(backend.command("t1", "adhoc-2", "checkout", { operationId: "0f8fad5b-d9cb-469f-a165-70867728950e", productKey: "G1", quantity: 1 })[0]).toBe(400);
  });
});
