// The billing worker (src/billing/worker.ts) against the in-memory table, with
// each event's handles passing only what the billing-worker role allows
// (test/billing-policy.ts), and a fake Stripe. test/billing-ddb.test.ts runs
// the data functions' conditions against DynamoDB Local.

import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import type { SQSEvent } from "aws-lambda";
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingMessage } from "../src/billing/webhook-handler.js";
import { CLOSED_AT_METADATA, closingAction, closingKey, resumeKey } from "../src/billing/closing.js";
import type { EntitlementStripe } from "../src/billing/entitlements.js";
import type { SeatStripe, SeatSubscription, SeatSyncMessage } from "../src/billing/seats.js";
import type { CompDiscountStripe } from "../src/billing/comp-discount.js";
import { createBillingWorker, endedEarlier, noticeFor, parseMessage, type SubscriptionLike, subscriptionState, type WorkerStripe } from "../src/billing/worker.js";
import { workerScopedDbs, type WorkerScope } from "../src/billing/worker-db.js";
import { cancelReplacedKey, unpaidToClear, voidReplacedKey } from "../src/billing/replaced.js";
import { createWorkerHandler } from "../src/billing/worker-handler.js";
import { teamBody } from "../src/api/account-handler.js";
import { errorFor } from "../src/api/data-handler.js";
import { connection } from "../src/data/client.js";
import { authorizeTeam, createInvite, createProduct, deletionTime, linkStripeCustomer, setOwnMemberEmail, SubscriptionEndedError } from "../src/data/index.js";
import { BusinessMetric, type BusinessMetricName, type Metadata, type Observability, skippedForTest } from "../src/observability/index.js";
import { workerPolicy } from "./billing-policy.js";
import { fakeMailer, REGION, stripeSubscriptionUpdate } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const DAY_S = 86400;
const TEAM = "team-a";
const CUSTOMER = "cus_test_1";
const OWNER = "user-owner";
const OWNER2 = "user-owner-2";
const CREW = "user-crew";

let table: MemoryTable;
let subs: Map<string, SubscriptionLike>;
let retrieves: string[];
let cancels: { id: string; key: string }[];
/** Stripe's invoices: subscription, customer and status. */
let invoices: Map<string, { subscription: string; customer: string; status: string; amount_paid?: number }>;
/** Stripe can't list subscriptions (as when it's down). */
let listFails: boolean;
let voids: { id: string; key: string }[];
let invoiceListings: { subscription: string; status: string; limit: number; starting_after?: string }[];
/** How many invoices Stripe lists on a page (OPEN_INVOICES_LISTED in production). */
let invoicePage: number;
/** Stripe fails voiding an invoice. */
let voidFails: boolean;
/** Invoices Stripe refuses to void for good (an invalid-request error). */
let refuseVoid: Set<string>;
let updates: { id: string; params: Record<string, unknown>; key: string }[];
let seatUpdates: { item: string; quantity: number; proration: string; key: string }[];
let stripeDown: boolean;
/** Stripe refuses resuming a subscription (cancel_at_period_end back to false). */
let refuseResume: boolean;
/** Stripe's clock for the requests it takes (epoch seconds): canceled_at. */
let stripeClock: number;
/** The idempotency keys Stripe has seen. */
let stripeKeys: Set<string>;
/** Runs as Stripe is asked for a subscription: after the worker read the team, before it writes. */
let onRetrieve: (() => void) | undefined;
/** Runs after Stripe takes an update: before the worker reads the team again. */
let onUpdate: (() => void) | undefined;
/** The table refuses the worker's reads (GetItem), as when DynamoDB throttles. */
let readsFail: boolean;
let denied: { command: string; input: Record<string, unknown> }[];
let scopes: WorkerScope[];
let counts: Record<string, number>;
/** Every count() call, with its metadata. */
let lines: [BusinessMetricName, number, Metadata][];
let logs: unknown[][];
let mails: ReturnType<typeof fakeMailer>;
let worker: ReturnType<typeof createBillingWorker>;

function obs(): Observability {
  return {
    region: REGION,
    logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), addContext: () => {} } as unknown as Observability["logger"],
    count: (m, v = 1, metadata = {}) => {
      counts[m] = (counts[m] ?? 0) + v;
      lines.push([m, v, metadata]);
    },
    gauge: () => {},
    flush: () => {},
  };
}

/** A Stripe subscription as both the worker and the seat sync read it. */
type Sub = SubscriptionLike & SeatSubscription;

function subscription(fields: Partial<SubscriptionLike> & { quantity?: number; lookupKey?: string | null; interval?: string } = {}): Sub {
  const { quantity = 3, lookupKey = "supply_checkout_starter_monthly", interval = "month", ...rest } = fields;
  return {
    id: "sub_test_1",
    customer: CUSTOMER,
    status: "trialing",
    cancel_at_period_end: false,
    trial_end: NOW / 1000 + 13 * DAY_S,
    default_payment_method: null,
    items: { data: [{ id: "si_test_1", quantity, current_period_end: NOW / 1000 + 13 * DAY_S, price: { lookup_key: lookupKey, recurring: { interval } } }] },
    ...rest,
  } as Sub;
}

beforeEach(() => {
  table = new MemoryTable();
  table.seedTeam(TEAM, { [OWNER]: "owner", [OWNER2]: "owner", [CREW]: "contributor" });
  for (const [userId, email] of [[OWNER, "owner@example.com"], [OWNER2, "second@example.com"], [CREW, "crew@example.com"]]) {
    table.put({ ...(table.get(`TEAM#${TEAM}`, `MEMBER#${userId}`) as Record<string, unknown>), email });
  }
  patchTeam({ name: "Echo Plumbing", plan: "trial", seats: 1, status: "trialing", stripeCustomerId: CUSTOMER });
  table.put({ PK: `STRIPE#${CUSTOMER}`, SK: "TEAM", type: "stripeLink", customerId: CUSTOMER, teamId: TEAM });
  subs = new Map([["sub_test_1", subscription()]]);
  retrieves = [];
  cancels = [];
  invoices = new Map();
  voids = [];
  invoiceListings = [];
  invoicePage = 100;
  voidFails = false;
  refuseVoid = new Set();
  listFails = false;
  updates = [];
  onRetrieve = undefined;
  onUpdate = undefined;
  readsFail = false;
  seatUpdates = [];
  stripeDown = false;
  refuseResume = false;
  stripeClock = NOW / 1000;
  stripeKeys = new Set();
  denied = [];
  scopes = [];
  counts = {};
  lines = [];
  logs = [];
  mails = fakeMailer();
  build();
});

/** The worker, with its clock at `nowMs`. */
function build(nowMs = NOW) {
  const stripe: WorkerStripe & SeatStripe & EntitlementStripe & CompDiscountStripe = {
    // Comp discounts have their own tests (comp-discount.test.ts)
    coupons: {
      async retrieve() {
        throw new Error("not used");
      },
      async create() {
        throw new Error("not used");
      },
    },
    subscriptions: {
      async list({ limit }) {
        if (listFails) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        // Every customer's, newest first: the worker must pick out the customer's own itself
        return { data: [...subs.values()].sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).slice(0, limit) };
      },
      async retrieve(id: string) {
        retrieves.push(id);
        onRetrieve?.();
        if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        const found = subs.get(id);
        if (!found) throw Object.assign(new Error(`No such subscription ${id}`), { code: "resource_missing" });
        return found as SubscriptionLike & SeatSubscription;
      },
      async update(id: string, params: { cancel_at_period_end?: boolean; metadata: Record<string, string> }, options: { idempotencyKey: string }) {
        if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        if (refuseResume && params.cancel_at_period_end === false) throw Object.assign(new Error("Stripe is busy"), { name: "StripeRateLimitError" });
        // A key Stripe has seen in the last 24 hours gets the cached answer, and changes nothing
        if (stripeKeys.has(options.idempotencyKey)) return;
        stripeKeys.add(options.idempotencyKey);
        updates.push({ id, params, key: options.idempotencyKey });
        subs.set(id, stripeSubscriptionUpdate(subs.get(id) as SubscriptionLike, params, stripeClock));
        onUpdate?.();
      },
      async cancel(id, _params, options) {
        if (stripeKeys.has(options.idempotencyKey)) return;
        stripeKeys.add(options.idempotencyKey);
        const found = subs.get(id) as SubscriptionLike;
        // As Stripe answers cancelling one that's already canceled
        if (found.status === "canceled") throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
        cancels.push({ id, key: options.idempotencyKey });
        subs.set(id, { ...found, status: "canceled" });
      },
    },
    invoices: {
      async list(params) {
        invoiceListings.push(params);
        const open = [...invoices].filter(([, i]) => i.subscription === params.subscription && i.status === params.status).map(([id, i]) => ({ id, customer: i.customer, amount_paid: i.amount_paid ?? 0 }));
        const from = params.starting_after ? open.findIndex((i) => i.id === params.starting_after) + 1 : 0;
        const size = Math.min(params.limit, invoicePage);
        return { data: open.slice(from, from + size), has_more: open.length > from + size };
      },
      async voidInvoice(id, _params, options) {
        if (voidFails) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        if (refuseVoid.has(id)) throw new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: `Invoice ${id} can't be voided`, code: "invoice_not_editable", statusCode: 400, requestId: "req_test_1" } as never);
        if (stripeKeys.has(options.idempotencyKey)) return;
        stripeKeys.add(options.idempotencyKey);
        const found = invoices.get(id);
        if (found?.status !== "open") throw Object.assign(new Error("Only open invoices can be voided"), { code: "invoice_not_open" });
        voids.push({ id, key: options.idempotencyKey });
        invoices.set(id, { ...found, status: "void" });
      },
    },
    subscriptionItems: {
      async update(item, params, options) {
        seatUpdates.push({ item, quantity: params.quantity, proration: params.proration_behavior, key: options.idempotencyKey });
        for (const [id, sub] of subs) {
          if (sub.items.data.some((i) => (i as { id?: string }).id === item)) {
            subs.set(id, { ...sub, items: { data: sub.items.data.map((i) => ((i as { id?: string }).id === item ? { ...i, quantity: params.quantity } : i)) } });
          }
        }
      },
    },
  };
  worker = createBillingWorker({
    dbFor: (scope) => {
      scopes.push(scope);
      const allowed = workerPolicy(scope, denied);
      return table.guarded((command, input) => {
        if (readsFail && command === "GetCommand") throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
        return allowed(command, input);
      });
    },
    stripe: async () => stripe,
    mailer: mails.mailer,
    obs: obs(),
    now: () => nowMs,
  });
}

function patchTeam(fields: Record<string, unknown>) {
  const meta = table.get(`TEAM#${TEAM}`, "META") as Record<string, unknown>;
  table.put(Object.fromEntries(Object.entries({ ...meta, ...fields }).filter(([, v]) => v !== undefined)));
}

const meta = () => table.get(`TEAM#${TEAM}`, "META") as Record<string, unknown>;
const message = (type: BillingMessage["type"], fields: Partial<BillingMessage> = {}): BillingMessage => ({ eventId: "evt_test_1", type, created: NOW / 1000, customer: CUSTOMER, subscription: "sub_test_1", ...fields });
const processed = (eventId = "evt_test_1") => table.get(`WEBHOOK#${eventId}`, "DONE");

