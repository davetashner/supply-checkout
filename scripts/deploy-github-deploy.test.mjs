// node --test scripts/deploy-github-deploy.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_REPO } from "./check-environments.mjs";
import { cdkArgs, main, repositoryFrom } from "./deploy-github-deploy.mjs";

const lockedDown = (seen) => (p) => {
  seen.push(p);
  if (p.endsWith("deployment-branch-policies?per_page=100")) return { branch_policies: [{ name: "main", type: "branch" }] };
  return {
    can_admins_bypass: false,
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }],
  };
};

test("the repository comes from the githubRepository context, in every form cdk takes", () => {
  assert.equal(repositoryFrom(["--profile", "p"]), DEFAULT_REPO);
  assert.equal(repositoryFrom(["-c", "githubRepository=o/r", "-c", "githubOwnerId=1"]), "o/r");
  assert.equal(repositoryFrom(["--context", "githubRepository=o/r2"]), "o/r2");
  assert.equal(repositoryFrom(["--context=githubRepository=o/r3"]), "o/r3");
  assert.equal(repositoryFrom(["-c=githubRepository=o/r4"]), "o/r4");
  assert.equal(repositoryFrom(["-c", "envName=prod"]), DEFAULT_REPO);
});

test("checks that repository's environments, then deploys with the caller's arguments", () => {
  const seen = [];
  const runs = [];
  const code = main(["--profile", "p", "-c", "githubRepository=o/r"], {
    api: lockedDown(seen),
    run: (cmd, args) => { runs.push([cmd, ...args]); return { status: 0 }; },
    log: () => {},
  });
  assert.equal(code, 0);
  assert.ok(seen.length === 4 && seen.every((p) => p.startsWith("repos/o/r/environments/")));
  assert.deepEqual(runs, [["./node_modules/.bin/cdk", ...cdkArgs(["--profile", "p", "-c", "githubRepository=o/r"])]]);
  assert.deepEqual(cdkArgs([]), ["deploy", "--app", "npx tsx bin/github-deploy.ts", "-o", "cdk.out/github-deploy"]);
});

test("refuses, deploying nothing, when the environments aren't locked down", () => {
  const runs = [];
  const errors = [];
  const code = main([], { api: () => null, run: () => runs.push(1), log: () => {}, error: (e) => errors.push(e) });
  assert.equal(code, 1);
  assert.deepEqual(runs, []);
  assert.match(errors[0], new RegExp(`${DEFAULT_REPO}'s deploy environments aren't locked down`));
});

test("a failed cdk deploy fails it", () => {
  assert.equal(main([], { api: lockedDown([]), run: () => ({ status: 3 }), log: () => {} }), 3);
  assert.equal(main([], { api: lockedDown([]), run: () => ({ status: null }), log: () => {} }), 1);
});

test("infra's deploy:github-deploy runs it", () => {
  const pkg = JSON.parse(readFileSync(new URL("../infra/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["deploy:github-deploy"], "node ../scripts/deploy-github-deploy.mjs");
});
