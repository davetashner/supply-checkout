// Keeps `npm run dev` working: serves the app with the mock runtime, demo data
// and the query-string options documented in scripts/dev-server.mjs.
import { test, expect } from "./helpers.js";
import { createDevServer } from "../scripts/dev-server.mjs";

let server, base;
test.beforeAll(async () => {
  server = createDevServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
});
test.afterAll(() => new Promise((resolve) => server.close(resolve)));

const open = async (page, query = "") => {
  // Keep tests offline: the app works without fonts or ZXing
  await page.route(/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/, (r) => r.abort());
  await page.goto(base + query);
};

test("serves the app with demo sheets and inventory", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("button", { name: /Acme Offices/ })).toBeVisible();
  await page.getByRole("button", { name: "Returned" }).click();
  await expect(page.getByRole("button", { name: /Harbor Dental/ })).toBeVisible();
  await page.getByRole("button", { name: "Inventory" }).click();
  await expect(page.locator("#main tbody tr")).toHaveCount(4);
});

test("demo receipt reading matches inventory", async ({ page }) => {
  await open(page);
  await page.setInputFiles("#receiptFile", { name: "r.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") });
  await expect(page.locator(".rline")).toHaveCount(3);
  await expect(page.locator(".rline").first()).toContainText("Suggested match");
});

test("?seed=empty starts with no data", async ({ page }) => {
  await open(page, "?seed=empty");
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await page.getByRole("button", { name: "Inventory" }).click();
  await expect(page.getByText("No items yet.")).toBeVisible();
});

test("?viewer gives view-only access", async ({ page }) => {
  await open(page, "?viewer");
  await expect(page.locator("#notice")).toContainText("view-only access");
  await expect(page.getByRole("button", { name: "+ New sheet" })).toHaveCount(0);
});

test("?nouser asks who prepared a new sheet", async ({ page }) => {
  await open(page, "?nouser");
  await page.getByRole("button", { name: "+ New sheet" }).click();
  await expect(page.getByLabel("Prepared by")).toBeVisible();
});

test("?mock passes options to the runtime", async ({ page }) => {
  await open(page, "?mock=" + encodeURIComponent(JSON.stringify({ sampleError: "rate_limited" })));
  await page.setInputFiles("#receiptFile", { name: "r.jpg", mimeType: "image/jpeg", buffer: Buffer.from("x") });
  await expect(page.getByText("Too many requests right now")).toBeVisible();
});

test("other paths are not found", async ({ request }) => {
  expect((await request.get(base + "favicon.ico")).status()).toBe(404);
});