describe("applying a subscription", () => {
  it("makes the team subscribed after a checkout: plan, seats, status, interval and period end, then records the event", async () => {
    expect(await worker(message("checkout.session.completed"))).toBe("applied");
    expect(meta()).toMatchObject({
      plan: "starter",
      seats: 3,
      status: "trialing",
      stripeSubscriptionId: "sub_test_1",
      billingInterval: "month",
      currentPeriodEnd: new Date(NOW + 13 * DAY_S * 1000).toISOString(),
      cancelAtPeriodEnd: false,
      stripeSyncedAt: new Date(NOW).toISOString(),
      version: 2,
    });
    expect(processed()).toMatchObject({ type: "webhook", eventId: "evt_test_1" });
    expect(counts[BusinessMetric.BillingEventsApplied]).toBe(1);
    expect(mails.sent).toEqual([]);
    expect(denied).toEqual([]);
    // The team comes from our link, then every team call is on a session tagged with it
    // (twice: the event, then its seat check, which finds the team the same way)
    const scoped = [{ eventId: "evt_test_1", stripeCustomer: CUSTOMER }, { eventId: "evt_test_1", stripeCustomer: CUSTOMER, teamId: TEAM }];
    expect(scopes).toEqual([...scoped, ...scoped]);
    // Three billed members, three seats: nothing to change
    expect(seatUpdates).toEqual([]);
  });

  it("makes the team active when the purchase is paid (no trial)", async () => {
    subs.set("sub_test_1", subscription({ status: "active", trial_end: null, quantity: 5, lookupKey: "supply_checkout_starter_annual", interval: "year" }));
    await worker(message("invoice.paid"));
    expect(meta()).toMatchObject({ status: "active", plan: "starter", seats: 5, billingInterval: "year" });
    // /me and the member cap now treat it as paying
    const ctx = await authorizeTeam(table.db(TEAM), OWNER, TEAM);
    expect(ctx.subscriptionEnded).toBe(false);
  });

  it("changes nothing when the same event is replayed", async () => {
    await worker(message("customer.subscription.updated"));
    const before = structuredClone(meta());
    const calls = retrieves.length;
    expect(await worker(message("customer.subscription.updated"))).toBe("duplicate");
    expect(meta()).toEqual(before);
    // Only the seat check reads it again (a retry after the seat update failed), and the seats are right
    expect(retrieves).toHaveLength(calls + 1);
    expect(seatUpdates).toEqual([]);
  });

  it("applies the latest subscription whatever the order: an older event after a newer one leaves the newer state", async () => {
    subs.set("sub_test_1", subscription({ status: "active", quantity: 4 }));
    // Four billed members, so the seat sync leaves the quantity as it is
    table.put({ PK: `TEAM#${TEAM}`, SK: "MEMBER#user-4", type: "member", teamId: TEAM, userId: "user-4", role: "contributor" });
    await worker(message("customer.subscription.updated", { eventId: "evt_new", created: NOW / 1000 }));
    await worker(message("customer.subscription.created", { eventId: "evt_old", created: NOW / 1000 - 60 }));
    expect(meta()).toMatchObject({ status: "active", seats: 4 });
  });

  it("keeps the plan for a price we don't sell, and takes the seats from every item", async () => {
    const sub = subscription({ lookupKey: null });
    subs.set("sub_test_1", { ...sub, items: { data: [...sub.items.data, { quantity: 2, current_period_end: 0, price: { lookup_key: null, recurring: null } }] } });
    await worker(message("customer.subscription.updated"));
    expect(meta()).toMatchObject({ plan: "trial", seats: 5 });
    expect(meta().billingInterval).toBeUndefined();
  });

  it("records, and changes nothing for, an unknown customer", async () => {
    expect(await worker(message("customer.subscription.updated", { customer: "cus_test_stranger" }))).toBe("unknown_customer");
    expect(processed()).toBeDefined();
    expect(retrieves).toEqual([]);
  });

  it("ignores a team being purged without calling Stripe: deleting its customer ends the subscription", async () => {
    patchTeam({ closedAt: new Date(NOW - DAY_S * 1000).toISOString(), purging: new Date(NOW).toISOString() });
    expect(await worker(message("customer.subscription.updated"))).toBe("team_closed");
    expect(meta().stripeSubscriptionId).toBeUndefined();
    expect(retrieves).toEqual([]);
    expect(processed()).toBeDefined();
  });

  it("never reopens or changes a closed team, but sets a subscription still live on it to cancel at the period's end, once", async () => {
    const closedAt = new Date(NOW - DAY_S * 1000).toISOString();
    patchTeam({ closedAt });
    const before = structuredClone(meta());
    // A checkout that finished after the team closed: its subscription was never recorded
    expect(await worker(message("checkout.session.completed"))).toBe("team_closed");
    expect(meta()).toEqual(before);
    expect(updates).toEqual([{ id: "sub_test_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: closedAt } }, key: closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1", "evt_test_1") }]);
    expect(counts[BusinessMetric.ClosedTeamSubscriptionsEnded]).toBe(1);
    expect(counts[BusinessMetric.BillingEventsApplied]).toBeUndefined();
    expect(logs).toContainEqual(["Closed team's subscription ended", { teamId: TEAM, eventId: "evt_test_1", subscriptionId: "sub_test_1", status: "trialing", action: "cancel_at_period_end" }]);
    // Stripe's own event for that change, and a later payment: nothing more to do, and still nothing written
    expect(await worker(message("customer.subscription.updated", { eventId: "evt_test_2" }))).toBe("team_closed");
    expect(await worker(message("invoice.paid", { eventId: "evt_test_3" }))).toBe("team_closed");
    expect(updates).toHaveLength(1);
    expect(meta()).toEqual(before);
    expect(mails.sent).toEqual([]);
    expect(denied).toEqual([]);
    // Renewed while closed (a Customer Portal page opened before the closure, say): the next event sets it to
    // cancel again with a key of its own, which Stripe can't answer from its cache of the first
    subs.set("sub_test_1", { ...(subs.get("sub_test_1") as SubscriptionLike), cancel_at_period_end: false });
    expect(await worker(message("customer.subscription.updated", { eventId: "evt_test_4" }))).toBe("team_closed");
    expect(updates.map((u) => u.key)).toEqual([closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1", "evt_test_1"), closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1", "evt_test_4")]);
    expect(subs.get("sub_test_1")?.cancel_at_period_end).toBe(true);
  });

  it("cancels an unpaid or paused subscription on a closed team at once, and leaves an ended or foreign one", async () => {
    const closedAt = new Date(NOW - DAY_S * 1000).toISOString();
    patchTeam({ closedAt });
    subs.set("sub_test_1", subscription({ status: "paused" }));
    expect(await worker(message("customer.subscription.updated"))).toBe("team_closed");
    expect(cancels).toEqual([{ id: "sub_test_1", key: closingKey("cancel_now", TEAM, closedAt, "sub_test_1", "evt_test_1") }]);
    // Now canceled: nothing more
    expect(await worker(message("customer.subscription.deleted", { eventId: "evt_test_2" }))).toBe("team_closed");
    subs.set("sub_test_2", subscription({ id: "sub_test_2", status: "active", customer: "cus_test_other" }));
    expect(await worker(message("customer.subscription.updated", { eventId: "evt_test_3", subscription: "sub_test_2" }))).toBe("team_closed");
    // No subscription on the event: nothing to fetch
    expect(await worker(message("invoice.paid", { eventId: "evt_test_4", subscription: undefined }))).toBe("team_closed");
    expect(cancels).toHaveLength(1);
    expect(updates).toEqual([]);
  });

  it("retries a closed team's event when Stripe can't be reached, recording nothing", async () => {
    patchTeam({ closedAt: new Date(NOW - DAY_S * 1000).toISOString() });
    stripeDown = true;
    await expect(worker(message("customer.subscription.updated"))).rejects.toThrow("Stripe is down");
    expect(processed()).toBeUndefined();
    stripeDown = false;
    expect(await worker(message("customer.subscription.updated"))).toBe("team_closed");
    expect(updates).toHaveLength(1);
  });

  it("fails an event, and resumes the subscription, when the team was reopened while it was being set to cancel", async () => {
    const closedAt = new Date(NOW - DAY_S * 1000).toISOString();
    patchTeam({ closedAt });
    // The owner reopens after the worker read the team as closed, before Stripe answers
    onRetrieve = () => {
      onRetrieve = undefined;
      patchTeam({ closedAt: undefined });
    };
    await expect(worker(message("customer.subscription.updated"))).rejects.toThrow("Team reopened while its subscription was being ended");
    // Set to cancel, then resumed at once with the worker's own key: the reopen's resync may already have run
    expect(updates).toEqual([
      { id: "sub_test_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: closedAt } }, key: closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1", "evt_test_1") },
      { id: "sub_test_1", params: { cancel_at_period_end: false, metadata: { [CLOSED_AT_METADATA]: "" } }, key: resumeKey("worker", TEAM, closedAt, "sub_test_1") },
    ]);
    expect(subs.get("sub_test_1")).toMatchObject({ cancel_at_period_end: false, metadata: {} });
    expect(logs).toContainEqual(["Team reopened while its subscription was being ended: resumed", { teamId: TEAM, eventId: "evt_test_1", subscriptionId: "sub_test_1", action: "cancel_at_period_end" }]);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsResumed]).toBe(1);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsEnded]).toBeUndefined();
    expect(counts[BusinessMetric.ClosedTeamSubscriptionsEnded]).toBeUndefined();
    expect(processed()).toBeUndefined();
    expect(denied).toEqual([]);
    // Its redelivery finds the team open: applied as usual, renewing, and nothing more sent to Stripe
    expect(await worker(message("customer.subscription.updated"))).toBe("applied");
    expect(meta()).toMatchObject({ stripeSubscriptionId: "sub_test_1", cancelAtPeriodEnd: false });
    expect(updates).toHaveLength(2);
    expect(cancels).toEqual([]);
    expect(processed()).toBeDefined();
    // When Stripe refuses the resume, it's flagged for a person instead
    patchTeam({ closedAt });
    onRetrieve = () => {
      onRetrieve = undefined;
      patchTeam({ closedAt: undefined });
      refuseResume = true;
    };
    await expect(worker(message("customer.subscription.updated", { eventId: "evt_test_r" }))).rejects.toThrow("Team reopened while its subscription was being ended");
    expect(logs).toContainEqual(["Reopened team's subscription not resumed", { teamId: TEAM, subscriptionId: "sub_test_1", error: "StripeRateLimitError" }]);
    expect(logs).toContainEqual(["Team reopened while its subscription was being ended", { teamId: TEAM, eventId: "evt_test_r", subscriptionId: "sub_test_1", action: "cancel_at_period_end" }]);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsEnded]).toBe(1);
    refuseResume = false;
    // Closed again with a new closure in between: still not the closure it was ended for
    patchTeam({ closedAt });
    onRetrieve = () => {
      onRetrieve = undefined;
      patchTeam({ closedAt: new Date(NOW).toISOString() });
    };
    subs.set("sub_test_1", subscription({ status: "unpaid" }));
    await expect(worker(message("customer.subscription.updated", { eventId: "evt_test_2" }))).rejects.toThrow("Team reopened while its subscription was being ended");
    expect(logs).toContainEqual(["Team reopened while its subscription was being ended", { teamId: TEAM, eventId: "evt_test_2", subscriptionId: "sub_test_1", action: "cancel_now" }]);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsEnded]).toBe(2);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsResumed]).toBe(1);
  });

  it("carries on when the team is still closed, or purged, once Stripe has answered", async () => {
    const closedAt = new Date(NOW - DAY_S * 1000).toISOString();
    patchTeam({ closedAt });
    // The purge deleted it meanwhile: deleting its customer ends the subscription anyway
    onRetrieve = () => {
      onRetrieve = undefined;
      table.items.delete(`TEAM#${TEAM}\u0000META`);
    };
    expect(await worker(message("customer.subscription.updated"))).toBe("team_closed");
    expect(updates).toHaveLength(1);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsEnded]).toBeUndefined();
    expect(counts[BusinessMetric.ClosedTeamSubscriptionsEnded]).toBe(1);
  });

  it("alarms, and retries the event, when the team can't be read again after its subscription was set to end (supply-checkout-8jc.30)", async () => {
    const closedAt = new Date(NOW - DAY_S * 1000).toISOString();
    patchTeam({ closedAt });
    // Reopened while Stripe was asked, and DynamoDB refuses the re-read that would have seen it
    onUpdate = () => {
      onUpdate = undefined;
      patchTeam({ closedAt: undefined, stripeResyncFor: closedAt, stripeReopenedAt: new Date(NOW - 1000).toISOString() });
      readsFail = true;
    };
    await expect(worker(message("customer.subscription.updated"))).rejects.toThrow("the team wasn't read again");
    expect(updates).toHaveLength(1);
    // Can't tell whether the team was reopened: a person looks (the "Reopened team's subscription ended" alarm)
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsEnded]).toBe(1);
    expect(logs).toContainEqual(["Closed team's subscription set to end, but the team wasn't read again", { teamId: TEAM, eventId: "evt_test_1", subscriptionId: "sub_test_1", action: "cancel_at_period_end", error: "ThrottlingException" }]);
    expect(counts[BusinessMetric.ClosedTeamSubscriptionsEnded]).toBeUndefined();
    expect(processed()).toBeUndefined();
    // The retry applies the event to the open team
    readsFail = false;
    expect(await worker(message("customer.subscription.updated"))).toBe("applied");
    expect(processed()).toBeDefined();
  });

  it("never recreates a purged team", async () => {
    table.items.delete(`TEAM#${TEAM}\u0000META`);
    expect(await worker(message("customer.subscription.updated"))).toBe("team_gone");
    expect(table.get(`TEAM#${TEAM}`, "META")).toBeUndefined();
  });

  it("ignores a team closed between its read and the write, and sets the subscription it never recorded to cancel", async () => {
    const closedAt = new Date(NOW).toISOString();
    onRetrieve = () => {
      onRetrieve = undefined;
      patchTeam({ closedAt });
    };
    expect(await worker(message("customer.subscription.updated"))).toBe("team_closed");
    expect(meta().stripeSubscriptionId).toBeUndefined();
    expect(updates).toEqual([{ id: "sub_test_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: closedAt } }, key: closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1", "evt_test_1") }]);
    // Fetched once: the subscription as read is the one ended
    expect(retrieves).toEqual(["sub_test_1"]);
  });

  it("leaves Stripe alone for a team purged or being purged between its read and the write", async () => {
    onRetrieve = () => patchTeam({ closedAt: new Date(NOW).toISOString(), purging: new Date(NOW).toISOString() });
    expect(await worker(message("customer.subscription.updated"))).toBe("team_closed");
    patchTeam({ closedAt: undefined, purging: undefined });
    onRetrieve = () => table.items.delete(`TEAM#${TEAM}\u0000META`);
    expect(await worker(message("customer.subscription.updated", { eventId: "evt_test_2" }))).toBe("team_closed");
    expect(table.get(`TEAM#${TEAM}`, "META")).toBeUndefined();
    expect(updates).toEqual([]);
    expect(cancels).toEqual([]);
  });

  it("ignores a subscription that belongs to another customer", async () => {
    subs.set("sub_test_1", subscription({ customer: { id: "cus_test_other" } }));
    expect(await worker(message("customer.subscription.updated"))).toBe("ignored");
    expect(meta().stripeSubscriptionId).toBeUndefined();
  });

  it("records an event with no subscription without calling Stripe", async () => {
    expect(await worker(message("invoice.paid", { subscription: undefined }))).toBe("ignored");
    expect(retrieves).toEqual([]);
  });

  it("cancels a second live subscription (two checkouts finished), and takes a new one once the team's has ended", async () => {
    await worker(message("checkout.session.completed"));
    subs.set("sub_test_2", subscription({ id: "sub_test_2", status: "trialing" }));
    expect(await worker(message("checkout.session.completed", { eventId: "evt_test_2", subscription: "sub_test_2" }))).toBe("second_subscription_canceled");
    expect(meta()).toMatchObject({ stripeSubscriptionId: "sub_test_1", status: "trialing" });
    // Idempotent per subscription: the key names the subscription it cancels
    expect(cancels).toEqual([{ id: "sub_test_2", key: `cancel-second-${"sub_test_2"}` }]);
    expect(logs.find((l) => l[0] === "Second subscription canceled")?.[1]).toMatchObject({ teamId: TEAM, subscriptionId: "sub_test_2", kept: "sub_test_1" });
    // Its own deletion event: already ended, so nothing more to cancel, no email, and the team keeps the first
    expect(await worker(message("customer.subscription.deleted", { eventId: "evt_test_2b", subscription: "sub_test_2", status: "canceled" }))).toBe("ignored");
    expect(cancels).toHaveLength(1);
    expect(mails.sent).toEqual([]);
    expect(meta().status).toBe("trialing");
    subs.set("sub_test_2", subscription({ id: "sub_test_2", status: "active" }));
    // Stripe says the first one ended, though the team hasn't heard yet
    subs.set("sub_test_1", subscription({ status: "canceled" }));
    expect(await worker(message("checkout.session.completed", { eventId: "evt_test_3", subscription: "sub_test_2" }))).toBe("applied");
    expect(meta()).toMatchObject({ stripeSubscriptionId: "sub_test_2", status: "active" });
    // And once the team knows its subscription ended, without asking Stripe about it
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active" }));
    patchTeam({ status: "canceled" });
    retrieves = [];
    expect(await worker(message("checkout.session.completed", { eventId: "evt_test_4", subscription: "sub_test_3" }))).toBe("applied");
    // Once to apply it, once for its seats
    expect(retrieves).toEqual(["sub_test_3", "sub_test_3"]);
  });

  it("throws, recording nothing, when Stripe can't be reached, so the event is retried", async () => {
    stripeDown = true;
    await expect(worker(message("customer.subscription.updated"))).rejects.toThrow("Stripe is down");
    expect(processed()).toBeUndefined();
    stripeDown = false;
    expect(await worker(message("customer.subscription.updated"))).toBe("applied");
  });

  it("retries an event applied but not yet recorded, harmlessly", async () => {
    const markFails = { on: true };
    const inner = table.guarded.bind(table);
    table.guarded = (check) =>
      inner((command, input) => {
        if (command === "PutCommand" && String((input.Item as Record<string, unknown>).SK) === "DONE" && markFails.on) {
          markFails.on = false;
          return false;
        }
        return check(command, input);
      });
    build();
    await expect(worker(message("customer.subscription.updated"))).rejects.toThrow();
    expect(meta()).toMatchObject({ status: "trialing", stripeSubscriptionId: "sub_test_1", version: 2 });
    expect(await worker(message("customer.subscription.updated"))).toBe("applied");
    expect(meta()).toMatchObject({ status: "trialing", stripeSubscriptionId: "sub_test_1", version: 3 });
    expect(processed()).toBeDefined();
  });
});

