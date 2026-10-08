// node --test scripts/check-environments.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_REPO, ENVIRONMENTS, JOURNEYS_ENVIRONMENT, RULES, checkEnvironments, environmentProblems, ghApi, main, parseArgs } from "./check-environments.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Shaped like GitHub's answers (GET /repos/{repo}/environments/{name} and its deployment-branch-policies)
const good = (name) => ({
  name,
  can_admins_bypass: false,
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  protection_rules: [
    { id: 1, type: "branch_policy" },
    { id: 2, type: "required_reviewers", prevent_self_review: false, reviewers: [{ type: "User", reviewer: { login: "owner" } }] },
  ],
});
const mainOnly = { total_count: 1, branch_policies: [{ id: 1, name: "main", type: "branch" }] };

function fakeApi(overrides = {}) {
  const calls = [];
  const api = (p) => {
    calls.push(p);
    if (Object.hasOwn(overrides, p)) return overrides[p];
    const m = /^repos\/o\/r\/environments\/([^/]+)(\/deployment-branch-policies\?per_page=100)?$/.exec(p);
    assert.ok(m, `unexpected call ${p}`);
    return m[2] ? mainOnly : good(m[1]);
  };
  return { api, calls };
}

test("passes when both environments are locked down", () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(checkEnvironments("o/r", api), []);
  assert.deepEqual(calls, [
    "repos/o/r/environments/production",
    "repos/o/r/environments/production/deployment-branch-policies?per_page=100",
    "repos/o/r/environments/production-stateful",
    "repos/o/r/environments/production-stateful/deployment-branch-policies?per_page=100",
  ]);
});

test("refuses a missing environment, which GitHub would create unprotected", () => {
  const { api } = fakeApi({ "repos/o/r/environments/production-stateful": null });
  const problems = checkEnvironments("o/r", api);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^production-stateful: doesn't exist/);
});

