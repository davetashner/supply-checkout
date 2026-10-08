// Fixtures for the prod journey specs (tests/prod/*.prod.js). Specs import `test` and `expect`
// from here and the screen-level steps from tests/ui/, never tests/helpers.js (its fakes and
// mocks don't exist in prod).
//
// - `harness` (per worker): the run ID, the checked configuration, the masker, the mailbox
//   reader, the run records, the throwaway addresses global setup made.
// - `page`: fails the test on an uncaught error or console error from the app (not from Managed
//   Login's own pages), aborts requests to the RUM data plane (test sessions add no billed RUM
//   events), refuses any account deletion or team closure that assertDestructiveAllowed doesn't
//   allow, and keeps a trace only for a failed test, started after sign-in.
// - `signIn(page, role)`: signs in as a long-lived account through Managed Login (password, and
//   a two-step code for owner), then checks the app's own GET /me with checkMe.
/* global document, location -- readScreen's function runs in the page */
import { test as base, expect } from "@playwright/test";
import path from "node:path";
import { createCognito } from "../../scripts/journeys/lib/cognito.mjs";
import { PROD, TEAM_FOR_PROJECT, readConfig, runDir, runId, secretValues } from "../../scripts/journeys/lib/config.mjs";
import { GuardError, assertDestructiveAllowed, checkMe } from "../../scripts/journeys/lib/guards.mjs";
import { waitForMail } from "../../scripts/journeys/lib/mailbox.mjs";
import { consoleFailure, isExpectedConsoleError, isExpectedPageError } from "../../scripts/journeys/lib/console.mjs";
import { MASKED_VALUES_FILE, createMasker } from "../../scripts/journeys/lib/mask.mjs";
import { writeRecord } from "../../scripts/journeys/lib/runs.mjs";
import { createS3 } from "../../scripts/journeys/lib/s3.mjs";
import { freshTotp } from "../../scripts/journeys/lib/totp.mjs";
import { formatScreen } from "../../scripts/journeys/lib/screen.mjs";
import { assertNotTracing, markTracing, secretFill } from "../../scripts/journeys/lib/tracing.mjs";
import { waitUntilConnected } from "../ui/app.js";