describe("resyncing a reopened team's subscription (supply-checkout-85qp)", () => {
  // The closure the team was reopened from, as the reopen records it (stripeResyncFor)
  const CLOSED = new Date(NOW - 3 * DAY_S * 1000).toISOString();
  // When the purge set it to cancel (Stripe's canceled_at, epoch seconds), and when the team was reopened (stripeReopenedAt)
  const CANCELLED = NOW / 1000 - 2 * DAY_S;
  const REOPENED = new Date(NOW - DAY_S * 1000).toISOString();
  const sync = (reason: "membership" | "reconcile" = "membership", id = "seats-r1") => ({ kind: "seats" as const, id, customer: CUSTOMER, reason, created: NOW / 1000 });
  /** Active, and set to cancel at the period's end by that closure (closing.ts), while the team was closed. */
  const endedByClosure = (fields: Partial<SubscriptionLike> = {}) => subscription({ status: "active", trial_end: null, cancel_at_period_end: true, canceled_at: CANCELLED, metadata: { [CLOSED_AT_METADATA]: CLOSED }, ...fields });
  const resumed = { id: "sub_test_1", params: { cancel_at_period_end: false, metadata: { [CLOSED_AT_METADATA]: "" } }, key: resumeKey("resync", TEAM, CLOSED, "sub_test_1") };
  const body = () => teamBody(meta() as never, "owner", new Date(NOW));

  beforeEach(() => {
    // Recorded as trialing when it closed: the events since were skipped while it was closed
    patchTeam({ plan: "starter", seats: 3, status: "trialing", stripeSubscriptionId: "sub_test_1", cancelAtPeriodEnd: false, stripeResyncFor: CLOSED, stripeReopenedAt: REOPENED });
  });

  it("resumes a subscription its closure set to cancel, applies Stripe's state, and finishes, inside the worker role", async () => {
    subs.set("sub_test_1", endedByClosure());
    expect(await worker(sync())).toBe("in_sync");
    expect(updates).toEqual([resumed]);
    expect(subs.get("sub_test_1")).toMatchObject({ cancel_at_period_end: false, metadata: {} });
    // Stripe's state after the resume: active and renewing, so /me says nothing about it ending
    expect(meta()).toMatchObject({ status: "active", cancelAtPeriodEnd: false, stripeSyncedAt: new Date(NOW).toISOString() });
    expect(meta().stripeResyncFor).toBeUndefined();
    expect(body()).toMatchObject({ subscriptionEnded: false, cancelsAt: null });
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsResumed]).toBe(1);
    expect(counts[BusinessMetric.ReopenResyncsLate]).toBeUndefined();
    expect(logs).toContainEqual(["Reopened team's subscription resynced", { teamId: TEAM, subscriptionId: "sub_test_1", status: "active", action: "resume" }]);
    expect(denied).toEqual([]);
    expect(JSON.stringify(logs)).not.toMatch(/example\.com|Echo Plumbing/);
    // Done: the next sync, and the night's, change nothing
    expect(await worker(sync("membership", "seats-r2"))).toBe("in_sync");
    expect(await worker(sync("reconcile", "reconcile-r"))).toBe("in_sync");
    expect(updates).toHaveLength(1);
    expect(counts[BusinessMetric.ReopenResyncsLate]).toBeUndefined();
  });

  it("leaves a cancellation the owner made in the Customer Portal, and records it so the owner sees when it ends", async () => {
    subs.set("sub_test_1", endedByClosure({ metadata: {} }));
    await worker(sync());
    expect(updates).toEqual([]);
    expect(meta()).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    expect(meta().stripeResyncFor).toBeUndefined();
    expect(body().cancelsAt).toBe(new Date(NOW + 13 * DAY_S * 1000).toISOString());
    expect(logs).toContainEqual(["Reopened team's subscription resynced", { teamId: TEAM, subscriptionId: "sub_test_1", status: "active", action: "none" }]);
    // A subscription never set to cancel is applied as it is, too
    patchTeam({ stripeResyncFor: CLOSED });
    subs.set("sub_test_1", subscription({ status: "active", trial_end: null, metadata: null }));
    await worker(sync("membership", "seats-r2"));
    expect(updates).toEqual([]);
    expect(meta()).toMatchObject({ status: "active", cancelAtPeriodEnd: false });
  });

  it("never resumes a cancellation the owner made in the Customer Portal after renewing one a closure had stamped", async () => {
    // Renewed in the Portal after the reopen: the stamp stayed. Its event removes it (with the event's own key)
    subs.set("sub_test_1", endedByClosure({ cancel_at_period_end: false, canceled_at: null }));
    patchTeam({ stripeResyncFor: undefined });
    expect(await worker(message("customer.subscription.updated", { eventId: "evt_renew" }))).toBe("applied");
    expect(updates).toEqual([{ id: "sub_test_1", params: { metadata: { [CLOSED_AT_METADATA]: "" } }, key: expect.stringMatching(/^team-unstamp-[0-9a-f]{64}$/) }]);
    expect(subs.get("sub_test_1")?.metadata).toEqual({});
    // Then cancelled in the Portal, with a resync still pending: left as the owner set it
    patchTeam({ stripeResyncFor: CLOSED });
    subs.set("sub_test_1", { ...(subs.get("sub_test_1") as SubscriptionLike), cancel_at_period_end: true, canceled_at: NOW / 1000 });
    await worker(sync());
    expect(updates).toHaveLength(1);
    expect(meta()).toMatchObject({ cancelAtPeriodEnd: true });
    expect(meta().stripeResyncFor).toBeUndefined();
    // Renewed and cancelled again before any event removed the stamp: Stripe's canceled_at is after the reopen, so still the owner's
    patchTeam({ stripeResyncFor: CLOSED });
    subs.set("sub_test_1", endedByClosure({ canceled_at: NOW / 1000 }));
    await worker(sync("membership", "seats-r2"));
    // Not resumed, and the leftover stamp goes with the resync: it means nothing now
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual({ id: "sub_test_1", params: { metadata: { [CLOSED_AT_METADATA]: "" } }, key: expect.stringMatching(/^team-unstamp-/) });
    expect(subs.get("sub_test_1")).toMatchObject({ cancel_at_period_end: true, metadata: {} });
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsResumed]).toBeUndefined();
  });

  it("never carries a leftover stamp onto an owner's cancellation: removed on the open team, so the next closure doesn't stamp it and its reopen doesn't resume it", async () => {
    // C1 set it to cancel; R1's resync resumed it
    subs.set("sub_test_1", endedByClosure());
    await worker(sync());
    expect(updates).toEqual([resumed]);
    // The owner renews then cancels in the Portal, and the stamp is still on (as if the resume had left it)
    subs.set("sub_test_1", endedByClosure({ canceled_at: NOW / 1000 - 3600 }));
    // An event on the open team, no resync pending: any stamp of ours goes, set to cancel or not
    expect(meta().stripeResyncFor).toBeUndefined();
    expect(await worker(message("customer.subscription.updated", { eventId: "evt_owner_cancel" }))).toBe("applied");
    expect(updates[1]).toEqual({ id: "sub_test_1", params: { metadata: { [CLOSED_AT_METADATA]: "" } }, key: expect.stringMatching(/^team-unstamp-/) });
    expect(subs.get("sub_test_1")).toMatchObject({ cancel_at_period_end: true, metadata: {} });
    // C2: unstamped and already set to cancel is the owner's, so closing doesn't stamp it
    const c2 = new Date(NOW - 1800 * 1000).toISOString();
    patchTeam({ closedAt: c2 });
    expect(await worker(message("customer.subscription.updated", { eventId: "evt_c2" }))).toBe("team_closed");
    expect(updates).toHaveLength(2);
    // R2: not resumed
    patchTeam({ closedAt: undefined, stripeResyncFor: c2, stripeReopenedAt: new Date(NOW - 600 * 1000).toISOString(), stripeCancelledFor: c2 });
    await worker(sync("membership", "seats-r3"));
    expect(updates).toHaveLength(2);
    expect(subs.get("sub_test_1")?.cancel_at_period_end).toBe(true);
    expect(meta()).toMatchObject({ cancelAtPeriodEnd: true });
    expect(meta().stripeResyncFor).toBeUndefined();
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsResumed]).toBe(1);
  });

  it("keeps the stamp on a subscription set to cancel while its resync is pending", async () => {
    subs.set("sub_test_1", endedByClosure());
    expect(await worker(message("customer.subscription.updated", { eventId: "evt_pending" }))).toBe("applied");
    expect(updates).toEqual([]);
    expect(subs.get("sub_test_1")?.metadata).toEqual({ [CLOSED_AT_METADATA]: CLOSED });
  });

  it("resumes its own cancellation after a team is reopened, closed and reopened again: the second closure stamps it again", async () => {
    // Reopened from the first closure before its resync, then closed again: the subscription still carries the first stamp
    const closedAgain = new Date(NOW - 12 * 3600 * 1000).toISOString();
    patchTeam({ closedAt: closedAgain });
    subs.set("sub_test_1", endedByClosure());
    // Stripe takes the new stamp while the team is closed
    stripeClock = Date.parse(closedAgain) / 1000 + 60;
    expect(await worker(message("customer.subscription.updated", { eventId: "evt_closed" }))).toBe("team_closed");
    expect(updates).toEqual([{ id: "sub_test_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: closedAgain } }, key: closingKey("cancel_at_period_end", TEAM, closedAgain, "sub_test_1", "evt_closed") }]);
    // Reopened from the second closure
    patchTeam({ closedAt: undefined, stripeResyncFor: closedAgain, stripeReopenedAt: new Date(NOW - 3600 * 1000).toISOString() });
    await worker(sync());
    expect(updates[1]).toEqual({ id: "sub_test_1", params: { cancel_at_period_end: false, metadata: { [CLOSED_AT_METADATA]: "" } }, key: resumeKey("resync", TEAM, closedAgain, "sub_test_1") });
    expect(meta()).toMatchObject({ cancelAtPeriodEnd: false, status: "active" });
  });

  it("never resumes an unstamped cancellation the owner made before closing, even though the purge recorded it for the closure", async () => {
    patchTeam({ stripeCancelledFor: CLOSED });
    subs.set("sub_test_1", endedByClosure({ metadata: {}, canceled_at: Date.parse(CLOSED) / 1000 - DAY_S }));
    await worker(sync());
    expect(updates).toEqual([]);
    expect(meta()).toMatchObject({ cancelAtPeriodEnd: true });
    expect(meta().stripeResyncFor).toBeUndefined();
  });

  it("resumes an unstamped cancellation from before the stamp existed only when the purge recorded it and it was set while the team was closed", async () => {
    subs.set("sub_test_1", endedByClosure({ metadata: {} }));
    // Not recorded by the purge for this closure: not taken for ours
    patchTeam({ stripeCancelledFor: "2026-01-01T00:00:00.000Z" });
    await worker(sync());
    expect(updates).toEqual([]);
    // Recorded, and set while closed: ours
    patchTeam({ stripeResyncFor: CLOSED, stripeCancelledFor: CLOSED });
    subs.set("sub_test_1", endedByClosure({ metadata: {} }));
    await worker(sync("membership", "seats-r2"));
    expect(updates).toEqual([resumed]);
    expect(meta()).toMatchObject({ cancelAtPeriodEnd: false });
  });

  it("leaves one it can't tell for a person: counted, warned of, still set to cancel", async () => {
    patchTeam({ stripeCancelledFor: CLOSED });
    subs.set("sub_test_1", endedByClosure({ metadata: {}, canceled_at: null }));
    await worker(sync());
    expect(updates).toEqual([]);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsUndecided]).toBe(1);
    expect(logs).toContainEqual(["Reopened team's subscription left set to cancel", { teamId: TEAM, subscriptionId: "sub_test_1", closedAt: CLOSED }]);
    expect(meta()).toMatchObject({ cancelAtPeriodEnd: true });
    expect(meta().stripeResyncFor).toBeUndefined();
    // A team reopened before stripeReopenedAt was recorded can't be told either
    patchTeam({ stripeResyncFor: CLOSED, stripeReopenedAt: undefined });
    subs.set("sub_test_1", endedByClosure());
    await worker(sync("membership", "seats-r2"));
    expect(updates).toEqual([]);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsUndecided]).toBe(2);
  });

  it("removes a stale stamp it finds while resyncing one the owner renewed", async () => {
    subs.set("sub_test_1", endedByClosure({ cancel_at_period_end: false, canceled_at: null }));
    await worker(sync());
    expect(updates).toEqual([{ id: "sub_test_1", params: { metadata: { [CLOSED_AT_METADATA]: "" } }, key: expect.stringMatching(/^team-unstamp-[0-9a-f]{64}$/) }]);
    expect(meta().stripeResyncFor).toBeUndefined();
  });

  it("asks the owner to subscribe again when the closure cancelled it at once, or it ended since", async () => {
    // Unpaid when it closed: cancelled at once, which nothing can resume
    subs.set("sub_test_1", endedByClosure({ status: "canceled", cancel_at_period_end: false, metadata: {} }));
    expect(await worker(sync())).toBe("subscription_ended");
    expect(updates).toEqual([]);
    expect(meta()).toMatchObject({ status: "canceled" });
    expect(meta().stripeResyncFor).toBeUndefined();
    // The team is read-only, and its owners see Subscribe
    expect(body()).toMatchObject({ subscriptionEnded: true, billingAccount: true });
    expect(logs).toContainEqual(["Reopened team's subscription resynced", { teamId: TEAM, subscriptionId: "sub_test_1", status: "canceled", action: "needs_payment" }]);
    // Set to cancel by the closure, and the period ended before the reopen
    patchTeam({ stripeResyncFor: CLOSED, status: "active" });
    subs.set("sub_test_1", endedByClosure({ status: "canceled" }));
    await worker(sync("membership", "seats-r2"));
    expect(updates).toEqual([]);
    expect(meta()).toMatchObject({ status: "canceled" });
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsResumed]).toBeUndefined();
  });

  it("never blocks on Stripe: a failed resync is retried, and the night's sync finishes one still waiting and counts it late", async () => {
    subs.set("sub_test_1", endedByClosure());
    stripeDown = true;
    await expect(worker(sync())).rejects.toThrow("Stripe is down");
    expect(meta()).toMatchObject({ stripeResyncFor: CLOSED, status: "trialing" });
    stripeDown = false;
    expect(await worker(sync("reconcile", "reconcile-2026-09-28-cus_test_1"))).toBe("in_sync");
    expect(counts[BusinessMetric.ReopenResyncsLate]).toBe(1);
    expect(logs).toContainEqual(["Reopened team's subscription not yet resynced", { teamId: TEAM, closedAt: CLOSED, subscriptionId: "sub_test_1" }]);
    expect(updates).toEqual([resumed]);
    expect(meta()).toMatchObject({ status: "active", cancelAtPeriodEnd: false });
    expect(meta().stripeResyncFor).toBeUndefined();
    // Resynced first, so the entitlement check finds nothing to fix
    expect(counts[BusinessMetric.EntitlementDrift]).toBeUndefined();
    expect(denied).toEqual([]);
  });

  it("leaves it waiting, for a person, when Stripe doesn't have the subscription or it's another customer's", async () => {
    subs.delete("sub_test_1");
    // The entitlement check reports it as missing too
    expect(await worker(sync("reconcile", "reconcile-1"))).toBe("missing");
    expect(meta().stripeResyncFor).toBe(CLOSED);
    expect(logs).toContainEqual(["Reopened team's subscription not resynced: not found in Stripe", { teamId: TEAM, subscriptionId: "sub_test_1" }]);
    subs.set("sub_test_1", endedByClosure({ customer: "cus_test_other" }));
    await worker(sync());
    expect(updates).toEqual([]);
    expect(meta().stripeResyncFor).toBe(CLOSED);
    expect(logs).toContainEqual(["Reopened team's subscription not resynced: another customer's subscription", { teamId: TEAM, subscriptionId: "sub_test_1" }]);
    expect(counts[BusinessMetric.ReopenResyncsLate]).toBe(1);
  });

  it("finishes at once for a team with no subscription, and leaves a team closed again or linked to another customer", async () => {
    patchTeam({ stripeSubscriptionId: undefined });
    await worker(sync());
    expect(meta().stripeResyncFor).toBeUndefined();
    expect(retrieves).toEqual([]);
    // Closed again before the resync: that closure ends it, and the next reopen records itself
    patchTeam({ stripeSubscriptionId: "sub_test_1", stripeResyncFor: CLOSED, closedAt: new Date(NOW).toISOString() });
    subs.set("sub_test_1", endedByClosure());
    expect(await worker(sync("membership", "seats-r2"))).toBe("team_closed");
    expect(meta().stripeResyncFor).toBe(CLOSED);
    expect(updates).toEqual([]);
    patchTeam({ closedAt: undefined, stripeCustomerId: "cus_test_other" });
    await worker(sync("membership", "seats-r3"));
    expect(meta().stripeResyncFor).toBe(CLOSED);
    expect(updates).toEqual([]);
    expect(logs).toContainEqual(["Reopened team's subscription not resynced: the team has another Stripe customer", { teamId: TEAM, messageId: "seats-r3" }]);
  });

  it("leaves it for a later reopen when the team closes again while Stripe is asked", async () => {
    subs.set("sub_test_1", endedByClosure({ cancel_at_period_end: false, metadata: {} }));
    onRetrieve = () => {
      onRetrieve = undefined;
      patchTeam({ closedAt: new Date(NOW).toISOString() });
    };
    expect(await worker(sync())).toBe("team_closed");
    expect(meta()).toMatchObject({ stripeResyncFor: CLOSED, status: "trialing" });
  });

  it("does nothing more for a team that isn't waiting, or a customer it doesn't know", async () => {
    patchTeam({ stripeResyncFor: undefined });
    subs.set("sub_test_1", endedByClosure());
    await worker(sync());
    expect(updates).toEqual([]);
    expect(await worker({ ...sync(), customer: "cus_test_unknown" })).toBe("unknown_customer");
  });

  // supply-checkout-8jc.39: the resync uses the seat sync's link, context and team reads instead of making its own
  describe("reads", () => {
    const reads = () => table.calls.filter((c) => c.command === "GetCommand" || c.command === "QueryCommand").map((c) => `${c.command} ${c.partitions.join(",")}`);
    // Our link for the customer, the team context (the link again, then the team's home region), and the team
    const find = [`GetCommand STRIPE#${CUSTOMER}`, `GetCommand STRIPE#${CUSTOMER}`, `GetCommand TEAM#${TEAM}`, `GetCommand TEAM#${TEAM}`];
    const team = `GetCommand TEAM#${TEAM}`;
    const members = `QueryCommand TEAM#${TEAM}`;

    it("finds the team once for a seat sync with no resync waiting", async () => {
      patchTeam({ stripeResyncFor: undefined });
      table.calls.length = 0;
      expect(await worker(sync())).toBe("in_sync");
      expect(reads()).toEqual([...find, members]);
      expect(scopes).toEqual([{ eventId: "seats-r1", stripeCustomer: CUSTOMER }, { eventId: "seats-r1", stripeCustomer: CUSTOMER, teamId: TEAM }]);
    });

    it("reads only the team again after a resync, so the seat sync sees what it applied", async () => {
      subs.set("sub_test_1", endedByClosure());
      table.calls.length = 0;
      expect(await worker(sync())).toBe("in_sync");
      expect(updates).toEqual([resumed]);
      expect(reads()).toEqual([...find, team, members]);
      // One that ended: the seat sync sees the ended status the resync applied, and changes nothing
      patchTeam({ stripeResyncFor: CLOSED, status: "active" });
      subs.set("sub_test_1", endedByClosure({ status: "canceled", cancel_at_period_end: false }));
      table.calls.length = 0;
      expect(await worker(sync("membership", "seats-r2"))).toBe("subscription_ended");
      expect(meta()).toMatchObject({ status: "canceled" });
      expect(reads()).toEqual([...find, team]);
      expect(seatUpdates).toEqual([]);
    });

    it("reads the team again after the night's entitlement check, which may have fixed it", async () => {
      patchTeam({ stripeResyncFor: undefined });
      subs.set("sub_test_1", subscription({ status: "active", trial_end: null }));
      table.calls.length = 0;
      // The check applies Stripe's status (its own reads), then the seat sync reads the team again
      expect(await worker(sync("reconcile", "reconcile-r"))).toBe("in_sync");
      expect(counts[BusinessMetric.EntitlementDrift]).toBe(1);
      expect(meta()).toMatchObject({ status: "active" });
      expect(reads()).toEqual([...find, ...find, team, members]);
    });
  });
});

