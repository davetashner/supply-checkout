// Steps for the prod billing journeys (J7, J8, J10; supply-checkout-o60.9; the spec is
// J7-billing.prod.js): two-step sign-in for the billing throwaway, Stripe's hosted pages (Checkout
// and the Customer Portal) in the sandbox, and the owner's team as /me shows it.
//
// What keeps these in the sandbox: the spec starts only if global setup read `test` from every
// account's /me (lib/setup.mjs) and the throwaway's own /me says so again; a page is opened only
// after its URL is checked to be a sandbox session (isSandboxCheckoutUrl, isSandboxPortalUrl);
// card numbers are Stripe's public test cards, typed through secretFill.
//
// Nothing here is traced or filmed: the specs turn it off, since the pages show the throwaway's
// address and the two-step secret. A failing step describes the page (readScreen, redacted).
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PROD, runDir } from "../../scripts/journeys/lib/config.mjs";
import { parseTotpKey } from "../../scripts/journeys/lib/billing.mjs";
import { checkMe } from "../../scripts/journeys/lib/guards.mjs";
import { recordKey } from "../../scripts/journeys/lib/runs.mjs";
import { seal } from "../../scripts/journeys/lib/seal.mjs";
import { formatScreen } from "../../scripts/journeys/lib/screen.mjs";
import { isSandboxCheckoutUrl, isSandboxPortalUrl } from "../../scripts/journeys/lib/stripe-sandbox.mjs";
import { freshTotp } from "../../scripts/journeys/lib/totp.mjs";
import { modal } from "../ui/index.js";
import { expect, managedLogin, readScreen, secretFill } from "./fixtures.mjs";
import { apiCall } from "./steps.mjs";

/** The base32 secret and password of a throwaway whose two-step is on: what sign-in needs. */
export function totpFor(harness, role) {
  const stateFile = path.join(runDir(process.env, harness.runId), `totp-step-${role}`);
  return (secret) => freshTotp(secret, { stateFile });
}

/** Fails with what the page shows (redacted) when `fn` throws, so a changed Stripe page is diagnosable from the public log. */
export async function described(page, harness, what, fn) {
  try {
    return await fn();
  } catch (err) {
    const screen = formatScreen(await readScreen(page).catch(() => ({})), harness.masker.redact);
    // Only the redacted first line: the error's own cause could hold unmasked values
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`${what}: ${harness.masker.redact(String(err?.message ?? err).split("\n")[0])} (${screen})`);
  }
}

/**
 * Account → Set up two-step sign-in, as the app's own dialog has it: a password (the throwaway
 * signed in by email code and has none), the app's secret, a code from it. The password, and
 * then the secret too, are sealed into the run record before they take effect (lib/seal.mjs), so
 * a run that dies from here on can still be cleaned up. Ends on "Two-step sign-in is on": every
 * session of the account has ended. Returns the authenticator secret (masked).
 */
export async function turnOnTwoStep(page, { harness, account, password }) {
  const sealWith = (secrets) => account.keeper.update({ sealed: seal(secrets, harness.config.accounts.owner.password, { aad: recordKey(harness.runId, account.role) }) });
  harness.masker.add(password);
  await page.locator("#accountOpen").click();
  await modal(page).locator("#twoStepOpen").click();
  const m = modal(page);
  await expect(m.getByRole("heading", { name: "Two-step sign-in" })).toBeVisible();
  await sealWith({ password });
  await secretFill(m.getByLabel("New password", { exact: true }), password);
  await secretFill(m.getByLabel("Confirm new password", { exact: true }), password);
  await m.locator("#savePassword").click();
  await expect(m.locator("#totpKey")).toBeVisible({ timeout: 30_000 });
  const secret = parseTotpKey(await m.locator("#totpKey").textContent());
  harness.masker.add(secret);
  await sealWith({ password, totp: secret });
  await secretFill(m.locator("#totpCode"), await totpFor(harness, account.role)(secret));
  await m.locator("#turnOn").click();
  await expect(page.getByRole("heading", { name: "Two-step sign-in is on" })).toBeVisible({ timeout: 30_000 });
  return secret;
}

/**
 * From "Two-step sign-in is on": Sign in again, through Managed Login with the password and a
 * code from the authenticator secret, back to the app, and the guard on its own GET /me (the
 * throwaway, two-step on, in the teams the run made). Returns the /me body.
 */
