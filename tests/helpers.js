import { test as base, expect } from "@playwright/test";
import { builtFiles, currentBuild } from "../scripts/builds.mjs";
import { installMockClaude } from "./mock-claude.js";
import * as coverage from "./coverage.js";

const ORIGIN = "https://supply-checkout.test/";
// Fonts and CDN scripts, which openApp aborts to keep tests hermetic
const ABORTED = /^https:\/\/(fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net)\//;

// The console error a browser logs for a request openApp aborted. Chromium and
// WebKit say "Failed to load resource"; Firefox reports an aborted cross-origin
// stylesheet as "Cross-Origin Request Blocked … (Reason: CORS request did not
// succeed)", with the URL, so that error is only ignored for an aborted URL.
const isAbortedRequest = (text) =>
  /Failed to load resource/.test(text) ||
  (/Cross-Origin Request Blocked/.test(text) && (text.match(/https:\/\/[^\s"]+/g) || []).some((url) => ABORTED.test(url)));
// The build under test (BUILD=artifact or BUILD=web), built by tests/global-setup.js
const files = builtFiles(currentBuild());

// Every test fails on an uncaught exception or console error in the page.
export const test = base.extend({
  page: async ({ page, browserName }, use) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      // Aborted font/CDN requests are expected in tests
      if (m.type() === "error" && !isAbortedRequest(m.text())) errors.push(`console: ${m.text()}`);
    });
    // Only Chromium reports JS coverage
    const measure = coverage.enabled && browserName === "chromium";
    if (measure) await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    if (measure) await coverage.report().add(await page.coverage.stopJSCoverage());
    expect(errors, "page errors").toEqual([]);
  },
});
export { expect };

export async function openApp(page, opts = {}) {
  // Keep tests hermetic: no fonts or CDN scripts. The app works without ZXing.
  await page.route(ABORTED, (r) => r.abort());
  await page.route(ORIGIN + "**", (r) => {
    const file = files.get(new URL(r.request().url()).pathname);
    return file ? r.fulfill(file) : r.fulfill({ status: 404 });
  });
  await page.addInitScript(installMockClaude, opts);
  await page.goto(ORIGIN);
}

export async function createSheet(page, client) {
  await page.getByRole("button", { name: "+ New sheet" }).click();
  await page.getByLabel("Client", { exact: true }).fill(client);
  await page.getByRole("button", { name: "Create sheet" }).click();
  await expect(page.getByRole("heading", { name: client })).toBeVisible();
}

export async function enterBarcode(page, code) {
  await page.getByPlaceholder("Or type the barcode").fill(code);
  await page.getByPlaceholder("Or type the barcode").press("Enter");
}

export const modal = (page) => page.locator("#modal");
export const lineRow = (page, name) => page.locator("#sheetBody tbody tr", { hasText: name });
export const inventoryRow = (page, name) => page.locator("#main tbody tr", { hasText: name });
