// node --test scripts/check-workflow-environments.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWED_TRIGGERS, calls, expressionEnvironment, readWorkflows, triggers, workflowProblems } from "./check-workflow-environments.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "check-workflow-environments.mjs");

const journeys = (on = "  workflow_call:\n  workflow_dispatch:\n") => `name: Journeys\non:\n${on}jobs:\n  run:\n    runs-on: ubuntu-latest\n    environment: production-journeys\n    steps:\n      - run: echo hi\n`;
const deploy = `name: Deploy\non:\n  workflow_dispatch:\njobs:\n  journeys:\n    uses: ./.github/workflows/journeys.yml\n    secrets: inherit\n`;
const ci = `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: npm run lint\n`;

test("passes without journeys.yml, and with it named only there and started only by allowed events", () => {
  assert.deepEqual(workflowProblems({ "ci.yml": ci }), []);
  assert.deepEqual(workflowProblems({ "ci.yml": ci, "journeys.yml": journeys(), "deploy.yml": deploy }), []);
  assert.deepEqual(workflowProblems({ "journeys.yml": journeys("  push:\n    branches: [main]\n  schedule:\n    - cron: \"0 7 * * *\"\n") }), []);
});

test("rule 1: only journeys.yml may name production-journeys, in any case, comments included", () => {
  for (const text of [
    "on: workflow_dispatch\njobs:\n  x:\n    environment: production-journeys\n",
    "on: workflow_dispatch\njobs:\n  x:\n    environment:\n      name: Production-Journeys\n",
    "on: workflow_dispatch\n# runs in production-journeys later\n",
  ]) {
    const problems = workflowProblems({ "deploy.yml": text });
    assert.equal(problems[0], "deploy.yml: names production-journeys; only .github/workflows/journeys.yml may", text);
  }
  // Not even a journeys.yaml spelled differently
  assert.match(workflowProblems({ "journeys.yaml": journeys() })[0], /^journeys\.yaml: names production-journeys/);
  assert.match(workflowProblems({ "ci.yml": ci.replace("production", "production-journeys") }).join("\n"), /ci\.yml: names production-journeys; only/);
});

test("rule 2: no pull request trigger in a workflow that names it", () => {
  for (const [on, has] of [
    ["  pull_request:\n  workflow_dispatch:\n", "pull_request"],
    ["  pull_request_target:\n    types: [opened]\n", "pull_request_target"],
    ["  workflow_call:\n  pull_request_review:\n", "pull_request_review"],
  ]) {
    assert.deepEqual(workflowProblems({ "journeys.yml": journeys(on) }), [`journeys.yml: names production-journeys, so it must have no pull request trigger (has ${has})`]);
  }
  assert.deepEqual(workflowProblems({ "journeys.yml": journeys().replace(/on:\n[\s\S]*?jobs:/, "on: [push, pull_request_target]\njobs:") }), [
    "journeys.yml: names production-journeys, so it must have no pull request trigger (has pull_request_target)",
  ]);
  assert.deepEqual(workflowProblems({ "journeys.yml": journeys().replace(/on:\n[\s\S]*?jobs:/, "on: pull_request\njobs:") }), [
    "journeys.yml: names production-journeys, so it must have no pull request trigger (has pull_request)",
  ]);
});

test("rule 2: nor in any workflow that calls it, however indirectly", () => {
  const prCaller = `on:\n  pull_request_target:\njobs:\n  j:\n    uses: ./.github/workflows/journeys.yml\n`;
  assert.deepEqual(workflowProblems({ "journeys.yml": journeys(), "pr.yml": prCaller }), [
    "pr.yml: calls journeys.yml, which names production-journeys, so it must have no pull request trigger (has pull_request_target)",
  ]);
  const middle = `on:\n  workflow_call:\njobs:\n  j:\n    uses: "./.github/workflows/journeys.yml"\n`;
  const top = `on:\n  - pull_request\n  - workflow_dispatch\njobs:\n  j:\n    uses: ./.github/workflows/middle.yml@main\n`;
  assert.deepEqual(workflowProblems({ "journeys.yml": journeys(), "middle.yml": middle, "top.yml": top }), [
    "top.yml: calls middle.yml, which calls journeys.yml, which names production-journeys, so it must have no pull request trigger (has pull_request)",
  ]);
  // Calling a workflow that doesn't reach it is fine
  assert.deepEqual(workflowProblems({ "journeys.yml": journeys(), "ci.yml": ci.replace("steps:", "uses: ./.github/workflows/other.yml\n    steps:"), "other.yml": "on: workflow_call\n" }), []);
});

