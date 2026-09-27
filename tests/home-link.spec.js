// The logo in the header goes home: the sheet list on Out now, with no sheet or dialog open,
// as the app opens (supplycheckout.com redirects to it). It's a link to the app's root, so in
// the web build a Ctrl/Cmd click opens the app in a new tab. A dialog that's saving stays open.
import { test, expect, openApp, enterBarcode, modal } from "./helpers.js";
import { usedState } from "./fixtures.js";
import { currentBuild } from "../scripts/builds.mjs";

const logo = (page) => page.getByRole("link", { name: "Supply Checkout home" });
const pressed = (page, name) => page.getByRole("button", { name, exact: true });

async function openEcho(page) {
  await openApp(page, usedState);
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await expect(page.getByRole("heading", { name: "Echo Studio" })).toBeVisible();
}

async function expectHome(page) {
  await expect(pressed(page, "Sheets")).toHaveAttribute("aria-pressed", "true");
  await expect(pressed(page, "Inventory")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: /^Out now/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#sheetView")).toBeHidden();
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

test("a click on the logo goes from another view back to Sheets on Out now", async ({ page }) => {
  await openApp(page, usedState);
  await page.getByRole("button", { name: "Returned", exact: true }).click();
  await expect(page.getByRole("button", { name: "Returned", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Inventory" }).click();
  await logo(page).click();
  await expectHome(page);
  await expect(page).toHaveURL(/\/$/);

  // And from an open sheet
  await page.getByRole("button", { name: /Echo Studio/ }).click();
  await expect(page.locator("#sheetView")).toBeVisible();
  await logo(page).click();
  await expectHome(page);
});

test("the keyboard on the logo closes an open dialog and the sheet behind it", async ({ page }) => {
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
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
  await logo(page).focus();
  await page.keyboard.press("Enter");
  await expect(modal(page).getByRole("button", { name: "Saving…" })).toBeVisible();
  await expect(page.locator("#sheetView")).toBeVisible();

  await page.evaluate(() => window.__mock.release());
  await expect(modal(page)).toBeEmpty();
  await logo(page).click();
  await expectHome(page);
});

test("in the web build, a Ctrl, Cmd or Shift click on the logo is left to the browser", async ({ page }) => {
  test.skip(currentBuild() !== "web", "Only the web build is a page of its own to open again");
  await openEcho(page);
  // Whether the app took the click over; the check then stops the browser following the link
  const left = (mods) => logo(page).evaluate((a, m) => new Promise((done) => {
    window.addEventListener("click", (e) => { done(!e.defaultPrevented); e.preventDefault(); }, { once: true });
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...m }));
  }), mods);
  expect(await left({ ctrlKey: true })).toBe(true);
  expect(await left({ metaKey: true })).toBe(true);
  expect(await left({ shiftKey: true })).toBe(true);
  await expect(page.locator("#sheetView")).toBeVisible();
  expect(await left({})).toBe(false);
  await expectHome(page);
});

test("in the web build, a Ctrl or Cmd click on the logo opens the app in a new tab", async ({ page, context, browserName, isMobile }) => {
  test.skip(currentBuild() !== "web", "Only the web build is a page of its own to open again");
  test.skip(browserName !== "chromium" || isMobile, "Checked where Playwright opens the new tab itself: desktop Chromium");
  await openEcho(page);
  // The new tab gets a stand-in page (this tab's routes are its own)
  const home = new URL("./", page.url()).href;
  await context.route(home, (r) => r.fulfill({ contentType: "text/html", body: "<title>home</title>" }));
  const [tab] = await Promise.all([context.waitForEvent("page"), logo(page).click({ modifiers: ["ControlOrMeta"] })]);
  await expect.poll(() => tab.url()).toBe(home);
  await tab.close();
  // This tab stays where it was
  await expect(page.locator("#sheetView")).toBeVisible();
});
