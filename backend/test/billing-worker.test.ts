// The billing worker (src/billing/worker.ts) against the in-memory table, with
// each event's handles passing only what the billing-worker role allows
// (test/billing-policy.ts), and a fake Stripe. test/billing-ddb.test.ts runs
// the data functions' conditions against DynamoDB Local.

import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import type { SQSEvent } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingMessage } from "../src/billing/webhook-handler.js";
import { CLOSED_AT_METADATA, closingKey, resumeKey } from "../src/billing/closing.js";
import type { EntitlementStripe } from "../src/billing/entitlements.js";
import type { SeatStripe, SeatSubscription } from "../src/billing/seats.js";
import { createBillingWorker, noticeFor, parseMessage, type SubscriptionLike, subscriptionState, type WorkerStripe } from "../src/billing/worker.js";
import { workerScopedDbs, type WorkerScope } from "../src/billing/worker-db.js";
import { createWorkerHandler } from "../src/billing/worker-handler.js";
import { teamBody } from "../src/api/account-handler.js";
import { errorFor } from "../src/api/data-handler.js";
import { connection } from "../src/data/client.js";
import { authorizeTeam, createInvite, createProduct, linkStripeCustomer, setOwnMemberEmail, SubscriptionEndedError } from "../src/data/index.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { workerPolicy } from "./billing-policy.js";
import { fakeMailer, REGION } from "./helpers.js";
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
let updates: { id: string; params: Record<string, unknown>; key: string }[];
let seatUpdates: { item: string; quantity: number; proration: string; key: string }[];
let stripeDown: boolean;
/** Stripe refuses resuming a subscription (cancel_at_period_end back to false). */
let refuseResume: boolean;
/** Runs as Stripe is asked for a subscription: after the worker read the team, before it writes. */
let onRetrieve: (() => void) | undefined;
let denied: { command: string; input: Record<string, unknown> }[];
let scopes: WorkerScope[];
let counts: Record<string, number>;
let logs: unknown[][];
let mails: ReturnType<typeof fakeMailer>;
let worker: ReturnType<typeof createBillingWorker>;

function obs(): Observability {
  return {
    region: REGION,
    logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), addContext: () => {} } as unknown as Observability["logger"],
    count: (m, v = 1) => {
      counts[m] = (counts[m] ?? 0) + v;
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
  updates = [];
  onRetrieve = undefined;
  seatUpdates = [];
  stripeDown = false;
  refuseResume = false;
  denied = [];
  scopes = [];
  counts = {};
  logs = [];
  mails = fakeMailer();
  build();
});

function build() {
  const stripe: WorkerStripe & SeatStripe & EntitlementStripe = {
    subscriptions: {
      async list() {
        throw new Error("not used");
      },
      async retrieve(id: string) {
        retrieves.push(id);
        onRetrieve?.();
        if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        const found = subs.get(id);
        if (!found) throw Object.assign(new Error(`No such subscription ${id}`), { code: "resource_missing" });
        return found as SubscriptionLike & SeatSubscription;
      },
      async update(id, params, options) {
        if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        if (refuseResume && params.cancel_at_period_end === false) throw Object.assign(new Error("Stripe is busy"), { name: "StripeRateLimitError" });
        updates.push({ id, params, key: options.idempotencyKey });
        // Metadata merges, and an empty value removes a key, as Stripe does
        const metadata = { ...((subs.get(id) as SubscriptionLike).metadata ?? {}), ...params.metadata };
        for (const [k, v] of Object.entries(metadata)) if (v === "") Reflect.deleteProperty(metadata, k);
        subs.set(id, { ...(subs.get(id) as SubscriptionLike), cancel_at_period_end: params.cancel_at_period_end, metadata });
      },
      async cancel(id, _params, options) {
        cancels.push({ id, key: options.idempotencyKey });
        subs.set(id, { ...(subs.get(id) as SubscriptionLike), status: "canceled" });
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
      return table.guarded(workerPolicy(scope, denied));
    },
    stripe: async () => stripe,
    mailer: mails.mailer,
    obs: obs(),
    now: () => NOW,
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
    expect(updates).toEqual([{ id: "sub_test_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: closedAt } }, key: closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1") }]);
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
  });

  it("cancels an unpaid or paused subscription on a closed team at once, and leaves an ended or foreign one", async () => {
    const closedAt = new Date(NOW - DAY_S * 1000).toISOString();
    patchTeam({ closedAt });
    subs.set("sub_test_1", subscription({ status: "paused" }));
    expect(await worker(message("customer.subscription.updated"))).toBe("team_closed");
    expect(cancels).toEqual([{ id: "sub_test_1", key: closingKey("cancel_now", TEAM, closedAt, "sub_test_1") }]);
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
      { id: "sub_test_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: closedAt } }, key: closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1") },
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
    expect(updates).toEqual([{ id: "sub_test_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: closedAt } }, key: closingKey("cancel_at_period_end", TEAM, closedAt, "sub_test_1") }]);
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
    expect(await worker(message("customer.subscription.deleted", { eventId: "evt_test_2b", subscription: "sub_test_2", status: "canceled" }))).toBe("second_subscription_canceled");
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
  const sync = (reason: "membership" | "reconcile" = "membership", id = "seats-r1") => ({ kind: "seats" as const, id, customer: CUSTOMER, reason, created: NOW / 1000 });
  /** Active, and set to cancel at the period's end by that closure (closing.ts). */
  const endedByClosure = (fields: Partial<SubscriptionLike> = {}) => subscription({ status: "active", trial_end: null, cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: CLOSED }, ...fields });
  const body = () => teamBody(meta() as never, "owner", new Date(NOW));

  beforeEach(() => {
    // Recorded as trialing when it closed: the events since were skipped while it was closed
    patchTeam({ plan: "starter", seats: 3, status: "trialing", stripeSubscriptionId: "sub_test_1", cancelAtPeriodEnd: false, stripeResyncFor: CLOSED });
  });

  it("resumes a subscription its closure set to cancel, applies Stripe's state, and finishes, inside the worker role", async () => {
    subs.set("sub_test_1", endedByClosure());
    expect(await worker(sync())).toBe("in_sync");
    expect(updates).toEqual([{ id: "sub_test_1", params: { cancel_at_period_end: false, metadata: { [CLOSED_AT_METADATA]: "" } }, key: resumeKey("resync", TEAM, CLOSED, "sub_test_1") }]);
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
    expect(updates).toEqual([{ id: "sub_test_1", params: { cancel_at_period_end: false, metadata: { [CLOSED_AT_METADATA]: "" } }, key: resumeKey("resync", TEAM, CLOSED, "sub_test_1") }]);
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
    expect(mails.sent.map((m) => m.input.kind)).toEqual(["readOnly", "readOnly"]);
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
