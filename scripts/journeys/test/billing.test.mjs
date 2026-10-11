// node --test scripts/journeys/test/ (part of npm run test:scripts): the billing journeys' guards
// and their sandbox Stripe client (lib/stripe-sandbox.mjs), the sealed sign-in secrets
// (lib/seal.mjs) and the optional sandbox key in the configuration. Nothing here talks to Stripe.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigError, readConfig, secretValues } from "../lib/config.mjs";
import { GuardError } from "../lib/guards.mjs";
import { checkRecord } from "../lib/runs.mjs";
import { SEALED, seal, unseal } from "../lib/seal.mjs";
import { StripeError, billingMode, checkSandboxKey, createSandboxStripe, isSandboxCheckoutUrl, isSandboxPortalUrl } from "../lib/stripe-sandbox.mjs";
import { throwawayAddress } from "../lib/addresses.mjs";
import { fakeEnv } from "./helpers.mjs";

const KEY = `rk_test_${"A1b2C3d4E5".repeat(3)}`;
const SECRET = "Owner-password-1234567890-abcdef!";

test("billingMode: only test and live are modes; anything else, or no field, is unknown (so nothing runs)", () => {
  assert.equal(billingMode({ stripeMode: "test" }), "test");
  assert.equal(billingMode({ stripeMode: "live" }), "live");
  for (const bad of [undefined, null, "", "TEST", "sandbox", 1, {}, ["test"]]) assert.equal(billingMode({ stripeMode: bad }), "unknown", String(bad));
  assert.equal(billingMode(null), "unknown");
  assert.equal(billingMode({}), "unknown");
});

test("only Stripe's hosted pages of a sandbox session are allowed: a live or lookalike page never is", () => {
  assert.equal(isSandboxCheckoutUrl("https://checkout.stripe.com/c/pay/cs_test_a1B2c3#fidkdWxOYHwn"), true);
  for (const bad of [
    "https://checkout.stripe.com/c/pay/cs_live_a1B2c3",
    "https://checkout.stripe.com/c/pay/cs_test_a1B2c3/extra",
    "http://checkout.stripe.com/c/pay/cs_test_a1B2c3",
    "https://checkout.stripe.com.evil.example/c/pay/cs_test_a1B2c3",
    "https://evil.example/c/pay/cs_test_a1B2c3",
    `https://${"user"}:${"pw"}@checkout.stripe.com/c/pay/cs_test_a1B2c3`,
    "https://billing.stripe.com/c/pay/cs_test_a1B2c3",
    "javascript:alert(1)",
    "not a url",
    undefined,
    null,
  ]) assert.equal(isSandboxCheckoutUrl(bad), false, String(bad));
  assert.equal(isSandboxPortalUrl("https://billing.stripe.com/p/session/test_YWNjdF8x"), true);
  for (const bad of ["https://billing.stripe.com/p/session/live_YWNjdF8x", "https://billing.stripe.com/p/login/test_x", "https://billing.stripe.com.evil.example/p/session/test_x", "https://checkout.stripe.com/p/session/test_x", "ftp://billing.stripe.com/p/session/test_x", "", undefined]) {
    assert.equal(isSandboxPortalUrl(bad), false, String(bad));
  }
});

test("the sandbox key must be a restricted test key: never a secret key, a live key or a lookalike, and the error never shows it", () => {
  assert.equal(checkSandboxKey(KEY), KEY);
  for (const bad of [`sk_test_${"A1b2C3d4E5".repeat(3)}`, `rk_live_${"A1b2C3d4E5".repeat(3)}`, `sk_live_${"A1b2C3d4E5".repeat(3)}`, "rk_test_short", ` ${KEY}`, `${KEY}\n`, "", undefined, 5]) {
    assert.throws(() => checkSandboxKey(bad), (err) => err instanceof GuardError && !String(err.message).includes("A1b2C3d4E5"), String(bad));
    assert.throws(() => createSandboxStripe({ key: bad }), GuardError);
  }
});

test("the configuration takes the sandbox key only if it's a restricted test key, and masks it", () => {
  assert.equal(readConfig(fakeEnv()).stripeSandboxKey, undefined);
  assert.equal(readConfig(fakeEnv({ JOURNEYS_STRIPE_SANDBOX_KEY: "" })).stripeSandboxKey, undefined);
  const config = readConfig(fakeEnv({ JOURNEYS_STRIPE_SANDBOX_KEY: KEY }));
  assert.equal(config.stripeSandboxKey, KEY);
  assert.ok(secretValues(config).includes(KEY));
  assert.ok(!secretValues(readConfig(fakeEnv())).includes(undefined));
  assert.throws(() => readConfig(fakeEnv({ JOURNEYS_STRIPE_SANDBOX_KEY: `sk_live_${"A1b2C3d4E5".repeat(3)}` })), (err) => err instanceof ConfigError && /JOURNEYS_STRIPE_SANDBOX_KEY must be a restricted sandbox key/.test(err.message) && !err.message.includes("sk_live"));
});

