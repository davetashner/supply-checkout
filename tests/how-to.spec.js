// The how-to lessons on supplycheckout.com/how-to/ (site/how-to/, supply-checkout-vrm7), built with
// the home page (npm run build:site) and served the same way: under the app's CSP.
//
// In every browser: the index lists the lessons, and each lesson has what you'll do and how long
// it takes, numbered steps that say "Step N of M", a screenshot per step with alt text, a Stuck?
// note and a Next lesson link; no accessibility violations in light or dark mode; nothing scrolls
// sideways at phone width; any clip has controls, doesn't autoplay and has a text description.
//
// In desktop Chrome only (the @how-to-steps tests): each lesson's steps are played in the app at
// phone size (tests/how-to-lessons.js: the demo build, or the web build against the fake backend), and every control a step names in bold must be
// on screen at that step, so a lesson fails here when the app renames or drops a control it
// names. With HOW_TO_SHOTS=1 (npm run how-to:shots) the same run writes each step's screenshot
// to site/how-to/shots/<lesson>-<step>.jpg, with the step's controls outlined; commit them.
import AxeBuilder from "@axe-core/playwright";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allowConsoleError, test, expect } from "./helpers.js";
import { DEMO, SITE, builtFiles } from "../scripts/builds.mjs";
import { contentSecurityPolicy } from "../infra/lib/web/content-security-policy.ts";
import { RUM_REGION, openAws, connected } from "./fake-aws.js";
import { LESSONS } from "./how-to-lessons.js";

const ORIGIN = "https://site.supply-checkout.test";
const DEMO_ORIGIN = "https://demo.supply-checkout.test";
const CSP = contentSecurityPolicy({ api: "api.supplycheckout.com", realtime: "realtime.supplycheckout.com", auth: "auth.supplycheckout.com", rumRegion: RUM_REGION, photos: `supply-checkout-prod-photos-${RUM_REGION}-000000000000.s3.${RUM_REGION}.amazonaws.com` });
const SHOTS = fileURLToPath(new URL("../site/how-to/shots/", import.meta.url));
const WRITE_SHOTS = process.env.HOW_TO_SHOTS === "1";
// The size the screenshots are taken at: a phone, at 2x
const PHONE = { width: 390, height: 664 };

const site = builtFiles(SITE);
const fileAt = (files, pathname) => files.get(pathname === "/" || !pathname.endsWith("/") ? pathname : pathname + "index.html");

// The lessons, in the index's order, by slug
const SLUGS = Object.keys(LESSONS);

async function serveSite(page, { policy = true } = {}) {
  // WebKit's own video controls log this for their button icons, on macOS, whatever the page does
  allowConsoleError(page, /^Button failed to load, iconName = [\w-]+-placard, /);
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"}`));
  });
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
  await page.route(`${ORIGIN}/**`, (route) => {
    const file = fileAt(site, new URL(route.request().url()).pathname);
    const headers = { ...(policy ? { "content-security-policy": CSP } : {}), "cache-control": "no-store" };
    return file ? route.fulfill({ status: 200, headers: { ...headers, "content-type": file.contentType }, body: file.body }) : route.fulfill({ status: 404, headers });
  });
}

async function open(page, path, opts) {
  await serveSite(page, opts);
  await page.goto(ORIGIN + path);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

const noViolations = async (page) => expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);

// A lesson's steps as the page has them: the progress line, the heading, the controls named in
// bold (<b>, with data-role for a control that isn't a button and data-match="contains" for one
// whose name has more in it), and the screenshot
const readSteps = (page) =>
  page.locator("ol.steps > li").evaluateAll((items) =>
    items.map((li) => ({
      progress: li.querySelector(".progress")?.textContent.trim(),
      heading: li.querySelector("h2")?.textContent.trim(),
      controls: [...li.querySelectorAll(".copy b")].map((b) => ({ name: b.textContent.trim(), role: b.dataset.role || null, contains: b.dataset.match === "contains" })),
      img: li.querySelector("figure img")?.getAttribute("src"),
      alt: li.querySelector("figure img")?.getAttribute("alt"),
    })),
  );

