// The web build's runtime (src/aws/) when a team's subscription has ended: read-only with a
// clear notice, and for its owners a way to subscribe again on Stripe Checkout
// (src/aws/account.js, db.js), against the fake backend in tests/fake-aws.js. The server's
// side is in backend/test/billing-worker.test.ts and billing-api.test.ts.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { FakeBackend, TEAM, openAws, connected } from "./fake-aws.js";

test.use({ reducedMotion: "reduce" });

const ENDED = { status: "canceled", plan: "starter", subscriptionEnded: true, members: 4 };
const CHECKOUT = "/teams/t1/billing/checkout";
const STRIPE = "https://checkout.stripe.test/c/pay/cs_test_1";
const bar = (page) => page.locator(".teambar");
const error = (status, code, extra = {}) => ({ status, body: { error: { code, message: code, ...extra } } });

async function open(page, backend, options) {
  await openAws(page, backend, options);
  await connected(page);
  return backend;
}

test("an owner sees why the team is read-only, and subscribes again through Stripe Checkout", { tag: ["@J7.2"] }, async ({ page }) => {
  // A checklist this device started doesn't come back for a team that can't change
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED }] }), { storage: { local: { "supplyCheckout.firstRun.t1": "{}" } } });
  await expect(bar(page).locator(".closed-note")).toHaveText("This team's subscription has ended, so it's read-only. Nothing has been deleted: everyone can still see it, and you can export it. Subscribe to make changes again.");
  await expect(page.locator("#notice")).toHaveText("This team's subscription ended, so nothing in it can be changed until an owner subscribes.");
  await expect(bar(page).getByRole("button", { name: "Import CSV" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ New project" })).toHaveCount(0);
  await expect(page.locator("#firstRun")).toHaveCount(0);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);

  // The first try fails; the second, with the same key, gets the page
  backend.on("POST", CHECKOUT, { abort: true });
  backend.on("POST", CHECKOUT, { status: 201, body: { checkout: { url: STRIPE, expiresAt: "2026-09-28T12:00:00.000Z", trialEndsAt: null } } });
  await bar(page).getByRole("button", { name: "Subscribe" }).click();
  await expect(page.locator("#toast")).toHaveText("Couldn't start checkout. Check your connection and try again.");
  await bar(page).getByRole("button", { name: "Subscribe" }).click();
  const link = bar(page).getByRole("link", { name: "Continue to checkout" });
  await expect(link).toHaveAttribute("href", STRIPE);
  await expect(link).toBeFocused();
  const calls = backend.requests("POST", CHECKOUT);
  // No seat count: the server bills the team's owners and editors (supply-checkout-8jc.20)
  expect(calls.map((c) => c.body)).toEqual([
    { plan: "starter", interval: "month" },
    { plan: "starter", interval: "month" },
  ]);
  expect(calls[0].headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1].headers["idempotency-key"]).toBe(calls[0].headers["idempotency-key"]);
});

test("an owner whose team already subscribed meanwhile is told to reload", { tag: ["@J7.2"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, members: null }] }));
  backend.on("POST", CHECKOUT, error(409, "aborted", { reason: "already_subscribed" }));
  await bar(page).getByRole("button", { name: "Subscribe" }).click();
  await expect(page.locator("#toast")).toHaveText("This team already has a subscription. Reload the page to see it.");
  // No seat count, whatever the team's member count
  expect(backend.requests("POST", CHECKOUT)[0].body).toEqual({ plan: "starter", interval: "month" });
});

test("a contributor is told to ask an owner, with no way to subscribe", { tag: ["@J7"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, role: "contributor" }] }));
  await expect(bar(page).locator(".closed-note")).toHaveText("This team's subscription has ended, so it's read-only. Nothing has been deleted: everyone can still see it. Ask an owner to subscribe to make changes again.");
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toHaveCount(0);
  await expect(page.locator("#notice")).toHaveText("This team's subscription ended, so nothing in it can be changed until an owner subscribes.");
});

