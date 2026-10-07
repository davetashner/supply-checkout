// node --test scripts/journeys/test/ (part of npm run test:scripts): the run summary maps
// Playwright's JSON report to journey steps, and masks what it prints.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { envMasker, main, parseArgs, results, summarize } from "../prod-summary.mjs";
import { fakeEnv } from "./helpers.mjs";

const registry = {
  journeys: [
    { id: "J0", name: "Sign in", critical: true, steps: [{ id: "J0.1", text: "Open the app.", status: "built" }, { id: "J0.2", text: "Sign in.", status: "built" }, { id: "J0.3", text: "Pick the team.", status: "built", prodSkip: "covered by J0.2 for now" }] },
    { id: "J1", name: "Sign up", critical: true, steps: [{ id: "J1.1", text: "Visit the site.", status: "planned" }] },
    { id: "J9", name: "Viewer", critical: false, steps: [{ id: "J9.1", text: "Open | read.", status: "built" }] },
  ],
};
const env = fakeEnv();
const result = (status, duration, error) => ({ status, duration, retry: 0, ...(error ? { error: { message: error }, errors: [{ message: error }] } : {}), steps: [] });
const report = {
  suites: [
    {
      title: "J0-sign-in.prod.js",
      specs: [
        {
          title: "crew signs in",
          tags: ["@J0.2", "@prod"],
          tests: [
            { projectName: "desktop-chrome", status: "expected", results: [result("passed", 4000)], annotations: [{ type: "journeys-warning", description: "A long-lived journey team's comp (Journeys desktop) ends in 9 days" }] },
            { projectName: "iphone-safari", status: "flaky", results: [result("failed", 5000, "Timeout"), result("passed", 3000)] },
          ],
        },
      ],
      suites: [
        {
          title: "viewer",
          specs: [
            {
              title: "sees but can't change",
              tags: ["@prod"],
              tests: [
                {
                  projectName: "desktop-chrome",
                  status: "unexpected",
                  results: [
                    { ...result("failed", 2000, "first try"), steps: [{ title: "J9.1 Open the projects" }] },
                    { ...result("failed", 2500, `\u001b[31mexpected\u001b[39m visible for ${env.JOURNEYS_VIEWER_EMAIL} with eyJabcdefg.eyJabcdefgh.sigsigsig\nCall log: fill("${env.JOURNEYS_VIEWER_PASSWORD}")`), steps: [{ title: "J9.1 Open the projects" }] },
                  ],
                },
              ],
            },
            { title: "untagged check", tags: [], tests: [{ projectName: "iphone-safari", status: "unexpected", results: [result("failed", 100, `failed for ${env.JOURNEYS_CREW_PASSWORD}`)] }, { projectName: "desktop-chrome", status: "skipped", results: [] }] },
          ],
        },
      ],
    },
  ],
};

test("results() finds each test's steps by tag and by test.step title", () => {
  const r = results(report);
  assert.equal(r.length, 5);
  assert.deepEqual(r[0].steps, ["J0.2"]);
  assert.deepEqual(r[2].steps, ["J9.1"]);
  assert.equal(r[2].title, "viewer › sees but can't change");
  assert.equal(r[1].outcome, "flaky");
  assert.equal(r[1].duration, 8000);
  assert.equal(r[4].outcome, "skipped");
  assert.deepEqual(results({}), []);
});

