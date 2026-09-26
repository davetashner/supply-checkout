import { buildApp, currentBuild } from "../scripts/builds.mjs";
import { enabled, report } from "./coverage.js";
import { acquireRunLock } from "./run-lock.js";

// Wait for any other run on this machine, build the app under test (BUILD=artifact
// or BUILD=web), and start each coverage run from an empty cache.
export default async function globalSetup() {
  await acquireRunLock();
  await buildApp(currentBuild());
  if (enabled) report().cleanCache();
}
