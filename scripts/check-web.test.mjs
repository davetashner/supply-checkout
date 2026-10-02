// node --test scripts/check-web.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkWeb, main, parseArgs, problemsWith, webChecks } from "./check-web.mjs";
import { DOMAIN, configParameterNames } from "./publish-web.mjs";

const APP = "<!doctype html><title>app</title>";
const DEMO = "<!doctype html><title>demo</title>";
const CONFIG = Object.fromEntries(Object.keys(configParameterNames("prod")).map((k) => [k, `${k}-value`]));
const SECURITY = { "content-security-policy": "default-src 'self'", "strict-transport-security": "max-age=63072000" };

const response = (status, body, headers = {}) => ({
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  text: async () => body,
});

/** A fake fetch serving the site; `site` maps URLs to responses (or functions of the try). */
function fakeFetch(site) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const r = site[url];
    if (r === undefined) throw new Error(`unexpected ${url}`);
    return typeof r === "function" ? r(calls.filter((c) => c.url === url).length) : r;
  };
  return { fetch, calls };
}
const good = () => ({
  [`https://app.${DOMAIN}/`]: response(200, APP, SECURITY),
  [`https://app.${DOMAIN}/config.json`]: response(200, JSON.stringify(CONFIG)),
  [`https://${DOMAIN}/demo/`]: response(200, DEMO),
});
const quiet = { log: () => {}, wait: async () => {} };

test("checks the app, its config.json and the demo, on the environment's domain", () => {
  const checks = webChecks("prod", APP, DEMO);
  assert.deepEqual(checks.map((c) => c.url), [`https://app.${DOMAIN}/`, `https://app.${DOMAIN}/config.json`, `https://${DOMAIN}/demo/`]);
  assert.equal(webChecks("staging", APP, DEMO)[2].url, `https://staging.${DOMAIN}/demo/`);
});

test("passes when everything is live", async () => {
  const { fetch, calls } = fakeFetch(good());
  assert.deepEqual(await checkWeb(webChecks("prod", APP, DEMO), { fetch, ...quiet }), []);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.init.redirect === "manual" && c.init.cache === "no-store"));
});

test("tries again until the new release is live", async () => {
  const site = good();
  site[`https://app.${DOMAIN}/`] = (n) => response(200, n < 3 ? "<old>" : APP, SECURITY);
  const { fetch } = fakeFetch(site);
  const waits = [];
  const lines = [];
  const problems = await checkWeb(webChecks("prod", APP, DEMO), { fetch, wait: async (ms) => waits.push(ms), log: (l) => lines.push(l), tries: 5, waitMs: 7 });
  assert.deepEqual(problems, []);
  assert.deepEqual(waits, [7, 7]);
  assert.match(lines[0], /Try 1 of 5: .* isn't the index.html just published/);
});

test("gives up after the last try, with what's wrong", async () => {
  const site = good();
  site[`https://${DOMAIN}/demo/`] = response(503, "");
  const { fetch } = fakeFetch(site);
  const waits = [];
  const problems = await checkWeb(webChecks("prod", APP, DEMO), { fetch, wait: async (ms) => waits.push(ms), log: () => {}, tries: 3, waitMs: 1 });
  assert.deepEqual(problems, [`https://${DOMAIN}/demo/ answered 503, not 200`]);
  assert.equal(waits.length, 2, "no wait after the last try");
});

test("a network error is a problem, not a crash", async () => {
  const fetch = async () => { throw new Error("getaddrinfo ENOTFOUND"); };
  const problems = await checkWeb(webChecks("prod", APP, DEMO), { fetch, ...quiet, tries: 1 });
  assert.equal(problems.length, 3);
  assert.match(problems[0], /failed: getaddrinfo ENOTFOUND/);
});

test("each check's problems", async () => {
  const [app, config, demo] = webChecks("prod", APP, DEMO);
  assert.deepEqual(await problemsWith(app, response(200, APP, SECURITY)), []);
  assert.deepEqual(await problemsWith(app, response(200, APP, {})), [
    `https://app.${DOMAIN}/ has no content-security-policy header`,
    `https://app.${DOMAIN}/ has no strict-transport-security header`,
  ]);
  assert.deepEqual(await problemsWith(app, response(302, "", SECURITY)), [`https://app.${DOMAIN}/ answered 302, not 200`]);
  assert.deepEqual(await problemsWith(demo, response(200, "<other>")), [`https://${DOMAIN}/demo/ isn't the index.html just published (yet)`]);
  assert.deepEqual(await problemsWith(config, response(200, JSON.stringify(CONFIG))), []);
  assert.deepEqual(await problemsWith(config, response(200, "<html>")), [`https://app.${DOMAIN}/config.json isn't JSON`]);
  const { apiUrl, ...rest } = CONFIG;
  assert.ok(apiUrl);
  assert.deepEqual(await problemsWith(config, response(200, JSON.stringify({ ...rest, clientId: "", extra: "x" }))), [
    `https://app.${DOMAIN}/config.json is missing apiUrl, clientId`,
    `https://app.${DOMAIN}/config.json has keys publish-web doesn't write: extra`,
  ]);
  assert.deepEqual(await problemsWith(config, response(200, "null")), [`https://app.${DOMAIN}/config.json is missing ${Object.keys(CONFIG).join(", ")}`]);
});

test("options, and main reads the published index.html files", async () => {
  assert.throws(() => parseArgs([]), /--app-index and --demo-index are required/);
  assert.throws(() => parseArgs(["--app-index", "a", "--demo-index", "d", "--tries", "0"]), /--tries/);
  assert.throws(() => parseArgs(["--app-index", "a", "--demo-index", "d", "--wait", "x"]), /--wait/);
  assert.throws(() => parseArgs(["--app-index"]), /needs a value/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
  assert.deepEqual(parseArgs(["--app-index", "a", "--demo-index", "d"]), { env: "prod", tries: 12, wait: 10, appIndex: "a", demoIndex: "d" });
  const dir = mkdtempSync(path.join(tmpdir(), "check-web-"));
  writeFileSync(path.join(dir, "app.html"), APP);
  writeFileSync(path.join(dir, "demo.html"), DEMO);
  const { fetch } = fakeFetch(good());
  const problems = await main(["--app-index", path.join(dir, "app.html"), "--demo-index", path.join(dir, "demo.html"), "--tries", "1", "--wait", "0"], { fetch, log: () => {} });
  assert.deepEqual(problems, []);
});
