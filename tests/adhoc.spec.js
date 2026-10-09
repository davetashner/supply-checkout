// The ad hoc checkout (ADR 0017, sections 4 to 6): Quick take onto the team's General Use project, its
// card and screen, Return from the project list, a client project's "Not on this project" offering where
// the item is out, moving an ad hoc line to a client project, and finishing the General Use project. Against
// the mock runtime (tests/mock-claude.js, with the commands in the page), then the web build's
// commands against tests/fake-aws.js.
import { test, expect, openApp } from "./helpers.js";
import { modal, waitUntilConnected, goToInventory, startReturn, saveReturn, finishReturn, lineRow, continueReview } from "./ui/index.js";
import { FakeBackend, openAws, connected } from "./fake-aws.js";

const gloves = { code: "G1", name: "Nitrile gloves", price: 12.5, cost: 9, stock: 50 };
const towels = { code: "SKU1", name: "Paper towels", price: 8.5, stock: 10 };
const ladder = { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, stock: 3 };
const products = { "products/G1": gloves, "products/SKU1": towels, "products/LAD-1": ladder, "products/rags": { code: "", name: "Rags", price: 1 } };
const echo = { client: "Echo Studio", date: "2026-09-24", createdBy: "u_test", status: "open", items: { SKU1: { code: "SKU1", name: "Paper towels", price: 9, out: 2, returned: 0 } } };
const delta = { client: "Delta Dental", date: "2026-09-25", createdByName: "Sam", status: "open", items: {} };
const adhoc1 = (items, extra = {}) => ({ kind: "adhoc", client: "", date: "2026-09-30", createdBy: "u_test", status: "open", items, ...extra });
const seed = { ...products, "projects/s1": echo, "projects/s2": delta };

const ready = waitUntilConnected;
async function open(page, opts = {}) {
  await openApp(page, { seed, ...opts });
  await ready(page);
}
const doc = (page, path) => page.evaluate((p) => window.__mock.docs.get(p), path);
const toast = (page) => page.locator("#toast");
const card = (page, name) => page.locator("#main .project-card", { hasText: name });
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
const openAdhoc = (page) => card(page, "General Use (no job)").click();

