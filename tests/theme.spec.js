// The theme (src/theme.js), picked in Account's Appearance section (src/aws/appearance.js): a
// palette (Work Order by default, Evergreen, Slate or High contrast) and System / Light / Dark.
// A choice overrides the OS setting and is kept per device, System follows the OS, other tabs
// follow along, and storage that throws falls back to the defaults without errors.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, openApp } from "./helpers.js";
import { usedState } from "./fixtures.js";
import { FakeBackend, openAws, connected } from "./fake-aws.js";

const MODE = "supplyCheckout.theme", PALETTE = "supplyCheckout.palette";
// --ground of each palette in styles.css
const GROUND = {
  workorder: { light: "rgb(238, 241, 246)", dark: "rgb(14, 19, 32)" },
  evergreen: { light: "rgb(241, 244, 241)", dark: "rgb(15, 21, 19)" },
  slate: { light: "rgb(246, 246, 246)", dark: "rgb(33, 33, 33)" },
  contrast: { light: "rgb(255, 255, 255)", dark: "rgb(0, 0, 0)" },
};
const NAMES = { workorder: "Work Order", evergreen: "Evergreen", slate: "Slate", contrast: "High contrast" };

const background = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const saved = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const attrs = (page) => page.evaluate(() => [document.documentElement.getAttribute("data-palette"), document.documentElement.getAttribute("data-theme")]);
const paletteRadio = (page, p) => page.getByRole("group", { name: "Theme" }).getByRole("radio", { name: NAMES[p] });
const modeRadio = (page, name) => page.getByRole("group", { name: "Light or dark" }).getByRole("radio", { name });

// The app with the mock runtime: no Account, but the theme still applies from storage
async function openMock(page, { os = "light", local = {} } = {}) {
  await page.emulateMedia({ colorScheme: os });
  await page.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, local);
  // What the theme was when the page finished parsing, before anything else happens
  await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
    window.__themeAtLoad = [document.documentElement.getAttribute("data-palette"), document.documentElement.getAttribute("data-theme")];
  }));
  await openApp(page, usedState);
  await expect(page.getByRole("button", { name: /Echo Studio/ })).toBeVisible();
}

// The web build, signed in, with Account open
async function openAccount(page, { os = "light", storage } = {}) {
  await page.emulateMedia({ colorScheme: os });
  await openAws(page, new FakeBackend(), { storage });
  await connected(page);
  await page.locator(".teambar").getByRole("button", { name: /\. Account$/ }).click();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
}

test("starts on Work Order following the OS, with no theme control in the header", async ({ page }) => {
  await openMock(page, { os: "dark" });
  expect(await attrs(page)).toEqual([null, null]);
  expect(await background(page)).toBe(GROUND.workorder.dark);
  await page.emulateMedia({ colorScheme: "light" });
  expect(await background(page)).toBe(GROUND.workorder.light);
  await expect(page.locator("header").getByRole("group", { name: "Theme" })).toHaveCount(0);
});

for (const palette of Object.keys(GROUND)) for (const mode of ["light", "dark"]) {
  test(`a saved ${NAMES[palette]} ${mode} theme applies before the page finishes loading`, async ({ page }) => {
    const local = { [MODE]: mode };
    if (palette !== "workorder") local[PALETTE] = palette;
    await openMock(page, { os: mode === "dark" ? "light" : "dark", local });
    expect(await page.evaluate(() => window.__themeAtLoad)).toEqual([palette === "workorder" ? null : palette, mode]);
    expect(await background(page)).toBe(GROUND[palette][mode]);
  });
}

test("unknown saved values are treated as Work Order and System", async ({ page }) => {
  await openMock(page, { os: "dark", local: { [MODE]: "purple", [PALETTE]: "plaid" } });
  expect(await attrs(page)).toEqual([null, null]);
  expect(await background(page)).toBe(GROUND.workorder.dark);
});

test("Account picks a theme and light or dark, applies them at once, and saves them", async ({ page }) => {
  await openAccount(page, { os: "light" });
  await expect(paletteRadio(page, "workorder")).toBeChecked();
  await expect(modeRadio(page, "Match this device")).toBeChecked();

  await paletteRadio(page, "evergreen").check();
  expect(await attrs(page)).toEqual(["evergreen", null]);
  expect(await background(page)).toBe(GROUND.evergreen.light);
  expect(await saved(page, PALETTE)).toBe("evergreen");

  await modeRadio(page, "Dark").check();
  expect(await attrs(page)).toEqual(["evergreen", "dark"]);
  expect(await background(page)).toBe(GROUND.evergreen.dark);
  expect(await saved(page, MODE)).toBe("dark");

  // The defaults are kept by removing the keys
  await paletteRadio(page, "workorder").check();
  await modeRadio(page, "Match this device").check();
  expect(await attrs(page)).toEqual([null, null]);
  expect(await background(page)).toBe(GROUND.workorder.light);
  expect(await saved(page, PALETTE)).toBeNull();
  expect(await saved(page, MODE)).toBeNull();
});

