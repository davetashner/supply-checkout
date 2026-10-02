// node --test scripts/check-environments.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_REPO, ENVIRONMENTS, checkEnvironments, environmentProblems, ghApi, main } from "./check-environments.mjs";

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
  assert.ok(config.includes(`name: "${DEFAULT_REPO}"`));
});
