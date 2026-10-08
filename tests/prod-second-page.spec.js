// The prod suite's second-context error watch (watchAppErrors in tests/prod/steps.mjs): it
// collects a page's console errors until stopped, and secondPage stops it before closing its
// context. Closing a context the test made makes Playwright's runner screenshot its pages
// (screenshot "only-on-failure"), adding a caret-hiding <style> that WebKit refuses under the
// app's CSP and logs as the page's console error. That error is Playwright's, not the app's.
import { expect, test } from "@playwright/test";
import { watchAppErrors } from "./prod/steps.mjs";

test.use({ screenshot: "only-on-failure" });

const ORIGIN = "https://second-page.supply-checkout.test";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'";

async function openContext(browser) {
  const context = await browser.newContext();
  await context.route(`${ORIGIN}/**`, (r) => r.fulfill({ body: "<!doctype html><title>App</title><button>Hi</button>", headers: { "content-type": "text/html", "content-security-policy": CSP } }));
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  return { context, page };
}

test("an app error is collected until the watch stops, and closing the context afterwards adds nothing", async ({ browser }) => {
  const { context, page } = await openContext(browser);
  const watch = watchAppErrors(page, [ORIGIN]);
  await page.evaluate(() => console.error("the app logged this"));
  await expect.poll(() => watch.errors.length).toBe(1);
  const errors = watch.stop();
  await context.close();
  expect(errors).toEqual(["console: the app logged this"]);
  expect(watch.errors).toEqual(["console: the app logged this"]);
});

test("without stopping first, WebKit logs the runner's close-time screenshot style as a CSP error", async ({ browser, browserName }) => {
  test.skip(browserName !== "webkit", "WebKit's behavior, the reason for stopping first");
  const { context, page } = await openContext(browser);
  const watch = watchAppErrors(page, [ORIGIN]);
  await context.close();
  expect(watch.errors.join("\n")).toContain("Refused to apply a stylesheet");
});
