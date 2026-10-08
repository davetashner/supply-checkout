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
// - `signIn(page, role, { fresh })`: signs in as a long-lived account, reusing a session an
//   earlier test left (lib/sessions.mjs, shared by both browser projects) unless `fresh`, waiting
//   up to 45 seconds for one on lease to come back, and otherwise
//   through Managed Login (password, and a two-step code for owner), backing off on Managed
//   Login's "Too many requests"; then checks the app's own GET /me with checkMe. At the end of
//   the test (or at signIn.release(context)) the session goes back to the pool.
/* global document, location -- readScreen's function runs in the page */
import { test as base, expect } from "@playwright/test";
import path from "node:path";
import { createCognito } from "../../scripts/journeys/lib/cognito.mjs";
import { PROD, TEAM_FOR_PROJECT, readConfig, runDir, runId, secretValues } from "../../scripts/journeys/lib/config.mjs";
import { GuardError, assertDestructiveAllowed, checkMe } from "../../scripts/journeys/lib/guards.mjs";
import { waitForMail } from "../../scripts/journeys/lib/mailbox.mjs";
import { consoleFailure, isDocumentNotFound, isExpectedConsoleError, isExpectedPageError, NOT_FOUND_WARNING } from "../../scripts/journeys/lib/console.mjs";
import { MASKED_VALUES_FILE, createMasker } from "../../scripts/journeys/lib/mask.mjs";
import { writeRecord } from "../../scripts/journeys/lib/runs.mjs";
import { createS3 } from "../../scripts/journeys/lib/s3.mjs";
import { freshTotp } from "../../scripts/journeys/lib/totp.mjs";
import { PASSWORD_CHOICE, formatScreen } from "../../scripts/journeys/lib/screen.mjs";
import { SIGN_IN, createSessionPool, sessionCookie } from "../../scripts/journeys/lib/sessions.mjs";
import { assertNotTracing, markTracing, secretFill } from "../../scripts/journeys/lib/tracing.mjs";
import { waitUntilConnected } from "../ui/app.js";

const RUM = /^https:\/\/dataplane\.rum\.[a-z0-9-]+\.amazonaws\.com\//;
const appOrigins = new Set([PROD.app, PROD.api]);
const originOf = (url) => { try { return new URL(url).origin; } catch { return ""; } };

