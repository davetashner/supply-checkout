// node --test scripts/journeys/test/ (part of npm run test:scripts): the journeys workflow's own
// steps, checking the secrets before signing in and passing the failed steps to the deploy.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  SUITE_JOB, SUITE_STEP, VERDICT_ARTIFACT, activeRuns, cancelRuns, follow, isLiveDeploy, main, outputLines, parseFollowArgs, parseWaitArgs, runName, runsTitled,
  secretProblems, suiteOutcome, waitForProd,
} from "../workflow.mjs";
import { fakeEnv } from "./helpers.mjs";

test("check-secrets: names the missing or malformed variables, never their values", () => {
  assert.deepEqual(secretProblems(fakeEnv()), []);
  const env = fakeEnv({ JOURNEYS_OWNER_PASSWORD: "", JOURNEYS_OWNER_TOTP: "not base32 at all!" });
  const problems = secretProblems(env);
  assert.ok(problems.length >= 2);
  for (const p of problems) assert.match(p, /^::error::/);
  assert.ok(problems.some((p) => p.includes("JOURNEYS_OWNER_PASSWORD is not set")));
  assert.ok(problems.some((p) => p.includes("JOURNEYS_OWNER_TOTP must be a base32 secret")));
  for (const p of problems) for (const v of Object.values(fakeEnv())) assert.ok(!p.includes(v), "a value was printed");

  const lines = [];
  assert.equal(main(["check-secrets"], fakeEnv(), (l) => lines.push(l)), 0);
  assert.deepEqual(lines, ["Every journeys secret is set"]);
  lines.length = 0;
  assert.equal(main(["check-secrets"], {}, (l) => lines.push(l)), 1);
  assert.ok(lines.length > 1 && lines.every((l) => l.startsWith("::error::")));
});