test("rule 2: only the allowed triggers, and triggers it can't read fail", () => {
  assert.deepEqual(ALLOWED_TRIGGERS, ["workflow_call", "workflow_dispatch", "push", "schedule"]);
  for (const event of ["issue_comment", "workflow_run", "issues", "release"]) {
    assert.deepEqual(workflowProblems({ "journeys.yml": journeys(`  workflow_call:\n  ${event}:\n`) }), [
      `journeys.yml: names production-journeys, so it may only be started by workflow_call, workflow_dispatch, push, schedule (has ${event})`,
    ]);
  }
  for (const on of ["  [workflow_call,\n   pull_request]\n", "  <<: *triggers\n"]) {
    assert.match(workflowProblems({ "journeys.yml": journeys(on) })[0], /triggers \(on:\) can't be read/, on);
  }
  assert.match(workflowProblems({ "journeys.yml": "jobs:\n  x:\n    environment: production-journeys\n" })[0], /can't be read/);
  // Workflows that don't reach it may have any trigger
  assert.deepEqual(workflowProblems({ "x.yml": "on: [issue_comment, pull_request_target]\n" }), []);
});

test("rule 3: no environment from an expression, in any workflow", () => {
  for (const text of [
    "on: pull_request_target\njobs:\n  x:\n    environment: ${{ github.head_ref }}\n",
    "on: workflow_dispatch\njobs:\n  x:\n    environment:\n      name: ${{ inputs.env }}\n      url: https://example.test\n",
  ]) {
    assert.deepEqual(workflowProblems({ "x.yml": text }), ["x.yml: sets a job's environment from an expression; name the environment literally"], text);
  }
  assert.equal(expressionEnvironment("jobs:\n  x:\n    environment:\n      name: production\n      url: ${{ steps.x.outputs.url }}\n  y:\n    name: ${{ inputs.x }}\n"), false);
  assert.equal(expressionEnvironment("jobs:\n  x:\n    environment: production # not ${{ x }}\n"), false);
});

test("reading triggers and calls", () => {
  assert.deepEqual(triggers("on: push\n"), ["push"]);
  assert.deepEqual(triggers("'on': [push, \"workflow_dispatch\"]\n"), ["push", "workflow_dispatch"]);
  assert.deepEqual(triggers("name: x\non:\n  # comment\n  push:\n    branches: [main]\n\n  schedule:\n    - cron: x\njobs: {}\n"), ["push", "schedule"]);
  assert.deepEqual(triggers('"on":\n  - push\n  - workflow_call\n'), ["push", "workflow_call"]);
  assert.equal(triggers("on: [push, {x: 1}]\n"), null);
  assert.equal(triggers("on: {push: {}}\n"), null);
  assert.equal(triggers("on:\njobs:\n"), null);
  assert.equal(triggers("on:\n    push:\n  pull_request:\n"), null);
  assert.equal(triggers("on:\n  - push: x\n"), null);
  assert.deepEqual(calls("    uses: ./.github/workflows/a.yml\n    uses: 'b.yml'\n    uses: ./.github/workflows/c.yaml@v1\n"), ["a.yml", "c.yaml"]);
});

test("this repository's workflows pass, and the command says so", () => {
  const workflows = readWorkflows(path.join(root, ".github", "workflows"));
  assert.ok(Object.keys(workflows).includes("ci.yml"));
  assert.deepEqual(workflowProblems(workflows), []);
  assert.match(execFileSync(process.execPath, [script], { encoding: "utf8" }), /^check-workflow-environments: \d+ workflows; /);
});

test("CI runs it in the workflow lint job", () => {
  const ciYml = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciYml, /- run: node scripts\/check-workflow-environments\.mjs/);
});