/** Managed Login's request limit ("Too many requests: You have exceeded the request limit..."). */
const TOO_MANY_REQUESTS = /too many requests|exceeded the request limit/i;
export class TooManyRequests extends Error {}
/** How long signIn waits before each new try after "Too many requests": two more tries at most. */
export const RATE_LIMIT_BACKOFF_MS = [30_000, 60_000];
/** How long signIn waits for a leased session to come back before signing in again. */
export const SESSION_WAIT_MS = 45_000;

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
      /** The long-lived accounts' signed-in sessions, shared by the run's workers (lib/sessions.mjs). */
      sessions: createSessionPool(dir, { masker }),
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
      if (m.type() !== "error" || !appOrigins.has(originOf(url || page.url())) || isExpectedConsoleError(m.text(), url)) return;
      // A project or item 404 is counted in the summary, not a failure (lib/console.mjs)
      if (isDocumentNotFound(m.text(), url)) testInfo.annotations.push({ type: NOT_FOUND_WARNING, description: consoleFailure(m.text(), url) });
      else errors.push(consoleFailure(m.text(), url));
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
   * signIn(page, "owner" | "crew" | "viewer", { fresh }): a session from the pool, or Managed
   * Login by password (and the two-step code for owner); then the /me guard on the app's own
   * request. Tracing starts after it. `fresh` always goes through Managed Login (J0.2).
   */
  signIn: async ({ harness, identity, context }, use, testInfo) => {
    const held = [];
    // Puts the context's sessions back in the pool: the refresh cookie as it is now, since the
    // app's refresh rotated it. A closed context has nothing to give back.
    const release = async (ctx) => {
      const mine = held.filter((h) => h.context === ctx);
      for (const h of mine) held.splice(held.indexOf(h), 1);
      if (!mine.length) return;
      let cookie;
      try { cookie = sessionCookie(await ctx.cookies(PROD.api), PROD.api); } catch { return; }
      for (const h of mine) harness.sessions.put(h.role, cookie);
    };
    const signIn = async (page, role, { fresh = false } = {}) => {
      const account = harness.config.accounts[role];
      if (!account) throw new Error(`No long-lived account ${role}`);
      // A trace records the password and code typed below: never sign in while tracing
      assertNotTracing(page.context(), "a sign-in");
      identity.account = account.email;
      const ctx = page.context();
      for (let attempt = 0; ; attempt++) {
        const meResponse = page.waitForResponse((r) => r.url() === `${PROD.api}/me` && r.request().method() === "GET", { timeout: 60_000 });
        // Awaited below; a sign-in that fails first ends the test, and that rejection isn't news
        meResponse.catch(() => {});
        let session = fresh ? null : harness.sessions.take(role);
        // Every session out on lease (the other worker has it): wait for it to come back rather
        // than sign in again, if one was ever made
        if (!fresh && !session && harness.sessions.wasIssued(role)) {
          testInfo.setTimeout(testInfo.timeout + SESSION_WAIT_MS);
          for (const until = Date.now() + SESSION_WAIT_MS; !session && Date.now() < until;) {
            await page.waitForTimeout(2_000);
            session = harness.sessions.take(role);
          }
        }
        if (session) await ctx.addCookies([session]);
        await page.goto("/");
        // A session the app can't refresh (revoked, or used past its rotation) shows sign-in
        const reused = session && await Promise.race([
          meResponse.then(() => true, () => false),
          page.locator("#signIn").waitFor({ timeout: 30_000 }).then(() => false, () => false),
        ]);
        if (!reused) {
          try {
            await page.locator("#signIn").click();
            await page.waitForURL((u) => u.origin === PROD.auth);
            await managedLogin(page, account, account.totp ? harness.totpCode : null, { redact: harness.masker.redact });
          } catch (err) {
            if (!(err instanceof TooManyRequests) || attempt >= RATE_LIMIT_BACKOFF_MS.length) throw err;
            const wait = RATE_LIMIT_BACKOFF_MS[attempt];
            testInfo.setTimeout(testInfo.timeout + wait + 60_000);
            testInfo.annotations.push({ type: "journeys-warning", description: `Managed Login refused a sign-in as ${role} with "Too many requests"; tried again ${wait / 1000} seconds later` });
            await page.waitForTimeout(wait);
            continue;
          }
          await page.waitForURL((u) => u.origin === PROD.app, { timeout: 30_000 });
          harness.sessions.markIssued(role);
        }
        testInfo.annotations.push({ type: SIGN_IN, description: `${role}: ${reused ? "saved session" : "Managed Login"}` });
        const res = await meResponse;
        expect(res.status(), "GET /me after sign-in").toBe(200);
        const me = await res.json();
        harness.masker.add(me?.user?.id);
        const warnings = checkMe(me, { email: account.email, teamIds: Object.values(harness.config.teams), requireTeams: true });
        for (const w of warnings) testInfo.annotations.push({ type: "journeys-warning", description: w });
        break;
      }
      held.push({ context: ctx, role });
      await waitUntilConnected(page);
      await page.startTrace();
    };
    signIn.release = release;
    await use(signIn);
    // `context` is a dependency so that it's torn down after this: the test's own context is
    // still open here
    for (const ctx of new Set([context, ...held.map((h) => h.context)])) await release(ctx);
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

const OTHER_WAYS = /other (sign[- ]in )?(options|ways|methods)|another way|more (sign[- ]in )?options|choose (a|another) (sign[- ]in )?(option|method|way)/i;

async function reachPassword(page, { timeout, redact, submit }) {
  const field = page.locator('input[type="password"]').first();
  const choices = [
    { kind: "radio", locator: page.getByRole("radio", { name: PASSWORD_CHOICE }) },
    { kind: "button", locator: page.getByRole("button", { name: PASSWORD_CHOICE }) },
    { kind: "link", locator: page.getByRole("link", { name: PASSWORD_CHOICE }) },
  ];
  const others = [page.getByRole("button", { name: OTHER_WAYS }), page.getByRole("link", { name: OTHER_WAYS })];
  const alert = page.getByRole("alert").filter({ hasText: /\S/ });
  const done = new Set();
  const deadline = Date.now() + timeout;
  // The email's Next counts as the first action: the next page can draw its alert ("Enter the
  // code that we sent…") before its buttons, so an alert alone mustn't end the wait at once
  let lastAction = Date.now();
  while (Date.now() < deadline) {
    if (await field.isVisible()) return;
    // Read the alert before looking for choices: if the page moves on between the two, the
    // choices it now shows are still taken before the alert can end the wait
    const alerted = await alert.first().isVisible();
    let acted = false;
    for (const { kind, locator } of choices) {
      if (done.has(kind) || !(await locator.first().isVisible())) continue;
      done.add(kind);
      if (kind === "radio") {
        // The email code's radio comes selected: Continue only once the password's is
        await locator.first().check();
        await expect(locator.first(), "the Password option is selected").toBeChecked();
        await submit();
      }
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
    else if (alerted && Date.now() - lastAction > 2_000) break;
    await page.waitForTimeout(250);
  }
  if (await field.isVisible()) return;
  const screen = await readScreen(page);
  if ((screen.alerts ?? []).some((a) => TOO_MANY_REQUESTS.test(a))) throw new TooManyRequests(`Managed Login refused the sign-in: ${formatScreen(screen, redact)}`);
  throw new Error(`Managed Login showed no password field after the email (tried: ${[...done].join(", ") || "nothing"}): ${formatScreen(screen, redact)}`);
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

export { consoleFailure, isDocumentNotFound, isExpectedConsoleError, isExpectedPageError, NOT_FOUND_WARNING };
export { expect, secretFill };
