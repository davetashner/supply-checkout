import { enabled, report } from "./coverage.js";
import { releaseRunLock } from "./run-lock.js";

// Merge coverage from every test and fail the run if it's below the threshold,
// then let the next run on this machine start.
export default async function globalTeardown() {
  try {
    if (enabled) await report().generate();
  } finally {
    releaseRunLock();
  }
}
