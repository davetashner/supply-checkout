import { test as base, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { builtFiles, currentBuild } from "../scripts/builds.mjs";
import { installMockClaude } from "./mock-claude.js";
import * as coverage from "./coverage.js";
import * as journeyVideo from "./journey-video.js";
import { modal } from "./ui/app.js";

const ORIGIN = "https://supply-checkout.test/";
// Fonts and CDN scripts, which openApp aborts to keep tests hermetic
const ABORTED = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

// The console error a browser logs for a request openApp aborted. Chromium and
// WebKit say "Failed to load resource"; Firefox reports an aborted cross-origin
// stylesheet as "Cross-Origin Request Blocked … (Reason: CORS request did not
// succeed)", with the URL, so that error is only ignored for an aborted URL.
const isAbortedRequest = (text) =>
  /Failed to load resource/.test(text) ||
  (/Cross-Origin Request Blocked/.test(text) && (text.match(/https:\/\/[^\s"]+/g) || []).some((url) => ABORTED.test(url)));
// Console errors a test expects, by page (see allowConsoleError)
const allowed = new WeakMap();

/**
 * Lets one test's page log a console error it causes on purpose, matched by
 * `pattern`. Keep the pattern as narrow as the error: every other console error
 * still fails the test.
 */
export function allowConsoleError(page, pattern) {
  allowed.set(page, [...(allowed.get(page) ?? []), pattern]);
}
const isAllowed = (page, text) => (allowed.get(page) ?? []).some((pattern) => pattern.test(text));

// Notes a page crash, a page closed before the test ended, and a lost browser
// as a "lifecycle" annotation on the test and a line on stderr. stop() at the
// end of the test, before the fixtures close the page themselves.
function lifecycleLog(page, testInfo) {
  const started = Date.now();
  const note = (what) => {
    const description = `${what} ${((Date.now() - started) / 1000).toFixed(1)} s into the test`;
    testInfo.annotations.push({ type: "lifecycle", description });
    process.stderr.write(`[${testInfo.project.name}] ${testInfo.titlePath.slice(1).join(" › ")}: ${description}\n`);
  };
  const onCrash = () => note("page crashed");
  const onClose = () => note("page closed");
  const onDisconnect = () => note("browser disconnected");
  const browser = page.context().browser();
  page.on("crash", onCrash);
  page.on("close", onClose);
  browser?.on("disconnected", onDisconnect);
  return {
    stop() {
      page.off("crash", onCrash);
      page.off("close", onClose);
      browser?.off("disconnected", onDisconnect);
    },
  };
}

// The build under test (BUILD=web), built by tests/global-setup.js
const files = builtFiles(currentBuild());

// Every test fails on an uncaught exception or console error in the page.
export const test = base.extend({
  page: async ({ page, browserName }, use, testInfo) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      // Aborted font/CDN requests are expected in tests
      if (m.type() === "error" && !isAbortedRequest(m.text()) && !isAllowed(page, m.text())) errors.push(`console: ${m.text()}`);
    });
    // Only Chromium reports JS coverage
    const measure = coverage.enabled && browserName === "chromium";
    if (measure) await page.coverage.startJSCoverage({ resetOnNavigation: false });
    // Only while recording journey videos (JOURNEY_VIDEO=1, npm run journeys:video)
    const video = journeyVideo.enabled ? await journeyVideo.start(page, testInfo) : null;
    // A page or browser that goes away under a test fails it with only "Target
    // page, context or browser has been closed". Say which, and when, in the
    // report and the log (see "Browsers that go away mid-test" in docs/testing.md).
    const lost = lifecycleLog(page, testInfo);
    await use(page);
    lost.stop();
    if (video) await journeyVideo.finish(video, testInfo, errors);
    if (measure) await coverage.report().add(await page.coverage.stopJSCoverage());
    expect(errors, "page errors").toEqual([]);
  },
});
journeyVideo.wrapSteps(test);
export { expect };

export async function openApp(page, opts = {}) {
  // Keep tests hermetic: no fonts.
  await page.route(ABORTED, (r) => r.abort());
  await page.route(ORIGIN + "**", (r) => {
    const file = files.get(new URL(r.request().url()).pathname);
    return file ? r.fulfill(file) : r.fulfill({ status: 404 });
  });
  // The marketing clips' crew (tests/journey-video.js): the signed-in user, and the teammate
  // seeded as "Sam" (a name typed on the project, which the web build has no profile for)
  const { persona } = journeyVideo;
  if (persona) opts = { userName: persona.user, avatarUrl: persona.avatarUrl, ...opts, names: { Sam: persona.crew, [persona.crew]: persona.crew, ...opts.names } };
  await page.addInitScript(installMockClaude, opts);
  await page.goto(ORIGIN);
}

/**
 * The open modal's accessibility violations (WCAG 2.1 A and AA), by rule ID.
 * A modal rises into place from 0.6 opacity (`.modal`'s "rise" animation in
 * the app's CSS), and axe's colour-contrast rule reads a half-faded modal as
 * low contrast, so this waits for the modal's animations to finish first.
 */
export async function modalViolations(page) {
  await modal(page).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const { violations } = await new AxeBuilder({ page }).include("#modal").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return violations.map((v) => v.id);
}