/** A fake fetch that answers from a script and records each request. */
function fakeStripe(answers) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null, auth: init.headers.Authorization, host: u.host });
    const answer = answers.shift();
    return { ok: answer.status === undefined || answer.status < 400, status: answer.status ?? 200, async json() { return answer.body; } };
  };
  return { fetch, calls };
}

test("customerOfTeam searches by the team's metadata and refuses a team ID that isn't one", async () => {
  const { fetch, calls } = fakeStripe([{ body: { data: [{ id: "cus_AbC123xyz" }], livemode: false } }, { body: { data: [] } }]);
  const stripe = createSandboxStripe({ key: KEY, fetch });
  assert.equal(await stripe.customerOfTeam("team_1-A"), "cus_AbC123xyz");
  assert.deepEqual(calls[0], { method: "GET", path: "/v1/customers/search", query: { query: "metadata['teamId']:'team_1-A'", limit: "2" }, body: null, auth: `Bearer ${KEY}`, host: "api.stripe.com" });
  assert.equal(await stripe.customerOfTeam("team_2"), null);
  for (const bad of ["a'b", "x y", "", undefined, "a".repeat(129)]) await assert.rejects(stripe.customerOfTeam(bad), /Not a team ID/);
  assert.equal(calls.length, 2, "a bad team ID makes no request");
});

test("more than one customer or subscription for a team stops the run", async () => {
  const two = fakeStripe([{ body: { data: [{ id: "cus_AbC123xyz" }, { id: "cus_DeF456uvw" }] } }]);
  await assert.rejects(createSandboxStripe({ key: KEY, fetch: two.fetch }).customerOfTeam("t1"), GuardError);
  const subs = fakeStripe([{ body: { data: [{ id: "sub_AbC123xyz", status: "active" }, { id: "sub_DeF456uvw", status: "trialing" }] } }]);
  await assert.rejects(createSandboxStripe({ key: KEY, fetch: subs.fetch }).subscriptionOf("cus_AbC123xyz"), GuardError);
});

test("subscriptionOf ignores ended subscriptions and reads the seat quantity", async () => {
  const { fetch, calls } = fakeStripe([
    { body: { data: [{ id: "sub_old123456", status: "canceled" }, { id: "sub_AbC123xyz", status: "trialing", items: { data: [{ quantity: 2 }] } }] } },
    { body: { data: [{ id: "sub_old123456", status: "canceled" }] } },
  ]);
  const stripe = createSandboxStripe({ key: KEY, fetch });
  assert.deepEqual(await stripe.subscriptionOf("cus_AbC123xyz"), { id: "sub_AbC123xyz", status: "trialing", quantity: 2 });
  assert.deepEqual(calls[0].query, { customer: "cus_AbC123xyz", status: "all", limit: "3" });
  assert.equal(await stripe.subscriptionOf("cus_AbC123xyz"), null);
  await assert.rejects(stripe.subscriptionOf("../customers"), /Not a Stripe ID/);
});

test("the cards, the trial's end, the invoice and the cancellation are the calls the restricted key allows, to the sandbox only", async () => {
  const pm = { body: { id: "pm_1AbCdEf", livemode: false } };
  const ok = { body: { livemode: false } };
  const { fetch, calls } = fakeStripe([pm, ok, pm, ok, ok, ok, ok]);
  const stripe = createSandboxStripe({ key: KEY, fetch });
  await stripe.useGoodCard("cus_AbC123xyz", "sub_AbC123xyz");
  await stripe.useFailingCard("cus_AbC123xyz", "sub_AbC123xyz");
  await stripe.endTrial("sub_AbC123xyz");
  await stripe.invoiceNow("sub_AbC123xyz");
  await stripe.cancel("sub_AbC123xyz");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
    "POST /v1/payment_methods/pm_card_visa/attach",
    "POST /v1/subscriptions/sub_AbC123xyz",
    "POST /v1/payment_methods/pm_card_chargeCustomerFail/attach",
    "POST /v1/subscriptions/sub_AbC123xyz",
    "POST /v1/subscriptions/sub_AbC123xyz",
    "POST /v1/subscriptions/sub_AbC123xyz",
    "DELETE /v1/subscriptions/sub_AbC123xyz",
  ]);
  assert.deepEqual(calls[0].body, { customer: "cus_AbC123xyz" });
  assert.deepEqual(calls[1].body, { default_payment_method: "pm_1AbCdEf" });
  assert.deepEqual(calls[4].body, { trial_end: "now" });
  assert.deepEqual(calls[5].body, { billing_cycle_anchor: "now", proration_behavior: "none" });
  assert.ok(calls.every((c) => c.host === "api.stripe.com" && c.auth === `Bearer ${KEY}`));
  await assert.rejects(stripe.cancel("sub_1; DELETE"), /Not a Stripe ID/);
});

