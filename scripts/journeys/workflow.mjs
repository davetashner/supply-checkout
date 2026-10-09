#!/usr/bin/env node
// Small steps of the journeys workflow (.github/workflows/journeys.yml, supply-checkout-o60.6) and
// of the deploy's journeys job, which dispatches it (supply-checkout-o60.15):
//
//   node scripts/journeys/workflow.mjs check-secrets
//     Before signing in to AWS: every secret the suite needs is set and well formed
//     (lib/config.mjs readConfig), so a missing secret fails the job before the suite step and
//     isn't taken for a failing release. Prints ::error:: lines that name variables, never values.
//
//   node scripts/journeys/workflow.mjs outputs <verdict.json>
//     Writes `failed` and `critical` to $GITHUB_OUTPUT from a verdict file: prod-summary.mjs's
//     --json file in the suite job, or, in the deploy, the dispatched run's journeys-verdict
//     artifact. Only entries shaped like "J4.2 (desktop-chrome)" (the deploy's verdict job puts
//     them in the release notes, which are public; scripts/release-verdict.mjs checks again). A
//     missing file writes nothing; a file over 1 MB, or one that isn't JSON, is refused.
//
//   node scripts/journeys/workflow.mjs wait-for-prod --repo owner/name --run <this run's id>
//        (--manual | --deploy --deploy-run <deploy run's id>-<attempt>) [--wait-seconds N]
//     The suite signs the long-lived test accounts out everywhere when it ends, so two runs at
//     once would break each other. --manual (a run by hand): refuses while any deploy run is
//     queued, waiting or in progress. --deploy (dispatched by a deploy): first checks that the
//     deploy run it names is a run of deploy.yml on main that hasn't finished (so a run by hand
//     can't pass for a deploy's), then waits up to N seconds (default 1800) for any other run of
//     the journeys workflow to finish, then refuses. Uses `gh api` (GH_TOKEN, actions: read).
//
//   node scripts/journeys/workflow.mjs follow --repo owner/name --tag vX.Y.Z
//        --deploy-run <this deploy run's id>-<attempt> [--find-seconds N] [--wait-seconds N]
//   node scripts/journeys/workflow.mjs cancel --repo owner/name --tag vX.Y.Z --deploy-run …
//     In the deploy's journeys job, after `gh workflow run journeys.yml -f tag=… -f deploy-run=…`.
//     The dispatched run's run-name is runName(tag, deployRun), unique to this deploy run and
//     attempt, so `follow` finds it by that title among journeys.yml's workflow_dispatch runs on
//     main (never "the latest run": two can start close together), waiting up to --find-seconds
//     (default 300) for it to show up; more than one with that title is refused. Then it waits up
//     to --wait-seconds (default 5700) for the run to finish, cancelling it if it doesn't, and
//     reads the suite step's outcome from the run's jobs (SUITE_JOB, SUITE_STEP). It writes
//     run-id, run-url, suite (success, failure, cancelled, skipped, or empty when the suite never
//     ran) and conclusion to $GITHUB_OUTPUT, and exits 1 unless the run succeeded. `cancel`
//     cancels any unfinished run with that title (the job's `if: cancelled()` step). Everything
//     read from the other run is checked against a fixed shape before it's used or written out.
//     Uses `gh api` (GH_TOKEN, actions: write for the cancel).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./lib/config.mjs";

const ENTRY = /^J\d{1,3}\.\d{1,3} \((desktop-chrome|iphone-safari)\)$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const TAG = /^v\d+\.\d+\.\d+$/;
/** A deploy run and attempt, "<run id>-<attempt>": the correlation the deploy passes as deploy-run. */
export const DEPLOY_RUN = /^\d{1,20}-\d{1,4}$/;
/** journeys.yml's suite job and the step whose outcome is the suite's (journeys.yml keeps these names). */
export const SUITE_JOB = "Journey tests against prod";
export const SUITE_STEP = "Run the journey tests";
/** The artifact journeys.yml's results job uploads for a deploy: only the failed steps' lists. */
export const VERDICT_ARTIFACT = "journeys-verdict";
const OUTCOMES = ["success", "failure", "cancelled", "skipped"];
/** A finished run's conclusions, as the API gives them. */
const CONCLUSIONS = [...OUTCOMES, "neutral", "timed_out", "action_required", "stale", "startup_failure"];
const MAX_VERDICT_BYTES = 1024 * 1024;