test("a closed team whose subscription also ended shows only the closure", { tag: ["@J7"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z" }] }));
  await expect(bar(page).locator(".closed-note")).toHaveCount(1);
  await expect(bar(page).locator(".closed-note")).toContainText("This team was closed");
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toHaveCount(0);
  await expect(page.locator("#notice")).toHaveText("This team is closed, so nothing in it can be changed.");
});

test("a write refused because the subscription ended meanwhile switches the app to view-only", { tag: ["@J7"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend());
  backend.on("PUT", /^\/teams\/t1\/projects\//, error(403, "permission_denied", { reason: "subscription_ended" }));
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Delta");
  await page.getByRole("button", { name: "Create project" }).click();
  // /me doesn't say the team is read-only yet: the page says so, and to reload to see why
  const ended = "This team is read-only now, so nothing in it can be changed. Reload the page to see why.";
  await expect(page.locator("#toast")).toHaveText(ended);
  await expect(page.locator("#notice")).toHaveText(ended);
  await expect(page.getByRole("heading", { name: /no longer in/ })).toHaveCount(0);
  await expect(bar(page).locator("#endedNote")).toHaveCount(0);
});

// Why a team is read-only for billing (/me's readOnlyReason, supply-checkout-qdx), what
// happens next and what to do: per reason, for owners and for everyone else
const TRIAL_ENDED = { status: "trialing", plan: "trial", subscriptionEnded: true, readOnlyReason: "trial_ended", readOnlyDeletesAt: "2026-11-08T12:00:00.000Z", readOnlyLastDay: "2026-11-07", billingAccount: false };
const OVERDUE = { status: "past_due", plan: "starter", subscriptionEnded: true, readOnlyReason: "payment_overdue", readOnlyDeletesAt: null, readOnlyLastDay: null, billingAccount: true };
const note = (page) => bar(page).locator("#endedNote");

test.describe("in Pacific time", () => {
  // The last day is a calendar date, shown as that date wherever the reader is
  test.use({ timezoneId: "America/Los_Angeles" });

  test("an owner whose trial ended sees when it will be deleted, can still export, and subscribes", { tag: ["@J7.2"] }, async ({ page }) => {
    const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...TRIAL_ENDED }] }));
    await expect(note(page)).toHaveText("This team's free trial has ended, so it's read-only. Nothing has been deleted: everyone can still see it, and you can export it. Unless it's subscribed, everything in it will be deleted after November 7, 2026. Subscribe to make changes again.");
    await expect(note(page)).toHaveAttribute("role", "status");
    await expect(page.locator("#notice")).toHaveText("This team's free trial ended, so nothing in it can be changed until an owner subscribes.");
    await expect(page.getByRole("button", { name: "Export data" })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New project" })).toHaveCount(0);
    await expect(bar(page).getByRole("button", { name: "Billing" })).toHaveCount(0);
    backend.on("POST", CHECKOUT, { status: 201, body: { checkout: { url: STRIPE, expiresAt: "2026-09-28T12:00:00.000Z", trialEndsAt: null } } });
    await bar(page).getByRole("button", { name: "Subscribe" }).click();
    await expect(bar(page).getByRole("link", { name: "Continue to checkout" })).toHaveAttribute("href", STRIPE);
  });
});

test("a contributor whose team's trial ended is told to ask an owner, with no way to subscribe", { tag: ["@J7"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...TRIAL_ENDED, role: "contributor" }] }));
  await expect(note(page)).toHaveText("This team's free trial has ended, so it's read-only. Nothing has been deleted: everyone can still see it. Unless it's subscribed, everything in it will be deleted after November 7, 2026. Ask an owner to subscribe to make changes again.");
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toHaveCount(0);
  await expect(page.locator("#notice")).toHaveText("This team's free trial ended, so nothing in it can be changed until an owner subscribes.");
});