describe("ending a subscription as the team closes (supply-checkout-8jc.30)", () => {
  // Closing queues a seat sync with reason "closed" (account-handler.ts); the purge is the backstop an hour later
  const closing = (id = "seats-close-1"): SeatSyncMessage => ({ kind: "seats", id, customer: CUSTOMER, reason: "closed", created: NOW / 1000 });
  const sync = (id = "seats-reopen-1"): SeatSyncMessage => ({ kind: "seats", id, customer: CUSTOMER, reason: "membership", created: NOW / 1000 });
  const closedAt = new Date(NOW - 60_000).toISOString();
  const setToCancel = (key = "seats-close-1") => ({ id: "sub_test_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: closedAt } }, key: closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1", key) });
  /** The owner reopens the team, as reopenTeam records it. */
  const reopen = (at = NOW) => patchTeam({ closedAt: undefined, stripeResyncFor: closedAt, stripeReopenedAt: new Date(at).toISOString() });

  beforeEach(() => {
    patchTeam({ closedAt, stripeSubscriptionId: "sub_test_1", status: "active", plan: "starter", seats: 3 });
    subs.set("sub_test_1", subscription({ status: "active", trial_end: null }));
  });

  it("sets the team's subscription to cancel at the period's end, stamped with the closure, within the worker role and writing nothing", async () => {
    const before = structuredClone(meta());
    expect(await worker(closing())).toBe("closed_team_ended");
    expect(updates).toEqual([setToCancel()]);
    expect(subs.get("sub_test_1")).toMatchObject({ cancel_at_period_end: true, canceled_at: NOW / 1000, metadata: { [CLOSED_AT_METADATA]: closedAt } });
    expect(counts[BusinessMetric.ClosedTeamSubscriptionsEnded]).toBe(1);
    expect(logs).toContainEqual(["Closed team's subscription ended", { teamId: TEAM, messageId: "seats-close-1", subscriptionId: "sub_test_1", status: "active", action: "cancel_at_period_end" }]);
    expect(logs).toContainEqual(["Seat sync", { messageId: "seats-close-1", reason: "closed", outcome: "closed_team_ended" }]);
    expect(meta()).toEqual(before);
    expect(seatUpdates).toEqual([]);
    expect(denied).toEqual([]);
    // A redelivery, or the hourly purge, finds it already ended for this closure: nothing more is sent
    expect(await worker(closing())).toBe("nothing_to_end");
    expect(await worker(closing("seats-close-2"))).toBe("nothing_to_end");
    expect(updates).toHaveLength(1);
    expect(closingAction(subs.get("sub_test_1") as SubscriptionLike, closedAt)).toBe("none");
    // Stripe's own event for the change finds nothing to do either
    expect(await worker(message("customer.subscription.updated"))).toBe("team_closed");
    expect(updates).toHaveLength(1);
  });

  it("leaves a subscription to cancel at once (unpaid, paused, incomplete) to the purge, and one that's ended or ending alone", async () => {
    for (const status of ["unpaid", "paused", "incomplete"]) {
      subs.set("sub_test_1", subscription({ status }));
      expect(await worker(closing(`seats-${status}`))).toBe("left_to_purge");
    }
    subs.set("sub_test_1", subscription({ status: "canceled" }));
    expect(await worker(closing("seats-canceled"))).toBe("nothing_to_end");
    // The owner's own cancellation (unstamped) isn't stamped
    subs.set("sub_test_1", subscription({ status: "active", cancel_at_period_end: true, canceled_at: NOW / 1000 - DAY_S, metadata: {} }));
    expect(await worker(closing("seats-owners"))).toBe("nothing_to_end");
    expect(cancels).toEqual([]);
    expect(updates).toEqual([]);
    expect(counts[BusinessMetric.ClosedTeamSubscriptionsEnded]).toBeUndefined();
  });

  it("leaves it to the hourly purge, without failing the message, when Stripe can't be reached", async () => {
    stripeDown = true;
    expect(await worker(closing())).toBe("closed_team_deferred");
    expect(logs).toContainEqual(["Closed team's subscription not ended at close: the purge will", { teamId: TEAM, messageId: "seats-close-1", error: "StripeConnectionError" }]);
    expect(updates).toEqual([]);
    expect(counts[BusinessMetric.ClosedTeamSubscriptionsEnded]).toBeUndefined();
  });

  it("leaves it to the hourly purge, without failing the message, when DynamoDB refuses its reads, so the reopen's sync behind it isn't held up", async () => {
    readsFail = true;
    expect(await worker(closing())).toBe("closed_team_deferred");
    expect(logs).toContainEqual(["Closed team's subscription not ended at close: the purge will", expect.objectContaining({ messageId: "seats-close-1", error: "ThrottlingException" })]);
    expect(retrieves).toEqual([]);
    expect(updates).toEqual([]);
    // Once the link is read, a failing team read is deferred too, naming the team
    readsFail = false;
    const original = table.guarded.bind(table);
    table.guarded = (check) =>
      original((command, input) => {
        if (command === "GetCommand" && JSON.stringify(input.Key).includes(`TEAM#${TEAM}`)) throw Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
        return check(command, input);
      });
    expect(await worker(closing("seats-close-2"))).toBe("closed_team_deferred");
    expect(logs).toContainEqual(["Closed team's subscription not ended at close: the purge will", { teamId: TEAM, messageId: "seats-close-2", error: "ThrottlingException" }]);
    expect(updates).toEqual([]);
  });

  it("does nothing for a team reopened before it ran, being purged or gone, with no subscription, or another customer's", async () => {
    patchTeam({ closedAt: undefined });
    expect(await worker(closing())).toBe("team_open");
    patchTeam({ closedAt, purging: new Date(NOW).toISOString() });
    expect(await worker(closing())).toBe("team_closed");
    patchTeam({ purging: undefined, stripeSubscriptionId: undefined });
    expect(await worker(closing())).toBe("no_subscription");
    patchTeam({ stripeSubscriptionId: "sub_test_1", stripeCustomerId: "cus_test_other" });
    expect(await worker(closing())).toBe("not_ours");
    patchTeam({ stripeCustomerId: CUSTOMER });
    expect(await worker({ ...closing(), customer: "cus_test_stranger" })).toBe("unknown_customer");
    expect(retrieves).toEqual([]);
    // The subscription the team names is another customer's: untouched
    subs.set("sub_test_1", subscription({ customer: "cus_test_other" }));
    expect(await worker(closing())).toBe("not_ours");
    table.items.delete(`TEAM#${TEAM}\u0000META`);
    expect(await worker(closing())).toBe("team_gone");
    expect(updates).toEqual([]);
    expect(denied).toEqual([]);
  });

  it("resumes the subscription when the team is reopened right after (the reopen's seat sync, behind the close's on the queue)", async () => {
    expect(await worker(closing())).toBe("closed_team_ended");
    // Reopened in the same second Stripe set it to cancel
    reopen(NOW + 900);
    await worker(sync());
    expect(updates).toEqual([setToCancel(), { id: "sub_test_1", params: { cancel_at_period_end: false, metadata: { [CLOSED_AT_METADATA]: "" } }, key: resumeKey("resync", TEAM, closedAt, "sub_test_1") }]);
    expect(subs.get("sub_test_1")).toMatchObject({ cancel_at_period_end: false, metadata: {} });
    expect(meta()).toMatchObject({ cancelAtPeriodEnd: false, status: "active" });
    expect(meta().stripeResyncFor).toBeUndefined();
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsResumed]).toBe(1);
    expect(denied).toEqual([]);
  });

  it("resumes at once a subscription it set to cancel as the team was reopened, without failing the message", async () => {
    onRetrieve = () => {
      onRetrieve = undefined;
      reopen(NOW - 1000);
    };
    expect(await worker(closing())).toBe("team_reopened");
    expect(updates).toEqual([setToCancel(), { id: "sub_test_1", params: { cancel_at_period_end: false, metadata: { [CLOSED_AT_METADATA]: "" } }, key: resumeKey("worker", TEAM, closedAt, "sub_test_1") }]);
    expect(logs).toContainEqual(["Team reopened while its subscription was being ended: resumed", { teamId: TEAM, messageId: "seats-close-1", subscriptionId: "sub_test_1", action: "cancel_at_period_end" }]);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsResumed]).toBe(1);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsEnded]).toBeUndefined();
    // The reopen's own sync then finds it renewing, and finishes
    await worker(sync());
    expect(updates).toHaveLength(2);
    expect(meta()).toMatchObject({ cancelAtPeriodEnd: false });
    expect(meta().stripeResyncFor).toBeUndefined();
    // When Stripe refuses the resume, a person is alarmed
    patchTeam({ closedAt, stripeResyncFor: undefined });
    onRetrieve = () => {
      onRetrieve = undefined;
      reopen(NOW - 1000);
      refuseResume = true;
    };
    expect(await worker(closing("seats-close-2"))).toBe("team_reopened");
    expect(logs).toContainEqual(["Team reopened while its subscription was being ended", { teamId: TEAM, messageId: "seats-close-2", subscriptionId: "sub_test_1", action: "cancel_at_period_end" }]);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsEnded]).toBe(1);
  });

  it("alarms when the team can't be read again after its subscription was set to end, since it may have been reopened", async () => {
    onUpdate = () => {
      onUpdate = undefined;
      reopen(NOW - 1000);
      readsFail = true;
    };
    expect(await worker(closing())).toBe("unchecked");
    expect(updates).toEqual([setToCancel()]);
    expect(counts[BusinessMetric.ReopenedTeamSubscriptionsEnded]).toBe(1);
    expect(logs).toContainEqual(["Closed team's subscription set to end, but the team wasn't read again", { teamId: TEAM, messageId: "seats-close-1", subscriptionId: "sub_test_1", action: "cancel_at_period_end", error: "ThrottlingException" }]);
    expect(counts[BusinessMetric.ClosedTeamSubscriptionsEnded]).toBeUndefined();
  });

  it("refuses a closed message on the billing queue: only a seat sync can carry one", () => {
    expect(() => parseMessage(JSON.stringify(closing()))).toThrow("Not a billing message");
  });
});

