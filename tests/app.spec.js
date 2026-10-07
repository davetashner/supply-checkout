import { test, expect, openApp, createProject, enterBarcode, modal, lineRow, inventoryRow } from "./helpers.js";
import { usedState } from "./fixtures.js";

test("creates a project recording client, date and who prepared it", { tag: ["@J4.1"] }, async ({ page }) => {
  await openApp(page);
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await createProject(page, "Acme Offices");
  await expect(page.locator(".project-head")).toContainText("Prepared by");
  await expect(page.locator(".project-head")).toContainText("Test User");
  await expect(page.locator(".project-head .pill")).toHaveText("Checked out");
});

test("checks out a new barcode, returns part of it, and finishes the return", { tag: ["@J4.1", "@J4.2", "@J4.3"] }, async ({ page }) => {
  await openApp(page);
  await test.step("J4.1 Create a project for the client", async () => {
    await createProject(page, "Acme Offices");
  });

  await test.step("J4.2 Scan an item and choose how many", async () => {
    await enterBarcode(page, "012345678905");
    await modal(page).getByLabel("Item name").fill("Nitrile gloves");
    await modal(page).getByLabel("Price each ($)").fill("12.50");
    await modal(page).locator("#fQty").fill("3");
    await modal(page).getByRole("button", { name: "Add 3 to project" }).click();

    await expect(lineRow(page, "Nitrile gloves")).toContainText("Barcode 012345678905");
    await expect(page.locator(".totals .charge")).toHaveText("$37.50");
  });

  await test.step("J4.3 Return what came back unused and finish the return", async () => {
    await page.getByRole("button", { name: "Return", exact: true }).click();
    await enterBarcode(page, "012345678905");
    await modal(page).locator("#fRet").fill("1");
    await modal(page).getByRole("button", { name: "Save return" }).click();

    await expect(page.locator(".totals")).toContainText("Returned1");
    await expect(page.locator(".totals .charge")).toHaveText("$25.00");

    await page.getByRole("button", { name: "Finished Return" }).click();
    await expect(page.locator(".project-head .pill")).toHaveText("Returned");
    await expect(page.locator("#scanbar")).toBeHidden();
  });
});

test("storage counts go down on checkout and back up on return", { tag: ["@J4.2", "@J4.3"] }, async ({ page }) => {
  await openApp(page, { seed: { "products/SKU1": { code: "SKU1", name: "Paper towels", price: 2, stock: 10 } } });
  await createProject(page, "Beta LLC");

  await enterBarcode(page, "SKU1");
  await expect(modal(page)).toContainText("In storage");
  await modal(page).locator("#fQty").fill("3");
  await modal(page).getByRole("button", { name: "Add 3 to project" }).click();
  await expect(lineRow(page, "Paper towels")).toBeVisible();

  await page.getByRole("button", { name: "Inventory" }).click();
  await expect(inventoryRow(page, "Paper towels").locator("td").nth(1)).toHaveText("7");

  await page.getByRole("button", { name: "Projects" }).click();
  await page.getByRole("button", { name: /Beta LLC/ }).click();
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await modal(page).locator("#fRet").fill("1");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(page.locator(".totals")).toContainText("Returned1");

  await page.getByRole("button", { name: "Inventory" }).click();
  await expect(inventoryRow(page, "Paper towels").locator("td").nth(1)).toHaveText("8");
});

test("adds an item that has no barcode", { tag: ["@J4.2"] }, async ({ page }) => {
  await openApp(page);
  await createProject(page, "Gamma Co");

  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  await modal(page).getByRole("button", { name: "+ New item" }).click();
  await modal(page).getByLabel("Item name").fill("Leftover bins");
  await modal(page).getByLabel("Price each ($)").fill("4");
  await modal(page).locator("#fQty").fill("3");
  await modal(page).getByRole("button", { name: "Add 3 to project" }).click();

  await expect(lineRow(page, "Leftover bins")).toContainText("No barcode");
  await expect(page.locator(".totals .charge")).toHaveText("$12.00");

  await page.getByRole("button", { name: "Inventory" }).click();
  await expect(inventoryRow(page, "Leftover bins")).toBeVisible();
});

