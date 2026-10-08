// J15 Reorder before running out, against prod (supply-checkout-o60.7). Crew, on this browser
// project's long-lived team, with a run-named item (5 in storage): sets Reorder at 3 and Usual
// order 12, takes 3 on a run-named project so it's Low, acknowledges it, downloads the reorder
// list, marks it ordered and cancels the order. Other items in the team may be low too, so the
// assertions look only at the run's own row. Cleanup deletes the item and project.
import { addItem, addToProject, createProject, enterBarcode, goToInventory, goToProjects, inventoryRow, modal } from "../ui/index.js";
import { expect, test } from "./fixtures.mjs";
import { download, openTeam, runData } from "./steps.mjs";

const lowChip = (page) => page.getByRole("button", { name: /^Running low/ });

test("crew sets a reorder level, sees the item low, acknowledges it, and marks it ordered", { tag: ["@J15.1", "@J15.2", "@J15.3", "@J15.4", "@prod"] }, async ({ page, signIn, harness, journeyTeam }, testInfo) => {
  test.setTimeout(180_000);
  const run = runData(harness, testInfo, "J15");
  const item = { code: run.code(1), name: run.name("bins") };
  const client = run.name("Hotel");
  await signIn(page, "crew");
  await openTeam(page, journeyTeam);
  await goToInventory(page);
  await addItem(page, { barcode: item.code, name: item.name, stock: "5" });
  await expect(inventoryRow(page, item.name).locator("td").nth(1)).toHaveText("5");

  await test.step("J15.1 Tap the item and set Reorder at and Usual order", async () => {
    await inventoryRow(page, item.name).click();
    await expect(modal(page).getByRole("heading", { name: "Edit item" })).toBeVisible();
    await modal(page).getByLabel("Reorder at (optional)").fill("3");
    await modal(page).getByLabel("Usual order (optional)").fill("12");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    await expect(inventoryRow(page, item.name).locator(".low-badge")).toHaveCount(0);
  });

  await test.step("J15.2 Take it to its reorder level: it shows Low, and the Inventory tab counts it", async () => {
    await goToProjects(page);
    await createProject(page, client);
    await enterBarcode(page, item.code);
    await modal(page).locator("#fQty").fill("2");
    await addToProject(page, 2);
    await goToInventory(page);
    await expect(inventoryRow(page, item.name).locator("td").nth(1)).toHaveText("3");
    await expect(inventoryRow(page, item.name).locator(".low-badge")).toHaveText("Low");
    await expect(page.locator("#tab-prices")).toHaveAccessibleName(/^Inventory, \d+ running low$/);
    await expect(lowChip(page)).toHaveText(/^Running low \(\d+\)$/);
  });

  const row = page.locator("#main table.reorder tbody tr", { hasText: item.name });
  await test.step("J15.3 Open Running low, download the list, and acknowledge the item", async () => {
    await lowChip(page).click();
    await expect(row).toHaveCount(1);
    await expect(row.locator("td").nth(1)).toHaveText("3");
    await expect(row.locator("td").nth(2)).toHaveText("3");
    await expect(row.locator("td").nth(3)).toHaveText("12");
    const list = await download(page, page.getByRole("button", { name: "Download CSV" }));
    expect(list.filename).toBe("Reorder list.csv");
    expect(list.text.split("\n")[0]).toMatch(/^Item,(Brand,)?Barcode,In storage,Reorder at,Usual order,Status$/);
    expect(list.text).toContain(`${item.name},`);
    await page.getByRole("button", { name: `Acknowledge ${item.name}` }).click();
    await expect(page.locator("#toast")).toContainText("Acknowledged. It's flagged again if stock falls below 3.");
    await expect(row.locator("td").nth(4)).toContainText("Acknowledged");
  });

  await test.step("J15.4 Mark it ordered, then cancel the order", async () => {
    await page.getByRole("button", { name: `Mark ordered: ${item.name}` }).click();
    await expect(modal(page).getByRole("heading", { name: "Mark ordered" })).toBeVisible();
    await expect(modal(page).getByLabel("How many ordered")).toHaveValue("12");
    await modal(page).getByRole("button", { name: "Mark ordered" }).click();
    await expect(page.locator("#toast")).toHaveText("Marked 12 ordered");
    await expect(row.locator("td").nth(4)).toContainText("On order: 12 since");
    await page.getByRole("button", { name: `Cancel the order of ${item.name}` }).click();
    await expect(page.locator("#toast")).toHaveText("Order cancelled. It's flagged again while it's low.");
    await expect(row.locator("td").nth(4)).not.toContainText("On order");
  });
});
