// Tests for the release evidence report (report.mjs): npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, clock, parseArgs, readSidecars, writeReport } from "./report.mjs";

const registry = () => ({
  journeys: [],
  alarms: [
    { name: "Site down", journeys: ["*"], infra: "site-down" },
    { name: "Core journey canary failing", journeys: ["*", "J0"] },
    { name: "Checkouts stopped", journeys: ["J0"], infra: "checkouts-stopped" },
    { name: "Export failing", journeys: ["J2"], coveredBy: "Site down" },
  ],
});

const sidecar = () => ({
  journey: { id: "J0", name: "Check out, and back", persona: "Crew", critical: true, status: "Partly built" },
  video: "J0-check-out-and-back.webm",
  viewport: "desktop", size: { width: 1280, height: 804 }, build: "web", runtime: "fakes", commit: "abc1234", recordedAt: "2026-09-30T12:00:00.000Z",
  duration: 92.5,
  summary: { passed: 1, failed: 1, simulated: 1, planned: 1, backend: 1, untested: 0, skipped: 0 },
  steps: [
    { id: "J0.1", text: "Open a **sheet**.", status: "built", result: "passed", backendTests: [], tests: [
      { file: "tests/a.spec.js", line: 3, title: "opens <script>alert(1)</script>", result: "passed", at: 5, shot: "evidence/t1-shot-0.jpg" },
    ] },
    { id: "J0.2", text: "Scan.", status: "built", simulated: "The camera is a fake", result: "failed", backendTests: [], tests: [
      { file: "tests/a.spec.js", line: 9, title: "opens and scans", result: "failed", error: "Expected: \"3\"", at: 70.25, shot: "evidence/t2-shot-1.jpg", trace: "evidence/t2-trace.zip" },
      { file: "tests/b.spec.js", line: 5, title: "group › scans", result: "skipped" },
    ] },
    { id: "J0.3", text: "Pay.", status: "built", result: "backend", backendTests: ["backend/test/pay.test.ts"], tests: [], at: 80 },
    { id: "J0.4", text: "Sign.", status: "planned", result: "planned", beads: ["supply-checkout-sig"], backendTests: [], tests: [], at: 85 },
  ],
  timeline: [],
});

const options = () => ({ registry: registry(), tag: "v1.2.3", repo: "owner/repo", generatedAt: "2026-09-30T13:00:00.000Z", image: (rel) => (rel === "evidence/t1-shot-0.jpg" ? "data:image/jpeg;base64,QUJD" : null) });

test("times in the video read as minutes and seconds", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(5), "0:05");
  assert.equal(clock(70.25), "1:10");
  assert.equal(clock(3725), "62:05");
});