test("receipt review merges duplicates and splits items between a client and storage", { tag: ["@J5.1", "@J5.2", "@J5.3"] }, async ({ page }) => {
  await openApp(page, {
    seed: { "products/nb-bins": { code: "", name: "Storage bins, 12 qt", price: 5, stock: 2 } },
    receipt: {
      store: "Hardware Co",
      date: "2026-09-20",
      items: [
        { raw: "STRG BIN 12QT", name: "Sterilite 12 qt storage bin", qty: 4, price: 5.5, match: "i1" },
        { raw: "PTR TAPE 1.88", name: "Painter's tape, 1.88 in", qty: 2, price: 6.25, match: null },
      ],
      subtotal: 34.5,
      tax: 2.4,
      total: 36.9,
    },
  });
  await test.step("J5.1 Scan a receipt photo", async () => {
    await expect(page.getByText("Scan receipt")).toBeVisible();
    await page.setInputFiles("#receiptFile", { name: "receipt.jpg", mimeType: "image/jpeg", buffer: Buffer.from("fake image") });

    await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
    const prompt = await page.evaluate(() => window.__mock.sampleCalls[0]);
    expect(prompt).toContain("i1 | Storage bins, 12 qt");
  });

  const bins = page.locator(".rline").nth(0);
  await test.step("J5.2 Check each line and its inventory match", async () => {
    await expect(bins).toContainText("Suggested match");
    await expect(bins).toContainText("Price changed");
    await bins.getByRole("button", { name: /Keep the client price/ }).click();
  });

  await test.step("J5.3 Assign the lines to a client and storage, and save", async () => {
    await page.locator(".rline").nth(0).locator('select[data-f="dest"]').selectOption({ label: "General inventory (storage)" });

    await page.getByLabel("Client name").fill("Delta Inc");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Delta Inc" })).toBeVisible();
    await expect(lineRow(page, "Painter's tape")).toContainText("$6.25");

    await page.getByRole("button", { name: "Inventory" }).click();
    const binsRow = inventoryRow(page, "Storage bins, 12 qt");
    await expect(binsRow.locator("td").nth(1)).toHaveText("6");
    await expect(binsRow.locator("td").nth(2)).toHaveText("$5.00");
    await expect(inventoryRow(page, "Painter's tape")).toBeVisible();
  });
});

test("exports a project as CSV", { tag: ["@J6.1", "@J6.2"] }, async ({ page }) => {
  await openApp(page, {
    seed: {
      "projects/s1": {
        client: "Echo Studio", date: "2026-09-24", createdBy: "u_test", createdAt: "2026-09-24T12:00:00Z", status: "open",
        items: { A1: { code: "A1", name: "Drop cloth", price: 8, out: 2, returned: 1 } },
      },
    },
  });
  await test.step("J6.1 Open the project", async () => {
    await page.getByRole("button", { name: /Echo Studio/ }).click();
  });
  await test.step("J6.2 Download CSV", async () => {
    await page.getByRole("button", { name: "Download CSV" }).click();
    const save = await page.evaluate(() => window.__mock.saves[0]);
    expect(save.filename).toBe("Echo Studio 2026-09-24.csv");
    expect(save.data).toContain("Prepared by,Test User");
    expect(save.data).toContain("Drop cloth,A1,8.00,2,1,1,8.00");
  });
});

test("view-only users can't make changes", { tag: ["@J9.1"] }, async ({ page }) => {
  await openApp(page, { canWrite: false });
  await expect(page.locator("#notice")).toContainText("view-only access");
  await expect(page.getByRole("button", { name: "+ New project" })).toHaveCount(0);
});

