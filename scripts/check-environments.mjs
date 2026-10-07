#!/usr/bin/env node
// Refuses to go on unless the GitHub environments an AWS role trusts are locked down
// (supply-checkout-pbp.27, supply-checkout-o60.4). GitHub creates an environment, with no
// protection at all, the first time a job names one that doesn't exist; the deploy role trusts
// any job in `production` or `production-stateful`, and the journeys role any job in
// `production-journeys`. So before anything names them, check each exists with:
//
//   - can_admins_bypass false (administrators can't skip the rules),
//   - custom deployment branch policies (not "any branch", not "protected branches"),
//   - a required_reviewers rule with at least one reviewer (not for `production-journeys`:
//     the owner already approved the deploy it follows, and it deploys nothing),
//   - exactly one deployment branch policy: `main`, type branch (no tags, no patterns).
//
//   node scripts/check-environments.mjs [--repo owner/name] [--environment name ...]
//
// With no --environment it checks `production` and `production-stateful` (ENVIRONMENTS).
// Uses `gh api` (GH_TOKEN in Actions; your gh login on a laptop). The deploy workflow's
// release job runs it before any job names an environment, dry runs included;
// `npm run deploy:github-deploy` (infra/) runs it before deploying the deploy role's trust, and
// `npm run deploy:journeys` (infra/) for `production-journeys` before deploying the journeys role.
// Exits 1 with the problems listed, 0 when every one checked is right.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** In step with GITHUB_DEPLOY_ENVIRONMENTS in infra/lib/config.ts (check-environments.test.mjs checks). */
export const ENVIRONMENTS = ["production", "production-stateful"];
/** GITHUB_JOURNEYS_ENVIRONMENT in infra/lib/config.ts (check-environments.test.mjs checks). */
export const JOURNEYS_ENVIRONMENT = "production-journeys";
/** Each environment this checks, with its own rules and where its setup is documented. */
export const RULES = {
  production: { requireReviewers: true, setup: 'docs/releases.md, "Settings it needs"' },
  "production-stateful": { requireReviewers: true, setup: 'docs/releases.md, "Settings it needs"' },
  [JOURNEYS_ENVIRONMENT]: { requireReviewers: false, setup: 'docs/releases.md, "The production-journeys environment"' },
};
/** In step with DEFAULT_GITHUB_REPOSITORY in infra/lib/config.ts. */
export const DEFAULT_REPO = "davetashner/supply-checkout";

/**
 * The problems with one environment, from GitHub's answers to GET .../environments/<name>
 * (`environment`, or null when it doesn't exist) and .../deployment-branch-policies (`policies`).
 */
export function environmentProblems(name, environment, policies) {
  const rules = RULES[name];
  if (!rules) throw new Error(`No rules for environment "${name}" (known: ${Object.keys(RULES).join(", ")})`);
  if (!environment) return [`${name}: doesn't exist. Create it (${rules.setup}) before anything deploys.`];
  const problems = [];
  if (environment.can_admins_bypass !== false) problems.push(`${name}: administrators can bypass its rules (uncheck "Allow administrators to bypass configured protection rules")`);
  const branchPolicy = environment.deployment_branch_policy;
  if (!branchPolicy || branchPolicy.custom_branch_policies !== true || branchPolicy.protected_branches === true) {
    problems.push(`${name}: deployment branches must be "Selected branches and tags" (custom policies), not any branch or protected branches`);
  }
  const reviewers = (environment.protection_rules ?? []).filter((r) => r.type === "required_reviewers");
  if (rules.requireReviewers && !reviewers.some((r) => Array.isArray(r.reviewers) && r.reviewers.length > 0)) problems.push(`${name}: no required reviewers`);
  const list = policies?.branch_policies ?? [];
  if (list.length !== 1 || list[0].name !== "main" || list[0].type !== "branch") {
    const found = list.map((p) => `${p.name} (${p.type})`).join(", ") || "none";
    problems.push(`${name}: deployment branch policies must be exactly main (branch), found ${found}`);
  }
  return problems;
}

/** Every problem across `names` (ENVIRONMENTS by default). `api(path)` returns the parsed JSON, or null for a 404. */
export function checkEnvironments(repo, api, names = ENVIRONMENTS) {
  return names.flatMap((name) => {
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
    throw new Error(`gh api ${apiPath} failed: ${String(e.stderr ?? e.message).trim()}`, { cause: e });
  }
}

/** The repository and environments the command line names. */
export function parseArgs(argv) {
  let repo = DEFAULT_REPO;
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo" && i + 1 < argv.length) repo = argv[++i];
    else if (argv[i] === "--environment" && i + 1 < argv.length) names.push(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`--repo must be owner/name (got "${repo}")`);
  for (const name of names) if (!Object.hasOwn(RULES, name)) throw new Error(`--environment must be one of ${Object.keys(RULES).join(", ")} (got "${name}")`);
  return { repo, names: names.length ? [...new Set(names)] : ENVIRONMENTS };
}

export function main(argv, api = ghApi) {
  const { repo, names } = parseArgs(argv);
  return checkEnvironments(repo, api, names);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let problems;
  let names;
  try {
    ({ names } = parseArgs(process.argv.slice(2)));
    problems = main(process.argv.slice(2));
  } catch (e) {
    console.error(`check-environments: ${e.message}`);
    process.exit(2);
  }
  if (problems.length) {
    console.error(`These GitHub environments aren't locked down:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  const checked = names.map((name) => (RULES[name].requireReviewers ? `${name} (with required reviewers)` : name));
  console.log(`check-environments: ${checked.join(", ")}: each exists, main only, no admin bypass`);
}
