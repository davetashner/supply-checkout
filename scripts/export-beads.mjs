// Writes the beads backlog to .beads/issues.jsonl for committing, without the
// "owner" field: beads fills it from git's user.email, and this repo is public.
// Run from any worktree: `npm run beads:export`.
// With --check, writes nothing and exits 1 if the committed file is out of date.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const file = join(root, ".beads", "issues.jsonl");
const raw = execFileSync("bd", ["export"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = raw.split("\n").filter(Boolean).map((line) => {
  const issue = JSON.parse(line);
  delete issue.owner;
  return JSON.stringify(issue);
});
const out = lines.join("\n") + "\n";

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(file, "utf8"); } catch {}
  if (current !== out) { console.log(".beads/issues.jsonl is out of date. Run: npm run beads:export"); process.exit(1); }
  console.log(".beads/issues.jsonl is up to date");
} else {
  writeFileSync(file, out);
  console.log(`Exported ${lines.length} beads to .beads/issues.jsonl`);
}
