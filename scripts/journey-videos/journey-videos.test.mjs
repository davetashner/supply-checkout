// Tests for the journey videos' planning, sidecar and joining: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planVideos, grepFor, readReport, stepResults, clipsFor, sidecar, summarize, journeySlug, testKey } from "./assemble.mjs";
import { parseWebm, concatWebm, webmDuration } from "./webm.mjs";
import { errorSummary, frame, plain, titleCard, stepCard, endCard } from "./director.mjs";
import { parseArgs } from "./record.mjs";

const registry = () => ({
  journeys: [
    {
      id: "J0", name: "Check out, and back", persona: "Crew", critical: true,
      steps: [
        { id: "J0.1", text: "Open a **sheet**.", status: "built" },
        { id: "J0.2", text: "Scan.", status: "built", simulated: "The camera is a fake" },
        { id: "J0.3", text: "Pay.", status: "built", tests: ["backend/test/pay.test.ts"] },
        { id: "J0.4", text: "Sign.", status: "planned", beads: ["supply-checkout-sig"] },
      ],
    },
    { id: "J1", name: "Later", persona: "Owner", critical: false, phase2: true, steps: [{ id: "J1.1", text: "Wait.", status: "planned" }] },
    { id: "J2", name: "Export", persona: "Owner", critical: false, steps: [{ id: "J2.1", text: "Export.", status: "built" }] },
  ],
});

const t = (file, line, title, tags) => ({ file: `tests/${file}`, line, title, tags });
const tests = () => [
  t("b.spec.js", 5, "scans", ["J0.2"]),
  t("a.spec.js", 9, "opens and scans", ["J0", "J0.1", "J0.2", "J2.1"]),
  t("a.spec.js", 3, "opens", ["J0.1"]),
  t("a.spec.js", 20, "untagged", []),
  t("c.spec.js", 1, "journey only", ["J0"]),
];

test("each journey's tests are those tagged with its steps, ordered by the first step each proves", () => {
  const plans = planVideos(registry(), tests());
  assert.deepEqual(plans.map((p) => p.journey.id), ["J0", "J2"]);
  assert.deepEqual(plans[0].tests.map((x) => [x.title, x.ids, x.step]), [
    ["opens", ["J0.1"], 0],
    ["opens and scans", ["J0.1", "J0.2"], 0],
    ["scans", ["J0.2"], 1],
  ]);
  assert.deepEqual(plans[1].tests.map((x) => [x.title, x.ids]), [["opens and scans", ["J2.1"]]]);
  assert.deepEqual(planVideos(registry(), tests(), ["J2"]).map((p) => p.journey.id), ["J2"]);
  assert.throws(() => planVideos(registry(), tests(), ["J7"]), /No journey J7\. There are J0, J1, J2\./);
  assert.throws(() => planVideos(registry(), tests(), ["J1"]), /J1 is phase 2/);
  assert.equal(journeySlug(registry().journeys[0]), "J0-check-out-and-back");
});

test("the grep picks the step tags of the chosen journeys, and not J10's for J1", () => {
  const re = new RegExp(grepFor(planVideos(registry(), tests())));
  assert.ok(re.test("opens @J0.1"));
  assert.ok(re.test("x @J2.1 @other"));
  assert.ok(!re.test("x @J0"));
  assert.ok(!re.test("x @J20.1"));
  assert.ok(!re.test("x @J1.1"));
});

// Playwright's JSON report, cut down to what readReport reads
const events = (list) => ({ name: "journey-video-events", body: Buffer.from(JSON.stringify({ events: list })).toString("base64") });
const report = () => ({
  suites: [
    {
      file: "a.spec.js",
      specs: [
        { title: "opens", file: "a.spec.js", line: 3, tests: [{ results: [{ status: "passed", attachments: [{ name: "video", path: "/v/opens.webm" }, events([{ t: 0, type: "test-end", status: "passed" }])] }] }] },
        {
          title: "opens and scans", file: "a.spec.js", line: 9,
          tests: [{
            results: [{
              status: "failed", errors: [{ message: "Error: expect(locator).toHaveText(expected) failed\n\nExpected: \"3\"\nReceived: \"2\"" }],
              attachments: [{ name: "video", path: "/v/both.webm" }, events([
                { t: 100, type: "step-start", id: "J0.1" }, { t: 900, type: "step-end", id: "J0.1", status: "passed" },
                { t: 1000, type: "step-start", id: "J0.2" }, { t: 2500, type: "step-end", id: "J0.2", status: "failed", error: "Expected: \"3\"" },
                { t: 3000, type: "test-end", status: "failed", error: "expect(locator).toHaveText(expected) failed" },
              ])],
            }],
          }],
        },
      ],
      suites: [],
    },
    { file: "b.spec.js", specs: [], suites: [{ title: "group", specs: [{ title: "scans", file: "b.spec.js", line: 5, tests: [{ results: [{ status: "skipped", attachments: [] }] }] }] }] },
    { file: "c.spec.js", specs: [{ title: "no run", file: "c.spec.js", line: 1, tests: [{ results: [] }] }, { title: "timed out", file: "c.spec.js", line: 2, tests: [{ results: [{ status: "timedOut", errors: [{ message: "Test timeout of 30000ms exceeded." }], attachments: [] }] }] }] },
  ],
});

