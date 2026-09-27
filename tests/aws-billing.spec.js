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
