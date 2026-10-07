import AxeBuilder from "@axe-core/playwright";
import { test, expect, openApp, modal } from "./helpers.js";
import { usedState, fakeImage } from "./fixtures.js";

async function expectAccessible(page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const summary = violations.map((v) => `${v.id}: ${v.help} → ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary).toEqual([]);
}

for (const colorScheme of ["light", "dark"]) {
  test.describe(`accessibility (${colorScheme})`, () => {
    // Reduced motion: check the dialog at rest, not mid fade-in
    test.use({ colorScheme, reducedMotion: "reduce" });

    test("project list", async ({ page }) => {
      await openApp(page, usedState);
      await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
      await expectAccessible(page);
    });

    test("project detail and checkout dialog", async ({ page }) => {
      await openApp(page, usedState);
      await page.getByRole("button", { name: /Echo Studio/ }).click();
      await expect(page.locator("#projectBody tbody tr")).toHaveCount(2);
      await expectAccessible(page);

      await page.getByPlaceholder("Or type the barcode").fill("SKU1");
      await page.getByPlaceholder("Or type the barcode").press("Enter");
      await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
      await expectAccessible(page);
    });

    test("company equipment: the project's section, the item editor and Inventory's Out view", async ({ page }) => {
      const ladder = { code: "LAD-1", name: "Step ladder", kind: "equipment", out: 2, returned: 0, lost: 1, takenBy: "u_test", takenAt: "2026-09-24T13:05:00.000Z" };
      await openApp(page, { ...usedState, seed: { ...usedState.seed, "products/LAD-1": { code: "LAD-1", name: "Step ladder", kind: "equipment", cost: 120, stock: 2 }, "projects/s1": { ...usedState.seed["projects/s1"], items: { ...usedState.seed["projects/s1"].items, "LAD-1": ladder } } } });
      await page.getByRole("button", { name: /Echo Studio/ }).click();
      await expect(page.locator("#projectBody table.equipment tbody tr")).toHaveCount(1);
      await expectAccessible(page);
      // Finished Return's question about the piece still out, with the charge field showing
      await page.getByRole("button", { name: "Finished Return" }).click();
      await modal(page).getByLabel("Lost or broken", { exact: true }).fill("1");
      await modal(page).getByLabel("Lost or broken", { exact: true }).dispatchEvent("input");
      await expect(modal(page).getByLabel(/Charge the client/)).toBeVisible();
      await expectAccessible(page);
      await modal(page).getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Inventory" }).click();
      await page.getByRole("button", { name: "Equipment", exact: true }).click();
      await page.getByRole("button", { name: "Out on jobs" }).click();
      await expect(page.locator("#main table.out tbody tr")).toHaveCount(1);
      await expectAccessible(page);
      await page.getByRole("button", { name: "In storage" }).click();
      await page.locator("#main tbody tr", { hasText: "Step ladder" }).click();
      await expect(modal(page).getByLabel("Value each ($)")).toBeVisible();
      await expectAccessible(page);
    });

    test("inventory", async ({ page }) => {
      await openApp(page, usedState);
      await page.getByRole("button", { name: "Inventory" }).click();
      await expect(page.locator("#main tbody tr")).toHaveCount(2);
      await expectAccessible(page);
    });

    test("receipt review", async ({ page }) => {
      await openApp(page, usedState);
      await page.setInputFiles("#receiptFile", fakeImage);
      await expect(page.getByRole("heading", { name: "Review receipt" })).toBeVisible();
      await expectAccessible(page);
    });
  });
}
