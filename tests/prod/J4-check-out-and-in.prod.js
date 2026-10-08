// J4 Check supplies out and back in, against prod (supply-checkout-o60.7). Crew, on this browser
// project's long-lived team, with two run-named items (never real-looking stock): creates a
// run-named project, checks one item out by typed barcode and the other with the stand-in camera
// (tests/camera.js on the live page), returns part, and taps Finished Return; the storage counts
// follow. A second person (the long-lived viewer, in a context of their own) watches the
// project list and sees the checkout within 2 seconds. Everything is deleted by cleanup.
import { installCamera } from "../camera.js";
import { addItem, addToProject, createProject, enterBarcode, finishReturn, goToInventory, goToProjects, inventoryRow, lineRow, modal, saveReturn, startReturn } from "../ui/index.js";
import { expect, test } from "./fixtures.mjs";
import { cameraScript, openTeam, runData, secondPage } from "./steps.mjs";

test("crew checks supplies out by barcode and camera, returns part and finishes, and another phone sees it live", { tag: ["@J4.1", "@J4.2", "@J4.3", "@prod"] }, async ({ page, signIn, harness, journeyTeam, browser }, testInfo) => {
  test.setTimeout(180_000);
  const run = runData(harness, testInfo, "J4");
  const typed = { code: run.code(1), name: run.name("towels") };
  const scanned = { code: run.code(2), name: run.name("gloves") };
  const client = run.name("Acme");
  // The stand-in camera reads the scanned item's barcode; it's in place before the app loads
  await page.addInitScript(cameraScript(installCamera, { detector: [[{ rawValue: scanned.code, format: "code_128" }]] }));

  await signIn(page, "crew");
  await openTeam(page, journeyTeam);
  // The run's own stock: 10 of each
  await goToInventory(page);
  for (const item of [typed, scanned]) {
    await addItem(page, { barcode: item.code, name: item.name, stock: "10" });
    await expect(inventoryRow(page, item.name).locator("td").nth(1)).toHaveText("10");
  }

  // Another person on another phone, on the project list
  const other = await secondPage({ browser, harness, signIn, testInfo }, "viewer");
  try {
    await openTeam(other.page, journeyTeam);
    await goToProjects(page);

    await test.step("J4.1 Create a project for the client", async () => {
      await createProject(page, client);
      await expect(page.locator(".project-head .pill")).toHaveText("Checked out");
    });

    await test.step("J4.2 Type one barcode and scan the other with the camera, and choose how many", async () => {
      await enterBarcode(page, typed.code);
      await expect(modal(page)).toContainText("In storage");
      await modal(page).locator("#fQty").fill("3");
      await addToProject(page, 3);
      await expect(lineRow(page, typed.name)).toBeVisible();
      // The other phone's project list shows it within 2 seconds
      const card = other.page.getByRole("button", { name: new RegExp(client) });
      await expect(card, "the other phone sees the checkout within 2 seconds").toContainText("3 taken", { timeout: 2_000 });

      await page.getByText("Scan to check out").click();
      await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
      await expect(modal(page)).toContainText(scanned.name);
      await addToProject(page, 1);
      await expect(lineRow(page, scanned.name)).toBeVisible();
      await expect(page.locator("#projectBody .totals")).toContainText("Taken4");
    });

    await test.step("J4.3 Return what came back unused, and tap Finished Return", async () => {
      await startReturn(page);
      await enterBarcode(page, typed.code);
      await modal(page).locator("#fRet").fill("1");
      await saveReturn(page);
      await expect(page.locator("#projectBody .totals")).toContainText("Returned1");
      await enterBarcode(page, scanned.code);
      await modal(page).locator("#fRet").fill("1");
      await saveReturn(page);
      await expect(page.locator("#projectBody .totals")).toContainText("Returned2");
      await finishReturn(page);
      await expect(page.locator(".project-head .pill")).toHaveText("Returned");
      await expect(page.locator("#scanbar")).toBeHidden();
    });

    await test.step("J4.2 and J4.3 Storage counts went down on checkout and back up on return", async () => {
      await goToInventory(page);
      await expect(inventoryRow(page, typed.name).locator("td").nth(1)).toHaveText("8");
      await expect(inventoryRow(page, scanned.name).locator("td").nth(1)).toHaveText("10");
    });
  } finally {
    await other.close();
  }
});
