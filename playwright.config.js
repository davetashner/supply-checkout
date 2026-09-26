import { availableParallelism, totalmem } from "node:os";
import { defineConfig, devices } from "@playwright/test";

// Each worker runs its own browser, and a WebKit worker can take over a gigabyte.
// Locally, use one worker per 8 GB of RAM and at most half the cores, so a run
// leaves room for everything else. --workers overrides it. CI keeps the default.
const localWorkers = Math.max(1, Math.min(Math.floor(availableParallelism() / 2), Math.floor(totalmem() / 2 ** 33)));

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
  ],
});
