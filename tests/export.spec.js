// Exporting all of a team's data (supply-checkout-zuv): owners download every sheet and
// the inventory as CSV, or everything as JSON, from what the app shows.
import { test, expect, openApp, modal } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { usedState } from "./fixtures.js";

const seed = {
  ...usedState.seed,
  "products/uncounted": { code: "UC1", name: "=HYPERLINK(\"x\")", price: 2.25 },
  "products/noname": { code: "", price: "3" },
  "products/noprice": { code: "NP", name: "Rags", stock: 4 },
  "sheets/s2": { client: "Delta, \"Dry\" Cleaning", date: "2026-09-25", createdByName: "Sam", status: "closed", closedAt: "2026-09-25T18:00:00Z", items: {} },
  "sheets/s3": { client: "", status: "open", items: { odd: { code: "", out: "4", returned: 9 } } },
};

async function openOwner(page, opts = {}) {
  await openApp(page, { seed, ...opts });
  await page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });
}
const saved = (page, i) => page.evaluate((i) => window.__mock.saves[i], i);

test("owners export every sheet and the inventory as CSV, and everything as JSON", { tag: ["@J6", "@J10.2"] }, async ({ page }) => {
  await openOwner(page);
  await page.getByRole("button", { name: "Export data" }).click();
  await expect(modal(page)).toContainText("3 sheets and 5 inventory items");
  // Only the artifact says how to move to the web app (docs/moving-to-the-web-app.md)
  if (currentBuild() === "artifact") await expect(page.locator("#moveHint")).toHaveText(/^Moving to the Supply Checkout web app\? Download Everything \(JSON\) and send that file to us\./);
  else await expect(page.locator("#moveHint")).toHaveCount(0);

  await modal(page).getByRole("button", { name: "Sheets (CSV)" }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
  const sheets = await saved(page, 0);
  expect(sheets.filename).toMatch(/^Supply Checkout sheets \d{4}-\d{2}-\d{2}\.csv$/);
  // In the list's order (the mock sorts an undated sheet first); returned counts capped at taken; an empty sheet gets one row
  expect(sheets.data.split("\n")).toEqual([
    "Client,Date,Prepared by,Status,Item,Barcode,Price each,Taken,Returned,Used,Charge,Sheet ID",
    "Untitled,,Unknown,Checked out,Unnamed item,,0.00,4,4,0,0.00,s3",
    '"Delta, ""Dry"" Cleaning",2026-09-25,Sam,Returned,,,,,,,,s2',
    "Echo Studio,2026-09-24,Test User,Checked out,\"Paper towels, 6 roll\",SKU1,8.50,3,1,2,17.00,s1",
    "Echo Studio,2026-09-24,Test User,Checked out,\"Storage bins, 12 qt\",,5.00,2,0,2,10.00,s1",
  ]);

  await modal(page).getByRole("button", { name: "Inventory (CSV)" }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(2);
  const inventory = await saved(page, 1);
  expect(inventory.filename).toMatch(/^Supply Checkout inventory \d{4}-\d{2}-\d{2}\.csv$/);
  // By name, as the Inventory tab lists it; a formula-like name can't run in a spreadsheet
  expect(inventory.data.split("\n")).toEqual([
    "Item,Barcode,In storage,Price each,Value",
    "\"'=HYPERLINK(\"\"x\"\")\",UC1,,2.25,",
    "\"Paper towels, 6 roll\",SKU1,10,8.50,85.00",
    "Rags,NP,4,0.00,0.00",
    "\"Storage bins, 12 qt\",,2,5.00,10.00",
    "Unnamed item,,,3.00,",
  ]);

  await modal(page).getByRole("button", { name: "Everything (JSON)" }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(3);
  const all = await saved(page, 2);
  expect(all.filename).toMatch(/^Supply Checkout export \d{4}-\d{2}-\d{2}\.json$/);
  const json = JSON.parse(all.data);
  expect(json).toMatchObject({ app: "Supply Checkout", exportedAt: expect.any(String) });
  expect(json.sheets.map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
  expect(json.sheets[2]).toMatchObject({ client: "Echo Studio", preparedBy: "Test User", items: seed["sheets/s1"].items, totals: { taken: 5, returned: 1, used: 4, charge: 27 } });
  expect(json.inventory.map((p) => p.key)).toEqual(["uncounted", "SKU1", "noprice", "nb-bins", "noname"]);
  expect(json.inventory[1]).toEqual({ key: "SKU1", ...seed["products/SKU1"] });

  await modal(page).getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

// The artifact build's marks of recent saves only guard retries (src/moves.js): they aren't data
test("the JSON export leaves out the marks of recent saves", { tag: ["@J6"] }, async ({ page }) => {
  await openOwner(page, { seed: {
    "products/a": { name: "A", price: 1, stock: 3, ops: ["m1"] },
    "sheets/s": { client: "One", date: "2026-09-01", status: "open", savedReceipts: { m0: true }, items: { a: { code: "", name: "A", price: 1, out: 2, returned: 0, ops: ["m1", "m2"] } } },
    "sheets/bare": { client: "Two", date: "2026-09-02", status: "open" },
  } });
  await page.getByRole("button", { name: "Export data" }).click();
  await modal(page).getByRole("button", { name: "Everything (JSON)" }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
  const json = JSON.parse((await saved(page, 0)).data);
  expect(json.sheets.find((s) => s.id === "s")).toEqual({ id: "s", client: "One", date: "2026-09-01", status: "open", items: { a: { code: "", name: "A", price: 1, out: 2, returned: 0 } }, preparedBy: "Unknown", totals: { taken: 2, returned: 0, used: 2, charge: 2 } });
  expect(json.sheets.find((s) => s.id === "bare")).not.toHaveProperty("items");
  expect(json.inventory).toEqual([{ key: "a", name: "A", price: 1, stock: 3 }]);
});

test("a single sheet's CSV guards formula-like text too", { tag: ["@J6.2"] }, async ({ page }) => {
  await openOwner(page, { seed: { "sheets/f": { client: "@Risky", date: "2026-09-01", status: "open", items: { a: { code: "-1", name: "+Plus", price: 1, out: 1, returned: 0 } } } } });
  await page.getByRole("button", { name: /Risky/ }).click();
  await page.getByRole("button", { name: "Download CSV" }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
  const { data, filename } = await saved(page, 0);
  expect(filename).toBe("@Risky 2026-09-01.csv");
  expect(data).toContain("Client,'@Risky");
  expect(data).toContain("'+Plus,'-1,1.00,1,0,1,1.00");
});

test("view-only owners can still export (a cancelled team's read-only period)", { tag: ["@J6", "@J10.2"] }, async ({ page }) => {
  await openOwner(page, { canWrite: false, seed: { "products/a": { name: "A", price: 1 }, "sheets/s": { client: "One", date: "2026-09-01", status: "open", items: {} } } });
  await expect(page.getByRole("button", { name: "+ New sheet" })).toHaveCount(0);
  await page.getByRole("button", { name: "Export data" }).click();
  await expect(modal(page)).toContainText("1 sheet and 1 inventory item,");
  await modal(page).getByRole("button", { name: "Everything (JSON)" }).click();
  await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(1);
});

test("only owners see Export data", { tag: ["@J6"] }, async ({ page }) => {
  await openOwner(page, { owner: false });
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export data" })).toHaveCount(0);
});

test("no Export data when the owner check fails or downloads aren't available", { tag: ["@J6"] }, async ({ page }) => {
  await openOwner(page, { userErrors: ["isOwner"], unavailable: ["downloads"] });
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export data" })).toHaveCount(0);
});

test("a declined export says nothing", { tag: ["@J6"] }, async ({ page }) => {
  await openOwner(page, { downloadError: "declined" });
  await page.getByRole("button", { name: "Export data" }).click();
  await modal(page).getByRole("button", { name: "Inventory (CSV)" }).click();
  await expect(page.locator("#toast")).toBeHidden();
});

test("a failed export says it couldn't be prepared", { tag: ["@J6"] }, async ({ page }) => {
  await openOwner(page, { downloadError: "unavailable" });
  await page.getByRole("button", { name: "Export data" }).click();
  await modal(page).getByRole("button", { name: "Sheets (CSV)" }).click();
  await expect(page.locator("#toast")).toHaveText("Couldn't prepare the download here.");
});

test("exports 1,000 sheets in well under 30 seconds", { tag: ["@J6"] }, async ({ page }) => {
  const big = { ...usedState.seed };
  for (let i = 0; i < 1000; i++) {
    const items = {};
    for (let j = 0; j < 20; j++) items[`k${j}`] = { code: `C${j}`, name: `Item ${j}`, price: j + 0.5, out: 5, returned: j % 5 };
    big[`sheets/b${String(i).padStart(4, "0")}`] = { client: `Client ${i}`, date: "2026-09-01", createdByName: "Sam", status: i % 2 ? "closed" : "open", items };
  }
  await openOwner(page, { seed: big });
  await page.getByRole("button", { name: "Export data" }).click();
  const start = Date.now();
  for (const [i, name] of ["Sheets (CSV)", "Everything (JSON)"].entries()) {
    await modal(page).getByRole("button", { name }).click();
    await expect.poll(() => page.evaluate(() => window.__mock.saves.length)).toBe(i + 1);
  }
  expect(Date.now() - start).toBeLessThan(30e3);
  const rows = await page.evaluate(() => window.__mock.saves[0].data.split("\n").length);
  expect(rows).toBe(1 + 1000 * 20 + 2);
  expect(await page.evaluate(() => JSON.parse(window.__mock.saves[1].data).sheets.length)).toBe(1001);
});
