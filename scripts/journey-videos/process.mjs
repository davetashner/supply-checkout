// Child processes for record.mjs that don't outlive it. Each child runs in its own process group,
// so on Ctrl-C (SIGINT) or SIGTERM the signal goes to the whole group (Playwright's runner, its
// worker and their Chromium), and record.mjs waits for them to exit before it cleans up and
// releases the Playwright run lock. Without that, the tests kept running with no lock held.
import { spawn } from "node:child_process";

const children = new Set();
// Once a signal has come, a child that exits leaves its caller waiting: the handler exits instead
let stopping = false;

// Runs a command and resolves with its exit status (and its output, with capture)
export function run(cmd, args, { capture = false, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, detached: true, stdio: ["ignore", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"] });
    children.add(child);
    let stdout = "", stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8").on("data", (d) => { stdout += d; });
      child.stderr.setEncoding("utf8").on("data", (d) => { stderr += d; });
    }
    child.on("error", (error) => { children.delete(child); reject(error); });
    child.on("close", (status, signal) => {
      children.delete(child);
      if (!stopping) resolve({ status, signal, stdout, stderr });
    });
  });
}

const closed = (child) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once("close", r)));
const signalGroup = (child, signal) => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } };

// On SIGINT or SIGTERM: send it to every running child's process group, wait for them (up to
// graceMs, then SIGKILL), run cleanup, and exit 130 or 143. Returns a function that removes it.
export function onInterrupt(cleanup, { graceMs = 15000, exit = (code) => process.exit(code) } = {}) {
  const handler = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.error(`\n${signal}: stopping the recording…`);
    const running = [...children];
    for (const child of running) signalGroup(child, signal);
    const timer = setTimeout(() => { for (const child of running) signalGroup(child, "SIGKILL"); }, graceMs);
    await Promise.all(running.map(closed));
    clearTimeout(timer);
    try {
      await cleanup();
    } finally {
      exit(signal === "SIGINT" ? 130 : 143);
    }
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
