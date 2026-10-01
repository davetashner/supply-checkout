#!/usr/bin/env node
// Which stacks each kind of deploy deploys, shared by scripts/deploy.sh (the owner's manual
// deploy) and .github/workflows/deploy.yml (the release pipeline, supply-checkout-pbp.26),
// so the two can't drift apart.
//
//   node scripts/deploy-stacks.mjs <group> [--env prod]   the group's stack patterns, space-separated
//   node scripts/deploy-stacks.mjs region                 the region the pipeline signs in to
//
// Stacks are chosen by kind (`supply-checkout-<env>-*-<kind>`), so no region is named here, and
// a deploy passes the patterns to `cdk diff` and `cdk deploy --exclusively`, which orders the
// stacks it was given by their dependencies (api and realtime before observability).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REGION } from "./publish-web.mjs";

/**
 * Groups of stack kinds (the `component` of each stack in infra/lib/stacks).
 * stateless: the API, live updates and alarms. Nothing in them holds data, so a release
 * deploys them without a second look (ADR 0012). deploy-stacks.test.mjs checks each is a
 * stateless stack. The web stack and the stateful stacks have their own steps.
 */
export const GROUPS = {
  web: ["web"],
  stateless: ["api", "realtime", "observability"],
};

// envName in infra/lib/config.ts validateConfig
const ENV = /^[a-z][a-z0-9-]{0,15}$/;

/** The `cdk` stack patterns for a group in an environment. */
export function stackPatterns(group, envName = "prod") {
  if (!Object.hasOwn(GROUPS, group)) throw new Error(`Unknown group "${group}": use one of ${Object.keys(GROUPS).join(", ")}`);
  if (!ENV.test(envName)) throw new Error(`--env must be lowercase letters, digits or dashes (got "${envName}")`);
  return GROUPS[group].map((kind) => `supply-checkout-${envName}-*-${kind}`);
}

export function main(argv) {
  const [what, ...rest] = argv;
  let envName = "prod";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--env" && i + 1 < rest.length) envName = rest[++i];
    else throw new Error(`Unknown argument: ${rest[i]}`);
  }
  // GLOBAL_SERVICES_REGION, which is also the primary region while the MVP runs in one
  // region (publish-web.test.mjs keeps DEFAULT_REGION in step with infra/lib/config.ts)
  if (what === "region") return DEFAULT_REGION;
  return stackPatterns(what, envName).join(" ");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`deploy-stacks: ${e.message}`);
    process.exit(2);
  }
}
