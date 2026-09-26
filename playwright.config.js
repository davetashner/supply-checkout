import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  globalSetup: "./tests/coverage-setup.js",
  globalTeardown: "./tests/coverage-teardown.js",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "iphone-safari", use: { ...devices["iPhone 13"] } },
  ],
});
