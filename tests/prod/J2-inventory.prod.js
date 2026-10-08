// J2 Set up the inventory, against prod (supply-checkout-o60.7). The long-lived owner, on this
// browser project's long-lived team: adds a run-named item, edits it and deletes it, imports a
// 3-line CSV of run-named items (which cleanup deletes), and sets the equipment markup in Team
// settings, then puts the team's own value back.
//
// The markup is the one team setting a run changes. The test sets it to MARKUP_SENTINEL, a value
// only it uses, and puts back the value it found through the API in a finally, whatever happened
// on the page. If the run dies before that, cleanup (scripts/journeys/cleanup.mjs) puts a sentinel
// markup back to the journey teams' baseline, and so does the next run of this test.
import { MARKUP_SENTINEL, BASELINE_MARKUP } from "../../scripts/journeys/lib/settings.mjs";
import { fillItem, goToInventory, inventoryRow, modal, saveItem, startAddItem } from "../ui/index.js";
import { expect, test } from "./fixtures.mjs";
import { apiCall, openTeam, runData, watchBearer } from "./steps.mjs";

const teambarButton = (page, name) => page.locator(".teambar").getByRole("button", { name });

test("the owner adds, edits and deletes an item, imports a CSV, and sets the equipment markup", { tag: ["@J2.1", "@J2.2", "@J2.3", "@J2.4", "@J2.5", "@prod"] }, async ({ page, signIn, harness, journeyTeam }, testInfo) => {
  // The owner's sign-in may wait for a two-step code no other sign-in of this run has used
  test.setTimeout(210_000);
  const run = runData(harness, testInfo, "J2");
  const added = { code: run.code(1), name: run.name("glass cleaner"), renamed: run.name("glass cleaner 1 gal") };
  const imported = [2, 3, 4].map((i) => ({ code: run.code(i), name: run.name(`imported ${i}`) }));
  const bearer = watchBearer(page, harness);
  await signIn(page, "owner");
  await openTeam(page, journeyTeam);

  await test.step("J2.1 Open Inventory, tap + Add item", async () => {
    await goToInventory(page);
    await startAddItem(page);
    await expect(modal(page).getByRole("heading", { name: "Add item" })).toBeVisible();
  });

  await test.step("J2.2 Type a barcode, then the name, price and how many are in storage", async () => {
    await fillItem(page, { barcode: added.code, name: added.name, stock: "6" });
    await modal(page).getByLabel("Price each ($)").fill("4.5");
    await saveItem(page);
    const row = inventoryRow(page, added.name);
    await expect(row).toContainText(`Barcode ${added.code}`);
    await expect(row.locator("td").nth(1)).toHaveText("6");
    await expect(row.locator("td").nth(2)).toHaveText("$4.50");
  });

  await test.step("J2.3 Edit the item by tapping its row, then delete it", async () => {
    await inventoryRow(page, added.name).click();
    await expect(modal(page).getByRole("heading", { name: "Edit item" })).toBeVisible();
    await modal(page).getByLabel("Item name").fill(added.renamed);
    await modal(page).getByLabel("Price each ($)").fill("5");
    await saveItem(page);
    await expect(inventoryRow(page, added.renamed).locator("td").nth(2)).toHaveText("$5.00");
    await inventoryRow(page, added.renamed).click();
    await modal(page).getByRole("button", { name: "Delete" }).click();
    await modal(page).getByRole("button", { name: "Tap to delete" }).click();
    await expect(page.locator("#toast")).toHaveText("Item deleted");
    await expect(inventoryRow(page, added.renamed)).toHaveCount(0);
  });

  await test.step("J2.4 Import CSV: the file is checked, previewed and imported", async () => {
    const csv = ["name,barcode,price,stock", ...imported.map((it, i) => `${it.name},${it.code},${i + 1}.25,${i + 2}`)].join("\n") + "\n";
    await teambarButton(page, "Import CSV").click();
    await expect(modal(page).getByRole("heading", { name: "Import inventory" })).toBeVisible();
    await page.getByLabel("CSV file").setInputFiles({ name: "inventory.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await expect(page.locator("#importResult")).toContainText("3 rows: 3 new, 0 to update, 0 unchanged.");
    await expect(page.locator("#importResult tbody tr")).toHaveCount(3);
    await modal(page).getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(page.locator("#toast")).toHaveText("Imported: 3 new, 0 updated");
    for (const [i, it] of imported.entries()) {
      await expect(inventoryRow(page, it.name).locator("td").nth(1)).toHaveText(String(i + 2));
      await expect(inventoryRow(page, it.name).locator("td").nth(2)).toHaveText(`$${i + 1}.25`);
    }
  });

  await test.step("J2.5 Set the markup on company equipment in Team settings, then put it back", async () => {
    const token = await bearer();
    const settingsPath = `/teams/${encodeURIComponent(journeyTeam)}/settings`;
    const before = await apiCall(page, token, "GET", settingsPath);
    expect(before.status, "the owner reads the team's settings").toBe(200);
    const found = before.body?.settings?.equipmentMarkup ?? BASELINE_MARKUP;
    // A sentinel left by a run that died here is put back to the baseline, not kept
    const original = found === MARKUP_SENTINEL ? BASELINE_MARKUP : found;
    try {
      await teambarButton(page, "Team settings").click();
      const field = modal(page).getByLabel("Markup on company equipment bought for a client (%)");
      await expect(field).toHaveValue(String(found));
      await field.fill(String(MARKUP_SENTINEL));
      await modal(page).getByRole("button", { name: "Save" }).click();
      await expect(page.locator("#toast")).toHaveText(`Saved: ${MARKUP_SENTINEL}% on equipment bought for clients`);
      await teambarButton(page, "Team settings").click();
      await expect(field).toHaveValue(String(MARKUP_SENTINEL));
      await modal(page).getByRole("button", { name: "Cancel" }).click();
    } finally {
      const now = await apiCall(page, token, "GET", settingsPath);
      if ((now.body?.settings?.equipmentMarkup ?? BASELINE_MARKUP) !== original) {
        const put = await apiCall(page, token, "PUT", settingsPath, { equipmentMarkup: original, expectedVersion: now.body?.version ?? 0 });
        expect(put.status, "the team's own markup is put back").toBe(200);
      }
    }
  });
});