const RUM = /^https:\/\/dataplane\.rum\.[a-z0-9-]+\.amazonaws\.com\//;
const appOrigins = new Set([PROD.app, PROD.api]);
const originOf = (url) => { try { return new URL(url).origin; } catch { return ""; } };

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured object
  harness: [async ({}, use) => {
    const env = process.env;
    const config = readConfig(env);
    const id = runId(env);
    const dir = runDir(env, id);
    const masker = createMasker({ persist: path.join(dir, MASKED_VALUES_FILE) });
    for (const v of secretValues(config)) masker.remember(v);
    const throwaways = { owner: env.JOURNEYS_THROWAWAY_OWNER, crew: env.JOURNEYS_THROWAWAY_CREW };
    for (const a of Object.values(throwaways)) masker.add(a);
    const mailS3 = createS3(config.buckets.mail);
    await use({
      runId: id,
      config,
      masker,
      throwaways,
      cognito: createCognito({ region: PROD.region, clientId: env.JOURNEYS_CLIENT_ID }),
      totpCode: () => freshTotp(config.accounts.owner.totp, { stateFile: path.join(dir, "totp-step") }),
      /** The app's next mail to `to` since `since`: a code or a link (lib/mailbox.mjs). Never to a long-lived account. */
      mail: (opts) => waitForMail({ s3: mailS3, masker, log: (l) => console.log(masker.redact(l)), ...opts, refuse: Object.values(config.accounts).map((a) => a.email) }),
      /** Records a throwaway account's progress (`started` before sign-up, `deleted` after J11). */
      record: (role, patch) => writeRecord(mailS3, { runId: id, role, address: throwaways[role], ...patch }),
      /** Teams the run's throwaways created (the specs add to it), for the destructive-call guard. */
      createdTeams: new Set(),
    });
  }, { scope: "worker" }],

  /** The long-lived team for this browser project. */
  journeyTeam: async ({ harness }, use, testInfo) => {
    await use(harness.config.teams[TEAM_FOR_PROJECT[testInfo.project.name]]);
  },

  /** Who the page is signed in as, for the destructive-call guard. Set by signIn (and by specs signing up a throwaway). */
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured object
  identity: async ({}, use) => { await use({ account: null }); },

  page: async ({ page, harness, identity }, use, testInfo) => {
    const errors = [];
    page.on("pageerror", (e) => { if (appOrigins.has(originOf(page.url())) && !isExpectedPageError(e.message)) errors.push(`pageerror: ${e.message}`); });
    page.on("console", (m) => {
      const url = m.location()?.url ?? "";
      if (m.type() === "error" && appOrigins.has(originOf(url || page.url())) && !isExpectedConsoleError(m.text(), url)) errors.push(consoleFailure(m.text(), url));
    });
    await page.context().route(RUM, (r) => r.abort());
    // Account deletion and team closure only as the run's throwaway, on a team the run created
    await page.context().route((url) => url.origin === PROD.api && (url.pathname === "/me" || /^\/teams\/[^/]+\/close$/.test(url.pathname)), async (route) => {
      const req = route.request();
      const close = /^\/teams\/([^/]+)\/close$/.exec(new URL(req.url()).pathname);
      if (!(req.method() === "DELETE" || (close && req.method() === "POST"))) return route.fallback();
      try {
        const longLived = { emails: Object.values(harness.config.accounts).map((a) => a.email), teamIds: Object.values(harness.config.teams) };
        // The server checks the caller owns the team; here, that the run created it
        const team = close ? { id: decodeURIComponent(close[1]), role: "owner" } : undefined;
        assertDestructiveAllowed({ action: close ? "closeTeam" : "deleteAccount", account: identity.account, runIds: [harness.runId], longLived, team, createdTeams: [...harness.createdTeams] });
        return route.fallback();
      } catch (err) {
        errors.push(`guard: ${err instanceof GuardError ? err.message : "refused a destructive call"}`);
        return route.abort("blockedbyclient");
      }
    });
    let tracing = false;
    page.startTrace = async () => {
      if (tracing) return;
      markTracing(page.context());
      await page.context().tracing.start({ screenshots: true, snapshots: true, title: testInfo.title });
      tracing = true;
    };
    await use(page);
    if (tracing) {
      const failed = testInfo.status !== testInfo.expectedStatus;
      await page.context().tracing.stop(failed ? { path: testInfo.outputPath("trace.zip") } : undefined);
    }
    expect(errors.map(harness.masker.redact), "page errors").toEqual([]);
  },

  /**
   * signIn(page, "owner" | "crew" | "viewer"): Managed Login by password (and the two-step code
   * for owner), then the /me guard on the app's own request. Tracing starts after it.
   */
  signIn: async ({ harness, identity }, use, testInfo) => {
    await use(async (page, role) => {
      const account = harness.config.accounts[role];
      if (!account) throw new Error(`No long-lived account ${role}`);
      // A trace records the password and code typed below: never sign in while tracing
      assertNotTracing(page.context(), "a sign-in");
      identity.account = account.email;
      const meResponse = page.waitForResponse((r) => r.url() === `${PROD.api}/me` && r.request().method() === "GET", { timeout: 60_000 });
      // Awaited below; a sign-in that fails first ends the test, and that rejection isn't news
      meResponse.catch(() => {});
      await page.goto("/");
      await page.locator("#signIn").click();
      await page.waitForURL((u) => u.origin === PROD.auth);
      await managedLogin(page, account, account.totp ? harness.totpCode : null, { redact: harness.masker.redact });
      await page.waitForURL((u) => u.origin === PROD.app, { timeout: 30_000 });
      const res = await meResponse;
      expect(res.status(), "GET /me after sign-in").toBe(200);
      const me = await res.json();
      harness.masker.add(me?.user?.id);
      const warnings = checkMe(me, { email: account.email, teamIds: Object.values(harness.config.teams), requireTeams: true });
      for (const w of warnings) testInfo.annotations.push({ type: "journeys-warning", description: w });
      await waitUntilConnected(page);
      await page.startTrace();
    });
  },
});

/**
 * Managed Login's pages: the email, then the password, then the two-step code when asked. Every
 * value goes in through secretFill.
 *
 * The user pool allows a password, an email code and a passkey as the first factor (choice-based
 * sign-in). An account that can only use a password (the owner: Cognito offers no email code to
 * a user with MFA) goes straight to the password. Any other account (crew, viewer) is mailed a
 * code at once and shown "Check your email" with a "Verification code" field and a "Try another
 * way" button, behind which is the password. The long-lived accounts take the password, so a
 * run doesn't wait on mail for every sign-in (the throwaways prove the email code): after the
 * email this takes whichever leads to the password field (a password radio, button or link, or
 * "Try another way" / "Other sign-in options"), each at most once, and stops early on an alert.
 * The code mailed meanwhile is never used: the fixtures' mail() refuses the long-lived
 * addresses, and cleanup deletes those messages (sweepInbox in lib/mailbox.mjs). If no password field turns up it fails with what the page
 * showed (formatScreen: headings, alerts, labels and control names, redacted, never a value).
 */
