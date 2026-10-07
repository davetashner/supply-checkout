#!/usr/bin/env node
// Keeps the `production-journeys` GitHub environment out of every workflow but the journeys
// workflow, and out of anything a pull request can start (supply-checkout-o60.4; the #564 security
// review). The journeys role trusts any job in that environment, and its secrets reach any job
// that names it. The environment allows only `main`, but a `pull_request_target`, `issue_comment`
// or `workflow_run` run is on `main` too, while a pull request's author chooses what it runs on.
// So, for the workflows in .github/workflows:
//
//   1. Only .github/workflows/journeys.yml may name `production-journeys` (anywhere in the file,
//      comments included, in any letter case: GitHub's environment names ignore case).
//   2. A workflow that names it, or calls one that does (`uses: ./.github/workflows/…`, followed
//      through every caller), may only be started by ALLOWED_TRIGGERS: never by `pull_request`,
//      `pull_request_target` or any other event someone without write access can cause.
//   3. No workflow sets a job's `environment` from an expression (`${{ … }}`), since then nothing
//      here can tell which environment it names.
//
// journeys.yml doesn't have to exist (it comes with supply-checkout-o60.6). Triggers are read from
// the workflow's top-level `on:` in the forms GitHub documents (a name, a [list], a block list or
// a block map); one this can't read fails the check, which is the safe side.
//
//   node scripts/check-workflow-environments.mjs     (CI's "Lint GitHub workflows" job)
//
// Exits 1 with the problems listed, 0 when there are none.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ENVIRONMENT = "production-journeys";
export const JOURNEYS_WORKFLOW = "journeys.yml";
/** Events only someone with write access can cause (or another workflow, for workflow_call). */
export const ALLOWED_TRIGGERS = ["workflow_call", "workflow_dispatch", "push", "schedule"];

const NAMES = new RegExp(ENVIRONMENT.replace("-", "\\-"), "i");

/** A line without its comment (a `#` at the start or after a space; good enough for keys). */
const uncomment = (line) => line.replace(/(^|\s)#.*$/, "");
const indentOf = (line) => /^ */.exec(line)[0].length;

/**
 * The workflow's triggers from its top-level `on:` (also `"on":` or `'on':`), or null when there's
 * no `on:` or it's in a form this doesn't read.
 */
export function triggers(text) {
  const lines = text.split(/\r?\n/).map(uncomment);
  const at = lines.findIndex((l) => /^(on|"on"|'on'):/.test(l));
  if (at < 0) return null;
  const inline = lines[at].replace(/^(on|"on"|'on'):/, "").trim();
  const name = /^[A-Za-z_]+$/;
  if (inline) {
    if (name.test(inline)) return [inline];
    const list = /^\[(.*)\]$/.exec(inline);
    if (!list) return null;
    const items = list[1].split(",").map((s) => s.trim().replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);
    return items.every((i) => name.test(i)) ? items : null;
  }
  const block = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    if (indentOf(line) === 0) break;
    block.push(line);
  }
  if (!block.length) return null;
  const depth = indentOf(block[0]);
  const found = [];
  for (const line of block) {
    if (indentOf(line) < depth) return null;
    if (indentOf(line) > depth) continue;
    const m = /^\s*(?:-\s*)?(["']?)([A-Za-z_]+)\1\s*(:.*)?$/.exec(line);
    if (!m || (line.trim().startsWith("-") && m[3])) return null;
    found.push(m[2]);
  }
  return found;
}

/** The local workflows a workflow calls (`uses: ./.github/workflows/<file>`), by file name. */
export function calls(text) {
  return [...text.matchAll(/uses:\s*["']?\.\/\.github\/workflows\/([^\s"'@]+)/g)].map((m) => m[1]);
}

/** Whether any job's `environment` (or its `name:`) comes from an expression. */
export function expressionEnvironment(text) {
  const lines = text.split(/\r?\n/).map(uncomment);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)environment:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2].includes("${{")) return true;
    if (m[2].trim()) continue;
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > m[1].length); j++) {
      if (/^\s*name:.*\$\{\{/.test(lines[j])) return true;
    }
  }
  return false;
}

/** Every problem, from the workflows as { "<file name>": text }. */
export function workflowProblems(workflows) {
  const problems = [];
  const files = Object.keys(workflows).sort();
  for (const file of files) {
    if (NAMES.test(workflows[file]) && file !== JOURNEYS_WORKFLOW) {
      problems.push(`${file}: names ${ENVIRONMENT}; only .github/workflows/${JOURNEYS_WORKFLOW} may`);
    }
    if (expressionEnvironment(workflows[file])) {
      problems.push(`${file}: sets a job's environment from an expression; name the environment literally`);
    }
  }
  // The workflows that name the environment, and every workflow that calls one of them.
  const reach = new Map(files.filter((f) => NAMES.test(workflows[f])).map((f) => [f, `names ${ENVIRONMENT}`]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const file of files) {
      if (reach.has(file)) continue;
      const callee = calls(workflows[file]).find((c) => reach.has(c));
      if (callee) {
        reach.set(file, `calls ${callee}, which ${reach.get(callee)}`);
        grew = true;
      }
    }
  }
  for (const [file, why] of [...reach].sort(([a], [b]) => a.localeCompare(b))) {
    const on = triggers(workflows[file]);
    if (!on) {
      problems.push(`${file}: ${why}, and its triggers (on:) can't be read; write them as a list or a block map`);
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
