// The barcode favicon (src/icons/) in each build: the web build and the demo link the
// SVG, a 32 px PNG and an apple-touch-icon, served alongside the page.
import { test, expect, openApp } from "./helpers.js";
import { DEMO, builtFiles } from "../scripts/builds.mjs";

// Each icon link on the page, fetched from the page: its href, status and type
const fetchIcons = (page) =>
  page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map(async (link) => {
        const response = await fetch(link.href);
        const bytes = (await response.arrayBuffer()).byteLength;
        return { rel: link.rel, href: link.getAttribute("href"), sizes: link.getAttribute("sizes"), status: response.status, type: response.headers.get("content-type"), bytes };
      }),
    ),
  );

function expectIcons(icons, build) {
  const prefix = build === DEMO ? "\\./assets/" : "/assets/";
  const icon = (rel, name, ext, sizes, type) => ({ rel, href: expect.stringMatching(new RegExp(`^${prefix}${name}-[\\w-]+\\.${ext}$`)), sizes, status: 200, type, bytes: expect.any(Number) });
  expect(icons).toEqual([
    icon("icon", "favicon-32", "png", "32x32", "image/png"),
    icon("icon", "favicon", "svg", null, "image/svg+xml"),
    icon("apple-touch-icon", "apple-touch-icon", "png", null, "image/png"),
  ]);
  for (const { bytes } of icons) expect(bytes).toBeGreaterThan(0);
}

test("the app links a barcode favicon that loads", async ({ page }) => {
  await openApp(page);
  await expect(page.getByText("Connecting…")).toBeHidden();
  expectIcons(await fetchIcons(page), "web");
});

test("the demo links a barcode favicon that loads under any path", async ({ page }) => {
  // Its own origin, so coverage of src/ ignores it
  const base = "https://favicon-demo.supply-checkout.test/some/path/";
  const files = builtFiles(DEMO);
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
  await page.route(new URL(base).origin + "/**", (r) => {
    const { pathname } = new URL(r.request().url());
    const file = pathname.startsWith("/some/path/") && files.get("/" + pathname.slice("/some/path/".length));
    return file ? r.fulfill(file) : r.fulfill({ status: 404 });
  });
  await page.goto(base);
  await expect(page.getByRole("button", { name: /Acme Offices/ })).toBeVisible();
  expectIcons(await fetchIcons(page), DEMO);
});
