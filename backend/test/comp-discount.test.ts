// A comp's Stripe discount (src/billing/comp-discount.ts, supply-checkout-6e4b):
// the billing worker makes a team's subscription carry the 100%-off discount
// its comp wants, and nothing else of ours. Against the in-memory table, each
// message's handles passing only what the billing-worker role allows
// (test/billing-policy.ts), and a fake Stripe that keeps discounts, coupons and
// idempotency keys as Stripe does.

import { beforeEach, describe, expect, it } from "vitest";
import {
  COMP_UNTIL_METADATA,
  compCouponId,
  type CompDiscountStripe,
  compDiscountKey,
  type CompSubscriptionLike,
  type CouponLike,
  type DiscountLike,
  ensureCompCoupon,
  wantedCompDiscount,
} from "../src/billing/comp-discount.js";
import type { EntitlementStripe } from "../src/billing/entitlements.js";
import type { SeatStripe, SeatSyncMessage } from "../src/billing/seats.js";
import { createBillingWorker, type WorkerStripe } from "../src/billing/worker.js";
import type { WorkerScope } from "../src/billing/worker-db.js";
import { BILLING_WORKER_ACTOR } from "../src/data/index.js";
import type { Observability } from "../src/observability/index.js";
import { workerPolicy } from "./billing-policy.js";
import { fakeMailer, REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const TEAM = "team-a";
const CUSTOMER = "cus_test_1";
const SUB = "sub_test_1";
const UNTIL = "2026-12-02T12:00:00.000Z";

type Sub = Omit<CompSubscriptionLike, "discounts" | "metadata" | "items"> & {
  cancel_at_period_end: boolean;
  trial_end: number | null;
  default_payment_method: string | null;
  discounts: DiscountLike[];
  metadata: Record<string, string>;
  items: { data: { id: string; quantity: number; current_period_end: number; price: { lookup_key: string; recurring: { interval: string } } }[] };
};

let table: MemoryTable;
let subs: Map<string, Sub>;
let coupons: Map<string, CouponLike>;
let updates: { id: string; params: { discounts?: unknown; metadata?: Record<string, string> }; key: string }[];
let created: { id: string; key: string }[];
let stripeKeys: Set<string>;
let retrieves: { id: string; expand?: string[] }[];
let stripeDown: boolean;
let unexpanded: boolean;
let denied: { command: string; input: Record<string, unknown> }[];
let scopes: WorkerScope[];
let logs: [string, string, unknown][];
let worker: ReturnType<typeof createBillingWorker>;
let discountSeq: number;

function obs(): Observability {
  const log = (level: string) => (message: string, data?: unknown) => logs.push([level, message, data]);
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: () => {},
    gauge: () => {},
    flush: () => {},
  };
}

function subscription(fields: Partial<Sub> = {}, interval = "month"): Sub {
  return {
    id: SUB,
    customer: CUSTOMER,
    status: "active",
    cancel_at_period_end: false,
    trial_end: null,
    default_payment_method: "pm_1",
    metadata: {},
    discounts: [],
    items: { data: [{ id: "si_1", quantity: 1, current_period_end: NOW / 1000 + 86400 * 20, price: { lookup_key: `supply_checkout_starter_${interval === "year" ? "annual" : "monthly"}`, recurring: { interval } } }] },
    ...fields,
  };
}

const discount = (coupon: string, id = `di_${++discountSeq}`): DiscountLike => ({ id, source: { coupon } });

function patchTeam(fields: Record<string, unknown>) {
  const meta = table.get(`TEAM#${TEAM}`, "META") as Record<string, unknown>;
  table.put(Object.fromEntries(Object.entries({ ...meta, ...fields }).filter(([, v]) => v !== undefined)));
}

/** The team comped for `months` until UNTIL, live at NOW. */
const compMonths = (months = 2, until = UNTIL) => patchTeam({ compPlan: "starter", compUntil: until, compMonths: months, compReason: "Two months on us", compBy: "op-1", compAt: new Date(NOW).toISOString() });

