// Prints the coverage totals as a Markdown table, for the CI job summary.
import { readFileSync } from "node:fs";

// coverage/summary.json is written by tests/coverage.js.
const { threshold, ...metrics } = JSON.parse(readFileSync(new URL("../coverage/summary.json", import.meta.url), "utf8"));
const rows = Object.entries(metrics)
  .map(([m, v]) => `| ${m} | ${v.pct}% | ${v.covered} / ${v.total} | ${v.pct >= threshold ? "✅" : "❌"} |`);
console.log([`### Coverage (minimum ${threshold}%)`, "", "| Metric | Covered | Count | |", "| --- | --- | --- | --- |", ...rows].join("\n"));
