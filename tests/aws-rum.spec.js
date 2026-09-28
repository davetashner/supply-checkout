// CloudWatch RUM in the web build (src/aws/rum.js, supply-checkout-al0): errors and page
// performance reach the app monitor with the release version, signed with the identity
// pool's guest credentials, and without query strings, email addresses, cookies or anything
// about the signed-in user. Cognito and the RUM data plane are faked here.
import { test, expect } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { readFileSync } from "node:fs";
import { FakeBackend, FakeRum, RUM, RUM_REGION as REGION, TEAM, USER, CONFIG, openAws, connected } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "RUM is only in the web build");

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const withRum = (extra = {}, options = {}) => new FakeBackend({ ...options, config: { ...CONFIG, ...RUM, ...extra } });

test("reports an error with the release version, signed with the pool's guest credentials, and nothing personal", async ({ page }) => {
  const rum = new FakeRum();
  await rum.install(page);
  // An invite link, signed out: its token must never reach RUM
  await openAws(page, withRum({}, { signedIn: false }), { path: "/?invite=i1&token=invite-secret" });
  await expect(page.locator("#account")).toContainText("Sign in with the email address your invite was sent to");
  // What the browser dispatches for an uncaught error, with a URL and an address in it
  await page.evaluate(() => {
    const error = new Error("Couldn't load https://supply-checkout.test/?invite=i1&token=invite-secret#frag for pat@example.com");
    window.dispatchEvent(new ErrorEvent("error", { message: error.message, filename: "https://supply-checkout.test/?code=sign-in-code", lineno: 3, colno: 7, error }));
  });

  // The client sends every 5 seconds
  await expect.poll(() => rum.events().some((e) => e.type === "com.amazon.rum.js_error_event"), { timeout: 20_000 }).toBe(true);
  const error = rum.events().find((e) => e.type === "com.amazon.rum.js_error_event");
  expect(error.details).toMatchObject({
    type: "Error",
    message: "Couldn't load https://supply-checkout.test/ for [email]",
    filename: "https://supply-checkout.test/",
    lineno: 3,
    colno: 7,
  });
  // With a stack trace (Chromium's starts with the message, scrubbed too; WebKit's doesn't)
  expect(error.details.stack).toEqual(expect.any(String));
  expect(error.metadata.pageId).toBe("/");

  const [batch] = rum.batches;
  expect(batch.body.AppMonitorDetails).toMatchObject({ id: RUM.rumAppMonitorId, version });
  // No cookies: an anonymous user
  expect(batch.body.UserDetails.userId).toBe("00000000-0000-0000-0000-000000000000");
  expect(await page.evaluate(() => document.cookie)).toBe("");
  // Signed (SigV4) with the guest credentials from the identity pool, in the enhanced flow
  expect(batch.headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDGUEST/\\d{8}/${REGION}/rum/aws4_request`));
  expect(batch.headers["x-amz-security-token"]).toBe("guest-session");
  expect(rum.cognito.map((c) => c.target)).toEqual(["AWSCognitoIdentityService.GetId", "AWSCognitoIdentityService.GetCredentialsForIdentity"]);
  expect(rum.cognito[0].body).toEqual({ IdentityPoolId: RUM.rumIdentityPoolId });
  expect(rum.other).toEqual([]);

  // The landing page view, and nothing from a URL's query string or fragment
  const sent = rum.batches.map((b) => b.text).join("\n");
  expect(rum.events().find((e) => e.type === "com.amazon.rum.page_view_event").details.pageId).toBe("/");
  for (const secret of ["invite-secret", "sign-in-code", "invite=", "pat@example.com", "#frag"]) expect(sent).not.toContain(secret);
});

test("sends page performance: the page's navigation timing", async ({ page }) => {
  const rum = new FakeRum();
  await rum.install(page);
  await openAws(page, withRum());
  await connected(page);
  await expect.poll(() => rum.events().some((e) => e.type === "com.amazon.rum.performance_navigation_event"), { timeout: 20_000 }).toBe(true);
  // Nothing about the signed-in user or their team
  const sent = rum.batches.map((b) => b.text).join("\n");
  for (const personal of [USER.email, USER.id, TEAM.name, "Pat Lee"]) expect(sent).not.toContain(personal);
  // No HTTP telemetry: the API's requests (with team and document IDs in their paths) aren't sent
  expect(sent).not.toContain("/_api/");
  expect(rum.events().map((e) => e.type)).not.toContain("com.amazon.rum.http_event");
});

test("without an app monitor in config.json, or with a pool from another region, the RUM client isn't loaded", async ({ page }) => {
  const rum = new FakeRum();
  await rum.install(page);
  // The pool's ID starts with its region, which must be the monitor's
  await openAws(page, withRum({ rumIdentityPoolId: "elsewhere-1:pool-1" }));
  await connected(page);
  const scripts = await page.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((u) => u.endsWith(".js")));
  expect(scripts.some((u) => u.includes("/assets/rum-"))).toBe(false);
  expect(rum.cognito).toEqual([]);
  expect(rum.batches).toEqual([]);
  expect(rum.other).toEqual([]);
});

test("the app still runs when the RUM client can't load", async ({ page }) => {
  const rum = new FakeRum();
  await rum.install(page);
  const backend = withRum();
  const serve = backend.serveFile.bind(backend);
  let tried = false;
  backend.serveFile = (route, url) => {
    if (!url.pathname.startsWith("/assets/rum-")) return serve(route, url);
    tried = true;
    return route.abort();
  };
  await openAws(page, backend);
  await connected(page);
  await expect(page.locator(".teambar")).toContainText(TEAM.name);
  expect(tried).toBe(true);
  expect(rum.cognito).toEqual([]);
});