describe("owner notices", () => {
  it("emails each owner once when a trial is ending without a card, and never again on a retry", async () => {
    await worker(message("customer.subscription.trial_will_end", { trialEnd: NOW / 1000 + 3 * DAY_S }));
    expect(mails.sent.map((m) => [m.to, m.input.kind, m.tags])).toEqual([
      ["owner@example.com", "trialEnding", { teamId: TEAM }],
      ["second@example.com", "trialEnding", { teamId: TEAM }],
    ]);
    expect(mails.sent[0]?.input).toMatchObject({ teamName: "Echo Plumbing", trialEndsAt: new Date(NOW + 3 * DAY_S * 1000).toISOString() });
    expect(counts[BusinessMetric.BillingNotices]).toBe(2);
    // Stripe sends it again before it's recorded: the claims stand
    table.items.delete("WEBHOOK#evt_test_1\u0000DONE");
    await worker(message("customer.subscription.trial_will_end", { trialEnd: NOW / 1000 + 3 * DAY_S }));
    expect(mails.sent).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain("example.com");
  });

  it("sends no trial email when there's a card", async () => {
    subs.set("sub_test_1", subscription({ default_payment_method: "pm_test_1" }));
    await worker(message("customer.subscription.trial_will_end"));
    expect(mails.sent).toEqual([]);
  });

  it("emails owners when a payment fails, with the next try", async () => {
    subs.set("sub_test_1", subscription({ status: "past_due" }));
    await worker(message("invoice.payment_failed", { nextAttempt: NOW / 1000 + 3 * DAY_S }));
    expect(mails.sent.map((m) => m.input)).toEqual([
      { kind: "paymentFailed", teamName: "Echo Plumbing", nextAttemptAt: new Date(NOW + 3 * DAY_S * 1000).toISOString() },
      { kind: "paymentFailed", teamName: "Echo Plumbing", nextAttemptAt: new Date(NOW + 3 * DAY_S * 1000).toISOString() },
    ]);
    expect(meta().status).toBe("past_due");
  });

  it("makes the team read-only when a trial ends without a card, and tells its owners", async () => {
    await worker(message("checkout.session.completed", { eventId: "evt_checkout" }));
    subs.set("sub_test_1", subscription({ status: "canceled" }));
    await worker(message("customer.subscription.deleted", { status: "canceled" }));
    expect(meta().status).toBe("canceled");
    expect(mails.sent.map((m) => [m.to, m.input.kind])).toEqual([
      ["owner@example.com", "readOnly"],
      ["second@example.com", "readOnly"],
    ]);
    // Members can read, but nobody can change anything
    const ctx = await authorizeTeam(table.db(TEAM), CREW, TEAM);
    expect(ctx.subscriptionEnded).toBe(true);
    await expect(createProduct(table.db(TEAM), ctx, "gloves", { name: "Gloves", code: "", price: 1 })).rejects.toBeInstanceOf(SubscriptionEndedError);
  });

  it("doesn't call a comped team read-only", async () => {
    patchTeam({ compPlan: "starter", compUntil: new Date(NOW + 30 * DAY_S * 1000).toISOString() });
    subs.set("sub_test_1", subscription({ status: "canceled" }));
    await worker(message("customer.subscription.deleted", { status: "canceled" }));
    expect(meta().status).toBe("canceled");
    expect(mails.sent).toEqual([]);
    expect((await authorizeTeam(table.db(TEAM), CREW, TEAM)).subscriptionEnded).toBe(false);
  });

  it("tells owners when retries run out and the subscription goes unpaid, and not for other changes", async () => {
    subs.set("sub_test_1", subscription({ status: "unpaid" }));
    await worker(message("customer.subscription.updated", { status: "unpaid", previousStatus: "past_due" }));
    // An overdue payment's read-only notice: pay to edit again, and no deletion date (Terms 5.6)
    expect(mails.sent.map((m) => m.input)).toEqual([
      { kind: "readOnly", teamName: "Echo Plumbing", reason: "payment_overdue" },
      { kind: "readOnly", teamName: "Echo Plumbing", reason: "payment_overdue" },
    ]);
    subs.set("sub_test_1", subscription({ status: "active" }));
    await worker(message("customer.subscription.updated", { eventId: "evt_test_2", status: "active", previousStatus: "unpaid" }));
    expect(mails.sent).toHaveLength(2);
  });

  it("counts an owner it couldn't email, and doesn't try again on a retry", async () => {
    patchTeam({});
    table.put({ ...(table.get(`TEAM#${TEAM}`, `MEMBER#${OWNER2}`) as Record<string, unknown>), email: undefined });
    table.put(Object.fromEntries(Object.entries(table.get(`TEAM#${TEAM}`, `MEMBER#${OWNER2}`) as Record<string, unknown>).filter(([, v]) => v !== undefined)));
    mails.state.fail = "MessageRejected";
    subs.set("sub_test_1", subscription({ status: "past_due" }));
    await worker(message("invoice.payment_failed"));
    expect(counts[BusinessMetric.BillingNoticeFailures]).toBe(2);
    expect(logs.find((l) => l[0] === "Billing emails not sent")?.[1]).toMatchObject({ teamId: TEAM, failed: 2, codes: "MessageRejected,NoAddress" });
    mails.state.fail = undefined;
    table.items.delete("WEBHOOK#evt_test_1\u0000DONE");
    await worker(message("invoice.payment_failed"));
    expect(mails.sent).toEqual([]);
  });

  it("decides from the event alone", () => {
    const sub = subscription();
    expect(noticeFor(message("customer.subscription.trial_will_end"), sub, "T")).toMatchObject({ kind: "trialEnding" });
    expect(noticeFor(message("customer.subscription.trial_will_end"), { ...sub, trial_end: null }, "T")).toBeUndefined();
    expect(noticeFor(message("customer.subscription.trial_will_end"), { ...sub, status: "active" }, "T")).toBeUndefined();
    expect(noticeFor(message("invoice.payment_failed"), undefined, "T")).toEqual({ kind: "paymentFailed", teamName: "T" });
    expect(noticeFor(message("customer.subscription.updated", { status: "paused", previousStatus: "trialing" }), sub, "T")).toEqual({ kind: "readOnly", teamName: "T" });
    expect(noticeFor(message("customer.subscription.updated", { status: "canceled", previousStatus: "unpaid" }), sub, "T")).toBeUndefined();
    expect(noticeFor(message("customer.subscription.updated", { status: "canceled" }), sub, "T")).toBeUndefined();
    expect(noticeFor(message("invoice.paid"), sub, "T")).toBeUndefined();
  });
});