test("the report gives each test's result, video and events", () => {
  const results = readReport(report());
  assert.deepEqual([...results.keys()], ["tests/a.spec.js:3:opens", "tests/a.spec.js:9:opens and scans", "tests/b.spec.js:5:group › scans", "tests/c.spec.js:2:timed out"]);
  assert.equal(results.get("tests/a.spec.js:3:opens").video, "/v/opens.webm");
  // Two pages, two videos: the longest is the test's own page
  const two = report();
  two.suites[0].specs[0].tests[0].results[0].attachments.unshift({ name: "video", path: "/v/tab.webm" });
  assert.equal(readReport(two, (videos) => videos.find((v) => v !== "/v/tab.webm")).get("tests/a.spec.js:3:opens").video, "/v/opens.webm");
  assert.equal(readReport(two).get("tests/a.spec.js:3:opens").video, "/v/tab.webm");
  assert.equal(results.get("tests/a.spec.js:9:opens and scans").error, "expect(locator).toHaveText(expected) failed");
  assert.equal(results.get("tests/b.spec.js:5:group › scans").status, "skipped");
  assert.deepEqual(results.get("tests/c.spec.js:2:timed out"), { status: "failed", error: "Test timeout of 30000ms exceeded.", video: null, events: [] });
  assert.equal(testKey({ file: "tests/x.js", line: 1, title: "y" }), "tests/x.js:1:y");
});

test("each step's result comes from its test.step, else its tests; the cards and sidecar follow", () => {
  const reg = registry();
  // The b.spec.js test is in a group in the report
  const all = tests().map((x) => (x.title === "scans" ? { ...x, title: "group › scans" } : x));
  const [plan] = planVideos(reg, all, ["J0"]);
  const results = readReport(report());
  const steps = stepResults(plan, results);
  assert.deepEqual(steps.map((s) => [s.id, s.result]), [["J0.1", "passed"], ["J0.2", "failed"], ["J0.3", "backend"], ["J0.4", "planned"]]);
  assert.deepEqual(steps[1].tests.map((x) => [x.title, x.result]), [["opens and scans", "failed"], ["group › scans", "skipped"]]);
  assert.equal(steps[1].tests[0].error, "Expected: \"3\"");
  assert.equal(steps[1].simulated, "The camera is a fake");
  assert.deepEqual(steps[2].backendTests, ["backend/test/pay.test.ts"]);
  assert.deepEqual(summarize(steps), { passed: 1, failed: 1, simulated: 1, planned: 1, backend: 1, untested: 0, skipped: 0 });

  const clips = clipsFor(plan, steps, results);
  assert.deepEqual(clips.map((c) => c.kind + (c.test ? `:${c.test.title}` : c.step ? `:${c.step}` : "")), ["title", "test:opens", "test:opens and scans", "step:J0.3", "step:J0.4", "end"]);

  const data = sidecar({ plan, steps, clips, starts: [0, 5, 9, 14, 19, 24], duration: 32, results, video: "J0.webm", meta: { viewport: "desktop" } });
  assert.equal(data.journey.status, "Partly built");
  assert.equal(data.viewport, "desktop");
  assert.equal(data.duration, 32);
  assert.deepEqual(data.timeline.map((x) => [x.kind, x.start, x.end]), [["title", 0, 5], ["test", 5, 9], ["test", 9, 14], ["step", 14, 19], ["step", 19, 24], ["end", 24, 32]]);
  assert.deepEqual(data.timeline[2].events.map((e) => [e.at, e.type, e.step]), [[9.1, "step-start", "J0.1"], [9.9, "step-end", "J0.1"], [10, "step-start", "J0.2"], [11.5, "step-end", "J0.2"], [12, "test-end", undefined]]);
  // Where each step shows: its test.step, or the start of its test, or its card
  assert.deepEqual(data.steps[0].tests.map((x) => x.at), [5, 9.1]);
  assert.deepEqual(data.steps[1].tests.map((x) => x.at), [10, undefined]);
  assert.equal(data.steps[2].at, 14);
});

