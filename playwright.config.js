import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  globalSetup: "./tests/global-setup.js",
  globalTeardown: "./tests/coverage-teardown.js",
  fullyParallel: true,
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
