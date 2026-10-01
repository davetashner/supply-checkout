// Seat sync (src/billing/seats.ts, supply-checkout-l50): the billing worker
// keeps a subscription's seat quantity equal to the team's billed members.
// Against the in-memory table, each message's handles passing only what the
// billing-worker role allows (test/billing-policy.ts), and a fake Stripe.

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it } from "vitest";
import { entitlementDrift, type EntitlementStripe, UNRECORDED_GRACE_SECONDS } from "../src/billing/entitlements.js";
import { parseSeatSync, seatQuantity, type SeatStripe, type SeatSubscription, type SeatSyncMessage, seatUpdateKey, sqsSeatSyncQueue } from "../src/billing/seats.js";
import type { SQSEvent } from "aws-lambda";
import { createBillingWorker, type QueueMessage, type SubscriptionLike, type WorkerStripe } from "../src/billing/worker.js";
import { createWorkerHandler } from "../src/billing/worker-handler.js";
import type { WorkerScope } from "../src/billing/worker-db.js";
import { BILLED_ROLES, isBilledRole, MEMBERS_PER_TEAM } from "../src/data/index.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { workerPolicy } from "./billing-policy.js";
import { fakeMailer, REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const TEAM = "team-a";
const CUSTOMER = "cus_test_1";
const SUB = "sub_test_1";
const ITEM = "si_test_1";

/** A Stripe subscription as both the worker (SubscriptionLike) and the seat sync (SeatSubscription) read it. */
type Item = { id: string; quantity?: number; current_period_end: number; price: { lookup_key: string | null; recurring: { interval: string } | null } };
type Sub = Omit<SubscriptionLike, "items"> & { items: { data: Item[] } };
const typed = (sub: Sub): SubscriptionLike & SeatSubscription => sub as SubscriptionLike & SeatSubscription;

let table: MemoryTable;
let subs: Map<string, Sub>;
let updates: { item: string; quantity: number; proration: string; key: string }[];
let stripeDown: boolean;
let listed: string[];
let customerGone: boolean;
let listFails: boolean;
let onRetrieve: (() => void) | undefined;
let denied: { command: string; input: Record<string, unknown> }[];
let scopes: WorkerScope[];
let counts: [string, number, unknown][];
let logs: [string, string, unknown][];
let worker: ReturnType<typeof createBillingWorker>;

function obs(): Observability {
  const log = (level: string) => (message: string, data?: unknown) => logs.push([level, message, data]);
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (m, v = 1, meta) => counts.push([m, v, meta]),
    gauge: () => {},
    flush: () => {},
  };
}

function subscription(quantity: number, fields: Partial<Sub> = {}): Sub {
  return {
    id: SUB,
    customer: CUSTOMER,
    status: "active",
    cancel_at_period_end: false,
    trial_end: null,
    default_payment_method: "pm_1",
    items: { data: [{ id: ITEM, quantity, current_period_end: NOW / 1000 + 86400 * 20, price: { lookup_key: "supply_checkout_starter_monthly", recurring: { interval: "month" } } }] },
    ...fields,
  };
}

function member(userId: string, role: string) {
  table.put({ PK: `TEAM#${TEAM}`, SK: `MEMBER#${userId}`, type: "member", teamId: TEAM, userId, role, email: `${userId}@example.com` });
}

/** Deletes an item, as another request would have. */
function remove(PK: string, SK: string) {
  for (const [key, item] of table.items) if (item.PK === PK && item.SK === SK) table.items.delete(key);
}

function patchTeam(fields: Record<string, unknown>) {
  const meta = table.get(`TEAM#${TEAM}`, "META") as Record<string, unknown>;
  table.put(Object.fromEntries(Object.entries({ ...meta, ...fields }).filter(([, v]) => v !== undefined)));
}

