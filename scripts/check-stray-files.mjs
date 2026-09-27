// Fails if the repository tracks merge and patch leftovers: *.orig files from
// a conflict resolution and *.rej files from a patch that didn't apply.
//
//   node scripts/check-stray-files.mjs           every tracked file (CI)
//   node scripts/check-stray-files.mjs --staged  files the commit adds (pre-commit hook)
//
// Deleting a stray file is always allowed, so a commit can remove one.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const STRAY = /\.(?:orig|rej)$/i;

/** The paths in `files` that are merge or patch leftovers. */
export const strayFiles = (files) => files.filter((f) => STRAY.test(f));

function main(argv) {
  const staged = argv.includes("--staged");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  process.chdir(git("rev-parse", "--show-toplevel").trim());
  const files = (staged
    ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
    : git("ls-files")
  ).split("\n").filter(Boolean);
  const stray = strayFiles(files);
  if (stray.length) {
    console.error(`Remove these merge or patch leftovers before committing:\n\n${stray.join("\n")}\n`);
    return 1;
  }
  console.log(`stray-files: ${files.length} file${files.length === 1 ? "" : "s"} clean`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
