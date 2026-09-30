// Records one video per customer journey (docs/journeys.md, journeys/registry.json) from the
// tests that prove its steps: every Playwright test tagged with one of the journey's steps
// (@J4.2) runs in the web build, recorded, with a caption banner giving the step and the
// registry's text for it, a drawn cursor on each element the test acts on, and whether each
// step passed or failed (tests/journey-video.js). A title card starts each video; a card stands
// in for each step that's not built yet or is proved by backend tests only; an end card lists
// each step's result. It runs against the test suite's fakes (tests/fake-aws.js,
// tests/mock-claude.js), never a real AWS account, Stripe or email.
//
//   npm run journeys:video                          every journey, in a visible browser
//   npm run journeys:video -- --only J4             one journey (or --only J4,J7)
//   npm run journeys:video -- --viewport phone      an iPhone 13 in Chromium (default: desktop)
//   npm run journeys:video -- --headless            without a window (the videos are the same)
//   npm run journeys:video -- --pace 0.3            shorter pauses, for a quick check
//   npm run journeys:video -- --slow-mo 100         the browser's slowMo, in milliseconds (default 0)
//   npm run journeys:video -- --skip-build          use the dist/web already built
//
// For each journey it writes dist/journey-videos/<J#-slug>.webm and <J#-slug>.json (the
// sidecar: each step's result, its tests and where each shows in the video). With --viewport
// phone the names end in -phone. It holds the Playwright run lock (tests/run-lock.js) from start
// to end, runs one test at a time in one Chromium, and exits 1 if any recorded test failed; the
// videos are still written, showing the failure.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG = fileURLToPath(new URL("./playwright.config.mjs", import.meta.url));
const USAGE = "Usage: npm run journeys:video -- [--only J4[,J7]] [--viewport desktop|phone] [--headless] [--pace 1] [--slow-mo 0] [--skip-build]";

export function parseArgs(argv) {
  const opts = { headless: false, only: null, pace: 1, slowMo: 0, build: true, viewport: "desktop" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    const is = (flag) => arg === flag || arg.startsWith(`${flag}=`);
    if (arg === "--headless") opts.headless = true;
    else if (arg === "--headed") opts.headless = false;
    else if (arg === "--skip-build") opts.build = false;
    else if (is("--only")) opts.only = [...(opts.only || []), ...value().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)];
    else if (is("--pace")) opts.pace = Number(value());
    else if (is("--slow-mo")) opts.slowMo = Number(value());
    else if (is("--viewport")) opts.viewport = value();
    else if (arg === "--help" || arg === "-h") return { help: true };
    else throw new Error(`Unknown option ${arg}\n${USAGE}`);
  }
  if (!(opts.pace > 0)) throw new Error("--pace must be a number above 0");
  if (!(opts.slowMo >= 0)) throw new Error("--slow-mo must be 0 or more");
  if (!["desktop", "phone"].includes(opts.viewport)) throw new Error(`--viewport is desktop or phone, not ${opts.viewport}`);
  return opts;
}

// Runs Playwright with the recording config (process.mjs: stopped with record.mjs)
const PLAYWRIGHT = createRequire(import.meta.url).resolve("@playwright/test/cli");
function playwright(run, args, env, capture = false) {
  return run(process.execPath, [PLAYWRIGHT, "test", "--config", CONFIG, ...args], { cwd: ROOT, env: { ...process.env, ...env }, capture });
}

