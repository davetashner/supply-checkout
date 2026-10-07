// J9 A viewer can see but not change, against prod (supply-checkout-o60.7). Crew, in a context of
// its own, makes a run-named item and project on this browser project's long-lived team; the
// long-lived viewer sees both, with no scan, edit, delete or receipt controls, and one write made
// straight to the API with the viewer's own token is refused (403 view_only). Were it ever
// accepted, it would only make a run-named item, which cleanup deletes.
import { addItem, addToProject, createProject, enterBarcode, goToInventory, goToProjects, inventoryRow, lineRow, openProject } from "../ui/index.js";
import { expect, test } from "./fixtures.mjs";
import { apiCall, openTeam, runData, secondPage, watchBearer } from "./steps.mjs";

test("a viewer sees projects and inventory, gets no controls to change them, and the server refuses a write", { tag: ["@J9.1", "@prod"] }, async ({ page, signIn, harness, journeyTeam, browser }, testInfo) => {
  test.setTimeout(150_000);
  const run = runData(harness, testInfo, "J9");
  const item = { code: run.code(1), name: run.name("towels") };
  const client = run.name("Delta");

  // Crew, on another phone: something to look at
  const crew = await secondPage({ browser, harness, signIn, testInfo }, "crew");
  try {
    await openTeam(crew.page, journeyTeam);
    await goToInventory(crew.page);
    await addItem(crew.page, { barcode: item.code, name: item.name, stock: "4" });
    await expect(inventoryRow(crew.page, item.name)).toBeVisible();
    await goToProjects(crew.page);
    await createProject(crew.page, client);
    await enterBarcode(crew.page, item.code);
    await addToProject(crew.page, 1);
    await expect(lineRow(crew.page, item.name)).toBeVisible();
  } finally {
    await crew.close();
  }

  const bearer = watchBearer(page, harness);
  await signIn(page, "viewer");
  await openTeam(page, journeyTeam);

  await test.step("J9.1 Open projects and inventory: everything shows, nothing can be changed", async () => {
    await expect(page.locator("#notice")).toContainText("view-only access");
    await goToProjects(page);
    await expect(page.getByRole("button", { name: "+ New project" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Quick take" })).toHaveCount(0);
    await expect(page.getByText("Scan receipt")).toHaveCount(0);
    await openProject(page, client);
    await expect(page.getByRole("heading", { name: client })).toBeVisible();
    await expect(lineRow(page, item.name)).toBeVisible();
    await expect(page.locator("#scanbar")).toBeHidden();
    await expect(page.getByRole("button", { name: "Edit details" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Finished Return" })).toHaveCount(0);
    await lineRow(page, item.name).click();
    await expect(page.locator("#overlay")).toBeHidden();

    await goToInventory(page);
    await expect(inventoryRow(page, item.name).locator("td").nth(1)).toHaveText("3");
    await expect(page.getByRole("button", { name: "+ Add item" })).toHaveCount(0);
    await inventoryRow(page, item.name).click();
    await expect(page.locator("#overlay")).toBeHidden();
  });

  await test.step("J9.1 The server refuses a write made with the viewer's own token", async () => {
    const token = await bearer();
    const code = run.code(2);
    const res = await apiCall(page, token, "PUT", `/teams/${encodeURIComponent(journeyTeam)}/products/${encodeURIComponent(code)}`, {
      data: { code, name: run.name("refused"), price: 1 },
      expectedVersion: 0,
    });
    expect(res.status, "a viewer's write answers 403").toBe(403);
    expect(res.body?.error?.reason).toBe("view_only");
  });
});
