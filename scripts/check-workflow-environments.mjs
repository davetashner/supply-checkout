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
//   2. A workflow that names it, or calls one that does (`jobs.<id>.uses: ./.github/workflows/…`,
//      followed through every caller), may only be started by ALLOWED_TRIGGERS: never by
//      `pull_request`, `pull_request_target` or any other event someone without write access
//      can cause. Its `on:` may be a name, a list or a map; anything else fails.
//   3. No job sets its `environment` (or `environment.name`) from an expression (`${{ … }}`),
//      since then nothing here can tell which environment it names.
//   4. Nothing calls into this repository by a remote reference (`<owner>/<repo>/…@<ref>`, any
//      letter case), which rule 2 couldn't follow and which could run another branch's code:
//      a workflow in this repository is called as `./.github/workflows/<file>`.
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
const LOCAL_CALL = /^\.\/\.github\/workflows\/([^@\s]+)(@.*)?$/;
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

/** Every `uses:` in a parsed workflow's jobs and their steps. */
export function uses(workflow) {
  const found = [];
  for (const job of Object.values(isMap(workflow.jobs) ? workflow.jobs : {})) {
    if (!isMap(job)) continue;
    if (job.uses !== undefined) found.push(String(job.uses));
    for (const step of Array.isArray(job.steps) ? job.steps : []) if (isMap(step) && step.uses !== undefined) found.push(String(step.uses));
  }
  return found;
}

/** The local workflows a parsed workflow's jobs call, by file name. */
export function calls(workflow) {
  return uses(workflow).map((u) => LOCAL_CALL.exec(u.trim())?.[1]).filter(Boolean);
}

/** The `uses:` that reach into this repository by a remote reference. */
export function remoteCalls(workflow, repo = DEFAULT_REPO) {
  const prefix = `${repo.toLowerCase()}/`;
  return uses(workflow).filter((u) => u.trim().toLowerCase().startsWith(prefix));
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
    for (const p of environmentProblems(value)) problems.push(`${file}: ${p}`);
    for (const u of remoteCalls(value, repo)) problems.push(`${file}: calls ${u} by a remote reference; call this repository's workflows as ./.github/workflows/<file>`);
  }
  // The workflows that name the environment, and every workflow that calls one of them.
  const reach = new Map([...names].map((f) => [f, `names ${ENVIRONMENT}`]));
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
