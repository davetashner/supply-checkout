import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { belowThreshold, main, METRICS, summaryTable, uncovered } from "./vitest-coverage.mjs";

const metric = (pct, covered = pct, total = 100) => ({ pct, covered, total });
const totals = (pct) => Object.fromEntries(METRICS.map((m) => [m, metric(pct)]));
const minimums = { lines: 97, statements: 96, functions: 97, branches: 93 };

test("coverage at or above every minimum passes", () => {
  assert.deepEqual(belowThreshold({ lines: metric(97), statements: metric(96.5), functions: metric(100), branches: metric(93) }, minimums), []);
});

for (const m of METRICS) {
  test(`${m} below its minimum fails the gate`, () => {
    const total = Object.fromEntries(METRICS.map((k) => [k, metric(minimums[k])]));
    total[m] = metric(minimums[m] - 0.01);
    assert.deepEqual(belowThreshold(total, minimums), [`${m} ${minimums[m] - 0.01}% < ${minimums[m]}%`]);
  });
}

test("a missing minimum is an error, not a pass", () => {
  const partial = { ...minimums };
  delete partial.branches;
  assert.throws(() => belowThreshold(totals(100), partial), /no number for branches/);
});

test("the summary table marks each metric", () => {
  const table = summaryTable("backend/", { ...totals(99), branches: metric(90, 90, 100) }, minimums);
  assert.match(table, /^### Coverage, backend\//);
  assert.match(table, /\| lines \| 99% \| 99 \/ 100 \| 97% \| ✅ \|/);
  assert.match(table, /\| branches \| 90% \| 90 \/ 100 \| 93% \| ❌ \|/);
});

const final = {
  "/repo/backend/src/b.ts": {
    fnMap: { 0: { name: "unused", loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } } } },
    f: { 0: 0 },
    statementMap: {
      0: { start: { line: 2, column: 2 }, end: { line: 2, column: null } },
      1: { start: { line: 4, column: 0 }, end: { line: 4, column: 10 } },
    },
    s: { 0: 0, 1: 3 },
    branchMap: {
      0: {
        type: "binary-expr",
        loc: { start: { line: 5, column: 10 }, end: { line: 5, column: null } },
        locations: [
          { start: { line: 5, column: 10 }, end: { line: 5, column: 11 } },
          { start: { line: 5, column: 15 }, end: { line: 5, column: null } },
        ],
      },
    },
    b: { 0: [4, 0] },
  },
  "/repo/backend/src/a.ts": { fnMap: {}, f: {}, statementMap: {}, s: {}, branchMap: {}, b: {} },
};
const sources = { "/repo/backend/src/b.ts": "function unused() {\n  return   42;\n}\nconst x = 1;\nconst y = a ?? fallback();\n" };

test("uncovered lists functions, statements and branches that never ran, by file and line", () => {
  assert.deepEqual(uncovered(final, (p) => p.replace("/repo/", ""), (p) => sources[p]), [
    "backend/src/b.ts:1  function not run: unused",
    "backend/src/b.ts:2  statement not run: return 42;",
    "backend/src/b.ts:5  branch not run (binary-expr): fallback();",
  ]);
});

test("main writes uncovered.txt and the job summary, and exits 1 below a minimum", () => {
  const dir = mkdtempSync(join(tmpdir(), "vitest-coverage-"));
  mkdirSync(join(dir, "coverage"));
  const file = join(dir, "src.ts");
  writeFileSync(file, "function unused() {\n  return   42;\n}\nconst x = 1;\nconst y = a ?? fallback();\n");
  writeFileSync(join(dir, "coverage-thresholds.json"), JSON.stringify(minimums));
  writeFileSync(join(dir, "coverage/coverage-final.json"), JSON.stringify({ [file]: final["/repo/backend/src/b.ts"] }));
  const summary = join(dir, "summary.md");
  const run = (pct) => {
    writeFileSync(join(dir, "coverage/coverage-summary.json"), JSON.stringify({ total: totals(pct) }));
    return main(dir, { GITHUB_STEP_SUMMARY: summary });
  };
  const { error } = console;
  console.error = () => {};
  const { log } = console;
  console.log = () => {};
  try {
    assert.equal(run(99), 0);
    assert.equal(run(92.5), 1);
  } finally {
    console.error = error;
    console.log = log;
  }
  assert.match(readFileSync(join(dir, "coverage/uncovered.txt"), "utf8"), /src\.ts:2 {2}statement not run: return 42;/);
  const md = readFileSync(summary, "utf8");
  assert.equal(md.match(/### Coverage/g).length, 2);
  assert.match(md, /❌/);
});
