import { test, expect, openApp, modal } from "./helpers.js";
import { usedState, fakeImage } from "./fixtures.js";

const connected = (page) => page.waitForFunction(() => {
  const n = document.getElementById("notice");
  return n.hidden || !n.textContent.startsWith("Connecting");
});

test("explains when the page has no runtime at all", async ({ page }) => {
  await openApp(page, { noRuntime: true });
  await expect(page.locator("#notice")).toContainText("Shared storage isn't available");
});

test("a capability the user declines is treated as unavailable", async ({ page }) => {
  await openApp(page, { ...usedState, rejects: ["sample", "downloads"] });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await expect(page.getByRole("button", { name: "Download CSV" })).toHaveCount(0);
  await page.getByRole("button", { name: "← All projects" }).first().click();
  await expect(page.getByText("Scan receipt")).toHaveCount(0);
});

test("hides receipt scanning when images can't be sent", async ({ page }) => {
  await openApp(page, { ...usedState, limits: { maxPromptBytes: 1000 } });
  await connected(page);
  await expect(page.getByText("Scan receipt")).toHaveCount(0);
});

test("hides receipt scanning when limits can't be checked", async ({ page }) => {
  await openApp(page, { ...usedState, limitsError: true });
  await connected(page);
  await expect(page.getByText("Scan receipt")).toHaveCount(0);
});

test("keeps working when the user's identity or permissions can't be read", async ({ page }) => {
  await openApp(page, { userErrors: ["id", "can", "profiles"], ...usedState });
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toContainText("Someone");
  await page.getByRole("button", { name: "+ New project" }).click();
  await expect(modal(page).getByLabel("Prepared by")).toBeVisible();
});

test("reports a lost connection to shared storage", async ({ page }) => {
  await openApp(page, { snapshotError: true });
  await expect(page.locator("#toast")).toHaveText("Lost connection to shared storage. Reload the page.");
});

test("CSV export quotes commas and quotes, and names untitled projects", { tag: ["@J6.2"] }, async ({ page }) => {
  await openApp(page, {
    seed: {
      "projects/q": {
        client: "", date: "2026-09-01", status: "closed", createdBy: "u_test",
        items: {
          a: { code: "", name: 'Tape, 2" wide', price: "x", out: 2, returned: 5 },
          b: { name: "Line\nbreak", price: 1.5, out: 1 },
        },
      },
    },
  });
  await page.getByRole("button", { name: "Returned" }).click();
  await page.getByRole("button", { name: /Untitled/ }).click();
  await page.getByRole("button", { name: "Download CSV" }).click();
  const save = await page.evaluate(() => window.__mock.saves[0]);
  expect(save.filename).toBe("project 2026-09-01.csv");
  expect(save.data).toContain("Status,Returned");
  expect(save.data).toContain('"Tape, 2"" wide",,0.00,2,2,0,0.00');
  expect(save.data).toContain('"Line\nbreak",,1.50,1,0,1,1.50');
});

test("a declined download is silent", { tag: ["@J6.2"] }, async ({ page }) => {
  await openApp(page, { ...usedState, downloadError: "declined" });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await page.getByRole("button", { name: "Download CSV" }).click();
  await expect(page.locator("#toast")).toBeHidden();
});

test("a failed download explains", { tag: ["@J6.2"] }, async ({ page }) => {
  await openApp(page, { ...usedState, downloadError: "unavailable" });
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await page.getByRole("button", { name: "Download CSV" }).click();
  await expect(page.locator("#toast")).toHaveText("Couldn't prepare the download here.");
});

test("a corrupt saved receipt draft is ignored", { tag: ["@J5"] }, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("supplyCheckout.receiptDraft", "{not json"));
  await openApp(page, usedState);
  await connected(page);
  await expect(page.getByRole("button", { name: "Continue review" })).toHaveCount(0);
});

test("receipt review still works when the browser won't save drafts", { tag: ["@J5"] }, async ({ page }) => {
  await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error("QuotaExceededError"); }; });
  await openApp(page, usedState);
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
  await expect(page.locator(".rline")).toHaveCount(2);
});
