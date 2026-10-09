#!/usr/bin/env node
// Keeps the `production-journeys` GitHub environment out of every workflow but the journeys
// workflow, and out of anything a pull request can start (supply-checkout-o60.4; the #564 security
// review). The journeys role trusts any job in that environment, and its secrets reach any job
// that names it. The environment allows only `main`, but a `pull_request_target`, `issue_comment`
// or `workflow_run` run is on `main` too, while a pull request's author chooses what it runs on.
// So, for the workflows in .github/workflows, each parsed as YAML (the `yaml` package; a file that
// doesn't parse fails the check):
//
//   1. Only .github/workflows/journeys.yml may name `production-journeys`, in any letter case
//      (GitHub's environment names ignore case): not in any key or value once YAML's escapes are
//      decoded, and not anywhere in the raw text either, comments included (an extra tripwire).
//   2. A workflow that names it, dispatches journeys.yml (any string in its jobs mentions
//      `journeys.yml`, as `gh workflow run journeys.yml` and the API's
//      `workflows/journeys.yml/dispatches` do), or calls one that does either
//      (`jobs.<id>.uses: ./.github/workflows/…`, followed through every caller), may only be
//      started by ALLOWED_TRIGGERS: never by `pull_request`, `pull_request_target` or any other
//      event someone without write access can cause. Its `on:` may be a name, a list or a map;
//      anything else fails. (A dispatched run is main's journeys.yml, whatever the dispatcher
//      runs, but it still tests prod on demand, so only a trusted event may start it. The file
//      name is a tripwire: a run step could dispatch it by its name or ID instead.)
//   3. No job sets its `environment` (or `environment.name`) from an expression (`${{ … }}`),
//      since then nothing here can tell which environment it names.
//   4. A job calls a reusable workflow only as `./.github/workflows/<file>.yml` (no other
//      repository, no `@ref`, no `..` or `//`). A called workflow runs in the caller's context, so
//      one from another repository, or this one at another ref, could name the environment with
//      this repository's OIDC subject and secrets, and rule 2 couldn't follow it. Steps don't call
//      into this repository by a remote reference (`<owner>/<repo>/…@<ref>`, any letter case).
//   5. No YAML merge key (`<<`) anywhere, which could hide keys.
//   6. journeys.yml has no `workflow_call` trigger, so no workflow can call it: it's dispatched
//      (supply-checkout-o60.15). A called workflow's environment job gets that environment's
//      secrets only when the caller passes `secrets: inherit` (actions/runner#4453), which would
//      also hand it every secret of the caller (the deploy's AWS_DEPLOY_ROLE_ARN and
//      DEPLOY_ASSEMBLY_KEY), and the call would run under the caller's permissions.
//
// journeys.yml doesn't have to exist (it comes with supply-checkout-o60.6).
//
//   node scripts/check-workflow-environments.mjs     (CI's "Lint and validate HTML" job)
//
// Exits 1 with the problems listed, 0 when there are none.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { DEFAULT_REPO } from "./check-environments.mjs";

export const ENVIRONMENT = "production-journeys";
export const JOURNEYS_WORKFLOW = "journeys.yml";
/** Events only someone with write access can cause (or another workflow, for workflow_call). */
export const ALLOWED_TRIGGERS = ["workflow_call", "workflow_dispatch", "push", "schedule"];

const NAMES = new RegExp(ENVIRONMENT.replace("-", "\\-"), "i");
/** A mention of the journeys workflow's file, as a dispatch of it has. */
const DISPATCHES = /\bjourneys\.ya?ml\b/i;
/** The only job-level `uses:` allowed: a workflow file in this repository, by its local path. */
export const LOCAL_CALL = /^\.\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)$/;
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The workflow parsed, or { error } when it isn't one YAML document with a map at the top. */
export function parseWorkflow(text) {
  const doc = parseDocument(text, { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length) return { error: doc.errors[0].message.split("\n")[0] };
  let value;
  try {
    value = doc.toJS({ maxAliasCount: 100 });
  } catch (e) {
    return { error: e.message };
  }
  if (!isMap(value)) return { error: "the top level isn't a map" };
  return { value };
}

/** Every string in a parsed value, keys included. */
export function strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (isMap(value)) for (const [k, v] of Object.entries(value)) { out.push(k); strings(v, out); }
  return out;
}

/** The triggers from a parsed workflow's `on:`, or null when it's missing or not a name, list or map. */
export function triggers(workflow) {
  const on = workflow.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.every((t) => typeof t === "string") ? on : null;
  if (isMap(on)) return Object.keys(on);
  return null;
}

/** Every job-level `uses:` (a called reusable workflow), as [job id, uses]. */
export function jobUses(workflow) {
  return Object.entries(isMap(workflow.jobs) ? workflow.jobs : {})
    .filter(([, job]) => isMap(job) && job.uses !== undefined)
    .map(([id, job]) => [id, String(job.uses)]);
}

/** Every `uses:` in a parsed workflow's jobs and their steps. */
export function uses(workflow) {
  const found = jobUses(workflow).map(([, u]) => u);
  for (const job of Object.values(isMap(workflow.jobs) ? workflow.jobs : {})) {
    if (!isMap(job)) continue;
    for (const step of Array.isArray(job.steps) ? job.steps : []) if (isMap(step) && step.uses !== undefined) found.push(String(step.uses));
  }
  return found;
}

/** The local workflows a parsed workflow's jobs call, by file name. */
export function calls(workflow) {
  return jobUses(workflow).map(([, u]) => LOCAL_CALL.exec(u)?.[1]).filter(Boolean);
}

