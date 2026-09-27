// The System / Light / Dark theme control in the header (src/theme.js): a choice
// overrides the OS setting and is kept per device, System follows the OS, and storage
// that throws falls back to System without errors.
import { test, expect, openApp } from "./helpers.js";
import { usedState } from "./fixtures.js";

const KEY = "supplyCheckout.theme";
// --ground in styles.css
const LIGHT = "rgb(237, 241, 238)";
const DARK = "rgb(16, 22, 20)";

const themeButton = (page, name) => page.getByRole("group", { name: "Theme" }).getByRole("button", { name: `${name} theme` });
const background = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const saved = (page) => page.evaluate((k) => localStorage.getItem(k), KEY);
const attr = (page) => page.evaluate(() => document.documentElement.getAttribute("data-theme"));

async function open(page, { theme, os = "light", opts = usedState } = {}) {
  await page.emulateMedia({ colorScheme: os });
  if (theme !== undefined) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, theme]);
  // What the theme was when the page finished parsing, before anything else happens
  await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
    window.__themeAtLoad = document.documentElement.getAttribute("data-theme");
  }));
  await openApp(page, opts);
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
}

async function expectPressed(page, name) {
  for (const n of ["System", "Light", "Dark"]) await expect(themeButton(page, n)).toHaveAttribute("aria-pressed", String(n === name));
}

test("starts on System and follows the OS", async ({ page }) => {
  await open(page, { os: "dark" });
  await expectPressed(page, "System");
  expect(await attr(page)).toBeNull();
  expect(await background(page)).toBe(DARK);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await background(page)).toBe(LIGHT);
});

test("Dark overrides a light OS and is saved; System goes back to following the OS", async ({ page }) => {
  await open(page, { os: "light" });
  await themeButton(page, "Dark").click();
  await expectPressed(page, "Dark");
  expect(await attr(page)).toBe("dark");
  expect(await background(page)).toBe(DARK);
  expect(await saved(page)).toBe("dark");

  await themeButton(page, "System").click();
  await expectPressed(page, "System");
  expect(await attr(page)).toBeNull();
  expect(await background(page)).toBe(LIGHT);
  expect(await saved(page)).toBeNull();
});

test("Light overrides a dark OS and survives a reload", async ({ page }) => {
  await open(page, { os: "dark" });
  await themeButton(page, "Light").click();
  expect(await background(page)).toBe(LIGHT);
  expect(await saved(page)).toBe("light");
  await page.reload();
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
  await expectPressed(page, "Light");
  expect(await background(page)).toBe(LIGHT);
});

for (const [theme, os, color] of [["dark", "light", DARK], ["light", "dark", LIGHT]]) {
  test(`a saved ${theme} theme applies before the page finishes loading, over a ${os} OS`, async ({ page }) => {
    await open(page, { theme, os });
    expect(await page.evaluate(() => window.__themeAtLoad)).toBe(theme);
    await expectPressed(page, theme === "dark" ? "Dark" : "Light");
    expect(await background(page)).toBe(color);
  });
}

test("an unknown saved value is treated as System", async ({ page }) => {
  await open(page, { theme: "purple", os: "dark" });
  await expectPressed(page, "System");
  expect(await attr(page)).toBeNull();
  expect(await background(page)).toBe(DARK);
});

test("falls back to System, and still switches, when storage throws", async ({ page }) => {
  await page.addInitScript(() => {
    for (const m of ["getItem", "setItem", "removeItem"]) {
      Storage.prototype[m] = () => { throw new DOMException("blocked", "SecurityError"); };
    }
  });
  await open(page, { os: "light" });
  await expectPressed(page, "System");
  expect(await attr(page)).toBeNull();
  await themeButton(page, "Dark").click();
  await expectPressed(page, "Dark");
  expect(await background(page)).toBe(DARK);
  await themeButton(page, "System").click();
  await expectPressed(page, "System");
  expect(await background(page)).toBe(LIGHT);
});

test("theme changes in another tab update the page and pressed control without reloading", async ({ page, context }) => {
  await open(page, { os: "dark" });
  const other = await context.newPage();
  try {
    await open(other);
    for (const [choice, value, color] of [["Light", "light", LIGHT], ["Dark", "dark", DARK], ["System", null, DARK]]) {
      await themeButton(other, choice).click();
      await expectPressed(page, choice);
      expect(await attr(page)).toBe(value);
      expect(await background(page)).toBe(color);
    }
    // clear() has no key; unknown stored choices have the same fallback as at startup.
    await themeButton(other, "Light").click();
    await expectPressed(page, "Light");
    await other.evaluate(() => localStorage.clear());
    await expectPressed(page, "System");
    await themeButton(other, "Dark").click();
    await expectPressed(page, "Dark");
    await other.evaluate(k => localStorage.setItem(k, "purple"), KEY);
    await expectPressed(page, "System");
    expect(await attr(page)).toBeNull();
  } finally {
    await other.close();
  }
});

test("unrelated storage events don't replace a tab's theme", async ({ page }) => {
  await open(page);
  await themeButton(page, "Dark").click();
  await page.evaluate(k => {
    // Keep the persisted value different to make an accidental re-read observable.
    localStorage.setItem(k, "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "another.preference", storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent("storage", { key: k, storageArea: sessionStorage }));
  }, KEY);
  await expectPressed(page, "Dark");
  expect(await attr(page)).toBe("dark");
});
