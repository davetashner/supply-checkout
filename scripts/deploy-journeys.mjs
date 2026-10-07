#!/usr/bin/env node
// `npm run deploy:journeys` (in infra/): deploys the prod journey tests' stack (bin/journeys.ts:
// the test mailbox, the results bucket and the journeys role; docs/infrastructure.md, "Journey
// tests"), after checking that the GitHub environment the role's trust names, `production-journeys`,
// is locked down (scripts/check-environments.mjs: exists, `main` only, no admin bypass), for the
// repository the trust is for. GitHub creates an environment with no protection the first time a
// job names one that doesn't exist, so the role must not exist before the environment does.
//
//   cd infra && npm run deploy:journeys -- --profile supply-prod [-c githubRepository=o/n -c ...]
//
// The same refusals as `npm run deploy:github-deploy` (scripts/deploy-github-deploy.mjs): context
// for the repository set outside the command line, IDs GitHub doesn't give that repository, or
// the environment not locked down. Every argument is passed on to `cdk deploy`.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JOURNEYS_ENVIRONMENT } from "./check-environments.mjs";
import { guardedDeploy } from "./deploy-github-deploy.mjs";

/** The `cdk deploy` arguments for the stack (bin/journeys.ts), with the caller's after them. */
export const cdkArgs = (args) => ["deploy", "--app", "npx tsx bin/journeys.ts", "-o", "cdk.out/journeys", ...args];

export const JOURNEYS = { what: "the journeys stack", cdkArgs, environments: [JOURNEYS_ENVIRONMENT] };

export const main = (args, deps = {}) => guardedDeploy(JOURNEYS, args, deps);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`deploy-journeys: ${e.message}`);
    process.exit(2);
  }
}
