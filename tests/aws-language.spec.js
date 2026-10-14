// The language on Account in the web build (supply-checkout-3ilj): English and Spanish, each in its own name,
// saved on the device, and the page loads again in the language picked. Against the fake backend in
// tests/fake-aws.js.
import { test, expect } from "./helpers.js";
import { FakeBackend, USER, openAws, connected } from "./fake-aws.js";

test.use({ reducedMotion: "reduce" });

const dialog = (page) => page.locator("#modal");
const prefs = (language) => ({ ...USER, preferences: { whatsNew: true, whatsNewLastShown: null, language } });
const open = async (page, path = "/") => {
  const backend = new FakeBackend({ user: prefs(null) });
  await openAws(page, backend, { path });
  await connected(page);
  return backend;
};
const language = (page) => page.evaluate(() => localStorage.getItem("supplyCheckout.language"));
// Only the language: the What's New banner records the day it was shown in the same preferences
const sent = (backend) => backend.requests("PATCH", "/me/preferences").map((r) => r.body).filter((body) => "language" in body);

test("Account lists English and Spanish, in their own names, with English chosen", async ({ page }) => {
  await open(page);
  await page.locator("#accountOpen").click();
  await expect(dialog(page).getByRole("heading", { name: "Your account", exact: true })).toBeVisible();
  const select = dialog(page).getByLabel("Language");
  await expect(select).toHaveValue("en");
  await expect(select.locator("option")).toHaveText(["English", "Español"]);
});

test("Account's switch saves Spanish and loads the page again", async ({ page }) => {
  const backend = await open(page);
  await page.locator("#accountOpen").click();
  await dialog(page).getByLabel("Language").selectOption("es");
  await expect.poll(() => backend.pageLoads).toBe(2);
  expect(await language(page)).toBe("es");
  // Kept for the user, so another device speaks it too
  expect(sent(backend)).toEqual([{ language: "es" }]);
});

test("a language the server can't save isn't switched to: it says so and stays as it was", async ({ page }) => {
  const backend = await open(page);
  backend.on("PATCH", "/me/preferences", { status: 500, body: { error: { code: "internal" } } });
  await page.locator("#accountOpen").click();
  const select = dialog(page).getByLabel("Language");
  await select.selectOption("es");
  await expect(dialog(page).getByRole("alert").filter({ hasText: "Couldn't save your language" })).toBeVisible();
  await expect(select).toHaveValue("en");
  expect(backend.pageLoads).toBe(1);
  expect(await language(page)).toBeNull();
  // Trying again, with the server back, works
  await select.selectOption("es");
  await expect.poll(() => backend.pageLoads).toBe(2);
  expect(await language(page)).toBe("es");
});

test("on ?lang=es, switching saves English and loads the page again without ?lang", async ({ page }) => {
  const backend = await open(page, "/?lang=es");
  await page.locator("#accountOpen").click();
  await expect(dialog(page).getByRole("heading", { name: "Su cuenta", exact: true })).toBeVisible();
  const select = dialog(page).getByLabel("Idioma");
  await expect(select).toHaveValue("es");
  await expect(select.locator("option")).toHaveText(["English", "Español"]);
  await select.selectOption("en");
  // The fake backend answers the page's second load with nothing (so coverage isn't lost): what matters is that
  // it was asked for, at an address with no ?lang= to choose Spanish again, and that English is what's kept
  await expect.poll(() => backend.pageLoads).toBe(2);
  expect(new URL(page.url()).search).toBe("");
  expect(await language(page)).toBe("en");
});