test("an owner whose subscription ended sees when it will be deleted", { tag: ["@J7.2"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, readOnlyReason: "subscription_ended", readOnlyDeletesAt: "2026-10-28T12:00:00.000Z", readOnlyLastDay: "2026-10-27" }] }));
  await expect(note(page)).toHaveText("This team's subscription has ended, so it's read-only. Nothing has been deleted: everyone can still see it, and you can export it. Unless it's subscribed, everything in it will be deleted after October 27, 2026. Subscribe to make changes again.");
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toBeVisible();
});

test("a reason this page doesn't know reads as an ended subscription", { tag: ["@J7"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, readOnlyReason: "something_new" }] }));
  await expect(note(page)).toContainText("This team's subscription has ended, so it's read-only.");
  await expect(page.locator("#notice")).toHaveText("This team's subscription ended, so nothing in it can be changed until an owner subscribes.");
});

test("an owner whose payment is overdue pays in Billing, with no deletion date, on a phone in dark mode", { tag: ["@J8.3"] }, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ colorScheme: "dark" });
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...OVERDUE }] }));
  await expect(note(page)).toHaveText("This team's payment is overdue, so it's read-only until it's paid. Nothing has been deleted: everyone can still see it, and you can export it. Update the payment method in Billing to make changes again.");
  await expect(page.locator("#notice")).toHaveText("This team's payment is overdue, so nothing in it can be changed until an owner pays it in Billing.");
  // Paying, not subscribing again: the team still has its subscription
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export data" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  backend.on("POST", PORTAL, { status: 201, body: { portal: { url: PORTAL_URL } } });
  await bar(page).getByRole("button", { name: "Update payment" }).click();
  await expect(bar(page).getByRole("link", { name: "Continue to billing" })).toHaveAttribute("href", PORTAL_URL);
});

test("an owner whose overdue team has no billing account has no payment button", { tag: ["@J7"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...OVERDUE, billingAccount: false }] }));
  await expect(note(page)).toContainText("Update the payment method in Billing to make changes again.");
  await expect(bar(page).getByRole("button", { name: "Update payment" })).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toHaveCount(0);
});

test("a contributor whose team's payment is overdue is told to ask an owner", { tag: ["@J8"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...OVERDUE, role: "contributor" }] }));
  await expect(note(page)).toHaveText("This team's payment is overdue, so it's read-only until it's paid. Nothing has been deleted: everyone can still see it. Ask an owner to update the payment method to make changes again.");
  await expect(bar(page).getByRole("button", { name: "Update payment" })).toHaveCount(0);
});

