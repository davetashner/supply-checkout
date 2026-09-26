// Prints a build's coverage totals as a Markdown table, for the CI job summary.
//
//   node scripts/coverage-summary.mjs artifact|web
import { readFileSync } from "node:fs";

// coverage/<build>/summary.json is written by tests/coverage.js.
const build = process.argv[2] || "artifact";
const { threshold, ...metrics } = JSON.parse(readFileSync(new URL(`../coverage/${build}/summary.json`, import.meta.url), "utf8"));
const rows = Object.entries(metrics)
  .map(([m, v]) => `| ${m} | ${v.pct}% | ${v.covered} / ${v.total} | ${v.pct >= threshold ? "✅" : "❌"} |`);
console.log([`### Coverage, ${build} build (minimum ${threshold}%)`, "", "| Metric | Covered | Count | |", "| --- | --- | --- | --- |", ...rows].join("\n"));