test("Account shows a saved choice, here Slate in Light over a dark OS", async ({ page }) => {
  await openAccount(page, { os: "dark", storage: { local: { [MODE]: "light", [PALETTE]: "slate" } } });
  expect(await background(page)).toBe(GROUND.slate.light);
  await expect(paletteRadio(page, "slate")).toBeChecked();
  await expect(modeRadio(page, "Light")).toBeChecked();
});

// axe's contrast check over Account, which shows text, hints, fields and buttons, in every theme
test("Account's text has enough contrast in every theme, light and dark", async ({ page }) => {
  await openAccount(page);
  for (const palette of Object.keys(GROUND)) for (const mode of ["Light", "Dark"]) {
    await paletteRadio(page, palette).check();
    await modeRadio(page, mode).check();
    const { violations } = await new AxeBuilder({ page }).include("#modal").withRules(["color-contrast"]).analyze();
    expect(violations.flatMap((v) => v.nodes.map((n) => `${palette} ${mode}: ${n.target} ${n.failureSummary}`))).toEqual([]);
  }
});

test("falls back to the defaults, and still switches, when the theme's storage throws", async ({ page }) => {
  // Only the theme's keys, so sign-in still keeps its session
  await page.addInitScript(([keys]) => {
    for (const m of ["getItem", "setItem", "removeItem"]) {
      const real = Storage.prototype[m];
      Storage.prototype[m] = function (k, ...rest) {
        if (keys.includes(k)) throw new DOMException("blocked", "SecurityError");
        return real.call(this, k, ...rest);
      };
    }
  }, [[MODE, PALETTE]]);
  await openAccount(page, { os: "light" });
  expect(await attrs(page)).toEqual([null, null]);
  await paletteRadio(page, "contrast").check();
  await modeRadio(page, "Dark").check();
  expect(await background(page)).toBe(GROUND.contrast.dark);
  await paletteRadio(page, "workorder").check();
  await modeRadio(page, "Match this device").check();
  expect(await background(page)).toBe(GROUND.workorder.light);
});

test("changes in another tab update the page without reloading; clear() resets both", async ({ page, context }) => {
  await openMock(page, { os: "dark" });
  const other = await context.newPage();
  try {
    await openMock(other);
    for (const [key, value, want, color] of [
      [PALETTE, "slate", ["slate", null], GROUND.slate.dark],
      [MODE, "light", ["slate", "light"], GROUND.slate.light],
      [PALETTE, "plaid", [null, "light"], GROUND.workorder.light],
    ]) {
      await other.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
      await expect.poll(() => attrs(page)).toEqual(want);
      expect(await background(page)).toBe(color);
    }
    await other.evaluate(() => localStorage.clear());
    await expect.poll(() => attrs(page)).toEqual([null, null]);
    expect(await background(page)).toBe(GROUND.workorder.dark);
  } finally {
    await other.close();
  }
});

test("an open Account follows a change in another tab", async ({ page }) => {
  await openAccount(page);
  await page.evaluate(([k]) => {
    localStorage.setItem(k, "evergreen");
    window.dispatchEvent(new StorageEvent("storage", { key: k, storageArea: localStorage }));
  }, [PALETTE]);
  await expect(paletteRadio(page, "evergreen")).toBeChecked();
  await expect(paletteRadio(page, "workorder")).not.toBeChecked();
});

test("unrelated storage events don't replace a tab's theme", async ({ page }) => {
  await openMock(page, { local: { [MODE]: "dark", [PALETTE]: "evergreen" } });
  await page.evaluate(([m, p]) => {
    // Keep the persisted values different to make an accidental re-read observable.
    localStorage.setItem(m, "light");
    localStorage.setItem(p, "slate");
    window.dispatchEvent(new StorageEvent("storage", { key: "another.preference", storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent("storage", { key: m, storageArea: sessionStorage }));
  }, [MODE, PALETTE]);
  expect(await attrs(page)).toEqual(["evergreen", "dark"]);
});
