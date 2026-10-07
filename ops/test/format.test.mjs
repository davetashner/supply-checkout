// Unit tests for what the operator page shows and sends (ops/lib/format.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISCOUNT_OUTCOMES,
  InputError,
  auditChange,
  auditRow,
  checkMonth,
  checkReason,
  compBody,
  compLine,
  date,
  endCompBody,
  idempotencyKeys,
  money,
  monthsLeft,
  receiptLines,
  stripeFacts,
  teamFacts,
  teamRow,
  text,
  usd,
} from "../lib/format.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const team = { id: "t1", name: "Acme", plan: "pro", status: "active", seats: 5, ownerCount: 1, createdAt: "2026-01-01T00:00:00Z", stripeCustomerId: "cus_1", version: 7, comp: null };

test("small formatters", () => {
  assert.equal(date("2026-10-02T12:00:00Z"), "2026-10-02");
  assert.equal(date(undefined), "-");
  assert.equal(date("x"), "-");
  assert.equal(text(null), "-");
  assert.equal(text(""), "-");
  assert.equal(text(0), "0");
  assert.equal(money(2700, "usd"), "27.00 USD");
  assert.equal(money(0, undefined), "0.00 ");
  assert.equal(money(undefined, "usd"), "-");
  assert.equal(usd(0.004), "<$0.01");
  assert.equal(usd(1.234), "$1.23");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(undefined), "-");
});

test("monthsLeft rounds down to whole months", () => {
  assert.equal(monthsLeft("2026-12-02T12:00:00Z", NOW), "2 months left");
  assert.equal(monthsLeft("2026-12-02T11:00:00Z", NOW), "1 month left");
  assert.equal(monthsLeft("2026-10-20T00:00:00Z", NOW), "less than a month left");
  assert.equal(monthsLeft("nope", NOW), "");
});

test("compLine: live with months left, ended, none", () => {
  assert.equal(compLine(null, NOW), "No comp");
  assert.equal(compLine({ plan: "free", seats: 3, until: "2027-01-02T12:00:00Z", live: true }, NOW), "free (3 seats) until 2027-01-02, 3 months left");
  assert.equal(compLine({ plan: "free", until: "2026-09-01T00:00:00Z", live: false }, NOW), "free until 2026-09-01 (ended)");
});

test("teamRow and teamFacts", () => {
  assert.deepEqual(teamRow({ ...team, owners: [{ email: "o@example.test", userId: "u1" }, { userId: "u2" }, null] }, NOW), {
    id: "t1",
    name: "Acme",
    test: false,
    plan: "pro / active",
    comp: "",
    owners: "o@example.test, u2, -",
    created: "2026-01-01",
  });
  const closed = teamRow({ ...team, closedAt: "2026-09-30T00:00:00Z", comp: { plan: "free", until: "2026-11-01T00:00:00Z", live: true } }, NOW);
  assert.equal(closed.plan, "pro / active (closed 2026-09-30)");
  assert.equal(closed.comp, "free until 2026-11-01, less than a month left");
  assert.equal(teamRow({ id: "t2" }, NOW).owners, "");
  // The Test badge only for a team marked exactly true (not for null: the mark unread)
  assert.equal(teamRow({ ...team, test: true }, NOW).test, true);
  assert.equal(teamRow({ ...team, test: null }, NOW).test, false);
  assert.match(Object.fromEntries(teamFacts({ ...team, test: true }, NOW))["Test team"], /^Yes: made by the prod journey tests/);
  assert.equal(Object.fromEntries(teamFacts({ ...team, test: null }, NOW))["Test team"], undefined);

  const facts = Object.fromEntries(teamFacts(team, NOW));
  assert.equal(facts.Comp, "No comp");
  assert.equal(facts.Version, "7");
  assert.equal(facts["Trial ends"], undefined);
  assert.equal(facts["Comp reason"], undefined);
  const more = Object.fromEntries(teamFacts({ ...team, stripeCustomerId: null, trialEndsAt: "2026-10-10", closedAt: "2026-10-01", comp: { plan: "free", until: "2026-12-02T12:00:00Z", live: true, reason: "Pilot" } }, NOW));
  assert.equal(more["Trial ends"], "2026-10-10");
  assert.equal(more["Stripe customer"], "none");
  assert.equal(more["Comp reason"], "Pilot");
  assert.match(more.Status, /closed 2026-10-01/);
});

