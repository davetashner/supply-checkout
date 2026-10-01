// What goes into each journey video, in what order, and what the sidecar JSON says about it
// (record.mjs). Kept free of Playwright and the file system, for journey-videos.test.mjs.
import { journeyStatus } from "../journeys.mjs";
import { errorSummary } from "./director.mjs";

const STEP_TAG = /^J\d+\.\d+$/;
export const testKey = (t) => `${t.file}:${t.line}:${t.title}`;
export const journeySlug = (j) => `${j.id}-${j.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

// The journeys to record (every one that isn't phase 2, or those in `only`), each with the tests
// tagged with its steps: ordered by the first of the journey's steps each proves, then by file and line
export function planVideos(registry, tests, only = null) {
  const ids = registry.journeys.map((j) => j.id);
  const unknown = (only || []).filter((id) => !ids.includes(id));
  if (unknown.length) throw new Error(`No journey ${unknown.join(", ")}. There are ${ids.join(", ")}.`);
  const phase2 = registry.journeys.filter((j) => j.phase2 && only?.includes(j.id)).map((j) => j.id);
  if (phase2.length) throw new Error(`${phase2.join(", ")} is phase 2: none of its steps are built yet`);
  return registry.journeys.filter((j) => (only ? only.includes(j.id) : !j.phase2)).map((journey) => {
    const order = journey.steps.map((s) => s.id);
    const mine = tests
      .map((t) => ({ ...t, ids: t.tags.filter((tag) => STEP_TAG.test(tag) && order.includes(tag)) }))
      .filter((t) => t.ids.length)
      .map((t) => ({ ...t, step: Math.min(...t.ids.map((id) => order.indexOf(id))) }))
      .sort((a, b) => a.step - b.step || a.file.localeCompare(b.file) || a.line - b.line || a.title.localeCompare(b.title));
    return { journey, tests: mine };
  });
}

// Playwright's --grep for the tests of these journeys' steps (it matches titles with their tags)
export function grepFor(plans) {
  const ids = plans.map((p) => p.journey.id.slice(1));
  return `@J(?:${ids.join("|")})\\.\\d+(?!\\d)`;
}

// Each test's result from Playwright's JSON report: status, first error, its video and the
// fixture's events (tests/journey-video.js)
export function readReport(report, longest = (videos) => videos[0]) {
  const results = new Map();
  const walk = (suite, titles) => {
    for (const spec of suite.specs || []) {
      const title = [...titles, spec.title].join(" › ");
      const run = spec.tests?.[0]?.results?.at(-1);
      if (!run) continue;
      // A test that opens another page (a new tab) has a video of each; `longest` picks the test's
      // own page's, which is open from the start to the end
      const videos = (run.attachments || []).filter((a) => a.name === "video" && a.path).map((a) => a.path);
      const video = videos.length > 1 ? longest(videos) : videos[0] || null;
      const raw = run.attachments?.find((a) => a.name === "journey-video-events")?.body;
      const events = raw ? JSON.parse(Buffer.from(raw, "base64").toString("utf8")).events : [];
      const end = events.find((e) => e.type === "test-end");
      const status = end?.status ?? (run.status === "passed" ? "passed" : run.status === "skipped" ? "skipped" : "failed");
      const error = end?.error ?? errorSummary(run.errors?.[0]?.message ?? run.error?.message);
      // With --evidence: Playwright's trace, and the fixture's screenshots at the end of each step
      // and of the test (journey-shot-<n>, named by the events' `shot`)
      const trace = run.attachments?.find((a) => a.name === "trace" && a.path)?.path;
      const shots = Object.fromEntries((run.attachments || []).filter((a) => /^journey-shot-\d+$/.test(a.name) && a.path).map((a) => [a.name.slice(13), a.path]));
      results.set(testKey({ file: `tests/${spec.file}`, line: spec.line, title }), {
        status, error: status === "failed" ? error || run.status : undefined, video, events,
        ...(trace ? { trace } : {}), ...(Object.keys(shots).length ? { shots } : {}),
      });
    }
    for (const child of suite.suites || []) walk(child, [...titles, child.title]);
  };
  for (const file of report.suites || []) walk(file, []);
  return results;
}

// A test's result for one step: its test.step named for the step if it has one, else the test's
function stepResultOf(result, id) {
  if (!result) return { result: "skipped", error: "didn't run" };
  if (result.status === "skipped") return { result: "skipped" };
  const end = result.events.find((e) => e.type === "step-end" && e.id === id);
  if (end) return { result: end.status, ...(end.error ? { error: end.error } : {}) };
  return { result: result.status, ...(result.error ? { error: result.error } : {}) };
}

// Each of the journey's steps, with its result: passed or failed (its tests), planned (not built
// yet), backend (built, with backend tests only), untested, or skipped (its tests didn't run)
export function stepResults(plan, results) {
  return plan.journey.steps.map((s) => {
    const base = { id: s.id, text: s.text, status: s.status, ...(s.simulated ? { simulated: s.simulated } : {}), ...(s.beads?.length ? { beads: s.beads } : {}), backendTests: s.tests || [] };
    if (s.status === "planned") return { ...base, result: "planned", tests: [] };
    const tests = plan.tests.filter((t) => t.ids.includes(s.id)).map((t) => ({ file: t.file, line: t.line, title: t.title, ...stepResultOf(results.get(testKey(t)), s.id) }));
    if (!tests.length) return { ...base, result: s.untested ? "untested" : "backend", ...(s.untested ? { untested: s.untested } : {}), tests };
    const result = tests.some((t) => t.result === "failed") ? "failed" : tests.some((t) => t.result === "passed") ? "passed" : "skipped";
    return { ...base, result, tests };
  });
}

export function summarize(steps) {
  const count = (f) => steps.filter(f).length;
  return {
    passed: count((s) => s.result === "passed"),
    failed: count((s) => s.result === "failed"),
    simulated: count((s) => s.simulated && s.status === "built"),
    planned: count((s) => s.result === "planned"),
    backend: count((s) => s.result === "backend"),
    untested: count((s) => s.result === "untested"),
    skipped: count((s) => s.result === "skipped"),
  };
}

// The clips in the video, in order: the title card, then for each step its tests (each test at
// the first of the journey's steps it proves) or a card for a step with nothing to show on
// screen, then the end card. A test with no video (skipped, or it never opened a page) is left out.
export function clipsFor(plan, steps, results) {
  const clips = [{ kind: "title" }];
  for (const [k, step] of steps.entries()) {
    const tests = plan.tests.filter((t) => t.step === k);
    if (!tests.length) {
      if (step.result !== "skipped") clips.push({ kind: "step", step: step.id });
      continue;
    }
    for (const t of tests) {
      const r = results.get(testKey(t));
      if (r?.video && r.status !== "skipped") clips.push({ kind: "test", test: t, video: r.video });
    }
  }
  clips.push({ kind: "end" });
  return clips;
}

// The traces and screenshots to keep (they're in the run's scratch folder): each test's files
// named evidence/t<n>-trace.zip and evidence/t<n>-shot-<k>.jpg, n counting the tests from 1.
// Returns the copies to make, [from, to], and the results with those names in place of the paths.
export function evidenceFiles(results) {
  const copies = [];
  const out = new Map();
  let n = 0;
  for (const [key, r] of results) {
    n++;
    const next = { ...r };
    if (r.trace) {
      next.trace = `evidence/t${n}-trace.zip`;
      copies.push([r.trace, next.trace]);
    }
    if (r.shots) {
      next.shots = Object.fromEntries(Object.entries(r.shots).map(([k, path]) => {
        const to = `evidence/t${n}-shot-${k}.jpg`;
        copies.push([path, to]);
        return [k, to];
      }));
    }
    out.set(key, next);
  }
  return { copies, results: out };
}

const round = (n) => Math.round(n * 100) / 100;

// The sidecar: the journey, each step's result with its tests and where each shows in the video,
// and the video's timeline. `starts` are the clips' start times in the video, in seconds.
export function sidecar({ plan, steps, clips, starts, duration, results, video, meta }) {
  const j = plan.journey;
  const end = (k) => round(k + 1 < starts.length ? starts[k + 1] : duration);
  const timeline = clips.map((c, k) => {
    const at = { start: round(starts[k]), end: end(k) };
    if (c.kind !== "test") return { kind: c.kind, ...(c.step ? { step: c.step } : {}), ...at };
    const r = results.get(testKey(c.test));
    return {
      kind: "test", file: c.test.file, line: c.test.line, title: c.test.title, steps: c.test.ids, result: r.status, ...(r.error ? { error: r.error } : {}), ...at,
      ...(r.trace ? { trace: r.trace } : {}),
      events: r.events.map((e) => ({
        at: round(starts[k] + e.t / 1000), type: e.type, ...(e.id ? { step: e.id } : {}), ...(e.status ? { status: e.status } : {}), ...(e.error ? { error: e.error } : {}),
        ...(e.shot !== undefined && r.shots?.[e.shot] ? { shot: r.shots[e.shot] } : {}),
      })),
    };
  });
  // A step's screenshot in a test: at the end of its test.step, else at the end of the test
  const evidenceFor = (step, test) => {
    const r = results.get(testKey(test));
    if (!r) return {};
    const shotEvent = r.events.find((e) => e.type === "step-end" && e.id === step && e.shot !== undefined) ?? r.events.find((e) => e.type === "test-end" && e.shot !== undefined);
    const shot = shotEvent && r.shots?.[shotEvent.shot];
    return { ...(shot ? { shot } : {}), ...(r.trace ? { trace: r.trace } : {}) };
  };
  const atFor = (step, test) => timeline.find((x) => x.kind === "test" && x.file === test.file && x.line === test.line && x.title === test.title)
    ?.events.find((e) => e.type === "step-start" && e.step === step)?.at
    ?? timeline.find((x) => x.kind === "test" && x.file === test.file && x.line === test.line && x.title === test.title)?.start;
  return {
    journey: { id: j.id, name: j.name, persona: j.persona, critical: j.critical, status: journeyStatus(j) },
    video,
    ...meta,
    duration: round(duration),
    summary: summarize(steps),
    steps: steps.map((s) => ({
      ...s,
      ...(timeline.find((x) => x.kind === "step" && x.step === s.id) ? { at: timeline.find((x) => x.kind === "step" && x.step === s.id).start } : {}),
      tests: s.tests.map((t) => ({ ...t, ...(atFor(s.id, t) !== undefined ? { at: atFor(s.id, t) } : {}), ...evidenceFor(s.id, t) })),
    })),
    timeline,
  };
}