export async function managedLogin(page, account, totpCode, { timeout = 20_000, redact = (s) => s } = {}) {
  const submit = () => page.getByRole("button", { name: /^(next|continue|sign in)$/i }).first().click();
  await secretFill(page.getByLabel(/email/i).first(), account.email);
  await submit();
  await reachPassword(page, { timeout, redact, submit });
  await secretFill(page.locator('input[type="password"]').first(), account.password);
  await submit();
  if (totpCode) {
    const code = page.getByLabel(/code/i).first();
    await expect(code).toBeVisible({ timeout: 20_000 });
    await secretFill(code, await totpCode());
    await submit();
  }
}

// A control naming the password that isn't a way to sign in with it
const PASSWORD_CHOICE = /^(?!.*(forgot|reset|show|hide|change|new password)).*password/i;
const OTHER_WAYS = /other (sign[- ]in )?(options|ways|methods)|another way|more (sign[- ]in )?options|choose (a|another) (sign[- ]in )?(option|method|way)/i;

async function reachPassword(page, { timeout, redact, submit }) {
  const field = page.locator('input[type="password"]').first();
  const choices = [
    { kind: "radio", locator: page.getByRole("radio", { name: /password/i }) },
    { kind: "button", locator: page.getByRole("button", { name: PASSWORD_CHOICE }) },
    { kind: "link", locator: page.getByRole("link", { name: PASSWORD_CHOICE }) },
  ];
  const others = [page.getByRole("button", { name: OTHER_WAYS }), page.getByRole("link", { name: OTHER_WAYS })];
  const alert = page.getByRole("alert").filter({ hasText: /\S/ });
  const done = new Set();
  const deadline = Date.now() + timeout;
  let lastAction = 0;
  while (Date.now() < deadline) {
    if (await field.isVisible()) return;
    let acted = false;
    for (const { kind, locator } of choices) {
      if (done.has(kind) || !(await locator.first().isVisible())) continue;
      done.add(kind);
      if (kind === "radio") { await locator.first().check(); await submit(); }
      else await locator.first().click();
      acted = true;
      break;
    }
    if (!acted && !done.has("other")) {
      for (const other of others) {
        if (!(await other.first().isVisible())) continue;
        done.add("other");
        await other.first().click();
        acted = true;
        break;
      }
    }
    // An alert ends the wait only when there's nothing left to try and the page has had time to
    // move on from the last click (a notice can be an alert too)
    if (acted) lastAction = Date.now();
    else if (Date.now() - lastAction > 2_000 && (await alert.first().isVisible())) break;
    await page.waitForTimeout(250);
  }
  if (await field.isVisible()) return;
  throw new Error(`Managed Login showed no password field after the email (tried: ${[...done].join(", ") || "nothing"}): ${formatScreen(await readScreen(page), redact)}`);
}

/** The page's headings, alerts, field labels and control names (never a field's value). */
export function readScreen(page) {
  return page.evaluate(() => {
    const shown = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const texts = (sel) => [...document.querySelectorAll(sel)].filter(shown).map((el) => el.innerText || el.textContent || "");
    const name = (el) => el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.getAttribute("title") || "";
    return {
      url: location.href,
      headings: texts("h1, h2, h3, [role=heading]"),
      alerts: texts("[role=alert], [aria-live]"),
      fields: [...document.querySelectorAll("input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea, select")].filter(shown).map((el) => `${name(el) || el.getAttribute("name") || "?"} (${el.type || el.tagName.toLowerCase()})`),
      controls: [...document.querySelectorAll("button, a[href], [role=button], [role=link], input[type=radio], input[type=checkbox], [role=radio], [role=tab], [role=option]")].filter(shown).map((el) => `${el.matches("input[type=radio], [role=radio]") ? "radio" : el.matches("a, [role=link]") ? "link" : "button"} ${name(el)}`),
    };
  });
}

export { consoleFailure, isExpectedConsoleError, isExpectedPageError };
export { expect, secretFill };