test("an answer from live mode stops everything, and a Stripe error carries its type only", async () => {
  const live = fakeStripe([{ body: { data: [{ id: "cus_AbC123xyz" }], livemode: true } }]);
  await assert.rejects(createSandboxStripe({ key: KEY, fetch: live.fetch }).customerOfTeam("t1"), (err) => err instanceof GuardError && /live-mode/.test(err.message));
  const bad = fakeStripe([{ status: 403, body: { error: { type: "invalid_request_error", message: `Secret detail for ${KEY} cus_AbC123xyz` } } }, { status: 500, body: null }]);
  const stripe = createSandboxStripe({ key: KEY, fetch: bad.fetch });
  await assert.rejects(stripe.endTrial("sub_AbC123xyz"), (err) => err instanceof StripeError && err.message === "Stripe end trial failed: invalid_request_error");
  await assert.rejects(stripe.endTrial("sub_AbC123xyz"), (err) => err instanceof StripeError && err.message === "Stripe end trial failed: HTTP 500");
});

test("a sealed secret opens only with the secret it was sealed under, and says nothing about its contents when it doesn't", () => {
  const sealed = seal({ password: "Throwaway-pass-1!", totp: "JBSWY3DPEHPK3PXP" }, SECRET);
  assert.match(sealed, SEALED);
  assert.ok(!sealed.includes("Throwaway") && !sealed.includes("JBSWY3"));
  assert.deepEqual(unseal(sealed, SECRET), { password: "Throwaway-pass-1!", totp: "JBSWY3DPEHPK3PXP" });
  assert.deepEqual(unseal(seal({ password: "Throwaway-pass-1!" }, SECRET), SECRET), { password: "Throwaway-pass-1!" });
  // A new random value each time
  assert.notEqual(seal({ password: "p" }, SECRET), seal({ password: "p" }, SECRET));
  assert.throws(() => unseal(sealed, `${SECRET}x`), (err) => /couldn't be opened/.test(err.message) && !err.message.includes("Throwaway"));
  const [v, iv, body] = sealed.split(".");
  const flipped = `${v}.${iv}.${body.slice(0, -2)}${body.endsWith("AA") ? "BB" : "AA"}`;
  assert.throws(() => unseal(flipped, SECRET), /couldn't be opened/);
  for (const bad of ["", "v1.x.y", undefined, 7, `v2.${iv}.${body}`]) assert.throws(() => unseal(bad, SECRET), /Not a sealed value/);
  assert.throws(() => seal({ password: "" }, SECRET), /no password/);
  assert.throws(() => seal({ password: "p", totp: 5 }, SECRET), /string/);
  assert.throws(() => seal({ password: "p" }, "short"), /sealing secret/);
  assert.throws(() => unseal(sealed, undefined), /sealing secret|couldn't be opened/);
});

test("a run record may hold a sealed value, and nothing else secret", () => {
  const address = throwawayAddress("9-1", "bowner");
  const base = { runId: "9-1", role: "bowner", address, state: "started" };
  const sealed = seal({ password: "Throwaway-pass-1!", totp: "JBSWY3DPEHPK3PXP" }, SECRET);
  assert.equal(checkRecord({ ...base, sealed }).sealed, sealed);
  assert.equal(checkRecord({ ...base, sealed: undefined }).sealed, undefined);
  for (const bad of ["Throwaway-pass-1!", "v1.short.short", 5, ""]) assert.throws(() => checkRecord({ ...base, sealed: bad }), /sealed/, String(bad));
  assert.throws(() => checkRecord({ ...base, password: "x" }), /may not hold password/);
  assert.throws(() => checkRecord({ ...base, totp: "x" }), /may not hold totp/);
});

test("the billing throwaway's password meets the pool's policy and is new each time", async () => {
  const { newPassword, parseTotpKey, isSubscribed, invoicesAnswerOk } = await import("../lib/billing.mjs");
  const a = newPassword();
  assert.match(a, /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/);
  assert.notEqual(a, newPassword());
  assert.equal(newPassword(() => Buffer.alloc(12, 0xab)), `Tw1!${"ab".repeat(12)}`);
  // The key as the app shows it
  assert.equal(parseTotpKey("jbsw y3dp ehpk 3pxp"), "JBSWY3DPEHPK3PXP");
  for (const bad of ["", undefined, "short", "JBSWY3DPEHPK3PX1", "otpauth://totp/x?secret=ABC"]) assert.throws(() => parseTotpKey(bad), (err) => /base32/.test(err.message) && !String(bad || "x").split(" ").some((w) => w.length > 3 && err.message.includes(w)), String(bad));
  assert.equal(isSubscribed({ plan: "starter", status: "trialing" }), true);
  assert.equal(isSubscribed({ plan: "starter", status: "active" }), true);
  for (const bad of [{ plan: "trial", status: "trialing" }, { plan: "starter", status: "past_due" }, { plan: "starter", status: "canceled" }, null, undefined]) assert.equal(isSubscribed(bad), false);
  assert.equal(invoicesAnswerOk({ status: 200, body: { invoices: [] } }), true);
  assert.equal(invoicesAnswerOk({ status: 200, body: {} }), false);
  assert.equal(invoicesAnswerOk({ status: 409, body: { error: { reason: "no_billing_account" } } }), true);
  assert.equal(invoicesAnswerOk({ status: 500, body: { error: { reason: "no_billing_account" } } }), false);
  assert.equal(invoicesAnswerOk({ status: 403, body: { error: { reason: "mfa_required" } } }), false);
});