// In the order written: they share a time, and their IDs are random
const audits = () => [...table.items.values()].filter((i) => i.PK === `OPAUDIT#${TEAM}`);
const message = (reason: SeatSyncMessage["reason"] = "comp", id = "seats-comp-1", customer = CUSTOMER): SeatSyncMessage => ({ kind: "seats", id, customer, reason, created: NOW / 1000 });
const ours = () => (subs.get(SUB)?.discounts ?? []).map((d) => (typeof d.source?.coupon === "string" ? d.source.coupon : ""));

beforeEach(() => {
  table = new MemoryTable();
  table.seedTeam(TEAM, { "user-owner": "owner" });
  patchTeam({ name: "Echo Plumbing", plan: "starter", seats: 1, status: "active", cancelAtPeriodEnd: false, stripeCustomerId: CUSTOMER, stripeSubscriptionId: SUB });
  table.put({ PK: `STRIPE#${CUSTOMER}`, SK: "TEAM", type: "stripeLink", customerId: CUSTOMER, teamId: TEAM });
  subs = new Map([[SUB, subscription()]]);
  coupons = new Map();
  updates = [];
  created = [];
  stripeKeys = new Set();
  retrieves = [];
  stripeDown = false;
  unexpanded = false;
  denied = [];
  scopes = [];
  logs = [];
  discountSeq = 0;
  const stripe = {
    subscriptions: {
      async retrieve(id: string, params?: { expand?: string[] }) {
        retrieves.push({ id, ...(params?.expand ? { expand: params.expand } : {}) });
        if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        const found = subs.get(id);
        if (!found) throw Object.assign(new Error(`No such subscription ${id}`), { code: "resource_missing" });
        // Unexpanded, Stripe sends the discounts' IDs only
        return params?.expand?.includes("discounts") && !unexpanded ? found : { ...found, discounts: found.discounts.map((d) => d.id) };
      },
      async list() {
        return { data: [...subs.values()] };
      },
      async update(id: string, params: { discounts?: { coupon?: string; discount?: string }[] | ""; metadata?: Record<string, string> }, options: { idempotencyKey: string }) {
        if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
        // A key Stripe has seen in the last 24 hours gets the cached answer, and changes nothing
        if (stripeKeys.has(options.idempotencyKey)) return;
        stripeKeys.add(options.idempotencyKey);
        updates.push({ id, params, key: options.idempotencyKey });
        const sub = subs.get(id) as Sub;
        let discounts = sub.discounts;
        if (params.discounts === "") discounts = [];
        else if (params.discounts?.length) discounts = params.discounts.map((d) => (d.discount ? (sub.discounts.find((x) => x.id === d.discount) as DiscountLike) : discount(d.coupon as string)));
        const metadata = Object.fromEntries(Object.entries({ ...sub.metadata, ...(params.metadata ?? {}) }).filter(([, v]) => v !== ""));
        subs.set(id, { ...sub, discounts, metadata });
      },
      async cancel() {
        throw new Error("not used");
      },
    },
    subscriptionItems: {
      async update() {
        throw new Error("not used");
      },
    },
    coupons: {
      async retrieve(id: string) {
        const found = coupons.get(id);
        if (!found) throw Object.assign(new Error(`No such coupon: '${id}'`), { code: "resource_missing" });
        return found;
      },
      async create(params: { id: string; percent_off: number; duration: "repeating"; duration_in_months: number }, options: { idempotencyKey: string }) {
        created.push({ id: params.id, key: options.idempotencyKey });
        const coupon: CouponLike = { id: params.id, percent_off: params.percent_off, amount_off: null, duration: params.duration, duration_in_months: params.duration_in_months, valid: true, applies_to: undefined };
        coupons.set(params.id, coupon);
        return coupon;
      },
    },
  } as unknown as WorkerStripe & SeatStripe & EntitlementStripe & CompDiscountStripe;
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

describe("the comp coupons", () => {
  it("are one per length, 1 to 12 months, with fixed IDs", () => {
    expect([1, 2, 12].map(compCouponId)).toEqual(["supply-checkout-comp-1m", "supply-checkout-comp-2m", "supply-checkout-comp-12m"]);
    for (const bad of [0, 13, 1.5]) expect(() => compCouponId(bad)).toThrow(/1 to 12/);
  });

  it("are wanted only for a live comp made with months", () => {
    expect(wantedCompDiscount({ compLive: true, compMonths: 2, compUntil: UNTIL })).toEqual({ coupon: "supply-checkout-comp-2m", until: UNTIL });
    expect(wantedCompDiscount({ compLive: false, compMonths: 2, compUntil: UNTIL })).toBeUndefined();
    expect(wantedCompDiscount({ compLive: true, compUntil: UNTIL })).toBeUndefined();
    expect(wantedCompDiscount({ compLive: true, compMonths: 2 })).toBeUndefined();
    expect(wantedCompDiscount({ compLive: true, compMonths: 13, compUntil: UNTIL })).toBeUndefined();
  });

  it("are created once, with an idempotency key, and an existing one is used as it is", async () => {
    expect(await worker(message())).toBe("none");
    compMonths();
    expect(await worker(message("comp", "seats-comp-2"))).toBe("applied");
    expect(created).toEqual([{ id: "supply-checkout-comp-2m", key: "comp-coupon-supply-checkout-comp-2m" }]);
    patchTeam({ compUntil: "2026-12-03T12:00:00.000Z" });
    expect(await worker(message("comp", "seats-comp-3"))).toBe("applied");
    expect(created).toHaveLength(1);
  });

  it.each<[string, Partial<CouponLike>]>([
    ["50% off", { percent_off: 50 }],
    ["an amount off", { amount_off: 500 }],
    ["once, not repeating", { duration: "once" }],
    ["for other months", { duration_in_months: 3 }],
    ["no longer valid", { valid: false }],
    ["for some products only", { applies_to: { products: ["prod_1"] } }],
  ])("refuse one edited by hand: %s, and never apply it", async (_what, change) => {
    coupons.set("supply-checkout-comp-2m", { id: "supply-checkout-comp-2m", percent_off: 100, amount_off: null, duration: "repeating", duration_in_months: 2, valid: true, ...change });
    compMonths();
    await expect(worker(message())).rejects.toMatchObject({ name: "CompCouponMismatch" });
    expect(updates).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("pass on a Stripe error other than a missing coupon", async () => {
    const stripe = { coupons: { retrieve: async () => Promise.reject(Object.assign(new Error("busy"), { code: "rate_limit" })), create: async () => Promise.reject(new Error("not used")) } } as unknown as CompDiscountStripe;
    await expect(ensureCompCoupon(stripe, 2)).rejects.toThrow("busy");
  });
});

describe("a comp message (reason comp)", () => {
  it("puts a 100%-off coupon for the comp's months on a monthly subscription, stamps the comp's end, and audits it, inside the worker role", async () => {
    compMonths();
    expect(await worker(message())).toBe("applied");
    expect(retrieves).toEqual([{ id: SUB, expand: ["discounts"] }]);
    expect(updates).toEqual([
      { id: SUB, params: { discounts: [{ coupon: "supply-checkout-comp-2m" }], metadata: { [COMP_UNTIL_METADATA]: UNTIL } }, key: compDiscountKey(TEAM, SUB, "apply", UNTIL, []) },
    ]);
    expect(ours()).toEqual(["supply-checkout-comp-2m"]);
    expect(coupons.get("supply-checkout-comp-2m")).toMatchObject({ percent_off: 100, duration: "repeating", duration_in_months: 2 });
    const [audit] = audits();
    expect(audit).toMatchObject({
      type: "operatorAudit",
      action: "ops.comp.discount",
      operatorSub: BILLING_WORKER_ACTOR,
      teamId: TEAM,
      target: `team/${TEAM}`,
      before: { coupon: null },
      after: { outcome: "applied", coupon: "supply-checkout-comp-2m", until: UNTIL, subscriptionId: SUB },
      idempotencyKey: "seats-comp-1",
    });
    // Not in the operators' index: the worker's role can't name GSI3's keys
    expect(audit).not.toHaveProperty("GSI3PK");
    expect(audit).not.toHaveProperty("GSI3SK");
    // Exactly docs/api/openapi.yaml's CompDiscountBefore and CompDiscountRecord
    expect(Object.keys(audit?.before as object)).toEqual(["coupon"]);
    expect(Object.keys(audit?.after as object).sort()).toEqual(["coupon", "outcome", "subscriptionId", "until"]);
    // Kept 2 years, like every operator audit item
    expect(audit?.expiresAt).toBe(Math.floor(NOW / 1000) + 730 * 86400);
    expect(denied).toEqual([]);
    // The team comes from our link for the customer, never the message
    expect(scopes).toEqual([{ eventId: "seats-comp-1", stripeCustomer: CUSTOMER }, { eventId: "seats-comp-1", stripeCustomer: CUSTOMER, teamId: TEAM }]);
    expect(JSON.stringify(logs)).not.toMatch(/Echo Plumbing|Two months/);
    expect(logs).toContainEqual(["info", "Comp discount", { teamId: TEAM, messageId: "seats-comp-1", reason: "comp", subscriptionId: SUB, outcome: "applied", coupon: "supply-checkout-comp-2m", before: "" }]);
  });

  it("applies one coupon however often it's retried or queued again: then it's in step and sends nothing", async () => {
    compMonths();
    expect(await worker(message())).toBe("applied");
    expect(await worker(message())).toBe("in_sync");
    expect(await worker(message("comp", "seats-comp-2"))).toBe("in_sync");
    expect(updates).toHaveLength(1);
    expect(ours()).toEqual(["supply-checkout-comp-2m"]);
    expect(audits().map((a) => (a.after as { outcome: string }).outcome)).toEqual(["applied", "in_sync", "in_sync"]);
  });

  it("sends the same request with the same key when a retry finds the subscription as the first try did", () => {
    expect(compDiscountKey(TEAM, SUB, "apply", UNTIL, ["di_b", "di_a"])).toBe(compDiscountKey(TEAM, SUB, "apply", UNTIL, ["di_a", "di_b"]));
    expect(compDiscountKey(TEAM, SUB, "apply", UNTIL, [])).not.toBe(compDiscountKey(TEAM, SUB, "apply", "2027-01-01T00:00:00.000Z", []));
    expect(compDiscountKey(TEAM, SUB, "apply", UNTIL, [])).not.toBe(compDiscountKey("team-b", SUB, "apply", UNTIL, []));
    expect(compDiscountKey(TEAM, SUB, "remove", UNTIL, [])).toMatch(/^comp-remove-[0-9a-f]{64}$/);
  });

  it("replaces its discount for a changed comp, starting the months again, and keeps a discount that isn't ours", async () => {
    subs.set(SUB, subscription({ discounts: [discount("promo-spring", "di_promo")] }));
    compMonths();
    expect(await worker(message())).toBe("applied");
    expect(ours()).toEqual(["promo-spring", "supply-checkout-comp-2m"]);
    compMonths(3, "2027-01-02T12:00:00.000Z");
    expect(await worker(message("comp", "seats-comp-2"))).toBe("applied");
    expect(updates[1]?.params.discounts).toEqual([{ discount: "di_promo" }, { coupon: "supply-checkout-comp-3m" }]);
    expect(ours()).toEqual(["promo-spring", "supply-checkout-comp-3m"]);
    expect(subs.get(SUB)?.metadata).toEqual({ [COMP_UNTIL_METADATA]: "2027-01-02T12:00:00.000Z" });
    expect(audits()[1]).toMatchObject({ before: { coupon: "supply-checkout-comp-2m" }, after: { outcome: "applied", coupon: "supply-checkout-comp-3m" } });
  });

  it("removes its discount and stamp when the comp ends, keeping one that isn't ours", async () => {
    subs.set(SUB, subscription({ discounts: [discount("promo-spring", "di_promo")] }));
    compMonths();
    await worker(message());
    // What endComp leaves: only when the comp stopped
    patchTeam({ compPlan: undefined, compMonths: undefined, compReason: undefined, compBy: undefined, compAt: undefined, compUntil: new Date(NOW).toISOString() });
    expect(await worker(message("comp", "seats-comp-2"))).toBe("removed");
    expect(updates[1]?.params).toEqual({ discounts: [{ discount: "di_promo" }], metadata: { [COMP_UNTIL_METADATA]: "" } });
    expect(ours()).toEqual(["promo-spring"]);
    expect(subs.get(SUB)?.metadata).toEqual({});
    expect(audits()[1]).toMatchObject({ after: { outcome: "removed", coupon: null, until: null }, before: { coupon: "supply-checkout-comp-2m" } });
    // Nothing of ours left: nothing more to do
    expect(await worker(message("comp", "seats-comp-3"))).toBe("none");
    expect(updates).toHaveLength(2);
  });

  it("clears every discount with an empty string when ours was the only one", async () => {
    compMonths();
    await worker(message());
    patchTeam({ compMonths: undefined });
    expect(await worker(message("comp", "seats-comp-2"))).toBe("removed");
    expect(updates[1]?.params.discounts).toBe("");
    expect(ours()).toEqual([]);
  });

  it("removes its discount when the comp has run out, and leaves a stale stamp alone", async () => {
    compMonths(2, new Date(NOW - 1000).toISOString());
    subs.set(SUB, subscription({ discounts: [discount("supply-checkout-comp-2m")], metadata: { [COMP_UNTIL_METADATA]: "x" } }));
    expect(await worker(message())).toBe("removed");
    subs.set(SUB, subscription({ metadata: { [COMP_UNTIL_METADATA]: "2026-01-01T00:00:00.000Z" } }));
    expect(await worker(message("comp", "seats-comp-2"))).toBe("none");
    expect(updates).toHaveLength(1);
  });

  it("removes ours for a comp made with until, which wants none", async () => {
    patchTeam({ compPlan: "free", compUntil: UNTIL });
    subs.set(SUB, subscription({ discounts: [discount("supply-checkout-comp-6m")] }));
    expect(await worker(message())).toBe("removed");
    expect(ours()).toEqual([]);
  });

  it("never discounts a yearly subscription (a renewal in the window would be a year free), and takes ours off one", async () => {
    subs.set(SUB, subscription({}, "year"));
    compMonths();
    expect(await worker(message())).toBe("not_monthly");
    expect(updates).toEqual([]);
    expect(created).toEqual([]);
    expect(audits()[0]).toMatchObject({ after: { outcome: "not_monthly", coupon: null } });
    subs.set(SUB, subscription({ discounts: [discount("supply-checkout-comp-2m")] }, "year"));
    expect(await worker(message("comp", "seats-comp-2"))).toBe("removed");
    expect(ours()).toEqual([]);
  });

  it("never discounts a price billed every few months: each invoice would cover several", async () => {
    const base = subscription();
    subs.set(SUB, { ...base, items: { data: base.items.data.map((i) => ({ ...i, price: { ...i.price, recurring: { interval: "month", interval_count: 3 } } })) } });
    compMonths();
    expect(await worker(message())).toBe("not_monthly");
    expect(updates).toEqual([]);
  });

  it.each([["canceled"], ["incomplete_expired"], ["incomplete"]])("leaves a %s subscription alone", async (status) => {
    subs.set(SUB, subscription({ status }));
    compMonths();
    expect(await worker(message())).toBe("no_subscription");
    expect(updates).toEqual([]);
    expect(audits()[0]).toMatchObject({ after: { outcome: "no_subscription", subscriptionId: SUB } });
  });

  it("does nothing for a team with no subscription, and audits that", async () => {
    patchTeam({ stripeSubscriptionId: undefined });
    compMonths();
    expect(await worker(message())).toBe("no_subscription");
    expect(retrieves).toEqual([]);
    expect(audits()[0]).toMatchObject({ after: { outcome: "no_subscription", subscriptionId: null } });
  });

  it("never touches another customer's subscription", async () => {
    subs.set(SUB, subscription({ customer: { id: "cus_other" } }));
    compMonths();
    expect(await worker(message())).toBe("not_ours");
    expect(updates).toEqual([]);
  });

  it("skips a closed or purging team, and a team whose own customer isn't the message's, auditing why", async () => {
    compMonths();
    patchTeam({ closedAt: "2026-10-01T00:00:00.000Z" });
    expect(await worker(message())).toBe("team_closed");
    patchTeam({ closedAt: undefined, purging: "2026-10-01T00:00:00.000Z" });
    expect(await worker(message("comp", "seats-comp-2"))).toBe("team_closed");
    patchTeam({ purging: undefined, stripeCustomerId: "cus_other" });
    expect(await worker(message("comp", "seats-comp-3"))).toBe("not_ours");
    expect(retrieves).toEqual([]);
    expect(audits().map((a) => (a.after as { outcome: string }).outcome)).toEqual(["team_closed", "team_closed", "not_ours"]);
    expect(logs).toContainEqual(["warn", "Comp discount skipped: the team has another Stripe customer", { teamId: TEAM, messageId: "seats-comp-3" }]);
    expect(denied).toEqual([]);
  });

  it("does nothing for an unknown customer or a team that's gone, with nowhere to audit", async () => {
    expect(await worker(message("comp", "seats-comp-1", "cus_unknown"))).toBe("unknown_customer");
    table.items.delete([...table.items.entries()].find(([, i]) => i.PK === `TEAM#${TEAM}` && i.SK === "META")?.[0] as string);
    expect(await worker(message())).toBe("team_gone");
    expect(audits()).toEqual([]);
  });

  it("throws on a Stripe failure, so the message is retried (then the seat sync dead-letter queue)", async () => {
    compMonths();
    stripeDown = true;
    await expect(worker(message())).rejects.toThrow("Stripe is down");
    expect(audits()).toEqual([]);
  });

  it("changes nothing if Stripe didn't expand the discounts: it couldn't tell ours apart", async () => {
    subs.set(SUB, subscription({ discounts: [discount("promo-spring")] }));
    unexpanded = true;
    compMonths();
    await expect(worker(message())).rejects.toMatchObject({ name: "DiscountsNotExpanded" });
    expect(updates).toEqual([]);
  });
});

describe("the nightly reconciliation", () => {
  it("puts a missing discount right after the seat sync, and audits the change", async () => {
    compMonths();
    expect(await worker(message("reconcile", "reconcile-1"))).toBe("in_sync");
    expect(ours()).toEqual(["supply-checkout-comp-2m"]);
    expect(audits()).toEqual([expect.objectContaining({ action: "ops.comp.discount", after: expect.objectContaining({ outcome: "applied" }), idempotencyKey: "reconcile-1" })]);
    expect(denied).toEqual([]);
  });

  it("removes a discount whose comp has ended (a comp message that never arrived)", async () => {
    subs.set(SUB, subscription({ discounts: [discount("supply-checkout-comp-2m")] }));
    patchTeam({ compUntil: new Date(NOW - 1000).toISOString() });
    await worker(message("reconcile", "reconcile-1"));
    expect(ours()).toEqual([]);
    expect(audits()).toHaveLength(1);
  });

  it("audits nothing when it's in step, and doesn't look at a team never comped", async () => {
    compMonths();
    await worker(message());
    await worker(message("reconcile", "reconcile-1"));
    expect(audits()).toHaveLength(1);
    patchTeam({ compPlan: undefined, compUntil: undefined, compMonths: undefined });
    retrieves.length = 0;
    await worker(message("reconcile", "reconcile-2"));
    expect(retrieves.filter((r) => r.expand)).toEqual([]);
  });
});