test("a step with no UI test and an untested reason, or tests that didn't run, is said so", () => {
  const reg = registry();
  reg.journeys[0].steps[2] = { id: "J0.3", text: "Pay.", status: "built", untested: "needs a real card" };
  const [plan] = planVideos(reg, [t("a.spec.js", 3, "opens", ["J0.1"])], ["J0"]);
  const steps = stepResults(plan, new Map());
  assert.deepEqual(steps.map((s) => s.result), ["skipped", "backend", "untested", "planned"]);
  assert.equal(steps[0].tests[0].error, "didn't run");
  assert.deepEqual(clipsFor(plan, steps, new Map()).map((c) => c.kind), ["title", "step", "step", "step", "end"]);
});

test("cards show the step text plain, the results and what's simulated", () => {
  const reg = registry();
  const j = { ...reg.journeys[0], status: "Partly built" };
  assert.match(titleCard(j, { viewport: "phone", build: "web", commit: "abc1234", date: "2026-09-29", tests: 1 }), /The 1 automated test that prove.*a phone \(iPhone 13 in Chromium\).*Commit abc1234\./s);
  assert.match(stepCard(j, { id: "J0.3", text: "Pay.", result: "backend", backendTests: ["backend/test/pay.test.ts"], simulated: "Stripe" }), /Backend tests.*Simulated.*<li>backend\/test\/pay\.test\.ts<\/li>/s);
  assert.match(stepCard(j, { id: "J0.4", text: "Sign.", result: "planned", beads: ["supply-checkout-sig"] }), /Not built yet\. Planned in supply-checkout-sig\./);
  assert.match(stepCard(j, { id: "J0.4", text: "Sign.", result: "untested", untested: "a <real> card" }), /No automated test yet: a &lt;real&gt; card/);
  const failed = Array.from({ length: 6 }, (_, k) => ({ title: `t${k}`, result: "failed" }));
  const html = endCard(j, [{ id: "J0.1", text: "Open a **sheet**.", result: "failed", tests: [...failed, { title: "ok", result: "passed" }] }], { passed: 0, failed: 1 });
  assert.match(html, /Steps: <span class="count">1<\/span> failed/);
  assert.match(html, /Open a sheet\. <span class="small">\(1 passed, 6 failed of 7 tests\)/);
  assert.match(html, /<li>t3<\/li><li>and 2 more<\/li>/);
  assert.equal(plain("Tap **Save** in `Billing`"), "Tap Save in Billing");
});

test("an assertion's error is one line: the matcher, and what it expected and got", () => {
  assert.equal(errorSummary("Error: \u001b[2mexpect(\u001b[22mreceived).toContain(expected) // indexOf\n\nExpected substring:  \"a\"\nReceived string:    \"b\""), "expect(received).toContain(expected) · Expected substring: \"a\" · Received string: \"b\"");
  assert.equal(errorSummary(undefined), "");
  assert.equal(errorSummary("x".repeat(300)).length, 240);
});

test("the viewports and the command's options", () => {
  assert.deepEqual(frame("desktop").video, { width: 1280, height: 804 });
  assert.deepEqual(frame("phone").page, { width: 390, height: 776 });
  assert.deepEqual(frame("phone").video, { width: 780, height: 1552 });
  assert.throws(() => frame("tv"), /desktop or phone/);
  assert.deepEqual(parseArgs([]), { headless: false, only: null, pace: 1, slowMo: 0, build: true, viewport: "desktop" });
  assert.deepEqual(parseArgs(["--only", "j4,J7", "--only=J1", "--headless", "--pace=0.3", "--slow-mo", "50", "--viewport", "phone", "--skip-build"]), { headless: true, only: ["J4", "J7", "J1"], pace: 0.3, slowMo: 50, build: false, viewport: "phone" });
  assert.deepEqual(parseArgs(["-h"]), { help: true });
  assert.throws(() => parseArgs(["--pace", "0"]), /--pace must be a number above 0/);
  assert.throws(() => parseArgs(["--slow-mo", "-1"]), /--slow-mo must be 0 or more/);
  assert.throws(() => parseArgs(["--viewport", "tv"]), /--viewport is desktop or phone/);
  assert.throws(() => parseArgs(["--only"]), /--only needs a value/);
  assert.throws(() => parseArgs(["--loud"]), /Unknown option --loud/);
});

