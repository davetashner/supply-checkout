// Writes the beads backlog to .beads/issues.jsonl for committing, without the
// "owner" field: beads fills it from git's user.email, and this repo is public.
// Run from any worktree: `npm run beads:export`.
// With --check, writes nothing and exits 1 if the committed file is out of date,
// or 2 if it couldn't tell (bd failed, say).
// With --due, asks git rather than bd, and exits 0 if a refresh is due: the
// export last committed on origin/main is at least EXPORT_MAX_AGE_HOURS old,
// or git can't say when (no origin/main, no history). Otherwise it exits 1.
// npm run land and the Stop hook refresh a stale export only when it's due, so
// there's at most one export PR a day; npm run beads:pr by hand doesn't ask.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXPORT_MAX_AGE_HOURS = 24;

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const file = join(root, ".beads", "issues.jsonl");
const check = process.argv.includes("--check");

if (process.argv.includes("--due")) {
  let committed = NaN;
  try {
    committed = Number.parseInt(execFileSync("git", ["log", "-1", "--format=%ct", "origin/main", "--", ".beads/issues.jsonl"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), 10);
  } catch {}
  if (!Number.isFinite(committed)) {
    console.log("No committed beads export found on origin/main: a refresh is due");
    process.exit(0);
  }
  const hours = (Date.now() / 1000 - committed) / 3600;
  if (hours >= EXPORT_MAX_AGE_HOURS) {
    console.log(`The beads export on origin/main is ${Math.floor(hours)} hours old: a refresh is due`);
    process.exit(0);
  }
  console.log(`The beads export on origin/main is under ${EXPORT_MAX_AGE_HOURS} hours old: no refresh due yet`);
  process.exit(1);
}
let raw;
try {
  raw = execFileSync("bd", ["export"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (err) {
  console.error(`Couldn't export the beads: ${err.message}`);
  process.exit(check ? 2 : 1);
}
const lines = raw.split("\n").filter(Boolean).map((line) => {
  const issue = JSON.parse(line);
  delete issue.owner;
  return JSON.stringify(issue);
});
const out = lines.join("\n") + "\n";

if (check) {
  let current = "";
  try { current = readFileSync(file, "utf8"); } catch {}
  if (current !== out) { console.log(".beads/issues.jsonl is out of date. Run: npm run beads:export"); process.exit(1); }
  console.log(".beads/issues.jsonl is up to date");
} else {
  writeFileSync(file, out);
  console.log(`Exported ${lines.length} beads to .beads/issues.jsonl`);
}
