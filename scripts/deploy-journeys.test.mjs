// node --test scripts/deploy-journeys.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_OWNER_ID, DEFAULT_REPOSITORY_ID } from "./deploy-github-deploy.mjs";
import { JOURNEYS, cdkArgs, main } from "./deploy-journeys.mjs";

/** GitHub's answers: the repository (with IDs) and a production-journeys environment, `env` changing it. */
const github = ({ repoId = DEFAULT_REPOSITORY_ID, ownerId = DEFAULT_OWNER_ID, env = {}, policies = [{ name: "main", type: "branch" }] } = {}) => (seen = []) => (p) => {
  seen.push(p);
  if (/^repos\/[^/]+\/[^/]+$/.test(p)) return { id: Number(repoId), owner: { id: Number(ownerId) } };
  if (p.endsWith("deployment-branch-policies?per_page=100")) return { branch_policies: policies };
  if (env === null) return null;
  return {
    can_admins_bypass: false,
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    protection_rules: [{ type: "branch_policy" }],
    ...env,
  };
};
const noFiles = { exists: () => false, env: {}, home: "/home/x", infraDir: "/repo/infra" };

test("checks production-journeys (no reviewer needed), then deploys the journeys app with the caller's arguments", () => {
  const seen = [];
  const runs = [];
  const logs = [];
  const args = ["--profile", "p", "-c", "githubRepository=o/r", "-c", "githubOwnerId=1", "-c", "githubRepositoryId=2"];
  const code = main(args, { ...noFiles, api: github({ repoId: 2, ownerId: 1 })(seen), run: (cmd, a, opts) => { runs.push([cmd, ...a, opts.stdio]); return { status: 0 }; }, log: (l) => logs.push(l) });
  assert.equal(code, 0);
  assert.deepEqual(seen, ["repos/o/r", "repos/o/r/environments/production-journeys", "repos/o/r/environments/production-journeys/deployment-branch-policies?per_page=100"]);
  assert.deepEqual(runs, [["./node_modules/.bin/cdk", "deploy", "--app", "npx tsx bin/journeys.ts", "-o", "cdk.out/journeys", ...args, "inherit"]]);
  assert.deepEqual(cdkArgs([]), ["deploy", "--app", "npx tsx bin/journeys.ts", "-o", "cdk.out/journeys"]);
  assert.deepEqual(JOURNEYS.environments, ["production-journeys"]);
  assert.equal(logs[0], "o/r: the IDs match, and production-journeys is locked down. Deploying the journeys stack.");
});

test("refuses, deploying nothing, unless production-journeys is locked down (and on the usual context and ID problems)", () => {
  const cases = [
    [noFiles, github({ env: null })(), /production-journeys: doesn't exist/],
    [noFiles, github({ env: { can_admins_bypass: true } })(), /production-journeys: administrators can bypass/],
    [noFiles, github({ env: { deployment_branch_policy: { custom_branch_policies: false, protected_branches: false } } })(), /production-journeys: deployment branches must be/],
    [noFiles, github({ policies: [{ name: "main", type: "branch" }, { name: "*", type: "branch" }] })(), /production-journeys: deployment branch policies must be exactly main/],
    [noFiles, github({ repoId: 7 })(), /repository ID is 7/],
    [{ ...noFiles, exists: (f) => f === "/repo/infra/cdk.json", read: () => '{"context":{"githubRepository":"evil/repo"}}' }, github()(), /cdk\.json sets githubRepository/],
    [{ ...noFiles, env: { CDK_CONTEXT_JSON: '{"githubRepositoryId":"1"}' } }, github()(), /CDK_CONTEXT_JSON sets githubRepositoryId/],
  ];
  for (const [deps, api, expected] of cases) {
    const runs = [];
    const errors = [];
    assert.equal(main(["--profile", "p"], { ...deps, api, run: () => runs.push(1), log: () => {}, error: (e) => errors.push(e) }), 1);
    assert.deepEqual(runs, []);
    assert.match(errors[0], /^Not deploying the journeys stack for /);
    assert.match(errors[0], expected);
  }
});

test("a failed cdk deploy fails it", () => {
  assert.equal(main([], { ...noFiles, api: github()(), run: () => ({ status: 3 }), log: () => {} }), 3);
  assert.equal(main([], { ...noFiles, api: github()(), run: () => ({ status: null }), log: () => {} }), 1);
});

test("in step with infra: the package script and the app it deploys", () => {
  const pkg = JSON.parse(readFileSync(new URL("../infra/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["deploy:journeys"], "node ../scripts/deploy-journeys.mjs");
  assert.ok(pkg.scripts["synth:journeys"].includes('--app "npx tsx bin/journeys.ts" -o cdk.out/journeys'));
});

test("refuses arguments that pick another app, output directory or stack, deploying nothing", () => {
  for (const args of [
    ["--app", "npx tsx bin/app.ts"], ["--app=x"], ["-a", "x"], ["-ax"], ["--output", "elsewhere"], ["--output=elsewhere"], ["-o", "x"],
    ["--all"], ["supply-checkout-prod-us-east-1-data"], ["--profile", "p", "some-stack"], ["--", "--profile", "p"],
  ]) {
    const runs = [];
    const errors = [];
    assert.equal(main(args, { ...noFiles, api: github()(), run: () => runs.push(1), log: () => {}, error: (e) => errors.push(e) }), 1, args.join(" "));
    assert.deepEqual(runs, []);
    assert.match(errors[0], /this deploys its own|not allowed/);
  }
  // Values of options that take one are fine
  const runs = [];
  const args = ["--profile", "p", "--require-approval", "never", "-c", "envName=prod", "--outputs-file", "out.json", "-O", "o.json", "-r", "arn", "--method", "direct"];
  assert.equal(main(args, { ...noFiles, api: github()(), run: (cmd, a) => { runs.push(a); return { status: 0 }; }, log: () => {} }), 0);
  assert.deepEqual(runs[0], cdkArgs(args));
});
