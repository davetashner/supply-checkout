// Journey videos (npm run journeys:video, scripts/journey-videos/record.mjs) record the tests
// tagged with a journey's steps. Only while JOURNEY_VIDEO=1, which that command sets for its
// own Playwright run, each test's page gets the overlay in scripts/journey-videos/director.mjs:
// a caption banner with the test's step IDs and the registry's text for them, a drawn cursor
// that glides to each element the test acts on, and the result of each step (a test.step named
// for a step, "J4.2 …") and of the test. Nothing here runs in a normal test run.
//
// The events (each step's start and end, and the result) go to the test's attachments as
// journey-video-events, with times in ms from when the page opened, which is when its video starts.
import { readFileSync } from "node:fs";

export const enabled = process.env.JOURNEY_VIDEO === "1";

const STEP = /^J\d+\.\d+$/;
const STEP_TITLE = /^(J\d+\.\d+)\b/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let options, steps, director, current = null;

async function setup() {
  if (director) return;
  director = await import("../scripts/journey-videos/director.mjs");
  options = { pace: 1, viewport: "desktop", ...JSON.parse(process.env.JOURNEY_VIDEO_OPTIONS || "{}") };
  const registry = JSON.parse(readFileSync(new URL("../journeys/registry.json", import.meta.url), "utf8"));
  steps = new Map(registry.journeys.flatMap((j) => j.steps.map((s) => [s.id, s])));
}

const ms = (base) => Math.round(base * options.pace);
const firstLine = (e) => director.errorSummary(e?.message ?? e);

class Recorder {
  constructor(page, testInfo) {
    this.page = page;
    this.started = Date.now();
    this.events = [];
    this.ids = testInfo.tags.map((t) => t.replace(/^@/, "")).filter((t) => STEP.test(t));
    this.test = `${testInfo.file.split(/[\\/]/).pop()}: ${testInfo.titlePath.slice(1).join(" › ")}`;
    this.state = this.caption(this.ids, "running");
    this.testInfo = testInfo;
    this.shots = [];
  }

  caption(ids, state, note) {
    const known = ids.map((id) => steps.get(id)).filter(Boolean);
    const simulated = known.map((s) => s.simulated).filter(Boolean);
    return {
      id: ids.join(" · ") || "Test",
      test: this.test,
      step: known.map((s) => director.plain(s.text)).join(" Then: ") || "",
      note: note ?? (simulated.length ? `Simulated: ${simulated.join("; ")}` : ""),
      state,
    };
  }

  async show(state) {
    this.state = state;
    await this.page.evaluate((s) => window.__jv?.caption(s), state).catch(() => {});
  }

  event(e) {
    const event = { t: Date.now() - this.started, ...e };
    this.events.push(event);
    return event;
  }

  // With --evidence (the release evidence pack), a screenshot of the page, caption and all, as a
  // step or the test ends. The event names it by its number: attachment journey-shot-<n>
  async shot(event) {
    if (!options.evidence) return;
    const path = this.testInfo.outputPath(`journey-shot-${this.shots.length}.jpg`);
    try {
      await this.page.screenshot({ path, type: "jpeg", quality: 55, scale: "css" });
    } catch {
      return; // The page has closed or is navigating: the video still shows it
    }
    event.shot = this.shots.length;
    this.shots.push(path);
  }

  async stepStart(id, title) {
    this.event({ type: "step-start", id, title });
    await this.show(this.caption([id], "running"));
    await sleep(ms(1200));
  }

  async stepEnd(id, title, error) {
    const event = this.event({ type: "step-end", id, title, status: error ? "failed" : "passed", ...(error ? { error: firstLine(error) } : {}) });
    await this.show(this.caption([id], error ? "failed" : "passed", error ? firstLine(error) : undefined));
    await this.shot(event);
    await sleep(ms(error ? 2000 : 900));
  }

