#!/usr/bin/env node
// Fails a deploy whose `cdk diff` would replace or delete something that holds data
// (supply-checkout-pbp.27, ADR 0012). The deploy workflow runs it on the stateful stacks' diff
// before asking for their approval, and again just before deploying them.
//
//   node scripts/check-replacements.mjs <diff.txt> [--allow]
//
// <diff.txt> is `cdk diff --no-color` output. It prints a Markdown report (for the job summary)
// and exits 1 when the diff replaces, may replace, deletes or orphans a resource of a type that
// holds data (PROTECTED_TYPES), or orphans any resource (CDK says "orphan" for a retained
// resource that leaves the stack). --allow reports the same findings but exits 0: for a planned
// migration, following the expand/contract rule (docs/releases.md). Output it can't read, with
// no "Number of stacks with differences" line, exits 2, so a failed diff never passes.
//
// It reads CDK's text, the only form the CLI prints. Each resource line looks like
//   [~] AWS::DynamoDB::GlobalTable Table TableABC123 replace
// with the impact (replace, may be replaced, destroy, orphan) last, before an optional
// "(OR move ...)" note. check-replacements.test.mjs pins it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resource types whose replacement or deletion loses data, or breaks sign-in, mail or DNS. */
export const PROTECTED_TYPES = new Set([
  "AWS::DynamoDB::Table",
  "AWS::DynamoDB::GlobalTable",
  "AWS::Cognito::UserPool",
  "AWS::Cognito::UserPoolClient",
  "AWS::KMS::Key",
  "AWS::S3::Bucket",
  "AWS::Route53::HostedZone",
  "AWS::Logs::LogGroup",
  "AWS::Backup::BackupVault",
  "AWS::CloudTrail::Trail",
  "AWS::SES::EmailIdentity",
  "AWS::SecretsManager::Secret",
]);

const IMPACTS = ["may be replaced", "replace", "destroy", "orphan"];
const RESOURCE = /^\[([+~\-←])\] ((?:AWS|Custom)::\S+) (.+)$/;
const STACK = /^Stack (\S+)/;
const SUMMARY = /Number of stacks with differences: (\d+)/;

/** The impact word a resource line ends with, if any. */
function impactOf(rest) {
  const text = rest.replace(/\s*\(OR move .*\)\s*$/, "").trimEnd();
  return IMPACTS.find((impact) => text.endsWith(` ${impact}`)) ?? "";
}

/**
 * Every resource line that replaces, deletes or orphans something, by stack.
 * blocking: a protected type with any of those impacts, a protected type removed, or anything orphaned.
 */
export function findReplacements(text) {
  const summary = SUMMARY.exec(text);
  if (!summary) throw new Error("No \"Number of stacks with differences\" line: this isn't the output of a finished cdk diff");
  const findings = [];
  let stack = "";
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const s = STACK.exec(line);
    if (s) { stack = s[1]; continue; }
    const r = RESOURCE.exec(line);
    if (!r) continue;
    const [, change, type, rest] = r;
    const impact = impactOf(rest) || (change === "-" ? "destroy" : "");
    if (!impact) continue;
    const id = rest.replace(/\s*\(OR move .*\)\s*$/, "").trimEnd().slice(0, -(impact.length + 1)).trim() || rest.trim();
    const blocking = impact === "orphan" || PROTECTED_TYPES.has(type);
    findings.push({ stack, type, id, impact, blocking });
  }
  return { stacksWithDifferences: Number(summary[1]), findings };
}

/** The Markdown report and exit code for a diff. */
export function check(text, { allow = false } = {}) {
  let result;
  try {
    result = findReplacements(text);
  } catch (e) {
    return { code: 2, report: `### No-replacement check: couldn't read the diff\n\n${e.message}\n` };
  }
  const blocking = result.findings.filter((f) => f.blocking);
  const others = result.findings.filter((f) => !f.blocking);
  const rows = (list) => list.map((f) => `| ${f.stack} | \`${f.type}\` | ${f.id} | ${f.impact} |`).join("\n");
  const table = (list) => `| Stack | Type | Resource | Impact |\n| --- | --- | --- | --- |\n${rows(list)}\n`;
  let report = "### No-replacement check\n\n";
  if (blocking.length) {
    report += allow
      ? "**Allowed by the `allow-replacement` input** (a planned migration). These replace or delete what holds data:\n\n"
      : "**Blocked.** This replaces or deletes what holds data. If it's a planned migration (expand/contract, docs/releases.md), run the deploy again with `allow-replacement` checked:\n\n";
    report += table(blocking);
  } else {
    report += "Nothing that holds data is replaced or deleted.\n";
  }
  if (others.length) report += `\nOther replacements and deletions (allowed):\n\n${table(others)}`;
  return { code: blocking.length && !allow ? 1 : 0, report, ...result };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const allow = args.includes("--allow");
  const files = args.filter((a) => a !== "--allow");
  if (files.length !== 1 || files[0].startsWith("-")) {
    console.error("usage: node scripts/check-replacements.mjs <diff.txt> [--allow]");
    process.exit(2);
  }
  const { code, report } = check(readFileSync(files[0], "utf8"), { allow });
  console.log(report);
  process.exit(code);
}