// The language follows the user (supply-checkout-ae27): /me's user.preferences.language. A reload that
// the fake backend answers with nothing is what shows the page was asked to load again
test.describe("follows the user across devices", () => {
  const start = async (page, { saved, user, path = "/" }) => {
    const backend = new FakeBackend({ user });
    await openAws(page, backend, { path, storage: saved ? { local: { "supplyCheckout.language": saved } } : undefined });
    return backend;
  };

  test("a device that never chose speaks the language chosen on another, from the next load", async ({ page }) => {
    const backend = await start(page, { user: prefs("es") });
    await expect.poll(() => backend.pageLoads).toBe(2);
    expect(await language(page)).toBe("es");
    expect(sent(backend)).toEqual([]);
  });

  test("the server's language wins over this device's own earlier choice", async ({ page }) => {
    const backend = await start(page, { saved: "en", user: prefs("es") });
    await expect.poll(() => backend.pageLoads).toBe(2);
    expect(await language(page)).toBe("es");
  });

  test("a language the app doesn't have is ignored", async ({ page }) => {
    const backend = await start(page, { user: prefs("fr") });
    await connected(page);
    await expect(page.locator("#tab-projects")).toHaveText("Projects");
    expect(backend.pageLoads).toBe(1);
    expect(await language(page)).toBeNull();
  });

  test("a device already in that language just carries on", async ({ page }) => {
    const backend = await start(page, { saved: "es", user: prefs("es") });
    await connected(page);
    await expect(page.locator("#tab-projects")).toHaveText("Proyectos");
    expect(backend.pageLoads).toBe(1);
    expect(sent(backend)).toEqual([]);
  });

  test("storage the device can't write doesn't send it round in circles", async ({ page }) => {
    await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error("blocked"); }; });
    const backend = await start(page, { user: prefs("es") });
    await connected(page);
    await expect(page.locator("#tab-projects")).toHaveText("Projects");
    expect(backend.pageLoads).toBe(1);
  });

  test("a choice this device made before the server knew of one is sent up", async ({ page }) => {
    const backend = await start(page, { saved: "es", user: prefs(null) });
    await connected(page);
    await expect.poll(() => sent(backend)).toEqual([{ language: "es" }]);
    expect(backend.pageLoads).toBe(1);
  });

  test("a choice that can't be sent up is dropped without a word", async ({ page }) => {
    const backend = new FakeBackend({ user: prefs(null) });
    backend.on("PATCH", "/me/preferences", { status: 500, body: { error: { code: "internal" } } });
    await openAws(page, backend, { storage: { local: { "supplyCheckout.language": "es" } } });
    await connected(page);
    await expect.poll(() => sent(backend)).toEqual([{ language: "es" }]);
    await expect(page.locator("#tab-projects")).toHaveText("Proyectos");
  });

  test("no choice anywhere: nothing is sent", async ({ page }) => {
    const backend = await start(page, { user: prefs(null) });
    await connected(page);
    expect(sent(backend)).toEqual([]);
    expect(backend.pageLoads).toBe(1);
  });

  test("a language named in the address is a preview, not the user's choice", async ({ page }) => {
    const backend = await start(page, { user: prefs("en"), path: "/?lang=es" });
    await connected(page);
    await expect(page.locator("#tab-projects")).toHaveText("Proyectos");
    expect(sent(backend)).toEqual([]);
    expect(backend.pageLoads).toBe(1);
  });

  test("an API from before the language changes nothing", async ({ page }) => {
    const backend = await start(page, { saved: "es", user: { ...USER, preferences: { whatsNew: true, whatsNewLastShown: null } } });
    await connected(page);
    expect(sent(backend)).toEqual([]);
    expect(backend.pageLoads).toBe(1);
  });

  test("an API from before preferences changes nothing either", async ({ page }) => {
    const backend = await start(page, { saved: "es", user: USER });
    await connected(page);
    expect(sent(backend)).toEqual([]);
  });
});

test.describe("the sign-in link", () => {
  const link = async (page, path) => {
    await openAws(page, new FakeBackend({ signedIn: false }), { path });
    const href = await page.locator("#account a[href*='oauth2/authorize']").first().getAttribute("href");
    return new URL(href).searchParams.get("lang");
  };

  test("asks Managed Login for the language the app speaks", async ({ page }) => {
    expect(await link(page, "/?lang=es")).toBe("es");
  });

  test("names none for the pseudo-language, which Managed Login doesn't have", async ({ page }) => {
    expect(await link(page, "/?lang=qps")).toBeNull();
  });
});