export async function signInWithTwoStep(page, { harness, account, password, secret }) {
  await page.locator("#signInAgain").click();
  await expect(page.locator("#signIn")).toBeVisible({ timeout: 30_000 });
  const meResponse = page.waitForResponse((r) => r.url() === `${PROD.api}/me` && r.request().method() === "GET", { timeout: 120_000 });
  meResponse.catch(() => {});
  await page.locator("#signIn").click();
  await page.waitForURL((u) => u.origin === PROD.auth);
  await managedLogin(page, { email: account.address, password }, () => totpFor(harness, account.role)(secret), { redact: harness.masker.redact });
  await page.waitForURL((u) => u.origin === PROD.app, { timeout: 30_000 });
  const res = await meResponse;
  expect(res.status(), "GET /me after the two-step sign-in").toBe(200);
  const me = await res.json();
  checkMe(me, { email: account.address, teamIds: [...harness.createdTeams] });
  expect(me.user.mfa, "two-step sign-in is on").toBe("totp");
  return me;
}

/** The team's body from GET /me, as the owner's token sees it. */
export async function teamNow(page, token, teamId) {
  const res = await apiCall(page, await token(), "GET", "/me");
  expect(res.status, "GET /me").toBe(200);
  return res.body.teams.find((t) => t.id === teamId);
}

const sandboxOnly = (harness, link) => {
  harness.masker.add(link);
  try { harness.masker.add(new URL(link).pathname); } catch {}
};

/**
 * Starts Checkout as the Subscribe button does (POST billing/checkout, Starter, monthly; a team
 * still in its trial has no button for it until J7.1's plan picker is built), checks the answer
 * is a sandbox session, and opens it. Returns nothing; the page is on Stripe.
 */
export async function openCheckout(page, { harness, token, teamId }) {
  const res = await apiCall(page, await token(), "POST", `/teams/${encodeURIComponent(teamId)}/billing/checkout`, { plan: "starter", interval: "month" }, { "Idempotency-Key": randomUUID() });
  expect(res.status, "POST billing/checkout").toBe(201);
  const link = res.body?.checkout?.url;
  if (typeof link === "string") sandboxOnly(harness, link);
  // Fail closed: nothing but a sandbox session is ever opened
  expect(isSandboxCheckoutUrl(link), "Checkout answered with a sandbox session").toBe(true);
  await page.goto(link);
}

const TEST_CARD = { number: "4242424242424242", expiry: "1234", cvc: "123", name: "Journeys Test", postal: "10001" };
// A fixed, fake US address for the billing address the Checkout Session requires (`billing_address_collection: required`)
const TEST_ADDRESS = { line1: "123 Test Street", city: "New York", state: "NY", postal: TEST_CARD.postal };

/**
 * Fills the billing name and address fields Checkout shows (it requires them), whichever of them there are. The
 * name is here and not only with the card: the free trial shows no card fields, so `typeCard` never runs, and
 * Checkout kept answering REQUIRED on the empty name (the journeys run after v1.18.0).
 */
async function fillBillingAddress(page) {
  const name = page.locator("#billingName");
  if (await name.isVisible().catch(() => false)) await secretFill(name, TEST_CARD.name);
  const country = page.locator("#billingCountry");
  if (await country.isVisible().catch(() => false)) await country.selectOption("US");
  const line1 = page.locator("#billingAddressLine1");
  if (await line1.isVisible().catch(() => false)) await secretFill(line1, TEST_ADDRESS.line1);
  const city = page.locator("#billingLocality");
  if (await city.isVisible().catch(() => false)) await secretFill(city, TEST_ADDRESS.city);
  const state = page.locator("#billingAdministrativeArea");
  if (await state.isVisible().catch(() => false)) {
    if ((await state.evaluate((el) => el.tagName)) === "SELECT") await state.selectOption(TEST_ADDRESS.state);
    else await secretFill(state, TEST_ADDRESS.state);
  }
  const postal = page.locator("#billingPostalCode");
  if (await postal.isVisible().catch(() => false)) await secretFill(postal, TEST_ADDRESS.postal);
}

/** Types a test card into Checkout's fields, or the Elements' frames (the Portal's form). */
async function typeCard(page) {
  const direct = page.locator("#cardNumber");
  if (await direct.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) {
    await secretFill(direct, TEST_CARD.number);
    await secretFill(page.locator("#cardExpiry"), TEST_CARD.expiry);
    await secretFill(page.locator("#cardCvc"), TEST_CARD.cvc);
    const name = page.locator("#billingName");
    if (await name.isVisible()) await secretFill(name, TEST_CARD.name);
    const postal = page.locator("#billingPostalCode");
    if (await postal.isVisible()) await secretFill(postal, TEST_CARD.postal);
    return;
  }
  const frames = page.frameLocator('iframe[name^="__privateStripeFrame"]');
  await secretFill(frames.locator('input[name="cardnumber"]').first(), TEST_CARD.number);
  await secretFill(frames.locator('input[name="exp-date"]').first(), TEST_CARD.expiry);
  await secretFill(frames.locator('input[name="cvc"]').first(), TEST_CARD.cvc);
  const postal = frames.locator('input[name="postal"]').first();
  if (await postal.isVisible().catch(() => false)) await secretFill(postal, TEST_CARD.postal);
}

