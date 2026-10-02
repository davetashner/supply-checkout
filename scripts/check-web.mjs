#!/usr/bin/env node
// Checks the live web app and demo after a publish (supply-checkout-pbp.28): the deploy workflow
// runs it after `publish-web.mjs publish` and `check-router`, and rolls the channels back if it
// fails.
//
//   node scripts/check-web.mjs [--env prod] --app-index dist/web/index.html --demo-index dist/demo/index.html
//                              [--tries 12] [--wait 10]
//
// Over HTTPS, as a browser sees them:
//   - https://app.<domain>/ answers 200 with exactly the index.html just published (so the new
//     release is the live one), a Content-Security-Policy and Strict-Transport-Security;
//   - https://app.<domain>/config.json answers 200 with every key publish-web writes, each a
//     non-empty string;
//   - https://<domain>/demo/ answers 200 with exactly the demo's index.html.
// The edges pick up a new live version within seconds, so it tries again (--tries times, --wait
// seconds apart) until every check passes, and exits 1 with the last failures if they don't.
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { configParameterNames, envDomain } from "./publish-web.mjs";

/** The URLs, and what each must be. */
export function webChecks(envName, appIndex, demoIndex) {
  const domain = envDomain(envName);
  return [
    { name: "app", url: `https://app.${domain}/`, body: appIndex, headers: ["content-security-policy", "strict-transport-security"] },
    { name: "config", url: `https://app.${domain}/config.json`, configKeys: Object.keys(configParameterNames(envName)) },
    { name: "demo", url: `https://${domain}/demo/`, body: demoIndex },
  ];
}

/** The problems with one check's response ([] when it passes). */
export async function problemsWith(check, response) {
  const problems = [];
  if (response.status !== 200) return [`${check.url} answered ${response.status}, not 200`];
  for (const header of check.headers ?? []) {
    if (!response.headers.get(header)) problems.push(`${check.url} has no ${header} header`);
  }
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
        problems.push(...(await problemsWith(check, await fetch(check.url, { redirect: "manual", cache: "no-store" }))));
      } catch (e) {
        problems.push(`${check.url} failed: ${e.message}`);
      }
    }
    if (!problems.length) {
      log(`The web app and demo are live (${checks.map((c) => c.url).join(", ")}).`);
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
  const checks = webChecks(opts.env, readFileSync(opts.appIndex, "utf8"), readFileSync(opts.demoIndex, "utf8"));
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
