// Code coverage of the app's source (src/), collected from Chromium during the
// Playwright suites and mapped back through the build's source maps. Enabled
// with COVERAGE=1 (npm run test:coverage), for the build in BUILD.
import { readFileSync, writeFileSync } from "node:fs";
import { CoverageReport } from "monocart-coverage-reports";
import { currentBuild, distDir } from "../scripts/builds.mjs";

export const enabled = !!process.env.COVERAGE;
const BUILD = currentBuild();
const ORIGIN = "https://supply-checkout.test/";

// Minimum coverage, in percent, for every metric. CI fails below this.
export const THRESHOLD = 98;
const METRICS = ["lines", "statements", "functions", "branches"];
const OUTPUT = `coverage/${BUILD}`;

// Lists what isn't covered, by src/ file and line, so a failing run says
// exactly what still needs a test: whole lines never run, lines only partly
// run (shown as the fraction of their code that ran), and each branch that
// never ran with the code it would have run.
function uncovered(file) {
  const src = file.source.split("\n");
  const lineAt = (offset) => file.source.slice(0, offset).split("\n").length;
  return [
    ...Object.entries(file.data.lines)
      .filter(([, hits]) => hits === 0 || typeof hits === "string")
      .map(([n, hits]) => `${file.sourcePath}:${n}  line ${hits === 0 ? "not run" : `partly run (${hits})`}: ${src[n - 1].trim().slice(0, 140)}`),
    ...file.data.branches
      .filter((b) => b.count === 0)
      .map((b) => `${file.sourcePath}:${lineAt(b.start)}  branch not run: ${file.source.slice(b.start, b.end).replace(/\s+/g, " ").slice(0, 140)}`),
  ];
}

// The builds write hidden source maps (no sourceMappingURL comment), so attach
// them here.
function sourceMapFor(url) {
  const path = url.slice(ORIGIN.length);
  return JSON.parse(readFileSync(distDir(BUILD) + `${path}.map`, "utf8"));
}

export const options = {
  name: `Supply Checkout coverage (${BUILD} build)`,
  outputDir: OUTPUT,
  reports: ["console-summary", "v8", "lcovonly"],
  // Only the app itself, not test helpers or third-party scripts.
  entryFilter: (entry) => entry.url.startsWith(ORIGIN),
  onEntry: (entry) => { entry.sourceMap = sourceMapFor(entry.url); },
  // Report the app's own modules by their path in the repo
  sourceFilter: (path) => /(^|\/)src\//.test(path),
  sourcePath: (path) => path.replace(/^.*?\bsrc\//, "src/"),
  onEnd: (results) => {
    const rows = results.files.flatMap(uncovered);
    writeFileSync(`${OUTPUT}/uncovered.txt`, rows.join("\n") + "\n");
    // The same numbers the threshold checks, for the CI job summary
    const summary = Object.fromEntries(METRICS.map((m) => [m, { pct: results.summary[m].pct, covered: results.summary[m].covered, total: results.summary[m].total }]));
    writeFileSync(`${OUTPUT}/summary.json`, JSON.stringify({ threshold: THRESHOLD, ...summary }, null, 2) + "\n");
    const low = METRICS.filter((m) => results.summary[m].pct < THRESHOLD)
      .map((m) => `${m} ${results.summary[m].pct}%`);
    if (low.length) {
      throw new Error(`Coverage below ${THRESHOLD}%: ${low.join(", ")}. ${rows.length} gaps are listed in ${OUTPUT}/uncovered.txt`);
    }
  },
};

export const report = () => new CoverageReport(options);
