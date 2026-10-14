// The language on Account in the web build (supply-checkout-3ilj): offered only where there's a choice (English
// alone has none), saved on the device, and the page loads again in the language picked. Against the fake
// backend in tests/fake-aws.js.
import { test, expect } from "./helpers.js";
import { FakeBackend, openAws, connected } from "./fake-aws.js";

test.use({ reducedMotion: "reduce" });

const dialog = (page) => page.locator("#modal");
const open = async (page, path = "/") => {
  const backend = new FakeBackend();
  await openAws(page, backend, { path });
  await connected(page);
  return backend;
};

test("English alone has nothing to choose, so Account has no language", async ({ page }) => {
  await open(page);
  await page.locator("#accountOpen").click();
  await expect(dialog(page).getByRole("heading", { name: "Your account", exact: true })).toBeVisible();
  await expect(dialog(page).locator("#languageSelect")).toHaveCount(0);
});

test("on ?lang=es, Account lists both languages, in their own names, and switching saves English and loads the page again without ?lang", async ({ page }) => {
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
  expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.language"))).toBe("en");
});