function commit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Records a card: a whole-frame page held for `seconds`, as a video the size of the test videos
async function recordCard(browser, html, seconds, { size, video, scale, dir }) {
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: scale, recordVideo: { dir, size: video } });
  const page = await context.newPage();
  await page.setContent(html);
  // A bar along the bottom fills over the card's time. It also keeps the page painting: Chromium
  // sends the video no frames for a page that doesn't change, and the card would come out blank
  const ms = Math.round(seconds * 1000);
  await page.evaluate((duration) => {
    const bar = document.createElement("div");
    bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:6px;background:#3ea6ff;transform-origin:left;transform:scaleX(0)";
    document.body.append(bar);
    bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration, fill: "forwards" });
  }, ms);
  await page.waitForTimeout(ms);
  const v = page.video();
  await context.close();
  return v.path();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(USAGE);
  const { playwrightTests, journeyStatus } = await import("../journeys.mjs");
  const { planVideos, grepFor, readReport, stepResults, clipsFor, sidecar, summarize, journeySlug } = await import("./assemble.mjs");
  const { frame, titleCard, stepCard, endCard } = await import("./director.mjs");
  const { concatWebm, webmDuration } = await import("./webm.mjs");
  const { acquireRunLock, releaseRunLock } = await import("../../tests/run-lock.js");
  const { buildApp, distDir, DEMO } = await import("../builds.mjs");
  const { run, onInterrupt } = await import("./process.mjs");
  const registry = JSON.parse(readFileSync(join(ROOT, "journeys/registry.json"), "utf8"));
  const size = frame(opts.viewport);

  await acquireRunLock();
  const scratch = mkdtempSync(join(tmpdir(), "journey-videos-"));
  const outDir = join(ROOT, "dist/journey-videos");
  const env = {
    BUILD: "web",
    JOURNEY_VIDEO: "1",
    JOURNEY_VIDEO_OPTIONS: JSON.stringify({ viewport: opts.viewport, pace: opts.pace, slowMo: opts.slowMo, headless: opts.headless, outputDir: join(scratch, "results"), report: join(scratch, "report.json") }),
  };
  const written = [];
  let failed = 0, browser, done = false;
  // Also on Ctrl-C or SIGTERM, once the Playwright run has stopped
  const cleanup = async () => {
    if (done) return;
    done = true;
    if (browser) await browser.close().catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
    releaseRunLock();
  };
  const stopHandling = onInterrupt(cleanup);
  try {
    // Listing the tests loads the web build, and tests/demo.spec.js the demo's
    for (const build of ["web", DEMO]) {
      if (!opts.build && existsSync(join(distDir(build), "index.html"))) continue;
      console.log(`Building the ${build} app…`);
      await buildApp(build);
    }
    const listing = await playwright(run, ["--list", "--reporter=json"], env, true);
    const list = JSON.parse(listing.stdout || "{}");
    if (list.errors?.length || listing.status) throw new Error(`Couldn't list the tests:\n${(list.errors || []).map((e) => e.message).join("\n") || listing.stderr}`);
    const plans = planVideos(registry, playwrightTests(list), opts.only);
    const count = new Set(plans.flatMap((p) => p.tests.map((t) => `${t.file}:${t.line}:${t.title}`))).size;
    console.log(`Recording ${count} tests for ${plans.map((p) => p.journey.id).join(", ")} (${opts.viewport})…`);
    const recording = count ? await playwright(run, ["--grep", grepFor(plans)], env) : { status: 0 };
    const report = existsSync(join(scratch, "report.json")) ? JSON.parse(readFileSync(join(scratch, "report.json"), "utf8")) : {};
    if (count && !report.suites) throw new Error(`The recording run didn't finish (exit ${recording.status})`);
    const results = readReport(report, (videos) => videos.reduce((a, b) => (webmDuration(b) > webmDuration(a) ? b : a)));

    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch();
    const cardDir = join(scratch, "cards");
    const meta = { viewport: opts.viewport, size: size.video, build: "web", commit: commit(), recordedAt: new Date().toISOString() };
    mkdirSync(outDir, { recursive: true });
    for (const plan of plans) {
      const steps = stepResults(plan, results);
      const clips = clipsFor(plan, steps, results);
      const journey = { ...plan.journey, status: journeyStatus(plan.journey) };
      const card = (html, seconds) => recordCard(browser, html, seconds * opts.pace, { size: size.page, video: size.video, scale: size.scale, dir: cardDir });
      const files = [];
      for (const clip of clips) {
        if (clip.kind === "title") files.push(await card(titleCard(journey, { viewport: opts.viewport, build: "web", commit: meta.commit, date: meta.recordedAt.slice(0, 10), tests: plan.tests.length }), 5));
        else if (clip.kind === "step") files.push(await card(stepCard(journey, steps.find((s) => s.id === clip.step)), 5));
        else if (clip.kind === "end") files.push(await card(endCard(journey, steps, summarize(steps)), 8));
        else files.push(clip.video);
      }
      const name = `${journeySlug(plan.journey)}${opts.viewport === "phone" ? "-phone" : ""}`;
      const file = join(outDir, `${name}.webm`);
      const { starts, duration } = concatWebm(files, file);
      const data = sidecar({ plan, steps, clips, starts, duration, results, video: `${name}.webm`, meta });
      writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(data, null, 2)}\n`);
      failed += data.summary.failed;
      written.push({ id: plan.journey.id, file, duration, bytes: statSync(file).size, summary: data.summary });
    }
  } finally {
    stopHandling();
    await cleanup();
  }

  console.log("\nJourney videos:");
  for (const w of written) {
    const s = w.summary;
    const counts = [`${s.passed} passed`, s.failed && `${s.failed} failed`, s.simulated && `${s.simulated} simulated`, s.planned && `${s.planned} not built yet`, s.backend && `${s.backend} backend tests only`, s.skipped && `${s.skipped} not run`].filter(Boolean).join(", ");
    console.log(`  ${s.failed ? "FAILED" : "ok    "} ${w.id.padEnd(3)} ${w.file} (${w.duration.toFixed(1)} s, ${(w.bytes / 1e6).toFixed(1)} MB; steps: ${counts})`);
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