/** The dispatched run's title (journeys.yml's run-name for a deploy), the deploy's way to find it. */
export const runName = (tag, deployRun) => `Journeys after deploying ${tag} (deploy run ${deployRun})`;

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
    else if (flag === "--deploy-run" && value) out.deployRun = value;
    else if (flag === "--wait-seconds" && /^\d+$/.test(value ?? "")) out.wait = Number(value);
    else throw new Error(`Unknown or incomplete argument ${flag}`);
    i++;
  }
  if (!REPO.test(out.repo ?? "")) throw new Error("--repo must be owner/name");
  if (!/^\d+$/.test(out.run ?? "")) throw new Error("--run must be a run ID");
  if (!out.mode) throw new Error("Pick one of --manual and --deploy");
  if (out.mode === "deploy" && !DEPLOY_RUN.test(out.deployRun ?? "")) throw new Error("--deploy needs --deploy-run <run id>-<attempt>");
  if (out.mode === "manual" && out.deployRun !== undefined) throw new Error("--deploy-run goes with --deploy only");
  return out;
}

/** Whether a run (from the API) is deploy.yml's, on main, and not finished. */
export function isLiveDeploy(run) {
  return Boolean(run) && typeof run.path === "string" && run.path.split("@")[0] === ".github/workflows/deploy.yml"
    && run.head_branch === "main" && run.status !== "completed";
}

/** 0 when prod is free for this run; 1 (with ::error:: lines logged) when it isn't. */
export async function waitForProd(argv, { api, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const { repo, run, mode, wait, deployRun } = parseWaitArgs(argv);
  if (mode === "manual") {
    const busy = activeRuns(api, repo, "deploy.yml", run);
    if (!busy.length) return 0;
    log(`::error::A deploy is running or waiting (runs ${busy.join(", ")}): run the journey tests by hand after it, since the deploy runs them too`);
    return 1;
  }
  const deployId = deployRun.split("-")[0];
  if (!isLiveDeploy(api(`repos/${repo}/actions/runs/${deployId}`))) {
    log(`::error::This run says deploy run ${deployId} started it, but that isn't a deploy of main that's still going: run the journey tests by hand with deploy-run (and tag) left empty`);
    return 1;
  }
  const until = now() + wait * 1000;
  for (;;) {
    const busy = activeRuns(api, repo, "journeys.yml", run);
    if (!busy.length) return 0;
    if (now() >= until) {
      log(`::error::Another run of the journey tests is still going after ${wait} seconds (runs ${busy.join(", ")}): cancel it, then re-run the deploy's journeys job`);
      return 1;
    }
    log(`Waiting for another run of the journey tests to finish: ${busy.join(", ")}`);
    await sleep(30_000);
  }
}

export function parseFollowArgs(argv) {
  const out = { find: 300, wait: 5700 };
  const flags = { "--repo": "repo", "--tag": "tag", "--deploy-run": "deployRun" };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flags[flag] && value !== undefined && !(flags[flag] in out)) out[flags[flag]] = value;
    else if (flag === "--find-seconds" && /^\d+$/.test(value ?? "")) out.find = Number(value);
    else if (flag === "--wait-seconds" && /^\d+$/.test(value ?? "")) out.wait = Number(value);
    else throw new Error(`Unknown or incomplete argument ${flag}`);
  }
  if (!REPO.test(out.repo ?? "")) throw new Error("--repo must be owner/name");
  if (!TAG.test(out.tag ?? "")) throw new Error("--tag must look like v1.2.3");
  if (!DEPLOY_RUN.test(out.deployRun ?? "")) throw new Error("--deploy-run must be <run id>-<attempt>");
  return out;
}

/** The workflow_dispatch runs of journeys.yml on main titled `title`, as { id, status }, IDs checked. */
export function runsTitled(api, repo, title) {
  const runs = api(`repos/${repo}/actions/workflows/journeys.yml/runs?event=workflow_dispatch&branch=main&per_page=100`)?.workflow_runs;
  return (Array.isArray(runs) ? runs : [])
    .filter((r) => r && r.display_title === title && r.head_branch === "main" && r.event === "workflow_dispatch" && Number.isSafeInteger(r.id) && r.id > 0)
    .map((r) => ({ id: r.id, status: String(r.status) }));
}

/** The suite step's outcome from a run's jobs, or "" when the suite job or step didn't run. */
export function suiteOutcome(jobs) {
  const list = Array.isArray(jobs?.jobs) ? jobs.jobs : [];
  const job = list.find((j) => j && j.name === SUITE_JOB);
  const step = (Array.isArray(job?.steps) ? job.steps : []).find((s) => s && s.name === SUITE_STEP);
  return OUTCOMES.includes(step?.conclusion) ? step.conclusion : "";
}

const sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

