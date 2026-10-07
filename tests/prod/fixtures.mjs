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
import { test as base, expect } from "@playwright/test";
import path from "node:path";
import { createCognito } from "../../scripts/journeys/lib/cognito.mjs";
import { PROD, TEAM_FOR_PROJECT, readConfig, runDir, runId, secretValues } from "../../scripts/journeys/lib/config.mjs";
import { GuardError, assertDestructiveAllowed, checkMe } from "../../scripts/journeys/lib/guards.mjs";
import { waitForMail } from "../../scripts/journeys/lib/mailbox.mjs";
import { createMasker } from "../../scripts/journeys/lib/mask.mjs";
import { writeRecord } from "../../scripts/journeys/lib/runs.mjs";
import { createS3 } from "../../scripts/journeys/lib/s3.mjs";
import { freshTotp } from "../../scripts/journeys/lib/totp.mjs";
import { waitUntilConnected } from "../ui/app.js";

const RUM = /^https:\/\/dataplane\.rum\.[a-z0-9-]+\.amazonaws\.com\//;
const appOrigins = new Set([PROD.app, PROD.api]);
const originOf = (url) => { try { return new URL(url).origin; } catch { return ""; } };

/** Console errors the app logs in prod that aren't failures: aborted RUM requests, and the refresh before sign-in. */
export function isExpectedConsoleError(text, url) {
  if (RUM.test(url ?? "") && /Failed to load resource|net::ERR_FAILED/.test(text)) return true;
  if (url === `${PROD.api}/auth/refresh` && /status of 401/.test(text)) return true;
  return false;
}

export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured object
  harness: [async ({}, use) => {
    const env = process.env;
    const config = readConfig(env);
    const masker = createMasker();
    for (const v of secretValues(config)) masker.add(v);
    const id = runId(env);
    const dir = runDir(env, id);
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
      /** The app's next mail to `to` since `since`: a code or a link (lib/mailbox.mjs). */
      mail: (opts) => waitForMail({ s3: mailS3, masker, log: (l) => console.log(masker.redact(l)), ...opts }),
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
    page.on("pageerror", (e) => { if (appOrigins.has(originOf(page.url()))) errors.push(`pageerror: ${e.message}`); });
    page.on("console", (m) => {
      const url = m.location()?.url ?? "";
      if (m.type() === "error" && appOrigins.has(originOf(url || page.url())) && !isExpectedConsoleError(m.text(), url)) errors.push(`console: ${m.text()}`);
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
      identity.account = account.email;
      const meResponse = page.waitForResponse((r) => r.url() === `${PROD.api}/me` && r.request().method() === "GET", { timeout: 60_000 });
      await page.goto("/");
      await page.locator("#signIn").click();
      await page.waitForURL((u) => u.origin === PROD.auth);
      await managedLogin(page, account, account.totp ? harness.totpCode : null);
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
 * Managed Login's pages: the email, then the password (choosing it if the page offers other
 * ways first), then the two-step code when asked.
 */
export async function managedLogin(page, account, totpCode) {
  const submit = () => page.getByRole("button", { name: /^(next|continue|sign in)$/i }).first().click();
  await page.getByLabel(/email/i).first().fill(account.email);
  await submit();
  const password = page.getByLabel(/^password$/i).first();
  const choosePassword = page.getByRole("button", { name: /password/i }).first();
  await expect(password.or(choosePassword)).toBeVisible({ timeout: 20_000 });
  if (!(await password.isVisible())) await choosePassword.click();
  await password.fill(account.password);
  await submit();
  if (totpCode) {
    const code = page.getByLabel(/code/i).first();
    await expect(code).toBeVisible({ timeout: 20_000 });
    await code.fill(await totpCode());
    await submit();
  }
}

export { expect };
