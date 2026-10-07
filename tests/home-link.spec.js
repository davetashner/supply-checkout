// The logo in the header goes home: the project list on Out now, with no project or dialog open,
// as the app opens (supplycheckout.com redirects to it). It's a link to the app's root, so in
// the web build a Ctrl/Cmd click opens the app in a new tab. A dialog that's saving stays open.
import { test, expect, openApp } from "./helpers.js";
import { modal, goToInventory, openProject, enterBarcode, addToProject } from "./ui/index.js";
import { usedState } from "./fixtures.js";

const logo = (page) => page.getByRole("link", { name: "Supply Checkout home" });
const pressed = (page, name) => page.getByRole("button", { name, exact: true });

async function openEcho(page) {
  await openApp(page, usedState);
  await openProject(page, "Echo Studio");
  await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
}

async function expectHome(page) {
  await expect(pressed(page, "Projects")).toHaveAttribute("aria-pressed", "true");
  await expect(pressed(page, "Inventory")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /^Out now/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#projectView")).toBeHidden();
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
}

test("the logo is a link to the app's root that keeps the heading", async ({ page }) => {
  await openApp(page);
  await expect(logo(page)).toHaveAttribute("href", "./");
  await expect(logo(page).getByRole("heading", { name: "Supply Checkout" })).toBeVisible();
  // Looks as it did: no underline, the page's ink
  const look = await logo(page).evaluate((a) => {
    const s = getComputedStyle(a), h = getComputedStyle(a.querySelector("h1"));
    return { line: s.textDecorationLine, color: h.color, ink: getComputedStyle(document.body).color };
  });
  expect(look.line).toBe("none");
  expect(look.color).toBe(look.ink);
  // A focus ring for the keyboard (Safari skips links on Tab unless the user turns that on)
  await logo(page).focus();
  await expect(logo(page)).toBeFocused();
  expect(await logo(page).evaluate((a) => getComputedStyle(a).outlineStyle)).toBe("solid");
});

test("a click on the logo goes from another view back to Projects on Out now", async ({ page }) => {
  await openApp(page, usedState);
  await page.getByRole("button", { name: "Returned", exact: true }).click();
  await expect(page.getByRole("button", { name: "Returned", exact: true })).toHaveAttribute("aria-pressed", "true");
  await goToInventory(page);
  await logo(page).click();
  await expectHome(page);
  await expect(page).toHaveURL(/\/$/);

  // And from an open project
  await openProject(page, "Echo Studio");
  await expect(page.locator("#projectView")).toBeVisible();
  await logo(page).click();
  await expectHome(page);
});

test("the keyboard on the logo closes an open dialog and the project behind it", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await expect(page.locator("#overlay")).toBeVisible();
  await logo(page).focus();
  await page.keyboard.press("Enter");
  await expectHome(page);
  await expect(modal(page)).toBeEmpty();
});

test("the logo leaves a dialog that's saving open, so what was entered isn't lost", async ({ page }) => {
  await openEcho(page);
  await enterBarcode(page, "SKU1");
  await page.evaluate(() => window.__mock.hold());
  await addToProject(page);
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await logo(page).focus();
  await page.keyboard.press("Enter");
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeVisible();
  await expect(page.locator("#projectView")).toBeVisible();

  await page.evaluate(() => window.__mock.release());
  await expect(modal(page)).toBeEmpty();
  await logo(page).click();
  await expectHome(page);
});

test("in the web build, a Ctrl, Cmd or Shift click on the logo is left to the browser", async ({ page }) => {
  await openEcho(page);
  // Whether the app took the click over; the check then stops the browser following the link
  const left = (mods) => logo(page).evaluate((a, m) => new Promise((done) => {
    window.addEventListener("click", (e) => { done(!e.defaultPrevented); e.preventDefault(); }, { once: true });
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...m }));
  }), mods);
  expect(await left({ ctrlKey: true })).toBe(true);
  expect(await left({ metaKey: true })).toBe(true);
  expect(await left({ shiftKey: true })).toBe(true);
  await expect(page.locator("#projectView")).toBeVisible();
  expect(await left({})).toBe(false);
  await expectHome(page);
});

test("in the web build, a Ctrl or Cmd click on the logo opens the app in a new tab", async ({ page, context, browserName, isMobile }) => {
  test.skip(browserName !== "chromium" || isMobile, "Checked where Playwright opens the new tab itself: desktop Chromium");
  await openEcho(page);
  // Chromium starts loading a Ctrl/Cmd-click tab before Playwright can route it, so this checks
  // that the browser opened one, not what it loaded; the test above checks the app lets it through
  const [tab] = await Promise.all([context.waitForEvent("page"), logo(page).click({ modifiers: ["ControlOrMeta"] })]);
  await tab.close();
  // This tab stays where it was
  await expect(page.locator("#projectView")).toBeVisible();
});
