#!/usr/bin/env node
// Keeps the release commit's code away from the production OIDC token in the deploy workflow
// (supply-checkout-pbp.39). A job with `id-token: write` can ask GitHub for an OIDC token, and in
// the production environments that token is the deploy role. Code from the release commit (its
// npm dependencies, its CDK app, its build) that runs in such a job can ask for it too, from any
// step: blanking ACTIONS_ID_TOKEN_REQUEST_* for one step doesn't stop it reaching the later ones
// through $GITHUB_ENV, $GITHUB_PATH, BASH_ENV or a process left running. So in
// .github/workflows/deploy.yml, parsed as YAML (anchors and aliases followed):
//
//   1. The workflow's own `permissions` don't grant id-token (`write-all` or `id-token: write`).
//   2. A job that can request the token (its `permissions`, or the workflow's when it has none)
//      checks out only main's commit, this workflow's own: every actions/checkout step says
//      `ref: ${{ github.sha }}` and no other `repository`. It calls no reusable workflow and uses
//      only actions/* actions (no local or composite action, which could come from elsewhere).
//      Nothing in it (its env, a step's env, with or run) mentions the release commit
//      (needs.release.outputs.sha), and no run step fetches code with git (checkout, fetch,
//      clone, worktree, switch, pull) or gh (repo clone, pr checkout).
//   3. No job that can request the token restores a cache (actions/cache, or setup-node's
//      `cache`): build and synth run release code that could poison one (through NODE_OPTIONS in
//      $GITHUB_ENV, say), and a cache is shared across runs. This holds for the apply jobs too.
//   4. Except the jobs in AFTER_APPLY_APPROVAL, which deploy the release and so run its code:
//      each must be past an apply approval, in an environment and after `plan`, or after such a
//      job.
//   5. Every actions/setup-node step, in any job, says `package-manager-cache: false`: setup-node
//      v5 and later cache npm on their own when package.json names a packageManager (or
//      devEngines.packageManager), so leaving it out could one day turn a cache on unseen.
//   6. No raw assembly or template hash passes between jobs or steps where the log shows it: no
//      job output whose name has "hash" in it unless it ends in -hmac (an HMAC under
//      DEPLOY_ASSEMBLY_KEY), and no ${{ needs.<job>.outputs.<…hash…> }} or
//      ${{ steps.<step>.outputs.<…hash…> }} in a job's env, outputs or with, or a step's env,
//      with or run, unless it ends in -hmac. GitHub prints a step's env in its header, and its run
//      with expressions filled in, masking only secrets; the source is public and the synth
//      deterministic, so a template hash there could be brute-forced back to the account. The
//      one exception is the build job's `hash`, of the web build, whose files are public anyway.
//
// It's a tripwire, not a proof: a run step could still reach the release's code some other way
// (a curl of the tarball, say), and files the release's jobs hand over (artifacts, outputs) still
// reach a job that has the token, which must treat them as data (scripts/check-assembly.mjs,
// docs/releases.md). Review deploy.yml changes with that in mind.
//
//   node scripts/check-deploy-workflow.mjs     (CI's "Lint and validate HTML" job)
//
// It also refuses any YAML merge key (`<<`), which could hide keys from these checks.
//
// Exits 1 with the problems listed, 0 when there are none.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasMergeKey, parseWorkflow } from "./check-workflow-environments.mjs";

/** Jobs that run the release commit's code with the deploy role, after an apply approval. */
export const AFTER_APPLY_APPROVAL = ["apply-stateful", "apply", "journeys"];
/** The plan job: an apply job must come after it. */
export const PLAN_JOB = "plan";
const MAIN_COMMIT = "${{ github.sha }}";
const RELEASE_SHA = /needs\s*\.\s*release\s*\.\s*outputs\s*\.\s*sha/i;
const FETCHES_CODE = /\bgit\b[^\n]*\b(checkout|fetch|clone|worktree|switch|pull|restore)\b|\bgh\b[^\n]*\b(repo\s+clone|pr\s+checkout)\b/i;

