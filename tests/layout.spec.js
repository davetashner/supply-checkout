import { test, expect, openApp } from "./helpers.js";
import { modal, goToInventory, goToProjects, openProject, enterBarcode, uploadReceipt } from "./ui/index.js";
import { usedState, fakeImage } from "./fixtures.js";

// The page body must never scroll sideways on a phone or tablet; only tables may, inside their own container.
async function expectNoSideways(page) {
  const { overflow, culprits } = await page.evaluate(() => {
    const width = window.innerWidth;
    const culprits = [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > width + 0.5 && !el.closest(".table-wrap, [hidden]"))
      .slice(-5)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className ? "." + String(el.className).trim().replace(/\s+/g, ".") : ""}`);
    return { overflow: document.documentElement.scrollWidth - width, culprits };
  });
  expect(overflow, `horizontal overflow in px; elements past the edge: ${culprits.join(", ")}`).toBeLessThanOrEqual(0);
}

// Fallback fonts differ by OS and some are much wider (Linux CI uses DejaVu).
// Force a wide font so the check doesn't depend on which machine runs it.
const wideFont = "*{font-family:Verdana,'DejaVu Sans',sans-serif !important}";

// Opens every main screen and two dialogs, checking each one fits the width.
async function checkEveryScreen(page) {
  await openApp(page, usedState);
  await page.addStyleTag({ content: wideFont });
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
  await expectNoSideways(page);

  await openProject(page, "Echo Studio");
  await expect(page.locator("#projectBody tbody tr")).toHaveCount(2);
  await expectNoSideways(page);

  await enterBarcode(page, "SKU1");
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expectNoSideways(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#overlay")).toBeHidden();

  await goToInventory(page);
  await expect(page.locator("#main tbody tr")).toHaveCount(2);
  await expectNoSideways(page);

  await goToProjects(page);
  await page.getByRole("button", { name: "+ New project" }).click();
  await expect(modal(page).getByRole("heading", { name: "New project" })).toBeVisible();
  await expectNoSideways(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#overlay")).toBeHidden();

  await uploadReceipt(page, fakeImage);
  await expectNoSideways(page);
}

// The narrowest phones (320), common Android (360) and iPhone (390, 430) widths,
// and a portrait tablet (768)
for (const width of [320, 360, 390, 430, 768]) {
  test.describe(`layout at ${width}px`, () => {
    test.use({ viewport: { width, height: 740 } });
    test("every screen fits the width", async ({ page }) => checkEveryScreen(page));
  });
}

// And at each project's own screen, which covers phones and tablets in landscape
test("every screen fits this device's width", async ({ page }) => checkEveryScreen(page));
