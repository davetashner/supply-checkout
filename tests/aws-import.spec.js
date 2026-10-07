// The web build's CSV inventory import (src/aws/import.js): owners pick a file, see the
// server's preview, and import it, against the fake backend in tests/fake-aws.js. The
// server's side (parsing, validation, all or nothing) is tested in backend/test/imports*.
import { readFile } from "node:fs/promises";
import { test, expect, modalViolations } from "./helpers.js";
import { FakeBackend, TEAM, openAws, connected } from "./fake-aws.js";

// The modal's entrance animation fades it in; axe must see its final colors
test.use({ reducedMotion: "reduce" });

const PATH = "/teams/t1/imports";
const CSV = "name,barcode,price,stock,Notes\nNitrile gloves,0123,13,10,x\nRags,,1.5,,y\nBins,,3,2,\n";
const SUMMARY = { rows: 3, created: 1, updated: 1, unchanged: 1 };
const PREVIEW = {
  status: "preview",
  rows: [
    { line: 2, name: "Nitrile gloves", barcode: "0123", price: 13, stock: 10, key: "0123", action: "update", changes: ["price", "stock"] },
    { line: 3, name: "Rags", barcode: "", price: 1.5, key: "nb-1", action: "create", changes: ["name", "price"] },
    { line: 4, name: "Bins <b>", barcode: "", price: 3, stock: 2, key: "nb-2", action: "unchanged", changes: [] },
  ],
  errors: [],
  errorCount: 0,
  ignoredColumns: ["Notes"],
  summary: SUMMARY,
};
const ok = (body) => ({ status: 200, body });
const error = (status, code, message = code) => ({ status, body: { error: { code, message } } });
const dialog = (page) => page.locator("#modal");

async function openImport(page, backend = new FakeBackend()) {
  await openAws(page, backend);
  await connected(page);
  await page.locator(".teambar").getByRole("button", { name: "Import CSV" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Import inventory" })).toBeVisible();
  return backend;
}

const choose = (page, text = CSV, name = "inventory.csv") => page.getByLabel("CSV file").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(text) });

test("an owner previews a file, imports it, and every retry sends the same import ID", { tag: ["@J2.4"] }, async ({ page }) => {
  const backend = new FakeBackend();
  backend.on("POST", PATH, ok(PREVIEW));
  await openImport(page, backend);
  await choose(page);
  const result = page.locator("#importResult");
  await expect(result).toContainText("3 rows: 1 new, 1 to update, 1 unchanged.");
  await expect(result).toContainText("Not imported: “Notes”.");
  const rows = result.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveText(/Nitrile gloves\s*0123\s*\$13\.00\s*10\s*Update price, stock/);
  await expect(rows.nth(1)).toHaveText(/Rags\s*\$1\.50\s*—\s*New/);
  await expect(rows.nth(2)).toContainText("Bins <b>");
  await expect(rows.nth(2)).toContainText("No change");
  expect(await modalViolations(page)).toEqual([]);
  expect(backend.requests("POST", PATH).map((c) => c.body)).toEqual([{ dryRun: true, csv: CSV }]);

  // The first try doesn't finish; the second, with the same ID, does
  backend.on("POST", PATH, error(500, "internal"));
  backend.on("POST", PATH, ok({ status: "imported", importId: "x", replayed: false, summary: SUMMARY }));
  const go = dialog(page).getByRole("button", { name: "Import", exact: true });
  await go.click();
  await expect(page.locator("#importFail")).toHaveText("The import didn't finish. Try again to finish it; nothing will be added twice.");
  await dialog(page).getByRole("button", { name: "Try again" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.locator("#toast")).toHaveText("Imported: 1 new, 1 updated");
  const [, first, second] = backend.requests("POST", PATH).map((c) => c.body);
  expect(first).toEqual({ importId: expect.stringMatching(/^[0-9a-f-]{36}$/), csv: CSV });
  expect(second).toEqual(first);
});

test("shows the server's words when an import can't go on as it is", { tag: ["@J2.4"] }, async ({ page }) => {
  const backend = new FakeBackend();
  const message = "This import expired before it finished. Choose the file again to finish; rows already imported won't be added twice.";
  backend.on("POST", PATH, ok(PREVIEW));
  backend.on("POST", PATH, error(409, "aborted", message));
  await openImport(page, backend);
  await choose(page);
  await dialog(page).getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.locator("#importFail")).toHaveText(message);
  await expect(dialog(page).getByRole("button", { name: "Try again" })).toBeVisible();
});