test("the index lists every lesson in order, and each lesson's next link follows that order", async ({ page }) => {
  await open(page, "/how-to/");
  await expect(page).toHaveTitle("How-to lessons · Supply Checkout");
  const links = await page.locator("ol.lessons a").evaluateAll((a) => a.map((e) => e.getAttribute("href")));
  expect(links).toEqual(SLUGS.map((slug) => `/how-to/${slug}/`));
  await noViolations(page);
  // The home page links here
  const home = fileAt(site, "/").body.toString();
  expect(home).toContain('href="/how-to/"');
});

for (const [index, slug] of SLUGS.entries()) {
  test(`${slug}: what you'll do, how long, numbered steps each with a screenshot, Stuck? and the next lesson`, async ({ page }) => {
    await open(page, `/how-to/${slug}/`);
    await expect(page.locator("main.lesson")).toHaveAttribute("data-lesson", slug);
    await expect(page.locator(".about dt")).toHaveText(["What you'll do", "How long it takes", "You need"]);
    await expect(page.locator(".about dd").nth(1)).toHaveText(/\d+ minutes?/);

    const steps = await readSteps(page);
    // One step on the page for each step the demo plays, so the two can't drift apart
    expect(steps).toHaveLength(LESSONS[slug].steps.length);
    for (const [i, step] of steps.entries()) {
      const n = i + 1;
      expect(step.progress, `step ${n}`).toBe(`Step ${n} of ${steps.length}`);
      expect(step.heading, `step ${n}`).toMatch(/.{4}/);
      // The screenshot from the script, hashed by the build, with alt text that says what's outlined
      expect(step.img, `step ${n}`).toMatch(new RegExp(`^/assets/${slug}-${n}-[\\w-]+\\.jpg$`));
      expect(site.has(step.img), `step ${n}`).toBe(true);
      expect(step.alt, `step ${n}`).toMatch(/.{20}/);
    }
    // Every screenshot loads
    for (const img of await page.locator("ol.steps img").all()) {
      await img.scrollIntoViewIfNeeded();
      await expect.poll(() => img.evaluate((e) => e.complete && e.naturalWidth)).toBeGreaterThan(0);
    }

    await expect(page.getByRole("complementary", { name: "Stuck?" }).locator("li").first()).toBeVisible();

    const next = page.getByRole("navigation", { name: "Lessons" }).getByRole("link").last();
    const after = SLUGS[index + 1];
    if (after) {
      await expect(next).toHaveAttribute("href", `/how-to/${after}/`);
      await expect(next).toHaveText(/^Next lesson: /);
    } else {
      await expect(next).toHaveAttribute("href", "/how-to/");
    }

    // A clip, if the lesson has one: controls, no autoplay, starts paused, nothing loaded until
    // asked, and a text description of what it shows
    for (const video of await page.locator("video").all()) {
      await expect(video).toHaveAttribute("controls", "");
      await expect(video).not.toHaveAttribute("autoplay", /.*/);
      await expect(video).toHaveAttribute("preload", "none");
      await expect(video).toHaveJSProperty("paused", true);
      const described = await video.getAttribute("aria-describedby");
      await expect(page.locator(`#${described}`)).toHaveText(/.{40}/);
    }
    await noViolations(page);
  });
}

for (const scheme of ["light", "dark"]) {
  test(`the index and every lesson have no accessibility violations in ${scheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    // axe reads the stylesheets by fetch, which the policy's connect-src refuses: no policy here
    await serveSite(page, { policy: false });
    for (const path of ["/how-to/", ...SLUGS.map((slug) => `/how-to/${slug}/`)]) {
      await page.goto(ORIGIN + path);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
      expect(results.violations.map((v) => `${path} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
    }
  });
}

test("at phone width nothing scrolls sideways, and the text is large", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await serveSite(page);
  for (const path of ["/how-to/", ...SLUGS.map((slug) => `/how-to/${slug}/`)]) {
    await page.goto(ORIGIN + path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), path).toBeLessThanOrEqual(360);
    expect(await page.locator("main p").first().evaluate((p) => parseFloat(getComputedStyle(p).fontSize)), path).toBeGreaterThanOrEqual(18);
  }
  await noViolations(page);
});