/** Whether any map in a parsed value has a YAML merge key (`<<`). */
export function hasMergeKey(value) {
  if (Array.isArray(value)) return value.some(hasMergeKey);
  if (isMap(value)) return Object.entries(value).some(([k, v]) => k === "<<" || hasMergeKey(v));
  return false;
}

/** The `uses:` that reach into this repository by a remote reference. */
export function remoteCalls(workflow, repo = DEFAULT_REPO) {
  const prefix = `${repo.toLowerCase()}/`;
  return uses(workflow).filter((u) => u.trim().toLowerCase().startsWith(prefix));
}

/** Whether a parsed workflow's jobs mention journeys.yml (dispatch it), comments and job-level `uses:` (calls, rule 2's other half) aside. */
export function dispatchesJourneys(workflow) {
  const jobs = Object.values(isMap(workflow.jobs) ? workflow.jobs : {});
  return jobs.some((job) => strings(isMap(job) ? Object.fromEntries(Object.entries(job).filter(([k]) => k !== "uses")) : job).some((s) => DISPATCHES.test(s)));
}

/** Problems with the jobs' `environment`: from an expression, or not a name or a map with one. */
export function environmentProblems(workflow) {
  const problems = [];
  for (const [id, job] of Object.entries(isMap(workflow.jobs) ? workflow.jobs : {})) {
    if (!isMap(job) || job.environment === undefined) continue;
    const env = job.environment;
    const name = isMap(env) ? env.name : env;
    if (typeof name !== "string") problems.push(`job ${id}'s environment isn't a name or a map with a name`);
    else if (name.includes("${{")) problems.push(`job ${id} sets its environment from an expression; name the environment literally`);
  }
  return problems;
}

/** Every problem, from the workflows as { "<file name>": text }. */
export function workflowProblems(workflows, repo = DEFAULT_REPO) {
  const problems = [];
  const files = Object.keys(workflows).sort();
  const parsed = {};
  const names = new Set();
  for (const file of files) {
    const text = workflows[file];
    const { value, error } = parseWorkflow(text);
    if (error) problems.push(`${file}: can't be read as a workflow (${error})`);
    else parsed[file] = value;
    if (NAMES.test(text) || (value && strings(value).some((s) => NAMES.test(s)))) names.add(file);
    if (names.has(file) && file !== JOURNEYS_WORKFLOW) problems.push(`${file}: names ${ENVIRONMENT}; only .github/workflows/${JOURNEYS_WORKFLOW} may`);
    if (!value) continue;
    if (hasMergeKey(value)) problems.push(`${file}: uses a YAML merge key (<<); write the keys out`);
    for (const p of environmentProblems(value)) problems.push(`${file}: ${p}`);
    for (const [id, u] of jobUses(value)) {
      if (!LOCAL_CALL.test(u)) problems.push(`${file}: job ${id} calls ${u}; a job may only call a workflow in this repository as ./.github/workflows/<file>.yml (no other repository, no @ref, no ..)`);
    }
    for (const u of remoteCalls(value, repo)) problems.push(`${file}: calls ${u} by a remote reference; call this repository's workflows as ./.github/workflows/<file>`);
    if (file === JOURNEYS_WORKFLOW && (triggers(value) ?? []).includes("workflow_call")) {
      problems.push(`${file}: has a workflow_call trigger; it's only ever dispatched (gh workflow run), since a called workflow's environment secrets need secrets: inherit from the caller (actions/runner#4453)`);
    }
  }
  // The workflows that name the environment or dispatch journeys.yml, and every workflow that
  // calls one of them.
  const reach = new Map([...names].map((f) => [f, `names ${ENVIRONMENT}`]));
  for (const file of Object.keys(parsed)) {
    if (!reach.has(file) && dispatchesJourneys(parsed[file])) reach.set(file, `dispatches ${JOURNEYS_WORKFLOW}`);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const file of Object.keys(parsed)) {
      if (reach.has(file)) continue;
      const callee = calls(parsed[file]).find((c) => reach.has(c));
      if (callee) {
        reach.set(file, `calls ${callee}, which ${reach.get(callee)}`);
        grew = true;
      }
    }
  }
  for (const [file, why] of [...reach].sort(([a], [b]) => a.localeCompare(b))) {
    if (!parsed[file]) continue;
    const on = triggers(parsed[file]);
    if (!on) {
      problems.push(`${file}: ${why}, and its triggers (on:) aren't a name, a list or a map`);
      continue;
    }
    const pullRequest = on.filter((t) => t.startsWith("pull_request"));
    if (pullRequest.length) problems.push(`${file}: ${why}, so it must have no pull request trigger (has ${pullRequest.join(", ")})`);
    const other = on.filter((t) => !t.startsWith("pull_request") && !ALLOWED_TRIGGERS.includes(t));
    if (other.length) problems.push(`${file}: ${why}, so it may only be started by ${ALLOWED_TRIGGERS.join(", ")} (has ${other.join(", ")})`);
  }
  return problems;
}

/** The workflows in `dir` (*.yml and *.yaml) as { "<file name>": text }. */
export function readWorkflows(dir) {
  return Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(path.join(dir, f), "utf8")]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
  const workflows = readWorkflows(dir);
  const problems = workflowProblems(workflows);
  if (problems.length) {
    console.error(`The ${ENVIRONMENT} environment is named where it mustn't be:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  const named = JOURNEYS_WORKFLOW in workflows && NAMES.test(workflows[JOURNEYS_WORKFLOW]);
  console.log(`check-workflow-environments: ${Object.keys(workflows).length} workflows; ${named ? `only ${JOURNEYS_WORKFLOW} names ${ENVIRONMENT}, and nothing a pull request starts reaches it` : `none names ${ENVIRONMENT}`}`);
}