test.describe("in Eastern time", () => {
  test.use({ timezoneId: "America/New_York" });
  const GRACE = { status: "past_due", plan: "starter", billingAccount: true, subscriptionEnded: false, readOnlyReason: null, paymentGraceEndsAt: "2026-10-15T16:00:00.000Z" };

  test("an owner in the payment grace period sees when the team becomes read-only, and everything still works", { tag: ["@J8.2"] }, async ({ page }) => {
    await open(page, new FakeBackend({ teams: [{ ...TEAM, ...GRACE }] }));
    await expect(bar(page).locator("#graceNote")).toHaveText(/^A payment for this team didn't go through\. Everything works until October 15, 2026,? (at )?12:00\sPM EDT; then the team becomes read-only until it's paid\. Update the payment method in Billing to keep it working\.$/);
    await expect(bar(page).locator("#graceNote")).toHaveAttribute("role", "status");
    await expect(bar(page).getByRole("button", { name: "Billing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "+ New project" })).toBeVisible();
    await expect(note(page)).toHaveCount(0);
  });

  test("a contributor in the payment grace period is told to ask an owner", { tag: ["@J8.2"] }, async ({ page }) => {
    await open(page, new FakeBackend({ teams: [{ ...TEAM, ...GRACE, role: "contributor" }] }));
    await expect(bar(page).locator("#graceNote")).toContainText("Ask an owner to update the payment method.");
    await expect(page.getByRole("button", { name: "+ New project" })).toBeVisible();
  });

  test("a closed team in the grace period shows only the closure", { tag: ["@J7"] }, async ({ page }) => {
    await open(page, new FakeBackend({ teams: [{ ...TEAM, ...GRACE, closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z" }] }));
    await expect(bar(page).locator("#graceNote")).toHaveCount(0);
    await expect(bar(page).locator(".closed-note")).toHaveCount(1);
  });
});

test("a write refused when the trial ended meanwhile shows why, and the owner can subscribe without reloading", { tag: ["@J7.2"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend());
  backend.on("PUT", /^\/teams\/t1\/projects\//, error(403, "permission_denied", { reason: "subscription_ended" }));
  // /me now says why
  backend.teams[0] = { ...TEAM, ...TRIAL_ENDED };
  await page.getByRole("button", { name: "+ New project" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Delta");
  await page.getByRole("button", { name: "Create project" }).click();
  const why = "This team's free trial ended, so nothing in it can be changed until an owner subscribes.";
  await expect(page.locator("#toast")).toHaveText(why);
  await expect(page.locator("#notice")).toHaveText(why);
  await expect(note(page)).toContainText("This team's free trial has ended");
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Import CSV" })).toHaveCount(0);
});

// The Stripe Customer Portal (supply-checkout-121): owners of a team with a Stripe customer
// open it from Billing in the team bar, to add or change a card, switch plans, see invoices
// and cancel. What they change there reaches /me through the webhook.
const PORTAL = "/teams/t1/billing/portal";
const PORTAL_URL = "https://billing.stripe.test/p/session/bps_test_1";
const PAYING = { status: "active", plan: "starter", billingAccount: true, cancelsAt: null, members: 4 };

test("an owner opens the Customer Portal from Billing, and a stale link gives way to a new one", { tag: ["@J8.3", "@J10.1"] }, async ({ page }) => {
  await page.clock.install();
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }] }));
  await expect(bar(page).locator("#cancelNote")).toHaveCount(0);
  // The first try fails; the second gets a session
  backend.on("POST", PORTAL, { abort: true });
  backend.on("POST", PORTAL, { status: 201, body: { portal: { url: PORTAL_URL } } });
  await bar(page).getByRole("button", { name: "Billing" }).click();
  await expect(page.locator("#toast")).toHaveText("Couldn't open billing. Check your connection and try again.");
  await bar(page).getByRole("button", { name: "Billing" }).click();
  const link = bar(page).getByRole("link", { name: "Continue to billing" });
  await expect(link).toHaveAttribute("href", PORTAL_URL);
  await expect(link).toBeFocused();
  await expect(bar(page).getByRole("button", { name: "Billing" })).toHaveCount(0);
  // Nothing is sent but the path's team
  expect(backend.requests("POST", PORTAL).map((c) => c.body ?? null)).toEqual([null, null]);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  // Stripe's session doesn't last: after a few minutes the button is back, to make a new one
  await page.clock.fastForward(4 * 60e3 + 1e3);
  await expect(link).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Billing" })).toBeEnabled();
});

test("an owner whose team has no billing account yet is told so", { tag: ["@J7"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }] }));
  backend.on("POST", PORTAL, error(409, "aborted", { reason: "no_billing_account" }));
  await bar(page).getByRole("button", { name: "Billing" }).click();
  await expect(page.locator("#toast")).toHaveText("This team has no billing account yet. Reload the page, then subscribe.");
  await expect(bar(page).getByRole("button", { name: "Billing" })).toBeEnabled();
});

test("an owner whose subscription was canceled sees when it ends, and can renew from Billing", { tag: ["@J10.1"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING, cancelsAt: "2026-10-27T12:00:00.000Z" }] }));
  await expect(bar(page).locator("#cancelNote")).toHaveText("This team's subscription was canceled. Everything works until October 27, 2026; then the team becomes read-only. To keep it, renew it from Billing.");
  await expect(bar(page).getByRole("button", { name: "Billing" })).toBeVisible();
  // Still paid up: everything works
  await expect(page.getByRole("button", { name: "+ New project" })).toBeVisible();
});

