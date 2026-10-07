import { test, expect, openApp, modal } from "./helpers.js";
import { usedState, fakeImage } from "./fixtures.js";

test("explains when shared storage isn't available", async ({ page }) => {
  await openApp(page, { unavailable: ["db"] });
  await expect(page.locator("#notice")).toContainText("Shared storage isn't available");
});

test("hides receipt scanning when Claude can't be used from the page", { tag: ["@J5"] }, async ({ page }) => {
  await openApp(page, { ...usedState, unavailable: ["sample"] });
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
  await expect(page.getByText("Scan receipt")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ New project" })).toBeVisible();
});

test("hides CSV download when downloads aren't available", { tag: ["@J6"] }, async ({ page }) => {
  await openApp(page, { ...usedState, unavailable: ["downloads"] });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await expect(page.locator("#projectBody tbody tr")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(0);
});

test("a failed receipt read explains why and offers manual entry", { tag: ["@J5.1"] }, async ({ page }) => {
  await openApp(page, { ...usedState, sampleError: "rate_limited" });
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.getByRole("heading", { name: "Couldn't read that receipt" })).toBeVisible();
  await expect(page.getByText("Too many requests right now")).toBeVisible();

  await page.getByRole("button", { name: "Enter items by hand" }).click();
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
  await expect(page.locator(".rline")).toHaveCount(1);
});

test("a photo with no line items asks for a better photo", { tag: ["@J5.1"] }, async ({ page }) => {
  await openApp(page, { ...usedState, receipt: { items: [] } });
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.getByText("No line items were found in that photo")).toBeVisible();
});

test("an unfinished receipt review survives a reload", { tag: ["@J5.2"] }, async ({ page }) => {
  await openApp(page, usedState);
  await page.setInputFiles("#receiptFile", fakeImage);
  await page.getByLabel("Client name").fill("Foxtrot Ltd");
  await page.reload();
  await page.getByRole("button", { name: "Continue review" }).click();
  await expect(page.getByLabel("Client name")).toHaveValue("Foxtrot Ltd");
  await expect(page.locator(".rline")).toHaveCount(2);
});

test("a full database is reported and nothing is lost from the form", { tag: ["@J4"] }, async ({ page }) => {
  await openApp(page, { writeError: "quota_exceeded" });
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Golf Club");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.locator("#toast")).toContainText("Storage is full");
  await expect(modal(page).getByLabel("Client", { exact: true })).toHaveValue("Golf Club");
});

test("a permission failure switches the page to view-only", { tag: ["@J9.1"] }, async ({ page }) => {
  await openApp(page, { writeError: "invalid_argument" });
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Hotel Group");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.locator("#toast")).toHaveText("You have view-only access. Ask the owner for Contributor access to make changes.");
  await expect(page.locator("#notice")).toContainText("view-only access");
});
