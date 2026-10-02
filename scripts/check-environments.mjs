#!/usr/bin/env node
// Refuses to go on unless the GitHub environments the deploy role trusts are locked down
// (supply-checkout-pbp.27). GitHub creates an environment, with no protection at all, the first
// time a job names one that doesn't exist; and the deploy role trusts any job in `production` or
// `production-stateful`. So before anything names them, check both exist with:
//
//   - can_admins_bypass false (administrators can't skip the rules),
//   - custom deployment branch policies (not "any branch", not "protected branches"),
//   - a required_reviewers rule with at least one reviewer,
//   - exactly one deployment branch policy: `main`, type branch (no tags, no patterns).
//
//   node scripts/check-environments.mjs [--repo owner/name]
//
// Uses `gh api` (GH_TOKEN in Actions; your gh login on a laptop). The deploy workflow's
// release job runs it before any job names an environment, dry runs included, and
// `npm run deploy:github-deploy` (infra/) runs it before deploying the role's trust.
// Exits 1 with the problems listed, 0 when both are right.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** In step with GITHUB_DEPLOY_ENVIRONMENTS in infra/lib/config.ts (check-environments.test.mjs checks). */
export const ENVIRONMENTS = ["production", "production-stateful"];
/** In step with DEFAULT_GITHUB_REPOSITORY in infra/lib/config.ts. */
export const DEFAULT_REPO = "davetashner/supply-checkout";

/**
 * The problems with one environment, from GitHub's answers to GET .../environments/<name>
 * (`environment`, or null when it doesn't exist) and .../deployment-branch-policies (`policies`).
 */
export function environmentProblems(name, environment, policies) {
  if (!environment) return [`${name}: doesn't exist. Create it (docs/releases.md, "Settings it needs") before anything deploys.`];
  const problems = [];
  if (environment.can_admins_bypass !== false) problems.push(`${name}: administrators can bypass its rules (uncheck "Allow administrators to bypass configured protection rules")`);
  const branchPolicy = environment.deployment_branch_policy;
  if (!branchPolicy || branchPolicy.custom_branch_policies !== true || branchPolicy.protected_branches === true) {
    problems.push(`${name}: deployment branches must be "Selected branches and tags" (custom policies), not any branch or protected branches`);
  }
  const reviewers = (environment.protection_rules ?? []).filter((r) => r.type === "required_reviewers");
  if (!reviewers.some((r) => Array.isArray(r.reviewers) && r.reviewers.length > 0)) problems.push(`${name}: no required reviewers`);
  const list = policies?.branch_policies ?? [];
  if (list.length !== 1 || list[0].name !== "main" || list[0].type !== "branch") {
    const found = list.map((p) => `${p.name} (${p.type})`).join(", ") || "none";
    problems.push(`${name}: deployment branch policies must be exactly main (branch), found ${found}`);
  }
  return problems;
}

/** Every problem across ENVIRONMENTS. `api(path)` returns the parsed JSON, or null for a 404. */
export function checkEnvironments(repo, api) {
  return ENVIRONMENTS.flatMap((name) => {
    const environment = api(`repos/${repo}/environments/${name}`);
    const policies = environment ? api(`repos/${repo}/environments/${name}/deployment-branch-policies?per_page=100`) : null;
    return environmentProblems(name, environment, policies);
  });
}

/** `gh api`, with a 404 as null and anything else an error. */
export function ghApi(apiPath, run = execFileSync) {
  try {
    return JSON.parse(run("gh", ["api", apiPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (e) {
    if (/HTTP 404|Not Found/.test(`${e.stderr ?? ""}${e.stdout ?? ""}`)) return null;
    throw new Error(`gh api ${apiPath} failed: ${String(e.stderr ?? e.message).trim()}`);
  }
}

export function main(argv, api = ghApi) {
  let repo = DEFAULT_REPO;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo" && i + 1 < argv.length) repo = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`--repo must be owner/name (got "${repo}")`);
  return checkEnvironments(repo, api);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let problems;
  try {
    problems = main(process.argv.slice(2));
  } catch (e) {
    console.error(`check-environments: ${e.message}`);
    process.exit(2);
  }
  if (problems.length) {
    console.error(`The deploy environments aren't locked down:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`check-environments: ${ENVIRONMENTS.join(" and ")} exist, main only, with required reviewers and no admin bypass`);
}