describe("the dates the access rules count from (billingAccess, supply-checkout-qdx)", () => {
  const at = (ms: number) => new Date(ms).toISOString();

  it("records when the subscription went past due, keeps it through retries, and removes it once it's paid", async () => {
    subs.set("sub_test_1", subscription({ status: "past_due" }));
    await worker(message("invoice.payment_failed"));
    expect(meta().pastDueSince).toBe(at(NOW));
    // A retry fails three days later: the grace still runs from the first
    build(NOW + 3 * DAY_S * 1000);
    await worker(message("invoice.payment_failed", { eventId: "evt_test_2" }));
    expect(meta().pastDueSince).toBe(at(NOW));
    expect(teamBody(meta() as never, "owner", new Date(NOW + 3 * DAY_S * 1000))).toMatchObject({ subscriptionEnded: false, paymentGraceEndsAt: at(NOW + 7 * DAY_S * 1000), readOnlyReason: null });
    expect(teamBody(meta() as never, "owner", new Date(NOW + 7 * DAY_S * 1000))).toMatchObject({ subscriptionEnded: true, readOnlyReason: "payment_overdue", readOnlyDeletesAt: null, paymentGraceEndsAt: null });
    subs.set("sub_test_1", subscription({ status: "active" }));
    await worker(message("invoice.paid", { eventId: "evt_test_3" }));
    expect(meta().pastDueSince).toBeUndefined();
    expect(denied).toEqual([]);
  });

  it("records when the subscription ended, from Stripe's ended_at, says on /me and in the email when it's deleted, and clears it on a resubscription", async () => {
    const ended = NOW - 2 * DAY_S * 1000;
    subs.set("sub_test_1", subscription({ status: "canceled", ended_at: ended / 1000 }));
    await worker(message("customer.subscription.deleted", { status: "canceled" }));
    expect(meta().subscriptionEndedAt).toBe(at(ended));
    // 30 days on, rounded up to the end of that date everywhere: noon UTC the next day
    const deletesAt = at(deletionTime(ended + 30 * DAY_S * 1000));
    expect(deletesAt.slice(11)).toBe("12:00:00.000Z");
    expect(Date.parse(deletesAt)).toBeGreaterThan(ended + 30 * DAY_S * 1000);
    expect(mails.sent.map((m) => m.input)).toEqual([
      { kind: "readOnly", teamName: "Echo Plumbing", reason: "subscription_ended", deletesAt },
      { kind: "readOnly", teamName: "Echo Plumbing", reason: "subscription_ended", deletesAt },
    ]);
    expect(teamBody(meta() as never, "owner", new Date(NOW))).toMatchObject({ subscriptionEnded: true, readOnlyReason: "subscription_ended", readOnlyDeletesAt: deletesAt, readOnlyLastDay: at(ended + 30 * DAY_S * 1000).slice(0, 10) });
    // Once that's passed (the job closes it once its warning's 7 days are up): no date in the past to show
    expect(teamBody(meta() as never, "owner", new Date(Date.parse(deletesAt)))).toMatchObject({ readOnlyDeletesAt: deletesAt, readOnlyLastDay: null });
    // Subscribed again: a new subscription replaces the ended one
    subs.set("sub_test_2", subscription({ id: "sub_test_2", status: "active" }));
    await worker(message("customer.subscription.created", { eventId: "evt_test_2", subscription: "sub_test_2" }));
    expect(meta()).toMatchObject({ status: "active", stripeSubscriptionId: "sub_test_2" });
    expect(meta().subscriptionEndedAt).toBeUndefined();
    expect(denied).toEqual([]);
  });

  it("never lets an older ended subscription replace the team's ended one and pull its deletion date in, but takes a later one", async () => {
    const recorded = NOW - 2 * DAY_S * 1000;
    patchTeam({ status: "canceled", stripeSubscriptionId: "sub_test_2", subscriptionEndedAt: at(recorded) });
    // A late or replayed event for the team's earlier subscription, which ended 40 days ago
    subs.set("sub_test_1", subscription({ status: "canceled", ended_at: (NOW - 40 * DAY_S * 1000) / 1000 }));
    expect(await worker(message("customer.subscription.deleted", { status: "canceled" }))).toBe("ignored");
    expect(meta()).toMatchObject({ stripeSubscriptionId: "sub_test_2", subscriptionEndedAt: at(recorded) });
    expect(mails.sent).toEqual([]);
    // Ended at the same time: still the team's own
    subs.set("sub_test_1", subscription({ status: "canceled", ended_at: recorded / 1000 }));
    expect(await worker(message("customer.subscription.deleted", { eventId: "evt_test_2", status: "canceled" }))).toBe("ignored");
    // One that ended later replaces it, with its later date
    subs.set("sub_test_1", subscription({ status: "canceled", ended_at: (NOW - DAY_S * 1000) / 1000 }));
    expect(await worker(message("customer.subscription.deleted", { eventId: "evt_test_3", status: "canceled" }))).toBe("applied");
    expect(meta()).toMatchObject({ stripeSubscriptionId: "sub_test_1", subscriptionEndedAt: at(NOW - DAY_S * 1000) });
    expect(denied).toEqual([]);
  });

  it("decides an older ended subscription only from dates it has", () => {
    const team = { stripeSubscriptionId: "sub_test_2", status: "canceled", subscriptionEndedAt: at(NOW) };
    const old = subscription({ status: "canceled", ended_at: NOW / 1000 - DAY_S });
    expect(endedEarlier(old, team)).toBe(true);
    expect(endedEarlier({ ...old, ended_at: null }, team)).toBe(false);
    expect(endedEarlier(old, { ...team, subscriptionEndedAt: undefined })).toBe(false);
    expect(endedEarlier(old, { ...team, status: "active" })).toBe(false);
    expect(endedEarlier({ ...old, status: "active" }, team)).toBe(false);
    expect(endedEarlier({ ...old, id: "sub_test_2" }, team)).toBe(false);
    expect(endedEarlier(old, { ...team, stripeSubscriptionId: undefined })).toBe(false);
  });

  it("never dates an unpaid subscription for deletion: it's an overdue payment, read-only until paid", async () => {
    subs.set("sub_test_1", subscription({ status: "unpaid", ended_at: null }));
    await worker(message("customer.subscription.updated", { status: "unpaid", previousStatus: "past_due" }));
    expect(meta().subscriptionEndedAt).toBeUndefined();
    expect(meta().pastDueSince).toBeUndefined();
    expect(teamBody(meta() as never, "owner", new Date(NOW))).toMatchObject({ subscriptionEnded: true, readOnlyReason: "payment_overdue", readOnlyDeletesAt: null });
    // Stripe cancels it once its retries all fail: then the 30 days start
    subs.set("sub_test_1", subscription({ status: "canceled", ended_at: NOW / 1000 }));
    await worker(message("customer.subscription.deleted", { eventId: "evt_test_2", status: "canceled" }));
    expect(meta().subscriptionEndedAt).toBe(at(NOW));
    expect(teamBody(meta() as never, "owner", new Date(NOW))).toMatchObject({ readOnlyReason: "subscription_ended", readOnlyDeletesAt: at(deletionTime(NOW + 30 * DAY_S * 1000)) });
  });

  it("never takes an unpaid subscription for an older ended one", () => {
    const team = { stripeSubscriptionId: "sub_test_2", status: "canceled", subscriptionEndedAt: at(NOW) };
    expect(endedEarlier(subscription({ status: "unpaid", ended_at: NOW / 1000 - DAY_S }), team)).toBe(false);
    // An over one never replaces a stored unpaid one, whenever it ended; a live one can
    const unpaid = { ...team, status: "unpaid", subscriptionEndedAt: undefined };
    expect(endedEarlier(subscription({ status: "canceled", ended_at: NOW / 1000 - DAY_S }), unpaid)).toBe(true);
    expect(endedEarlier(subscription({ status: "incomplete_expired", ended_at: NOW / 1000 + DAY_S }), unpaid)).toBe(true);
    expect(endedEarlier(subscription({ status: "active" }), unpaid)).toBe(false);
  });

  it("keeps a team's unpaid subscription when an older canceled one's event arrives, and takes a resubscription", async () => {
    patchTeam({ status: "unpaid", stripeSubscriptionId: "sub_test_2" });
    subs.set("sub_test_2", subscription({ id: "sub_test_2", status: "unpaid" }));
    subs.set("sub_test_1", subscription({ status: "canceled", ended_at: (NOW - 40 * DAY_S * 1000) / 1000 }));
    expect(await worker(message("customer.subscription.deleted", { status: "canceled" }))).toBe("ignored");
    expect(meta()).toMatchObject({ status: "unpaid", stripeSubscriptionId: "sub_test_2" });
    expect(meta().subscriptionEndedAt).toBeUndefined();
    expect(processed()).toMatchObject({ eventId: "evt_test_1" });
    expect(mails.sent).toEqual([]);
    expect(teamBody(meta() as never, "owner", new Date(NOW))).toMatchObject({ readOnlyReason: "payment_overdue", readOnlyDeletesAt: null });
    // The owner subscribes again
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active" }));
    expect(await worker(message("customer.subscription.created", { eventId: "evt_test_2", subscription: "sub_test_3" }))).toBe("applied");
    expect(meta()).toMatchObject({ status: "active", stripeSubscriptionId: "sub_test_3" });
    expect(teamBody(meta() as never, "owner", new Date(NOW))).toMatchObject({ subscriptionEnded: false });
    expect(denied).toEqual([]);
  });

  it("sends no deletion date for a team with no date it ended (an ended team never applied with one)", async () => {
    patchTeam({ status: "canceled", stripeSubscriptionId: "sub_test_1" });
    expect(teamBody(meta() as never, "owner", new Date(NOW))).toMatchObject({ subscriptionEnded: true, readOnlyReason: "subscription_ended", readOnlyDeletesAt: null });
  });
});

