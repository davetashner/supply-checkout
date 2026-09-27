// Claude Code Stop hook (.claude/settings.json): keeps the lead's two views of
// the backlog current after bead edits made outside a merge.
//
// Only in the main checkout (not a worktree), and never twice in a row
// (stop_hook_active), it:
//   - rebuilds dist/backlog/index.html when the beads' data differs from the
//     page last published (the stamp `npm run backlog:published` records), and
//   - checks whether the committed .beads/issues.jsonl is stale,
// and if either needs doing, blocks the stop with a reason telling Claude to
// republish the page to the private backlog artifact (its URL is in the lead's
// memory, never in the repo) and run `npm run backlog:published`, and/or to
// run `npm run beads:pr`. Otherwise it prints nothing.
//
// It must never get in the way on its own account: any error (bd missing, a
// timeout, not a git repo) ends it silently with exit 0.
//
// Input (stdin): the Stop hook's JSON, of which it reads cwd,
// stop_hook_active and agent_id. Output (stdout), only when blocking:
// {"decision": "block", "reason": "..."}.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildData, dataHash, mainCheckout, pagePath, publishedHash, readBeads, writePage } from "./backlog-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const TIMEOUT = 15_000;

export function stopHook(input) {
  if (!input || input.stop_hook_active || input.agent_id) return null;
  const cwd = input.cwd || process.cwd();
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const main = mainCheckout(cwd);
  if (realpathSync(top) !== realpathSync(main)) return null;   // a worktree

  const data = buildData(readBeads(undefined, { cwd: main, timeout: TIMEOUT }));
  const page = pagePath(main);
  const pageStale = dataHash(data) !== publishedHash(page);
  // 1 means stale; 0 is current, and anything else (2: bd failed) isn't ours to report
  const exportStale = spawnSync(process.execPath, [join(here, "export-beads.mjs"), "--check"],
    { cwd: main, timeout: TIMEOUT, stdio: "ignore" }).status === 1;
  if (!pageStale && !exportStale) return null;

  const reasons = [];
  if (pageStale) {
    writePage(page, data);
    reasons.push(`The backlog changed since the backlog page was last published. It's rebuilt at ${relative(main, page)} ` +
      "(the main checkout's). Republish that file with the Artifact tool to the existing private backlog artifact " +
      "(its URL is in your memory), then run `npm run backlog:published` so this hook knows it's current.");
  }
  if (exportStale) {
    reasons.push("The committed beads export (.beads/issues.jsonl) is stale: run `npm run beads:pr` from the main checkout " +
      "to open and land the export PR.");
  }
  return { decision: "block", reason: reasons.join(" ") };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = stopHook(JSON.parse(readFileSync(0, "utf8") || "{}"));
    if (result) process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    // Never fail or block the stop on this hook's own errors
  }
  process.exit(0);
}
