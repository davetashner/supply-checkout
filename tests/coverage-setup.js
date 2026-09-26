import { enabled, report } from "./coverage.js";

// Start each coverage run from an empty cache.
export default async function globalSetup() {
  if (enabled) report().cleanCache();
}
