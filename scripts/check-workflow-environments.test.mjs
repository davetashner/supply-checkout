// node --test scripts/check-workflow-environments.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALLOWED_TRIGGERS, calls, parseWorkflow, readWorkflows, remoteCalls, triggers, uses, workflowProblems } from "./check-workflow-environments.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "check-workflow-environments.mjs");

const journeys = (on = "  workflow_call:\n  workflow_dispatch:\n") => `name: Journeys\non:\n${on}jobs:\n  run:\n    runs-on: ubuntu-latest\n    environment: production-journeys\n    steps:\n      - run: echo hi\n`;
const deploy = `name: Deploy\non:\n  workflow_dispatch:\njobs:\n  journeys:\n    uses: ./.github/workflows/journeys.yml\n    secrets: inherit\n`;
const ci = `name: CI\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: npm run lint\n`;
const parsed = (text) => parseWorkflow(text).value;

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

test("rule 1: YAML escapes and line folding don't hide the name", () => {
  for (const env of [
    String.raw`"production\x2Djourneys"`,
    String.raw`"production\u002Djourneys"`,
    String.raw`"PRODUCTION\x2DJOURNEYS"`,
    '"production-\\\n      journeys"',
    "\"production-\n      journeys\"".replace("-\n      ", "-\\\n      "),
  ]) {
    const text = `on: pull_request_target\njobs:\n  x:\n    runs-on: ubuntu-latest\n    environment: ${env}\n`;
    assert.doesNotMatch(text, /production-journeys/i, "the raw text hides it");
    const problems = workflowProblems({ "pr.yml": text });
    assert.ok(problems.includes("pr.yml: names production-journeys; only .github/workflows/journeys.yml may"), env);
    assert.ok(problems.some((p) => /must have no pull request trigger/.test(p)), env);
  }
  // And in a key
  assert.match(workflowProblems({ "x.yml": String.raw`on: push` + "\njobs:\n  " + String.raw`"production\x2Djourneys"` + ":\n    runs-on: x\n" })[0], /x\.yml: names production-journeys/);
});

test("rule 2: no pull request trigger in a workflow that names it, in any form of on:", () => {
  for (const [on, has] of [
    ["  pull_request:\n  workflow_dispatch:\n", "pull_request"],
    ["  pull_request_target:\n    types: [opened]\n", "pull_request_target"],
    ["  workflow_call:\n  pull_request_review:\n", "pull_request_review"],
    ["  [workflow_call,\n   pull_request]\n", "pull_request"],
    ["  - push\n  - pull_request_target\n", "pull_request_target"],
    ['  "pull_request": {}\n', "pull_request"],
  ]) {
    assert.deepEqual(workflowProblems({ "journeys.yml": journeys(on) }), [`journeys.yml: names production-journeys, so it must have no pull request trigger (has ${has})`], on);
  }
  for (const [on, has] of [["on: [push, pull_request_target]", "pull_request_target"], ["on: pull_request", "pull_request"], ["'on': {pull_request: null}", "pull_request"]]) {
    assert.deepEqual(workflowProblems({ "journeys.yml": journeys().replace(/on:\n[\s\S]*?jobs:/, `${on}\njobs:`) }), [
      `journeys.yml: names production-journeys, so it must have no pull request trigger (has ${has})`,
    ], on);
  }
});

