// node --test scripts/journeys/test/ (part of npm run test:scripts): the journeys workflow's own
// steps, checking the secrets before signing in and passing the failed steps to the deploy.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { activeRuns, main, outputLines, parseWaitArgs, secretProblems, waitForProd } from "../workflow.mjs";
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("usage", () => {
  for (const argv of [[], ["frob"], ["check-secrets", "x"], ["outputs"], ["outputs", "a", "b"]]) assert.throws(() => main(argv, {}), /Usage/);
});

const runs = (list) => ({ workflow_runs: list });

test("wait-for-prod: arguments", () => {
  assert.deepEqual(parseWaitArgs(["--repo", "o/r", "--run", "9", "--manual"]), { repo: "o/r", run: "9", mode: "manual", wait: 1800 });
  assert.equal(parseWaitArgs(["--deploy", "--repo", "o/r", "--run", "9", "--wait-seconds", "60"]).wait, 60);
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

test("wait-for-prod --deploy: waits for a run by hand, then gives up", async () => {
  let t = 0;
  let calls = 0;
  const lines = [];
  const api = (p) => { assert.match(p, /workflows\/journeys\.yml\/runs/); calls++; return runs(calls < 3 ? [{ id: 7, status: "in_progress" }] : []); };
  const deps = { api, log: (l) => lines.push(l), sleep: async (ms) => { t += ms; }, now: () => t };
  assert.equal(await waitForProd(["--repo", "o/r", "--run", "9", "--deploy"], deps), 0);
  assert.equal(calls, 3);
  assert.equal(lines.filter((l) => l.startsWith("Waiting")).length, 2);
  t = 0;
  lines.length = 0;
  const stuck = { ...deps, api: () => runs([{ id: 7, status: "in_progress" }]) };
  assert.equal(await waitForProd(["--repo", "o/r", "--run", "9", "--deploy", "--wait-seconds", "60"], stuck), 1);
  assert.match(lines.at(-1), /^::error::A run of the journey tests by hand is still going after 60 seconds/);
});
