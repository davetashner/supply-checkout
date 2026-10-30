// The "New" callout (src/aws/new-feature.js, supply-checkout-ihhe) in the web build, against the fake
// backend. The app ships with no feature marked new, so each test adds one through the test seam
// (globalThis.__newFeatureSeam, set before the page loads) and draws it with the seam's callout().
// Covers: the first 3 local days after shipping, a day counted once however many times the app opens
// or on whichever device, the cutoff, What's New off, a legend label, English and Spanish, and what's
// recorded (PATCH /me/preferences).
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { FakeBackend, USER, openAws, connected } from "./fake-aws.js";

const DAY = 864e5;
const shift = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const SHIPPED = "2026-10-01";
const FEATURE = { id: "photo-link", shipped: SHIPPED };

test.use({ timezoneId: "America/New_York", reducedMotion: "reduce" });

const patches = (backend) => backend.requests("PATCH", "/me/preferences").map((r) => r.body);

async function open(page, { today = shift(SHIPPED, 1), preferences = {}, features = [FEATURE], search = "", failSave = false } = {}) {
  await page.addInitScript((f) => { globalThis.__newFeatureSeam = { features: f }; }, features);
  await page.clock.install({ time: new Date(`${today}T16:00:00Z`) });
  const user = preferences === null ? USER : { ...USER, preferences: { whatsNew: true, whatsNewLastShown: today, newFeatures: {}, ...preferences } };
  const backend = new FakeBackend({ user });
  if (failSave) backend.on("PATCH", "/me/preferences", { status: 500, body: { error: { code: "internal", message: "internal" } } });
  await openAws(page, backend, { path: "/" + search });
  await connected(page);
  return backend;
}

const draw = (page, id = FEATURE.id) => page.evaluate((i) => {
  document.body.insertAdjacentHTML("beforeend", `<div id="host">${globalThis.__newFeatureSeam.callout(i, "<p id=\"inner\">Photo section</p>")}</div>`);
  return document.querySelector("#host .new-callout") !== null;
}, id);

test.describe("New callout", () => {
  test("wraps a new feature in a legend box, records the day, and doesn't announce itself", async ({ page }) => {
    const today = shift(SHIPPED, 1);
    const backend = await open(page, { today });
    expect(await draw(page)).toBe(true);
    const box = page.locator(".new-callout");
    await expect(box).toContainText("Photo section");
    await expect(box.locator(".new-callout-tag")).toHaveText("New");
    await expect(box.locator("[role=status], [aria-live]")).toHaveCount(0);
    await expect.poll(() => patches(backend)).toEqual([{ newFeatures: { "photo-link": { days: 1, last: today } } }]);
    await expect(page.locator("#whatsNew")).toHaveCount(0);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });

  test("names the feature in the legend when it has a label, in Spanish too", async ({ page }) => {
    await open(page, { features: [{ ...FEATURE, label: "newFeature.tag" }], search: "?lang=es" });
    await draw(page);
    await expect(page.locator(".new-callout-tag")).toHaveText("Nuevo: Nuevo");
  });

  test("shows for 3 days, then plainly, counting each day once", async ({ page }) => {
    const today = shift(SHIPPED, 5);
    // Counted yesterday (day 2): today is its third and last
    const backend = await open(page, { today, preferences: { newFeatures: { "photo-link": { days: 2, last: shift(today, -1) } } } });
    expect(await draw(page)).toBe(true);
    await expect.poll(() => patches(backend)).toEqual([{ newFeatures: { "photo-link": { days: 3, last: today } } }]);
  });

  test("a day already counted today (another device, or opened again) shows without using up another", async ({ page }) => {
    const today = shift(SHIPPED, 5);
    const backend = await open(page, { today, preferences: { newFeatures: { "photo-link": { days: 3, last: today } } } });
    expect(await draw(page)).toBe(true);
    expect(patches(backend)).toEqual([]);
  });

  test("after 3 days it shows plainly and records nothing", async ({ page }) => {
    const today = shift(SHIPPED, 6);
    const backend = await open(page, { today, preferences: { newFeatures: { "photo-link": { days: 3, last: shift(today, -1) } } } });
    expect(await draw(page)).toBe(false);
    await expect(page.locator("#inner")).toHaveText("Photo section");
    expect(patches(backend)).toEqual([]);
  });

  test("never before it ships", async ({ page }) => {
    const before = await open(page, { today: shift(SHIPPED, -1) });
    expect(await draw(page)).toBe(false);
    expect(patches(before)).toEqual([]);
  });

  test("on the cutoff day it still shows, the day after it doesn't", async ({ page }) => {
    const last = shift(SHIPPED, 30);
    const backend = await open(page, { today: last, preferences: { newFeatures: { "photo-link": { days: 1, last: shift(last, -10) } } } });
    expect(await draw(page)).toBe(true);
    await expect.poll(() => patches(backend)).toEqual([{ newFeatures: { "photo-link": { days: 2, last } } }]);
  });

  test("past the cutoff it's plain however few days were shown", async ({ page }) => {
    const backend = await open(page, { today: shift(SHIPPED, 31) });
    expect(await draw(page)).toBe(false);
    expect(patches(backend)).toEqual([]);
  });

  test("is off when What's New is off, and from an API without the preferences", async ({ page }) => {
    const off = await open(page, { preferences: { whatsNew: false } });
    expect(await draw(page)).toBe(false);
    expect(patches(off)).toEqual([]);
  });

  test("an API from before the preferences shows nothing", async ({ page }) => {
    await open(page, { preferences: null });
    expect(await draw(page)).toBe(false);
  });

  test("an API from before newFeatures shows nothing", async ({ page }) => {
    await open(page, { preferences: { newFeatures: undefined } });
    expect(await draw(page)).toBe(false);
  });

  test("with no feature marked, which is how it ships, nothing is drawn or recorded", async ({ page }) => {
    const backend = await open(page, { features: [] });
    expect(await draw(page)).toBe(false);
    expect(patches(backend)).toEqual([]);
  });

  test("keeps only the features the app lists, and a failed save says nothing", async ({ page }) => {
    const today = shift(SHIPPED, 1);
    const backend = await open(page, { today, failSave: true, preferences: { newFeatures: { retired: { days: 3, last: "2026-09-01" } } } });
    expect(await draw(page)).toBe(true);
    await expect.poll(() => patches(backend)).toEqual([{ newFeatures: { "photo-link": { days: 1, last: today } } }]);
  });

  test("turning What's New off in Account stops marking sections", async ({ page }) => {
    await open(page);
    expect(await draw(page)).toBe(true);
    await page.locator("#accountOpen").click();
    await page.locator("#whatsNewOn").uncheck();
    await expect.poll(() => page.evaluate(() => globalThis.__newFeatureSeam.isNew("photo-link"))).toBe(false);
  });
});
