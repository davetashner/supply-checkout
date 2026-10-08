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
//
//   node scripts/journeys/workflow.mjs wait-for-prod --repo owner/name --run <this run's id>
//        (--manual | --deploy) [--wait-seconds N]
//     The suite signs the long-lived test accounts out everywhere when it ends, so two runs at
//     once would break each other. --manual (a run by hand): refuses while any deploy run is
//     queued, waiting or in progress. --deploy (called from a deploy): waits up to N seconds
//     (default 1800) for any run of the journeys workflow by hand to finish, then refuses. Uses
//     `gh api` (GH_TOKEN, actions: read).
import { execFileSync } from "node:child_process";
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

/** The runs of `workflow` (a file name) that haven't completed, other than `self`, as "<id> (<status>)". */
export function activeRuns(api, repo, workflow, self) {
  const runs = api(`repos/${repo}/actions/workflows/${workflow}/runs?per_page=100`)?.workflow_runs ?? [];
  return runs.filter((r) => r.status !== "completed" && String(r.id) !== String(self)).map((r) => `${r.id} (${r.status})`);
}

export function parseWaitArgs(argv) {
  const out = { wait: 1800 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--manual" || flag === "--deploy") { if (out.mode) throw new Error("Pick one of --manual and --deploy"); out.mode = flag.slice(2); continue; }
    if (flag === "--repo" && value) out.repo = value;
    else if (flag === "--run" && value) out.run = value;
    else if (flag === "--wait-seconds" && /^\d+$/.test(value ?? "")) out.wait = Number(value);
    else throw new Error(`Unknown or incomplete argument ${flag}`);
    i++;
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(out.repo ?? "")) throw new Error("--repo must be owner/name");
  if (!/^\d+$/.test(out.run ?? "")) throw new Error("--run must be a run ID");
  if (!out.mode) throw new Error("Pick one of --manual and --deploy");
  return out;
}

/** 0 when prod is free for this run; 1 (with ::error:: lines logged) when it isn't. */
export async function waitForProd(argv, { api, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const { repo, run, mode, wait } = parseWaitArgs(argv);
  if (mode === "manual") {
    const busy = activeRuns(api, repo, "deploy.yml", run);
    if (!busy.length) return 0;
    log(`::error::A deploy is running or waiting (runs ${busy.join(", ")}): run the journey tests by hand after it, since the deploy runs them too`);
    return 1;
  }
  const until = now() + wait * 1000;
  for (;;) {
    const busy = activeRuns(api, repo, "journeys.yml", run);
    if (!busy.length) return 0;
    if (now() >= until) {
      log(`::error::A run of the journey tests by hand is still going after ${wait} seconds (runs ${busy.join(", ")}): cancel it, then re-run this job`);
      return 1;
    }
    log(`Waiting for a run of the journey tests by hand to finish: ${busy.join(", ")}`);
    await sleep(30_000);
  }
}

/** `gh api`, parsed. */
export const ghApi = (apiPath) => JSON.parse(execFileSync("gh", ["api", apiPath], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));

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
  if (command === "wait-for-prod") return waitForProd(argv.slice(1), { api: ghApi, log });
  throw new Error("Usage: workflow.mjs check-secrets | outputs <verdict.json> | wait-for-prod …");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(`journeys workflow: ${e.message}`);
    process.exitCode = 2;
  }
}
