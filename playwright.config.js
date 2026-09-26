import { existsSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { defineConfig, devices } from "@playwright/test";

// Each worker runs its own browser, and a WebKit worker can take over a gigabyte.
// Locally, use one worker per 8 GB of RAM and at most half the cores, so a run
// leaves room for everything else. --workers overrides it. CI keeps the default.
const localWorkers = Math.max(1, Math.min(Math.floor(availableParallelism() / 2), Math.floor(totalmem() / 2 ** 33)));

// Branded Microsoft Edge is a system install (npx playwright install msedge, which
// needs admin rights), unlike Playwright's own browsers. CI always installs and runs
// it; elsewhere it runs when Edge is installed in its standard place.
const EDGE_PATHS = {
  darwin: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  linux: "/opt/microsoft/msedge/msedge",
  win32: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
};
const edge = !!process.env.CI || existsSync(EDGE_PATHS[process.platform] ?? "");

export default defineConfig({
  testDir: "tests",
  globalSetup: "./tests/global-setup.js",
  globalTeardown: "./tests/coverage-teardown.js",
  fullyParallel: true,
  workers: process.env.CI ? undefined : localWorkers,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A test that fails and then passes on retry fails the run, so flakiness gets fixed
  failOnFlakyTests: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "iphone-safari", use: { ...devices["iPhone 13"] } },
    // The other supported desktop browsers (browserslist in package.json). They run
    // against the web build only (npm run test:web); the artifact is for claude.ai.
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "desktop-safari", use: { ...devices["Desktop Safari"] } },
    ...(edge ? [{ name: "desktop-edge", use: { ...devices["Desktop Edge"], channel: "msedge" } }] : []),
    // Phones and tablets, against the web build only. Android Chrome also covers
    // Samsung Internet (the same Blink engine); Firefox for Android can't be
    // automated, so it's covered by desktop-firefox (Gecko) and the real-device
    // release check in README.md.
    { name: "android-chrome", use: { ...devices["Pixel 7"] } },
    { name: "android-chrome-landscape", use: { ...devices["Pixel 7 landscape"] } },
    // 360px wide, the most common Android width
    { name: "galaxy-chrome", use: { ...devices["Galaxy S24"] } },
    { name: "ipad-safari", use: { ...devices["iPad Mini"] } },
    { name: "ipad-safari-landscape", use: { ...devices["iPad Mini landscape"] } },
  ],
});
