// The Content-Security-Policy CloudFront sends (infra/lib/web/content-security-policy.ts)
// must not break the app or the demo. Each build is served with that header, and a test
// fails on any violation: the page fixture already fails on the console error a browser
// logs, and each test also collects securitypolicyviolation events.
import { test, expect, createSheet, enterBarcode, modal } from "./helpers.js";
import { DEMO, builtFiles, currentBuild } from "../scripts/builds.mjs";
import { installMockClaude } from "./mock-claude.js";
import { fakeImage } from "./fixtures.js";
import { contentSecurityPolicy } from "../infra/lib/web/content-security-policy.ts";
import { FakeBackend, installFakeSocket, TEAM } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "CloudFront serves the web and demo builds; the artifact runs under claude.ai's own policy");

const CSP = contentSecurityPolicy({ api: "api.supplycheckout.com", realtime: "realtime.supplycheckout.com", auth: "auth.supplycheckout.com" });
// Their own origins, so coverage of the other suites isn't affected
const APP = "https://csp-app.supply-checkout.test";
const DEMO_SITE = "https://csp-demo.supply-checkout.test";
const THIRD_PARTY = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const png = {
  name: "barcode.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
};

// Serves a build at origin (under prefix, as CloudFront serves the demo at /demo/) with
// the CloudFront headers on the page, and records violations
async function serve(page, origin, files, prefix = "") {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__cspViolations.push(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"} (${e.sourceFile}:${e.lineNumber})`),
    );
  });
  // Fonts pass the policy before the request is made; then they're aborted
  // to keep tests offline, as in the other suites.
  await page.route(THIRD_PARTY, (r) => r.abort());
  await page.route(origin + "/**", (r) => {
    const { pathname } = new URL(r.request().url());
    const file = pathname.startsWith(prefix + "/") && files.get(pathname.slice(prefix.length));
    if (!file) return r.fulfill({ status: 404 });
    const headers = { "content-type": file.contentType };
    if (file.contentType === "text/html") headers["content-security-policy"] = CSP;
    return r.fulfill({ ...file, headers });
  });
}

// Loads each favicon the page links as an image, as a browser tab would (img-src)
const loadIcons = (page) =>
  page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map((link) => {
        const img = new Image();
        img.src = link.href;
        return img.decode().then(() => img.naturalWidth > 0);
      }),
    ),
  );

const violations = (page) => page.evaluate(() => window.__cspViolations);

test("the web app runs under the policy", async ({ page }) => {
  await serve(page, APP, builtFiles("web"));
  await page.addInitScript(installMockClaude, {});
  await page.goto(APP + "/");
  await expect(page.getByText("Connecting…")).toBeHidden();

  // A blob: image (the barcode photo), then markup with inline style attributes in a modal
  await createSheet(page, "Policy Test");
  await page.setInputFiles("#scanFile", png);
  // No barcode in the photo, so ZXing was loaded: its own chunk, from the app's origin (script-src 'self')
  await expect(page.locator("#toast")).toContainText("No barcode found");
  const scripts = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.endsWith(".js")));
  expect(scripts.some((u) => u.startsWith(APP + "/assets/zxing-"))).toBe(true);
  await enterBarcode(page, "012345678905");
  const form = modal(page).locator("form#f");
  await expect(form).toBeVisible();
  // style="display:grid" applies: style-src-attr allows it
  expect(await form.evaluate((el) => getComputedStyle(el).display)).toBe("grid");

  const header = await page.evaluate(async () => (await fetch("/")).headers.get("content-security-policy"));
  expect(header).toBe(CSP);
  expect(await loadIcons(page)).toEqual([true, true, true]);
  expect(await violations(page)).toEqual([]);
});

test("the web app signs in and loads its data from the API under the policy", async ({ page }) => {
  // The API on its own origin, as deployed: cross-origin requests with credentials
  const config = { apiUrl: "https://api.supplycheckout.com/_api", authUrl: "https://auth.supplycheckout.com", clientId: "c", realtimeUrl: "wss://realtime.supplycheckout.com/event/realtime", realtimeHost: "realtime.supplycheckout.com" };
  const backend = new FakeBackend({ config, docs: { "t1/sheets/s1": { client: "Policy Co", date: "2026-09-26", status: "open", items: {} } } });
  backend.cors = APP;
  await serve(page, APP, builtFiles("web"));
  await page.route(APP + "/config.json", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(config) }));
  await page.route("https://api.supplycheckout.com/**", (r) => backend.route(r));
  await page.addInitScript(installFakeSocket, {});
  await page.goto(APP + "/");
  await expect(page.getByRole("button", { name: /Policy Co/ })).toBeVisible();
  await expect(page.locator(".teambar")).toContainText(TEAM.name);
  expect(backend.requests("POST", "/auth/refresh")[0].headers.origin).toBe(APP);
  expect(await violations(page)).toEqual([]);
});

test("the demo runs under the policy at /demo/, including its barcode reader, CSV download and receipt", async ({ page }) => {
  await serve(page, DEMO_SITE, builtFiles(DEMO), "/demo");
  await page.goto(DEMO_SITE + "/demo/");
  await page.getByRole("button", { name: /Acme Offices/ }).click();
  await expect(page.getByRole("heading", { name: "Acme Offices" })).toBeVisible();

  // ZXing's chunk resolves under /demo/ too
  await page.setInputFiles("#scanFile", png);
  await expect(page.locator("#toast")).toContainText("No barcode found");
  const scripts = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.endsWith(".js")));
  expect(scripts.some((u) => u.startsWith(DEMO_SITE + "/demo/assets/zxing-"))).toBe(true);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download CSV/ }).click();
  await download;

  await page.getByRole("button", { name: "← All sheets" }).click();
  await page.setInputFiles("#receiptFile", fakeImage);
  await expect(page.locator(".rline")).toHaveCount(3);

  const icons = await page.evaluate(() => [...document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map((l) => l.href));
  for (const href of icons) expect(href.startsWith(DEMO_SITE + "/demo/assets/"), href).toBe(true);
  expect(await loadIcons(page)).toEqual([true, true, true]);
  expect(await violations(page)).toEqual([]);
});
