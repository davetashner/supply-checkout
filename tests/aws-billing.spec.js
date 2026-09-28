// The web build's runtime (src/aws/) when a team's subscription has ended: read-only with a
// clear notice, and for its owners a way to subscribe again on Stripe Checkout
// (src/aws/account.js, db.js), against the fake backend in tests/fake-aws.js. The server's
// side is in backend/test/billing-worker.test.ts and billing-api.test.ts.
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./helpers.js";
import { currentBuild } from "../scripts/builds.mjs";
import { FakeBackend, TEAM, openAws, connected } from "./fake-aws.js";

test.skip(currentBuild() !== "web", "The AWS runtime is only in the web build");
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

test("an owner sees why the team is read-only, and subscribes again through Stripe Checkout", async ({ page }) => {
  // A checklist this device started doesn't come back for a team that can't change
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED }] }), { storage: { local: { "supplyCheckout.firstRun.t1": "{}" } } });
  await expect(bar(page).locator(".closed-note")).toHaveText("This team's subscription has ended, so it's read-only. Nothing has been deleted: everyone can still see it, and you can export it. Subscribe to make changes again.");
  await expect(page.locator("#notice")).toHaveText("This team's subscription ended, so nothing in it can be changed until an owner subscribes.");
  await expect(bar(page).getByRole("button", { name: "Import CSV" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ New sheet" })).toHaveCount(0);
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
  expect(calls.map((c) => c.body)).toEqual([
    { plan: "starter", interval: "month", seats: 4 },
    { plan: "starter", interval: "month", seats: 4 },
  ]);
  expect(calls[0].headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls[1].headers["idempotency-key"]).toBe(calls[0].headers["idempotency-key"]);
});

test("an owner whose team already subscribed meanwhile is told to reload", async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, members: null }] }));
  backend.on("POST", CHECKOUT, error(409, "aborted", { reason: "already_subscribed" }));
  await bar(page).getByRole("button", { name: "Subscribe" }).click();
  await expect(page.locator("#toast")).toHaveText("This team already has a subscription. Reload the page to see it.");
  // At least one seat, for a team from before the member count
  expect(backend.requests("POST", CHECKOUT)[0].body.seats).toBe(1);
});

test("a contributor is told to ask an owner, with no way to subscribe", async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, role: "contributor" }] }));
  await expect(bar(page).locator(".closed-note")).toHaveText("This team's subscription has ended, so it's read-only. Nothing has been deleted: everyone can still see it. Ask an owner to subscribe to make changes again.");
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toHaveCount(0);
  await expect(page.locator("#notice")).toHaveText("This team's subscription ended, so nothing in it can be changed until an owner subscribes.");
});

test("a closed team whose subscription also ended shows only the closure", async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z" }] }));
  await expect(bar(page).locator(".closed-note")).toHaveCount(1);
  await expect(bar(page).locator(".closed-note")).toContainText("This team was closed");
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toHaveCount(0);
  await expect(page.locator("#notice")).toHaveText("This team is closed, so nothing in it can be changed.");
});

test("a write refused because the subscription ended meanwhile switches the app to view-only", async ({ page }) => {
  const backend = await open(page, new FakeBackend());
  backend.on("PUT", /^\/teams\/t1\/sheets\//, error(403, "permission_denied", { reason: "subscription_ended" }));
  await page.getByRole("button", { name: "+ New sheet" }).click();
  await page.getByLabel("Client", { exact: true }).fill("Delta");
  await page.getByRole("button", { name: "Create sheet" }).click();
  const ended = "This team's subscription ended, so nothing in it can be changed now. An owner can subscribe again from the team bar.";
  await expect(page.locator("#toast")).toHaveText(ended);
  await expect(page.locator("#notice")).toHaveText(ended);
  await expect(page.getByRole("heading", { name: /no longer in/ })).toHaveCount(0);
});

// The Stripe Customer Portal (supply-checkout-121): owners of a team with a Stripe customer
// open it from Billing in the team bar, to add or change a card, switch plans, see invoices
// and cancel. What they change there reaches /me through the webhook.
const PORTAL = "/teams/t1/billing/portal";
const PORTAL_URL = "https://billing.stripe.test/p/session/bps_test_1";
const PAYING = { status: "active", plan: "starter", billingAccount: true, cancelsAt: null, members: 4 };

test("an owner opens the Customer Portal from Billing, and a stale link gives way to a new one", async ({ page }) => {
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

test("an owner whose team has no billing account yet is told so", async ({ page }) => {
  const backend = await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING }] }));
  backend.on("POST", PORTAL, error(409, "aborted", { reason: "no_billing_account" }));
  await bar(page).getByRole("button", { name: "Billing" }).click();
  await expect(page.locator("#toast")).toHaveText("This team has no billing account yet. Reload the page, then subscribe.");
  await expect(bar(page).getByRole("button", { name: "Billing" })).toBeEnabled();
});

test("an owner whose subscription was canceled sees when it ends, and can renew from Billing", async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING, cancelsAt: "2026-10-27T12:00:00.000Z" }] }));
  await expect(bar(page).locator("#cancelNote")).toHaveText("This team's subscription was canceled. Everything works until October 27, 2026; then the team becomes read-only. To keep it, renew it from Billing.");
  await expect(bar(page).getByRole("button", { name: "Billing" })).toBeVisible();
  // Still paid up: everything works
  await expect(page.getByRole("button", { name: "+ New sheet" })).toBeVisible();
});

test("a contributor sees a cancellation too, with no Billing", async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING, role: "contributor", cancelsAt: "2026-10-27T12:00:00.000Z" }] }));
  await expect(bar(page).locator("#cancelNote")).toHaveText("This team's subscription was canceled. Everything works until October 27, 2026; then the team becomes read-only. Ask an owner to renew it to keep it.");
  await expect(bar(page).getByRole("button", { name: "Billing" })).toHaveCount(0);
});

test("an owner of a team with no Stripe customer has no Billing", async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, billingAccount: false, cancelsAt: null }] }));
  await expect(bar(page).getByRole("button", { name: "Members" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Billing" })).toHaveCount(0);
});

test("an owner of a team whose subscription ended can subscribe again or open Billing, and no cancellation shows", async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...ENDED, billingAccount: true, cancelsAt: "2026-09-20T12:00:00.000Z" }] }));
  await expect(bar(page).getByRole("button", { name: "Subscribe" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Billing" })).toBeVisible();
  await expect(bar(page).locator("#cancelNote")).toHaveCount(0);
});

test("a closed team has no Billing and no cancellation note", async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, ...PAYING, cancelsAt: "2026-10-27T12:00:00.000Z", closedAt: "2026-09-26T12:00:00.000Z", deletesAt: "2026-10-26T12:00:00.000Z" }] }));
  await expect(bar(page).locator(".closed-note")).toHaveCount(1);
  await expect(bar(page).getByRole("button", { name: "Billing" })).toHaveCount(0);
  await expect(bar(page).locator("#cancelNote")).toHaveCount(0);
});
