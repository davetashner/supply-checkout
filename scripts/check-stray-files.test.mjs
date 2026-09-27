// node --test scripts/check-stray-files.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { strayFiles } from "./check-stray-files.mjs";

const SCRIPT = fileURLToPath(new URL("./check-stray-files.mjs", import.meta.url));

/** A throwaway repo with `files` committed. */
function repo(files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "stray-files-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  for (const [name, text] of Object.entries(files)) add(dir, name, text);
  if (Object.keys(files).length) git("commit", "-qm", "initial", "--no-verify");
  return { dir, git };
}

function add(dir, name, text = "x\n") {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), text);
  execFileSync("git", ["add", "-f", name], { cwd: dir });
}

const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });

test("strayFiles picks out .orig and .rej files, in any case", () => {
  assert.deepEqual(
    strayFiles(["docs/api/openapi.yaml", "docs/api/openapi.yaml.orig", "src/app.js.rej", "README.ORIG", "origin.md", "reject.js", "a.orig.md"]),
    ["docs/api/openapi.yaml.orig", "src/app.js.rej", "README.ORIG"],
  );
});

test("passes a clean repository", () => {
  const { dir } = repo({ "README.md": "hi\n", "docs/a.yaml": "a: 1\n" });
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 files clean/);
});

test("fails on a tracked .orig or .rej file anywhere in the tree", () => {
  const { dir } = repo({ "README.md": "hi\n", "docs/api/openapi.yaml.orig": "x\n", "src/app.js.rej": "x\n" });
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/api\/openapi\.yaml\.orig/);
  assert.match(r.stderr, /src\/app\.js\.rej/);
});

test("--staged fails when the commit adds a stray file", () => {
  const { dir } = repo({ "README.md": "hi\n" });
  add(dir, "docs/api/openapi.yaml.orig");
  const r = run(dir, "--staged");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /openapi\.yaml\.orig/);
});

test("--staged ignores stray files already committed and allows deleting them", () => {
  const { dir, git } = repo({ "README.md": "hi\n", "old.orig": "x\n" });
  add(dir, "README.md", "changed\n");
  let r = run(dir, "--staged");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 file clean/);
  git("rm", "-q", "old.orig");
  r = run(dir, "--staged");
  assert.equal(r.status, 0, r.stderr);
});

test("the pre-commit hook and CI run the check", () => {
  const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");
  assert.match(read("./git-hooks/pre-commit"), /^node scripts\/check-stray-files\.mjs --staged/m);
  assert.match(read("../.github/workflows/ci.yml"), /run: node scripts\/check-stray-files\.mjs$/m);
});