test("a contributor sees a cancellation too, with no Billing", { tag: ["@J10"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING, role: "contributor", cancelsAt: "2026-10-27T12:00:00.000Z" }] }));
  await expect(bar(page).locator("#cancelNote")).toHaveText("This team's subscription was canceled. Everything works until October 27, 2026; then the team becomes read-only. Ask an owner to renew it to keep it.");
  await expect(bar(page).getByRole("button", { name: "Billing" })).toHaveCount(0);
});

test("an owner of a team with no Stripe customer has no Billing", { tag: ["@J7"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, billingAccount: false, cancelsAt: null }] }));
  await expect(bar(page).getByRole("button", { name: "Members" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Billing" })).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Invoices" })).toHaveCount(0);
});

test("an owner of a team whose subscription ended can subscribe again or open Billing, and no cancellation shows", { tag: ["@J7.2"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, billingAccount: true, cancelsAt: "2026-09-20T12:00:00.000Z" }] }));
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Billing" })).toBeVisible();
  await expect(bar(page).locator("#cancelNote")).toHaveCount(0);
});

test("a closed team has no Billing and no cancellation note, but its owners keep Invoices", { tag: ["@J7"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING, cancelsAt: "2026-10-27T12:00:00.000Z", closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z" }] }));
  await expect(bar(page).locator(".closed-note")).toHaveCount(1);
  await expect(bar(page).getByRole("button", { name: "Billing" })).toHaveCount(0);
  await expect(bar(page).getByRole("button", { name: "Invoices" })).toBeVisible();
  await expect(bar(page).locator("#cancelNote")).toHaveCount(0);
});

test("a closed team with no Stripe customer has no Invoices", { tag: ["@J7"] }, async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING, billingAccount: false, closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z" }] }));
  await expect(bar(page).locator(".closed-note")).toHaveCount(1);
  await expect(bar(page).getByRole("button", { name: "Invoices" })).toHaveCount(0);
});

// Invoices (supply-checkout-eja): the team's latest invoices as Stripe has them, with links to Stripe
const INVOICES = "/teams/t1/billing/invoices";
const dialog = (page) => page.locator("#modal");
const invoice = (n, fields = {}) => ({
  id: `in_test_${n}`,
  number: `ABCD-000${n}`,
  status: "paid",
  createdAt: `2026-0${n}-01T12:00:00.000Z`,
  currency: "usd",
  total: 1200 + n,
  amountDue: 1200 + n,
  amountPaid: 1200 + n,
  hostedUrl: `https://invoice.stripe.com/i/test_${n}`,
  pdfUrl: `https://pay.stripe.com/invoice/test_${n}/pdf`,
  ...fields,
});

test("an owner sees the team's invoices, with Stripe's page and PDF for each", { tag: ["@J7.3"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }] }));
  // The first try fails and offers another
  backend.on("GET", INVOICES, { abort: true });
  backend.on("GET", INVOICES, {
    status: 200,
    body: {
      invoices: [
        invoice(3, { status: "open", amountPaid: 0 }),
        invoice(2, { number: null, pdfUrl: null }),
        invoice(1, { status: "void", hostedUrl: null }),
        invoice(4, { status: "something_new" }),
      ],
      hasMore: true,
    },
  });
  await bar(page).getByRole("button", { name: "Invoices" }).click();
  await expect(dialog(page).locator("#invoicesFail")).toHaveText("Couldn't load invoices. Check your connection and try again.");
  await dialog(page).getByRole("button", { name: "Try again" }).click();
  await expect(dialog(page).locator("#invoicesFail")).toBeHidden();
  const rows = dialog(page).locator(".invoice");
  await expect(rows).toHaveText([
    /Mar 1, 2026\s+Invoice ABCD-0003\s+\$12\.03\s+Due: \$12\.03\s+View\s+PDF/,
    /Feb 1, 2026\s+Invoice\s+\$12\.02\s+Paid\s+View/,
    /Jan 1, 2026\s+Invoice ABCD-0001\s+\$12\.01\s+Void\s+PDF/,
    /Apr 1, 2026\s+Invoice ABCD-0004\s+\$12\.04\s+something_new/,
  ]);
  const view = rows.first().getByRole("link", { name: "View Invoice ABCD-0003" });
  await expect(view).toHaveAttribute("href", "https://invoice.stripe.com/i/test_3");
  await expect(view).toHaveAttribute("target", "_blank");
  await expect(rows.first().getByRole("link", { name: "Invoice ABCD-0003 as a PDF" })).toHaveAttribute("href", "https://pay.stripe.com/invoice/test_3/pdf");
  await expect(rows.nth(1).getByRole("link")).toHaveCount(1);
  await expect(dialog(page).locator("#olderInvoices")).toHaveText("Older invoices are in Billing.");
  // Nothing is sent but the path's team
  expect(backend.requests("GET", INVOICES)).toHaveLength(2);
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  await dialog(page).getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
});