/**
 * Completes the sandbox Checkout page: the email (Stripe asks for one when the customer has
 * none), and the test card if it asks for one (it doesn't while the team's free trial runs:
 * `payment_method_collection: if_required`), then Start trial / Subscribe. Waits for the redirect
 * back to the app.
 */
export async function completeCheckout(page, { harness, email }) {
  await described(page, harness, "Stripe Checkout", async () => {
    const submit = page.locator('[data-testid="hosted-payment-submit-button"], button.SubmitButton').first();
    await expect(submit).toBeVisible({ timeout: 60_000 });
    const emailField = page.locator("#email");
    if (await emailField.isVisible()) await secretFill(emailField, email);
    const card = page.getByRole("radio", { name: /^card$/i });
    if (await card.isVisible().catch(() => false)) await card.check();
    if (await page.locator("#cardNumber").waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false)) await typeCard(page);
    await fillBillingAddress(page);
    await submit.click();
    try {
      await page.waitForURL((u) => u.origin === PROD.app, { timeout: 120_000 });
    } catch (err) {
      // Which of the form's fields are still empty, by name only (never a value), so a changed Checkout form is diagnosable from the public log
      /* global document -- this function runs in the page */
      const empty = await page.evaluate(() => [...document.querySelectorAll("input, select, textarea")]
        .filter((el) => el.offsetParent !== null && !el.value)
        .map((el) => el.getAttribute("aria-label") || el.id || el.name || el.type)).catch(() => []);
      // The first line only, as `described` does: the error's own cause could hold unmasked values
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`${String(err?.message ?? err).split("\n")[0]} [still empty: ${empty.join(", ") || "none"}]`);
    }
  });
}

/** The "Billing" button's Customer Portal: checks the link is a sandbox session, and opens it. */
export async function openPortal(page, { harness }) {
  await page.locator(".teambar #manageBilling").click();
  const link = page.locator("#billingLink");
  await expect(link).toBeVisible({ timeout: 30_000 });
  const href = await link.getAttribute("href");
  if (href) sandboxOnly(harness, href);
  expect(isSandboxPortalUrl(href), "Billing opens a sandbox Customer Portal session").toBe(true);
  await page.goto(href);
}

const CANCEL = /^(cancel (plan|subscription)|confirm cancell?ation)$/i;
const CANCELED = /(will be|has been|is) cancell?ed|cancell?s on|ends on|renewal.*cancell?ed/i;

/** In the Portal: Cancel (at the period's end), confirming until Stripe says it is canceled. */
export async function cancelInPortal(page, { harness }) {
  await described(page, harness, "Stripe Customer Portal cancellation", async () => {
    const start = page.getByRole("link", { name: CANCEL }).or(page.getByRole("button", { name: CANCEL })).first();
    await expect(start).toBeVisible({ timeout: 60_000 });
    await start.click();
    for (let i = 0; i < 4; i++) {
      if (await page.getByText(CANCELED).first().isVisible().catch(() => false)) return;
      const confirm = page.getByRole("button", { name: CANCEL }).first();
      if (await confirm.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) await confirm.click();
    }
    await expect(page.getByText(CANCELED).first()).toBeVisible({ timeout: 30_000 });
  });
}

/** In the Portal: replace the payment method with the test card. */
export async function updateCardInPortal(page, { harness }) {
  await described(page, harness, "Stripe Customer Portal card update", async () => {
    const update = page.getByRole("link", { name: /update (payment method|information)|add payment method/i }).or(page.getByRole("button", { name: /update (payment method|information)|add payment method/i })).first();
    await expect(update).toBeVisible({ timeout: 60_000 });
    await update.click();
    const add = page.getByRole("button", { name: /add payment method/i }).first();
    if (await add.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false)) await add.click();
    await typeCard(page);
    await page.getByRole("button", { name: /^(save|add|update|submit)/i }).first().click();
    await expect(page.getByText(/4242/).first()).toBeVisible({ timeout: 60_000 });
  });
}

/** Back to the app from the Portal: its "Return to …" link if there, else the app's address. */
export async function leavePortal(page) {
  const back = page.getByRole("link", { name: /^return to /i }).first();
  if (await back.isVisible().catch(() => false)) await back.click();
  else await page.goto(PROD.app);
  await page.waitForURL((u) => u.origin === PROD.app, { timeout: 60_000 });
}