/** The job whose `hash` output is of the public web build, not of an assembly. */
export const WEB_BUILD_JOB = "build";
const OUTPUT_REF = /\b(needs|steps)\s*\.\s*([A-Za-z0-9_-]+)\s*\.\s*outputs\s*\.\s*([A-Za-z0-9_-]+)/gi;

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Whether a reference to an output, from job `inJob`, may show in a log: not a raw hash, unless it's the web build's. */
export function hashRefAllowed(kind, from, name, inJob) {
  if (!/hash/i.test(name) || /-hmac$/i.test(name)) return true;
  if (kind.toLowerCase() === "needs") return from === WEB_BUILD_JOB && name === "hash";
  return inJob === WEB_BUILD_JOB && name === "hash";
}

/** Every raw-hash output reference in a value (env, outputs, with, run). */
function rawHashRefs(value, inJob) {
  const refs = [];
  for (const [ref, kind, from, name] of JSON.stringify(value ?? null).matchAll(OUTPUT_REF)) {
    if (!hashRefAllowed(kind, from, name, inJob)) refs.push(ref.replace(/\s+/g, ""));
  }
  return refs;
}
const squash = (s) => String(s).replace(/\s+/g, "");

/** Whether these permissions (a job's or the workflow's) let a job request an OIDC token. */
export function grantsIdToken(permissions) {
  if (typeof permissions === "string") return permissions.trim() === "write-all";
  return isMap(permissions) && String(permissions["id-token"]).trim() === "write";
}

/** Every job a job needs, directly or not. */
export function needsClosure(jobs, id, seen = new Set()) {
  const needs = jobs[id]?.needs;
  for (const n of typeof needs === "string" ? [needs] : Array.isArray(needs) ? needs : []) {
    if (seen.has(n)) continue;
    seen.add(n);
    needsClosure(jobs, n, seen);
  }
  return seen;
}

/** Whether a job is past an apply approval: in an environment and after plan, or after such a job. */
export function afterApplyApproval(jobs, id, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  const job = jobs[id];
  if (!isMap(job)) return false;
  const before = needsClosure(jobs, id);
  if (job.environment !== undefined && before.has(PLAN_JOB)) return true;
  return [...before].some((n) => n !== id && afterApplyApproval(jobs, n, seen));
}