test("refuses admin bypass, any-branch or protected-branch policies, and no reviewers", () => {
  const cases = [
    [{ can_admins_bypass: true }, /administrators can bypass/],
    [{ can_admins_bypass: undefined }, /administrators can bypass/],
    [{ deployment_branch_policy: null }, /Selected branches and tags/],
    [{ deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, /Selected branches and tags/],
    [{ protection_rules: [{ type: "branch_policy" }] }, /no required reviewers/],
    [{ protection_rules: [{ type: "required_reviewers", reviewers: [] }] }, /no required reviewers/],
    [{ protection_rules: undefined }, /no required reviewers/],
  ];
  for (const [change, expected] of cases) {
    const problems = environmentProblems("production", { ...good("production"), ...change }, mainOnly);
    assert.equal(problems.length, 1, JSON.stringify(change));
    assert.match(problems[0], expected);
  }
});

test("the branch policies must be exactly main, as a branch", () => {
  for (const list of [
    [],
    [{ name: "main", type: "branch" }, { name: "v*", type: "tag" }],
    [{ name: "main", type: "tag" }],
    [{ name: "*", type: "branch" }],
    [{ name: "release/*", type: "branch" }],
  ]) {
    const problems = environmentProblems("production", good("production"), { branch_policies: list });
    assert.equal(problems.length, 1, JSON.stringify(list));
    assert.match(problems[0], /exactly main \(branch\)/);
  }
  assert.match(environmentProblems("production", good("production"), null)[0], /found none/);
});

test("command line: the repository, and arguments it refuses", () => {
  assert.deepEqual(main(["--repo", "o/r"], fakeApi().api), []);
  // The default repository, with every environment missing
  const seen = [];
  assert.equal(main([], (p) => { seen.push(p); return null; }).length, 2);
  assert.deepEqual(seen, ENVIRONMENTS.map((e) => `repos/${DEFAULT_REPO}/environments/${e}`));
  assert.throws(() => main(["--repo", "o/r/x"]), /--repo must be owner\/name/);
  assert.throws(() => main(["--frob"]), /Unknown argument/);
  assert.equal(DEFAULT_REPO, "davetashner/supply-checkout");
});

test("production-journeys: the same rules but no required reviewer, only when asked for", () => {
  const { api, calls } = fakeApi();
  assert.deepEqual(checkEnvironments("o/r", api, [JOURNEYS_ENVIRONMENT]), []);
  assert.deepEqual(calls, [
    "repos/o/r/environments/production-journeys",
    "repos/o/r/environments/production-journeys/deployment-branch-policies?per_page=100",
  ]);
  // No reviewers is fine for it, and still refused for the deploy environments
  const noReviewers = { ...good(JOURNEYS_ENVIRONMENT), protection_rules: [{ type: "branch_policy" }] };
  assert.deepEqual(environmentProblems(JOURNEYS_ENVIRONMENT, noReviewers, mainOnly), []);
  assert.deepEqual(environmentProblems(JOURNEYS_ENVIRONMENT, { ...noReviewers, protection_rules: undefined }, mainOnly), []);
  for (const name of ENVIRONMENTS) assert.deepEqual(environmentProblems(name, { ...noReviewers, name }, mainOnly), [`${name}: no required reviewers`]);
  // Everything else as for the others
  const cases = [
    [null, mainOnly, /^production-journeys: doesn't exist\. Create it \(docs\/releases\.md, "The production-journeys environment"\)/],
    [{ ...noReviewers, can_admins_bypass: true }, mainOnly, /administrators can bypass/],
    [{ ...noReviewers, can_admins_bypass: undefined }, mainOnly, /administrators can bypass/],
    [{ ...noReviewers, deployment_branch_policy: null }, mainOnly, /Selected branches and tags/],
    [{ ...noReviewers, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, mainOnly, /Selected branches and tags/],
    [noReviewers, { branch_policies: [{ name: "main", type: "branch" }, { name: "feature/*", type: "branch" }] }, /exactly main \(branch\)/],
    [noReviewers, { branch_policies: [{ name: "main", type: "tag" }] }, /exactly main \(branch\)/],
    [noReviewers, null, /found none/],
  ];
  for (const [environment, policies, expected] of cases) {
    const problems = environmentProblems(JOURNEYS_ENVIRONMENT, environment, policies);
    assert.equal(problems.length, 1, JSON.stringify([environment, policies]));
    assert.match(problems[0], expected);
  }
  // The deploy environments' message still points at their own settings
  assert.match(environmentProblems("production", null, null)[0], /docs\/releases\.md, "Settings it needs"/);
  assert.throws(() => environmentProblems("staging", good("staging"), mainOnly), /No rules for environment "staging"/);
  assert.deepEqual(Object.fromEntries(Object.entries(RULES).map(([k, v]) => [k, v.requireReviewers])), {
    production: true, "production-stateful": true, "production-journeys": false,
  });
});

test("command line: --environment picks which to check", () => {
  assert.deepEqual(parseArgs([]), { repo: DEFAULT_REPO, names: ENVIRONMENTS, optional: [] });
  assert.deepEqual(parseArgs(["--environment", "production-journeys", "--repo", "o/r"]), { repo: "o/r", names: ["production-journeys"], optional: [] });
  assert.deepEqual(parseArgs(["--environment", "production", "--environment", "production-journeys", "--environment", "production"]).names, ["production", "production-journeys"]);
  assert.throws(() => parseArgs(["--environment", "staging"]), /--environment must be one of production, production-stateful, production-journeys \(got "staging"\)/);
  assert.throws(() => parseArgs(["--environment"]), /Unknown argument: --environment/);
  const { api, calls } = fakeApi();
  assert.deepEqual(main(["--repo", "o/r", "--environment", "production-journeys"], api), []);
  assert.equal(calls.length, 2);
  // Missing, it's a problem (and the default run doesn't look at it)
  assert.match(main(["--repo", "o/r", "--environment", "production-journeys"], fakeApi({ "repos/o/r/environments/production-journeys": null }).api)[0], /production-journeys: doesn't exist/);
});

test("command line: --journeys adds the journeys environment without naming it", () => {
  assert.deepEqual(parseArgs(["--journeys", "required"]), { repo: DEFAULT_REPO, names: [...ENVIRONMENTS, JOURNEYS_ENVIRONMENT], optional: [] });
  assert.deepEqual(parseArgs(["--journeys", "if-present"]), { repo: DEFAULT_REPO, names: [...ENVIRONMENTS, JOURNEYS_ENVIRONMENT], optional: [JOURNEYS_ENVIRONMENT] });
  // With --environment, only those and the journeys one
  assert.deepEqual(parseArgs(["--environment", "production", "--journeys", "if-present"]).names, ["production", JOURNEYS_ENVIRONMENT]);
  // Named outright, it's required whatever --journeys says, and listed once
  assert.deepEqual(parseArgs(["--environment", JOURNEYS_ENVIRONMENT, "--journeys", "if-present"]), { repo: DEFAULT_REPO, names: [JOURNEYS_ENVIRONMENT], optional: [] });
  assert.throws(() => parseArgs(["--journeys", "maybe"]), /--journeys must be one of required, if-present \(got "maybe"\)/);
  assert.throws(() => parseArgs(["--journeys"]), /Unknown argument: --journeys/);
  assert.throws(() => parseArgs(["--journeys", "required", "--journeys", "if-present"]), /Unknown argument: --journeys/);

  // All three locked down: no problems, either way
  for (const mode of ["required", "if-present"]) {
    const { api, calls } = fakeApi();
    const skipped = [];
    assert.deepEqual(main(["--repo", "o/r", "--journeys", mode], api, skipped), []);
    assert.deepEqual(skipped, []);
    assert.ok(calls.includes("repos/o/r/environments/production-journeys/deployment-branch-policies?per_page=100"));
  }
  // Missing: a problem when required, skipped (and reported) when if-present
  const missing = { "repos/o/r/environments/production-journeys": null };
  assert.match(main(["--repo", "o/r", "--journeys", "required"], fakeApi(missing).api)[0], /production-journeys: doesn't exist/);
  const skipped = [];
  const { api, calls } = fakeApi(missing);
  assert.deepEqual(main(["--repo", "o/r", "--journeys", "if-present"], api, skipped), []);
  assert.deepEqual(skipped, [JOURNEYS_ENVIRONMENT]);
  assert.ok(!calls.includes("repos/o/r/environments/production-journeys/deployment-branch-policies?per_page=100"));
  // Present but not locked down: a problem in either mode
  const open = { "repos/o/r/environments/production-journeys": { ...good(JOURNEYS_ENVIRONMENT), can_admins_bypass: true } };
  for (const mode of ["required", "if-present"]) assert.match(main(["--repo", "o/r", "--journeys", mode], fakeApi(open).api)[0], /production-journeys: administrators can bypass/);
  // if-present never excuses the deploy environments
  assert.match(checkEnvironments("o/r", fakeApi({ "repos/o/r/environments/production": null }).api, ["production"], { optional: [JOURNEYS_ENVIRONMENT] })[0], /production: doesn't exist/);
});

test("the command's output and exit codes", () => {
  const script = path.join(root, "scripts", "check-environments.mjs");
  const r = spawnSync(process.execPath, [script, "--environment", "staging"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /check-environments: --environment must be one of/);
});

test("gh api: JSON back, a 404 as null, anything else an error", () => {
  assert.deepEqual(ghApi("x", () => '{"a":1}'), { a: 1 });
  const fail = (stderr) => () => { const e = new Error("exit 1"); e.stderr = stderr; throw e; };
  assert.equal(ghApi("x", fail("gh: Not Found (HTTP 404)")), null);
  assert.throws(() => ghApi("x", fail("gh: Bad credentials (HTTP 401)")), /gh api x failed: gh: Bad credentials/);
});

test("in step with infra/lib/config.ts", () => {
  const config = readFileSync(path.join(root, "infra", "lib", "config.ts"), "utf8");
  assert.match(config, /GITHUB_DEPLOY_ENVIRONMENT = "production";/);
  assert.match(config, /GITHUB_STATEFUL_DEPLOY_ENVIRONMENT = "production-stateful";/);
  assert.match(config, /GITHUB_DEPLOY_ENVIRONMENTS = \[GITHUB_DEPLOY_ENVIRONMENT, GITHUB_STATEFUL_DEPLOY_ENVIRONMENT\]/);
  assert.deepEqual(ENVIRONMENTS, ["production", "production-stateful"]);
  assert.match(config, /GITHUB_JOURNEYS_ENVIRONMENT = "production-journeys";/);
  assert.equal(JOURNEYS_ENVIRONMENT, "production-journeys");
  assert.ok(config.includes(`name: "${DEFAULT_REPO}"`));
});