describe("resubscribing an unpaid team (supply-checkout-8jc.44)", () => {
  /** A team whose subscription (sub_test_2) went unpaid, with its overdue invoice, an older paid one, and invoices it must never touch. */
  function unpaidTeam() {
    patchTeam({ status: "unpaid", stripeSubscriptionId: "sub_test_2", plan: "starter", seats: 3 });
    subs.set("sub_test_2", subscription({ id: "sub_test_2", status: "unpaid" }));
    invoices.set("in_test_overdue", { subscription: "sub_test_2", customer: CUSTOMER, status: "open" });
    invoices.set("in_test_paid", { subscription: "sub_test_2", customer: CUSTOMER, status: "paid" });
    invoices.set("in_test_foreign", { subscription: "sub_test_2", customer: "cus_test_other", status: "open" });
    invoices.set("in_test_other_sub", { subscription: "sub_test_9", customer: CUSTOMER, status: "open" });
  }
  const resubscribe = (eventId = "evt_test_2", type: BillingMessage["type"] = "checkout.session.completed") => worker(message(type, { eventId, subscription: "sub_test_3" }));
  const cleared = () => logs.filter(([line]) => line === "Replaced unpaid subscription cleared").map(([, data]) => data);

  it("cancels the unpaid subscription and voids its open invoices, then the team takes the new one", async () => {
    unpaidTeam();
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active" }));
    expect(await resubscribe()).toBe("applied");
    expect(cancels).toEqual([{ id: "sub_test_2", key: cancelReplacedKey("sub_test_2") }]);
    // Only the customer's own open invoice of that subscription
    expect(voids).toEqual([{ id: "in_test_overdue", key: voidReplacedKey("in_test_overdue") }]);
    expect(invoices.get("in_test_paid")?.status).toBe("paid");
    expect(invoices.get("in_test_foreign")?.status).toBe("open");
    expect(invoices.get("in_test_other_sub")?.status).toBe("open");
    expect(invoiceListings).toEqual([{ subscription: "sub_test_2", status: "open", limit: 100 }]);
    expect(meta()).toMatchObject({ status: "active", stripeSubscriptionId: "sub_test_3" });
    expect(teamBody(meta() as never, "owner", new Date(NOW))).toMatchObject({ subscriptionEnded: false });
    expect(cleared()).toEqual([{ teamId: TEAM, eventId: "evt_test_2", subscriptionId: "sub_test_2", status: "unpaid", canceled: true, voided: 1, refused: 0, by: "sub_test_3" }]);
    expect(denied).toEqual([]);
    // A replay, and the new subscription's other events, clear nothing again
    expect(await resubscribe()).toBe("duplicate");
    expect(await resubscribe("evt_test_3", "invoice.paid")).toBe("applied");
    // Nor does the old one's own deletion event, which changes nothing on the team and emails no one
    expect(await worker(message("customer.subscription.deleted", { eventId: "evt_test_4", subscription: "sub_test_2", status: "canceled" }))).not.toBe("applied");
    expect(cancels).toHaveLength(1);
    expect(voids).toHaveLength(1);
    expect(meta()).toMatchObject({ status: "active", stripeSubscriptionId: "sub_test_3" });
    expect(mails.sent).toEqual([]);
  });

  it("waits for an incomplete resubscription to be paid before it replaces the unpaid one, and keeps the unpaid one if it expires", async () => {
    unpaidTeam();
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "incomplete" }));
    expect(await resubscribe()).toBe("ignored");
    expect(processed("evt_test_2")).toBeDefined();
    expect(cancels).toEqual([]);
    expect(voids).toEqual([]);
    expect(meta()).toMatchObject({ status: "unpaid", stripeSubscriptionId: "sub_test_2" });
    expect(logs).toContainEqual(["Resubscription not live yet: the team keeps its unpaid subscription", { teamId: TEAM, eventId: "evt_test_2", subscriptionId: "sub_test_3", status: "incomplete", kept: "sub_test_2" }]);
    // It expires: the team is still overdue on the unpaid one, never dated for deletion, and nothing was cancelled
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "incomplete_expired", ended_at: NOW / 1000 }));
    expect(await resubscribe("evt_test_3", "customer.subscription.updated")).toBe("ignored");
    expect(meta()).toMatchObject({ status: "unpaid", stripeSubscriptionId: "sub_test_2" });
    expect(teamBody(meta() as never, "owner", new Date(NOW))).toMatchObject({ readOnlyReason: "payment_overdue", readOnlyDeletesAt: null });
    expect(cancels).toEqual([]);
    expect(invoices.get("in_test_overdue")?.status).toBe("open");
  });

  it("clears the unpaid one once the incomplete resubscription is paid", async () => {
    unpaidTeam();
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "incomplete" }));
    expect(await resubscribe()).toBe("ignored");
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active" }));
    expect(await resubscribe("evt_test_3", "customer.subscription.updated")).toBe("applied");
    expect(cancels).toEqual([{ id: "sub_test_2", key: cancelReplacedKey("sub_test_2") }]);
    expect(voids.map((v) => v.id)).toEqual(["in_test_overdue"]);
    expect(meta()).toMatchObject({ status: "active", stripeSubscriptionId: "sub_test_3" });
  });

  it("retries after a failure without cancelling twice, even once Stripe has forgotten the request, and voids what's left", async () => {
    unpaidTeam();
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active" }));
    voidFails = true;
    await expect(resubscribe()).rejects.toThrow("Stripe is down");
    // Cancelled, but the team still names it and the event isn't recorded, so the retry finds it
    expect(cancels).toHaveLength(1);
    expect(meta()).toMatchObject({ status: "unpaid", stripeSubscriptionId: "sub_test_2" });
    expect(processed("evt_test_2")).toBeUndefined();
    voidFails = false;
    // Past Stripe's 24 hours: the keys are new again, and the status check alone keeps it from cancelling twice
    stripeKeys.clear();
    expect(await resubscribe()).toBe("applied");
    expect(cancels).toHaveLength(1);
    expect(voids.map((v) => v.id)).toEqual(["in_test_overdue"]);
    expect(cleared().at(-1)).toMatchObject({ subscriptionId: "sub_test_2", status: "canceled", canceled: false, voided: 1 });
    expect(meta()).toMatchObject({ status: "active", stripeSubscriptionId: "sub_test_3" });
  });

  it("voids every open invoice, page by page", async () => {
    unpaidTeam();
    invoices.set("in_test_overdue_2", { subscription: "sub_test_2", customer: CUSTOMER, status: "open" });
    invoices.set("in_test_overdue_3", { subscription: "sub_test_2", customer: CUSTOMER, status: "open" });
    invoicePage = 2;
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active" }));
    expect(await resubscribe()).toBe("applied");
    expect(voids.map((v) => v.id)).toEqual(["in_test_overdue", "in_test_overdue_2", "in_test_overdue_3"]);
    expect(invoiceListings.map((l) => l.starting_after)).toEqual([undefined, "in_test_foreign"]);
  });

  it("treats a resubscription as a second subscription when the unpaid one was paid meanwhile", async () => {
    unpaidTeam();
    // The overdue invoice was paid in the Customer Portal, and its event hasn't been applied yet
    subs.set("sub_test_2", subscription({ id: "sub_test_2", status: "active" }));
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active" }));
    expect(await resubscribe()).toBe("second_subscription_canceled");
    expect(cancels).toEqual([{ id: "sub_test_3", key: `cancel-second-${"sub_test_3"}` }]);
    expect(voids).toEqual([]);
    expect(meta()).toMatchObject({ stripeSubscriptionId: "sub_test_2" });
  });

  it("clears an unpaid one Stripe has that the team hasn't heard of yet, and never another customer's", async () => {
    // The team still records it active: the event that it went unpaid hasn't been applied
    unpaidTeam();
    patchTeam({ status: "active" });
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active" }));
    expect(await resubscribe()).toBe("applied");
    expect(cancels.map((c) => c.id)).toEqual(["sub_test_2"]);
    expect(voids.map((v) => v.id)).toEqual(["in_test_overdue"]);
    // Another customer's subscription, recorded on the team by mistake, is replaced but never touched
    patchTeam({ status: "unpaid", stripeSubscriptionId: "sub_test_5" });
    subs.set("sub_test_5", subscription({ id: "sub_test_5", status: "unpaid", customer: { id: "cus_test_other" } }));
    invoices.set("in_test_5", { subscription: "sub_test_5", customer: "cus_test_other", status: "open" });
    expect(await resubscribe("evt_test_3", "invoice.paid")).toBe("applied");
    expect(cancels).toHaveLength(1);
    expect(invoices.get("in_test_5")?.status).toBe("open");
    expect(meta()).toMatchObject({ stripeSubscriptionId: "sub_test_3" });
  });

  it("never writes the old debt off for a trial: the team stays on its unpaid subscription until the new one is paid", async () => {
    unpaidTeam();
    // Trying to game it: a trial (Checkout gives such a team none, but one made another way) is not a payment
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "trialing" }));
    expect(await resubscribe()).toBe("ignored");
    // Its trial's $0 invoice is paid, and then the first real one fails: still nothing paid
    invoices.set("in_test_trial", { subscription: "sub_test_3", customer: CUSTOMER, status: "paid", amount_paid: 0 });
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "past_due" }));
    expect(await resubscribe("evt_test_3", "customer.subscription.updated")).toBe("ignored");
    expect(cancels).toEqual([]);
    expect(voids).toEqual([]);
    expect(invoices.get("in_test_overdue")?.status).toBe("open");
    expect(meta()).toMatchObject({ status: "unpaid", stripeSubscriptionId: "sub_test_2" });
    expect(teamBody(meta() as never, "owner", new Date(NOW))).toMatchObject({ subscriptionEnded: true, readOnlyReason: "payment_overdue" });
    // Once one of its invoices takes money, past_due is a paid subscription, and the old debt is written off
    invoices.set("in_test_first", { subscription: "sub_test_3", customer: CUSTOMER, status: "paid", amount_paid: 900 });
    expect(await resubscribe("evt_test_4", "invoice.paid")).toBe("applied");
    expect(cancels.map((c) => c.id)).toEqual(["sub_test_2"]);
    expect(voids.map((v) => v.id)).toEqual(["in_test_overdue"]);
    expect(meta()).toMatchObject({ status: "past_due", stripeSubscriptionId: "sub_test_3" });
  });

  it("takes the paid replacement, not the old one's end, when clearing failed and the old one's end arrives", async () => {
    unpaidTeam();
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active", created: NOW / 1000 }));
    voidFails = true;
    // The resubscription's event fails after the cancel (and, retried, goes to the dead-letter queue)
    await expect(resubscribe()).rejects.toThrow("Stripe is down");
    expect(subs.get("sub_test_2")?.status).toBe("canceled");
    expect(meta()).toMatchObject({ status: "unpaid", stripeSubscriptionId: "sub_test_2" });
    // The old one's end, for the subscription the team still names: while Stripe still fails, it fails too, starting nothing
    subs.set("sub_test_2", { ...(subs.get("sub_test_2") as SubscriptionLike), ended_at: NOW / 1000 });
    const ended = () => worker(message("customer.subscription.deleted", { eventId: "evt_test_9", subscription: "sub_test_2", status: "canceled" }));
    await expect(ended()).rejects.toThrow("Stripe is down");
    expect(meta()).toMatchObject({ status: "unpaid", stripeSubscriptionId: "sub_test_2" });
    voidFails = false;
    expect(await ended()).toBe("applied");
    expect(meta()).toMatchObject({ status: "active", stripeSubscriptionId: "sub_test_3" });
    expect(meta().subscriptionEndedAt).toBeUndefined();
    expect(voids.map((v) => v.id)).toEqual(["in_test_overdue"]);
    expect(cancels).toHaveLength(1);
    // No read-only email: the team isn't
    expect(mails.sent).toEqual([]);
  });

  it("applies the team's own subscription's end as before when nothing paid replaced it, and retries when Stripe can't list", async () => {
    unpaidTeam();
    // A trial isn't a paid replacement, and another customer's never counts
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "trialing" }));
    subs.set("sub_test_4", subscription({ id: "sub_test_4", status: "active", customer: { id: "cus_test_other" } }));
    subs.set("sub_test_2", subscription({ id: "sub_test_2", status: "canceled", ended_at: NOW / 1000 }));
    listFails = true;
    const ended = () => worker(message("customer.subscription.deleted", { eventId: "evt_test_9", subscription: "sub_test_2", status: "canceled" }));
    await expect(ended()).rejects.toThrow("Stripe is down");
    listFails = false;
    expect(await ended()).toBe("applied");
    expect(meta()).toMatchObject({ status: "canceled", stripeSubscriptionId: "sub_test_2", subscriptionEndedAt: new Date(NOW).toISOString() });
  });

  it("logs an invoice Stripe refuses to void, for a person, and carries on", async () => {
    unpaidTeam();
    invoices.set("in_test_overdue_2", { subscription: "sub_test_2", customer: CUSTOMER, status: "open" });
    refuseVoid.add("in_test_overdue");
    subs.set("sub_test_3", subscription({ id: "sub_test_3", status: "active" }));
    expect(await resubscribe()).toBe("applied");
    expect(voids.map((v) => v.id)).toEqual(["in_test_overdue_2"]);
    expect(logs).toContainEqual([
      "Replaced unpaid subscription's invoice not voided: void it by hand",
      { teamId: TEAM, eventId: "evt_test_2", subscriptionId: "sub_test_2", invoiceId: "in_test_overdue", type: "StripeInvalidRequestError", code: "invoice_not_editable", status: 400, requestId: "req_test_1" },
    ]);
    expect(cleared()).toEqual([expect.objectContaining({ voided: 1, refused: 1 })]);
    expect(meta()).toMatchObject({ status: "active", stripeSubscriptionId: "sub_test_3" });
  });

  it("decides which old subscriptions to clear", () => {
    expect(unpaidToClear({ status: "unpaid" }, "active")).toBe(true);
    expect(unpaidToClear({ status: "canceled" }, "unpaid")).toBe(true);
    expect(unpaidToClear({ status: "canceled" }, "canceled")).toBe(false);
    expect(unpaidToClear({ status: "incomplete_expired" }, "unpaid")).toBe(false);
    expect(unpaidToClear({ status: "active" }, "unpaid")).toBe(false);
  });
});

describe("what the API says about an ended subscription", () => {
  it("shows it on /me, unless a comp keeps the team going, and refuses writes with its own reason", async () => {
    const team = { ...(table.get(`TEAM#${TEAM}`, "META") as Record<string, unknown>), status: "canceled", createdAt: "2026-09-01T00:00:00.000Z" } as never;
    expect(teamBody(team, "owner", new Date(NOW)).subscriptionEnded).toBe(true);
    expect(teamBody({ ...(team as object), compPlan: "starter", compUntil: new Date(NOW + DAY_S * 1000).toISOString() } as never, "owner", new Date(NOW)).subscriptionEnded).toBe(false);
    expect(teamBody({ ...(team as object), status: "past_due" } as never, "owner", new Date(NOW)).subscriptionEnded).toBe(false);
    expect(errorFor(new SubscriptionEndedError("x"))).toMatchObject({ status: 403, code: "permission_denied", reason: "subscription_ended" });
  });
});