/** Every problem with a parsed deploy workflow. */
export function deployProblems(workflow) {
  const problems = [];
  if (hasMergeKey(workflow)) problems.push("it uses a YAML merge key (<<), which could hide keys from these checks; write the keys out");
  if (grantsIdToken(workflow.permissions)) problems.push("the workflow's permissions grant id-token; grant it per job");
  const jobs = isMap(workflow.jobs) ? workflow.jobs : {};
  for (const [id, job] of Object.entries(jobs)) {
    if (!isMap(job)) continue;
    for (const name of Object.keys(isMap(job.outputs) ? job.outputs : {})) {
      if (/hash/i.test(name) && !/-hmac$/i.test(name) && !(id === WEB_BUILD_JOB && name === "hash")) {
        problems.push(`job ${id}'s output ${name} names a hash: pass only an HMAC of one, as an output ending in -hmac, since an output reaches the log through any step that uses it`);
      }
    }
    for (const [where, value] of [["env", job.env], ["outputs", job.outputs], ["with", job.with]]) {
      for (const ref of rawHashRefs(value, id)) problems.push(`job ${id}'s ${where} uses ${ref}, a raw hash, which the log would show; use an -hmac output`);
    }
    (Array.isArray(job.steps) ? job.steps : []).forEach((step, i) => {
      if (!isMap(step)) return;
      for (const ref of rawHashRefs({ env: step.env, with: step.with, run: step.run }, id)) {
        problems.push(`job ${id}, step ${i + 1} (${step.name ?? step.uses ?? "run"}) uses ${ref}, a raw hash, which the log would show; use an -hmac output`);
      }
    });
    (Array.isArray(job.steps) ? job.steps : []).forEach((step, i) => {
      if (!isMap(step) || typeof step.uses !== "string" || !/^actions\/setup-node@/i.test(step.uses.trim())) return;
      const off = isMap(step.with) ? step.with["package-manager-cache"] : undefined;
      if (off !== false && String(off).trim() !== "false") {
        problems.push(`job ${id}, step ${i + 1} (${step.name ?? step.uses}): setup-node must say package-manager-cache: false, or it may cache on its own`);
      }
    });
    const permissions = job.permissions === undefined ? workflow.permissions : job.permissions;
    if (!grantsIdToken(permissions)) continue;
    (Array.isArray(job.steps) ? job.steps : []).forEach((step, i) => {
      const action = isMap(step) && typeof step.uses === "string" ? step.uses.trim().toLowerCase() : "";
      const cached = /^actions\/cache(\/[a-z]+)?@/.test(action) || (/^actions\/setup-[a-z]+@/.test(action) && isMap(step.with) && step.with.cache !== undefined && step.with.cache !== false && step.with.cache !== "");
      if (cached) problems.push(`job ${id}, step ${i + 1} (${step.name ?? step.uses}): the job can request the OIDC token, so it may restore no cache`);
    });
    if (AFTER_APPLY_APPROVAL.includes(id)) {
      if (!afterApplyApproval(jobs, id)) problems.push(`job ${id} runs the release with the deploy role, so it must be past an apply approval: in an environment and after ${PLAN_JOB}, or after such a job`);
      continue;
    }
    if (job.uses !== undefined) problems.push(`job ${id} can request the OIDC token, so it may not call a reusable workflow (${job.uses})`);
    if (JSON.stringify(job.env ?? {}).match(RELEASE_SHA)) problems.push(`job ${id} can request the OIDC token, so its env may not name the release commit (needs.release.outputs.sha)`);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, i) => {
      if (!isMap(step)) return;
      const name = `job ${id}, step ${i + 1} (${step.name ?? step.uses ?? "run"})`;
      if (RELEASE_SHA.test(JSON.stringify({ env: step.env, with: step.with, run: step.run }))) {
        problems.push(`${name}: the job can request the OIDC token, so it may not name the release commit (needs.release.outputs.sha)`);
      }
      if (typeof step.run === "string" && FETCHES_CODE.test(step.run)) {
        problems.push(`${name}: the job can request the OIDC token, so it may not fetch code with git or gh`);
      }
      if (step.uses === undefined) return;
      if (typeof step.uses !== "string" || !/^actions\/[A-Za-z0-9_.-]+@/i.test(step.uses.trim())) {
        problems.push(`${name}: the job can request the OIDC token, so it may use only actions/* actions, not ${step.uses}`);
        return;
      }
      if (!/^actions\/checkout@/i.test(step.uses.trim())) return;
      const withs = isMap(step.with) ? step.with : {};
      if (squash(withs.ref ?? "") !== squash(MAIN_COMMIT)) {
        problems.push(`${name}: the job can request the OIDC token, so it may check out only main's commit (ref: ${MAIN_COMMIT}), not ${withs.ref === undefined ? "the default ref" : withs.ref}`);
      }
      if (withs.repository !== undefined) problems.push(`${name}: the job can request the OIDC token, so it may not check out another repository (${withs.repository})`);
    });
  }
  return problems;
}

/** Every problem with the deploy workflow's text. */
export function deployTextProblems(text) {
  const { value, error } = parseWorkflow(text);
  if (error) return [`can't be read as a workflow (${error})`];
  return deployProblems(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "deploy.yml");
  const problems = deployTextProblems(readFileSync(file, "utf8"));
  if (problems.length) {
    console.error(`deploy.yml lets release code near the production OIDC token:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`check-deploy-workflow: only ${AFTER_APPLY_APPROVAL.join(", ")} run release code where the production OIDC token can be requested, each past an apply approval`);
}