test("stripeFacts: none, unavailable, a subscription with a comp discount, other discounts", () => {
  assert.equal(stripeFacts(null).summary, "No Stripe customer");
  assert.match(stripeFacts({ error: "unavailable" }).summary, /unavailable/);
  const full = stripeFacts({
    subscription: { id: "sub_1", status: "active", plan: "pro", interval: "month", lookupKey: "pro_month", seats: 5, currentPeriodEnd: "2026-11-01T00:00:00Z", cancelAtPeriodEnd: true, trialEnd: "2026-09-01T00:00:00Z", compDiscountUntil: "2026-12-02T00:00:00Z" },
    subscriptionCount: 2,
    invoices: [{ id: "in_1", number: "A-1", status: "paid", total: 2700, currency: "usd", createdAt: "2026-09-01T00:00:00Z" }, { id: "in_2", status: "open", total: 0, currency: "usd" }],
    hasMoreInvoices: true,
  });
  assert.equal(full.summary, "Subscription sub_1: active, pro/month (pro_month), 5 seats, period ends 2026-11-01, cancels at period end, trial ends 2026-09-01");
  assert.equal(full.discount, "Comp discount: invoices $0 until about 2026-12-02, then billing resumes");
  assert.deepEqual(full.invoices, [
    { number: "A-1", status: "paid", total: "27.00 USD", created: "2026-09-01" },
    { number: "in_2", status: "open", total: "0.00 USD", created: "-" },
  ]);
  assert.equal(full.notes.length, 2);
  const other = stripeFacts({ subscription: { id: "sub_2", status: "active", seats: 1, cancelAt: "2027-01-01T00:00:00Z", discountCount: 1 }, invoices: [] });
  assert.equal(other.summary, "Subscription sub_2: active, unknown price, 1 seats, cancels on 2027-01-01");
  assert.equal(other.discount, "1 discount on the subscription (not a comp's)");
  assert.equal(stripeFacts({ subscription: { id: "s", discountCount: 2 } }).discount, "2 discounts on the subscription (not a comp's)");
  const none = stripeFacts({ subscription: null, invoices: [] });
  assert.equal(none.summary, "No subscription");
  assert.equal(none.discount, "No comp discount");
});

test("receiptLines", () => {
  assert.deepEqual(receiptLines(undefined), []);
  assert.deepEqual(receiptLines(null), ["Receipts: unavailable (try again later)"]);
  assert.deepEqual(receiptLines({ trialReceipts: 4, months: [{ month: "2026-10", receipts: 12, estimatedCostUsd: 0.084 }] }), ["Receipts in its trial: 4", "Receipts 2026-10: 12, est. $0.08"]);
  assert.deepEqual(receiptLines({ trialReceipts: 0 }), ["Receipts in its trial: 0"]);
});

test("auditChange and auditRow, for every action", () => {
  assert.equal(auditChange({ action: "ops.comp.discount", after: { outcome: "applied", coupon: "c-2m", until: "2026-12-02T00:00:00Z" } }), "Stripe discount: applied (c-2m until 2026-12-02)");
  assert.equal(auditChange({ action: "ops.comp.discount", after: { outcome: "in_sync" } }), "Stripe discount: in_sync");
  assert.equal(auditChange({ action: "ops.import.clear", after: { importId: "i1" } }), "import i1");
  assert.equal(auditChange({ action: "ops.receipts.usage", after: { month: "2026-09", teams: [1, 2] } }), "receipts 2026-09, 2 teams");
  assert.equal(auditChange({ action: "ops.receipts.usage", after: { month: "2026-09" } }), "receipts 2026-09, 0 teams");
  assert.equal(auditChange({ action: "ops.team.reopen", before: { closedAt: "2026-09-30" } }), "closed 2026-09-30 -> open");
  assert.equal(auditChange({ action: "ops.team.reopen" }), "closed - -> open");
  assert.equal(auditChange({ action: "ops.comp.set", after: { plan: "free", until: "2026-12-02T00:00:00Z", months: 2 } }), "-> free until 2026-12-02 (2 months)");
  assert.equal(auditChange({ action: "ops.comp.set", after: { plan: "free", until: "2026-12-02" } }), "-> free until 2026-12-02");
  assert.equal(auditChange({ action: "ops.comp.end", after: null }), "-> none");
  assert.equal(auditChange({ action: "ops.team.read", after: "x" }), "");
  assert.deepEqual(auditRow({ ts: "2026-10-02T12:00:00Z", action: "ops.comp.end", teamId: "t1", operatorSub: "s1", reason: "Over" }), {
    ts: "2026-10-02T12:00:00Z",
    action: "ops.comp.end",
    teamId: "t1",
    by: "s1",
    change: "-> none",
    reason: "Over",
  });
  assert.equal(auditRow({}).reason, "");
});