test("an owner whose team has no invoices yet is told so", { tag: ["@J7.3"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }] }));
  backend.on("GET", INVOICES, { status: 200, body: { invoices: [], hasMore: false } });
  await bar(page).getByRole("button", { name: "Invoices" }).click();
  await expect(dialog(page).locator("#invoiceList")).toHaveText("No invoices yet.");
  await expect(dialog(page).locator("#olderInvoices")).toHaveCount(0);
});

test("an owner whose team has no billing account yet is told there are no invoices", { tag: ["@J7.3"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }] }));
  backend.on("GET", INVOICES, error(409, "aborted", { reason: "no_billing_account" }));
  await bar(page).getByRole("button", { name: "Invoices" }).click();
  await expect(dialog(page).locator("#invoicesFail")).toHaveText("This team has no billing account yet, so it has no invoices.");
  await expect(dialog(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
});

// A closed team's owners can save its invoices until it's deleted (supply-checkout-8jc.24)
const CLOSED = { closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z" };

test("an owner of a closed team sees its invoices, and is told to save them before it's deleted", { tag: ["@J7.3"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING, ...CLOSED }] }));
  backend.on("GET", INVOICES, { status: 200, body: { invoices: [invoice(2), invoice(1)], hasMore: true } });
  await bar(page).getByRole("button", { name: "Invoices" }).click();
  await expect(dialog(page).locator(".hint").first()).toHaveText("Stripe emailed each invoice and receipt to your billing email. This team was closed: save any invoices you need before it's deleted on Oct 26, 2026, when they're deleted with it.");
  await expect(dialog(page).locator(".invoice")).toHaveCount(2);
  await expect(dialog(page).getByRole("link", { name: "Invoice ABCD-0002 as a PDF" })).toHaveAttribute("href", "https://pay.stripe.com/invoice/test_2/pdf");
  await expect(dialog(page).locator("#olderInvoices")).toHaveText("Older invoices are in the emails from Stripe.");
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
});

test("an owner of a closed team whose deletion is due is told its invoices are going with it", { tag: ["@J7.3"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING, ...CLOSED }] }));
  backend.on("GET", INVOICES, error(409, "aborted", { reason: "team_deleting" }));
  await bar(page).getByRole("button", { name: "Invoices" }).click();
  await expect(dialog(page).locator("#invoicesFail")).toHaveText("This team is being deleted, and its invoices with it.");
  await expect(dialog(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("invoices refused for want of two-step sign-in open the setup, saying why", { tag: ["@J7.3"] }, async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }] }));
  backend.on("GET", INVOICES, error(403, "permission_denied", { reason: "mfa_required" }));
  await bar(page).getByRole("button", { name: "Invoices" }).click();
  await expect(dialog(page).locator(".two-step-why")).toHaveText("To manage billing, turn on two-step sign-in first. It keeps someone who gets hold of your email from changing how your team pays.");
  await expect(dialog(page).locator("#invoiceList")).toHaveCount(0);
});
