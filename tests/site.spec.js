// The marketing home page (npm run build:site, site/; supply-checkout-a1s.1). Built and tested
// with the web build (BUILD=web), in every browser. It runs as CloudFront serves it at the apex:
// under the same Content-Security-Policy as the app (failing on any violation), with the clips
// served in ranges, which iPhone Safari needs to play a video.
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { test, expect } from "./helpers.js";
import { SITE, builtFiles, currentBuild } from "../scripts/builds.mjs";
import { contentSecurityPolicy } from "../infra/lib/web/content-security-policy.ts";
import { RUM_REGION } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The home page is built and tested with the web build");

const ORIGIN = "https://site.supply-checkout.test";
const CSP = contentSecurityPolicy({ api: "api.supplycheckout.com", realtime: "realtime.supplycheckout.com", auth: "auth.supplycheckout.com", rumRegion: RUM_REGION });
const files = currentBuild() === "web" ? builtFiles(SITE) : new Map();
const CLIPS = JSON.parse(readFileSync(new URL("../site/clips/clips.json", import.meta.url), "utf8")).clips;

// axe reads the page's stylesheets by fetch, which the policy's connect-src refuses: its runs have no policy
async function open(page, { policy = true } = {}) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"}`));
  });
  // The fonts pass the policy, then are refused to keep the test offline, as in the other suites
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const file = files.get(pathname);
    const headers = { ...(policy ? { "content-security-policy": CSP } : {}), "cache-control": "no-store" };
    if (!file) return route.fulfill({ status: 404, headers });
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
    if (!range) return route.fulfill({ status: 200, headers: { ...headers, "content-type": file.contentType, "accept-ranges": "bytes" }, body: file.body });
    const start = Number(range[1]);
    const end = Math.min(range[2] ? Number(range[2]) : file.body.length - 1, file.body.length - 1);
    return route.fulfill({ status: 206, headers: { ...headers, "content-type": file.contentType, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${file.body.length}` }, body: file.body.subarray(start, end + 1) });
  });
  await page.goto(`${ORIGIN}/`);
  // Every other host is the app's, which the test never reaches
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const noViolations = async (page) => expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);

test("the page leads with the checkout journey and the trial, and says the price", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Know what left the van, and what it cost the client.");
  const trial = page.getByRole("link", { name: "Start your free trial" }).first();
  await expect(trial).toHaveAttribute("href", "https://app.supplycheckout.com/");
  await expect(page.getByRole("link", { name: "Try the demo", exact: true })).toHaveAttribute("href", "/demo/");
  await expect(page.getByText("14 days free. No card needed. $3 per user per month after that.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "$3 per user per month." })).toBeVisible();
  // One section for each of the other journeys the clips show
  const features = await page.locator(".feature h2").allTextContents();
  expect(features).toEqual([
    "Check supplies out. Check them back in.",
    "Know where every ladder and vacuum is.",
    "A box of gloves for the van? Quick take.",
    "Photograph the receipt. Every line lands on the right job.",
  ]);
  await noViolations(page);
});

test("each recorded clip is on the page with a poster, and every file loads", async ({ page }) => {
  const failed = [];
  page.on("response", (r) => { if (new URL(r.url()).origin === ORIGIN && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  await open(page);
  // The clips' own journeys, in the order the config gives them: J4 is the hero and again its section
  const sources = await page.locator(".screen video source").evaluateAll((s) => s.map((e) => e.getAttribute("src")));
  expect(sources).toHaveLength(CLIPS.length + 1);
  for (const clip of CLIPS) {
    const hashed = sources.filter((src) => src.includes(`/assets/${clip.mp4.replace(".mp4", "")}-`));
    expect(hashed, clip.mp4).toHaveLength(clip.journey === "J4" ? 2 : 1);
    expect(files.has(hashed[0]), clip.mp4).toBe(true);
  }
  for (const v of await page.locator(".screen video").all()) {
    const poster = await v.getAttribute("poster");
    expect(poster).toMatch(/^\/assets\/J\d+-[a-z-]+-[\w-]+\.jpg$/);
    expect(files.has(poster)).toBe(true);
    await expect(v).toHaveJSProperty("muted", true);
    await expect(v).toHaveAttribute("playsinline", "");
    // Described by its figure's hidden caption
    await expect(v.locator("xpath=ancestor::figure/figcaption")).toHaveText(/.{20}/);
    await expect(v).not.toHaveAttribute("autoplay", /.*/);
  }
  // A poster, or a clip a scroll has brought on screen, loaded without an error
  await page.locator("#j14-h").scrollIntoViewIfNeeded();
  await page.waitForLoadState("load");
  expect(failed).toEqual([]);
  await noViolations(page);
});

test("the hero clip plays muted and loops; one off screen is paused", async ({ page, browserName }) => {
  test.skip(browserName === "firefox", "The test Firefox build has no H.264 decoder");
  await open(page);
  const hero = page.locator(".hero video");
  // On a phone the clip is below the headline
  await hero.scrollIntoViewIfNeeded();
  await expect(hero).toHaveJSProperty("loop", true);
  await expect.poll(() => hero.evaluate((v) => !v.paused && v.readyState >= 2), { timeout: 15_000 }).toBe(true);
  expect(await hero.evaluate((v) => v.videoWidth)).toBe(390);
  expect(await page.locator("#j5-h").locator("xpath=ancestor::section").locator("video").evaluate((v) => v.paused)).toBe(true);
});

test("someone who prefers reduced motion gets stills, and a button to play a clip", async ({ page, browserName }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  for (const v of await page.locator(".screen video").all()) {
    await expect(v).toHaveJSProperty("paused", true);
  }
  const play = page.getByRole("button", { name: /^Play the clip: Checking a client's supplies out/ });
  await expect(play).toBeVisible();
  // (Playwright's Firefox has no H.264 decoder, so a clip there can't start)
  if (browserName === "firefox") return;
  await play.click();
  await expect(page.getByRole("button", { name: /^Pause the clip: Checking a client's supplies out/ })).toBeAttached();
  await page.getByRole("button", { name: /^Pause the clip: Checking a client's supplies out/ }).click();
  await expect(play).toBeAttached();
});

for (const scheme of ["light", "dark"]) {
  test(`has no accessibility violations in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page, { policy: false });
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
  });
}

test("at phone width nothing scrolls sideways, and the header and trial button fit", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await expect(page.locator("header .btn")).toBeInViewport();
  await expect(page.getByRole("link", { name: "Start your free trial" }).first()).toBeInViewport();
});

test("the page has no scripts but its own, and no links to terms or privacy until they exist", async ({ page }) => {
  await open(page);
  expect(await page.locator("script").evaluateAll((s) => s.map((e) => e.getAttribute("src")))).toEqual([expect.stringMatching(/^\/assets\/index-[\w-]+\.js$/)]);
  expect(files.get("/site-release.json").body.toString()).toBe('{"site":true}\n');
  await expect(page.getByRole("link", { name: /terms|privacy/i })).toHaveCount(0);
});
