// The billing journeys' guards and their one tool for Stripe's sandbox (supply-checkout-o60.9;
// docs/journey-tests-plan.md, "Billing in prod").
//
// Guards, all fail-closed:
// - billingMode(me): the mode GET /me reports. Only `test` runs the billing steps; `live` runs the
//   read-only checks; anything else (the field missing, as before the api that reports it is
//   deployed) runs none.
// - isSandboxCheckoutUrl / isSandboxPortalUrl: a page the browser may be sent to is Stripe's
//   hosted page of a sandbox session (cs_test_ / test_), exactly, so a live page is never opened,
//   whatever the app answered.
//
// The restricted sandbox key (JOURNEYS_STRIPE_SANDBOX_KEY, optional): `rk_test_…` only, never a
// secret key, never a live one. It lets the harness do what a card on a hosted page can't:
// give the subscription a card, make the payment after the trial, make the next payment fail
// (J8.1) and end the subscription during cleanup. The permissions it needs are Customers read
// (search), Subscriptions write and Payment methods write, and nothing else. Every call is to
// api.stripe.com with that key, an answer that isn't `livemode: false` is refused, and errors
// carry Stripe's error type only, never its message, an ID or anything sent.
import { SANDBOX_KEY } from "./config.mjs";
import { GuardError } from "./guards.mjs";

const API = "https://api.stripe.com";
const STRIPE_ID = /^(cus|sub|pm|in)_[A-Za-z0-9]{6,}$/;
const TEAM_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** "test", "live" or "unknown" from a `GET /me` body. */
export function billingMode(me) {
  const mode = me?.stripeMode;
  return mode === "test" || mode === "live" ? mode : "unknown";
}

/** Stripe's hosted Checkout page of a sandbox session, and nothing else. */
export function isSandboxCheckoutUrl(link) {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.username && !url.password && /^\/c\/pay\/cs_test_[A-Za-z0-9_]+$/.test(url.pathname);
  } catch { return false; }
}

/** Stripe's hosted Customer Portal page of a sandbox session, and nothing else. */
export function isSandboxPortalUrl(link) {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname === "billing.stripe.com" && !url.username && !url.password && /^\/p\/session\/test_[A-Za-z0-9_]+$/.test(url.pathname);
  } catch { return false; }
}

/** The key if it is a restricted sandbox key, else a GuardError that never shows the key. */
export function checkSandboxKey(key) {
  if (typeof key !== "string" || !SANDBOX_KEY.test(key)) throw new GuardError("JOURNEYS_STRIPE_SANDBOX_KEY isn't a restricted sandbox key (rk_test_…): refusing to use it");
  return key;
}

export class StripeError extends Error {
  constructor(operation, type) {
    super(`Stripe ${operation} failed: ${type}`);
    this.type = type;
  }
}

/** The sandbox client. `fetch` is injectable for the unit tests. */
export function createSandboxStripe({ key, fetch = globalThis.fetch, timeoutMs = 20_000 }) {
  checkSandboxKey(key);

  async function call(operation, method, path, params) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: method === "POST" ? new URLSearchParams(params ?? {}).toString() : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = {};
    try { json = await res.json(); } catch {}
    if (!res.ok) throw new StripeError(operation, String(json?.error?.type ?? `HTTP ${res.status}`));
    // Never act on anything that is not the sandbox, whatever the key
    if (json.livemode === true) throw new GuardError("Stripe answered with a live-mode object: stopping");
    return json;
  }
  const id = (value) => {
    if (typeof value !== "string" || !STRIPE_ID.test(value)) throw new Error("Not a Stripe ID");
    return value;
  };

  return {
    /** The customer the app made for a team (its metadata names the team), or null. Search lags by up to a minute. */
    async customerOfTeam(teamId) {
      if (!TEAM_ID.test(teamId ?? "")) throw new Error("Not a team ID");
      const found = await call("customer search", "GET", `/v1/customers/search?${new URLSearchParams({ query: `metadata['teamId']:'${teamId}'`, limit: "2" })}`);
      if ((found.data ?? []).length > 1) throw new GuardError("More than one Stripe customer for the team: stopping");
      return found.data?.[0]?.id ? id(found.data[0].id) : null;
    },
    /** The customer's one subscription (any status but ended), or null. */
    async subscriptionOf(customerId) {
      const found = await call("subscription list", "GET", `/v1/subscriptions?${new URLSearchParams({ customer: id(customerId), status: "all", limit: "3" })}`);
      const live = (found.data ?? []).filter((s) => s.status !== "canceled" && s.status !== "incomplete_expired");
      if (live.length > 1) throw new GuardError("More than one Stripe subscription for the team: stopping");
      const sub = live[0];
      return sub ? { id: id(sub.id), status: sub.status, quantity: sub.items?.data?.[0]?.quantity ?? null } : null;
    },
    /** Stripe's test card 4242…: the subscription's card, from now on. */
    async useGoodCard(customerId, subscriptionId) {
      await call("attach card", "POST", `/v1/payment_methods/pm_card_visa/attach`, { customer: id(customerId) }).then((pm) => call("set card", "POST", `/v1/subscriptions/${id(subscriptionId)}`, { default_payment_method: id(pm.id) }));
    },
    /** Stripe's test card 4000 0000 0000 0341: attaches, then every charge declines. */
    async useFailingCard(customerId, subscriptionId) {
      await call("attach card", "POST", `/v1/payment_methods/pm_card_chargeCustomerFail/attach`, { customer: id(customerId) }).then((pm) => call("set card", "POST", `/v1/subscriptions/${id(subscriptionId)}`, { default_payment_method: id(pm.id) }));
    },
    /** Ends the free trial now: the first payment is taken. */
    async endTrial(subscriptionId) {
      await call("end trial", "POST", `/v1/subscriptions/${id(subscriptionId)}`, { trial_end: "now" });
    },
    /**
     * An invoice for the subscription now, which the card on it must pay: a new billing cycle
     * starts at once and is charged in full (no proration, so there's no credit to net it to $0,
     * and no seat count is touched, which the nightly reconciliation would flag as drift).
     */
    async invoiceNow(subscriptionId) {
      await call("invoice now", "POST", `/v1/subscriptions/${id(subscriptionId)}`, { billing_cycle_anchor: "now", proration_behavior: "none" });
    },
    /** Ends the subscription at once (cleanup). */
    async cancel(subscriptionId) {
      await call("cancel", "DELETE", `/v1/subscriptions/${id(subscriptionId)}`);
    },
  };
}
