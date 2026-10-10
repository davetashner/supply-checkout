// Fails if the repository contains things a public repo must not: AWS account
// and SSO identifiers, personal email addresses, or credentials.
//
//   node scripts/check-public-safety.mjs           every tracked file
//   node scripts/check-public-safety.mjs --staged  only what's staged (pre-commit hook)
//
// A line containing "public-safety: allow" is skipped. Use it only for
// deliberate examples, never for real values.
// gitleaks has its own marker, gitleaks:allow; a fake key
// on one line needs both (docs/testing.md, "Fake secrets in tests").
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { RULES } from "./public-safety-rules.mjs";

const staged = process.argv.includes("--staged");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
process.chdir(git("rev-parse", "--show-toplevel").trim());
const files = (staged
  ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
  : git("ls-files")
).split("\n").filter(Boolean);

const findings = [];
for (const file of files) {
  let text;
  try { text = staged ? git("show", `:${file}`) : readFileSync(file, "utf8"); }
  catch { continue; }
  if (text.includes("\0")) continue; // binary
  text.split("\n").forEach((line, i) => {
    if (line.includes("public-safety: allow")) return;
    for (const rule of RULES) {
      const matches = rule.re.global ? [...line.matchAll(rule.re)].map((m) => m[0]) : [line.match(rule.re)?.[0]].filter(Boolean);
      for (const m of matches) {
        if (rule.allow && rule.allow(m)) continue;
        findings.push(`${file}:${i + 1}  ${rule.name}: ${m.slice(0, 4)}…`);
      }
    }
  });
}

if (findings.length) {
  console.error(`This repository is public. Remove these before committing:\n\n${findings.join("\n")}\n`);
  process.exit(1);
}
console.log(`public-safety: ${files.length} file${files.length === 1 ? "" : "s"} clean`);
