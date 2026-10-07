// Company equipment bought on a receipt for a client (ADR 0017, section 2a), and the team's
// equipment markup. In both builds against the claude.ai runtime's mock (no markup: the line is
// charged the receipt price, or a typed one), and in the web build against tests/fake-aws.js:
// the server works the markup out, only owners have the percentage, and owners set it in Team
// settings.
import { test, expect, openApp, modalViolations } from "./helpers.js";
import { modal, startReturn, lineRow, continueReview, enterBarcode } from "./ui/index.js";
import { FakeBackend, TEAM, USER, openAws, connected } from "./fake-aws.js";

const ladder = { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, stock: 3 };
const seed = {
  "products/LAD-1": ladder,
  "products/SKU1": { code: "SKU1", name: "Paper towels, 6 roll", price: 8.5, stock: 10 },
  "projects/s1": {
    client: "Echo Studio", date: "2026-09-24", createdBy: "u_test", createdAt: "2026-09-24T12:00:00Z", status: "open",
    items: { "LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, out: 1, returned: 0 } },
  },
};
const draftOf = (lines, dests = [{ id: "d1", projectId: "", client: "Foxtrot" }]) => ({
  store: "Hardware Co", receiptDate: "2026-09-20", date: "2026-09-25", subtotal: null, tax: null, total: null,
  savePrices: true, by: "", dests,
  lines: lines.map((o, i) => ({ id: `l${i}`, name: "Ladder", raw: "", qty: 1, price: 130, dest: "d1", code: "", match: "LAD-1", suggested: false, useName: "inv", usePrice: "", ...o })),
});
const rline = (page, i = 0) => page.locator(".rline").nth(i);
const doc = (page, path) => page.evaluate((p) => window.__mock.docs.get(p), path);
const saveReceipt = (page) => page.getByRole("button", { name: "Save", exact: true }).click();

// The claude.ai runtime's mock, with a receipt draft waiting (once: a reload keeps what the page saved)
async function review(page, draft, opts = {}) {
  await page.addInitScript((d) => {
    if (sessionStorage.getItem("draftSeeded")) return;
    sessionStorage.setItem("draftSeeded", "1");
    localStorage.setItem("supplyCheckout.receiptDraft", JSON.stringify(d));
  }, draft);
  await openApp(page, { seed, ...opts });
  await continueReview(page);
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
}

test.describe("equipment bought on a receipt for a client", { tag: ["@J5.3", "@J13"] }, () => {
  test("says what it is wherever it goes, and offers a typed price instead of the price choice", async ({ page }) => {
    await review(page, draftOf([{ price: 130 }]));
    await expect(rline(page)).toContainText("Company equipment · bought for this client: charged on their project, not kept in storage");
    // The claude.ai build has no markup; the web build's page doesn't know it here (no team settings)
    await expect(rline(page).locator("[data-charged]")).toHaveText("Charged: receipt price + team markup");
    await expect(rline(page).getByRole("button", { name: /Charge the receipt price/ })).toHaveCount(0);
    // The web build's total is short of the markup it doesn't know, and says so
    await expect(rline(page).locator("[data-total]")).toHaveText("$130.00 (before markup)");
    await expect(page.locator("#rSum tr").first().locator("td").last()).toHaveText("$130.00 (before markup)");
    await rline(page).getByLabel("Charge a different price ($)").fill("150");
    await expect(rline(page).locator("[data-charged]")).toHaveText("Charged: $150.00 each, the price you typed");
    await expect(rline(page).locator("[data-total]")).toHaveText("$150.00");
    await expect(page.locator("#rSum tr").first().locator("td").last()).toHaveText("$150.00");
    await rline(page).getByLabel("Charge a different price ($)").fill("");
    await rline(page).getByLabel("For").selectOption("stock");
    await expect(rline(page)).toContainText("Company equipment · added to storage, not charged");
    await expect(rline(page).getByLabel("Charge a different price ($)")).toHaveCount(0);
    await rline(page).getByLabel("For").selectOption("d1");
    await expect(rline(page)).toContainText("bought for this client");
  });

  test("on a new project, it's its own charged line at the receipt price, and stock doesn't move", { tag: ["@J5.3"] }, async ({ page }) => {
    await review(page, draftOf([{ qty: 2, price: 130 }, { id: "l9", name: "Towels", match: "SKU1", qty: 1, price: 8 }]));
    await saveReceipt(page);
    await expect(page.locator("#toast")).toHaveText("Saved to 1 project");
    await expect(page.getByRole("heading", { name: "Foxtrot" })).toBeVisible();
    const id = await page.evaluate(() => [...window.__mock.docs.keys()].find((k) => k.startsWith("projects/") && window.__mock.docs.get(k).client === "Foxtrot"));
    const items = (await doc(page, id)).items;
    expect(items["LAD-1:bought"]).toMatchObject({ code: "LAD-1", name: "Step ladder", cost: 130, price: 130, purchased: true, out: 2, returned: 0 });
    expect(items["LAD-1:bought"]).not.toHaveProperty("priceSet");
    expect(items["LAD-1"]).toBeUndefined();
    expect(items.SKU1).toMatchObject({ out: 1 });
    expect((await doc(page, "products/LAD-1")).stock).toBe(3);
    // The value follows what was last paid; equipment never gets a price
    expect(await doc(page, "products/LAD-1")).toMatchObject({ cost: 130, kind: "equipment" });
    expect(await doc(page, "products/LAD-1")).not.toHaveProperty("price");
    await expect(lineRow(page, "Step ladder (bought for this client)").locator("td")).toHaveText(["Step ladder (bought for this client)Barcode LAD-1", "$130.00", "2", "0", "2", "$260.00"]);
  });

  test("a typed price on an existing project stays apart from the same item on loan, says who typed it, and doesn't come back", { tag: ["@J5.3"] }, async ({ page }) => {
    await review(page, draftOf([{ price: 130, typed: "149.5" }], [{ id: "d1", projectId: "s1", client: "" }]));
    await saveReceipt(page);
    await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
    const items = (await doc(page, "projects/s1")).items;
    expect(items["LAD-1:bought"]).toMatchObject({ price: 149.5, cost: 130, purchased: true, priceSet: "manual", priceSetBy: "u_test", priceSetAt: expect.stringMatching(/^\d{4}-/) });
    expect(items["LAD-1"]).toMatchObject({ kind: "equipment", out: 1 });
    const row = lineRow(page, "(bought for this client)");
    await expect(row).toContainText("Price typed by Test User");
    await expect(page.locator("#projectBody .totals .charge")).toHaveText("$149.50");
    // It isn't in any return list, and scanning the item returns the one on loan
    await startReturn(page);
    await page.getByRole("button", { name: "Return item without a barcode" }).click();
    await expect(modal(page).locator("[data-k]")).toHaveCount(1);
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    await enterBarcode(page, "LAD-1");
    await expect(modal(page)).toContainText("1 taken");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // The line editor changes how many and the price, never returned
    await row.click();
    await expect(modal(page).getByRole("heading", { name: "Step ladder (bought for this client)" })).toBeVisible();
    await expect(modal(page).getByLabel("Returned")).toHaveCount(0);
    await modal(page).getByLabel("Taken").fill("2");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    expect((await doc(page, "projects/s1")).items["LAD-1:bought"]).toMatchObject({ out: 2, returned: 0, price: 149.5 });
    // The client's CSV has it, charged
    await page.getByRole("button", { name: "Download CSV" }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
    const csv = (await page.evaluate(() => window.__mock.saves[0].data)).split("\n");
    expect(csv).toContain("Step ladder (bought for this client),LAD-1,149.50,2,0,2,299.00");
  });

  test("without a signed-in user, a typed price names who prepared the receipt", { tag: ["@J5.3"] }, async ({ page }) => {
    await review(page, { ...draftOf([{ price: 130, typed: "140" }], [{ id: "d1", projectId: "s1", client: "" }]), by: "Sam" }, { userErrors: ["id"] });
    await saveReceipt(page);
    await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
    expect((await doc(page, "projects/s1")).items["LAD-1:bought"]).toMatchObject({ priceSet: "manual", priceSetBy: "Sam" });
    await expect(lineRow(page, "(bought for this client)")).toContainText("Price typed by Someone");
  });
});

test.describe("the web build: the server prices it, and only owners have the markup", { tag: ["@J5.3", "@J2"] }, () => {
  const docs = () => Object.fromEntries(Object.entries(seed).map(([k, v]) => [`t1/${k}`, v]));
  const local = (draft) => ({ storage: { local: { "supplyCheckout.owner": USER.id, "supplyCheckout.team": "t1", "supplyCheckout.receiptDraft.t1": JSON.stringify(draft) } } });

  test("an owner sees the price the markup gives, and the receipt sends only the receipt price", async ({ page }) => {
    const backend = new FakeBackend({ docs: docs(), settings: { t1: { equipmentMarkup: 25, version: 3 } } });
    await openAws(page, backend, local(draftOf([{ price: 130 }, { id: "l2", name: "Cord", match: "LAD-1", price: 20, typed: "31", dest: "d2" }], [{ id: "d1", projectId: "s1", client: "" }, { id: "d2", projectId: "", client: "Golf" }])));
    await connected(page);
    await continueReview(page);
    await expect(rline(page, 0).locator("[data-charged]")).toHaveText("Charged: $162.50 each (receipt price + 25% markup)");
    await expect(rline(page, 0).locator("[data-total]")).toHaveText("$162.50");
    await saveReceipt(page);
    await expect(page.locator("#toast")).toHaveText("Saved to 2 projects");
    const [toEcho] = backend.requests("POST", "/teams/t1/projects/s1/lines");
    // No price: the server adds the markup
    expect(toEcho.body.lines).toEqual([{ productKey: "LAD-1", quantity: 1, code: "LAD-1", name: "Step ladder", cost: 130 }]);
    expect(backend.doc("t1", "projects", "s1").data.items["LAD-1:bought"]).toMatchObject({ price: 162.5, cost: 130, purchased: true, priceSet: "markup" });
    // A new project is saved first, then its bought line is added, with the typed price as typed
    const put = backend.requests("PUT", /^\/teams\/t1\/projects\//).find((r) => r.body.data.client === "Golf");
    expect(put.body.data.items).toEqual({});
    const id = put.path.split("/").pop();
    const [toGolf] = backend.requests("POST", `/teams/t1/projects/${id}/lines`);
    expect(toGolf.body.lines).toEqual([{ productKey: "LAD-1", quantity: 1, code: "LAD-1", name: "Step ladder", cost: 20, price: 31, priceSet: "manual" }]);
    expect(backend.doc("t1", "projects", id).data.items["LAD-1:bought"]).toMatchObject({ price: 31, priceSet: "manual", priceSetBy: USER.id });
    // Stock didn't move
    expect(backend.doc("t1", "products", "LAD-1").data.stock).toBe(3);
  });

  test("an owner demoted meanwhile gets the contributor's wording, never an undefined markup", { tag: ["@J2.5"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: docs(), settings: { t1: { equipmentMarkup: 25, version: 3 } } });
    await openAws(page, backend, local(draftOf([{ price: 130 }], [{ id: "d1", projectId: "s1", client: "" }])));
    await connected(page);
    backend.teams[0].role = "contributor";
    await continueReview(page);
    await expect(rline(page).locator("[data-charged]")).toHaveText("Charged: receipt price + team markup");
    await expect(rline(page).locator("[data-total]")).toHaveText("$130.00 (before markup)");
    await expect(page.locator("#rSum tr").first().locator("td").last()).toHaveText("$130.00 (before markup)");
    expect(await page.evaluate(() => document.body.innerText.includes("undefined"))).toBe(false);
    // Team settings can't show or save a markup it didn't get
    await page.locator(".teambar").getByRole("button", { name: "Team settings" }).click();
    await expect(modal(page).locator("#settingsFail")).toHaveText("Couldn't load the settings. Check your connection, then open them again.");
    await expect(modal(page).getByLabel("Markup on company equipment bought for a client (%)")).toHaveValue("");
    await expect(modal(page).getByRole("button", { name: "Save" })).toBeDisabled();
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // Nor one without its version
    backend.teams[0].role = "owner";
    backend.on("GET", "/teams/t1/settings", { status: 200, body: { settings: { equipmentMarkup: 25 } } });
    await page.locator(".teambar").getByRole("button", { name: "Team settings" }).click();
    await expect(modal(page).locator("#settingsFail")).toHaveText("Couldn't load the settings. Check your connection, then open them again.");
    await expect(modal(page).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(backend.requests("PUT", "/teams/t1/settings")).toEqual([]);
  });

  test("a contributor never asks for the markup, and the page never has it", { tag: ["@J2.5"] }, async ({ page }) => {
    const backend = new FakeBackend({ teams: [{ ...TEAM, role: "contributor" }], docs: docs(), settings: { t1: { equipmentMarkup: 37.77, version: 1 } } });
    await openAws(page, backend, local(draftOf([{ price: 130 }], [{ id: "d1", projectId: "s1", client: "" }])));
    await connected(page);
    await expect(page.locator(".teambar").getByRole("button", { name: "Team settings" })).toHaveCount(0);
    await continueReview(page);
    await expect(rline(page).locator("[data-charged]")).toHaveText("Charged: receipt price + team markup");
    await saveReceipt(page);
    await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
    // The price it gave is on the project, as any line's is; the percentage is nowhere
    await expect(lineRow(page, "(bought for this client)")).toContainText("$179.10");
    expect(backend.requests("GET", "/teams/t1/settings")).toEqual([]);
    expect(await page.evaluate(() => document.body.innerText.includes("37.77"))).toBe(false);
    // (The server answers a contributor's GET /settings with nothing: backend/test/equipment-api.test.ts)
  });

  test("an owner sets the markup in Team settings", { tag: ["@J2.5"] }, async ({ page }) => {
    const backend = new FakeBackend({ docs: docs() });
    await openAws(page, backend);
    await connected(page);
    await page.locator(".teambar").getByRole("button", { name: "Team settings" }).click();
    const field = modal(page).getByLabel("Markup on company equipment bought for a client (%)");
    await expect(field).toHaveValue("0");
    expect(await modalViolations(page)).toEqual([]);
    for (const bad of ["", "1000.5", "1.234"]) {
      await field.fill(bad);
      await modal(page).getByRole("button", { name: "Save" }).click();
      await expect(modal(page).locator("#settingsFail")).toHaveText("Enter a percentage from 0 to 1,000, with at most two decimals.");
    }
    await field.fill("12.5");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("Saved: 12.5% on equipment bought for clients");
    expect(backend.requests("PUT", "/teams/t1/settings").map((r) => r.body)).toEqual([{ equipmentMarkup: 12.5, expectedVersion: 0 }]);
    expect(backend.settings.t1).toEqual({ equipmentMarkup: 12.5, version: 1 });

    // Another owner saved meanwhile
    await page.locator(".teambar").getByRole("button", { name: "Team settings" }).click();
    await expect(field).toHaveValue("12.5");
    backend.settings.t1 = { equipmentMarkup: 20, version: 2 };
    await field.fill("15");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(modal(page).locator("#settingsFail")).toHaveText("Another owner changed the settings meanwhile. Close and open them again to see theirs.");
    backend.on("PUT", "/teams/t1/settings", { status: 503, body: { error: { code: "unavailable", message: "x" } } });
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(modal(page).locator("#settingsFail")).toHaveText("That didn't save. Check your connection and try again.");
    await modal(page).getByRole("button", { name: "Cancel" }).click();
    // Settings that can't be loaded say so
    backend.on("GET", "/teams/t1/settings", { status: 503, body: { error: { code: "unavailable", message: "x" } } });
    await page.locator(".teambar").getByRole("button", { name: "Team settings" }).click();
    await expect(modal(page).locator("#settingsFail")).toHaveText("Couldn't load the settings. Check your connection, then open them again.");
    await expect(modal(page).getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
