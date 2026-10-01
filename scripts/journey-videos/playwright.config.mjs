// The Playwright run that records journey videos: only npm run journeys:video (record.mjs) uses
// it, never CI. It runs the tests one at a time in one Chromium, each recorded to its own video,
// with the journey overlay on (JOURNEY_VIDEO=1, tests/journey-video.js). record.mjs holds the
// Playwright run lock (tests/run-lock.js) and builds the app before it starts this run, so this
// config has no global setup of its own.
import { defineConfig, devices } from "@playwright/test";
import { frame } from "./director.mjs";

const options = JSON.parse(process.env.JOURNEY_VIDEO_OPTIONS || "{}");
const { page, video, device } = frame(options.viewport || "desktop");
// The device's screen, touch and user agent, in Chromium whatever the device's own browser
const emulate = { ...devices[device] };
delete emulate.defaultBrowserType;

export default defineConfig({
  testDir: "../../tests",
  outputDir: options.outputDir || "../../test-results/journey-videos",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // The cursor and captions add pauses to every test
  timeout: 300_000,
  reporter: [["list"], ["json", { outputFile: options.report || "../../test-results/journey-videos/report.json" }]],
  use: {
    browserName: "chromium",
    headless: options.headless ?? false,
    ...emulate,
    viewport: page,
    video: { mode: "on", size: video },
    // The release evidence pack (--evidence) keeps each test's trace, without its screenshots: the video has those
    trace: options.evidence ? { mode: "on", screenshots: false } : "off",
    launchOptions: { slowMo: options.slowMo ?? 0 },
  },
  projects: [{ name: `journey-video-${options.viewport || "desktop"}` }],
});
