// The prod journey suite (supply-checkout-o60, docs/journey-tests-plan.md): tests/prod/*.prod.js
// against the live app at https://app.supplycheckout.com, as the long-lived test accounts and the
// run's throwaway accounts, never anything else.
//
//   npx playwright test --config playwright.prod.config.mjs --list   (PR CI: the specs load)
//
// Running it for real needs the production-journeys environment's secrets and either a GitHub
// Actions run or JOURNEYS_PROD_OPT_IN=run-against-prod; tests/prod/global-setup.mjs refuses
// otherwise, before anything signs in. The journeys workflow (supply-checkout-o60.6) runs it,
// then scripts/journeys/cleanup.mjs, then scripts/journeys/upload-results.mjs, then
// scripts/journeys/prod-summary.mjs.
//
// - Only the prod app's URL: tests/prod/global-setup.mjs checks every project's baseURL.
// - Desktop Chrome and iPhone Safari only (owner decision 11), one worker each.
// - retries 1; a test that passes on its retry is flaky in the summary.
// - Traces are off here: the fixtures start tracing only after sign-in, so no password or
//   two-step code is in a trace, and keep one only for a failed test. Traces, videos and
//   screenshots stay in the run's temporary directory until upload-results.mjs puts them in the
//   private results bucket; they are never Actions artifacts.
// - The list reporter and a JSON report (for prod-summary.mjs), no html or github reporter.
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { PROD, runDir, runId } from "./scripts/journeys/lib/config.mjs";

// One run ID for the main process and every worker (workers inherit the environment)
if (!process.env.GITHUB_RUN_ID && !process.env.JOURNEYS_RUN_ID) process.env.JOURNEYS_RUN_ID = runId(process.env);
const dir = runDir(process.env, runId(process.env));

export default defineConfig({
  testDir: "tests/prod",
  testMatch: "**/*.prod.js",
  outputDir: path.join(dir, "test-results"),
  globalSetup: "./tests/prod/global-setup.mjs",
  fullyParallel: false,
  workers: 2,
  forbidOnly: true,
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["json", { outputFile: path.join(dir, "report.json") }]],
  use: {
    baseURL: PROD.app,
    trace: "off",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "iphone-safari", use: { ...devices["iPhone 13"] } },
  ],
});
