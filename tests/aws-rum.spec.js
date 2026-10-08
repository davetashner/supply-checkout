// CloudWatch RUM in the web build (src/aws/rum.js, supply-checkout-al0): errors and page
// performance reach the app monitor with the release version, signed with the identity
// pool's guest credentials, and without query strings, email addresses, cookies or anything
// about the signed-in user. Cognito and the RUM data plane are faked here.
import { test, expect } from "./helpers.js";
import { readFileSync } from "node:fs";
import { FakeBackend, FakeRum, RUM, RUM_REGION as REGION, TEAM, USER, CONFIG, openAws, connected } from "./fake-aws.js";


const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const withRum = (extra = {}, options = {}) => new FakeBackend({ ...options, config: { ...CONFIG, ...RUM, ...extra } });

test("reports an error with the release version, signed with the pool's guest credentials, and nothing personal", async ({ page, browserName }) => {
  const rum = new FakeRum();
  await rum.install(page);
  // An invite link, signed out: its token must never reach RUM
  await openAws(page, withRum({}, { signedIn: false }), { path: "/?invite=i1&token=invite-secret" });
  await expect(page.locator("#account")).toContainText("Sign in with the email address your invite was sent to");
  // What the browser dispatches for an uncaught error, with a URL and an address in it
  await page.evaluate(() => {
    const error = new Error("Couldn't load https://supply-checkout.test/?invite=i1&token=invite-secret#frag and /teams/t1/projects?cursor=page-secret for pat@example.com with eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1LXBhdCJ9.sig-part");
    window.dispatchEvent(new ErrorEvent("error", { message: error.message, filename: "https://supply-checkout.test/?code=sign-in-code", lineno: 3, colno: 7, error }));
  });

  // The client sends every 5 seconds
  await expect.poll(() => rum.events().some((e) => e.type === "com.amazon.rum.js_error_event"), { timeout: 20_000 }).toBe(true);
  const error = rum.events().find((e) => e.type === "com.amazon.rum.js_error_event");
  expect(error.details).toMatchObject({
    type: "Error",
    message: "Couldn't load https://supply-checkout.test/ and /teams/t1/projects for [email] with [token]",
  });
  // Chromium and WebKit report the event's position; Firefox takes it from the stack, which here is the evaluated code
  if (browserName !== "firefox") expect(error.details).toMatchObject({ filename: "https://supply-checkout.test/", lineno: 3, colno: 7 });
  expect(error.details.filename).not.toMatch(/[?#]|sign-in-code/);
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
  for (const secret of ["invite-secret", "sign-in-code", "invite=", "pat@example.com", "#frag", "page-secret", "eyJ"]) expect(sent).not.toContain(secret);
});

test("scrubbing fails closed: details it can't read aren't recorded, and a client event it can't clean stops the client", async ({ page }) => {
  const rum = new FakeRum();
  await rum.install(page);
  await openAws(page, withRum());
  await connected(page);
  // The RUM client's own chunk, as the app loaded it
  const chunk = await page.waitForFunction(() => performance.getEntriesByType("resource").map((e) => e.name).find((u) => u.includes("/assets/rum-")));
  const results = await page.evaluate(async (url) => {
    const { scrub, scrubbedRecorder, scrubInPlace, scrubOrStop } = await import(url);
    const unreadable = () => Object.defineProperty({}, "message", { enumerable: true, get() { throw new Error("no"); } });

    // Copies, at any depth, with paths' queries, tokens and addresses taken out
    const details = { version: "1.0.0", n: 3, none: null, targetUrl: "./assets/app.js?v=2#x", list: ["/teams/t1?cursor=c1", { note: "pat@example.com eyJa.eyJb.c" }] };
    const copy = scrub(details);

    // A plugin's record: a scrubbed copy, or nothing when the details can't be read
    const recorded = [];
    const record = scrubbedRecorder((type, d, meta) => recorded.push([type, d, meta]));
    record("ok", { message: "see /x?token=t" }, { m: 1 });
    record("unreadable", unreadable());

    // The client's own events, cleaned in place
    const plain = { referrer: "https://supply-checkout.test/?code=c" };
    const locked = Object.defineProperty({ keep: "x" }, "referrer", { enumerable: true, configurable: true, writable: false, value: "https://a.test/?code=c" });
    const frozen = Object.freeze({ referrer: "https://a.test/?code=c" });
    const inPlace = [scrubInPlace(plain), plain, scrubInPlace(locked), locked, scrubInPlace(frozen), scrubInPlace(unreadable())];

    // The hook stops the client when an event can't be cleaned, and only then
    let stopped = 0;
    const hook = scrubOrStop({ disable: () => stopped++ });
    hook("page", { referrer: "/?code=c" });
    const afterClean = stopped;
    hook("page", Object.freeze({ referrer: "/?code=c" }));
    return { details, copy, recorded, inPlace, afterClean, stopped };
  }, await chunk.jsonValue());

  expect(results.copy).toEqual({ version: "1.0.0", n: 3, none: null, targetUrl: "./assets/app.js", list: ["/teams/t1", { note: "[email] [token]" }] });
  // The original is left as it was
  expect(results.details.targetUrl).toBe("./assets/app.js?v=2#x");
  expect(results.recorded).toEqual([["ok", { message: "see /x" }, { m: 1 }]]);
  expect(results.inPlace).toEqual([
    true, { referrer: "https://supply-checkout.test/" },
    // A read-only field is removed rather than kept
    true, { keep: "x" },
    // A frozen object or one that can't be read can't be cleaned
    false, false,
  ]);
  expect(results.afterClean).toBe(0);
  expect(results.stopped).toBe(1);
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

// The client asks for its credentials once without waiting (src/aws/rum.js handledProvider):
// when Cognito fails, that's no uncaught error (the page fixture fails on one), and the app runs
test("the app still runs, with no uncaught error, when the RUM client can't get its credentials", async ({ page }) => {
  const rum = new FakeRum({ cognitoFails: true });
  await rum.install(page);
  await openAws(page, withRum());
  await connected(page);
  await expect(page.locator(".teambar")).toContainText(TEAM.name);
  // Tried, and tried again (the client retries once), and every try failed
  await expect.poll(() => rum.cognito.length).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(500);
  expect(rum.cognito.every((c) => c.target === "AWSCognitoIdentityService.GetId")).toBe(true);
  expect(rum.batches).toEqual([]);
});
