import { enabled, report } from "./coverage.js";

// Merge coverage from every test and fail the run if it's below the threshold.
export default async function globalTeardown() {
  if (enabled) await report().generate();
}
