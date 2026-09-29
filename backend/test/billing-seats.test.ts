// Seat sync (src/billing/seats.ts, supply-checkout-l50): the billing worker
// keeps a subscription's seat quantity equal to the team's billed members.
// Against the in-memory table, each message's handles passing only what the
// billing-worker role allows (test/billing-policy.ts), and a fake Stripe.

import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSeatSync, seatQuantity, type SeatStripe, type SeatSubscription, type SeatSyncMessage, seatUpdateKey, sqsSeatSyncQueue } from "../src/billing/seats.js";
import type { SQSEvent } from "aws-lambda";
import { createBillingWorker, type QueueMessage, type SubscriptionLike, type WorkerStripe } from "../src/billing/worker.js";
import { createWorkerHandler } from "../src/billing/worker-handler.js";
import type { WorkerScope } from "../src/billing/worker-db.js";
import { BILLED_ROLES, isBilledRole } from "../src/data/index.js";
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
  denied = [];
  scopes = [];
  counts = [];
  logs = [];
  const stripe: WorkerStripe & SeatStripe = {
    subscriptions: {
      async retrieve(id: string) {
        if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        const found = subs.get(id);
        if (!found) throw new Error(`No such subscription ${id}`);
        return typed(found);
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
    // The team comes from our link for the customer, never the message
    expect(scopes).toEqual([{ eventId: "seats-1", stripeCustomer: CUSTOMER }, { eventId: "seats-1", stripeCustomer: CUSTOMER, teamId: TEAM }]);
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

  it("makes different keys for different messages, items, and current and target quantities", () => {
    const key = seatUpdateKey(TEAM, "m1", ITEM, 5, 3);
    expect(key).toMatch(/^seats-team-a-[0-9a-f]{64}$/);
    expect(new Set([key, seatUpdateKey(TEAM, "m2", ITEM, 5, 3), seatUpdateKey(TEAM, "m1", "si_2", 5, 3), seatUpdateKey(TEAM, "m1", ITEM, 5, 4), seatUpdateKey(TEAM, "m1", ITEM, 4, 3)]).size).toBe(5);
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
    expect(await worker(seats("reconcile"))).toBe("in_sync");
    expect(counts).toEqual([]);
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
    const handler = createWorkerHandler(async (m) => void applied.push(m), obs(), SEATS_ARN);
    const record = (id: string, source: string, body: unknown) => ({ messageId: id, eventSourceARN: source, body: JSON.stringify(body), attributes: { MessageGroupId: `g-${id}` } }) as unknown as SQSEvent["Records"][number];
    const event = { eventId: "evt_1", type: "invoice.paid", created: 1, customer: CUSTOMER };
    const result = await handler({
      Records: [record("m1", SEATS_ARN, seats()), record("m2", EVENTS_ARN, event), record("m3", EVENTS_ARN, seats()), record("m4", SEATS_ARN, event)],
    });
    expect(applied).toEqual([seats(), event]);
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
