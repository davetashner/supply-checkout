// Writes the beads backlog to .beads/issues.jsonl for committing, without the
// "owner" field: beads fills it from git's user.email, and this repo is public.
// Run from any worktree: `npm run beads:export`.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const raw = execFileSync("bd", ["export"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = raw.split("\n").filter(Boolean).map((line) => {
  const issue = JSON.parse(line);
  delete issue.owner;
  return JSON.stringify(issue);
});
writeFileSync(join(root, ".beads", "issues.jsonl"), lines.join("\n") + "\n");
console.log(`Exported ${lines.length} beads to .beads/issues.jsonl`);