test("each step links its tests' results, video timestamps, screenshots, traces and the journey's alarms", () => {
  const html = buildReport({ sidecars: [sidecar()], ...options() });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>Journey evidence v1\.2\.3<\/title>/);
  // The summary: one row per journey, with its video
  assert.match(html, /<a href="#J0">J0<\/a>/);
  assert.match(html, /<video [^>]*src="J0-check-out-and-back\.webm"/);
  const row = (id) => html.slice(html.indexOf(`id="step-${id.replace(".", "-")}"`), html.indexOf("</tr>", html.indexOf(`id="step-${id.replace(".", "-")}"`)));
  const j01 = row("J0.1");
  assert.match(j01, /Open a sheet\./);
  assert.match(j01, /class="tag passed">Passed</);
  assert.match(j01, /href="https:\/\/github\.com\/owner\/repo\/blob\/v1\.2\.3\/tests\/a\.spec\.js#L3"/);
  assert.match(j01, /href="J0-check-out-and-back\.webm#t=5" data-video="J0" data-t="5">0:05</);
  assert.match(j01, /<img [^>]*src="data:image\/jpeg;base64,QUJD"/);
  // The step's alarms: the journey's own, with whether each is built, and not Every journey's
  assert.match(j01, /href="#alarm-checkouts-stopped">Checkouts stopped<\/a> \(built\)/);
  assert.match(j01, /Core journey canary failing<\/a> \(planned\)/);
  assert.doesNotMatch(j01, /Site down/);
  // Test titles are escaped
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /opens &lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const j02 = row("J0.2");
  assert.match(j02, /class="tag failed">Failed</);
  assert.match(j02, /class="tag simulated">Simulated</);
  assert.match(j02, /Expected: &quot;3&quot;/);
  assert.match(j02, /#t=70\.25" data-video="J0" data-t="70\.25">1:10</);
  assert.match(j02, /href="evidence\/t2-trace\.zip">trace<\/a>/);
  // A screenshot that isn't there says so rather than breaking the page
  assert.match(j02, /no screenshot/);
  assert.match(j02, /group › scans/);
  assert.match(j02, /class="tag skipped">Not run</);

  assert.match(row("J0.3"), /backend\/test\/pay\.test\.ts/);
  assert.match(row("J0.3"), /#t=80"/);
  assert.match(row("J0.4"), /class="tag planned">Not built yet</);
  assert.match(row("J0.4"), /supply-checkout-sig/);

  // The alarms section: every alarm, Every journey's too, with its journeys
  assert.match(html, /id="alarm-site-down"/);
  assert.match(html, /id="alarm-export-failing"[^]*?covered by Site down/);
  // Fakes only, and said so; nothing loaded from elsewhere
  assert.match(html, /fakes and demo data/);
  assert.doesNotMatch(html, /<script src|<link |src="http/);
});

test("without a repo the files aren't links, and the journeys come in order", () => {
  const j10 = { ...sidecar(), journey: { ...sidecar().journey, id: "J10", name: "Export" }, video: "J10-export.webm", steps: [] };
  const html = buildReport({ sidecars: [j10, sidecar()], ...options(), repo: null, tag: null, image: () => null });
  assert.ok(html.indexOf('id="J0"') < html.indexOf('id="J10"'));
  assert.match(html, /<title>Journey evidence<\/title>/);
  assert.doesNotMatch(html, /github\.com/);
  assert.match(html, /<code>tests\/a\.spec\.js:3<\/code>/);
});

test("it refuses a recording that wasn't made against the fakes, or no recordings at all", () => {
  assert.throws(() => buildReport({ sidecars: [], ...options() }), /No journey recordings/);
  const real = { ...sidecar(), runtime: undefined };
  assert.throws(() => buildReport({ sidecars: [real], ...options() }), /J0-check-out-and-back\.webm wasn't recorded against the test suite's fakes/);
});

test("the command reads the sidecars and screenshots from a folder and writes one self-contained page", () => {
  const dir = mkdtempSync(join(tmpdir(), "journey-report-"));
  mkdirSync(join(dir, "evidence"));
  writeFileSync(join(dir, "J0-check-out-and-back.json"), JSON.stringify(sidecar()));
  writeFileSync(join(dir, "notes.txt"), "not a sidecar");
  writeFileSync(join(dir, "evidence/t1-shot-0.jpg"), Buffer.from("ABC"));
  assert.deepEqual(readSidecars(dir).map((s) => s.journey.id), ["J0"]);
  const out = join(dir, "journey-evidence.html");
  writeReport({ dir, out, registry: registry(), tag: "v1.2.3", repo: "owner/repo" });
  const html = readFileSync(out, "utf8");
  assert.match(html, /src="data:image\/jpeg;base64,QUJD"/);
  // A screenshot path can't reach outside the folder
  const escape = { ...sidecar() };
  escape.steps[0].tests[0].shot = "../secret.jpg";
  writeFileSync(join(dir, "J0-check-out-and-back.json"), JSON.stringify(escape));
  writeReport({ dir, out, registry: registry() });
  assert.doesNotMatch(readFileSync(out, "utf8"), /data:image/);

  assert.deepEqual(parseArgs([]), { dir: "dist/journey-videos", out: null, tag: null, repo: null });
  assert.deepEqual(parseArgs(["--dir", "x", "--out=y.html", "--tag", "v1", "--repo", "o/r"]), { dir: "x", out: "y.html", tag: "v1", repo: "o/r" });
  assert.throws(() => parseArgs(["--tag"]), /--tag needs a value/);
  assert.throws(() => parseArgs(["--loud"]), /Unknown option --loud/);
  assert.throws(() => parseArgs(["--repo", "not a repo"]), /--repo is owner\/name/);
});
