import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// One Playwright run at a time across every worktree of this repo. Several full
// runs at once (each a set of Chrome and WebKit workers) have used up a laptop's
// memory and swap. The lock lives in the shared .git directory, so every worktree
// sees it. CI jobs run on their own machines and skip it.
const POLL_MS = 2000;

function lockPath() {
  const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  return join(gitDir, "playwright-run.lock");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else
    return error.code === "EPERM";
  }
}

function holder(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function removeLock(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Waits until no other live run holds the lock, then takes it.
export async function acquireRunLock() {
  if (process.env.CI) return;
  const path = lockPath();
  let announced = false;
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, cwd: process.cwd(), started: new Date().toISOString() }), {
        flag: "wx",
      });
      process.once("exit", () => releaseRunLock());
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let other = holder(path);
    if (!other) {
      // The holder may still be writing it; look again before calling it stale
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      other = holder(path);
    }
    if (!other || !alive(other.pid)) {
      // Left behind by a run that was killed; take it over
      removeLock(path);
      continue;
    }
    if (!announced) {
      console.log(`Waiting for the Playwright run in ${other.cwd} (pid ${other.pid}) to finish…`);
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export function releaseRunLock() {
  if (process.env.CI) return;
  const path = lockPath();
  if (holder(path)?.pid === process.pid) removeLock(path);
}
