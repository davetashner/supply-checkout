// Saves that fail leave the screen as it was, so nothing is lost and the
// user can try again.
import { test, expect, openApp } from "./helpers.js";
import { modal, goToInventory, openProject, enterBarcode, addToProject, startReturn, saveReturn, lineRow, inventoryRow } from "./ui/index.js";
import { usedState, fakeImage } from "./fixtures.js";

const failing = { ...usedState, writeError: "unavailable" };
const failed = (page) => expect(page.locator("#toast")).toHaveText("That didn't save. Check your connection and try again.");
const openEcho = async (page, opts = failing) => {
  await openApp(page, opts);
  await openProject(page, "Echo Studio");
};

test("a failed project delete keeps the project open", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Delete project" }).click();
  await page.getByRole("button", { name: "Tap again to delete" }).click();
  await failed(page);
  await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
});

test("a failed edit keeps the edit form open", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Edit details" }).click();
  await modal(page).getByRole("button", { name: "Save" }).click();
  await failed(page);
  await expect(modal(page).getByRole("heading", { name: "Edit project" })).toBeVisible();
});

test("failed line edits keep the line editor open", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Paper towels").click();
  await modal(page).getByRole("button", { name: "Save" }).click();
  await failed(page);
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await failed(page);
  await expect(modal(page).getByRole("heading", { name: "Paper towels, 6 roll" })).toBeVisible();
});

test("an edit someone else saved over first closes the editor and says so", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page, { ...usedState, writeErrorFor: { prefix: "projects/", code: "aborted" } });
  await lineRow(page, "Paper towels").click();
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText("Someone else changed this just now, so your change wasn't saved. The latest is showing; make your change again if it's still needed.");
  await expect(modal(page)).toBeEmpty();
  await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
});

// `refused` is the web build's code for a checkout or return the API refused (src/aws/db.js)
test("a return refused for what's saved now closes the form and says why, not to check the connection", { tag: ["@J4.3"] }, async ({ page }) => {
  await openEcho(page, { ...usedState, writeErrorFor: { prefix: "projects/", code: "refused" } });
  await startReturn(page);
  await enterBarcode(page, "SKU1");
  await saveReturn(page);
  await expect(page.locator("#toast")).toHaveText("simulated refused");
  await expect(modal(page)).toBeEmpty();
});

test("any other refusal from the runtime keeps the form open with the usual message", { tag: ["@J4"] }, async ({ page }) => {
  await openEcho(page, { ...usedState, writeErrorFor: { prefix: "projects/", code: "failed_precondition" } });
  await startReturn(page);
  await enterBarcode(page, "SKU1");
  await saveReturn(page);
  await failed(page);
  await expect(modal(page).getByRole("button", { name: "Try again" })).toBeVisible();
});

test("a new item that can't be saved to inventory isn't added to the project", { tag: ["@J4.2"] }, async ({ page }) => {
  await openEcho(page, { ...usedState, writeErrorFor: { prefix: "products/", code: "unavailable" } });
  await enterBarcode(page, "NEW1");
  await modal(page).getByLabel("Item name").fill("Wax");
  await addToProject(page);
  await failed(page);
  await expect(lineRow(page, "Wax")).toHaveCount(0);
  await expect(modal(page).getByLabel("Item name")).toHaveValue("Wax");
});

test("a checkout that fails after saving a new item doesn't save the item again on retry", { tag: ["@J4.2"] }, async ({ page }) => {
  await openEcho(page, { ...usedState, writeErrorFor: { prefix: "projects/", code: "unavailable" } });
  await enterBarcode(page, "NEW1");
  await modal(page).getByLabel("Item name").fill("Wax");
  await addToProject(page);
  await failed(page);
  expect(await page.evaluate(() => window.__mock.docs.get("products/NEW1").name)).toBe("Wax");
  // Gone by the retry: if the retry saved it again, it would be back
  await page.evaluate(() => window.__mock.docs.delete("products/NEW1"));
  await page.locator("#toast").evaluate((t) => { t.hidden = true; });
  await modal(page).getByRole("button", { name: "Try again" }).click();
  await failed(page);
  expect(await page.evaluate(() => window.__mock.docs.has("products/NEW1"))).toBe(false);
});

test("a failed item delete keeps the item", { tag: ["@J2.3"] }, async ({ page }) => {
  await openApp(page, failing);
  await goToInventory(page);
  await inventoryRow(page, "Storage bins").click();
  await modal(page).getByRole("button", { name: "Delete" }).click();
  await modal(page).getByRole("button", { name: "Tap to delete" }).click();
  await failed(page);
  await expect(modal(page).getByRole("heading", { name: "Edit item" })).toBeVisible();
});

test("a new project from a receipt that fails to save stays in the review", { tag: ["@J5.3"] }, async ({ page }) => {
  await openApp(page, { ...usedState, writeErrorFor: { prefix: "projects/", code: "unavailable" } });
  await page.setInputFiles("#receiptFile", fakeImage);
  await page.getByLabel("Client name").fill("Alpha Two");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await failed(page);
  await expect(page.locator(".rline")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Alpha Two/ })).toHaveCount(0);
});

test("a download rejected without an error is treated as cancelled", { tag: ["@J6.2"] }, async ({ page }) => {
  await openEcho(page, { ...usedState, downloadError: "bare" });
  await page.getByRole("button", { name: "Download CSV" }).click();
  await expect(page.locator("#toast")).toBeHidden();
});
