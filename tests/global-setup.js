import { DEMO, OPS, SITE, buildApp, currentBuild } from "../scripts/builds.mjs";
import { enabled, report } from "./coverage.js";
import { acquireRunLock } from "./run-lock.js";

// Wait for any other run on this machine, build the app under test (BUILD=artifact
// or BUILD=web, which also builds the demo, the operator page and the home page), and start each coverage run from an
// empty cache.
export default async function globalSetup() {
  await acquireRunLock();
  const build = currentBuild();
  await buildApp(build);
  if (build === "web") {
    await buildApp(DEMO);
    await buildApp(OPS);
    await buildApp(SITE);
  }
  if (enabled) report().cleanCache();
}
