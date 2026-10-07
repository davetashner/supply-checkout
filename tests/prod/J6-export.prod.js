// J6 Export a project to bill a client, against prod (supply-checkout-o60.7). On this browser
// project's long-lived team, crew makes a finished run-named project (a run-named item, 3 taken,
// 1 back), then opens it and downloads its CSV: named after the client and date, with the item's
// price, taken, returned, used and charge, and a total row. Cleanup deletes the project and item.
import { addToProject, createProject, enterBarcode, finishReturn, fillItem, goToInventory, goToProjects, inventoryRow, modal, openProject, saveReturn, startAddItem, startReturn, saveItem } from "../ui/index.js";
import { expect, test } from "./fixtures.mjs";
import { download, openTeam, runData } from "./steps.mjs";

test("a finished project downloads as the client's CSV", { tag: ["@J6.1", "@J6.2", "@prod"] }, async ({ page, signIn, harness, journeyTeam }, testInfo) => {
  test.setTimeout(150_000);
  const run = runData(harness, testInfo, "J6");
  const item = { code: run.code(1), name: run.name("drop cloth") };
  const client = run.name("Echo");
  await signIn(page, "crew");
  await openTeam(page, journeyTeam);

  // A finished project to bill: 3 drop cloths at $8 taken, 1 back
  await goToInventory(page);
  await startAddItem(page);
  await fillItem(page, { barcode: item.code, name: item.name, stock: "5" });
  await modal(page).getByLabel("Price each ($)").fill("8");
  await saveItem(page);
  await expect(inventoryRow(page, item.name).locator("td").nth(2)).toHaveText("$8.00");
  await goToProjects(page);
  await createProject(page, client);
  await enterBarcode(page, item.code);
  await modal(page).locator("#fQty").fill("3");
  await addToProject(page, 3);
  await startReturn(page);
  await enterBarcode(page, item.code);
  await modal(page).locator("#fRet").fill("1");
  await saveReturn(page);
  await finishReturn(page);
  await expect(page.locator(".project-head .pill")).toHaveText("Returned");

  await test.step("J6.1 Open the finished project", async () => {
    await goToProjects(page);
    await page.getByRole("button", { name: "Returned", exact: true }).click();
    await openProject(page, client);
    await expect(page.getByRole("heading", { name: client })).toBeVisible();
  });

  await test.step("J6.2 Download CSV", async () => {
    const { filename, text } = await download(page, page.getByRole("button", { name: "Download CSV" }));
    const rows = text.split("\n");
    const date = /^Date,(\d{4}-\d\d-\d\d)$/.exec(rows[1])?.[1];
    expect(rows[0]).toBe(`Client,${client}`);
    expect(date, "the CSV's date row").toBeTruthy();
    expect(filename).toBe(`${client} ${date}.csv`);
    expect(rows).toContain("Status,Returned");
    expect(rows).toContain("Item,Barcode,Price each,Taken,Returned,Used,Charge");
    expect(rows).toContain(`${item.name},${item.code},8.00,3,1,2,16.00`);
    expect(rows.at(-1)).toBe("Total,,,3,1,2,16.00");
  });
});
