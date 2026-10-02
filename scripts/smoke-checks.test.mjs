// node --test scripts/smoke-checks.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DOMAIN } from "./publish-web.mjs";
import { FETCH_TIMEOUT_MS, hosts, main, parseArgs, report, runCheck, runSmoke, smokeChecks } from "./smoke-checks.mjs";

const status = (s) => ({ status: s });
/** A fake internet: `site` maps URLs to statuses (or functions of the try); `dns` lists hosts that resolve. */
function fake(site, dns = [`realtime.${DOMAIN}`, `auth.${DOMAIN}`]) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const s = site[url];
    if (s === undefined) throw new Error(`unexpected ${url}`);
    if (s instanceof Error) throw s;
    return status(typeof s === "function" ? s(calls.filter((c) => c.url === url).length) : s);
  };
  const lookup = async (host) => {
    if (!dns.includes(host)) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return { address: "192.0.2.1", family: 4 };
  };
  return { fetch, lookup, calls };
}
const healthy = () => ({
  [`https://api.${DOMAIN}/me`]: 401,
  [`https://api.${DOMAIN}/ops/teams`]: 401,
  [`https://realtime.${DOMAIN}/event`]: 404,
  [`https://auth.${DOMAIN}/`]: 404,
});
const quiet = { log: () => {}, wait: async () => {} };

test("the hosts are infra/lib/domain.ts's", () => {
  const source = readFileSync(new URL("../infra/lib/domain.ts", import.meta.url), "utf8");
  for (const name of ["api", "realtime", "auth"]) assert.ok(source.includes(`${name}: \`${name}.\${apex}\``), name);
  assert.deepEqual(hosts("prod"), { api: `api.${DOMAIN}`, realtime: `realtime.${DOMAIN}`, auth: `auth.${DOMAIN}` });
  assert.equal(hosts("staging").api, `api.staging.${DOMAIN}`);
});

test("checks the API refuses an anonymous caller, and live updates and sign-in answer", () => {
  assert.deepEqual(smokeChecks("prod").map((c) => c.url), [
    `https://api.${DOMAIN}/me`,
    `https://api.${DOMAIN}/ops/teams`,
    `https://realtime.${DOMAIN}/event`,
    `https://auth.${DOMAIN}/`,
  ]);
});

test("all pass on a healthy prod, with timeouts and no redirects followed", async () => {
  const f = fake(healthy());
  const results = await runSmoke(smokeChecks("prod"), { ...f, ...quiet });
  assert.ok(results.every((r) => r.passed && r.result === "ok"));
  assert.ok(f.calls.every((c) => c.init.redirect === "manual" && c.init.signal instanceof AbortSignal));
  assert.equal(FETCH_TIMEOUT_MS, 15_000);
  assert.match(report(results), /All 4 passed/);
});

test("what fails each check", async () => {
  const [me, , realtime] = smokeChecks("prod");
  const run = (check, site, dns) => runCheck(check, fake(site, dns));
  assert.equal(await run(me, { [me.url]: 200 }), "answered 200");
  assert.equal(await run(me, { [me.url]: 502 }), "answered 502");
  assert.equal(await run(me, { [me.url]: new Error("ECONNRESET") }), "request failed (ECONNRESET)");
  assert.equal(await run(realtime, { [realtime.url]: 503 }), "answered 503");
  assert.equal(await run(realtime, { [realtime.url]: 404 }, []), "doesn't resolve (ENOTFOUND)");
  assert.equal(await run(realtime, { [realtime.url]: 400 }), "");
});

test("tries again before failing, and reports every check", async () => {
  const site = healthy();
  site[`https://api.${DOMAIN}/me`] = (n) => (n < 3 ? 503 : 401);
  site[`https://auth.${DOMAIN}/`] = 500;
  const waits = [];
  const results = await runSmoke(smokeChecks("prod"), { ...fake(site), log: () => {}, wait: async (ms) => waits.push(ms), tries: 3, waitMs: 9 });
  assert.deepEqual(results.map((r) => r.passed), [true, true, true, false]);
  assert.equal(results[3].result, "answered 500");
  assert.deepEqual(waits, [9, 9, 9, 9]);
  const text = report(results);
  assert.match(text, /\*\*1 of 4 failed\.\*\* The stacks aren't rolled back automatically/);
  assert.match(text, /\| \*\*FAIL\*\* \| auth\.supplycheckout\.com resolves and answers \| resolves; HTTPS status below 500 \| answered 500 \|/);
});

test("main prints, appends to the summary, and exits 1 on a failure", async () => {
  const appended = [];
  const ok = await main(["--summary", "/tmp/summary", "--tries", "1"], { ...fake(healthy()), log: () => {}, append: (file, text) => appended.push([file, text]) });
  assert.equal(ok, 0);
  assert.equal(appended[0][0], "/tmp/summary");
  assert.match(appended[0][1], /## Post-deploy checks/);
  const site = healthy();
  site[`https://api.${DOMAIN}/ops/teams`] = 200;
  assert.equal(await main(["--tries", "1"], { ...fake(site), log: () => {} }), 1);
});

test("options", () => {
  assert.deepEqual(parseArgs([]), { env: "prod", tries: 3, wait: 5 });
  assert.equal(parseArgs(["--env", "staging", "--wait", "0"]).wait, 0);
  assert.throws(() => parseArgs(["--tries", "0"]), /--tries/);
  assert.throws(() => parseArgs(["--wait", "x"]), /--wait/);
  assert.throws(() => parseArgs(["--summary"]), /needs a value/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
});
