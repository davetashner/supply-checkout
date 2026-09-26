// Saves that fail leave the screen as it was, so nothing is lost and the
// user can try again.
import { test, expect, openApp, enterBarcode, modal, lineRow, inventoryRow } from "./helpers.js";
import { usedState, fakeImage } from "./fixtures.js";

const failing = { ...usedState, writeError: "unavailable" };
const failed = (page) => expect(page.locator("#toast")).toHaveText("That didn't save. Check your connection and try again.");
const openEcho = async (page, opts = failing) => {
  await openApp(page, opts);
  await page.getByRole("button", { name: /Echo Studio/ }).click();
};

test("a failed sheet delete keeps the sheet open", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Delete sheet" }).click();
  await page.getByRole("button", { name: "Tap again to delete" }).click();
  await failed(page);
  await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
});

test("a failed edit keeps the edit form open", async ({ page }) => {
  await openEcho(page);
  await page.getByRole("button", { name: "Edit details" }).click();
  await modal(page).getByRole("button", { name: "Save" }).click();
  await failed(page);
  await expect(modal(page).getByRole("heading", { name: "Edit sheet" })).toBeVisible();
});

test("failed line edits keep the line editor open", async ({ page }) => {
  await openEcho(page);
  await lineRow(page, "Paper towels").click();
  await modal(page).getByRole("button", { name: "Save" }).click();
  await failed(page);
  await modal(page).getByRole("button", { name: "Remove" }).click();
  await modal(page).getByRole("button", { name: "Tap to remove" }).click();
  await failed(page);
  await expect(modal(page).getByRole("heading", { name: "Paper towels, 6 roll" })).toBeVisible();
});

test("an edit someone else saved over first closes the editor and says so", async ({ page }) => {
  await openEcho(page, { ...usedState, writeErrorFor: { prefix: "sheets/", code: "aborted" } });
  await lineRow(page, "Paper towels").click();
  await modal(page).getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toHaveText("Someone else changed this just now, so your change wasn't saved. The latest is showing; make your change again if it's still needed.");
  await expect(modal(page)).toBeEmpty();
  await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
});

test("a return refused for what's saved now closes the form and says why, not to check the connection", async ({ page }) => {
  await openEcho(page, { ...usedState, writeErrorFor: { prefix: "sheets/", code: "failed_precondition" } });
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await enterBarcode(page, "SKU1");
  await modal(page).getByRole("button", { name: "Save return" }).click();
  await expect(page.locator("#toast")).toHaveText("simulated failed_precondition");
  await expect(modal(page)).toBeEmpty();
});

test("a new item that can't be saved to inventory isn't added to the sheet", async ({ page }) => {
  await openEcho(page, { ...usedState, writeErrorFor: { prefix: "products/", code: "unavailable" } });
  await enterBarcode(page, "NEW1");
  await modal(page).getByLabel("Item name").fill("Wax");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await failed(page);
  await expect(lineRow(page, "Wax")).toHaveCount(0);
  await expect(modal(page).getByLabel("Item name")).toHaveValue("Wax");
});

test("a checkout that fails after saving a new item doesn't save the item again on retry", async ({ page }) => {
  await openEcho(page, { ...usedState, writeErrorFor: { prefix: "sheets/", code: "unavailable" } });
  await enterBarcode(page, "NEW1");
  await modal(page).getByLabel("Item name").fill("Wax");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await failed(page);
  expect(await page.evaluate(() => window.__mock.docs.get("products/NEW1").name)).toBe("Wax");
  // Gone by the retry: if the retry saved it again, it would be back
  await page.evaluate(() => window.__mock.docs.delete("products/NEW1"));
  await page.locator("#toast").evaluate((t) => { t.hidden = true; });
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await failed(page);
  expect(await page.evaluate(() => window.__mock.docs.has("products/NEW1"))).toBe(false);
});

test("a failed item delete keeps the item", async ({ page }) => {
  await openApp(page, failing);
  await page.getByRole("button", { name: "Inventory" }).click();
  await inventoryRow(page, "Storage bins").click();
  await modal(page).getByRole("button", { name: "Delete" }).click();
  await modal(page).getByRole("button", { name: "Tap to delete" }).click();
  await failed(page);
  await expect(modal(page).getByRole("heading", { name: "Edit item" })).toBeVisible();
});

test("a new sheet from a receipt that fails to save stays in the review", async ({ page }) => {
  await openApp(page, { ...usedState, writeErrorFor: { prefix: "sheets/", code: "unavailable" } });
  await page.setInputFiles("#receiptFile", fakeImage);
  await page.getByLabel("Client name").fill("Alpha Two");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await failed(page);
  await expect(page.locator(".rline")).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Alpha Two/ })).toHaveCount(0);
});

test("a download rejected without an error is treated as cancelled", async ({ page }) => {
  await openEcho(page, { ...usedState, downloadError: "bare" });
  await page.getByRole("button", { name: "Download CSV" }).click();
  await expect(page.locator("#toast")).toBeHidden();
});
