#!/usr/bin/env node
// Two small steps of the journeys workflow (.github/workflows/journeys.yml, supply-checkout-o60.6):
//
//   node scripts/journeys/workflow.mjs check-secrets
//     Before signing in to AWS: every secret the suite needs is set and well formed
//     (lib/config.mjs readConfig), so a missing secret fails the job before the suite step and
//     isn't taken for a failing release. Prints ::error:: lines that name variables, never values.
//
//   node scripts/journeys/workflow.mjs outputs <verdict.json>
//     Writes `failed` and `critical` to $GITHUB_OUTPUT from prod-summary.mjs's --json file, for
//     the deploy's verdict job, which puts them in the release notes (public): only entries shaped
//     like "J4.2 (desktop-chrome)" (scripts/release-verdict.mjs checks again). A missing file
//     writes nothing.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./lib/config.mjs";

const ENTRY = /^J\d{1,3}\.\d{1,3} \((desktop-chrome|iphone-safari)\)$/;

/** The ::error:: lines for the configuration's problems, or [] when it's complete. */
export function secretProblems(env) {
  try {
    readConfig(env);
    return [];
  } catch (e) {
    return e.message.split("\n").map((line) => `::error::${line}`);
  }
}

/** The GITHUB_OUTPUT lines from prod-summary's verdict: only well-formed entries. */
export function outputLines(verdict) {
  const ok = (list) => (Array.isArray(list) ? list : []).filter((s) => typeof s === "string" && ENTRY.test(s)).join(", ");
  return `failed=${ok(verdict?.failed)}\ncritical=${ok(verdict?.critical)}\n`;
}

export function main(argv, env = process.env, log = console.log) {
  const [command, file] = argv;
  if (command === "check-secrets" && argv.length === 1) {
    const problems = secretProblems(env);
    for (const p of problems) log(p);
    if (!problems.length) log("Every journeys secret is set");
    return problems.length ? 1 : 0;
  }
  if (command === "outputs" && argv.length === 2) {
    if (!existsSync(file)) return 0;
    if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT isn't set");
    appendFileSync(env.GITHUB_OUTPUT, outputLines(JSON.parse(readFileSync(file, "utf8"))));
    return 0;
  }
  throw new Error("Usage: workflow.mjs check-secrets | outputs <verdict.json>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`journeys workflow: ${e.message}`);
    process.exitCode = 2;
  }
}