test("rule 2: a decoy on: inside a multi-line quoted scalar isn't read as the triggers", () => {
  // At column 0 the yaml package refuses the scalar, which fails the check either way
  const text = `name: "x\non: workflow_dispatch\n  y"\non: pull_request_target\njobs:\n  x:\n    environment: production-journeys\n`;
  assert.match(workflowProblems({ "journeys.yml": text }).join("\n"), /can't be read as a workflow/);
  const indented = `name: "x\n  on: workflow_dispatch\n  y"\non: pull_request_target\njobs:\n  x:\n    environment: production-journeys\n`;
  assert.deepEqual(workflowProblems({ "journeys.yml": indented }), ["journeys.yml: names production-journeys, so it must have no pull request trigger (has pull_request_target)"]);
  const block = `name: |\n  on: workflow_dispatch\non: issue_comment\njobs:\n  x:\n    environment: production-journeys\n`;
  assert.match(workflowProblems({ "journeys.yml": block })[0], /may only be started by .* \(has issue_comment\)/);
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
  assert.deepEqual(workflowProblems({ "journeys.yml": journeys(), "ci.yml": ci.replace("    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: npm run lint\n", "    uses: ./.github/workflows/other.yml\n"), "other.yml": "on: workflow_call\n" }), []);
});

test("rule 2: only the allowed triggers, and triggers it can't read fail", () => {
  assert.deepEqual(ALLOWED_TRIGGERS, ["workflow_call", "workflow_dispatch", "push", "schedule"]);
  for (const event of ["issue_comment", "workflow_run", "issues", "release"]) {
    assert.deepEqual(workflowProblems({ "journeys.yml": journeys(`  workflow_call:\n  ${event}:\n`) }), [
      `journeys.yml: names production-journeys, so it may only be started by workflow_call, workflow_dispatch, push, schedule (has ${event})`,
    ]);
  }
  assert.match(workflowProblems({ "journeys.yml": "jobs:\n  x:\n    environment: production-journeys\n" })[0], /triggers \(on:\) aren't a name, a list or a map/);
  assert.match(workflowProblems({ "journeys.yml": journeys().replace(/on:\n[\s\S]*?jobs:/, "on: [push, {x: 1}]\njobs:") })[0], /aren't a name, a list or a map/);
  // YAML 1.1 reads `on` as true: then there's no `on` key, which fails too
  assert.match(workflowProblems({ "journeys.yml": `%YAML 1.1\n---\n${journeys()}` }).join("\n"), /aren't a name, a list or a map/);
  // Workflows that don't reach it may have any trigger
  assert.deepEqual(workflowProblems({ "x.yml": "on: [issue_comment, pull_request_target]\n" }), []);
});

test("rule 3: no environment from an expression, in any form", () => {
  const env = (value) => `on: pull_request_target\njobs:\n  x:\n    runs-on: ubuntu-latest\n    environment: ${value}\n`;
  for (const text of [
    env("${{ github.head_ref }}"),
    env(">-\n      ${{ github.head_ref }}"),
    env("|\n      ${{ github.head_ref }}"),
    env("\"${{ github.head_ref }}\""),
    "on: workflow_dispatch\njobs:\n  x:\n    environment:\n      name: ${{ inputs.env }}\n      url: https://example.test\n",
    "on: workflow_dispatch\njobs:\n  x:\n    \"environment\":\n      \"name\": ${{ inputs.env }}\n",
    "on: workflow_dispatch\nenv:\n  e: &e ${{ github.head_ref }}\njobs:\n  x:\n    environment: *e\n",
  ]) {
    assert.deepEqual(workflowProblems({ "x.yml": text }), ["x.yml: job x sets its environment from an expression; name the environment literally"], text);
  }
  assert.deepEqual(workflowProblems({ "x.yml": "on: push\njobs:\n  x:\n    environment: [a]\n" }), ["x.yml: job x's environment isn't a name or a map with a name"]);
  assert.deepEqual(workflowProblems({ "x.yml": "on: push\njobs:\n  x:\n    environment:\n      name: production\n      url: ${{ steps.x.outputs.url }}\n  y:\n    name: ${{ inputs.x }}\n" }), []);
  assert.deepEqual(workflowProblems({ "x.yml": "on: push\njobs:\n  x:\n    environment: production # not ${{ x }}\n" }), []);
});

test("rule 4: no remote-reference calls into this repository", () => {
  for (const ref of [
    "davetashner/supply-checkout/.github/workflows/journeys.yml@main",
    "DaveTashner/Supply-Checkout/.github/workflows/journeys.yml@some-branch",
    "davetashner/supply-checkout/.github/actions/x@v1",
  ]) {
    const text = `on: pull_request_target\njobs:\n  j:\n    uses: ${ref}\n  k:\n    runs-on: x\n    steps:\n      - uses: ${ref}\n`;
    const problems = workflowProblems({ "pr.yml": text });
    assert.deepEqual(problems, [
      `pr.yml: calls ${ref} by a remote reference; call this repository's workflows as ./.github/workflows/<file>`,
      `pr.yml: calls ${ref} by a remote reference; call this repository's workflows as ./.github/workflows/<file>`,
    ], ref);
  }
  // Other repositories' actions and workflows are fine; so is another repository through --repo
  assert.deepEqual(workflowProblems({ "x.yml": "on: push\njobs:\n  j:\n    uses: other/repo/.github/workflows/w.yml@v1\n  k:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@abc\n" }), []);
  assert.deepEqual(remoteCalls(parsed("jobs:\n  j:\n    uses: o/r/.github/workflows/w.yml@x\n"), "o/r"), ["o/r/.github/workflows/w.yml@x"]);
});

test("unparseable YAML fails", () => {
  for (const text of ["on: [push\n", "on: push\non: pull_request\n", "on: push\njobs: *nope\n", "- a\n- b\n", "on: push\n---\non: pull_request\n"]) {
    assert.match(workflowProblems({ "x.yml": text })[0], /^x\.yml: can't be read as a workflow \(/, text);
  }
  // Still caught by the raw-text tripwire when it names the environment
  assert.deepEqual(workflowProblems({ "x.yml": "on: [push\nenvironment: production-journeys\n" }).length, 2);
});

test("reading triggers and calls", () => {
  assert.deepEqual(triggers(parsed("on: push\n")), ["push"]);
  assert.deepEqual(triggers(parsed("'on': [push, \"workflow_dispatch\"]\n")), ["push", "workflow_dispatch"]);
  assert.deepEqual(triggers(parsed("name: x\non:\n  # comment\n  push:\n    branches: [main]\n\n  schedule:\n    - cron: x\njobs: {}\n")), ["push", "schedule"]);
  assert.equal(triggers(parsed("on:\njobs:\n")), null);
  const w = parsed("jobs:\n  a:\n    uses: ./.github/workflows/a.yml\n  b:\n    uses: ' ./.github/workflows/c.yaml@v1'\n  c:\n    steps:\n      - uses: ./.github/actions/x\n      - run: y\n  d: 3\n");
  assert.deepEqual(uses(w), ["./.github/workflows/a.yml", " ./.github/workflows/c.yaml@v1", "./.github/actions/x"]);
  assert.deepEqual(calls(w), ["a.yml", "c.yaml"]);
  assert.deepEqual(uses(parsed("on: push\n")), []);
});

test("this repository's workflows pass, and the command says so", () => {
  const workflows = readWorkflows(path.join(root, ".github", "workflows"));
  assert.ok(Object.keys(workflows).includes("ci.yml"));
  assert.deepEqual(workflowProblems(workflows), []);
  assert.match(execFileSync(process.execPath, [script], { encoding: "utf8" }), /^check-workflow-environments: \d+ workflows; /);
});

test("CI runs it", () => {
  const ciYml = readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ciYml, /- run: node scripts\/check-workflow-environments\.mjs/);
});