test("a runtime that says why the page is read-only (a closed team) shows that instead of the role's notice", { tag: ["@J9"] }, async ({ page }) => {
  await openApp(page, { canWrite: false, viewOnlyNotice: "This team is closed, so nothing in it can be changed." });
  await expect(page.locator("#notice")).toHaveText("This team is closed, so nothing in it can be changed.");
});

test("a runtime with nothing to say about it keeps the role's view-only notice", { tag: ["@J9"] }, async ({ page }) => {
  await openApp(page, { canWrite: false, viewOnlyNotice: null });
  await expect(page.locator("#notice")).toHaveText("You have view-only access. Ask the owner to give you Contributor access to scan and edit.");
});

test("a refused write says why from the runtime when it can", { tag: ["@J9"] }, async ({ page }) => {
  await openApp(page, { writeError: "invalid_argument", viewOnlyNotice: "An owner closed this team." });
  await expect(page.locator("#notice")).toBeHidden();
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Hotel Group");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.locator("#toast")).toHaveText("An owner closed this team.");
  await expect(page.locator("#notice")).toHaveText("An owner closed this team.");
});

test("returning the same item again adds to what's already been returned", { tag: ["@J4.3"] }, async ({ page }) => {
  await openApp(page, {
    seed: {
      "products/SKU1": { code: "SKU1", name: "Paper towels", price: 2, stock: 0 },
      "projects/s1": {
        client: "Kilo Kitchens", date: "2026-09-25", createdBy: "u_test", createdAt: "2026-09-25T12:00:00Z", status: "open",
        items: { SKU1: { code: "SKU1", name: "Paper towels", price: 2, out: 5, returned: 0 } },
      },
    },
  });
  await page.getByRole("button", { name: /Kilo Kitchens/ }).click();
  await page.getByRole("button", { name: "Return", exact: true }).click();

  await enterBarcode(page, "SKU1");
  await modal(page).locator("#fRet").fill("2");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(page.locator(".totals")).toContainText("Returned2");

  // Second return starts from what's left and adds to the count
  await enterBarcode(page, "SKU1");
  await expect(modal(page)).toContainText("5 taken · 2 back");
  await expect(modal(page).locator("#fRet")).toHaveAttribute("max", "3");
  await modal(page).locator("#fRet").fill("3");
  await expect(modal(page).locator("#sum")).toContainText("Returned 5 of 5");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(page.locator(".totals")).toContainText("Returned5");
  await expect(page.locator(".totals .charge")).toHaveText("$0.00");

  // Nothing left to return
  await enterBarcode(page, "SKU1");
  await expect(modal(page).getByRole("heading", { name: "Already returned" })).toBeVisible();
  await modal(page).getByRole("button", { name: "Close" }).click();

  // Both returns went back into storage
  await page.getByRole("button", { name: "Inventory" }).click();
  await expect(inventoryRow(page, "Paper towels").locator("td").nth(1)).toHaveText("5");
});

test("Enter on a project line or inventory row opens its editor and keeps it open", { tag: ["@J4"] }, async ({ page }) => {
  await openApp(page, usedState);
  await expect(page.locator("#notice")).toBeHidden();
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await lineRow(page, "Storage bins").press("Enter");
  await expect(modal(page).getByRole("heading", { name: "Storage bins, 12 qt" })).toBeVisible();
  await expect(page.locator("#toast")).toBeHidden();
  await modal(page).getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Inventory" }).click();
  await inventoryRow(page, "Paper towels").press("Enter");
  await expect(modal(page).getByRole("heading", { name: "Edit item" })).toBeVisible();
  await expect(page.locator("#toast")).toBeHidden();
});

test("inventory search matches barcodes in any case", { tag: ["@J2"] }, async ({ page }) => {
  await openApp(page, usedState);
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await page.getByRole("button", { name: "Add item without a barcode" }).click();
  await modal(page).getByLabel("Or pick from inventory").fill("sku1");
  await expect(modal(page).locator("#pick button")).toHaveCount(1);
  await expect(modal(page).locator("#pick")).toContainText("Paper towels");
});