// The control a lesson names, in the open dialog if there is one, else on the page: a role and
// name, the placeholder of a box, or the exact text of something that can be tapped
function control(page, { name, role, contains }) {
  const find = (scope) => {
    if (role === "placeholder") return scope.getByPlaceholder(name, { exact: true });
    if (role) return scope.getByRole(role, { name, exact: !contains });
    const text = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
    return scope.getByRole("button", { name, exact: !contains }).or(scope.locator("button, label, a").filter({ hasText: text }));
  };
  return { inModal: find(page.locator("#modal")).filter({ visible: true }), onPage: find(page).filter({ visible: true }) };
}

async function outline(locator, on) {
  await locator.evaluate((el, on) => {
    if (on) {
      el.dataset.howToStyle = el.getAttribute("style") || "";
      el.style.outline = "4px solid #E8590C";
      el.style.outlineOffset = "3px";
    } else {
      if (el.dataset.howToStyle) el.setAttribute("style", el.dataset.howToStyle);
      else el.removeAttribute("style");
      delete el.dataset.howToStyle;
    }
  }, on);
}

// Hides what isn't the app's (the demo's banner) and what would cover a shot (toasts, animations, the caret)
const STILL = ".demo-banner, #toast { display: none !important; } *, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";

// Opens the lesson's app: the demo build with its demo data, or the web build against the fake backend
// (`ready`: what to wait for in the web build, when it isn't the team's data loading)
async function openLessonApp(page, lesson, backend, { ready = connected, ...opts } = {}) {
  if (lesson.app === "web") {
    await openAws(page, backend, opts);
    await ready(page);
  } else {
    const demo = builtFiles(DEMO);
    await page.route(`${DEMO_ORIGIN}/**`, (r) => {
      const file = fileAt(demo, new URL(r.request().url()).pathname);
      return file ? r.fulfill(file) : r.fulfill({ status: 404 });
    });
    await page.goto(`${DEMO_ORIGIN}/`);
    await expect(page.getByRole("button", { name: /Acme Offices/ })).toBeVisible();
  }
  await page.addStyleTag({ content: STILL });
}

test.describe("each lesson's steps work in the app", { tag: ["@how-to-steps"] }, () => {
  test.use({ viewport: PHONE, deviceScaleFactor: 2 });

  for (const slug of SLUGS) {
    test(`${slug}: every control a step names is on screen at that step`, async ({ page, browser }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop-chrome", "Played once, in desktop Chrome at phone size");
      const lesson = LESSONS[slug];
      await open(page, `/how-to/${slug}/`);
      const steps = await readSteps(page);
      expect(steps).toHaveLength(lesson.steps.length);

      const backend = lesson.app === "web" ? lesson.backend() : null;
      await openLessonApp(page, lesson, backend);
      if (WRITE_SHOTS) mkdirSync(SHOTS, { recursive: true });

      // A step seen by someone else opens their own browser, which fails the test on any page error too
      const others = [];
      const newPage = async (theirs, opts) => {
        const context = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2 });
        const other = await context.newPage();
        const errors = [];
        other.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
        other.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
        others.push({ context, errors });
        await openLessonApp(other, lesson, theirs, opts);
        return other;
      };

      let shown = page;
      for (const [i, step] of steps.entries()) {
        const n = i + 1;
        await test.step(`Step ${n}: ${step.heading}`, async () => {
          shown = (await lesson.steps[i](shown, { backend, newPage })) || shown;
          const found = [];
          for (const c of step.controls) {
            const { inModal, onPage } = control(shown, c);
            const locator = (await inModal.count()) ? inModal.first() : onPage.first();
            await expect(locator, `step ${n} names "${c.name}", which isn't on screen`).toBeVisible();
            found.push(locator);
          }
          for (const l of found) await l.scrollIntoViewIfNeeded();
          // ...and all of them in the shot
          for (const [k, l] of found.entries()) await expect(l, `step ${n}: "${step.controls[k].name}" isn't on the same screen as the rest`).toBeInViewport();
          for (const l of found) await outline(l, true);
          const file = `${SHOTS}${slug}-${n}.jpg`;
          if (WRITE_SHOTS) await shown.screenshot({ path: file, type: "jpeg", quality: 70 });
          else expect(existsSync(file), `${slug}-${n}.jpg is committed (npm run how-to:shots)`).toBe(true);
          for (const l of found) await outline(l, false);
        });
      }
      for (const { context, errors } of others) {
        await context.close();
        expect(errors, "page errors").toEqual([]);
      }
    });
  }
});
