// J14 Take supplies without a job, against prod (supply-checkout-o60.7). Crew, on this browser
// project's long-lived team, with a run-named item and project: Quick take onto General Use (no
// job), Return from the project list, move the line to the run's project, and Finished Return on
// General Use, so the next run starts with none open. Cleanup deletes the item, the project and
// the General Use project (every line on it is the run's).
import { addItem, createProject, goToInventory, goToProjects, inventoryRow, lineRow, modal, saveReturn, startReturn, finishReturn } from "../ui/index.js";
import { expect, test } from "./fixtures.mjs";
import { openTeam, runData } from "./steps.mjs";

const card = (page, name) => page.locator("#main .project-card", { hasText: name });
const GENERAL_USE = "General Use (no job)";
async function typeCode(page, code) {
  await modal(page).getByPlaceholder("Or type the barcode").fill(code);
  await modal(page).getByPlaceholder("Or type the barcode").press("Enter");
}

test("crew takes supplies without a job, returns some, moves the rest to a client, and finishes General Use", { tag: ["@J14.1", "@J14.2", "@J14.3", "@J14.4", "@prod"] }, async ({ page, signIn, harness, journeyTeam }, testInfo) => {
  test.setTimeout(180_000);
  const run = runData(harness, testInfo, "J14");
  const gloves = { code: run.code(1), name: run.name("gloves") };
  const client = run.name("Golf");
  await signIn(page, "crew");
  await openTeam(page, journeyTeam);
  await goToInventory(page);
  await addItem(page, { barcode: gloves.code, name: gloves.name, stock: "10" });
  await expect(inventoryRow(page, gloves.name).locator("td").nth(1)).toHaveText("10");
  await goToProjects(page);
  // The client project the line will move to, then back to the list
  await createProject(page, client);
  await page.getByRole("button", { name: "← All projects", exact: true }).first().click();

  await test.step("J14.1 Quick take: scan what you're taking, and how many", async () => {
    await page.getByRole("button", { name: "Quick take", exact: true }).click();
    await typeCode(page, gloves.code);
    await expect(modal(page).locator("h2")).toHaveText("Quick take");
    for (let i = 1; i < 3; i++) await modal(page).locator("[data-step='1']").click();
    await modal(page).getByRole("button", { name: "Take 3", exact: true }).click();
    await expect(page.locator("#toast")).toHaveText(`Took 3 × ${gloves.name} (General Use)`);
    await expect(page.locator("#main .project-card").first()).toHaveClass(/adhoc/);
    await expect(card(page, GENERAL_USE)).toBeVisible();
    await expect(card(page, GENERAL_USE)).not.toContainText("$");
    await goToInventory(page);
    await expect(inventoryRow(page, gloves.name).locator("td").nth(1)).toHaveText("7");
    await goToProjects(page);
  });

  await test.step("J14.2 Return from the project list: it goes back to General Use", async () => {
    await startReturn(page);
    await typeCode(page, gloves.code);
    await expect(modal(page).locator("h2")).toHaveText(new RegExp(`^Return to ${GENERAL_USE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    await saveReturn(page);
    await expect(page.locator("#toast")).toHaveText("1 returned · 1 of 3 back");
    await goToInventory(page);
    await expect(inventoryRow(page, gloves.name).locator("td").nth(1)).toHaveText("8");
    await goToProjects(page);
  });

  await test.step("J14.3 Open General Use, tap the line and move it to the client's project", async () => {
    await card(page, GENERAL_USE).click();
    await expect(page.locator(".project-head h2")).toHaveText(GENERAL_USE);
    await lineRow(page, gloves.name).click();
    const pick = modal(page).getByLabel("Project", { exact: true });
    const value = await pick.locator("option", { hasText: client }).getAttribute("value");
    expect(value, "the run's project is offered").toBeTruthy();
    await pick.selectOption(value);
    await modal(page).getByRole("button", { name: "Move", exact: true }).click();
    await expect(page.locator("#toast")).toHaveText(`Moved to ${client}`);
    await expect(lineRow(page, gloves.name)).toHaveCount(0);
    // Moving doesn't move stock
    await goToInventory(page);
    await expect(inventoryRow(page, gloves.name).locator("td").nth(1)).toHaveText("8");
    await goToProjects(page);
    await card(page, client).click();
    await expect(lineRow(page, gloves.name)).toBeVisible();
    await page.getByRole("button", { name: "← All projects", exact: true }).first().click();
  });

  await test.step("J14.4 Finished Return on General Use: the next quick take starts a new one", async () => {
    await card(page, GENERAL_USE).click();
    await finishReturn(page);
    await expect(page.locator(".project-head .pill")).toHaveText("Returned");
    await goToProjects(page);
    await expect(card(page, GENERAL_USE)).toHaveCount(0);
  });
});
