#!/usr/bin/env node
// `npm run deploy:github-deploy` (in infra/): deploys GitHub Actions' deploy role stack, after
// checking that the GitHub environments its trust names are locked down
// (scripts/check-environments.mjs), for the repository the trust is for.
//
//   cd infra && npm run deploy:github-deploy -- --profile supply-prod [-c githubRepository=o/n -c ...]
//
// The repository comes from the same `-c githubRepository=<owner>/<name>` context the CDK app
// reads (lib/config.ts githubRepositoryFromContext), so a trust for a renamed or forked
// repository is checked against that repository's environments, never the default one. Every
// argument is passed on to `cdk deploy`. It refuses, deploying nothing, when the check fails.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REPO, checkEnvironments, ghApi } from "./check-environments.mjs";

/** The repository named by `-c githubRepository=...` / `--context githubRepository=...` in cdk arguments, else DEFAULT_REPO. */
export function repositoryFrom(args) {
  let repo;
  for (let i = 0; i < args.length; i++) {
    let pair;
    if (args[i] === "-c" || args[i] === "--context") pair = args[i + 1];
    else if (/^(-c|--context)=/.test(args[i])) pair = args[i].replace(/^(-c|--context)=/, "");
    if (pair?.startsWith("githubRepository=")) repo = pair.slice("githubRepository=".length);
  }
  return repo ?? DEFAULT_REPO;
}

/** The `cdk deploy` arguments for the stack (bin/github-deploy.ts), with the caller's after them. */
export const cdkArgs = (args) => ["deploy", "--app", "npx tsx bin/github-deploy.ts", "-o", "cdk.out/github-deploy", ...args];

export function main(args, { api = ghApi, run = spawnSync, log = console.log, error = console.error } = {}) {
  const repo = repositoryFrom(args);
  const problems = checkEnvironments(repo, api);
  if (problems.length) {
    error(`Not deploying the deploy role: ${repo}'s deploy environments aren't locked down:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }
  log(`${repo}: production and production-stateful are locked down. Deploying the deploy role stack.`);
  const result = run("./node_modules/.bin/cdk", cdkArgs(args), { stdio: "inherit" });
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`deploy-github-deploy: ${e.message}`);
    process.exit(2);
  }
}
