import { WITH_WEB, buildApp, currentBuild } from "../scripts/builds.mjs";
import { enabled, report } from "./coverage.js";
import { acquireRunLock } from "./run-lock.js";

// Wait for any other run on this machine, build the app under test (BUILD=web,
// which also builds the demo, the operator page and the home page), and start each coverage run from an
// empty cache.
export default async function globalSetup() {
  await acquireRunLock();
  await buildApp(currentBuild());
  for (const build of WITH_WEB) await buildApp(build);
  if (enabled) report().cleanCache();
}