test("the summary lists every registry step, failures by browser, flaky tests and skip reasons", () => {
  const masker = envMasker(env);
  const s = summarize(report, registry, { redact: masker.redact, warnings: ["setup warning"] });
  assert.equal(s.ok, false);
  assert.deepEqual(s.failed, ["J9.1 (desktop-chrome)"]);
  assert.deepEqual(s.flaky, ["J0.2 (iphone-safari)"]);
  assert.deepEqual(s.critical, []);
  const md = s.markdown;
  assert.match(md, /\| J0\.1 Open the app\. \| – \| – \| – \| no prod test yet \|/);
  assert.match(md, /\| J0\.2 Sign in\. \| pass \| flaky \| 8 s \| {2}\|/);
  assert.match(md, /\| J0\.3 Pick the team\. \| – \| – \| – \| not in prod: covered by J0\.2 for now \|/);
  assert.match(md, /\| J1\.1 Visit the site\. \| – \| – \| – \| planned \|/);
  assert.match(md, /\| J9\.1 Open \\\| read\. \| \*\*FAIL\*\* \| – \| 5 s \| desktop-chrome: expected visible for/);
  assert.match(md, /> \*\*Warning:\*\* setup warning/);
  assert.match(md, /> \*\*Warning:\*\* A long-lived journey team's comp \(Journeys desktop\) ends in 9 days/);
  assert.match(md, /- viewer › untagged check \(iphone-safari\): failed: failed for \*\*\*/);
  // Nothing secret: no address, password, token, ANSI code or call log
  for (const v of [env.JOURNEYS_VIEWER_EMAIL, env.JOURNEYS_VIEWER_PASSWORD, env.JOURNEYS_CREW_PASSWORD, "eyJabcdefg", "\u001b[", "Call log"]) assert.ok(!md.includes(v), v);
});

test("a critical journey's failure is called out; a clean run says so", () => {
  const failing = { suites: [{ title: "f", specs: [{ title: "t", tags: ["@J0.2"], tests: [{ projectName: "iphone-safari", status: "unexpected", results: [result("failed", 1000, "boom")] }] }] }] };
  const s = summarize(failing, registry);
  assert.deepEqual(s.critical, ["J0.2 (iphone-safari)"]);
  assert.match(s.markdown, /\*\*Critical journeys failed\*\* \(J0\.2 \(iphone-safari\)\): follow the runbook/);
  const passing = { suites: [{ title: "f", specs: [{ title: "t", tags: ["@J0.2"], tests: [{ projectName: "desktop-chrome", status: "expected", results: [result("passed", 1000)] }] }] }] };
  const p = summarize(passing, registry);
  assert.equal(p.ok, true);
  assert.match(p.markdown, /All prod journey tests passed\.\n/);
  assert.match(summarize(report.suites[0].specs[0] ? { suites: [{ title: "f", specs: [report.suites[0].specs[0]] }] } : {}, registry).markdown, /passed, 1 only on a retry/);
});

test("the CLI writes the job summary and the verdict file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "summary-"));
  const files = { report: path.join(dir, "r.json"), registry: path.join(dir, "reg.json"), warnings: path.join(dir, "w.json"), json: path.join(dir, "v.json"), summary: path.join(dir, "s.md") };
  writeFileSync(files.report, JSON.stringify(report));
  writeFileSync(files.registry, JSON.stringify(registry));
  writeFileSync(files.warnings, JSON.stringify(["from setup"]));
  assert.equal(main(["--report", files.report, "--registry", files.registry, "--warnings", files.warnings, "--json", files.json], { ...env, GITHUB_STEP_SUMMARY: files.summary }), 0);
  assert.match(readFileSync(files.summary, "utf8"), /from setup/);
  assert.deepEqual(JSON.parse(readFileSync(files.json, "utf8")), { ok: false, failed: ["J9.1 (desktop-chrome)"], flaky: ["J0.2 (iphone-safari)"], critical: [] });
  // A missing warnings file is no warnings
  assert.equal(main(["--report", files.report, "--registry", files.registry, "--warnings", path.join(dir, "none.json")], { GITHUB_STEP_SUMMARY: files.summary }), 0);
  assert.deepEqual(parseArgs(["--report", "r"]), { report: "r", registry: "journeys/registry.json" });
  assert.throws(() => parseArgs([]), /--report/);
  assert.throws(() => parseArgs(["--nope", "x"]), /Unknown/);
  assert.throws(() => parseArgs(["--report"]), /incomplete/);
});

test("the real registry loads into a summary of every step", () => {
  const real = JSON.parse(readFileSync(new URL("../../../journeys/registry.json", import.meta.url), "utf8"));
  const s = summarize({ suites: [] }, real);
  const steps = real.journeys.flatMap((j) => j.steps).length;
  assert.equal(s.markdown.split("\n").filter((l) => /^\| J\d+\.\d+ /.test(l)).length, steps);
});
