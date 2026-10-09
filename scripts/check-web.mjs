#!/usr/bin/env node
// Checks the live web app, demo and operator page after a publish (supply-checkout-pbp.28,
// supply-checkout-8jc.47): the deploy workflow runs it after `publish-web.mjs publish` and
// `check-router`, and rolls the channels back if it fails.
//
//   node scripts/check-web.mjs [--env prod] --app-index dist/web/index.html --demo-index dist/demo/index.html
//                              [--ops-index dist/ops/index.html] [--tries 12] [--wait 10]
//
// Over HTTPS, as a browser sees them:
//   - https://app.<domain>/ answers 200 with exactly the index.html just published (so the new
//     release is the live one), a Content-Security-Policy and Strict-Transport-Security;
//   - https://app.<domain>/config.json answers 200 with every key publish-web writes, each a
//     non-empty string;
//   - https://<domain>/demo/ answers 200 with exactly the demo's index.html;
//   - with --ops-index, the operator page: https://ops.<domain>/ answers 200 with exactly that
//     index.html, its strict Content-Security-Policy (default-src 'none'), HSTS and
//     Cache-Control: no-store; its ops-config.json has every key publish-web writes, and is
//     no-store too; and a path it doesn't serve (the app's /config.json) is a 404, no-store.
// The edges pick up a new live version within seconds, so it tries again (--tries times, --wait
// seconds apart) until every check passes, and exits 1 with the last failures if they don't.
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { configParameterNames, envDomain, opsConfigParameterNames } from "./publish-web.mjs";

/** How long one request may take. */
export const FETCH_TIMEOUT_MS = 15_000;

/** What every operator page response must carry: never cached, by anything. */
const OPS_NO_STORE = { "cache-control": "no-store" };

/** The URLs, and what each must be. The operator page's only when its index.html is given. */
export function webChecks(envName, appIndex, demoIndex, opsIndex) {
  const domain = envDomain(envName);
  const checks = [
    { name: "app", url: `https://app.${domain}/`, body: appIndex, headers: ["content-security-policy", "strict-transport-security"] },
    { name: "config", url: `https://app.${domain}/config.json`, configKeys: Object.keys(configParameterNames(envName)) },
    { name: "demo", url: `https://${domain}/demo/`, body: demoIndex },
  ];
  if (opsIndex === undefined) return checks;
  const ops = `https://ops.${domain}`;
  return [
    ...checks,
    {
      name: "ops",
      url: `${ops}/`,
      body: opsIndex,
      headers: ["content-security-policy", "strict-transport-security"],
      headerIncludes: { ...OPS_NO_STORE, "content-security-policy": "default-src 'none'" },
    },
    { name: "ops-config", url: `${ops}/ops-config.json`, configKeys: Object.keys(opsConfigParameterNames(envName)), headerIncludes: OPS_NO_STORE },
    { name: "ops-404", url: `${ops}/config.json`, status: 404, headerIncludes: OPS_NO_STORE },
  ];
}

/** The problems with one check's response ([] when it passes). */
export async function problemsWith(check, response) {
  const problems = [];
  const status = check.status ?? 200;
  if (response.status !== status) return [`${check.url} answered ${response.status}, not ${status}`];
  for (const header of check.headers ?? []) {
    if (!response.headers.get(header)) problems.push(`${check.url} has no ${header} header`);
  }
  for (const [header, part] of Object.entries(check.headerIncludes ?? {})) {
    if (!(response.headers.get(header) ?? "").includes(part)) problems.push(`${check.url} has no ${part} in its ${header} header`);
  }
  if (status !== 200) return problems;
  const text = await response.text();
  if (check.body !== undefined && text !== check.body) problems.push(`${check.url} isn't the index.html just published (yet)`);
  if (check.configKeys) {
    let config;
    try {
      config = JSON.parse(text);
    } catch {
      return [...problems, `${check.url} isn't JSON`];
    }
    const missing = check.configKeys.filter((k) => typeof config?.[k] !== "string" || config[k] === "");
    if (missing.length) problems.push(`${check.url} is missing ${missing.join(", ")}`);
    const extra = Object.keys(config ?? {}).filter((k) => !check.configKeys.includes(k));
    if (extra.length) problems.push(`${check.url} has keys publish-web doesn't write: ${extra.join(", ")}`);
  }
  return problems;
}

/** Runs every check until all pass or `tries` runs out; returns the last problems. */
export async function checkWeb(checks, { fetch = globalThis.fetch, wait = sleep, tries = 12, waitMs = 10_000, log = console.log } = {}) {
  let problems = [];
  for (let attempt = 1; attempt <= tries; attempt++) {
    problems = [];
    for (const check of checks) {
      try {
        // A hung connection counts as a failed try, not a stuck deploy
        const init = { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
        problems.push(...(await problemsWith(check, await fetch(check.url, init))));
      } catch (e) {
        problems.push(`${check.url} failed: ${e.message}`);
      }
    }
    if (!problems.length) {
      log(`The web is live (${checks.map((c) => c.url).join(", ")}).`);
      return [];
    }
    log(`Try ${attempt} of ${tries}: ${problems.join("; ")}`);
    if (attempt < tries) await wait(waitMs);
  }
  return problems;
}

export function parseArgs(argv) {
  const opts = { env: "prod", tries: 12, wait: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--env") opts.env = value();
    else if (arg === "--app-index") opts.appIndex = value();
    else if (arg === "--demo-index") opts.demoIndex = value();
    else if (arg === "--ops-index") opts.opsIndex = value();
    else if (arg === "--tries") opts.tries = Number(value());
    else if (arg === "--wait") opts.wait = Number(value());
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!opts.appIndex || !opts.demoIndex) throw new Error("--app-index and --demo-index are required (the index.html files just published)");
  if (!Number.isInteger(opts.tries) || opts.tries < 1) throw new Error("--tries must be a whole number of at least 1");
  if (!Number.isFinite(opts.wait) || opts.wait < 0) throw new Error("--wait must be a number of seconds");
  return opts;
}

export async function main(argv, deps = {}) {
  const opts = parseArgs(argv);
  const read = (file) => readFileSync(file, "utf8");
  const checks = webChecks(opts.env, read(opts.appIndex), read(opts.demoIndex), opts.opsIndex === undefined ? undefined : read(opts.opsIndex));
  return checkWeb(checks, { tries: opts.tries, waitMs: opts.wait * 1000, ...deps });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const problems = await main(process.argv.slice(2));
    if (problems.length) {
      console.error(`check-web: the live site isn't right:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`check-web: ${e.message}`);
    process.exit(2);
  }
}
