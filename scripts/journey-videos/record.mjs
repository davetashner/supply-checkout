// Records one video per customer journey in docs/journeys.md (J0 to J11), for people to
// watch: a browser opens, a visible cursor moves and clicks through the journey, and a
// caption says what each step shows or checks. It runs the web build against the test
// suite's fakes (tests/fake-aws.js, tests/mock-claude.js), never a real AWS account,
// Stripe or email.
//
//   npm run journeys:video                          every journey, in a visible browser
//   npm run journeys:video -- --headless            without a window (the videos are the same)
//   npm run journeys:video -- --only J4             one journey (or --only J4,J7)
//   npm run journeys:video -- --pace 0.3            shorter pauses, for a quick check
//   npm run journeys:video -- --slow-mo 100         the browser's slowMo, in milliseconds (default 40)
//   npm run journeys:video -- --skip-build          use the dist/web already built
//
// Videos go to dist/journey-videos/<J#-slug>.webm (gitignored), 1280x800. It holds the
// Playwright run lock (tests/run-lock.js) while it runs, so it waits for any test run.
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// tests/fake-aws.js imports infra's TypeScript config, whose imports name .js files that
// are .ts on disk (Playwright's test runner maps them the same way)
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error.code === "ERR_MODULE_NOT_FOUND" && /^\.\.?\/.*\.js$/.test(specifier) && context.parentURL?.endsWith(".ts")) return next(specifier.replace(/\.js$/, ".ts"), context);
      throw error;
    }
  },
});

const USAGE = "Usage: npm run journeys:video -- [--headless] [--only J4[,J7]] [--pace 1] [--slow-mo 40] [--skip-build]";

function parseArgs(argv) {
  const opts = { headless: false, only: null, pace: 1, slowMo: 40, build: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return v;
    };
    if (arg === "--headless") opts.headless = true;
    else if (arg === "--headed") opts.headless = false;
    else if (arg === "--skip-build") opts.build = false;
    else if (arg.startsWith("--only")) opts.only = [...(opts.only || []), ...value().split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)];
    else if (arg.startsWith("--pace")) opts.pace = Number(value());
    else if (arg.startsWith("--slow-mo")) opts.slowMo = Number(value());
    else if (arg === "--help" || arg === "-h") { console.log(USAGE); process.exit(0); }
    else throw new Error(`Unknown option ${arg}\n${USAGE}`);
  }
  if (!(opts.pace > 0)) throw new Error("--pace must be a number above 0");
  if (!(opts.slowMo >= 0)) throw new Error("--slow-mo must be 0 or more");
  return opts;
}

// Seconds, from ffprobe when it's installed
function duration(file) {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const s = Number(out.trim());
    return Number.isFinite(s) ? s : null;
  } catch {
    return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { JOURNEYS } = await import("./journeys.mjs");
  const chosen = opts.only ? JOURNEYS.filter((j) => opts.only.includes(j.id)) : JOURNEYS;
  const unknown = (opts.only || []).filter((id) => !JOURNEYS.some((j) => j.id === id));
  if (unknown.length) throw new Error(`No journey ${unknown.join(", ")}. There are ${JOURNEYS.map((j) => j.id).join(", ")}.`);

  const { acquireRunLock, releaseRunLock } = await import("../../tests/run-lock.js");
  const { buildApp, distDir } = await import("../builds.mjs");
  const { chromium } = await import("@playwright/test");
  const { Director, installOverlay } = await import("./director.mjs");

  await acquireRunLock();
  const outDir = fileURLToPath(new URL("../../dist/journey-videos/", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "journey-videos-"));
  const results = [];
  let browser;
  try {
    if (opts.build || !existsSync(join(distDir("web"), "index.html"))) {
      console.log("Building the web app…");
      await buildApp("web");
    }
    mkdirSync(outDir, { recursive: true });
    browser = await chromium.launch({ headless: opts.headless, slowMo: opts.slowMo });
    for (const journey of chosen) {
      const file = join(outDir, `${journey.id}-${journey.slug}.webm`);
      const size = { width: 1280, height: 800 };
      const context = await browser.newContext({ viewport: size, recordVideo: { dir: scratch, size }, bypassCSP: true, acceptDownloads: true, locale: "en-US", timezoneId: "America/New_York" });
      // Nothing leaves this machine: whatever the journey's own routes don't answer is refused
      const refused = [];
      await context.route(/^https?:\/\//, (route) => { refused.push(route.request().url()); return route.abort(); });
      await context.addInitScript(installOverlay, Director.bannerHeight);
      const page = await context.newPage();
      page.on("pageerror", (e) => console.warn(`  ${journey.id} page error: ${e.message}`));
      const d = new Director(page, journey, { pace: opts.pace, slowMo: opts.slowMo });
      const started = Date.now();
      let error = null;
      console.log(`${journey.id} ${journey.title}…`);
      try {
        await d.titleCard();
        await d.hideCard();
        await journey.run(d);
        await d.endCard();
      } catch (e) {
        error = e;
        console.error(`  ${journey.id} failed: ${e.stack || e}`);
      }
      const video = page.video();
      await context.close();
      if (video) {
        await video.saveAs(file);
        await video.delete();
      }
      if (refused.length) console.warn(`  ${journey.id} refused requests that would have left the machine: ${[...new Set(refused)].join(", ")}`);
      results.push({ journey, file, error, seconds: duration(file), bytes: existsSync(file) ? statSync(file).size : 0, wall: (Date.now() - started) / 1000 });
    }
  } finally {
    if (browser) await browser.close();
    rmSync(scratch, { recursive: true, force: true });
    releaseRunLock();
  }

  console.log("\nJourney videos:");
  for (const r of results) {
    const length = r.seconds === null ? `${(r.bytes / 1e6).toFixed(1)} MB` : `${r.seconds.toFixed(1)} s, ${(r.bytes / 1e6).toFixed(1)} MB`;
    console.log(`  ${r.error ? "FAILED" : "ok    "} ${r.journey.id.padEnd(3)} ${r.file} (${length})`);
  }
  if (results.some((r) => r.error)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
