// J13 Take company equipment to a job and bring it back, against prod (supply-checkout-o60.7).
// Crew, on this browser project's long-lived team: adds a run-named item as company equipment
// (3 in storage), takes 2 to a run-named project, sees it listed apart and not charged, sees it
// in Inventory → Equipment → Out on jobs, returns 1, and at Finished Return says the last one was
// lost or broken (no charge), which closes the project. Cleanup deletes the item and project.
import { addToProject, createProject, enterBarcode, fillItem, finishReturn, goToInventory, goToProjects, inventoryRow, modal, openProject, saveItem, saveReturn, startAddItem, startReturn } from "../ui/index.js";
import { expect, test } from "./fixtures.mjs";
import { openTeam, runData } from "./steps.mjs";

const equipmentRow = (page, name) => page.locator("#projectBody table.equipment tbody tr", { hasText: name });
const finishBox = (page, i) => modal(page).locator(`fieldset.finish[data-i="${i}"]`);

test("crew takes company equipment to a job, sees where it is, and brings it back", { tag: ["@J13.1", "@J13.2", "@J13.3", "@J13.4", "@J13.5", "@prod"] }, async ({ page, signIn, harness, journeyTeam }, testInfo) => {
  test.setTimeout(180_000);
  const run = runData(harness, testInfo, "J13");
  const ladder = { code: run.code(1), name: run.name("ladder") };
  const client = run.name("Foxtrot");
  await signIn(page, "crew");
  await openTeam(page, journeyTeam);

  await test.step("J13.1 Mark an item as company equipment, with what it's worth", async () => {
    await goToInventory(page);
    await startAddItem(page);
    await modal(page).getByLabel("Company equipment (reused, not charged)").check();
    await expect(modal(page).getByLabel("Price each ($)")).toBeHidden();
    await fillItem(page, { barcode: ladder.code, name: ladder.name, stock: "3" });
    await modal(page).getByLabel("Value each ($)").fill("120");
    await saveItem(page);
    await expect(inventoryRow(page, ladder.name)).toContainText("Company equipment");
    await expect(inventoryRow(page, ladder.name).locator("td").nth(1)).toHaveText("3");
    await expect(inventoryRow(page, ladder.name).locator("td").nth(2)).toHaveText("Not charged");
  });

  await test.step("J13.2 Check it out on a project: listed apart, not charged", async () => {
    await goToProjects(page);
    await createProject(page, client);
    await enterBarcode(page, ladder.code);
    await expect(modal(page)).toContainText("Company equipment · not charged");
    await modal(page).locator("#fQty").fill("2");
    await addToProject(page, 2);
    await expect(page.locator("#projectBody")).toContainText("Equipment (not charged)");
    await expect(equipmentRow(page, ladder.name).locator("td").last()).toHaveText("2");
    await goToInventory(page);
    await expect(inventoryRow(page, ladder.name).locator("td").nth(1)).toHaveText("1");
  });

  await test.step("J13.5 See it in Inventory → Equipment → Out on jobs", async () => {
    await page.getByRole("button", { name: "Equipment", exact: true }).click();
    await page.getByRole("button", { name: "Out on jobs" }).click();
    const row = page.locator("#main table.out tbody tr", { hasText: ladder.name });
    await expect(row).toHaveCount(1);
    await expect(row.locator("td").nth(1)).toHaveText("2");
    await expect(row.locator("td").nth(2)).toContainText(client);
    // A row opens its project
    await row.click();
    await expect(page.getByRole("heading", { name: client })).toBeVisible();
  });

  await test.step("J13.3 Switch to Return and scan what came back", async () => {
    await startReturn(page);
    await enterBarcode(page, ladder.code);
    await expect(modal(page).locator("#sum")).toContainText("Returned 1 of 2");
    await saveReturn(page);
    await expect(page.locator("#toast")).toHaveText("1 returned · 1 of 2 back");
    await expect(equipmentRow(page, ladder.name).locator("td").last()).toHaveText("1");
  });

  await test.step("J13.4 Finished Return: the last one was lost or broken, and the project closes", async () => {
    await finishReturn(page);
    await expect(modal(page).getByRole("heading", { name: "Before you finish" })).toBeVisible();
    await expect(finishBox(page, 0).locator("legend")).toHaveText(`${ladder.name} · 1 still out`);
    const lost = finishBox(page, 0).getByLabel("Lost or broken", { exact: true });
    await lost.fill("1");
    await lost.dispatchEvent("input");
    await modal(page).getByRole("button", { name: "Save" }).click();
    await expect(page.locator("#toast")).toHaveText("Return finished");
    await expect(page.locator(".project-head .pill")).toHaveText("Returned");
    // The return put one back; the lost one didn't
    await goToInventory(page);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(inventoryRow(page, ladder.name).locator("td").nth(1)).toHaveText("2");
    // Nothing of it is out on a job any more
    await page.getByRole("button", { name: "Equipment", exact: true }).click();
    await page.getByRole("button", { name: "Out on jobs" }).click();
    await expect(page.locator("#main table.out tbody tr", { hasText: ladder.name })).toHaveCount(0);
  });

  // The closed project is under Returned
  await goToProjects(page);
  await page.getByRole("button", { name: "Returned", exact: true }).click();
  await openProject(page, client);
  await expect(page.locator(".project-head .pill")).toHaveText("Returned");
});
