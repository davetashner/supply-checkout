// node --test scripts/check-web.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FETCH_TIMEOUT_MS, checkWeb, main, parseArgs, problemsWith, webChecks } from "./check-web.mjs";
import { DOMAIN, configParameterNames, opsConfigParameterNames } from "./publish-web.mjs";

const APP = "<!doctype html><title>app</title>";
const DEMO = "<!doctype html><title>demo</title>";
const CONFIG = Object.fromEntries(Object.keys(configParameterNames("prod")).map((k) => [k, `${k}-value`]));
const SECURITY = { "content-security-policy": "default-src 'self'", "strict-transport-security": "max-age=63072000" };
const OPS = "<!doctype html><title>ops</title>";
const OPS_CONFIG = Object.fromEntries(Object.keys(opsConfigParameterNames("prod")).map((k) => [k, `${k}-value`]));
const OPS_HEADERS = { "content-security-policy": "default-src 'none'; script-src 'self'", "strict-transport-security": "max-age=63072000", "cache-control": "no-store" };

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
const goodWithOps = () => ({
  ...good(),
  [`https://ops.${DOMAIN}/`]: response(200, OPS, OPS_HEADERS),
  [`https://ops.${DOMAIN}/ops-config.json`]: response(200, JSON.stringify(OPS_CONFIG), { "cache-control": "no-store" }),
  [`https://ops.${DOMAIN}/config.json`]: response(404, "", { "cache-control": "no-store" }),
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
  assert.ok(calls.every((c) => c.init.redirect === "manual" && c.init.cache === "no-store" && c.init.signal instanceof AbortSignal));
  assert.equal(FETCH_TIMEOUT_MS, 15_000);
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

test("with the operator page's index.html, checks its page, config and a 404, never cached", async () => {
  const checks = webChecks("prod", APP, DEMO, OPS);
  assert.deepEqual(checks.slice(3).map((c) => c.url), [`https://ops.${DOMAIN}/`, `https://ops.${DOMAIN}/ops-config.json`, `https://ops.${DOMAIN}/config.json`]);
  assert.equal(webChecks("staging", APP, DEMO, OPS)[3].url, `https://ops.staging.${DOMAIN}/`);
  const { fetch, calls } = fakeFetch(goodWithOps());
  assert.deepEqual(await checkWeb(checks, { fetch, ...quiet }), []);
  assert.equal(calls.length, 6);
});

test("each operator page check's problems", async () => {
  const [, , , ops, config, missing] = webChecks("prod", APP, DEMO, OPS);
  assert.deepEqual(await problemsWith(ops, response(200, OPS, OPS_HEADERS)), []);
  assert.deepEqual(await problemsWith(ops, response(200, OPS, { ...SECURITY, "cache-control": "max-age=60" })), [
    `https://ops.${DOMAIN}/ has no no-store in its cache-control header`,
    `https://ops.${DOMAIN}/ has no default-src 'none' in its content-security-policy header`,
  ]);
  assert.deepEqual(await problemsWith(ops, response(200, "<old>", OPS_HEADERS)), [`https://ops.${DOMAIN}/ isn't the index.html just published (yet)`]);
  assert.deepEqual(await problemsWith(config, response(200, JSON.stringify(OPS_CONFIG), { "cache-control": "no-store" })), []);
  assert.deepEqual(await problemsWith(config, response(200, JSON.stringify({ ...OPS_CONFIG, rumRegion: "x" }))), [
    `https://ops.${DOMAIN}/ops-config.json has no no-store in its cache-control header`,
    `https://ops.${DOMAIN}/ops-config.json has keys publish-web doesn't write: rumRegion`,
  ]);
  assert.deepEqual(await problemsWith(missing, response(404, "", { "cache-control": "no-store" })), []);
  assert.deepEqual(await problemsWith(missing, response(404, "")), [`https://ops.${DOMAIN}/config.json has no no-store in its cache-control header`]);
  assert.deepEqual(await problemsWith(missing, response(200, "{}", { "cache-control": "no-store" })), [`https://ops.${DOMAIN}/config.json answered 200, not 404`]);
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
  assert.deepEqual(parseArgs(["--app-index", "a", "--demo-index", "d", "--ops-index", "o"]).opsIndex, "o");
  writeFileSync(path.join(dir, "ops.html"), OPS);
  const withOps = fakeFetch(goodWithOps());
  const args = ["--app-index", path.join(dir, "app.html"), "--demo-index", path.join(dir, "demo.html"), "--ops-index", path.join(dir, "ops.html"), "--tries", "1"];
  assert.deepEqual(await main(args, { fetch: withOps.fetch, log: () => {} }), []);
  assert.equal(withOps.calls.length, 6);
});