beforeEach(() => {
  table = new MemoryTable();
  // Two owners, one editor and two viewers: three billed seats
  table.seedTeam(TEAM, { "user-owner": "owner", "user-owner-2": "owner", "user-crew": "contributor", "user-view-1": "viewer", "user-view-2": "viewer" });
  patchTeam({ name: "Echo Plumbing", plan: "starter", seats: 5, status: "active", stripeCustomerId: CUSTOMER, stripeSubscriptionId: SUB });
  table.put({ PK: `STRIPE#${CUSTOMER}`, SK: "TEAM", type: "stripeLink", customerId: CUSTOMER, teamId: TEAM });
  subs = new Map([[SUB, subscription(5)]]);
  updates = [];
  stripeDown = false;
  listed = [];
  customerGone = false;
  listFails = false;
  onRetrieve = undefined;
  denied = [];
  scopes = [];
  counts = [];
  logs = [];
  const stripe: WorkerStripe & SeatStripe & EntitlementStripe = {
    subscriptions: {
      async retrieve(id: string) {
        if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        onRetrieve?.();
        const found = subs.get(id);
        // As Stripe answers for an ID it doesn't have
        if (!found) throw Object.assign(new Error(`No such subscription: '${id}'`), { type: "StripeInvalidRequestError", code: "resource_missing" });
        return typed(found);
      },
      async list({ customer, status, limit }) {
        listed.push(`${customer} ${status} ${limit}`);
        if (listFails) throw Object.assign(new Error("Stripe is busy"), { type: "StripeRateLimitError", code: "rate_limit" });
        if (customerGone) throw Object.assign(new Error(`No such customer: '${customer}'`), { type: "StripeInvalidRequestError", code: "resource_missing" });
        // Every customer's, newest first: the check must pick out the customer's own itself
        return { data: [...subs.values()].sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).map(typed) };
      },
      async update() {
        throw new Error("not used");
      },
      async cancel() {
        throw new Error("not used");
      },
    },
    subscriptionItems: {
      async update(item, params, options) {
        if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        updates.push({ item, quantity: params.quantity, proration: params.proration_behavior, key: options.idempotencyKey });
        for (const [id, sub] of subs) {
          subs.set(id, { ...sub, items: { data: sub.items.data.map((i) => (i.id === item ? { ...i, quantity: params.quantity } : i)) } });
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
    mailer: fakeMailer().mailer,
    obs: obs(),
    now: () => NOW,
  });
});

const seats = (reason: SeatSyncMessage["reason"] = "membership", id = "seats-1", customer = CUSTOMER): SeatSyncMessage => ({ kind: "seats", id, customer, reason, created: NOW / 1000 });
const quantity = () => subs.get(SUB)?.items.data[0]?.quantity;

describe("who is billed", () => {
  it("bills owners and editors, and not viewers, from one list", () => {
    expect(BILLED_ROLES).toEqual(["owner", "contributor"]);
    expect(["owner", "contributor", "viewer", "system", undefined].map(isBilledRole)).toEqual([true, true, false, false, false]);
  });

  it("never asks Stripe for fewer than one seat", () => {
    expect([0, 1, 3, 12].map(seatQuantity)).toEqual([1, 1, 3, 12]);
  });
});

describe("a seat sync after a membership change", () => {
  it("sets the seat item's quantity to the billed members, with proration and an idempotency key, inside the worker role", async () => {
    expect(await worker(seats())).toBe("updated");
    expect(updates).toEqual([{ item: ITEM, quantity: 3, proration: "create_prorations", key: seatUpdateKey(TEAM, "seats-1", ITEM, 5, 3) }]);
    expect(quantity()).toBe(3);
    expect(counts).toEqual([[BusinessMetric.SeatQuantityUpdates, 1, { teamId: TEAM, reason: "membership" }]]);
    // Not drift: the change is what the sync is for
    expect(counts.map(([m]) => m)).not.toContain(BusinessMetric.SeatQuantityDrift);
    expect(denied).toEqual([]);
    // The team comes from our link for the customer, never the message: for the reopen resync's check, then the sync
    const scoped = [{ eventId: "seats-1", stripeCustomer: CUSTOMER }, { eventId: "seats-1", stripeCustomer: CUSTOMER, teamId: TEAM }];
    expect(scopes).toEqual([...scoped, ...scoped]);
    // IDs and numbers only: never a name or an address
    expect(JSON.stringify(logs)).not.toMatch(/example\.com|Echo Plumbing/);
    expect(logs).toContainEqual(["info", "Seat quantity updated", { teamId: TEAM, subscriptionId: SUB, from: 5, to: 3, reason: "membership" }]);
  });

  it("changes nothing when the quantity is already right", async () => {
    subs.set(SUB, subscription(3));
    expect(await worker(seats())).toBe("in_sync");
    expect(updates).toEqual([]);
    expect(counts).toEqual([]);
  });

  it("counts from the members as they are when it runs, so racing changes converge", async () => {
    subs.set(SUB, subscription(3));
    // Two changes queued one after the other; the second member joined before the first sync ran
    member("user-new-1", "contributor");
    member("user-new-2", "owner");
    expect(await worker(seats("membership", "seats-a"))).toBe("updated");
    expect(await worker(seats("membership", "seats-b"))).toBe("in_sync");
    expect(quantity()).toBe(5);
    // A late message after someone left sets it down again, whatever it was queued for
    remove(`TEAM#${TEAM}`, "MEMBER#user-new-1");
    expect(await worker(seats("membership", "seats-c"))).toBe("updated");
    expect(updates.map((u) => u.quantity)).toEqual([5, 4]);
    expect(new Set(updates.map((u) => u.key)).size).toBe(2);
  });

  it("throws when Stripe can't be reached, so the message is retried, and a retry sends the same key", async () => {
    stripeDown = true;
    await expect(worker(seats())).rejects.toThrow("Stripe is down");
    stripeDown = false;
    expect(await worker(seats())).toBe("updated");
    expect(updates[0]?.key).toBe(seatUpdateKey(TEAM, "seats-1", ITEM, 5, 3));
    // Once Stripe has it, a repeat finds nothing to do
    expect(await worker(seats())).toBe("in_sync");
    expect(updates).toHaveLength(1);
  });

  it("makes different keys for different messages, deliveries, items, and current and target quantities", () => {
    const key = seatUpdateKey(TEAM, "m1", ITEM, 5, 3);
    expect(key).toMatch(/^seats-team-a-[0-9a-f]{64}$/);
    const others = [seatUpdateKey(TEAM, "m2", ITEM, 5, 3), seatUpdateKey(TEAM, "m1", "si_2", 5, 3), seatUpdateKey(TEAM, "m1", ITEM, 5, 4), seatUpdateKey(TEAM, "m1", ITEM, 4, 3), seatUpdateKey(TEAM, "m1", ITEM, 5, 3, "sqs-1"), seatUpdateKey(TEAM, "m1", ITEM, 5, 3, "sqs-2")];
    expect(new Set([key, ...others]).size).toBe(7);
    expect(seatUpdateKey(TEAM, "m1", ITEM, 5, 3, "sqs-1")).toBe(others[4]);
  });

  it("folds the SQS delivery into the key, so the same message ID delivered again isn't a replay of Stripe's cached update (supply-checkout-8jc.21)", async () => {
    const message = seats("reconcile", "reconcile-2026-09-28-cus_test_1");
    expect(await worker(message, "sqs-run-1")).toBe("updated");
    // Someone sets it back by hand, and the reconciliation runs again the same day: same message ID, new delivery
    subs.set(SUB, subscription(5));
    expect(await worker(message, "sqs-run-2")).toBe("updated");
    expect(updates.map((u) => u.key)).toEqual([seatUpdateKey(TEAM, message.id, ITEM, 5, 3, "sqs-run-1"), seatUpdateKey(TEAM, message.id, ITEM, 5, 3, "sqs-run-2")]);
    expect(updates[0]?.key).not.toBe(updates[1]?.key);
  });

  it("sends the same key when SQS delivers the same message again (a retry)", async () => {
    stripeDown = true;
    await expect(worker(seats(), "sqs-1")).rejects.toThrow("Stripe is down");
    stripeDown = false;
    expect(await worker(seats(), "sqs-1")).toBe("updated");
    expect(updates.map((u) => u.key)).toEqual([seatUpdateKey(TEAM, "seats-1", ITEM, 5, 3, "sqs-1")]);
  });
});

describe("what a seat sync skips", () => {
  it("an unknown customer, a team that's gone, closed or being purged", async () => {
    expect(await worker(seats("membership", "seats-1", "cus_unknown"))).toBe("unknown_customer");
    patchTeam({ closedAt: "2026-09-27T00:00:00.000Z" });
    expect(await worker(seats())).toBe("team_closed");
    patchTeam({ closedAt: undefined, purging: "2026-09-27T00:00:00.000Z" });
    expect(await worker(seats())).toBe("team_closed");
    remove(`TEAM#${TEAM}`, "META");
    expect(await worker(seats())).toBe("team_gone");
    // A link to another team than the one it names now
    table.put({ PK: `STRIPE#${CUSTOMER}`, SK: "TEAM", type: "stripeLink", customerId: CUSTOMER, teamId: "team-other" });
    expect(await worker(seats())).toBe("team_gone");
    expect(updates).toEqual([]);
  });

  it("a team whose own Stripe customer isn't the message's, with a warning (supply-checkout-8jc.21)", async () => {
    patchTeam({ stripeCustomerId: "cus_other" });
    expect(await worker(seats())).toBe("not_ours");
    patchTeam({ stripeCustomerId: undefined });
    expect(await worker(seats())).toBe("not_ours");
    expect(updates).toEqual([]);
    expect(logs.filter(([level]) => level === "warn")).toEqual([
      ["warn", "Seat sync skipped: the team has another Stripe customer", { teamId: TEAM, messageId: "seats-1" }],
      ["warn", "Seat sync skipped: the team has another Stripe customer", { teamId: TEAM, messageId: "seats-1" }],
    ]);
    // Before Stripe is asked anything
    expect(logs).toContainEqual(["info", "Seat sync", { messageId: "seats-1", reason: "membership", outcome: "not_ours" }]);
  });

  it("a team without a subscription (a trial that never went through Checkout), or whose subscription ended", async () => {
    patchTeam({ stripeSubscriptionId: undefined, status: "trialing" });
    expect(await worker(seats())).toBe("no_subscription");
    patchTeam({ stripeSubscriptionId: SUB, status: "canceled" });
    expect(await worker(seats())).toBe("subscription_ended");
    expect(updates).toEqual([]);
  });

  it("a subscription Stripe says ended or hasn't started, or that belongs to another customer", async () => {
    for (const status of ["canceled", "incomplete_expired", "incomplete"]) {
      subs.set(SUB, subscription(5, { status }));
      expect(await worker(seats())).toBe("subscription_ended");
    }
    subs.set(SUB, subscription(5, { customer: { id: "cus_other" } }));
    expect(await worker(seats())).toBe("not_ours");
    expect(updates).toEqual([]);
    expect(logs).toContainEqual(["warn", "Seat sync skipped: another customer's subscription", { teamId: TEAM, subscriptionId: SUB }]);
  });

  it("more billed members than a team can have: changes nothing, and counts drift so the alarm brings a person (supply-checkout-8jc.21)", async () => {
    // Three billed already; up to the cap is still billed
    for (let i = 3; i < MEMBERS_PER_TEAM; i++) member(`user-extra-${i}`, "contributor");
    expect(await worker(seats())).toBe("updated");
    expect(quantity()).toBe(MEMBERS_PER_TEAM);
    counts = [];
    member("user-one-too-many", "contributor");
    expect(await worker(seats("membership", "seats-2"))).toBe("over_cap");
    expect(quantity()).toBe(MEMBERS_PER_TEAM);
    expect(updates).toHaveLength(1);
    expect(counts).toEqual([[BusinessMetric.SeatQuantityDrift, 1, { teamId: TEAM }]]);
    expect(logs).toContainEqual(["warn", "Seat sync skipped: more billed members than a team can have", { teamId: TEAM, billedMembers: MEMBERS_PER_TEAM + 1, cap: MEMBERS_PER_TEAM }]);
  });

  it("a subscription that isn't one item on a price we sell, which someone set up by hand", async () => {
    const [item] = subscription(5).items.data;
    subs.set(SUB, subscription(5, { items: { data: [item as Item, { ...(item as Item), id: "si_2" }] } }));
    expect(await worker(seats())).toBe("not_ours");
    subs.set(SUB, subscription(5, { items: { data: [{ ...(item as Item), price: { lookup_key: "someone_elses_price", recurring: { interval: "month" } } }] } }));
    expect(await worker(seats())).toBe("not_ours");
    expect(updates).toEqual([]);
    expect(logs.filter(([level]) => level === "warn")).toEqual([
      ["warn", "Seat sync skipped: not one catalog item", { teamId: TEAM, subscriptionId: SUB, items: 2 }],
      ["warn", "Seat sync skipped: not one catalog item", { teamId: TEAM, subscriptionId: SUB, items: 1 }],
    ]);
  });

  it("a seat item with no quantity counts as none", async () => {
    const [item] = subscription(5).items.data;
    const rest: Item = { ...(item as Item) };
    delete rest.quantity;
    subs.set(SUB, subscription(5, { items: { data: [rest] } }));
    expect(await worker(seats())).toBe("updated");
    expect(logs).toContainEqual(["info", "Seat quantity updated", { teamId: TEAM, subscriptionId: SUB, from: 0, to: 3, reason: "membership" }]);
  });
});

describe("the nightly reconciliation's check", () => {
  it("counts drift and logs both numbers, then fixes it", async () => {
    expect(await worker(seats("reconcile", "reconcile-2026-09-28-cus_test_1"))).toBe("updated");
    expect(counts).toEqual([
      [BusinessMetric.SeatQuantityDrift, 1, { teamId: TEAM }],
      [BusinessMetric.SeatQuantityUpdates, 1, { teamId: TEAM, reason: "reconcile" }],
    ]);
    expect(logs).toContainEqual(["warn", "Seat quantity drift", { teamId: TEAM, subscriptionId: SUB, stripeQuantity: 5, billedMembers: 3 }]);
    expect(quantity()).toBe(3);
  });

  it("counts nothing when the seats are right", async () => {
    subs.set(SUB, subscription(3));
    patchTeam({ seats: 3 });
    expect(await worker(seats("reconcile"))).toBe("in_sync");
    expect(counts).toEqual([]);
  });
});

describe("the nightly entitlement check (supply-checkout-8jc.9)", () => {
  const RECONCILE = "reconcile-2026-09-28-cus_test_1";
  const nightly = () => worker(seats("reconcile", RECONCILE));
  const meta = () => table.get(`TEAM#${TEAM}`, "META") as Record<string, unknown>;
  const drift = () => counts.filter(([m]) => m === BusinessMetric.EntitlementDrift);
  const OLD = NOW / 1000 - UNRECORDED_GRACE_SECONDS - 1;

  beforeEach(() => {
    // Seats already right, so only the entitlements are in question
    subs.set(SUB, subscription(3));
    patchTeam({ seats: 3 });
  });

  it("finds nothing to fix when the team matches Stripe, and lists nothing", async () => {
    expect(await nightly()).toBe("in_sync");
    expect(counts).toEqual([]);
    expect(listed).toEqual([]);
    expect(logs).toContainEqual(["info", "Entitlement check", { messageId: RECONCILE, outcome: "in_sync" }]);
  });

  it("alarms on a status change we missed (a forced mismatch), fixes it inside the worker role, and logs no name or email", async () => {
    subs.set(SUB, subscription(3, { status: "past_due" }));
    expect(await nightly()).toBe("in_sync");
    expect(drift()).toEqual([[BusinessMetric.EntitlementDrift, 1, { teamId: TEAM }]]);
    expect(logs).toContainEqual([
      "warn",
      "Entitlement drift",
      {
        teamId: TEAM,
        fields: "status",
        ours: { subscriptionId: SUB, status: "active", plan: "starter", seats: 3, cancelAtPeriodEnd: false },
        stripe: { subscriptionId: SUB, status: "past_due", plan: "starter", seats: 3, cancelAtPeriodEnd: false },
      },
    ]);
    expect(meta()).toMatchObject({ status: "past_due", stripeSubscriptionId: SUB });
    expect(denied).toEqual([]);
    expect(JSON.stringify(logs)).not.toMatch(/example\.com|Echo Plumbing/);
    // Fixed: the next night finds nothing
    counts = [];
    expect(await worker(seats("reconcile", "reconcile-2026-09-29-cus_test_1"))).toBe("in_sync");
    expect(counts).toEqual([]);
  });

  it("alarms on a plan change we missed, and records it", async () => {
    patchTeam({ plan: "trial" });
    expect(await nightly()).toBe("in_sync");
    expect(drift()).toHaveLength(1);
    expect(logs.find(([, message]) => message === "Entitlement drift")?.[2]).toMatchObject({ fields: "plan" });
    expect(meta()).toMatchObject({ plan: "starter", billingInterval: "month" });
  });

  it("records a cancellation at the period's end we never heard about (a reopened team's), and its renewal", async () => {
    // Set to cancel while the team was closed, whose events the worker skipped
    subs.set(SUB, subscription(3, { cancel_at_period_end: true }));
    expect(await nightly()).toBe("in_sync");
    expect(drift()).toHaveLength(1);
    expect(logs.find(([, message]) => message === "Entitlement drift")?.[2]).toMatchObject({ fields: "cancelAtPeriodEnd", ours: { cancelAtPeriodEnd: false }, stripe: { cancelAtPeriodEnd: true } });
    expect(meta()).toMatchObject({ cancelAtPeriodEnd: true, status: "active" });
    // Renewed in the Customer Portal, and that event lost too
    subs.set(SUB, subscription(3));
    logs = [];
    expect(await worker(seats("reconcile", "reconcile-2026-09-29-cus_test_1"))).toBe("in_sync");
    expect(logs.find(([, message]) => message === "Entitlement drift")?.[2]).toMatchObject({ fields: "cancelAtPeriodEnd" });
    expect(meta().cancelAtPeriodEnd).toBe(false);
    expect(denied).toEqual([]);
  });

  it("doesn't overwrite a cancellation an event applied while the check was asking Stripe", async () => {
    // The check reads the team as renewing and Stripe as renewing too, then an event records a cancellation
    subs.set(SUB, subscription(3, { status: "past_due" }));
    onRetrieve = () => {
      onRetrieve = undefined;
      patchTeam({ cancelAtPeriodEnd: true });
    };
    await expect(nightly()).rejects.toThrow("changed meanwhile");
    expect(meta()).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
    expect(drift()).toEqual([]);
  });

  it("turns a team read-only whose subscription ended without us hearing, after looking for a newer one", async () => {
    subs.set(SUB, subscription(3, { status: "canceled" }));
    expect(await nightly()).toBe("subscription_ended");
    expect(listed).toEqual([`${CUSTOMER} all 10`]);
    expect(logs.find(([, message]) => message === "Entitlement drift")?.[2]).toMatchObject({ fields: "status" });
    expect(meta()).toMatchObject({ status: "canceled" });
    expect(updates).toEqual([]);
  });

  it("records a subscription whose checkout we never heard about, once it's past the grace period", async () => {
    patchTeam({ stripeSubscriptionId: undefined, status: "trialing", plan: "trial", seats: 1 });
    subs.set(SUB, subscription(3, { status: "trialing", created: NOW / 1000 - 60 }));
    // Minutes old: its events may still be on the way
    expect(await nightly()).toBe("no_subscription");
    expect(counts).toEqual([]);
    expect(meta().stripeSubscriptionId).toBeUndefined();
    subs.set(SUB, subscription(3, { status: "trialing", created: OLD }));
    expect(await worker(seats("reconcile", "reconcile-2026-09-29-cus_test_1"))).toBe("in_sync");
    expect(logs.find(([, message]) => message === "Entitlement drift")?.[2]).toMatchObject({ fields: "subscription,plan,seats" });
    expect(meta()).toMatchObject({ stripeSubscriptionId: SUB, status: "trialing", plan: "starter", seats: 3 });
    expect(denied).toEqual([]);
  });

  it("records a resubscription we never heard about, in place of the ended one", async () => {
    subs.set(SUB, subscription(3, { status: "canceled", created: OLD - 86400 }));
    patchTeam({ status: "canceled" });
    subs.set("sub_test_2", subscription(3, { id: "sub_test_2", created: OLD }));
    expect(await nightly()).toBe("in_sync");
    expect(logs.find(([, message]) => message === "Entitlement drift")?.[2]).toMatchObject({ fields: "subscription,status" });
    expect(meta()).toMatchObject({ stripeSubscriptionId: "sub_test_2", status: "active" });
  });

  it("ignores another customer's subscription in the listing, and changes nothing for an ended team with no newer one", async () => {
    subs.set(SUB, subscription(3, { status: "canceled" }));
    patchTeam({ status: "canceled" });
    subs.set("sub_other", subscription(3, { id: "sub_other", created: OLD, customer: { id: "cus_other" } }));
    expect(await nightly()).toBe("subscription_ended");
    expect(counts).toEqual([]);
    expect(meta()).toMatchObject({ stripeSubscriptionId: SUB, status: "canceled" });
  });

  it("counts an ended team whose customer Stripe doesn't have, and stops there instead of failing every night", async () => {
    subs.set(SUB, subscription(3, { status: "canceled" }));
    patchTeam({ status: "canceled" });
    customerGone = true;
    expect(await nightly()).toBe("missing");
    expect(drift()).toHaveLength(1);
    expect(logs).toContainEqual(["warn", "Entitlement drift: customer missing in Stripe", { teamId: TEAM, status: "canceled" }]);
    expect(meta()).toMatchObject({ stripeSubscriptionId: SUB, status: "canceled" });
  });

  it("throws when listing the customer's subscriptions fails for another reason", async () => {
    patchTeam({ stripeSubscriptionId: undefined });
    subs.clear();
    listFails = true;
    await expect(nightly()).rejects.toThrow("Stripe is busy");
    expect(counts).toEqual([]);
  });

  it("doesn't take an incomplete subscription (its first payment hasn't gone through) as unrecorded", async () => {
    patchTeam({ stripeSubscriptionId: undefined, status: "trialing", plan: "trial", seats: 1 });
    subs.set(SUB, subscription(3, { status: "incomplete", created: OLD }));
    expect(await nightly()).toBe("no_subscription");
    expect(counts).toEqual([]);
    expect(meta().stripeSubscriptionId).toBeUndefined();
  });

  it("counts a recorded subscription Stripe doesn't have, and stops there", async () => {
    patchTeam({ stripeSubscriptionId: "sub_gone" });
    expect(await nightly()).toBe("missing");
    expect(drift()).toHaveLength(1);
    expect(logs).toContainEqual(["warn", "Entitlement drift: subscription missing in Stripe", { teamId: TEAM, subscriptionId: "sub_gone", status: "active" }]);
    expect(meta()).toMatchObject({ stripeSubscriptionId: "sub_gone", status: "active" });
  });

  it("throws when Stripe can't be reached, so the message is retried", async () => {
    stripeDown = true;
    await expect(nightly()).rejects.toThrow("Stripe is down");
    expect(counts).toEqual([]);
  });

  it("never overwrites an event applied meanwhile: it throws, and the retry finds the team in sync", async () => {
    subs.set(SUB, subscription(3, { status: "past_due" }));
    // The billing worker applies the same change between the check's read and its write
    onRetrieve = () => {
      onRetrieve = undefined;
      patchTeam({ status: "past_due" });
    };
    await expect(nightly()).rejects.toThrow("The team's subscription changed meanwhile");
    expect(counts).toEqual([]);
    expect(await nightly()).toBe("in_sync");
    expect(counts).toEqual([]);
  });

  it("skips an unknown customer, a closed, purging or gone team, and a subscription that isn't the customer's", async () => {
    expect(await worker(seats("reconcile", RECONCILE, "cus_unknown"))).toBe("unknown_customer");
    patchTeam({ closedAt: "2026-09-27T00:00:00.000Z" });
    expect(await nightly()).toBe("team_closed");
    patchTeam({ closedAt: undefined, purging: "2026-09-27T00:00:00.000Z" });
    expect(await nightly()).toBe("team_closed");
    patchTeam({ purging: undefined });
    subs.set(SUB, subscription(3, { status: "past_due", customer: { id: "cus_other" } }));
    expect(await nightly()).toBe("not_ours");
    expect(logs).toContainEqual(["warn", "Entitlement check skipped: subscription isn't the customer's", { teamId: TEAM, subscriptionId: SUB }]);
    subs.set(SUB, subscription(3, { status: "past_due" }));
    patchTeam({ stripeCustomerId: "cus_other" });
    expect(await nightly()).toBe("not_ours");
    expect(logs).toContainEqual(["warn", "Entitlement check skipped: the team has another Stripe customer", { teamId: TEAM }]);
    patchTeam({ stripeCustomerId: CUSTOMER });
    table.put({ PK: `STRIPE#${CUSTOMER}`, SK: "TEAM", type: "stripeLink", customerId: CUSTOMER, teamId: "team-other" });
    expect(await nightly()).toBe("team_gone");
    table.put({ PK: `STRIPE#${CUSTOMER}`, SK: "TEAM", type: "stripeLink", customerId: CUSTOMER, teamId: TEAM });
    remove(`TEAM#${TEAM}`, "META");
    expect(await nightly()).toBe("team_gone");
    expect(counts).toEqual([]);
    expect(listed).toEqual([]);
  });

  it("runs only for the nightly reconciliation, not after a membership change", async () => {
    subs.set(SUB, subscription(3, { status: "past_due" }));
    expect(await worker(seats("membership"))).toBe("in_sync");
    expect(counts).toEqual([]);
    expect(meta()).toMatchObject({ status: "active" });
  });

  it("compares the subscription, status, plan, seats and whether it's set to cancel, and leaves the plan of a price we don't sell alone", () => {
    const team = { stripeSubscriptionId: SUB, status: "active", plan: "starter", seats: 3, cancelAtPeriodEnd: false };
    const state = { customerId: CUSTOMER, subscriptionId: SUB, status: "active", plan: "starter", seats: 3, cancelAtPeriodEnd: false };
    expect(entitlementDrift(team, state)).toEqual([]);
    expect(entitlementDrift({ ...team, plan: "trial" }, { ...state, plan: undefined })).toEqual([]);
    expect(entitlementDrift({ stripeSubscriptionId: undefined, status: "trialing", plan: "trial", seats: 1, cancelAtPeriodEnd: true }, state)).toEqual(["subscription", "status", "plan", "seats", "cancelAtPeriodEnd"]);
    expect(entitlementDrift(team, { ...state, cancelAtPeriodEnd: true })).toEqual(["cancelAtPeriodEnd"]);
  });
});

describe("after a Stripe event", () => {
  const event = (fields: Record<string, unknown> = {}) => ({ eventId: "evt_1", type: "checkout.session.completed" as const, created: NOW / 1000, customer: CUSTOMER, subscription: SUB, ...fields });

  it("sets the seats chosen at Checkout to the billed members once the subscription is applied, and again on a retry", async () => {
    patchTeam({ stripeSubscriptionId: undefined, status: "trialing", plan: "trial" });
    subs.set(SUB, subscription(5, { status: "trialing" }));
    expect(await worker(event())).toBe("applied");
    expect(updates).toEqual([{ item: ITEM, quantity: 3, proration: "create_prorations", key: seatUpdateKey(TEAM, "evt_1", ITEM, 5, 3) }]);
    expect(counts).toContainEqual([BusinessMetric.SeatQuantityUpdates, 1, { teamId: TEAM, reason: "subscription" }]);
    // The event is recorded before the seats: a retry (after the update failed) is a duplicate, and still checks them
    subs.set(SUB, subscription(5, { status: "trialing" }));
    expect(await worker(event())).toBe("duplicate");
    expect(updates).toHaveLength(2);
  });

  it("doesn't sync for an event about no subscription, or one that wasn't applied", async () => {
    expect(await worker(event({ eventId: "evt_2", subscription: undefined }))).toBe("ignored");
    expect(await worker(event({ eventId: "evt_3", customer: "cus_unknown" }))).toBe("unknown_customer");
    expect(updates).toEqual([]);
  });
});

describe("seat sync messages", () => {
  it("parses a well-formed one and refuses anything else", () => {
    const good = seats("reconcile");
    expect(parseSeatSync(JSON.stringify({ ...good, extra: "dropped" }))).toEqual(good);
    for (const bad of [{ ...good, kind: "event" }, { ...good, id: "a#b" }, { ...good, customer: 7 }, { ...good, reason: "because" }, { ...good, created: "now" }, { eventId: "evt_1" }, null]) {
      expect(() => parseSeatSync(JSON.stringify(bad))).toThrow("Not a seat sync message");
    }
    expect(() => parseSeatSync("not json")).toThrow();
  });

  it("takes only seat syncs from the seat sync queue, and only Stripe events from the billing queue", async () => {
    const SEATS_ARN = "arn:aws:sqs:test-local-1:account:supply-checkout-prod-seat-syncs.fifo";
    const EVENTS_ARN = "arn:aws:sqs:test-local-1:account:supply-checkout-prod-billing-events.fifo";
    const applied: QueueMessage[] = [];
    const deliveries: string[] = [];
    const handler = createWorkerHandler(async (m, delivery) => void (applied.push(m), deliveries.push(delivery)), obs(), SEATS_ARN);
    const record = (id: string, source: string, body: unknown) => ({ messageId: id, eventSourceARN: source, body: JSON.stringify(body), attributes: { MessageGroupId: `g-${id}` } }) as unknown as SQSEvent["Records"][number];
    const event = { eventId: "evt_1", type: "invoice.paid", created: 1, customer: CUSTOMER };
    const result = await handler({
      Records: [record("m1", SEATS_ARN, seats()), record("m2", EVENTS_ARN, event), record("m3", EVENTS_ARN, seats()), record("m4", SEATS_ARN, event)],
    });
    expect(applied).toEqual([seats(), event]);
    // Each with the SQS message ID that delivered it (for the seat update's idempotency key)
    expect(deliveries).toEqual(["m1", "m2"]);
    // A seat sync passed off as an event, and the reverse, are refused
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m3" }, { itemIdentifier: "m4" }]);
  });

  it("queues on the billing queue in the customer's group, deduplicated by its own ID", async () => {
    const sent: SendMessageCommand[] = [];
    const queue = sqsSeatSyncQueue("https://sqs.example/queue.fifo", { send: async (c) => void sent.push(c) }, { now: () => NOW, newId: () => "seats-abc" });
    await queue(CUSTOMER, "membership");
    expect(sent.map((c) => c.input)).toEqual([
      {
        QueueUrl: "https://sqs.example/queue.fifo",
        MessageBody: JSON.stringify({ kind: "seats", id: "seats-abc", customer: CUSTOMER, reason: "membership", created: NOW / 1000 }),
        MessageGroupId: CUSTOMER,
        MessageDeduplicationId: "seats-abc",
      },
    ]);
    await expect(queue("cus#1", "membership")).rejects.toThrow("Invalid Stripe customer ID");
    // By default each message gets a new ID
    const ids: string[] = [];
    const fresh = sqsSeatSyncQueue("q", { send: async (c) => void ids.push(String((c as SendMessageCommand).input.MessageDeduplicationId)) });
    await fresh(CUSTOMER, "membership");
    await fresh(CUSTOMER, "membership");
    expect(ids[0]).toMatch(/^seats-[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
