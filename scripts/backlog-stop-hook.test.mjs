// Tests for scripts/backlog-stop-hook.mjs and `npm run backlog:published`:
// npm run test:scripts
//
// Each test runs the hook in a throwaway git repo (the "main checkout", with a
// worktree) against a fake `bd` that answers from $FAKE_BEADS, so nothing
// touches the real beads database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const hook = new URL("./backlog-stop-hook.mjs", import.meta.url).pathname;
const pageScript = new URL("./backlog-page.mjs", import.meta.url).pathname;

const tmp = mkdtempSync(join(tmpdir(), "backlog-stop-hook-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// bd list/ready/blocked print the JSON in $FAKE_BEADS; bd export prints one
// line per bead; $FAKE_BD_FAIL makes every call fail
const bin = join(tmp, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "bd"), `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.FAKE_BD_FAIL) { console.error("bd: database not found"); process.exit(1); }
const beads = JSON.parse(fs.readFileSync(process.env.FAKE_BEADS, "utf8"));
const cmd = process.argv[2];
if (cmd === "export") process.stdout.write(beads.all.map((b) => JSON.stringify(b)).join("\\n") + "\\n");
else if (cmd === "list") console.log(JSON.stringify(beads.all));
else console.log(JSON.stringify(beads[cmd] || []));
`);
chmodSync(join(bin, "bd"), 0o755);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "" };

let n = 0;
// A main checkout whose committed export matches the fake bd, and a worktree
function repo() {
  const dir = join(tmp, `repo-${++n}`);
  mkdirSync(join(dir, ".beads"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  const beads = { all: [{ id: "supply-checkout-a", title: "One", status: "open", priority: 1 }], ready: [], blocked: [] };
  const fake = join(dir, ".fake-beads.json");
  writeFileSync(fake, JSON.stringify(beads));
  writeFileSync(join(dir, ".beads", "issues.jsonl"), beads.all.map((b) => JSON.stringify(b)).join("\n") + "\n");
  git(dir, "add", ".beads");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "worktree", "add", "-q", join(dir, ".claude", "worktrees", "feat", "x"), "-b", "feat/x");
  const page = join(dir, "dist", "backlog", "index.html");
  return {
    dir, page, fake, worktree: join(dir, ".claude", "worktrees", "feat", "x"),
    // Changes a bead in the database (not the committed export)
    edit(fields) { beads.all[0] = { ...beads.all[0], ...fields }; writeFileSync(fake, JSON.stringify(beads)); },
    // Syncs the committed export with the database
    exportNow() { writeFileSync(join(dir, ".beads", "issues.jsonl"), beads.all.map((b) => JSON.stringify(b)).join("\n") + "\n"); },
  };
}

function run(r, input, env = {}) {
  const res = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "s", stop_hook_active: false, cwd: r.dir, ...input }),
    encoding: "utf8",
    env: { ...process.env, PATH: bin + delimiter + process.env.PATH, FAKE_BEADS: r.fake, ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json: res.stdout ? JSON.parse(res.stdout) : null };
}
// Records the page as published, the way the lead does after republishing
const published = (r) => execFileSync(process.execPath, [pageScript, "--published", "--out", r.page], { encoding: "utf8" });

test("never published: rebuilds the page and blocks, asking to republish it", () => {
  const r = repo();
  const res = run(r);
  assert.equal(res.status, 0);
  assert.equal(res.json.decision, "block");
  assert.match(res.json.reason, /Republish that file with the Artifact tool/);
  assert.match(res.json.reason, /dist\/backlog\/index\.html/);
  assert.match(res.json.reason, /npm run backlog:published/);
  assert.doesNotMatch(res.json.reason, /beads:pr/, "the export is current");
  assert.ok(existsSync(r.page), "wrote the page");
  assert.ok(readFileSync(r.page, "utf8").includes("supply-checkout-a"));
});

test("stamp matches the data: silent", () => {
  const r = repo();
  run(r);
  assert.match(published(r), /Recorded .* as published/);
  const res = run(r);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
});

test("the build time alone doesn't count as a change", () => {
  const r = repo();
  run(r);
  published(r);
  // Rebuild the page later: a new `generated`, the same data
  execFileSync(process.execPath, [pageScript, "--out", r.page], { env: { ...process.env, PATH: bin + delimiter + process.env.PATH, FAKE_BEADS: r.fake } });
  assert.equal(run(r).stdout, "");
});

test("bead data changed since publishing: blocks and rebuilds the page", () => {
  const r = repo();
  run(r);
  published(r);
  r.edit({ title: "Renamed" });
  r.exportNow();
  const res = run(r);
  assert.equal(res.json.decision, "block");
  assert.match(res.json.reason, /changed since the backlog page was last published/);
  assert.ok(readFileSync(r.page, "utf8").includes("Renamed"), "rebuilt the page");
});

test("stale export: mentions npm run beads:pr", () => {
  const r = repo();
  run(r);
  published(r);
  r.edit({ status: "closed" });
  const res = run(r);
  assert.equal(res.json.decision, "block");
  assert.match(res.json.reason, /npm run beads:pr/);
  assert.match(res.json.reason, /npm run backlog:published/, "the page changed too");
});

test("stale export with the page current: only asks for beads:pr", () => {
  const r = repo();
  run(r);
  published(r);
  writeFileSync(join(r.dir, ".beads", "issues.jsonl"), "");
  const res = run(r);
  assert.equal(res.json.decision, "block");
  assert.match(res.json.reason, /npm run beads:pr/);
  assert.doesNotMatch(res.json.reason, /Artifact tool/);
});

test("in a worktree: silent, and builds nothing", () => {
  const r = repo();
  const res = run(r, { cwd: r.worktree });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.ok(!existsSync(r.page));
});

test("stop_hook_active: silent, so it never blocks twice in a row", () => {
  const r = repo();
  const res = run(r, { stop_hook_active: true });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.ok(!existsSync(r.page));
});

test("a subagent's stop: silent", () => {
  const r = repo();
  assert.equal(run(r, { agent_id: "agent-1" }).stdout, "");
});

test("bd fails: silent, exit 0", () => {
  const r = repo();
  const res = run(r, {}, { FAKE_BD_FAIL: "1" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
});

test("bd missing: silent, exit 0", () => {
  const r = repo();
  const res = run(r, {}, { PATH: "/usr/bin:/bin" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
});

test("not a git repo, or bad input: silent, exit 0", () => {
  const r = repo();
  assert.equal(run(r, { cwd: tmpdir() }).stdout, "");
  const res = spawnSync(process.execPath, [hook], { input: "not json", encoding: "utf8" });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
});

test("backlog:published without a page fails and says how to build one", () => {
  const r = repo();
  const res = spawnSync(process.execPath, [pageScript, "--published", "--out", r.page], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /npm run backlog:page/);
});
