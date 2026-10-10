// Steps for the prod journeys of the run's throwaway accounts (J1, J3, J5 and J11; the harness
// side is scripts/journeys/lib/throwaway.mjs): the try's two throwaways, signing one up, signing
// it in through Managed Login by email code, a browser context of its own for the crew member,
// and what the pages showed when a step failed.
//
// Throwaways sign in by email code only: they have no password. Their pages are never traced,
// filmed or screenshotted (the spec turns those off): every page shows the throwaway addresses,
// and the sign-in types a code. A failed step's description of each page (lib/screen.mjs,
// redacted) is a `journeys-screen` annotation instead.
import { formatScreen } from "../../scripts/journeys/lib/screen.mjs";
import { PROD } from "../../scripts/journeys/lib/config.mjs";
import { checkMe } from "../../scripts/journeys/lib/guards.mjs";
import { signUpThrowaway, throwawayPair } from "../../scripts/journeys/lib/throwaway.mjs";
import { assertNotTracing } from "../../scripts/journeys/lib/tracing.mjs";
import { expect, guardDestructiveCalls, managedLoginByCode, readScreen } from "./fixtures.mjs";
import { newDeviceContext, watchAppErrors } from "./steps.mjs";

/** This try's owner and crew member: `{ role, address, keeper }` each (their run records). */
export function throwaways(harness, testInfo) {
  return throwawayPair({ runId: harness.runId, retry: testInfo.retry, addresses: harness.throwaways, write: (role, record) => harness.record(role, record) });
}

/** Signs the throwaway up (Cognito SignUp, no password) and confirms it with the mailed code. */
export function signUp(harness, account) {
  return signUpThrowaway({ cognito: harness.cognito, mail: harness.mail, keeper: account.keeper });
}

/**
 * From the app's sign-in screen on `page`: Managed Login by email code (the code from the
 * mailbox), back to the app, and the guard on the app's own GET /me: a verified account at the
 * test mail domain, the throwaway signed in as, in no team the run didn't create. Records the
 * account's user ID. Returns the /me body.
 */
export async function signInByCode(page, { harness, account }) {
  assertNotTracing(page.context(), "an email code sign-in");
  await expect(page.locator("#signIn")).toBeVisible({ timeout: 30_000 });
  const meResponse = page.waitForResponse((r) => r.url() === `${PROD.api}/me` && r.request().method() === "GET", { timeout: 120_000 });
  // Awaited below; a sign-in that fails first ends the test, and that rejection isn't news
  meResponse.catch(() => {});
  await page.locator("#signIn").click();
  await page.waitForURL((u) => u.origin === PROD.auth);
  const readCode = async (since) => (await harness.mail({ to: account.address, since, want: "code" })).code;
  await managedLoginByCode(page, account.address, readCode, { redact: harness.masker.redact });
  await page.waitForURL((u) => u.origin === PROD.app, { timeout: 30_000 });
  const res = await meResponse;
  expect(res.status(), "GET /me after sign-in").toBe(200);
  const me = await res.json();
  harness.masker.add(me?.user?.id);
  checkMe(me, { email: account.address, teamIds: [...harness.createdTeams] });
  await account.keeper.update({ userId: me.user.id });
  return me;
}

/**
 * A browser context of the throwaway's own (the crew member on their phone): the project's
 * device, RUM aborted, and account deletion and team closure refused unless the guard allows
 * them as this throwaway. `close()` closes it and fails the test on any error it saw.
 */
export async function throwawayContext({ browser, harness, testInfo }, account) {
  const context = await newDeviceContext(browser, testInfo);
  const refused = [];
  await guardDestructiveCalls(context, { harness, account: () => account.address, refused });
  const page = await context.newPage();
  const watch = watchAppErrors(page, [PROD.app, PROD.api], testInfo);
  return {
    page,
    async close() {
      // What the page did is over; closing it isn't the app's doing (watchAppErrors)
      const errors = watch.stop();
      await context.close();
      expect([...refused, ...errors].map(harness.masker.redact), `page errors in the ${account.role}'s context`).toEqual([]);
    },
  };
}

/** Each open page's description (headings, alerts, labels, controls; redacted), as annotations. */
export async function noteScreens(testInfo, harness, pages) {
  for (const [name, page] of Object.entries(pages)) {
    if (!page || page.isClosed()) continue;
    try {
      testInfo.annotations.push({ type: "journeys-screen", description: `${name}: ${formatScreen(await readScreen(page), harness.masker.redact)}` });
    } catch { /* the page went away */ }
  }
}
