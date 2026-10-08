// node --test scripts/release-verdict.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RUNBOOK, main, parseArgs, parseList, verdict, withNote } from "./release-verdict.mjs";

const RUN = "https://github.com/o/r/actions/runs/123";
const base = ["--repo", "o/r", "--tag", "v1.2.3", "--run-url", RUN];

test("lists: only step and browser entries", () => {
  assert.deepEqual(parseList("", "failed"), []);
  assert.deepEqual(parseList(undefined, "failed"), []);
  assert.deepEqual(parseList("J4.2 (desktop-chrome), J13.4 (iphone-safari),J4.2 (desktop-chrome)", "failed"), ["J4.2 (desktop-chrome)", "J13.4 (iphone-safari)"]);
  for (const bad of ["J4.2", "J4.2 (firefox)", "J4.2 (desktop-chrome) <img>", "[x](https://evil)", "J4.2 (desktop-chrome)\nmore"]) {
    assert.throws(() => parseList(bad, "failed"), /--failed must list steps like/, bad);
  }
});

test("the verdict: pass, fail (with and without steps, critical), or nothing", () => {
  const pass = verdict({ suite: "success", runUrl: RUN, tag: "v1.2.3" });
  assert.equal(pass.action, "pass");
  assert.equal(pass.prerelease, false);
  assert.equal(pass.note, `**Journey tests passed in prod** for v1.2.3: ${RUN}`);

  const fail = verdict({ suite: "failure", failed: ["J4.2 (desktop-chrome)", "J6.1 (iphone-safari)"], critical: ["J4.2 (desktop-chrome)"], runUrl: RUN, tag: "v1.2.3" });
  assert.equal(fail.action, "fail");
  assert.equal(fail.prerelease, true);
  assert.match(fail.note, /^\*\*Journey tests failed in prod\*\* for v1\.2\.3: J4\.2 \(desktop-chrome\), J6\.1 \(iphone-safari\)\. https:/);
  assert.match(fail.note, /allow-bad-release/);
  assert.ok(fail.note.includes(`**Critical journeys failed** (J4.2 (desktop-chrome)): a P1, follow \`${RUNBOOK}\`.`));

  const early = verdict({ suite: "failure", runUrl: RUN, tag: "v1.2.3" });
  assert.match(early.note, /the suite failed before any test finished/);
  assert.doesNotMatch(early.note, /Critical/);

  for (const suite of ["", "skipped", "cancelled"]) assert.deepEqual(verdict({ suite, runUrl: RUN, tag: "v1.2.3" }), { action: "none", prerelease: false, note: "" });
});

test("the note goes at the end of the notes", () => {
  assert.equal(withNote("## Changes\n\n- a\n\n", "N"), "## Changes\n\n- a\n\nN\n");
  assert.equal(withNote("", "N"), "N\n");
  assert.equal(withNote(null, "N"), "N\n");
});

test("arguments: refused before anything changes", () => {
  assert.deepEqual(parseArgs([...base, "--suite", "failure", "--failed", "J1.1 (desktop-chrome)"]), {
    repo: "o/r", tag: "v1.2.3", runUrl: RUN, suite: "failure", failed: ["J1.1 (desktop-chrome)"], critical: [],
  });
  assert.equal(parseArgs([...base, "--suite", ""]).suite, "");
  assert.throws(() => parseArgs([...base]), /--suite is required/);
  assert.throws(() => parseArgs(["--repo", "o/r/x", "--tag", "v1.2.3", "--run-url", RUN, "--suite", "x"]), /--repo must be owner\/name/);
  assert.throws(() => parseArgs(["--repo", "o/r", "--tag", "main", "--run-url", RUN, "--suite", "x"]), /--tag must look like v1\.2\.3/);
  assert.throws(() => parseArgs(["--repo", "o/r", "--tag", "v1.2.3", "--run-url", "https://evil.example/x", "--suite", "x"]), /--run-url must be/);
  assert.throws(() => parseArgs([...base, "--suite", "x", "--suite", "y"]), /Unknown or incomplete argument --suite/);
  assert.throws(() => parseArgs([...base, "--frob", "x"]), /Unknown or incomplete argument --frob/);
  assert.throws(() => parseArgs([...base, "--suite"]), /Unknown or incomplete argument --suite/);
  assert.throws(() => parseArgs([...base, "--suite", "failure", "--critical", "nope"]), /--critical must list/);
});

function fakeGh(body = "Notes") {
  const calls = [];
  const notes = [];
  const run = (cmd, args) => {
    assert.equal(cmd, "gh");
    calls.push(args);
    const i = args.indexOf("--notes-file");
    if (i >= 0) notes.push(readFileSync(args[i + 1], "utf8"));
    return args[1] === "view" ? JSON.stringify({ body }) : "";
  };
  return { run, calls, notes };
}

test("main: a failure appends the note and marks a pre-release", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "verdict-test-"));
  try {
    const summary = path.join(dir, "summary.md");
    const gh = fakeGh("## 1.2.3");
    const v = main([...base, "--suite", "failure", "--failed", "J4.2 (desktop-chrome)", "--critical", "J4.2 (desktop-chrome)"], { run: gh.run, env: { GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir } });
    assert.equal(v.action, "fail");
    assert.deepEqual(gh.calls[0], ["release", "view", "v1.2.3", "--repo", "o/r", "--json", "body"]);
    assert.deepEqual(gh.calls[1].slice(0, 5), ["release", "edit", "v1.2.3", "--repo", "o/r"]);
    assert.equal(gh.calls[1].at(-1), "--prerelease");
    assert.match(gh.notes[0], /^## 1\.2\.3\n\n\*\*Journey tests failed in prod\*\*/);
    assert.match(readFileSync(summary, "utf8"), /v1\.2\.3 is now a pre-release/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main: a pass appends the note and leaves the pre-release flag alone", () => {
  const gh = fakeGh();
  main([...base, "--suite", "success"], { run: gh.run, env: {} });
  assert.equal(gh.calls.length, 2);
  assert.ok(!gh.calls[1].includes("--prerelease"));
  assert.match(gh.notes[0], /^Notes\n\n\*\*Journey tests passed in prod\*\*/);
});

test("main: a suite that didn't finish changes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "verdict-test-"));
  try {
    const summary = path.join(dir, "summary.md");
    const gh = fakeGh();
    for (const suite of ["", "skipped", "cancelled"]) assert.equal(main([...base, "--suite", suite], { run: gh.run, env: { GITHUB_STEP_SUMMARY: summary } }).action, "none");
    assert.equal(gh.calls.length, 0);
    assert.match(readFileSync(summary, "utf8"), /left as it is/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