/** `api` for a polling loop: up to `tries` failures in a row are logged and answered with undefined. */
export function patient(api, log, tries = 5) {
  let failures = 0;
  return (...args) => {
    try {
      const answer = api(...args);
      failures = 0;
      return answer;
    } catch (e) {
      if (++failures >= tries) throw e;
      log(`::warning::GitHub's API failed (${failures} in a row; trying again): ${String(e.message).split("\n")[0]}`);
      return undefined;
    }
  };
}

/** Finds the run this deploy dispatched, waits for it, and writes its result. 0 when it succeeded. */
export async function follow(argv, { api, output, log = console.log, sleep = sleeper, now = Date.now } = {}) {
  const { repo, tag, deployRun, find, wait } = parseFollowArgs(argv);
  const title = runName(tag, deployRun);
  const write = (name, value) => output(`${name}=${value}\n`);
  const poll = patient(api, log);
  let found;
  for (const until = now() + find * 1000; ;) {
    found = runsTitled(poll, repo, title);
    if (found.length || now() >= until) break;
    await sleep(10_000);
  }
  if (found.length !== 1) {
    log(found.length
      ? `::error::${found.length} runs of the journey tests are titled "${title}" (runs ${found.map((r) => r.id).join(", ")}): only this deploy should start one; read them before trusting either`
      : `::error::The journey tests' run for this deploy ("${title}") didn't show up within ${find} seconds of being started`);
    write("suite", "");
    return 1;
  }
  const { id } = found[0];
  const url = `https://github.com/${repo}/actions/runs/${id}`;
  write("run-id", id);
  write("run-url", url);
  log(`The journey tests are run ${id}: ${url}`);
  let run;
  for (const until = now() + wait * 1000; ;) {
    run = poll(`repos/${repo}/actions/runs/${id}`);
    if (run?.status === "completed") break;
    if (now() >= until) {
      log(`::error::The journey tests' run ${id} didn't finish within ${wait} seconds: cancelling it`);
      api(`repos/${repo}/actions/runs/${id}/cancel`, { method: "POST" });
      write("suite", "");
      return 1;
    }
    await sleep(30_000);
  }
  const conclusion = CONCLUSIONS.includes(run.conclusion) ? run.conclusion : "unknown";
  const suite = suiteOutcome(api(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`));
  write("suite", suite);
  write("conclusion", conclusion);
  log(`The journey tests' run ${id} finished: ${conclusion} (the suite step: ${suite || "didn't run"})`);
  if (conclusion === "success") return 0;
  log(`::error::The journey tests' run ${id} ended ${conclusion}; its summary has the results: ${url}`);
  return 1;
}

/** Cancels any unfinished run this deploy dispatched (the deploy's journeys job was cancelled). */
export function cancelRuns(argv, { api, log = console.log } = {}) {
  const { repo, tag, deployRun } = parseFollowArgs(argv);
  const live = runsTitled(api, repo, runName(tag, deployRun)).filter((r) => r.status !== "completed");
  for (const r of live) {
    api(`repos/${repo}/actions/runs/${r.id}/cancel`, { method: "POST" });
    log(`Cancelled the journey tests' run ${r.id}`);
  }
  if (!live.length) log("No unfinished run of the journey tests to cancel");
  return 0;
}

/** `gh api`, parsed (null for an empty answer, as a cancel's 202 is). */
export const ghApi = (apiPath, { method = "GET" } = {}) => {
  const text = execFileSync("gh", ["api", "-X", method, apiPath], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return text.trim() ? JSON.parse(text) : null;
};

export function main(argv, env = process.env, log = console.log, api = ghApi) {
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
    if (statSync(file).size > MAX_VERDICT_BYTES) throw new Error(`${path.basename(file)} is over ${MAX_VERDICT_BYTES} bytes`);
    appendFileSync(env.GITHUB_OUTPUT, outputLines(JSON.parse(readFileSync(file, "utf8"))));
    return 0;
  }
  if (command === "wait-for-prod") return waitForProd(argv.slice(1), { api, log });
  if (command === "follow" || command === "cancel") {
    if (!env.GITHUB_OUTPUT && command === "follow") throw new Error("GITHUB_OUTPUT isn't set");
    if (command === "cancel") return cancelRuns(argv.slice(1), { api, log });
    return follow(argv.slice(1), { api, log, output: (line) => appendFileSync(env.GITHUB_OUTPUT, line) });
  }
  throw new Error("Usage: workflow.mjs check-secrets | outputs <verdict.json> | wait-for-prod … | follow … | cancel …");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(`journeys workflow: ${e.message}`);
    process.exitCode = 2;
  }
}