  async finish(testInfo, pageErrors) {
    const skipped = testInfo.status === "skipped";
    const passed = !skipped && testInfo.status === testInfo.expectedStatus && !pageErrors.length;
    const status = skipped ? "skipped" : passed ? "passed" : "failed";
    const error = status === "failed" ? firstLine(testInfo.errors[0]?.message || testInfo.error?.message || pageErrors[0] || testInfo.status) : "";
    const event = this.event({ type: "test-end", status, ...(error ? { error } : {}) });
    await this.show(this.caption(this.ids, status, error || undefined));
    await this.shot(event);
    for (const [n, path] of this.shots.entries()) await testInfo.attach(`journey-shot-${n}`, { path, contentType: "image/jpeg" });
    await sleep(ms(status === "failed" ? 3000 : 1500));
    await testInfo.attach("journey-video-events", { contentType: "application/json", body: JSON.stringify({ test: this.test, ids: this.ids, events: this.events }) });
  }
}

// Called from the page fixture, before the test
export async function start(page, testInfo) {
  await setup();
  const v = director.VIEWPORTS[options.viewport];
  await page.context().addInitScript(director.installOverlay, { banner: v.banner, compact: options.viewport === "phone" });
  patchLocator(page);
  const recorder = new Recorder(page, testInfo);
  // A new document gets the overlay from the init script; this puts the caption back
  page.on("domcontentloaded", () => recorder.show(recorder.state));
  current = recorder;
  return recorder;
}

export async function finish(recorder, testInfo, pageErrors) {
  try {
    await recorder.finish(testInfo, pageErrors);
  } finally {
    current = null;
  }
}

// test.step blocks named for a step ("J4.2 Scan an item") change the caption, and show whether
// they passed. Other steps run as they are.
export function wrapSteps(test) {
  if (!enabled) return;
  const step = test.step;
  const wrapped = (title, body, ...rest) => {
    const id = STEP_TITLE.exec(title)?.[1];
    if (!id) return step.call(test, title, body, ...rest);
    return step.call(test, title, async (...args) => {
      const recorder = current;
      await recorder?.stepStart(id, title);
      let result;
      try {
        result = await body(...args);
      } catch (error) {
        await recorder?.stepEnd(id, title, error);
        throw error;
      }
      await recorder?.stepEnd(id, title);
      return result;
    }, ...rest);
  };
  Object.assign(wrapped, step);
  test.step = wrapped;
}

// Each action on a locator first glides the drawn cursor to the element, so the video shows what
// the test does. Only the drawing waits; the action itself is Playwright's, unchanged.
const ACTIONS = { click: true, dblclick: true, tap: true, check: true, uncheck: true, setChecked: true, selectOption: true, setInputFiles: true, fill: false, pressSequentially: false, type: false, press: false, hover: false, clear: false };

async function pointAt(locator, click) {
  const recorder = current;
  // A second page (a new tab) isn't in the video
  if (!recorder || pointAt.busy || locator.page() !== recorder.page) return;
  pointAt.busy = true;
  try {
    const box = await locator.boundingBox({ timeout: 1500 });
    if (!box) return;
    const glide = ms(450);
    await recorder.page.evaluate(([x, y, t, c]) => window.__jv?.point(x, y, t, c), [box.x + box.width / 2, box.y + box.height / 2, glide, click]);
    await sleep(glide + ms(click ? 150 : 50));
  } catch {
    // Not there yet, more than one match, or the page is navigating: the action says so itself
  } finally {
    pointAt.busy = false;
  }
}

function patchLocator(page) {
  const proto = Object.getPrototypeOf(page.locator("html"));
  if (proto.__jvPatched) return;
  proto.__jvPatched = true;
  for (const [name, click] of Object.entries(ACTIONS)) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    proto[name] = async function (...args) {
      await pointAt(this, click);
      const result = await original.apply(this, args);
      if (current && !pointAt.busy) await sleep(ms(250));
      return result;
    };
  }
}
