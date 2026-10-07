// Claude Code Stop hook (.claude/settings.json): keeps the two views of the
// backlog current after bead edits made outside a merge.
//
// Only in the main checkout (not a worktree), and never twice in a row
// (stop_hook_active), it:
//   - silently rebuilds dist/backlog/index.html (the page people open
//     locally) when the beads' data differs from the page last built (its
//     .hash), and
//   - checks whether the committed .beads/issues.jsonl is stale, and if so
//     blocks the stop with a reason telling Claude to run `npm run beads:pr`.
// Otherwise it prints nothing.
//
// It must never get in the way on its own account: any error (bd missing, a
// timeout, not a git repo) ends it silently with exit 0.
//
// Input (stdin): the Stop hook's JSON, of which it reads cwd,
// stop_hook_active and agent_id. Output (stdout), only when blocking:
// {"decision": "block", "reason": "..."}.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildData, dataHash, builtHash, mainCheckout, pagePath, readBeads, writePage } from "./backlog-page.mjs";

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
  if (dataHash(data) !== builtHash(page)) writePage(page, data);
  // 1 means stale; 0 is current, and anything else (2: bd failed) isn't ours to report
  const exportStale = spawnSync(process.execPath, [join(here, "export-beads.mjs"), "--check"],
    { cwd: main, timeout: TIMEOUT, stdio: "ignore" }).status === 1;
  if (!exportStale) return null;
  return {
    decision: "block",
    reason: "The committed beads export (.beads/issues.jsonl) is stale: run `npm run beads:pr` from the main checkout " +
      "to open and land the export PR.",
  };
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
