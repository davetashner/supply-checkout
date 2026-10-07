#!/usr/bin/env node
// `npm run deploy:github-deploy` (in infra/): deploys GitHub Actions' deploy role stack, after
// checking that the GitHub environments its trust names are locked down
// (scripts/check-environments.mjs), for the repository the trust is for.
//
//   cd infra && npm run deploy:github-deploy -- --profile supply-prod [-c githubRepository=o/n -c ...]
//
// The repository and its owner and repository IDs are what the CDK app will use
// (lib/config.ts githubRepositoryFromContext): the `-c githubRepository=… -c githubOwnerId=…
// -c githubRepositoryId=…` given here, else DEFAULT_GITHUB_REPOSITORY. It refuses, deploying
// nothing, when:
//   - one of those keys is set in a context source this script doesn't read the CDK way
//     (infra/cdk.json, infra/cdk.context.json, ~/.cdk.json, CDK_CONTEXT_JSON) without the same
//     value on the command line, since the trust could then be for another repository than
//     the one checked;
//   - GitHub doesn't give that repository those owner and repository IDs;
//   - the repository's production and production-stateful environments aren't locked down.
// Every argument is passed on to `cdk deploy`.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REPO, ENVIRONMENTS, checkEnvironments, ghApi } from "./check-environments.mjs";

/** DEFAULT_GITHUB_REPOSITORY's IDs in infra/lib/config.ts (deploy-github-deploy.test.mjs checks). */
export const DEFAULT_OWNER_ID = "5702882";
export const DEFAULT_REPOSITORY_ID = "1388338851";
export const KEYS = ["githubRepository", "githubOwnerId", "githubRepositoryId"];

/** Every `-c key=value` / `--context key=value` / `-c=key=value` in cdk arguments (the last of each key wins). */
export function cliContext(args) {
  const context = {};
  for (let i = 0; i < args.length; i++) {
    let pair;
    if (args[i] === "-c" || args[i] === "--context") pair = args[i + 1];
    else if (/^(-c|--context)=/.test(args[i])) pair = args[i].replace(/^(-c|--context)=/, "");
    const eq = pair?.indexOf("=") ?? -1;
    if (eq > 0) context[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return context;
}

/** The repository named by the command line's context, else DEFAULT_REPO. */
export const repositoryFrom = (args) => cliContext(args).githubRepository ?? DEFAULT_REPO;

/** The other places CDK reads context from, as { source, context } (a missing file is skipped). */
export function contextSources({ infraDir, home = homedir(), env = process.env, read = (f) => readFileSync(f, "utf8"), exists = existsSync }) {
  const sources = [];
  const json = (file, pick) => {
    if (!exists(file)) return;
    sources.push({ source: file, context: pick(JSON.parse(read(file))) ?? {} });
  };
  json(path.join(infraDir, "cdk.json"), (j) => j.context);
  json(path.join(infraDir, "cdk.context.json"), (j) => j);
  json(path.join(home, ".cdk.json"), (j) => j.context);
  if (env.CDK_CONTEXT_JSON) sources.push({ source: "CDK_CONTEXT_JSON", context: JSON.parse(env.CDK_CONTEXT_JSON) ?? {} });
  return sources;
}

/** Problems with repository context set outside the command line. */
export function contextProblems(cli, sources) {
  const problems = [];
  for (const { source, context } of sources) {
    for (const key of KEYS) {
      if (context[key] !== undefined && String(context[key]) !== cli[key]) {
        problems.push(`${source} sets ${key} to ${JSON.stringify(context[key])}: pass the same -c ${key}=… on the command line, or remove it there`);
      }
    }
  }
  return problems;
}

/** Problems with the repository's IDs, against what GitHub says. */
export function idProblems(repo, ownerId, repositoryId, api) {
  const github = api(`repos/${repo}`);
  if (!github) return [`GitHub has no repository ${repo}`];
  const problems = [];
  if (String(github.id) !== repositoryId) problems.push(`${repo}'s repository ID is ${github.id}, not ${repositoryId}`);
  if (String(github.owner?.id) !== ownerId) problems.push(`${repo}'s owner ID is ${github.owner?.id}, not ${ownerId}`);
  return problems;
}

/** The `cdk deploy` arguments for the stack (bin/github-deploy.ts), with the caller's after them. */
export const cdkArgs = (args) => ["deploy", "--app", "npx tsx bin/github-deploy.ts", "-o", "cdk.out/github-deploy", ...args];

/** What `npm run deploy:github-deploy` deploys, and the environments its trust names. */
export const GITHUB_DEPLOY = { what: "the deploy role stack", cdkArgs, environments: ENVIRONMENTS };

/**
 * Deploys `target` ({ what, cdkArgs, environments }) with `args` passed on to `cdk deploy`, once
 * the repository context is the command line's, its IDs are GitHub's, and target.environments are
 * locked down. Returns the exit code; 1, deploying nothing, when anything is wrong.
 */
export function guardedDeploy(target, args, deps = {}) {
  const { api = ghApi, run = spawnSync, log = console.log, error = console.error, infraDir = process.cwd(), ...sourceDeps } = deps;
  const cli = cliContext(args);
  const repo = cli.githubRepository ?? DEFAULT_REPO;
  const problems = [
    ...contextProblems(cli, contextSources({ infraDir, ...sourceDeps })),
    ...idProblems(repo, cli.githubOwnerId ?? DEFAULT_OWNER_ID, cli.githubRepositoryId ?? DEFAULT_REPOSITORY_ID, api),
  ];
  if (!problems.length) problems.push(...checkEnvironments(repo, api, target.environments));
  if (problems.length) {
    error(`Not deploying ${target.what} for ${repo}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    return 1;
  }
  log(`${repo}: the IDs match, and ${target.environments.join(" and ")} ${target.environments.length === 1 ? "is" : "are"} locked down. Deploying ${target.what}.`);
  const result = run("./node_modules/.bin/cdk", target.cdkArgs(args), { stdio: "inherit" });
  return result.status ?? 1;
}

export const main = (args, deps = {}) => guardedDeploy(GITHUB_DEPLOY, args, deps);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`deploy-github-deploy: ${e.message}`);
    process.exit(2);
  }
}
