import { buildApp, currentBuild } from "../scripts/builds.mjs";
import { enabled, report } from "./coverage.js";

// Build the app under test (BUILD=artifact or BUILD=web), and start each
// coverage run from an empty cache.
export default async function globalSetup() {
  await buildApp(currentBuild());
  if (enabled) report().cleanCache();
}
