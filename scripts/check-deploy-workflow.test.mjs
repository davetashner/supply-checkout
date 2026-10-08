// node --test scripts/check-deploy-workflow.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { afterApplyApproval, deployTextProblems, grantsIdToken, needsClosure } from "./check-deploy-workflow.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "check-deploy-workflow.mjs");

const checkout = (ref) => `      - uses: actions/checkout@abc # v7\n        with:\n${ref === undefined ? "" : `          ref: ${ref}\n`}          persist-credentials: false\n`;
const release = "${{ needs.release.outputs.sha }}";
const main = "${{ github.sha }}";

// The shape of deploy.yml: release code only in jobs without id-token, and in the apply jobs
const good = `on: workflow_dispatch
permissions: {}
jobs:
  release:
    runs-on: x
    permissions:
      contents: read
    steps:
${checkout(undefined)}
  trust:
    needs: release
    runs-on: x
    permissions:
      id-token: write
    steps:
      - run: echo refuse
  synth:
    needs: release
    runs-on: x
    permissions:
      contents: read
    steps:
      - &release
${checkout(release).replace("      - uses", "        uses")}
  plan:
    needs: [release, synth]
    runs-on: x
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
${checkout(main)}      - uses: actions/download-artifact@abc
  apply-stateful:
    needs: [release, plan]
    runs-on: x
    environment: production-stateful
    permissions:
      id-token: write
    steps:
      - *release
  apply:
    needs: [release, plan, apply-stateful]
    runs-on: x
    environment: production
    permissions:
      id-token: write
    steps:
      - *release
  journeys:
    needs: [release, apply]
    permissions:
      id-token: write
    uses: ./.github/workflows/journeys.yml
`;

test("passes deploy.yml's shape", () => {
  assert.deepEqual(deployTextProblems(good), []);
});

test("the repository's deploy.yml passes", () => {
  const out = execFileSync("node", [script], { encoding: "utf8" });
  assert.match(out, /check-deploy-workflow: only apply-stateful, apply, journeys run release code/);
});

test("rule 1: the workflow's permissions don't grant id-token", () => {
  assert.deepEqual(deployTextProblems(good.replace("permissions: {}", "permissions:\n  id-token: write")), ["the workflow's permissions grant id-token; grant it per job"]);
  assert.match(deployTextProblems(good.replace("permissions: {}", "permissions: write-all"))[0], /the workflow's permissions grant id-token/);
});

test("rule 2: a job that can request the token checks out only main's commit", () => {
  // plan checking out the release, as it did before supply-checkout-pbp.39
  const planRelease = good.replace(`${checkout(main)}      - uses: actions/download-artifact`, `${checkout(main)}${checkout(release)}      - uses: actions/download-artifact`);
  assert.deepEqual(deployTextProblems(planRelease), [`job plan, step 2 (actions/checkout@abc): the job can request the OIDC token, so it may check out only main's commit (ref: ${main}), not ${release}`]);
  // The default ref, spelled without one
  assert.match(deployTextProblems(good.replace(checkout(main), checkout(undefined))).join("\n"), /job plan, step 1 .*not the default ref/);
  // Spacing inside the expression doesn't matter; another repository does
  assert.deepEqual(deployTextProblems(good.replace(checkout(main), checkout("${{github.sha}}"))), []);
  assert.match(deployTextProblems(good.replace(checkout(main), `${checkout(main)}          repository: someone/else\n`)).join("\n"), /may not check out another repository \(someone\/else\)/);
  // Through an alias, and in a job that inherits id-token from write-all
  assert.match(deployTextProblems(good.replace("      - uses: actions/download-artifact@abc", "      - *release")).join("\n"), /job plan, step 2 .*not \$\{\{ needs\.release\.outputs\.sha \}\}/);
  assert.match(deployTextProblems(good.replace("    permissions:\n      contents: read\n    steps:\n      - &release", "    permissions: write-all\n    steps:\n      - &release")).join("\n"), /job synth, step 1/);
  // Case doesn't hide the action
  assert.match(deployTextProblems(good.replace(checkout(main), checkout(release).replace("actions/checkout", "Actions/Checkout"))).join("\n"), /job plan, step 1/);
});

test("rule 2: a job that inherits the workflow's permissions is checked too", () => {
  const inherit = good.replace("permissions: {}", "permissions:\n  id-token: write").replace("  release:\n    runs-on: x\n    permissions:\n      contents: read\n", "  release:\n    runs-on: x\n");
  assert.match(deployTextProblems(inherit).join("\n"), /job release, step 1 .*not the default ref/);
});

test("rule 2: no reusable workflow call from a job that can request the token, but for the apply-approved ones", () => {
  const call = good.replace("  trust:\n    needs: release\n    runs-on: x\n    permissions:\n      id-token: write\n    steps:\n      - run: echo refuse\n", "  trust:\n    needs: release\n    permissions:\n      id-token: write\n    uses: ./.github/workflows/other.yml\n");
  assert.deepEqual(deployTextProblems(call), ["job trust can request the OIDC token, so it may not call a reusable workflow (./.github/workflows/other.yml)"]);
});

test("rule 3: the jobs that run the release with the token are past an apply approval", () => {
  // apply without its environment, or not after plan
  assert.match(deployTextProblems(good.replace("    environment: production-stateful\n", "")).join("\n"), /job apply-stateful runs the release with the deploy role, so it must be past an apply approval/);
  assert.match(deployTextProblems(good.replace("  apply:\n    needs: [release, plan, apply-stateful]", "  apply:\n    needs: [release]")).join("\n"), /job apply runs the release/);
  // journeys only after apply
  assert.match(deployTextProblems(good.replace("    needs: [release, apply]\n", "    needs: [release]\n")).join("\n"), /job journeys runs the release/);
});

test("helpers", () => {
  assert.equal(grantsIdToken({ "id-token": "write" }), true);
  assert.equal(grantsIdToken({ "id-token": "read" }), false);
  assert.equal(grantsIdToken({}), false);
  assert.equal(grantsIdToken(undefined), false);
  assert.equal(grantsIdToken("read-all"), false);
  assert.equal(grantsIdToken(" write-all "), true);
  const jobs = { a: {}, b: { needs: "a" }, c: { needs: ["b"], environment: "e" }, loop1: { needs: "loop2" }, loop2: { needs: "loop1" } };
  assert.deepEqual([...needsClosure(jobs, "c")].sort(), ["a", "b"]);
  assert.deepEqual([...needsClosure(jobs, "loop1")].sort(), ["loop1", "loop2"]);
  assert.equal(afterApplyApproval(jobs, "c"), false, "no plan before it");
  assert.equal(afterApplyApproval(jobs, "loop1"), false);
  assert.equal(afterApplyApproval(jobs, "missing"), false);
  assert.equal(afterApplyApproval({ plan: {}, d: { needs: "plan", environment: "production" }, e: { needs: "d" } }, "e"), true);
  assert.deepEqual(deployTextProblems("jobs: ["), [deployTextProblems("jobs: [")[0]]);
  assert.match(deployTextProblems("jobs: [")[0], /^can't be read as a workflow/);
});