// ---------------------------------------------------------------------------
// WebM: small files built by hand, with the structure Playwright's ffmpeg writes

const vint = (n, len) => { const b = Buffer.alloc(len); let v = n; for (let i = len - 1; i >= 0; i--) { b[i] = v & 0xff; v = Math.floor(v / 256); } b[0] |= 0x80 >> (len - 1); return b; };
const idOf = (id) => { const out = []; while (id > 0) { out.unshift(id & 0xff); id = Math.floor(id / 256); } return Buffer.from(out); };
const el = (id, ...body) => { const data = Buffer.concat(body); return Buffer.concat([idOf(id), vint(data.length, 4), data]); };
const uint = (id, n, len = 2) => el(id, Buffer.from(vint(n, len).map((b, i) => (i ? b : b & (0xff >> len)))));
const block = (time, key) => { const b = Buffer.alloc(4 + 3); b[0] = 0x81; b.writeInt16BE(time, 1); b[3] = key ? 0x80 : 0; return el(0xa3, b); };
function webm(clusters, { scale = 1e6, unknownCluster = false } = {}) {
  const info = el(0x1549a966, uint(0x2ad7b1, scale, 4), el(0x4489, Buffer.alloc(8)));
  const tracks = el(0x1654ae6b, el(0xae, uint(0xd7, 1, 1)));
  const body = clusters.map(([timecode, blocks]) => {
    const inner = Buffer.concat([uint(0xe7, timecode), uint(0xab, 5), ...blocks.map(([time, key]) => block(time, key))]);
    return unknownCluster ? Buffer.concat([idOf(0x1f43b675), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), inner]) : el(0x1f43b675, inner);
  });
  const segment = Buffer.concat([info, tracks, ...body, el(0x1c53bb6b)]);
  return Buffer.concat([el(0x1a45dfa3, uint(0x4286, 1, 1)), idOf(0x18538067), Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), segment]);
}

test("WebM videos are joined end to end, with their timestamps moved along and cues for seeking", () => {
  const dir = mkdtempSync(join(tmpdir(), "webm-"));
  const a = join(dir, "a.webm"), b = join(dir, "b.webm"), out = join(dir, "out.webm");
  writeFileSync(a, webm([[0, [[0, true], [40, false]]], [80, [[0, false], [40, false]]]]));
  writeFileSync(b, webm([[0, [[0, true]]], [40, [[0, true], [40, false]]]], { unknownCluster: true }));
  assert.equal(webmDuration(a), 0.16);
  assert.equal(webmDuration(b), 0.12);
  assert.deepEqual(concatWebm([a, b], out), { starts: [0, 0.16], duration: 0.28 });
  const bytes = readFileSync(out);
  const joined = parseWebm(bytes);
  assert.deepEqual(joined.clusters.map((c) => [c.timecode, c.key]), [[0, true], [80, false], [160, true], [200, true]]);
  assert.equal(joined.duration, 280);
  assert.equal(joined.track, 1);
  // Duration, seek head and cues: the joined file says how long it is and where its keyframes are
  assert.deepEqual(cueTimes(bytes), [0, 160, 200], "a cue point for each cluster that starts with a keyframe");
  const other = join(dir, "c.webm");
  writeFileSync(other, webm([[0, [[0, true]]]], { scale: 1e5 }));
  assert.throws(() => concatWebm([a, other], out), /different timestamp scale/);
  assert.throws(() => concatWebm([], out), /No videos to join/);
  assert.throws(() => parseWebm(Buffer.from([0x00, 0x01])), /Not a WebM element/);
  assert.throws(() => parseWebm(el(0x1a45dfa3)), /Not a WebM file/);
});

// The joined file's cue times: its Cues element is last, and every size in it takes 8 bytes
function cueTimes(buf) {
  const times = [];
  let pos = buf.lastIndexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])) + 12;
  while (pos < buf.length) {
    assert.equal(buf[pos], 0xbb);
    const size = Number(buf.readBigUInt64BE(pos + 1) & 0xffffffffffffffn);
    // CueTime is the cue point's first child: ID, size, then the time
    times.push(Number(buf.readBigUInt64BE(pos + 9 + 9)));
    pos += 9 + size;
  }
  return times;
}
