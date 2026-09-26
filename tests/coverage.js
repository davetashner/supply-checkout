// Code coverage of the app's script, collected from Chromium during the
// Playwright suites. Enabled with COVERAGE=1 (npm run test:coverage).
import { readFileSync, writeFileSync } from "node:fs";
import { CoverageReport } from "monocart-coverage-reports";

export const enabled = !!process.env.COVERAGE;

// Minimum coverage, in percent, for every metric. CI fails below this.
export const THRESHOLD = 98;
const METRICS = ["lines", "statements", "functions", "branches"];
const OUTPUT = "coverage";

// Lists what isn't covered, by line number in index.html, so a failing run
// says exactly what still needs a test: whole lines never run, lines only
// partly run (shown as the fraction of their code that ran), and each branch
// that never ran with the code it would have run.
function writeUncovered(file) {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8").split("\n");
  const src = file.source.split("\n");
  const where = (n) => {
    const i = html.findIndex((l) => l.trim() === src[n - 1].trim());
    return i < 0 ? "?" : i + 1;
  };
  const lineAt = (offset) => file.source.slice(0, offset).split("\n").length;
  const rows = [
    ...Object.entries(file.data.lines)
      .filter(([, hits]) => hits === 0 || typeof hits === "string")
      .map(([n, hits]) => `index.html:${where(n)}  line ${hits === 0 ? "not run" : `partly run (${hits})`}: ${src[n - 1].trim().slice(0, 140)}`),
    ...file.data.branches
      .filter((b) => b.count === 0)
      .map((b) => `index.html:${where(lineAt(b.start))}  branch not run: ${file.source.slice(b.start, b.end).replace(/\s+/g, " ").slice(0, 140)}`),
  ];
  writeFileSync(`${OUTPUT}/uncovered.txt`, rows.join("\n") + "\n");
  return rows.length;
}

export const options = {
  name: "Supply Checkout coverage",
  outputDir: OUTPUT,
  reports: ["console-summary", "v8", "lcovonly"],
  // Only the app itself, not test helpers or third-party scripts.
  entryFilter: (entry) => entry.url.startsWith("https://supply-checkout.test/"),
  onEnd: (results) => {
    const gaps = results.files.reduce((n, f) => n + writeUncovered(f), 0);
    // The same numbers the threshold checks, for the CI job summary
    const summary = Object.fromEntries(METRICS.map((m) => [m, { pct: results.summary[m].pct, covered: results.summary[m].covered, total: results.summary[m].total }]));
    writeFileSync(`${OUTPUT}/summary.json`, JSON.stringify({ threshold: THRESHOLD, ...summary }, null, 2) + "\n");
    const low = METRICS.filter((m) => results.summary[m].pct < THRESHOLD)
      .map((m) => `${m} ${results.summary[m].pct}%`);
    if (low.length) {
      throw new Error(`Coverage below ${THRESHOLD}%: ${low.join(", ")}. ${gaps} gaps are listed in ${OUTPUT}/uncovered.txt`);
    }
  },
};

export const report = () => new CoverageReport(options);