test("shows every problem in the file and offers no import", { tag: ["@J2.4"] }, async ({ page }) => {
  const backend = new FakeBackend();
  backend.on("POST", PATH, ok({
    ...PREVIEW,
    status: "invalid",
    errors: [{ line: 3, column: "price", message: "price can't be negative" }, { line: 5, message: "Line 2 already updates the same item" }],
    errorCount: 3,
    ignoredColumns: [],
  }));
  backend.on("POST", PATH, ok({ ...PREVIEW, status: "invalid", errors: [{ line: 2, column: "name", message: "name is required" }], errorCount: 1, ignoredColumns: [] }));
  await openImport(page, backend);
  await choose(page);
  const result = page.locator("#importResult");
  await expect(result.getByRole("alert")).toHaveText("3 rows need fixing, so nothing can be imported yet. Fix them in the file and choose it again.");
  await expect(result.locator(".import-errors li")).toHaveText(["Line 3 (price): price can't be negative", "Line 5: Line 2 already updates the same item"]);
  await expect(result).toContainText("…and 1 more problem.");
  await expect(result.locator("table")).toHaveCount(0);
  await expect(result).not.toContainText("Not imported");
  await expect(dialog(page).getByRole("button", { name: "Import", exact: true })).toBeHidden();

  // The fixed file, chosen again, is checked again
  await choose(page, CSV + "\n", "fixed.csv");
  await expect(result.getByRole("alert")).toHaveText("1 row needs fixing, so nothing can be imported yet. Fix it in the file and choose it again.");
  await expect(result).not.toContainText("more problem");
});

test("shows the first 100 rows, and says when everything was already there", { tag: ["@J2.4"] }, async ({ page }) => {
  const backend = new FakeBackend();
  const rows = Array.from({ length: 105 }, (_, i) => ({ line: i + 2, name: `Item ${i}`, barcode: "", price: 1, key: `k${i}`, action: "unchanged", changes: [] }));
  const summary = { rows: 105, created: 0, updated: 0, unchanged: 105 };
  backend.on("POST", PATH, ok({ ...PREVIEW, rows, ignoredColumns: [], summary }));
  backend.on("POST", PATH, ok({ status: "imported", importId: "x", replayed: false, summary }));
  await openImport(page, backend);
  await choose(page);
  await expect(page.locator("#importResult")).toContainText("105 rows: 0 new, 0 to update, 105 unchanged.");
  await expect(page.locator("#importResult tbody tr")).toHaveCount(100);
  await expect(page.locator("#importResult")).toContainText("…and 5 more rows.");
  await dialog(page).getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.locator("#toast")).toHaveText("Everything in the file was already in inventory");
});

test("a row that clashes by the time of the import shows the problems again", { tag: ["@J2.4"] }, async ({ page }) => {
  const backend = new FakeBackend();
  backend.on("POST", PATH, ok({ ...PREVIEW, rows: PREVIEW.rows.slice(0, 1), summary: { rows: 1, created: 0, updated: 1, unchanged: 0 } }));
  backend.on("POST", PATH, error(400, "bad_request", "1 row has a problem; nothing was imported"));
  backend.on("POST", PATH, ok({ ...PREVIEW, status: "invalid", errors: [{ line: 2, column: "barcode", message: "2 items in inventory match this row" }], errorCount: 1 }));
  await openImport(page, backend);
  await choose(page);
  await expect(page.locator("#importResult")).toContainText("1 row: 0 new, 1 to update, 0 unchanged.");
  await dialog(page).getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.locator("#importResult .import-errors li")).toHaveText(["Line 2 (barcode): 2 items in inventory match this row"]);
  expect(backend.requests("POST", PATH).map((c) => c.body.dryRun)).toEqual([true, undefined, true]);
});