test("outputs: only well-formed step entries reach the deploy", () => {
  assert.equal(outputLines({ failed: ["J4.2 (desktop-chrome)", "J13.4 (iphone-safari)"], critical: ["J4.2 (desktop-chrome)"] }), "failed=J4.2 (desktop-chrome), J13.4 (iphone-safari)\ncritical=J4.2 (desktop-chrome)\n");
  assert.equal(outputLines({ failed: ["J4.2 (desktop-chrome)\ncritical=x", "J4.2 (firefox)", 7, "J4.2 (desktop-chrome)"], critical: "J1.1 (desktop-chrome)" }), "failed=J4.2 (desktop-chrome)\ncritical=\n");
  assert.equal(outputLines(null), "failed=\ncritical=\n");

  const dir = mkdtempSync(path.join(tmpdir(), "journeys-workflow-"));
  try {
    const out = path.join(dir, "out");
    writeFileSync(out, "");
    const file = path.join(dir, "verdict.json");
    // No verdict file (the suite didn't start): nothing written
    assert.equal(main(["outputs", file], { GITHUB_OUTPUT: out }), 0);
    assert.equal(readFileSync(out, "utf8"), "");
    writeFileSync(file, JSON.stringify({ ok: false, failed: ["J0.2 (iphone-safari)"], flaky: [], critical: ["J0.2 (iphone-safari)"] }));
    assert.equal(main(["outputs", file], { GITHUB_OUTPUT: out }), 0);
    assert.equal(readFileSync(out, "utf8"), "failed=J0.2 (iphone-safari)\ncritical=J0.2 (iphone-safari)\n");
    assert.throws(() => main(["outputs", file], {}), /GITHUB_OUTPUT isn't set/);
    // From another run (the deploy reads the dispatched run's artifact): too big, or not JSON, is refused
    writeFileSync(file, " ".repeat(1024 * 1024 + 1));
    assert.throws(() => main(["outputs", file], { GITHUB_OUTPUT: out }), /over 1048576 bytes/);
    writeFileSync(file, "failed=J1.1 (desktop-chrome)");
    assert.throws(() => main(["outputs", file], { GITHUB_OUTPUT: out }), SyntaxError);
    // A folder in the verdict file's place is refused, not read
    const folder = path.join(dir, "folder.json");
    mkdirSync(folder);
    assert.throws(() => main(["outputs", folder], { GITHUB_OUTPUT: out }), /folder\.json isn't a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage", () => {
  for (const argv of [[], ["frob"], ["check-secrets", "x"], ["outputs"], ["outputs", "a", "b"]]) assert.throws(() => main(argv, {}), /Usage/);
  assert.throws(() => main(["follow", "--repo", "o/r"], {}), /GITHUB_OUTPUT isn't set/);
});

const runs = (list) => ({ workflow_runs: list });

test("wait-for-prod: arguments", () => {
  assert.deepEqual(parseWaitArgs(["--repo", "o/r", "--run", "9", "--manual"]), { repo: "o/r", run: "9", mode: "manual", wait: 1800 });
  assert.deepEqual(parseWaitArgs(["--deploy", "--deploy-run", "5-2", "--repo", "o/r", "--run", "9", "--wait-seconds", "60"]), { repo: "o/r", run: "9", mode: "deploy", deployRun: "5-2", wait: 60 });
  assert.throws(() => parseWaitArgs(["--repo", "o/r", "--run", "9", "--deploy"]), /--deploy needs --deploy-run/);
  for (const bad of ["5", "5-", "-2", "5-2-1", "5-2; rm", "x-1"]) assert.throws(() => parseWaitArgs(["--repo", "o/r", "--run", "9", "--deploy", "--deploy-run", bad]), /--deploy needs --deploy-run/, bad);
  assert.throws(() => parseWaitArgs(["--repo", "o/r", "--run", "9", "--manual", "--deploy-run", "5-1"]), /goes with --deploy only/);
  assert.throws(() => parseWaitArgs(["--repo", "o/r", "--run", "9"]), /Pick one/);
  assert.throws(() => parseWaitArgs(["--repo", "o/r", "--run", "9", "--manual", "--deploy"]), /Pick one/);
  assert.throws(() => parseWaitArgs(["--repo", "o/r/x", "--run", "9", "--manual"]), /--repo/);
  assert.throws(() => parseWaitArgs(["--repo", "o/r", "--run", "x", "--manual"]), /--run/);
  assert.throws(() => parseWaitArgs(["--repo", "o/r", "--run", "9", "--manual", "--wait-seconds", "soon"]), /Unknown or incomplete argument --wait-seconds/);
  assert.throws(() => parseWaitArgs(["--frob"]), /Unknown or incomplete/);
});

test("wait-for-prod: active runs leave out completed ones and this run", () => {
  const api = (p) => { assert.equal(p, "repos/o/r/actions/workflows/deploy.yml/runs?per_page=100"); return runs([{ id: 1, status: "completed" }, { id: 2, status: "waiting" }, { id: 9, status: "in_progress" }, { id: 3, status: "queued" }]); };
  assert.deepEqual(activeRuns(api, "o/r", "deploy.yml", "9"), ["2 (waiting)", "3 (queued)"]);
  assert.deepEqual(activeRuns(() => null, "o/r", "deploy.yml", "9"), []);
});

test("wait-for-prod --manual: refuses while a deploy is going", async () => {
  const lines = [];
  const busy = () => runs([{ id: 5, status: "waiting" }]);
  assert.equal(await waitForProd(["--repo", "o/r", "--run", "9", "--manual"], { api: busy, log: (l) => lines.push(l) }), 1);
  assert.match(lines[0], /^::error::A deploy is running or waiting \(runs 5 \(waiting\)\)/);
  assert.equal(await waitForProd(["--repo", "o/r", "--run", "9", "--manual"], { api: () => runs([{ id: 5, status: "completed" }]) }), 0);
});

const liveDeploy = { id: 5, path: ".github/workflows/deploy.yml", head_branch: "main", status: "in_progress" };
const deployArgs = ["--repo", "o/r", "--run", "9", "--deploy", "--deploy-run", "5-1"];

test("wait-for-prod --deploy: waits for any other journeys run, then gives up", async () => {
  let t = 0;
  let calls = 0;
  const lines = [];
  const api = (p) => {
    if (p === "repos/o/r/actions/runs/5") return liveDeploy;
    assert.match(p, /workflows\/journeys\.yml\/runs/);
    calls++;
    return runs(calls < 3 ? [{ id: 7, status: "in_progress" }] : []);
  };
  const deps = { api, log: (l) => lines.push(l), sleep: async (ms) => { t += ms; }, now: () => t };
  assert.equal(await waitForProd(deployArgs, deps), 0);
  assert.equal(calls, 3);
  assert.equal(lines.filter((l) => l.startsWith("Waiting")).length, 2);
  t = 0;
  lines.length = 0;
  const stuck = { ...deps, api: (p) => (p.endsWith("/runs/5") ? liveDeploy : runs([{ id: 7, status: "in_progress" }])) };
  assert.equal(await waitForProd([...deployArgs, "--wait-seconds", "60"], stuck), 1);
  assert.match(lines.at(-1), /^::error::Another run of the journey tests is still going after 60 seconds/);
});

test("wait-for-prod --deploy: refuses unless the deploy run it names is a deploy of main still going", async () => {
  assert.equal(isLiveDeploy(liveDeploy), true);
  assert.equal(isLiveDeploy({ ...liveDeploy, path: ".github/workflows/deploy.yml@refs/heads/main" }), true);
  for (const run of [null, { ...liveDeploy, status: "completed" }, { ...liveDeploy, head_branch: "feature" }, { ...liveDeploy, path: ".github/workflows/ci.yml" }, { ...liveDeploy, path: 7 }]) {
    assert.equal(isLiveDeploy(run), false, JSON.stringify(run));
    const lines = [];
    const seen = [];
    assert.equal(await waitForProd(deployArgs, { api: (p) => { seen.push(p); return run; }, log: (l) => lines.push(l) }), 1);
    assert.deepEqual(seen, ["repos/o/r/actions/runs/5"]);
    assert.match(lines[0], /^::error::This run says deploy run 5 started it, but that isn't a deploy of main that's still going/);
  }
});

test("follow: arguments", () => {
  assert.deepEqual(parseFollowArgs(["--repo", "o/r", "--tag", "v1.2.3", "--deploy-run", "5-1"]), { repo: "o/r", tag: "v1.2.3", deployRun: "5-1", find: 300, wait: 5700 });
  assert.deepEqual(parseFollowArgs(["--deploy-run", "5-1", "--tag", "v1.2.3", "--repo", "o/r", "--find-seconds", "10", "--wait-seconds", "20"]).wait, 20);
  assert.throws(() => parseFollowArgs(["--repo", "o/r", "--tag", "1.2.3", "--deploy-run", "5-1"]), /--tag/);
  assert.throws(() => parseFollowArgs(["--repo", "o/r", "--tag", "v1.2.3", "--deploy-run", "5"]), /--deploy-run/);
  assert.throws(() => parseFollowArgs(["--repo", "o", "--tag", "v1.2.3", "--deploy-run", "5-1"]), /--repo/);
  assert.throws(() => parseFollowArgs(["--repo", "o/r", "--repo", "x/y"]), /Unknown or incomplete argument --repo/);
  assert.throws(() => parseFollowArgs(["--repo"]), /Unknown or incomplete/);
  assert.throws(() => parseFollowArgs(["--wait-seconds", "soon"]), /Unknown or incomplete/);
  assert.equal(runName("v1.2.3", "5-1"), "Journeys after deploying v1.2.3 (deploy run 5-1)");
});

const title = runName("v1.2.3", "5-1");
const dispatched = (over = {}) => ({ id: 42, display_title: title, head_branch: "main", event: "workflow_dispatch", status: "queued", ...over });

test("follow: finds its run only by its exact title, among main's workflow_dispatch runs", () => {
  const seen = [];
  const api = (p) => { seen.push(p); return runs([
    dispatched(),
    dispatched({ id: 43, display_title: runName("v1.2.3", "5-2") }),
    dispatched({ id: 44, head_branch: "feature" }),
    dispatched({ id: 45, event: "push" }),
    dispatched({ id: "46" }),
    dispatched({ id: -1 }),
    null,
    { id: 47, display_title: "Journeys" },
  ]); };
  assert.deepEqual(runsTitled(api, "o/r", title), [{ id: 42, status: "queued" }]);
  assert.deepEqual(seen, ["repos/o/r/actions/workflows/journeys.yml/runs?event=workflow_dispatch&branch=main&per_page=100"]);
  assert.deepEqual(runsTitled(() => ({ workflow_runs: "x" }), "o/r", title), []);
  assert.deepEqual(runsTitled(() => null, "o/r", title), []);
});

test("follow: the suite step's outcome from the run's jobs", () => {
  const jobs = (steps, name = SUITE_JOB) => ({ jobs: [{ name: "Check the journey tests are set up", steps: [{ name: SUITE_STEP, conclusion: "failure" }] }, { name, steps }] });
  for (const outcome of ["success", "failure", "cancelled", "skipped"]) assert.equal(suiteOutcome(jobs([{ name: "Install dependencies", conclusion: "success" }, { name: SUITE_STEP, conclusion: outcome }])), outcome);
  assert.equal(suiteOutcome(jobs([{ name: SUITE_STEP, conclusion: null }])), "");
  assert.equal(suiteOutcome(jobs([{ name: SUITE_STEP, conclusion: "failure\nsuite=success" }])), "");
  assert.equal(suiteOutcome(jobs([{ name: "Check the environment's secrets", conclusion: "failure" }])), "");
  assert.equal(suiteOutcome(jobs([{ name: SUITE_STEP, conclusion: "success" }], "Something else")), "");
  assert.equal(suiteOutcome(jobs("x")), "");
  assert.equal(suiteOutcome(null), "");
});

/** A fake API for one dispatched run: `finds` lists to answer the run search with, then `statuses`, then `jobs`. */
const fakeRun = ({ finds = [[dispatched()]], statuses = [{ status: "completed", conclusion: "success" }], jobs = { jobs: [] } } = {}) => {
  const seen = [];
  let f = 0;
  let st = 0;
  const api = (p, opts) => {
    seen.push(opts?.method ? `${opts.method} ${p}` : p);
    if (p.includes("/workflows/journeys.yml/runs")) return runs(finds[Math.min(f++, finds.length - 1)]);
    if (p.endsWith("/jobs?per_page=100")) return jobs;
    if (p.endsWith("/cancel")) return null;
    if (/\/actions\/runs\/\d+$/.test(p)) return statuses[Math.min(st++, statuses.length - 1)];
    throw new Error(`unexpected ${p}`);
  };
  return { api, seen };
};
const followArgs = ["--repo", "o/r", "--tag", "v1.2.3", "--deploy-run", "5-1"];
const clock = () => { let t = 0; return { sleep: async (ms) => { t += ms; }, now: () => t }; };

test("follow: waits for the run to show up and to finish, and writes the suite's outcome", async () => {
  const jobs = { jobs: [{ name: SUITE_JOB, steps: [{ name: SUITE_STEP, conclusion: "success" }] }] };
  const { api, seen } = fakeRun({ finds: [[], [], [dispatched()]], statuses: [{ status: "queued" }, { status: "in_progress" }, { status: "completed", conclusion: "success" }], jobs });
  const out = [];
  const lines = [];
  assert.equal(await follow(followArgs, { api, output: (l) => out.push(l), log: (l) => lines.push(l), ...clock() }), 0);
  assert.deepEqual(out.join(""), "run-id=42\nrun-url=https://github.com/o/r/actions/runs/42\nsuite=success\nconclusion=success\n");
  assert.equal(seen.filter((p) => p.includes("/workflows/")).length, 3);
  assert.equal(seen.filter((p) => p === "repos/o/r/actions/runs/42").length, 3);
  assert.ok(seen.includes("repos/o/r/actions/runs/42/jobs?per_page=100"));
  assert.match(lines.at(-1), /run 42 finished: success \(the suite step: success\)/);
});

test("follow: a failed suite, or a run that failed before it, fails the job with the suite's outcome", async () => {
  const failed = { jobs: [{ name: SUITE_JOB, steps: [{ name: SUITE_STEP, conclusion: "failure" }] }] };
  for (const [jobs, conclusion, suite] of [[failed, "failure", "failure"], [{ jobs: [] }, "failure", ""], [{ jobs: [] }, "cancelled", ""], [{ jobs: [] }, "weird\nsuite=success", ""]]) {
    const { api } = fakeRun({ statuses: [{ status: "completed", conclusion }], jobs });
    const out = [];
    const lines = [];
    assert.equal(await follow(followArgs, { api, output: (l) => out.push(l), log: (l) => lines.push(l), ...clock() }), 1);
    const written = out.join("");
    assert.match(written, new RegExp(`\nsuite=${suite}\n`));
    assert.match(written, new RegExp(`\nconclusion=${conclusion.includes("\n") ? "unknown" : conclusion}\n$`));
    assert.match(lines.at(-1), /^::error::The journey tests' run 42 ended /);
  }
});

test("follow: no run, or two, with its title is refused; a run that doesn't finish is cancelled", async () => {
  let { api } = fakeRun({ finds: [[]] });
  let out = [];
  const lines = [];
  assert.equal(await follow([...followArgs, "--find-seconds", "30"], { api, output: (l) => out.push(l), log: (l) => lines.push(l), ...clock() }), 1);
  assert.deepEqual(out, ["suite=\n"]);
  assert.match(lines.at(-1), /^::error::The journey tests' run for this deploy \("Journeys after deploying v1\.2\.3 \(deploy run 5-1\)"\) didn't show up within 30 seconds/);

  ({ api } = fakeRun({ finds: [[dispatched(), dispatched({ id: 43 })]] }));
  out = [];
  assert.equal(await follow(followArgs, { api, output: (l) => out.push(l), log: (l) => lines.push(l), ...clock() }), 1);
  assert.deepEqual(out, ["suite=\n"]);
  assert.match(lines.at(-1), /^::error::2 runs of the journey tests are titled .* \(runs 42, 43\)/);

  const stuck = fakeRun({ statuses: [{ status: "in_progress" }] });
  out = [];
  assert.equal(await follow([...followArgs, "--wait-seconds", "60"], { api: stuck.api, output: (l) => out.push(l), log: (l) => lines.push(l), ...clock() }), 1);
  assert.ok(stuck.seen.includes("POST repos/o/r/actions/runs/42/cancel"));
  assert.equal(out.at(-1), "suite=\n");
  assert.match(lines.at(-1), /didn't finish within 60 seconds: cancelling it/);
});

test("cancel: cancels only this deploy's unfinished runs", () => {
  const { api, seen } = fakeRun({ finds: [[dispatched({ status: "in_progress" }), dispatched({ id: 43, status: "completed" }), dispatched({ id: 44, display_title: "Journeys" })]] });
  const lines = [];
  assert.equal(cancelRuns(followArgs, { api, log: (l) => lines.push(l) }), 0);
  assert.deepEqual(seen.filter((p) => p.startsWith("POST")), ["POST repos/o/r/actions/runs/42/cancel"]);
  assert.deepEqual(lines, ["Cancelled the journey tests' run 42"]);
  const none = fakeRun({ finds: [[]] });
  assert.equal(cancelRuns(followArgs, { api: none.api, log: (l) => lines.push(l) }), 0);
  assert.equal(lines.at(-1), "No unfinished run of the journey tests to cancel");
});

test("follow and cancel through main", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "journeys-follow-"));
  try {
    const out = path.join(dir, "out");
    writeFileSync(out, "");
    const { api } = fakeRun();
    assert.equal(await main(["follow", ...followArgs, "--find-seconds", "0"], { GITHUB_OUTPUT: out }, () => {}, api), 0);
    assert.match(readFileSync(out, "utf8"), /^run-id=42\n/);
    assert.equal(main(["cancel", ...followArgs], {}, () => {}, fakeRun({ finds: [[]] }).api), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in step with journeys.yml and deploy.yml: the names follow reads, the run-name, the inputs", () => {
  const read = (f) => readFileSync(fileURLToPath(new URL(`../../../.github/workflows/${f}`, import.meta.url)), "utf8");
  const journeys = parse(read("journeys.yml"));
  assert.equal(journeys.jobs.suite.name, SUITE_JOB);
  assert.equal(journeys.jobs.suite.steps.filter((s) => s.name === SUITE_STEP).length, 1);
  assert.equal(journeys.jobs.suite.steps.find((s) => s.name === SUITE_STEP).id, "suite");
  assert.ok(Object.values(journeys.jobs).every((j) => j.name !== SUITE_JOB || j === journeys.jobs.suite));
  assert.equal(journeys.jobs.results.steps.find((s) => String(s.uses).startsWith("actions/upload-artifact@")).with.name, VERDICT_ARTIFACT);
  assert.equal(journeys["run-name"], "${{ inputs.deploy-run && format('Journeys after deploying {0} (deploy run {1})', inputs.tag, inputs.deploy-run) || 'Journeys' }}");
  assert.equal(runName("{0}", "{1}"), "Journeys after deploying {0} (deploy run {1})");
  assert.deepEqual(Object.keys(journeys.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(journeys.on.workflow_dispatch.inputs), ["tag", "deploy-run"]);
  const deploy = parse(read("deploy.yml")).jobs.journeys;
  const runs = deploy.steps.map((s) => s.run ?? "").join("\n");
  assert.match(runs, /gh workflow run journeys\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f tag="\$TAG" -f deploy-run="\$DEPLOY_RUN"/);
  assert.match(runs, /workflow\.mjs follow --repo "\$GITHUB_REPOSITORY" --tag "\$TAG" --deploy-run "\$DEPLOY_RUN"/);
  assert.equal(deploy.env.DEPLOY_RUN, "${{ github.run_id }}-${{ github.run_attempt }}");
  assert.equal(deploy.steps.find((s) => String(s.uses).startsWith("actions/download-artifact@")).with.name, VERDICT_ARTIFACT);
  assert.deepEqual(deploy.permissions, { contents: "read", actions: "write" });
  assert.equal(deploy.uses, undefined);
});

test("follow: a few API failures in a row while polling are retried, more are not", async () => {
  const { api } = fakeRun({ statuses: [{ status: "in_progress" }, { status: "completed", conclusion: "success" }] });
  let fails = 2;
  const flaky = (p, o) => { if (p === "repos/o/r/actions/runs/42" && fails-- > 0) throw new Error("HTTP 502\nmore"); return api(p, o); };
  const lines = [];
  assert.equal(await follow(followArgs, { api: flaky, output: () => {}, log: (l) => lines.push(l), ...clock() }), 0);
  assert.deepEqual(lines.filter((l) => l.startsWith("::warning::")), [
    "::warning::GitHub's API failed (1 in a row; trying again): HTTP 502",
    "::warning::GitHub's API failed (2 in a row; trying again): HTTP 502",
  ]);
  const down = () => { throw new Error("HTTP 500"); };
  await assert.rejects(follow(followArgs, { api: down, output: () => {}, log: () => {}, ...clock() }), /HTTP 500/);
});
