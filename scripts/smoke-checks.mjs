#!/usr/bin/env node
// Read-only checks of prod after a deploy (supply-checkout-pbp.30): the deploy workflow's apply
// job runs them after publishing the web app, check-router and check-web (which already prove
// app. answers 200 with the new index.html, CSP and HSTS, its config.json has every key, and the
// demo is live). These cover what the web checks don't, making no AWS calls, over HTTPS as
// anyone on the internet would:
//
//   - https://api.<domain>/me and /ops/teams answer 401 without a token (the API is up and its
//     authorizers refuse an anonymous caller; a 5xx or a 200 here is a failure);
//   - realtime.<domain> and auth.<domain> resolve in DNS and answer HTTPS below 500 (live
//     updates' and sign-in's custom domains are in place and their services answer).
//
//   node scripts/smoke-checks.mjs [--env prod] [--summary <file>] [--tries 3] [--wait 5]
//
// It tries each check again (--tries times, --wait seconds apart) to ride out a cold start, then
// prints, and appends to --summary (the job summary), a table of every check with what was
// expected and what came back, and exits 1 if any failed. It changes nothing.
//
// The core journey canary (supply-checkout-pkt, after the pilot) is to run after these: see
// "Post-deploy checks" in docs/releases.md for where it hooks in.
import { appendFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { envDomain } from "./publish-web.mjs";

/** How long one request may take. */
export const FETCH_TIMEOUT_MS = 15_000;

/** The hosts, as infra/lib/domain.ts hostNames builds them (smoke-checks.test.mjs checks). */
export function hosts(envName) {
  const apex = envDomain(envName);
  return { api: `api.${apex}`, realtime: `realtime.${apex}`, auth: `auth.${apex}` };
}

/** Every check: a name, what it expects, and how to run it. */
export function smokeChecks(envName) {
  const h = hosts(envName);
  const unauthorized = (url) => ({
    name: `${url} without a token`,
    expect: "401",
    url,
    ok: (status) => status === 401,
  });
  const answers = (host, url) => ({
    name: `${host} resolves and answers`,
    expect: "resolves; HTTPS status below 500",
    host,
    url,
    ok: (status) => status < 500,
  });
  return [
    unauthorized(`https://${h.api}/me`),
    unauthorized(`https://${h.api}/ops/teams`),
    answers(h.realtime, `https://${h.realtime}/event`),
    answers(h.auth, `https://${h.auth}/`),
  ];
}

/** One check, once: "" when it passes, else what came back. */
export async function runCheck(check, { fetch, lookup }) {
  if (check.host) {
    try {
      await lookup(check.host);
    } catch (e) {
      return `doesn't resolve (${e.code ?? e.message})`;
    }
  }
  let response;
  try {
    response = await fetch(check.url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    // fetch's own message is just "fetch failed"; the cause says why (ENOTFOUND, a timeout, ...)
    return `request failed (${e.cause?.code ?? e.cause?.message ?? e.message})`;
  }
  return check.ok(response.status) ? "" : `answered ${response.status}`;
}

/** Runs every check, each up to `tries` times; returns [{ name, expect, result, passed }]. */
export async function runSmoke(checks, { fetch = globalThis.fetch, lookup = dnsLookup, wait = sleep, tries = 3, waitMs = 5_000, log = console.log } = {}) {
  const results = [];
  for (const check of checks) {
    let problem = "";
    for (let attempt = 1; attempt <= tries; attempt++) {
      problem = await runCheck(check, { fetch, lookup });
      if (!problem) break;
      log(`Try ${attempt} of ${tries}: ${check.name}: ${problem}`);
      if (attempt < tries) await wait(waitMs);
    }
    results.push({ name: check.name, expect: check.expect, result: problem || "ok", passed: !problem });
  }
  return results;
}

/** The Markdown report for the job summary. */
export function report(results) {
  const failed = results.filter((r) => !r.passed);
  const rows = results.map((r) => `| ${r.passed ? "pass" : "**FAIL**"} | ${r.name} | ${r.expect} | ${r.result} |`).join("\n");
  const verdict = failed.length
    ? `**${failed.length} of ${results.length} failed.** The stacks aren't rolled back automatically: see "When a post-deploy check fails" in docs/releases.md.`
    : `All ${results.length} passed.`;
  return `## Post-deploy checks\n\n${verdict}\n\n| Result | Check | Expected | Got |\n| --- | --- | --- | --- |\n${rows}\n`;
}

export function parseArgs(argv) {
  const opts = { env: "prod", tries: 3, wait: 5 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--env") opts.env = value();
    else if (arg === "--summary") opts.summary = value();
    else if (arg === "--tries") opts.tries = Number(value());
    else if (arg === "--wait") opts.wait = Number(value());
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(opts.tries) || opts.tries < 1) throw new Error("--tries must be a whole number of at least 1");
  if (!Number.isFinite(opts.wait) || opts.wait < 0) throw new Error("--wait must be a number of seconds");
  return opts;
}

/** Runs the checks, prints and appends the report; returns the exit code. */
export async function main(argv, deps = {}) {
  const opts = parseArgs(argv);
  const { append = appendFileSync, log = console.log, ...rest } = deps;
  const results = await runSmoke(smokeChecks(opts.env), { tries: opts.tries, waitMs: opts.wait * 1000, log, ...rest });
  const text = report(results);
  log(text);
  if (opts.summary) append(opts.summary, text);
  return results.every((r) => r.passed) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(`smoke-checks: ${e.message}`);
    process.exit(2);
  }
}