test("says why a file couldn't be checked", { tag: ["@J2.4"] }, async ({ page }) => {
  const backend = new FakeBackend();
  backend.on("POST", PATH, error(400, "bad_request", "The file needs a price column."));
  backend.on("POST", PATH, error(403, "permission_denied"));
  backend.on("POST", PATH, { abort: true });
  await openImport(page, backend);
  const alert = page.locator("#importResult").getByRole("alert");
  await choose(page);
  await expect(alert).toHaveText("The file needs a price column.");
  await choose(page, CSV, "b.csv");
  await expect(alert).toHaveText("Only the team's owners can import inventory.");
  await choose(page, CSV, "c.csv");
  await expect(alert).toHaveText("Couldn't check the file. Check your connection and choose it again.");
  await expect(dialog(page).getByRole("button", { name: "Import", exact: true })).toBeHidden();
});

test("refuses a file over 300 KB without sending it, ignores an empty choice, and cancels", { tag: ["@J2.4"] }, async ({ page }) => {
  const backend = await openImport(page);
  await choose(page, "x".repeat(300_001));
  await expect(page.locator("#importResult").getByRole("alert")).toHaveText("This file is larger than 300 KB. Split it into smaller files and import each one.");
  await page.getByLabel("CSV file").setInputFiles([]);
  await expect(page.locator("#importResult").getByRole("alert")).toBeVisible();
  expect(backend.requests("POST", PATH)).toEqual([]);
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("offers a template with a column guide, and the template goes through the preview as it is", { tag: ["@J2.4"] }, async ({ page }) => {
  const backend = new FakeBackend();
  backend.on("POST", PATH, ok({ ...PREVIEW, rows: PREVIEW.rows.slice(0, 2).map((r) => ({ ...r, action: "create" })), ignoredColumns: [], summary: { rows: 2, created: 2, updated: 0, unchanged: 0 } }));
  await openImport(page, backend);
  const guide = dialog(page).locator("details.import-guide");
  await guide.getByText("What goes in each column").click();
  for (const column of ["name", "price", "barcode", "kind", "cost", "stock", "pack_size"]) await expect(guide.locator("dt", { hasText: new RegExp(`^${column}$`) })).toBeVisible();
  await expect(guide).toContainText("before tax. It isn't shown on client projects.");
  expect(await modalViolations(page)).toEqual([]);

  const download = page.waitForEvent("download");
  await dialog(page).getByRole("button", { name: "Download a template" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("inventory-template.csv");
  const text = await readFile(await file.path(), "utf8");
  expect(text).toBe(await readFile(new URL("../src/aws/import-template.csv", import.meta.url), "utf8"));
  const lines = text.trim().split("\n");
  expect(lines[0]).toBe("name,barcode,kind,price,cost,stock,pack_size");
  expect(lines).toHaveLength(4);
  expect(lines.slice(1).every((l) => l.startsWith("EXAMPLE "))).toBe(true);

  // Fed back unchanged, the file is sent as it is and the preview offers the import
  await choose(page, text, file.suggestedFilename());
  await expect(page.locator("#importResult")).toContainText("2 rows: 2 new, 0 to update, 0 unchanged.");
  await expect(dialog(page).getByRole("button", { name: "Import", exact: true })).toBeVisible();
  expect(backend.requests("POST", PATH).map((c) => c.body)).toEqual([{ dryRun: true, csv: text }]);
});

test("only owners see Import CSV", { tag: ["@J2.4"] }, async ({ page }) => {
  await openAws(page, new FakeBackend({ teams: [{ ...TEAM, role: "contributor" }] }));
  await connected(page);
  await expect(page.locator(".teambar").getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Import CSV" })).toHaveCount(0);
});

test("the preview shows company equipment without a price, and a change of kind", { tag: ["@J2.4", "@J13.1"] }, async ({ page }) => {
  const backend = new FakeBackend();
  backend.on("POST", PATH, ok({
    ...PREVIEW,
    rows: [{ line: 2, name: "Step ladder", barcode: "LAD-1", kind: "equipment", cost: 120, stock: 2, key: "LAD-1", action: "update", changes: ["kind", "price"] }],
    ignoredColumns: [],
    summary: { rows: 1, created: 0, updated: 1, unchanged: 0 },
  }));
  await openImport(page, backend);
  await choose(page, "name,barcode,kind,cost,stock,price\nStep ladder,LAD-1,equipment,120,2,\n");
  await expect(page.locator("#importResult tbody tr")).toHaveText(/Step ladder\s*LAD-1\s*Equipment\s*2\s*Update kind, price/);
});
