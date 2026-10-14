// The language on Account in the web build (supply-checkout-3ilj): English and Spanish, each in its own name,
// saved on the device, and the page loads again in the language picked. Against the fake backend in
// tests/fake-aws.js.
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
  expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.language"))).toBe("es");
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
  expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.language"))).toBe("en");
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
