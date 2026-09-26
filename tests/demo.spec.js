// The demo build (npm run build:demo) for supplycheckout.com: the app with its own
// in-memory runtime and demo data, and a banner saying so. It's built and tested
// with the web build (BUILD=web), in every browser.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, modal, lineRow } from "./helpers.js";
import { DEMO, builtFiles, currentBuild } from "../scripts/builds.mjs";
import { fakeImage } from "./fixtures.js";

test.skip(currentBuild() !== "web", "The demo is built and tested with the web build");

// Served under a path, to show the build's URLs are relative. The origin differs
// from the other suites', so coverage (of src/ in the web build) ignores it.
const BASE = "https://demo.supply-checkout.test/some/path/";
const ORIGIN = new URL(BASE).origin;
// The only places the demo may reach: itself, Google Fonts and ZXing's CDN
const ALLOWED = [ORIGIN, "https://fonts.googleapis.com", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"];
const THIRD_PARTY = /^https:\/\/(fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net)\//;

const files = currentBuild() === "web" ? builtFiles(DEMO) : new Map();

// Opens the demo and returns every URL the page requested
async function openDemo(page) {
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  // Record fonts and CDN requests, but keep tests offline
  await page.route(THIRD_PARTY, (r) => r.abort());
  await page.route(ORIGIN + "/**", (r) => {
    const { pathname } = new URL(r.request().url());
    const file = pathname.startsWith("/some/path/") && files.get("/" + pathname.slice("/some/path/".length));
    return file ? r.fulfill(file) : r.fulfill({ status: 404 });
  });
  // Anything else would be a real network request: fail it loudly
  await page.route((url) => !ALLOWED.includes(url.origin), (r) => r.abort());
  await page.goto(BASE);
  await expect(page.getByRole("button", { name: /Acme Offices/ })).toBeVisible();
  return requests;
}

const expectOnlyAllowed = (requests) => {
  // blob: URLs (the CSV download) carry the page's own origin
  const elsewhere = requests.filter((url) => !url.startsWith("data:") && !ALLOWED.includes(new URL(url).origin));
  expect(elsewhere, "requests outside the page, Google Fonts and cdn.jsdelivr.net").toEqual([]);
  expect(requests.filter((url) => url.startsWith(ORIGIN)).length, "the page and its assets").toBeGreaterThan(1);
};

test("says it's a demo, checks out, reads a receipt and downloads, without leaving the page", async ({ page }) => {
  const requests = await openDemo(page);
  await expect(page).toHaveTitle("Supply Checkout demo");
  const banner = page.getByRole("complementary", { name: "Demo" });
  await expect(banner).toHaveText("Demo: nothing you enter is saved. Data resets when you reload.");

  // Check out two more boxes of gloves on the open sheet
  await page.getByRole("button", { name: /Acme Offices/ }).click();
  await expect(page.getByRole("heading", { name: "Acme Offices" })).toBeVisible();
  await expect(page.getByText("Prepared by Demo user")).toBeVisible();
  await page.getByPlaceholder("Or type the barcode").fill("012345678905");
  await page.getByPlaceholder("Or type the barcode").press("Enter");
  await modal(page).locator("#fQty").fill("2");
  await modal(page).getByRole("button", { name: "Add 2 to sheet" }).click();
  await expect(lineRow(page, "Nitrile gloves")).toContainText("4");
  await expect(page.locator(".totals .charge")).toHaveText("$67.00");

  // The CSV is a real download, made in the page
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download CSV/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^Acme Offices \d{4}-\d{2}-\d{2}\.csv$/);

  // Receipt reading answers with the demo receipt after a pause
  await page.getByRole("button", { name: "← All sheets" }).click();
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.locator(".rline")).toHaveCount(3);
  await expect(page.locator(".rline").first()).toContainText("Suggested match");

  expectOnlyAllowed(requests);
  expect(requests.some((url) => url.startsWith(BASE + "assets/"))).toBe(true);
});

test("a reload starts over with the demo data", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: /Acme Offices/ }).click();
  await page.getByRole("button", { name: "Delete sheet" }).click();
  await page.getByRole("button", { name: "Tap again to delete" }).click();
  await expect(page.getByRole("button", { name: /Acme Offices/ })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: /Acme Offices/ })).toBeVisible();
});

for (const colorScheme of ["light", "dark"]) {
  test(`the banner is accessible in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await openDemo(page);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test.describe("at 320px", () => {
  test.use({ viewport: { width: 320, height: 740 } });

  test("the banner doesn't make the page scroll sideways", async ({ page }) => {
    await openDemo(page);
    // A wide fallback font, as in layout.spec.js
    await page.addStyleTag({ content: "*{font-family:Verdana,'DejaVu Sans',sans-serif !important}" });
    const banner = await page.getByRole("complementary", { name: "Demo" }).boundingBox();
    expect(banner.x + banner.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});
