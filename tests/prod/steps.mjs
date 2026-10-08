// Steps the prod journey specs share that only make sense against prod: the run's names and
// barcodes, opening the browser project's long-lived team, a second signed-in browser context,
// the signed-in user's token for a direct API call, and reading a download. The screen-level
// steps (forms, dialogs, tabs) come from tests/ui/, shared with the local suites.
//
// Everything a spec makes in a long-lived team is named for the run (`E2E <runId> …`, barcodes
// `e2e-<runId>-<n>`), so scripts/journeys/cleanup.mjs deletes it after the run, and the next
// run's cleanup sweeps it if this one crashed. A test's retry gets names and barcodes of its own,
// so a half-finished first try never collides with the retry.
/* global document -- appReady's check runs in the page */
import { readFile } from "node:fs/promises";
import { runBarcode, runName } from "../../scripts/journeys/lib/addresses.mjs";
import { PROD } from "../../scripts/journeys/lib/config.mjs";
import { switchTeam, teamPicker } from "../ui/index.js";
import { expect, isExpectedConsoleError, isExpectedPageError } from "./fixtures.mjs";

/**
 * The run's names and barcodes for one test: `name("towels")` is `E2E <runId> J4 towels r0`,
 * and `code(1)` is `e2e-<runId>-401` (the journey's number, the try, the item), different for
 * each journey and each try.
 */
export function runData(harness, testInfo, journey) {
  const n = Number(/^J(\d+)$/.exec(journey)?.[1]);
  if (!Number.isInteger(n)) throw new Error(`Not a journey: ${journey}`);
  const attempt = `r${testInfo.retry}`;
  return {
    name: (label) => runName(harness.runId, `${journey} ${label} ${attempt}`),
    code: (i) => {
      if (!(Number.isInteger(i) && i >= 0 && i < 10)) throw new Error("An item number is 0 to 9");
      return runBarcode(harness.runId, n * 100 + testInfo.retry * 10 + i);
    },
  };
}

/**
 * Waits until the app has drawn the open team's data: the "Connecting…" notice is gone and the
 * main view isn't still loading. (tests/ui's waitUntilConnected alone can pass right after a
 * reload, before the app has started.)
 */
export const appReady = (page, timeout) =>
  page.waitForFunction(() => {
    const notice = document.getElementById("notice"), main = document.getElementById("main");
    return !!main && main.childElementCount > 0 && !/Loading/.test(main.textContent) && (notice.hidden || !notice.textContent.startsWith("Connecting"));
  }, null, { timeout });

/**
 * Opens the long-lived team for this browser project. The long-lived accounts are members of
 * both journey teams, so the team bar has a switcher; switching loads the page again.
 */
export async function openTeam(page, teamId) {
  await appReady(page);
  const picker = teamPicker(page);
  await expect(picker, "the long-lived accounts are in both journey teams").toBeVisible();
  if ((await picker.inputValue()) !== teamId) {
    const loaded = page.waitForEvent("load");
    await switchTeam(page, teamId);
    await loaded;
  }
  await expect(teamPicker(page)).toHaveValue(teamId);
  await appReady(page);
}

/**
 * Records the bearer token of the app's API requests on `page`, so a test can make one direct
 * API call as the signed-in user (J9's refused write, J2's restore of the markup). Call it before
 * signing in. The token is masked as soon as it's seen.
 */
export function watchBearer(page, harness) {
  let token = null;
  page.on("request", async (req) => {
    if (!req.url().startsWith(`${PROD.api}/`)) return;
    const auth = (await req.allHeaders().catch(() => ({}))).authorization;
    const m = /^Bearer (\S+)$/.exec(auth ?? "");
    if (m && m[1] !== token) {
      token = m[1];
      harness.masker.add(token);
    }
  });
  return async () => {
    await expect.poll(() => token, { message: "the app sent an API request with a bearer token" }).not.toBeNull();
    return token;
  };
}

/** One API call as the page's user: `{ status, body }`, never thrown. */
export async function apiCall(page, token, method, path, data) {
  const res = await page.request.fetch(`${PROD.api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}) },
    data: data ? JSON.stringify(data) : undefined,
    failOnStatusCode: false,
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status(), body };
}

/** Clicks `button` and returns the download it starts: its file name and text. */
export async function download(page, button) {
  const started = page.waitForEvent("download");
  await button.click();
  const file = await started;
  return { filename: file.suggestedFilename(), text: await readFile(await file.path(), "utf8") };
}

// The second context's device: the browser project's own, without the test-runner options
const DEVICE_OPTIONS = ["viewport", "screen", "userAgent", "deviceScaleFactor", "isMobile", "hasTouch", "locale", "timezoneId", "colorScheme"];

/**
 * A second browser context signed in as `role`, as another person on another phone: J4's live
 * update and J9's crew member. It aborts RUM requests as the main page does, refuses any account
 * deletion or team closure outright (a long-lived account never makes one), collects the app's
 * errors, and isn't traced. `close()` closes it and fails the test on any error it saw.
 */
export async function secondPage({ browser, harness, signIn, testInfo }, role) {
  const use = testInfo.project.use;
  const context = await browser.newContext({
    ...Object.fromEntries(DEVICE_OPTIONS.filter((k) => use[k] !== undefined).map((k) => [k, use[k]])),
    baseURL: PROD.app,
  });
  await context.route(/^https:\/\/dataplane\.rum\.[a-z0-9-]+\.amazonaws\.com\//, (r) => r.abort());
  await context.route((url) => url.origin === PROD.api && (url.pathname === "/me" || /^\/teams\/[^/]+\/close$/.test(url.pathname)), (route) => {
    const method = route.request().method();
    if (method === "DELETE" || (method === "POST" && route.request().url().includes("/close"))) return route.abort("blockedbyclient");
    return route.fallback();
  });
  const page = await context.newPage();
  const errors = [];
  const appOrigin = (url) => { try { return [PROD.app, PROD.api].includes(new URL(url).origin); } catch { return false; } };
  page.on("pageerror", (e) => { if (appOrigin(page.url()) && !isExpectedPageError(e.message)) errors.push(`pageerror: ${e.message}`); });
  page.on("console", (m) => {
    const url = m.location()?.url ?? "";
    if (m.type() === "error" && appOrigin(url || page.url()) && !isExpectedConsoleError(m.text(), url)) errors.push(`console: ${m.text()}`);
  });
  // signIn starts a trace when it's done; this context is never traced
  page.startTrace = async () => {};
  await signIn(page, role);
  return {
    page,
    async close() {
      await context.close();
      expect(errors.map(harness.masker.redact), `page errors in the ${role}'s context`).toEqual([]);
    },
  };
}

/** The installCamera options, run only on the app's own pages (not Managed Login's). */
export function cameraScript(installCamera, options) {
  return `if (location.origin === ${JSON.stringify(PROD.app)}) (${installCamera.toString()})(${JSON.stringify(options)});`;
}
