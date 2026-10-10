// The coverage gate for backend/ and infra/, run after `vitest run --coverage`
// (npm run test:coverage in either package, which CI runs):
//
//   node ../scripts/vitest-coverage.mjs
//
// From the package's directory, it reads the minimum percentages in
// coverage-thresholds.json and Vitest's coverage/coverage-summary.json and
// coverage/coverage-final.json. It writes coverage/uncovered.txt, every
// statement, branch and function no test ran, by file and line; prints the
// totals as a Markdown table, appended to the GitHub job summary in CI
// ($GITHUB_STEP_SUMMARY); and exits 1 when any metric is below its minimum.
//
// The minimums are the measured coverage rounded down when the gate was added
// (bead supply-checkout-pbp.43). Raise them as coverage grows; never lower them.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const METRICS = ["lines", "statements", "functions", "branches"];
const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The metrics below their minimum, as "lines 97.1% < 98%". Every metric must have a minimum. */
export function belowThreshold(total, thresholds) {
  return METRICS.flatMap((m) => {
    if (typeof thresholds[m] !== "number") throw new Error(`coverage-thresholds.json has no number for ${m}`);
    return total[m].pct < thresholds[m] ? [`${m} ${total[m].pct}% < ${thresholds[m]}%`] : [];
  });
}

/** The totals as a Markdown table for the job summary. */
export function summaryTable(name, total, thresholds) {
  const rows = METRICS.map((m) => `| ${m} | ${total[m].pct}% | ${total[m].covered} / ${total[m].total} | ${thresholds[m]}% | ${total[m].pct >= thresholds[m] ? "✅" : "❌"} |`);
  return [`### Coverage, ${name}`, "", "| Metric | Covered | Count | Minimum | |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
}

/**
 * Every statement, branch and function no test ran, from Vitest's
 * coverage-final.json (Istanbul format), as "path:line  what: source".
 */
export function uncovered(final, pathOf = (p) => p, readSource = (p) => readFileSync(p, "utf8")) {
  return Object.entries(final).sort(([a], [b]) => a.localeCompare(b)).flatMap(([file, cov]) => {
    let lines;
    const text = (loc) => {
      lines ??= readSource(file).split("\n");
      const line = lines[loc.start.line - 1] ?? "";
      const end = loc.end.line === loc.start.line && loc.end.column != null ? loc.end.column : undefined;
      return line.slice(loc.start.column, end).replace(/\s+/g, " ").trim().slice(0, 140);
    };
    const at = (loc) => `${pathOf(file)}:${loc.start.line}`;
    return [
      ...Object.entries(cov.fnMap).filter(([id]) => cov.f[id] === 0)
        .map(([, fn]) => [fn.loc.start.line, `${at(fn.loc)}  function not run: ${fn.name}`]),
      ...Object.entries(cov.statementMap).filter(([id]) => cov.s[id] === 0)
        .map(([, loc]) => [loc.start.line, `${at(loc)}  statement not run: ${text(loc)}`]),
      ...Object.entries(cov.branchMap).flatMap(([id, br]) => br.locations
        .map((loc, i) => [loc, cov.b[id][i]])
        .filter(([, hits]) => hits === 0)
        .map(([loc]) => {
          const where = loc.start.line ? loc : br.loc;
          return [where.start.line, `${at(where)}  branch not run (${br.type}): ${text(where)}`];
        })),
    ].sort((a, b) => a[0] - b[0]).map(([, row]) => row);
  });
}

export function main(dir = process.cwd(), env = process.env) {
  const name = `${basename(dir)}/`;
  const thresholds = JSON.parse(readFileSync(resolve(dir, "coverage-thresholds.json"), "utf8"));
  const { total } = JSON.parse(readFileSync(resolve(dir, "coverage/coverage-summary.json"), "utf8"));
  const final = JSON.parse(readFileSync(resolve(dir, "coverage/coverage-final.json"), "utf8"));
  const rows = uncovered(final, (p) => relative(REPO, p));
  writeFileSync(resolve(dir, "coverage/uncovered.txt"), rows.join("\n") + "\n");
  const table = summaryTable(name, total, thresholds);
  console.log(table);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, table + "\n\n");
  const low = belowThreshold(total, thresholds);
  if (low.length) {
    console.error(`Coverage of ${name} is below its minimum: ${low.join(", ")}. ${rows.length} gaps are listed in ${name}coverage/uncovered.txt`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