test("a reason is required for every write", () => {
  assert.equal(checkReason("  Pilot  "), "Pilot");
  assert.throws(() => checkReason(""), InputError);
  assert.throws(() => checkReason(undefined), /Give a reason/);
  assert.throws(() => checkReason("ab"), /at least 3/);
  assert.throws(() => checkReason("x".repeat(501)), /500/);
  assert.throws(() => checkReason("two\nlines"), /one line/);
});

test("compBody: months or an end date, the team's plan by default, and its version", () => {
  assert.deepEqual(compBody({ mode: "months", months: "2", plan: "", seats: "", reason: "Two months on us" }, team, NOW), { plan: "pro", months: 2, reason: "Two months on us", expectedVersion: 7 });
  assert.deepEqual(compBody({ mode: "until", until: "2026-12-31", plan: "free", seats: "3", reason: "Pilot" }, team, NOW), { plan: "free", until: "2026-12-31", seats: 3, reason: "Pilot", expectedVersion: 7 });
  const bad = (form, pattern) => assert.throws(() => compBody({ mode: "months", months: "1", reason: "Pilot", ...form }, team, NOW), pattern);
  bad({ reason: "" }, /reason/);
  bad({ plan: "Pro Plan" }, /plan name/);
  bad({ seats: "0" }, /Seats/);
  bad({ seats: "101" }, /Seats/);
  bad({ seats: "1.5" }, /Seats/);
  bad({ months: "0" }, /Months/);
  bad({ months: "13" }, /Months/);
  bad({ months: "x" }, /Months/);
  bad({ mode: "until", until: "" }, /Pick the date/);
  bad({ mode: "until" }, /Pick the date/);
  bad({ mode: "until", until: "2026-02-31x" }, /Pick the date/);
  bad({ mode: "until", until: "2026-10-01" }, /future/);
  bad({ mode: "forever" }, /Choose/);
  assert.throws(() => compBody({ mode: "months", months: "1", reason: "Pilot" }, { ...team, plan: undefined }, NOW), /plan name/);
  assert.equal(compBody({ mode: "until", until: "2027-01-01", reason: "Pilot" }, team).until, "2027-01-01");
});

test("endCompBody needs a reason and sends the version", () => {
  assert.deepEqual(endCompBody({ reason: "Pilot over" }, team), { reason: "Pilot over", expectedVersion: 7 });
  assert.throws(() => endCompBody({ reason: " " }, team), InputError);
});

test("checkMonth", () => {
  assert.equal(checkMonth("2026-09"), "2026-09");
  assert.equal(checkMonth(""), undefined);
  assert.equal(checkMonth(undefined), undefined);
  assert.throws(() => checkMonth("2026-13"), /YYYY-MM/);
});

test("idempotency keys: the same request without an answer reuses its key; anything else gets a new one", () => {
  let n = 0;
  const keys = idempotencyKeys(() => `k${++n}`);
  assert.equal(keys.keyFor(["comp", "t1", { months: 2 }]), "k1");
  assert.equal(keys.keyFor(["comp", "t1", { months: 2 }]), "k1");
  assert.equal(keys.keyFor(["comp", "t1", { months: 3 }]), "k2");
  keys.answered();
  assert.equal(keys.keyFor(["comp", "t1", { months: 3 }]), "k3");
  assert.match(idempotencyKeys().keyFor(["x"]), /^[0-9a-f-]{36}$/);
  assert.equal(Object.keys(DISCOUNT_OUTCOMES).length, 3);
});