test.describe("J14. Take supplies without a job", { tag: ["@J14"] }, () => {
  test("Quick take starts the team's General Use project, adds to it after, and takes stock down", { tag: ["@J14.1"] }, async ({ page }) => {
    await open(page);
    await take(page, "G1", 2);
    await expect(toast(page)).toHaveText("Took 2 × Nitrile gloves (General Use)");
    const project = await doc(page, "projects/adhoc-1");
    expect(project).toMatchObject({ kind: "adhoc", client: "", status: "open", createdBy: "u_test", items: { G1: { code: "G1", name: "Nitrile gloves", price: 12.5, cost: 9, out: 2, returned: 0 } } });
    expect(project.date).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect((await doc(page, "products/G1")).stock).toBe(48);
    // Its card is above the client projects, with no money
    await expect(page.locator("#main .project-card").first()).toHaveClass(/adhoc/);
    await expect(card(page, "General Use (no job)")).toContainText("2 items out");
    await expect(card(page, "General Use (no job)")).not.toContainText("$");

    // Again: onto the same project, which the form says
    await page.getByRole("button", { name: "Quick take" }).click();
    await typeCode(page, "G1");
    await expect(modal(page).locator("h2")).toHaveText("Quick take");
    await expect(modal(page)).toContainText("Already on General Use");
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    await expect(toast(page)).toHaveText("Took 1 × Nitrile gloves (General Use)");
    expect((await doc(page, "projects/adhoc-1")).items.G1.out).toBe(3);

    // An item without a barcode, from the pick list, and company equipment
    await page.getByRole("button", { name: "Quick take" }).click();
    await modal(page).getByRole("button", { name: "Item without a barcode" }).click();
    await modal(page).locator("[data-k=rags]").click();
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    await expect(toast(page)).toHaveText("Took 1 × Rags (General Use)");
    await take(page, "LAD-1");
    expect((await doc(page, "projects/adhoc-1")).items["LAD-1"]).toMatchObject({ kind: "equipment", out: 1, takenBy: "u_test" });
    await expect(card(page, "General Use (no job)")).toContainText("5 items out");
    expect(await doc(page, "projects/adhoc-2")).toBeUndefined();
  });

  test("a new barcode taken ad hoc is named and priced, and saved to inventory", { tag: ["@J14.1"] }, async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Quick take" }).click();
    await typeCode(page, "NEW-9");
    await modal(page).getByLabel("Item name").fill("Box fan");
    await modal(page).getByLabel("Price each ($)").fill("20");
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    await expect(toast(page)).toHaveText("Took 1 × Box fan (General Use)");
    expect(await doc(page, "products/NEW-9")).toMatchObject({ name: "Box fan", price: 20 });
    // A new item that isn't saved to inventory
    await page.getByRole("button", { name: "Quick take" }).click();
    await modal(page).getByRole("button", { name: "Item without a barcode" }).click();
    await modal(page).getByRole("button", { name: "+ New item" }).click();
    await modal(page).getByLabel("Item name").fill("Leftover bins");
    await modal(page).getByLabel("Save to inventory for next time").uncheck();
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    await expect(toast(page)).toHaveText("Took 1 × Leftover bins (General Use)");
    const items = Object.values((await doc(page, "projects/adhoc-1")).items);
    expect(items.map((l) => l.name).sort()).toEqual(["Box fan", "Leftover bins"]);
  });

  test("the General Use project takes returns but not checkouts, edits or money, and finishes like a client project", { tag: ["@J14.4"] }, async ({ page }) => {
    await open(page, { seed: { ...seed, "projects/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 4, returned: 0 }, "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } }) } });
    await openAdhoc(page);
    await expect(page.locator(".project-head h2")).toHaveText("General Use (no job)");
    await expect(page.locator(".project-head")).toContainText("Since Sep 30, 2026");
    await expect(page.getByRole("button", { name: "Edit details" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(0);
    await expect(page.locator(".mode")).toBeHidden();
    await expect(page.locator("#scanLabel")).toHaveText("Scan to return");
    await expect(page.locator("#projectBody .totals")).not.toContainText("Charge");
    await expect(page.locator("#projectBody table").first().locator("thead th")).toHaveText(["Item", "Taken", "Returned", "Used"]);

    // A return, by barcode, says nothing of a charge
    await page.locator("#manualCode").fill("G1");
    await page.locator("#manualCode").press("Enter");
    await expect(modal(page).locator("h2")).toHaveText("Return");
    await expect(modal(page).locator("#sum")).not.toContainText("Charge");
    await saveReturn(page);
    await expect(toast(page)).toHaveText("1 returned · 1 of 4 back");
    // Something not on it can't be checked out onto it
    await page.locator("#manualCode").fill("SKU1");
    await page.locator("#manualCode").press("Enter");
    await expect(modal(page).locator("h2")).toHaveText("Not on this project");
    await expect(modal(page).getByRole("button", { name: "Check it out instead" })).toHaveCount(0);
    await modal(page).getByRole("button", { name: "Return it to Echo Studio, Sep 24, 2026" }).click();
    await expect(modal(page).locator("h2")).toHaveText("Return to Echo Studio, Sep 24, 2026");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // Without a barcode: the project's own pick list of returns
    await page.getByRole("button", { name: "Return item without a barcode" }).click();
    await expect(modal(page).locator("[data-k]")).toHaveCount(2);
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // The line editor has no price
    await lineRow(page, "Nitrile gloves").click();
    await expect(modal(page)).toContainText("Taken for no job: not charged.");
    await expect(modal(page).getByLabel("Price each on this project ($)")).toHaveCount(0);
    await modal(page).getByLabel("Taken").fill("5");
    await modal(page).getByRole("button", { name: "Save", exact: true }).click();
    await expect(toast(page)).toHaveText("Saved");
    expect((await doc(page, "projects/adhoc-1")).items.G1).toMatchObject({ out: 5, returned: 1, price: 12.5 });

    // Finished Return asks about the ladder, with no charge to anyone
    await finishReturn(page);
    await expect(modal(page).locator("fieldset.finish")).toHaveCount(1);
    await modal(page).getByLabel("Lost or broken", { exact: true }).fill("1");
    await modal(page).getByLabel("Lost or broken", { exact: true }).dispatchEvent("input");
    await expect(modal(page).getByLabel(/Charge the client/)).toHaveCount(0);
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page)).toHaveText("Return finished");
    expect((await doc(page, "projects/adhoc-1")).items["LAD-1"]).toMatchObject({ lost: 1 });
    expect((await doc(page, "projects/adhoc-1")).items["LAD-1"]).not.toHaveProperty("lostCharge");

    // Finished: the next take starts adhoc-2, and the finished one is under Returned as "General Use (no job)"
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(card(page, "General Use (no job)")).toHaveCount(0);
    await take(page, "G1");
    await expect(card(page, "General Use (no job)")).toContainText("1 item out");
    expect((await doc(page, "projects/adhoc-2")).items.G1.out).toBe(1);
    await page.getByRole("button", { name: "Returned" }).click();
    await expect(card(page, "General Use (no job)")).toContainText("Returned");
    await expect(card(page, "General Use (no job)")).not.toContainText("$");
    // Not reopened while adhoc-2 is open
    await card(page, "General Use (no job)").click();
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(toast(page)).toHaveText("Another General Use project is open. Finish it before reopening this one.");
    expect((await doc(page, "projects/adhoc-1")).status).toBe("closed");
  });

  test("a finished General Use project reopens when none is open, and takes go on it again", { tag: ["@J14.4"] }, async ({ page }) => {
    await open(page, { seed: { ...seed, "projects/adhoc-3": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 2, returned: 2 } }, { status: "closed" }) } });
    await page.getByRole("button", { name: "All" }).click();
    await card(page, "General Use (no job)").click();
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(toast(page)).toHaveText("Project reopened");
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await take(page, "G1");
    expect((await doc(page, "projects/adhoc-3")).items.G1.out).toBe(3);
    // Deleting the open one: the next take starts the one after
    await openAdhoc(page);
    await page.getByRole("button", { name: "Delete project" }).click();
    await page.getByRole("button", { name: "Tap again to delete" }).click();
    await expect(toast(page)).toHaveText("Project deleted");
    await take(page, "G1");
    expect(await doc(page, "projects/adhoc-1")).toMatchObject({ kind: "adhoc", items: { G1: { out: 1 } } });
  });

  test("Return on the project list finds where the item is out: one project, a pick of several (ad hoc first), or none", { tag: ["@J14.2"] }, async ({ page }) => {
    // A finished project, and a line bought for a client, aren't returned to
    const bought = { ...echo, items: { ...echo.items, "LAD-1:bought": { code: "LAD-1", name: "Step ladder", price: 150, purchased: true, out: 1, returned: 0 } } };
    const finished = { ...delta, client: "Foxtrot", status: "closed", items: { G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 5, returned: 0 } } };
    await open(page, { seed: { ...seed, "projects/s1": bought, "projects/s9": finished, "projects/adhoc-1": adhoc1({ SKU1: { code: "SKU1", name: "Paper towels", price: 8.5, out: 3, returned: 0 }, G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 2, returned: 0 }, rags: { code: "", name: "Rags", price: 1, out: 4, returned: 0 } }) } });
    // Out on one project: its return form, named
    await startReturn(page);
    await typeCode(page, "G1");
    await expect(modal(page).locator("h2")).toHaveText("Return to General Use (no job), Sep 30, 2026");
    await saveReturn(page);
    await expect(toast(page)).toHaveText("1 returned · 1 of 2 back");
    // The project it went to opens
    await expect(page.locator(".project-head h2")).toHaveText("General Use (no job)");
    await page.getByRole("button", { name: "Projects", exact: true }).click();

    // Out on two: pick one, the General Use project first
    await startReturn(page);
    await typeCode(page, "SKU1");
    await expect(modal(page).locator("h2")).toHaveText("Which project?");
    await expect(modal(page).locator("[data-i]")).toHaveText([/General Use \(no job\).*3 out/, /Echo Studio.*2 out/]);
    await modal(page).locator("[data-i='1']").click();
    await expect(modal(page).locator("h2")).toHaveText("Return to Echo Studio, Sep 24, 2026");
    await saveReturn(page);
    await expect(toast(page)).toHaveText("1 returned · 1 of 2 back");
    expect((await doc(page, "projects/s1")).items.SKU1.returned).toBe(1);
    await page.getByRole("button", { name: "Projects", exact: true }).click();

    // From the pick list, without a barcode
    await startReturn(page);
    await expect(modal(page).locator(".pick [data-k]")).toHaveText([/Nitrile gloves/, /Paper towels/, /Rags/]);
    await modal(page).locator(".pick [data-k='G1']").click();
    await expect(modal(page).locator("h2")).toHaveText("Return to General Use (no job), Sep 30, 2026");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    await startReturn(page);
    await modal(page).locator(".pick [data-k='rags']").click();
    await expect(modal(page).locator(".code")).toHaveText("No barcode");
    await modal(page).getByRole("button", { name: "Cancel" }).click();

    // Out nowhere
    await startReturn(page);
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
    await startReturn(page);
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
    // No open projects at all: no ad hoc card, and the empty list
    await expect(page.locator("#main .list")).toContainText("Nothing is checked out right now.");
    // A barcode photo: the item's quick take form
    await page.evaluate(() => { window.__code = "G1"; });
    await page.getByRole("button", { name: "Quick take" }).click();
    await modal(page).locator("#qScan").setInputFiles({ name: "x.png", mimeType: "image/png", buffer: Buffer.from("photo") });
    await modal(page).getByRole("button", { name: "Take 1" }).click();
    // Only the General Use project is out: its card, and no empty message
    await expect(card(page, "General Use (no job)")).toContainText("1 item out");
    await expect(page.locator("#main .list .empty")).toHaveCount(0);
  });

  test("a client project's \"Not on this project\" offers to return it where it's out", { tag: ["@J14.2"] }, async ({ page }) => {
    await open(page, { seed: { ...seed, "projects/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 2, returned: 0 }, SKU1: { code: "SKU1", name: "Paper towels", price: 8.5, out: 1, returned: 0 } }) } });
    await card(page, "Delta Dental").click();
    await startReturn(page);
    await page.locator("#manualCode").fill("G1");
    await page.locator("#manualCode").press("Enter");
    await expect(modal(page)).toContainText("It's out on another project.");
    await modal(page).getByRole("button", { name: "Return it to General Use (no job), Sep 30, 2026" }).click();
    await saveReturn(page);
    await expect(toast(page)).toHaveText("1 returned · 1 of 2 back");
    await expect(page.locator(".project-head h2")).toHaveText("General Use (no job)");
    // Out on two others: a pick list
    await page.getByRole("button", { name: "← All projects" }).click();
    await card(page, "Delta Dental").click();
    await page.locator("#manualCode").fill("SKU1");
    await page.locator("#manualCode").press("Enter");
    await modal(page).getByRole("button", { name: "Return it from another project" }).click();
    await expect(modal(page).locator("[data-i]")).toHaveCount(2);
    await modal(page).locator("[data-i='0']").click();
    await expect(modal(page).locator("h2")).toHaveText("Return to General Use (no job), Sep 30, 2026");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // Out nowhere else: only checking it out
    await page.locator("#manualCode").fill("LAD-1");
    await page.locator("#manualCode").press("Enter");
    await expect(modal(page)).not.toContainText("It's out on another project.");
    await modal(page).getByRole("button", { name: "Check it out instead" }).click();
    await expect(modal(page).locator("h2")).toHaveText("Check out");
  });

  test("moves an ad hoc line to a client project, whole, at the price it was taken at, without moving stock", { tag: ["@J14.3"] }, async ({ page }) => {
    const s1 = { ...echo, items: { ...echo.items, "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } };
    await open(page, { seed: { ...seed, "projects/s1": s1, "projects/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 11, cost: 9, out: 3, returned: 1 }, SKU1: { code: "SKU1", name: "Paper towels", price: 8, out: 2, returned: 0 }, "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 2, returned: 0, lost: 1, takenBy: "u_test" } }) } });
    await openAdhoc(page);
    await lineRow(page, "Nitrile gloves").click();
    await expect(modal(page).getByLabel("Project", { exact: true }).locator("option")).toHaveText(["Delta Dental, Sep 25, 2026", "Echo Studio, Sep 24, 2026"]);
    await modal(page).getByLabel("Project", { exact: true }).selectOption("s2");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Moved to Delta Dental");
    // Gone from the General Use project, and on the client project as it was
    await expect(lineRow(page, "Nitrile gloves")).toHaveCount(0);
    expect((await doc(page, "projects/adhoc-1")).items).not.toHaveProperty("G1");
    expect((await doc(page, "projects/s2")).items.G1).toMatchObject({ code: "G1", name: "Nitrile gloves", price: 11, cost: 9, out: 3, returned: 1 });
    expect((await doc(page, "products/G1")).stock).toBe(50);
    // Onto a line the client project already has: the counts add, its price stays
    await lineRow(page, "Paper towels").click();
    await modal(page).getByLabel("Project", { exact: true }).selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Moved to Echo Studio");
    expect((await doc(page, "projects/s1")).items.SKU1).toMatchObject({ price: 9, out: 4, returned: 0 });
    // Equipment, with what was lost
    await page.locator("#projectBody table.equipment tbody tr", { hasText: "Step ladder" }).click();
    await modal(page).getByLabel("Project", { exact: true }).selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Moved to Echo Studio");
    expect((await doc(page, "projects/s1")).items["LAD-1"]).toMatchObject({ kind: "equipment", out: 3, returned: 0, lost: 1 });
    await expect(page.locator("#projectBody")).toContainText("Nothing on General Use yet.");
    // The exports name the General Use project
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await page.getByRole("button", { name: "Export data" }).click();
    await modal(page).getByRole("button", { name: "Everything (JSON)" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    const all = JSON.parse(await page.evaluate(() => window.__mock.saves[0].data));
    expect(all.projects.find((s) => s.id === "adhoc-1").items).toEqual({});
    await modal(page).getByRole("button", { name: "Projects (CSV)" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(2);
    expect(await page.evaluate(() => window.__mock.saves[1].data)).toContain("General Use (no job),2026-09-30");
    // A line taken again after it moved starts afresh
    await modal(page).getByRole("button", { name: "Close" }).click();
    await take(page, "G1");
    expect((await doc(page, "projects/adhoc-1")).items.G1).toEqual(expect.objectContaining({ out: 1, returned: 0 }));
    await openAdhoc(page);
    await expect(lineRow(page, "Nitrile gloves").locator("td").nth(1)).toHaveText("1");
  });

  test("a retried move counts once, and a move the client project can't take is refused", { tag: ["@J14.3"] }, async ({ page }) => {
    const s1 = { ...echo, items: { ...echo.items, "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } } };
    await open(page, { seed: { ...seed, "projects/s1": s1, "projects/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 11, out: 3, returned: 0 }, "LAD-1": { code: "LAD-1", name: "Step ladder", price: 4, out: 1, returned: 0 } }) } });
    await openAdhoc(page);
    // Not saved, then saved with the answer lost: Try again finds the move done
    await page.evaluate(() => { window.__mock.failWrites = { prefix: "projects/adhoc-1", code: "unavailable" }; });
    await lineRow(page, "Nitrile gloves").click();
    await modal(page).getByLabel("Project", { exact: true }).selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
    expect((await doc(page, "projects/s1")).items).not.toHaveProperty("G1");
    await page.evaluate(() => { window.__mock.failWrites = null; window.__mock.loseWrites = "projects/adhoc-1"; });
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
    expect((await doc(page, "projects/s1")).items.G1.out).toBe(3);
    await page.evaluate(() => { window.__mock.loseWrites = null; });
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Moved to Echo Studio");
    expect((await doc(page, "projects/s1")).items.G1.out).toBe(3);
    expect((await doc(page, "projects/adhoc-1")).items).not.toHaveProperty("G1");

    // A supply where the client project has the item as equipment
    await lineRow(page, "Step ladder").click();
    await modal(page).getByLabel("Project", { exact: true }).selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("The project has this item as company equipment; correct the lines by hand. The latest is showing.");
  });

  test("a move says when there's no client project to move to, or the client project is gone", async ({ page }) => {
    await open(page, { seed: { ...products, "projects/s2": delta, "projects/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 11, out: 3, returned: 0 } }) } });
    await openAdhoc(page);
    await lineRow(page, "Nitrile gloves").click();
    // Delta Dental is deleted meanwhile, without this page hearing
    await page.evaluate(() => { window.__mock.docs.delete("projects/s2"); });
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("No such project. The latest is showing.");
    await page.evaluate(() => window.__mock.notify());
    await lineRow(page, "Nitrile gloves").click();
    await expect(modal(page)).toContainText("There's no open project to move it to.");
    await expect(modal(page).getByRole("button", { name: "Move", exact: true })).toHaveCount(0);
  });

  test("a take onto a General Use project someone finished meanwhile starts the next one", { tag: ["@J14.1"] }, async ({ page }) => {
    await open(page, { seed: { ...seed, "projects/adhoc-1": adhoc1({}) } });
    await expect(card(page, "General Use (no job)")).toContainText("0 items out");
    await page.evaluate(() => { window.__mock.docs.get("projects/adhoc-1").status = "closed"; });
    await take(page, "G1");
    expect((await doc(page, "projects/adhoc-2")).items.G1.out).toBe(1);
    expect((await doc(page, "projects/adhoc-1")).items).toEqual({});
  });

  test("a take steps past an adhoc- ID that isn't a General Use project, and never counts one whose number isn't whole", { tag: ["@J14.1"] }, async ({ page }) => {
    // A client project under adhoc-1 (from before the General Use project), and a finished General Use project with an odd ID
    const odd = { ...delta, client: "Odd job" };
    await open(page, { seed: { ...seed, "projects/adhoc-1": odd, "projects/adhoc-x": adhoc1({}, { status: "closed" }) } });
    await take(page, "G1");
    await expect(toast(page)).toHaveText("Took 1 × Nitrile gloves (General Use)");
    expect((await doc(page, "projects/adhoc-2")).items.G1.out).toBe(1);
    expect((await doc(page, "projects/adhoc-1")).items).toEqual({});
    expect(await doc(page, "projects/adhoc-NaN")).toBeUndefined();
  });

  test("the owner's projects CSV gives the General Use project's supplies no price or charge", { tag: ["@J14.1"] }, async ({ page }) => {
    await open(page, { seed: { ...seed, "projects/adhoc-1": adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 12.5, out: 3, returned: 1 } }) } });
    await page.getByRole("button", { name: "Export data" }).click();
    await modal(page).getByRole("button", { name: "Projects (CSV)" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    const rows = (await page.evaluate(() => window.__mock.saves[0].data)).split("\n");
    expect(rows).toContain("General Use (no job),2026-09-30,Test User,Checked out,Nitrile gloves,G1,,3,1,2,,adhoc-1,Supply");
    // A client project's rows keep theirs
    expect(rows).toContain("Echo Studio,2026-09-24,Test User,Checked out,Paper towels,SKU1,9.00,2,0,2,18.00,s1,Supply");
  });

  test("receipts list client projects only, and Inventory's Out view names the General Use project", async ({ page }) => {
    const draft = { store: "", receiptDate: "2026-09-30", date: "2026-09-30", savePrices: true, by: "", dests: [{ id: "d1", projectId: "", client: "" }], lines: [{ id: "l1", name: "Tape", raw: "", qty: 1, price: 2, dest: "d1", code: "", match: "", suggested: false, useName: "inv", usePrice: "", perEach: false }] };
    await page.addInitScript((d) => localStorage.setItem("supplyCheckout.receiptDraft", JSON.stringify(d)), draft);
    await open(page, { seed: { ...seed, "projects/adhoc-1": adhoc1({ "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 1, returned: 0 } }) } });
    await goToInventory(page);
    await page.getByRole("button", { name: "Equipment", exact: true }).click();
    await page.getByRole("button", { name: "Out on jobs" }).click();
    await expect(page.locator("#main table.out tbody tr")).toContainText("General Use (no job)");
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await continueReview(page);
    await expect(page.locator("#rBody [data-dsel] option")).toHaveText(["New project", "Add to Delta Dental (Sep 25, 2026)", "Add to Echo Studio (Sep 24, 2026)"]);
  });
});

test.describe("the web build's quick take and move commands", { tag: ["@J14"] }, () => {
  const docs = () => Object.fromEntries(Object.entries(seed).map(([k, v]) => [`t1/${k}`, v]));

  test("Quick take goes on the project the server picks, and a retry is applied once", { tag: ["@J14.1"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: docs() });
    await openAws(page, backend);
    await connected(page);
    // The first answer is lost: the same operation again, which the server replays
    backend.on("POST", "/teams/t1/adhoc/checkout", { lost: true });
    await take(page, "G1", 2);
    await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Took 2 × Nitrile gloves (General Use)");
    const sent = backend.requests("POST", "/teams/t1/adhoc/checkout").map((r) => r.body);
    expect(sent).toEqual([expect.objectContaining({ productKey: "G1", quantity: 2, date: expect.stringMatching(/^\d{4}-/) }), sent[0]]);
    expect(backend.doc("t1", "projects", "adhoc-1").data).toMatchObject({ kind: "adhoc", items: { G1: { out: 2 } } });
    expect(backend.doc("t1", "products", "G1").data.stock).toBe(48);
    await expect(card(page, "General Use (no job)")).toContainText("2 items out");
    // Busy once on the server: sent again, as it is
    backend.on("POST", "/teams/t1/adhoc/checkout", { status: 409, body: { error: { code: "aborted", message: "busy" } } });
    await take(page, "G1");
    await expect(toast(page)).toHaveText("Took 1 × Nitrile gloves (General Use)");
    expect(backend.doc("t1", "projects", "adhoc-1").data.items.G1.out).toBe(3);
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
    all["t1/projects/adhoc-1"] = adhoc1({ G1: { code: "G1", name: "Nitrile gloves", price: 11, out: 3, returned: 1 }, SKU1: { code: "SKU1", name: "Paper towels", price: 8, out: 1, returned: 0 }, rope: { code: "", name: "Rope", price: 2, out: 1, returned: 0 } });
    const backend = new FakeBackend({ docs: all });
    await openAws(page, backend);
    await connected(page);
    await openAdhoc(page);
    backend.on("POST", "/teams/t1/projects/adhoc-1/move", { lost: true });
    await lineRow(page, "Nitrile gloves").click();
    await modal(page).getByLabel("Project", { exact: true }).selectOption("s2");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
    await modal(page).getByRole("button", { name: "Try again" }).click();
    await expect(toast(page)).toHaveText("Moved to Delta Dental");
    const sent = backend.requests("POST", "/teams/t1/projects/adhoc-1/move").map((r) => r.body);
    expect(sent).toEqual([{ operationId: expect.any(String), productKey: "G1", toProjectId: "s2" }, sent[0]]);
    expect(backend.doc("t1", "projects", "s2").data.items.G1).toMatchObject({ price: 11, out: 3, returned: 1 });
    expect(backend.doc("t1", "projects", "adhoc-1").data.items).not.toHaveProperty("G1");
    await expect(lineRow(page, "Nitrile gloves")).toHaveCount(0);
    // Busy once: sent again
    backend.on("POST", "/teams/t1/projects/adhoc-1/move", { status: 409, body: { error: { code: "aborted", message: "busy" } } });
    await lineRow(page, "Paper towels").click();
    await modal(page).getByLabel("Project", { exact: true }).selectOption("s1");
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("Moved to Echo Studio");
    expect(backend.doc("t1", "projects", "s1").data.items.SKU1).toMatchObject({ price: 9, out: 3 });
    // Refused by the server: its message, with the latest showing
    backend.on("POST", "/teams/t1/projects/adhoc-1/move", { status: 400, body: { error: { code: "bad_request", message: "The project has this item as a supply; correct the lines by hand" } } });
    await lineRow(page, "Rope").click();
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText("The project has this item as a supply; correct the lines by hand. The latest is showing.");
    backend.on("POST", "/teams/t1/projects/adhoc-1/move", { status: 409, body: { error: { code: "aborted", message: "busy" } } }, 2);
    await lineRow(page, "Rope").click();
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(toast(page)).toHaveText(/Someone else changed this just now/);
  });

  test("the server refuses to reopen a General Use project while another is open", { tag: ["@J14.4"] }, async ({ page }) => {
    const all = docs();
    all["t1/projects/adhoc-1"] = adhoc1({}, { status: "closed" });
    const backend = new FakeBackend({ docs: all });
    await openAws(page, backend);
    await connected(page);
    // Someone else started adhoc-2, and this page hasn't heard
    backend.write("t1", "projects", "adhoc-2", adhoc1({}));
    await page.getByRole("button", { name: "Returned" }).click();
    await card(page, "General Use (no job)").click();
    await page.getByRole("button", { name: "Reopen" }).click();
    await expect(toast(page)).toHaveText("Another General Use project is open. Finish it before reopening this one.");
    expect(backend.doc("t1", "projects", "adhoc-1").data.status).toBe("closed");
    // The server refuses a checkout onto the General Use project too
    expect(backend.command("t1", "adhoc-2", "checkout", { operationId: "0f8fad5b-d9cb-469f-a165-70867728950e", productKey: "G1", quantity: 1 })[0]).toBe(400);
  });
});
