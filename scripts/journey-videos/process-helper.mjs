// For journey-videos.test.mjs: acts as record.mjs does around process.mjs. It runs a child (like
// Playwright's runner) that starts a child of its own (like its browser), and cleans up when
// stopped. JV_SIGNAL_DIR is where it writes the pids and what happened.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run, onInterrupt } from "./process.mjs";

const dir = process.env.JV_SIGNAL_DIR;
const CHILD = `
  const { spawn } = require("node:child_process");
  const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  require("node:fs").writeFileSync(require("node:path").join(process.env.JV_SIGNAL_DIR, "pids"), process.pid + " " + g.pid);
  setInterval(() => {}, 1000);
`;
onInterrupt(async () => writeFileSync(join(dir, "cleaned"), "yes"));
await run(process.execPath, ["-e", CHILD]);
writeFileSync(join(dir, "carried-on"), "yes");