describe("canceling in the Customer Portal", () => {
  const periodEnd = new Date(NOW + 20 * DAY_S * 1000).toISOString();
  const body = () => teamBody(meta() as never, "owner", new Date(NOW));

  it("records a cancellation at the period's end, shows when it ends on /me, and clears it when the owner renews", async () => {
    subs.set("sub_test_1", subscription({ status: "active", trial_end: null, cancel_at_period_end: true, cancel_at: NOW / 1000 + 20 * DAY_S, items: { data: [{ quantity: 3, current_period_end: NOW / 1000 + 20 * DAY_S, price: { lookup_key: "supply_checkout_starter_monthly", recurring: { interval: "month" } } }] } }));
    expect(await worker(message("customer.subscription.updated"))).toBe("applied");
    expect(meta()).toMatchObject({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd });
    expect(body()).toMatchObject({ billingAccount: true, cancelsAt: periodEnd, subscriptionEnded: false });
    // Still paying until then: no read-only email
    expect(mails.sent).toEqual([]);
    // Renewed ("Don't cancel" in the portal)
    subs.set("sub_test_1", { ...(subs.get("sub_test_1") as SubscriptionLike), cancel_at_period_end: false, cancel_at: null });
    await worker(message("customer.subscription.updated", { eventId: "evt_test_2", created: NOW / 1000 + 1 }));
    expect(meta().cancelAtPeriodEnd).toBe(false);
    expect(body().cancelsAt).toBeNull();
  });

  it("counts a cancellation Stripe schedules by date alone as not renewing", async () => {
    subs.set("sub_test_1", subscription({ status: "active", cancel_at_period_end: false, cancel_at: NOW / 1000 + 13 * DAY_S }));
    await worker(message("customer.subscription.updated"));
    expect(meta().cancelAtPeriodEnd).toBe(true);
  });

  it("makes the team read-only when the period ends, and /me stops saying when it ends", async () => {
    subs.set("sub_test_1", subscription({ status: "canceled", cancel_at_period_end: true }));
    await worker(message("customer.subscription.deleted"));
    expect(meta()).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true });
    expect(body()).toMatchObject({ subscriptionEnded: true, cancelsAt: null, billingAccount: true });
    expect(mails.sent.length).toBeGreaterThan(0);
  });

  it("says nothing on /me without a Stripe customer or a period end", () => {
    const team = { ...(meta() as object), cancelAtPeriodEnd: true, currentPeriodEnd: undefined, stripeCustomerId: undefined, status: "active" } as never;
    expect(teamBody(team, "owner", new Date(NOW))).toMatchObject({ billingAccount: false, cancelsAt: null });
  });
});

describe("a team whose subscription ended", () => {
  it("still lets a member keep their email current and an owner link the customer to subscribe again, and nothing else", async () => {
    patchTeam({ status: "canceled" });
    const owner = await authorizeTeam(table.db(TEAM), OWNER, TEAM);
    expect(owner.subscriptionEnded).toBe(true);
    expect(await setOwnMemberEmail(table.db(TEAM), owner, "new@example.com")).toBe(true);
    await expect(linkStripeCustomer(table.guarded(() => true), owner, CUSTOMER)).resolves.toBeUndefined();
    await expect(createInvite(table.db(TEAM), owner, { email: "x@example.com", role: "viewer" })).rejects.toBeInstanceOf(SubscriptionEndedError);
  });
});

describe("messages and state", () => {
  it("parses only well-formed billing messages", () => {
    const good = message("invoice.paid");
    expect(parseMessage(JSON.stringify(good))).toEqual(good);
    // Only the fields it checked come back (supply-checkout-8jc.21)
    const full = { ...good, status: "active", previousStatus: "trialing", trialEnd: 1, nextAttempt: 2 };
    expect(parseMessage(JSON.stringify({ ...full, extra: "dropped", id: "x", reason: "reconcile" }))).toEqual(full);
    for (const bad of [
      { ...good, eventId: "evt#1" },
      { ...good, customer: 7 },
      { ...good, type: "customer.created" },
      { ...good, created: "now" },
      { ...good, subscription: "sub/1" },
      // Never a seat sync in disguise: the worker tells them apart by `kind`
      { ...good, kind: "seats" },
      { ...good, kind: undefined, status: 1 },
      { ...good, previousStatus: false },
      { ...good, trialEnd: "soon" },
      { ...good, nextAttempt: "later" },
      [good],
      null,
    ]) {
      expect(() => parseMessage(JSON.stringify(bad))).toThrow("Not a billing message");
    }
    expect(() => parseMessage("not json")).toThrow();
  });

  it("reads a subscription with no items as no seats and no period end", () => {
    expect(subscriptionState({ ...subscription(), items: { data: [] } }, CUSTOMER)).toEqual({ customerId: CUSTOMER, subscriptionId: "sub_test_1", seats: 0, status: "trialing", cancelAtPeriodEnd: false });
  });
});

describe("the SQS handler", () => {
  const record = (id: string, group: string, body: string) => ({ messageId: id, body, attributes: { MessageGroupId: group } }) as unknown as SQSEvent["Records"][number];

  it("reports a failed message and every later one in its group, and carries on with other groups", async () => {
    const seen: string[] = [];
    const handler = createWorkerHandler(async (m) => {
      const id = "kind" in m ? m.id : m.eventId;
      seen.push(id);
      if (id === "evt_2") throw new Error("boom");
    }, obs());
    const body = (eventId: string, customer: string) => JSON.stringify(message("invoice.paid", { eventId, customer }));
    const result = await handler({ Records: [record("m1", "cus_a", body("evt_1", "cus_a")), record("m2", "cus_b", body("evt_2", "cus_b")), record("m3", "cus_b", body("evt_3", "cus_b")), record("m4", "cus_a", body("evt_4", "cus_a")), record("m5", "cus_c", "junk")] });
    expect(seen).toEqual(["evt_1", "evt_2", "evt_4"]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m2" }, { itemIdentifier: "m3" }, { itemIdentifier: "m5" }]);
    expect(logs.filter((l) => l[0] === "Billing event failed").map((l) => l[1])).toEqual([{ messageId: "m2", code: "Error" }, { messageId: "m5", code: "SyntaxError" }]);
  });
});

describe("workerScopedDbs", () => {
  it("tags each session with the event, the customer and the team (or the unused marker)", async () => {
    const calls: AssumeRoleCommand["input"][] = [];
    const sts = {
      send: vi.fn(async (command: AssumeRoleCommand) => {
        calls.push(command.input);
        return { Credentials: { AccessKeyId: "AK", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(Date.now() + 3600_000) } };
      }),
    };
    const dbFor = workerScopedDbs({ roleArn: "role", env: { AWS_REGION: REGION, TABLE_NAME: "app" }, sts });
    const creds = (db: ReturnType<typeof dbFor>) => (connection(db).client.config.credentials as () => Promise<unknown>)();
    await creds(dbFor({ eventId: "evt_1", stripeCustomer: CUSTOMER }));
    await creds(dbFor({ eventId: "evt_1", stripeCustomer: CUSTOMER, teamId: TEAM }));
    expect(calls.map((c) => c.Tags)).toEqual([
      [{ Key: "eventId", Value: "evt_1" }, { Key: "stripeCustomer", Value: CUSTOMER }, { Key: "teamId", Value: "." }],
      [{ Key: "eventId", Value: "evt_1" }, { Key: "stripeCustomer", Value: CUSTOMER }, { Key: "teamId", Value: TEAM }],
    ]);
    expect(() => dbFor({ eventId: "evt#1", stripeCustomer: CUSTOMER })).toThrow("Invalid event ID");
    expect(() => dbFor({ eventId: "evt_1", stripeCustomer: "" })).toThrow("Invalid Stripe customer ID");
    expect(() => dbFor({ eventId: "evt_1", stripeCustomer: CUSTOMER, teamId: "TEAM#x" })).toThrow("Invalid team ID");
    expect(workerScopedDbs({ roleArn: "role", env: { AWS_REGION: REGION, TABLE_NAME: "app" } })({ eventId: "e", stripeCustomer: "c" }).tableName).toBe("app");
  });
});

describe("a test team (supply-checkout-o60.12)", () => {
  // The mark (the META item's `test`, exactly true) changes nothing the worker does, only its metrics'
  // metadata: count() then skips the activity ones (TEST_SKIPPED_METRICS) and still sends the rest
  const tags = () => lines.map(([metric, , metadata]) => [metric, metadata.test]);
  const sent = () => lines.filter(([metric, , metadata]) => !skippedForTest(metric, metadata)).map(([metric]) => metric);

  it.each([
    ["a customer's team", undefined, undefined],
    ["a test team", true, true],
    ["a mark that isn't exactly true", "true", undefined],
  ])("applies events and emails owners the same for %s", async (_, mark, tagged) => {
    patchTeam({ test: mark });
    // An owner with no address on file: a notice failure
    table.put({ ...(table.get(`TEAM#${TEAM}`, `MEMBER#${OWNER2}`) as Record<string, unknown>), email: undefined });
    expect(await worker(message("checkout.session.completed"))).toBe("applied");
    expect(await worker(message("invoice.payment_failed", { eventId: "evt_test_2", nextAttempt: NOW / 1000 + DAY_S }))).toBe("applied");
    expect(meta()).toMatchObject({ plan: "starter", seats: 3, status: "trialing", stripeSubscriptionId: "sub_test_1" });
    expect(meta().test).toBe(mark);
    expect(mails.sent.map((m) => [m.to, m.input.kind])).toEqual([["owner@example.com", "paymentFailed"]]);
    expect(tags()).toEqual([
      [BusinessMetric.BillingEventsApplied, tagged],
      [BusinessMetric.BillingEventsApplied, tagged],
      [BusinessMetric.BillingNotices, tagged],
      [BusinessMetric.BillingNoticeFailures, tagged],
    ]);
    expect(sent()).toEqual(tagged ? [BusinessMetric.BillingNoticeFailures] : lines.map(([metric]) => metric));
    expect(denied).toEqual([]);
  });

  it("ends a closed test team's subscription the same, tagged", async () => {
    const closedAt = new Date(NOW - DAY_S * 1000).toISOString();
    patchTeam({ closedAt, test: true });
    expect(await worker(message("checkout.session.completed"))).toBe("team_closed");
    expect(updates).toEqual([{ id: "sub_test_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: closedAt } }, key: closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1", "evt_test_1") }]);
    expect(lines).toEqual([[BusinessMetric.ClosedTeamSubscriptionsEnded, 1, { teamId: TEAM, action: "cancel_at_period_end", test: true }]]);
    expect(sent()).toEqual([]);
  });

  it("tags a reopened subscription ended while it was being ended, which is still sent", async () => {
    const closedAt = new Date(NOW - DAY_S * 1000).toISOString();
    patchTeam({ closedAt, test: true });
    // Reopened and closed again while Stripe was asked
    onUpdate = () => patchTeam({ closedAt: new Date(NOW).toISOString() });
    await expect(worker(message("checkout.session.completed"))).rejects.toThrow();
    expect(lines).toEqual([[BusinessMetric.ReopenedTeamSubscriptionsEnded, 1, { teamId: TEAM, action: "cancel_at_period_end", test: true }]]);
    expect(sent()).toEqual([BusinessMetric.ReopenedTeamSubscriptionsEnded]);
  });

  it("tags the nightly resync of a reopened test team, late and resumed, both still sent", async () => {
    const closed = new Date(NOW - 3 * DAY_S * 1000).toISOString();
    patchTeam({ plan: "starter", seats: 3, status: "trialing", stripeSubscriptionId: "sub_test_1", cancelAtPeriodEnd: false, stripeResyncFor: closed, stripeReopenedAt: new Date(NOW - DAY_S * 1000).toISOString(), test: true });
    subs.set("sub_test_1", subscription({ status: "active", trial_end: null, cancel_at_period_end: true, canceled_at: NOW / 1000 - 2 * DAY_S, metadata: { [CLOSED_AT_METADATA]: closed } }));
    expect(await worker({ kind: "seats", id: "reconcile-2026-09-27-cus_test_1", customer: CUSTOMER, reason: "reconcile", created: NOW / 1000 })).toBe("in_sync");
    expect(meta().stripeResyncFor).toBeUndefined();
    expect(lines).toEqual([
      [BusinessMetric.ReopenResyncsLate, 1, { teamId: TEAM, test: true }],
      [BusinessMetric.ReopenedTeamSubscriptionsResumed, 1, { teamId: TEAM, source: "resync", test: true }],
    ]);
    expect(sent()).toEqual([BusinessMetric.ReopenResyncsLate, BusinessMetric.ReopenedTeamSubscriptionsResumed]);
    expect(denied).toEqual([]);
  });
});
