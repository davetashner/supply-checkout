// The lapsed-team job (src/ops/team-lapse-handler.ts, supply-checkout-qdx)
// against the in-memory table, each call passing only what its role allows
// (lapsePolicy in ops-policy.ts), with a fake Stripe and mailer. The closure
// it makes is the one the purge deletes (closing.test.ts runs the purge
// against DynamoDB Local); here the test checks the team is in the purge's
// index, due a day later.

import { beforeEach, describe, expect, it } from "vitest";
import type { SubscriptionLike } from "../src/billing/subscription.js";
import { deletionLastDay, deletionTime, LAPSE_CHECKOUT_GUARD_HOURS, LAPSE_PURGE_DELAY_HOURS, LAPSE_WARNING_DAYS, LAPSED_CLOSER } from "../src/data/index.js";
import { BusinessMetric, type BusinessMetricName, type Metadata, type Observability, skippedForTest } from "../src/observability/index.js";
import { LAPSE_BUDGET_MS, LAPSE_CHECKOUT_MAX_DELAY_DAYS, LAPSE_LEASE_MS, LAPSE_MAX_CLOSURES_PER_RUN } from "../src/ops/names.js";
import { createTeamLapseHandler, type LapseStripe } from "../src/ops/team-lapse-handler.js";
import { fakeMailer, REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";
import { lapsePolicy } from "./ops-policy.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let table: MemoryTable;
let denied: { command: string; input: Record<string, unknown> }[];
let mails: ReturnType<typeof fakeMailer>;
let counts: [string, number, Record<string, unknown>][];
let gauges: Record<string, number>;
let logs: [string, string, Record<string, unknown>][];
let subs: Map<string, SubscriptionLike>;
let customers: Set<string>;
let stripeCalls: string[];
let stripeDown: boolean;
let onStripe: (() => void) | undefined;
let hasMore: boolean;
let openCheckouts: Set<string>;

function obs(): Observability {
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push([level, message, data]);
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1, metadata = {}) => counts.push([metric, value, metadata as Record<string, unknown>]),
    gauge: (metric, value) => {
      gauges[metric] = value;
    },
    flush: () => {},
  };
}

const stripe: LapseStripe = {
  subscriptions: {
    async retrieve(id) {
      stripeCalls.push(`retrieve ${id}`);
      onStripe?.();
      if (stripeDown) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
      const sub = subs.get(id);
      if (!sub) throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
      return sub;
    },
    async list({ customer }) {
      stripeCalls.push(`list ${customer}`);
      if (!customers.has(customer)) throw Object.assign(new Error("No such customer"), { code: "resource_missing" });
      return { data: [...subs.values()].filter((s) => (typeof s.customer === "string" ? s.customer : s.customer.id) === customer), has_more: hasMore };
    },
  },
  checkout: {
    sessions: {
      async list({ customer, status }) {
        stripeCalls.push(`sessions ${customer} ${status}`);
        return { data: openCheckouts.has(customer) ? [{ id: `cs_${customer}` }] : [] };
      },
    },
  },
};

const sub = (id: string, customer: string, status: string): SubscriptionLike =>
  ({ id, customer, status, cancel_at_period_end: false, trial_end: null, default_payment_method: null, items: { data: [] } }) as SubscriptionLike;

/** A team in the table and the operators' index, with two owners (one without an address) and a contributor. */
function team(teamId: string, fields: Record<string, unknown>) {
  table.put({ PK: `TEAM#${teamId}`, SK: "META", GSI3PK: "OPS#TEAMS", GSI3SK: teamId, type: "team", teamId, name: `Name of ${teamId}`, homeRegion: REGION, owners: 2, version: 3, createdAt: iso(NOW - 400 * DAY), ...fields });
  table.put({ PK: `TEAM#${teamId}`, SK: "MEMBER#owner-1", GSI3PK: `OPS#OWNERS#${teamId}`, GSI3SK: "owner-1", type: "member", role: "owner", userId: "owner-1", email: `owner1.${teamId}@example.com` });
  table.put({ PK: `TEAM#${teamId}`, SK: "MEMBER#owner-2", GSI3PK: `OPS#OWNERS#${teamId}`, GSI3SK: "owner-2", type: "member", role: "owner", userId: "owner-2", email: `owner2.${teamId}@example.com` });
  table.put({ PK: `TEAM#${teamId}`, SK: "MEMBER#crew", type: "member", role: "contributor", userId: "crew", email: `crew.${teamId}@example.com` });
}

const meta = (teamId: string) => table.get(`TEAM#${teamId}`, "META") as Record<string, unknown>;
const run = (at = NOW, random = () => 0) => createTeamLapseHandler({ db: table.guarded(lapsePolicy(denied)), obs: obs(), mailer: mails.mailer, stripe: async () => stripe, now: () => at, random })();
const sentTo = (teamId: string) => mails.sent.filter((m) => m.tags.teamId === teamId);
const counted = (metric: string) => counts.filter(([m]) => m === metric).reduce((n, [, v]) => n + v, 0);

beforeEach(() => {
  table = new MemoryTable();
  denied = [];
  mails = fakeMailer();
  counts = [];
  gauges = {};
  logs = [];
  subs = new Map();
  customers = new Set();
  stripeCalls = [];
  stripeDown = false;
  onStripe = undefined;
  hasMore = false;
  openCheckouts = new Set();
});

describe("the app's own trial", () => {
  it("emails each owner once when it ends within 3 days, and not before, or for a Stripe trial", async () => {
    team("soon", { status: "trialing", trialEndsAt: iso(NOW + 2 * DAY) });
    team("later", { status: "trialing", trialEndsAt: iso(NOW + 4 * DAY) });
    team("stripe", { status: "trialing", trialEndsAt: iso(NOW + 2 * DAY), stripeSubscriptionId: "sub_s", stripeCustomerId: "cus_s" });
    team("comped", { status: "trialing", trialEndsAt: iso(NOW + 2 * DAY), compPlan: "starter", compUntil: iso(NOW + 30 * DAY) });
    // The comped one isn't even listed; the Stripe trial is, and read again
    expect(await run()).toEqual({ checked: 2, closed: 0, failed: 0, held: 0 });
    expect(mails.sent.map((m) => [m.to, m.input])).toEqual([
      ["owner1.soon@example.com", { kind: "trialEnding", teamName: "Name of soon", trialEndsAt: iso(NOW + 2 * DAY) }],
      ["owner2.soon@example.com", { kind: "trialEnding", teamName: "Name of soon", trialEndsAt: iso(NOW + 2 * DAY) }],
    ]);
    // The next hour's run sends nothing again
    await run(NOW + 3_600_000);
    expect(mails.sent).toHaveLength(2);
    expect(counted(BusinessMetric.LapseNotices)).toBe(2);
    expect(denied).toEqual([]);
  });

  it("tells owners it's read-only when it ends, with the deletion date, then warns 7 days ahead and closes it for the purge", async () => {
    const end = NOW - DAY;
    team("ended", { status: "trialing", trialEndsAt: iso(end) });
    await run();
    // 30 days on, rounded up to the end of that date everywhere: noon UTC the day after, and the emails say "after October 31"
    const deletes = iso(deletionTime(end + 30 * DAY));
    expect(deletes).toBe("2026-11-01T12:00:00.000Z");
    expect(deletionLastDay(deletes)).toBe("2026-10-31");
    expect(sentTo("ended").map((m) => m.input)).toEqual([
      { kind: "readOnly", teamName: "Name of ended", reason: "trial_ended", deletesAt: deletes },
      { kind: "readOnly", teamName: "Name of ended", reason: "trial_ended", deletesAt: deletes },
    ]);
    expect(gauges[BusinessMetric.LapseTeamsReadOnly]).toBe(1);
    // Nothing more until 8 days before the date (a day early, so the first hourly run in the window still warns 7 days ahead)
    mails.sent.length = 0;
    await run(Date.parse(deletes) - 8 * DAY - 1);
    expect(mails.sent).toEqual([]);
    // That run comes some minutes after the window opens: the warning states the same date as the read-only email
    const warnAt = Date.parse(deletes) - 8 * DAY + 37 * 60_000;
    await run(warnAt);
    expect(mails.sent.map((m) => m.input)).toEqual([
      { kind: "deletionWarning", teamName: "Name of ended", deletesAt: deletes },
      { kind: "deletionWarning", teamName: "Name of ended", deletesAt: deletes },
    ]);
    expect(table.get("LAPSE#ended", `WARNED#${deletes}`)).toMatchObject({ sentAt: iso(warnAt) });
    // Not on the date the owners were told, anywhere: not at the 30 days, nor on the evening of October 31 in Hawaii
    for (const early of [end + 30 * DAY, Date.parse("2026-11-01T09:59:59.999Z"), Date.parse(deletes) - 1]) {
      await run(early);
      expect(meta("ended").closedAt, iso(early)).toBeUndefined();
    }
    // Once it's over everywhere: closed, in the purge's index
    const at = Date.parse(deletes);
    expect(await run(at)).toEqual({ checked: 1, closed: 1, failed: 0, held: 0 });
    // Deleted by the purge a day later, so an operator can still reopen it if it was closed by mistake
    const purge = iso(at + LAPSE_PURGE_DELAY_HOURS * 3_600_000);
    expect(meta("ended")).toMatchObject({ closedAt: iso(at), closedBy: LAPSED_CLOSER, purgeAfter: purge, GSI1PK: "TEAMS#CLOSED", GSI1SK: `${purge}#ended`, version: 4 });
    expect(stripeCalls).toEqual([]);
    expect(counted(BusinessMetric.LapsedTeamsClosed)).toBe(1);
    expect(mails.sent).toHaveLength(2);
    // Closed: never listed again
    expect(await run(at + DAY)).toEqual({ checked: 0, closed: 0, failed: 0, held: 0 });
    expect(denied).toEqual([]);
  });

  it("gives a team found long past its date (from before this job, or comped until now) a full 7 days' warning", async () => {
    team("old", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    await run();
    // 7 days from now (October 9), rounded up: noon UTC October 10
    const deletes = iso(deletionTime(NOW + LAPSE_WARNING_DAYS * DAY));
    expect(deletes).toBe(iso(NOW + 8 * DAY));
    expect(sentTo("old").map((m) => m.input)).toEqual([
      { kind: "readOnly", teamName: "Name of old", reason: "trial_ended", deletesAt: deletes },
      { kind: "readOnly", teamName: "Name of old", reason: "trial_ended", deletesAt: deletes },
      { kind: "deletionWarning", teamName: "Name of old", deletesAt: deletes },
      { kind: "deletionWarning", teamName: "Name of old", deletesAt: deletes },
    ]);
    await run(NOW + 8 * DAY - 1);
    expect(meta("old").closedAt).toBeUndefined();
    await run(NOW + 8 * DAY);
    expect(meta("old").closedBy).toBe(LAPSED_CLOSER);
  });

  it("asks Stripe about a customer from an abandoned checkout before closing", async () => {
    team("abandoned", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY), stripeCustomerId: "cus_a" });
    customers.add("cus_a");
    subs.set("sub_old", sub("sub_old", "cus_a", "incomplete_expired"));
    await run();
    await run(NOW + 8 * DAY);
    expect(stripeCalls).toEqual(["list cus_a", "sessions cus_a open"]);
    expect(meta("abandoned").closedBy).toBe(LAPSED_CLOSER);
  });
});

describe("an ended subscription", () => {
  const ended = NOW - 40 * DAY;
  const deletes = iso(deletionTime(ended + 30 * DAY));
  beforeEach(() => {
    team("gone", { status: "canceled", subscriptionEndedAt: iso(ended), stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    customers.add("cus_1");
    subs.set("sub_1", sub("sub_1", "cus_1", "canceled"));
  });

  it("warns (no read-only email: the billing worker sent it), then closes once Stripe confirms nothing is live", async () => {
    await run();
    const floor = iso(deletionTime(NOW + 7 * DAY));
    expect(sentTo("gone").map((m) => m.input)).toEqual([
      { kind: "deletionWarning", teamName: "Name of gone", deletesAt: floor },
      { kind: "deletionWarning", teamName: "Name of gone", deletesAt: floor },
    ]);
    expect(Date.parse(deletes)).toBeLessThan(Date.parse(floor));
    expect(await run(NOW + 8 * DAY - 1)).toMatchObject({ closed: 0 });
    expect(await run(NOW + 8 * DAY)).toMatchObject({ closed: 1 });
    expect(stripeCalls).toEqual(["retrieve sub_1", "list cus_1", "sessions cus_1 open"]);
    expect(denied).toEqual([]);
  });

  it("doesn't close while Stripe has a live subscription for the customer, or disagrees about the team's, and counts it for a person", async () => {
    await run();
    const later = NOW + 8 * DAY;
    for (const [setup, why] of [
      [() => subs.set("sub_2", sub("sub_2", "cus_1", "active")), "SubscriptionLive"],
      [() => subs.set("sub_2", sub("sub_2", "cus_1", "unpaid")), "SubscriptionLive"],
      [() => subs.set("sub_1", sub("sub_1", "cus_1", "past_due")), "SubscriptionLive"],
      [() => subs.set("sub_1", sub("sub_1", "cus_other", "canceled")), "CustomerMismatch"],
      [() => subs.delete("sub_1"), "SubscriptionNotFound"],
      [() => customers.delete("cus_1"), "CustomerNotFound"],
      // More subscriptions than one page: a live one could be further down
      [() => (hasMore = true), "TooManySubscriptions"],
      // An owner in Checkout right now: paying would subscribe a team about to be deleted
    ] as const) {
      hasMore = false;
      openCheckouts.clear();
      subs.clear();
      customers.add("cus_1");
      subs.set("sub_1", sub("sub_1", "cus_1", "canceled"));
      counts = [];
      setup();
      expect(await run(later)).toMatchObject({ closed: 0, failed: 1 });
      expect(counts.find(([m]) => m === BusinessMetric.LapseFailures)?.[2]).toMatchObject({ teamId: "gone", step: "stripe", why });
      expect(meta("gone").closedAt).toBeUndefined();
    }
    // An owner in Checkout right now: not closed, and not a fault (not counted), until the session completes or expires
    hasMore = false;
    subs.clear();
    customers.add("cus_1");
    subs.set("sub_1", sub("sub_1", "cus_1", "canceled"));
    openCheckouts.add("cus_1");
    counts = [];
    expect(await run(later)).toMatchObject({ closed: 0, failed: 0 });
    expect(counted(BusinessMetric.LapseFailures)).toBe(0);
    expect(meta("gone").closedAt).toBeUndefined();
    expect(logs.some(([, message, data]) => message === "Lapsed team not closed: an owner has Checkout open" && data.teamId === "gone")).toBe(true);
    openCheckouts.clear();
    expect(await run(later)).toMatchObject({ closed: 1 });
    const line = logs.find(([, message]) => message === "Lapsed team not closed: Stripe disagrees");
    expect(line?.[2]).toMatchObject({ teamId: "gone", recordedSubscriptionId: "sub_1", customerId: "cus_1" });
  });

  it("leaves a team that changed between the read and the closure (a Stripe event, a comp, a customer linked) for the next run", async () => {
    await run();
    onStripe = () => table.put({ ...meta("gone"), version: 9 });
    expect(await run(NOW + 8 * DAY)).toEqual({ checked: 1, closed: 0, failed: 0, held: 0 });
    expect(meta("gone").closedAt).toBeUndefined();
    // A customer linked at Checkout moves the version too (linkStripeCustomer; team-lapse-ddb.test.ts runs the real one)
    onStripe = () => table.put({ ...meta("gone"), stripeCustomerId: "cus_new", version: 10 });
    expect(await run(NOW + 8 * DAY)).toEqual({ checked: 1, closed: 0, failed: 0, held: 0 });
    expect(meta("gone").closedAt).toBeUndefined();
    expect(logs.some(([, message]) => message === "Lapsed team changed before it was closed: left for the next run")).toBe(true);
  });

  it("doesn't close a team within a day of an owner starting Checkout, even when Stripe shows no session (supply-checkout-qdx)", async () => {
    await run();
    const later = NOW + 8 * DAY;
    // Checkout started an hour ago: linkStripeCustomer recorded it (and moved the version, read here as it is)
    table.put({ ...meta("gone"), stripeCheckoutAt: iso(later - 3_600_000), version: 7 });
    expect(await run(later)).toMatchObject({ closed: 0, failed: 0 });
    expect(meta("gone").closedAt).toBeUndefined();
    // Held before any Stripe call (supply-checkout-8jc.45), and counted, not as a failure
    expect(stripeCalls).toEqual([]);
    expect(counts.find(([m]) => m === BusinessMetric.LapseCheckoutHeld)?.[2]).toEqual({ teamId: "gone", why: "recent" });
    expect(counted(BusinessMetric.LapseFailures)).toBe(0);
    expect(await run(later - 3_600_000 + LAPSE_CHECKOUT_GUARD_HOURS * 3_600_000 - 1)).toMatchObject({ closed: 0 });
    expect(await run(later - 3_600_000 + LAPSE_CHECKOUT_GUARD_HOURS * 3_600_000 + 1)).toMatchObject({ closed: 1 });
    expect(denied).toEqual([]);
  });

  describe("held by an owner's Checkout (supply-checkout-8jc.45)", () => {
    // Warned at NOW, so it closes 7 days on, rounded up
    const closes = deletionTime(NOW + 7 * DAY);
    const cap = closes + LAPSE_CHECKOUT_MAX_DELAY_DAYS * DAY;
    const failures = () => counts.filter(([m]) => m === BusinessMetric.LapseFailures).map(([, , metadata]) => metadata);

    const overdue = () => counts.filter(([m]) => m === BusinessMetric.LapseCheckoutOverdue).map(([, , metadata]) => metadata);

    it("an owner who starts Checkout every day keeps it read-only, but past the cap it's counted on its own for a person, never closed", async () => {
      await run();
      for (let at = closes; at < cap; at += DAY) {
        table.put({ ...meta("gone"), stripeCheckoutAt: iso(at - 3_600_000) });
        counts = [];
        expect(await run(at)).toMatchObject({ closed: 0, failed: 0 });
        expect(counted(BusinessMetric.LapseCheckoutHeld)).toBe(1);
        expect(overdue()).toEqual([]);
      }
      table.put({ ...meta("gone"), stripeCheckoutAt: iso(cap - 3_600_000) });
      counts = [];
      expect(await run(cap)).toMatchObject({ closed: 0, failed: 0 });
      expect(counted(BusinessMetric.LapseCheckoutHeld)).toBe(1);
      expect(overdue()).toEqual([{ teamId: "gone", why: "recent" }]);
      // Not a failure: "Lapsed-team job failing" stays free for other teams' faults
      expect(failures()).toEqual([]);
      expect(logs.find(([, message]) => message === "Lapsed team held by Checkout too long past its date")?.[2]).toEqual({
        teamId: "gone",
        why: "recent",
        deletesAt: iso(closes),
        customerId: "cus_1",
        stripeCheckoutAt: iso(cap - 3_600_000),
      });
      expect(meta("gone").closedAt).toBeUndefined();
      expect(stripeCalls).toEqual([]);
      // Once the owner stops, it closes
      expect(await run(cap + LAPSE_CHECKOUT_GUARD_HOURS * 3_600_000)).toMatchObject({ closed: 1 });
      expect(denied).toEqual([]);
    });

    it("a session open in Stripe holds it the same way, with or without a Checkout the app recorded", async () => {
      await run();
      openCheckouts.add("cus_1");
      expect(await run(cap - 1)).toMatchObject({ closed: 0, failed: 0 });
      expect(counts.find(([m]) => m === BusinessMetric.LapseCheckoutHeld)?.[2]).toEqual({ teamId: "gone", why: "open" });
      expect(await run(cap)).toMatchObject({ closed: 0, failed: 0 });
      expect(overdue()).toEqual([{ teamId: "gone", why: "open" }]);
      expect(failures()).toEqual([]);
      const held = () => logs.filter(([, message]) => message === "Lapsed team held by Checkout too long past its date").map(([, , data]) => data);
      expect(held()).toEqual([{ teamId: "gone", why: "open", deletesAt: iso(closes), customerId: "cus_1" }]);
      // An older Checkout the app recorded is logged with it
      table.put({ ...meta("gone"), stripeCheckoutAt: iso(NOW) });
      expect(await run(cap)).toMatchObject({ closed: 0, failed: 0 });
      expect(held()[1]).toEqual({ teamId: "gone", why: "open", deletesAt: iso(closes), customerId: "cus_1", stripeCheckoutAt: iso(NOW) });
      expect(meta("gone").closedAt).toBeUndefined();
    });

    it("counts a last Checkout time that isn't a past date, which would hold it for good, without asking Stripe", async () => {
      await run();
      // Dates that parse but aren't the exact ISO 8601 linkStripeCustomer writes, which the closure's condition compares as strings
      const loose = ["2026-10-02", "2026-10-02T12:00:00Z", new Date(NOW).toUTCString()];
      for (const bad of ["not a date", iso(closes + 6 * 60_000), 1_700_000_000, ...loose]) {
        table.put({ ...meta("gone"), stripeCheckoutAt: bad });
        counts = [];
        expect(await run(closes)).toMatchObject({ closed: 0, failed: 1 });
        expect(failures()).toEqual([{ teamId: "gone", step: "badCheckoutAt" }]);
      }
      expect(logs.filter(([, message]) => message === "Lapsed team's last Checkout time isn't a past date, so it can't be closed").map(([, , data]) => data.stripeCheckoutAt)).toEqual(["not a date", iso(closes + 6 * 60_000), "", ...loose]);
      // A few minutes ahead is the billing function's clock: held as a Checkout just started
      table.put({ ...meta("gone"), stripeCheckoutAt: iso(closes + 4 * 60_000) });
      counts = [];
      expect(await run(closes)).toMatchObject({ closed: 0, failed: 0 });
      expect(counted(BusinessMetric.LapseCheckoutHeld)).toBe(1);
      expect(stripeCalls).toEqual([]);
      expect(meta("gone").closedAt).toBeUndefined();
      expect(denied).toEqual([]);
    });
  });

  it("counts a Stripe failure and still handles the other teams", async () => {
    team("trial", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    await run();
    stripeDown = true;
    expect(await run(NOW + 8 * DAY)).toEqual({ checked: 2, closed: 1, failed: 1, held: 0 });
    expect(meta("trial").closedBy).toBe(LAPSED_CLOSER);
    expect(logs.find(([level]) => level === "error")?.[2]).toMatchObject({ teamId: "gone", error: "StripeConnectionError" });
  });

  it("never dates an ended team without subscriptionEndedAt (the nightly check records it first), but counts it for a person", async () => {
    table.put(Object.fromEntries(Object.entries(meta("gone")).filter(([k]) => k !== "subscriptionEndedAt")));
    expect(await run(NOW + 400 * DAY)).toMatchObject({ closed: 0, failed: 1 });
    expect(counts.find(([m]) => m === BusinessMetric.LapseFailures)?.[2]).toMatchObject({ teamId: "gone", step: "undated" });
    expect(mails.sent).toEqual([]);
    expect(meta("gone").closedAt).toBeUndefined();
  });

  it("never closes a team whose warning record has no readable time (none this job writes), and counts it", async () => {
    await run();
    const [key] = [...table.items.values()].filter((i) => String(i.PK) === "LAPSE#gone" && String(i.SK).startsWith("WARNED#"));
    table.put({ ...(key as Record<string, unknown>), sentAt: "not a date" });
    expect(await run(NOW + 400 * DAY)).toMatchObject({ closed: 0, failed: 1 });
    expect(counts.find(([m]) => m === BusinessMetric.LapseFailures)?.[2]).toMatchObject({ teamId: "gone", step: "badDate" });
    expect(meta("gone").closedAt).toBeUndefined();
  });

  it("never closes a team without a version (none this app writes), and counts it", async () => {
    await run();
    table.put(Object.fromEntries(Object.entries(meta("gone")).filter(([k]) => k !== "version")));
    expect(await run(NOW + 8 * DAY)).toMatchObject({ closed: 0, failed: 1 });
    expect(counts.find(([m]) => m === BusinessMetric.LapseFailures)?.[2]).toMatchObject({ teamId: "gone", step: "noVersion" });
    expect(meta("gone").closedAt).toBeUndefined();
  });
});

describe("the deletion warning", () => {
  it("is retried each day until an owner gets it, and the 7 days start only then", async () => {
    team("quiet", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    mails.state.fail = "MessageRejected";
    expect(await run()).toMatchObject({ failed: 1 });
    expect(counts.find(([m, , d]) => m === BusinessMetric.LapseFailures && d.step === "warning")).toBeDefined();
    expect(counted(BusinessMetric.LapseNoticeFailures)).toBe(4);
    // Same day: already claimed (and counted), so nothing is sent, it's still unwarned, and it isn't counted again
    expect(await run(NOW + 3_600_000)).toMatchObject({ failed: 0, closed: 0 });
    mails.state.fail = undefined;
    const next = NOW + DAY;
    await run(next);
    expect(mails.sent.map((m) => m.input)).toEqual([
      { kind: "deletionWarning", teamName: "Name of quiet", deletesAt: iso(deletionTime(next + 7 * DAY)) },
      { kind: "deletionWarning", teamName: "Name of quiet", deletesAt: iso(deletionTime(next + 7 * DAY)) },
    ]);
    await run(deletionTime(NOW + 7 * DAY));
    expect(meta("quiet").closedAt).toBeUndefined();
    await run(deletionTime(next + 7 * DAY));
    expect(meta("quiet").closedBy).toBe(LAPSED_CLOSER);
  });

  it("counts a lapsed team with no owners in the index as failed every run, and never closes it unwarned", async () => {
    team("orphan", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    for (const id of ["owner-1", "owner-2"]) table.delete(`TEAM#orphan`, `MEMBER#${id}`);
    for (const at of [NOW, NOW + 3_600_000, NOW + 30 * DAY]) {
      counts = [];
      expect(await run(at)).toMatchObject({ closed: 0, failed: 1 });
      expect(counts.find(([m]) => m === BusinessMetric.LapseFailures)?.[2]).toMatchObject({ teamId: "orphan", step: "noOwners" });
    }
    expect(logs.some(([level, message, data]) => level === "warn" && message === "Lapsed team has no owners to warn" && data.teamId === "orphan")).toBe(true);
    expect(table.get("LAPSE#orphan", `WARNED#${iso(deletionTime(NOW - 170 * DAY))}`)).toBeUndefined();
    expect(meta("orphan").closedAt).toBeUndefined();
    expect(mails.sent).toEqual([]);
  });
});

describe("the closure cap", () => {
  it(`closes at most ${LAPSE_MAX_CLOSURES_PER_RUN} teams a run, holds the rest for the next run, and counts them`, async () => {
    const ids = Array.from({ length: LAPSE_MAX_CLOSURES_PER_RUN + 3 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    for (const id of ids) team(id, { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    await run();
    const due = deletionTime(NOW + 7 * DAY);
    expect(await run(due)).toMatchObject({ closed: LAPSE_MAX_CLOSURES_PER_RUN, held: 3, failed: 0 });
    expect(counted(BusinessMetric.LapseClosuresHeld)).toBe(3);
    expect(counted(BusinessMetric.LapsedTeamsClosed)).toBe(LAPSE_MAX_CLOSURES_PER_RUN);
    expect(ids.filter((id) => meta(id).closedAt !== undefined)).toHaveLength(LAPSE_MAX_CLOSURES_PER_RUN);
    expect(logs.some(([level, message, data]) => level === "warn" && message.startsWith("Lapsed-team job held teams at its closure cap") && data.held === 3)).toBe(true);
    // The next run closes the rest
    expect(await run(due + 3_600_000)).toMatchObject({ closed: 3, held: 0 });
    expect(ids.every((id) => meta(id).closedBy === LAPSED_CLOSER)).toBe(true);
  });

  it("holds before asking Stripe, and a team left open (an owner in Checkout) doesn't count toward it", async () => {
    const ids = Array.from({ length: LAPSE_MAX_CLOSURES_PER_RUN + 1 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    for (const id of ids) team(id, { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    // The first one listed has a Stripe customer in Checkout
    table.put({ ...meta("t00"), stripeCustomerId: "cus_t00" });
    customers.add("cus_t00");
    openCheckouts.add("cus_t00");
    await run();
    expect(await run(deletionTime(NOW + 7 * DAY))).toMatchObject({ closed: LAPSE_MAX_CLOSURES_PER_RUN, held: 0, failed: 0 });
    expect(meta("t00").closedAt).toBeUndefined();
  });
});

describe("what the job never deletes", () => {
  it("leaves comped, closed, unpaid, overdue and active teams alone, telling owners of an overdue payment once", async () => {
    team("comped", { status: "canceled", subscriptionEndedAt: iso(NOW - 90 * DAY), compPlan: "starter", compUntil: iso(NOW + 365 * DAY) });
    team("closed", { status: "trialing", trialEndsAt: iso(NOW - 90 * DAY), closedAt: iso(NOW - DAY), purgeAfter: iso(NOW + 29 * DAY), stripeSetAsideFor: iso(NOW - DAY) });
    team("unpaid", { status: "unpaid", stripeSubscriptionId: "sub_u", stripeCustomerId: "cus_u" });
    team("overdue", { status: "past_due", pastDueSince: iso(NOW - 8 * DAY), stripeSubscriptionId: "sub_o", stripeCustomerId: "cus_o" });
    team("grace", { status: "past_due", pastDueSince: iso(NOW - 2 * DAY), stripeSubscriptionId: "sub_g", stripeCustomerId: "cus_g" });
    team("active", { status: "active", stripeSubscriptionId: "sub_a", stripeCustomerId: "cus_a" });
    for (const at of [NOW, NOW + 3 * DAY]) await run(at);
    expect(mails.sent.map((m) => [m.tags.teamId, m.input])).toEqual([
      ["overdue", { kind: "readOnly", teamName: "Name of overdue", reason: "payment_overdue" }],
      ["overdue", { kind: "readOnly", teamName: "Name of overdue", reason: "payment_overdue" }],
    ]);
    for (const id of ["comped", "unpaid", "overdue", "grace", "active"]) expect(meta(id).closedAt, id).toBeUndefined();
    // Long after: still nothing closed but the comp's end starts the comped team's clock
    await run(NOW + 400 * DAY);
    for (const id of ["unpaid", "overdue", "active"]) expect(meta(id).closedAt, id).toBeUndefined();
    expect(meta("closed")).toMatchObject({ closedAt: iso(NOW - DAY), purgeAfter: iso(NOW + 29 * DAY) });
    expect(stripeCalls).toEqual([]);
    expect(denied).toEqual([]);
  });
});

describe("the run", () => {
  it("sends its gauges every run, zero included, and logs no names or emails", async () => {
    await run();
    expect(gauges).toEqual({ [BusinessMetric.LapseTeamsChecked]: 0, [BusinessMetric.LapseTeamsReadOnly]: 0, [BusinessMetric.LapseTeamsUnstarted]: 0 });
    team("old", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    await run();
    await run(NOW + 8 * DAY);
    expect(JSON.stringify(logs)).not.toMatch(/example\.com|Name of/);
    expect(JSON.stringify(counts)).not.toMatch(/example\.com|Name of/);
  });

  it("starts no team after its budget, and counts only those it checked", async () => {
    team("a", { status: "trialing", trialEndsAt: iso(NOW - DAY) });
    team("b", { status: "trialing", trialEndsAt: iso(NOW - DAY) });
    // Each run has time for one team, and starts at a random place in the list, so it isn't always "b" that's left
    const started = (random: number) => {
      let t = NOW;
      return createTeamLapseHandler({ db: table.guarded(lapsePolicy(denied)), obs: obs(), mailer: mails.mailer, stripe: async () => stripe, now: () => (t += LAPSE_BUDGET_MS), random: () => random })();
    };
    expect(await started(0)).toEqual({ checked: 1, closed: 0, failed: 0, held: 0 });
    expect(logs.some(([, message, data]) => message.startsWith("Lapsed-team job ran out of time") && data.unstarted === 1)).toBe(true);
    expect(gauges[BusinessMetric.LapseTeamsUnstarted]).toBe(1);
    expect(sentTo("a")).toHaveLength(2);
    expect(sentTo("b")).toHaveLength(0);
    expect(await started(0.99)).toMatchObject({ checked: 1 });
    expect(sentTo("b")).toHaveLength(2);
    expect(gauges[BusinessMetric.LapseTeamsUnstarted]).toBe(1);
  });

  it("runs one at a time: an invocation while another holds the lease does nothing, and a lease that ran out is taken over", async () => {
    team("old", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    // Another run holds it (a retry, a duplicate delivery, or one started by hand)
    table.put({ PK: "LAPSE#RUN", SK: "LEASE", type: "lapseLease", sentAt: iso(NOW - 60_000), expiresAt: Math.ceil((NOW + 60_000) / 1000) });
    expect(await run()).toEqual({ checked: 0, closed: 0, failed: 0, held: 0, skipped: true });
    expect(mails.sent).toEqual([]);
    expect(gauges).toEqual({});
    expect(logs.some(([level, message]) => level === "warn" && message.startsWith("Lapsed-team job skipped"))).toBe(true);
    // Run out (a run that died): taken over, and given up at the end
    expect(await run(NOW + 120_000)).toMatchObject({ checked: 1 });
    expect(table.get("LAPSE#RUN", "LEASE")).toMatchObject({ sentAt: iso(NOW + 120_000), expiresAt: 0 });
    expect(denied).toEqual([]);
  });

  it("returns the run's result when the lease can't be given up, which then runs out by itself", async () => {
    team("old", { status: "trialing", trialEndsAt: iso(NOW - DAY) });
    const policy = lapsePolicy(denied);
    const db = table.guarded((command, input) => !(command === "PutCommand" && (input.Item as Record<string, unknown>).expiresAt === 0) && policy(command, input));
    const result = await createTeamLapseHandler({ db, obs: obs(), mailer: mails.mailer, stripe: async () => stripe, now: () => NOW, random: () => 0 })();
    expect(result).toEqual({ checked: 1, closed: 0, failed: 0, held: 0 });
    expect(logs.find(([, message]) => message === "Lapsed-team job's lease not released")).toEqual(["warn", "Lapsed-team job's lease not released", { error: "AccessDeniedException" }]);
    expect(table.get("LAPSE#RUN", "LEASE")).toMatchObject({ sentAt: iso(NOW), expiresAt: Math.ceil((NOW + LAPSE_LEASE_MS) / 1000) });
    // The next hour's run takes it over
    expect(await run(NOW + 3_600_000)).not.toHaveProperty("skipped");
  });

  it("skips a second invocation that starts while the first is still running", async () => {
    team("gone", { status: "canceled", subscriptionEndedAt: iso(NOW - 40 * DAY), stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    customers.add("cus_1");
    subs.set("sub_1", sub("sub_1", "cus_1", "canceled"));
    await run();
    let second: Promise<unknown> | undefined;
    onStripe = () => {
      onStripe = undefined;
      second = run(NOW + 8 * DAY + 1000);
    };
    expect(await run(NOW + 8 * DAY)).toMatchObject({ closed: 1 });
    expect(await second).toMatchObject({ skipped: true });
    // Its lease given up: the next hour's run goes
    expect(await run(NOW + 8 * DAY + 3_600_000)).not.toHaveProperty("skipped");
  });

  it("fails the run when it can't list the teams, so no gauge goes out", async () => {
    const broken = createTeamLapseHandler({ db: table.guarded(() => false), obs: obs(), mailer: mails.mailer, stripe: async () => stripe, now: () => NOW });
    await expect(broken()).rejects.toThrow("not authorized");
    expect(gauges).toEqual({});
  });
});

describe("a test team (supply-checkout-o60.12)", () => {
  // The same lapse for a customer's team and a test team: the mark changes no email, warning,
  // closure or Stripe call, only the metrics' metadata, and count() then skips the business ones
  it("is handled exactly like a customer's team, its metrics tagged test", async () => {
    team("cust", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    team("probe", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY), test: true });
    team("other", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY), test: "true" });
    await run();
    expect(await run(NOW + 8 * DAY)).toEqual({ checked: 3, closed: 3, failed: 0, held: 0 });
    for (const id of ["probe", "other"]) {
      expect(sentTo(id).map((m) => m.input.kind)).toEqual(sentTo("cust").map((m) => m.input.kind));
      expect(meta(id)).toMatchObject({ closedBy: LAPSED_CLOSER, purgeAfter: meta("cust").purgeAfter });
    }
    expect(meta("probe").test).toBe(true);
    const tagged = (teamId: string) => counts.filter(([, , m]) => m.teamId === teamId);
    expect(tagged("probe").map(([metric]) => metric)).toEqual(tagged("cust").map(([metric]) => metric));
    expect(tagged("probe").map(([metric]) => metric)).toEqual(expect.arrayContaining([BusinessMetric.LapseNotices, BusinessMetric.LapsedTeamsClosed]));
    for (const [, , metadata] of tagged("probe")) expect(metadata.test).toBe(true);
    // Only exactly true marks it
    for (const id of ["cust", "other"]) for (const [, , metadata] of tagged(id)) expect(metadata).not.toHaveProperty("test");
    // The owners' emails aren't sent as metrics for it; the closure (its alarm guards against mass closures) is
    const sent = (teamId: string) => tagged(teamId).filter(([metric, , metadata]) => !skippedForTest(metric as BusinessMetricName, metadata as Metadata)).map(([metric]) => metric);
    expect(sent("probe")).toEqual([BusinessMetric.LapsedTeamsClosed]);
    expect(sent("cust")).toEqual(tagged("cust").map(([metric]) => metric));
    expect(denied).toEqual([]);
  });

  it("tags its failures, which are still sent, including one that throws after the team was read", async () => {
    team("probe", { status: "canceled", subscriptionEndedAt: iso(NOW - 40 * DAY), stripeSubscriptionId: "sub_p", stripeCustomerId: "cus_p", test: true });
    customers.add("cus_p");
    subs.set("sub_p", sub("sub_p", "cus_p", "canceled"));
    subs.set("sub_live", sub("sub_live", "cus_p", "active"));
    await run();
    // Stripe disagrees: a live subscription
    expect(await run(NOW + 8 * DAY)).toMatchObject({ closed: 0, failed: 1 });
    // Stripe down: the throw is counted by the caller, with the mark it read
    stripeDown = true;
    expect(await run(NOW + 8 * DAY + 3_600_000)).toMatchObject({ closed: 0, failed: 1 });
    const failures = counts.filter(([m]) => m === BusinessMetric.LapseFailures).map(([, , metadata]) => metadata);
    expect(failures).toEqual([
      { teamId: "probe", step: "stripe", why: "SubscriptionLive", test: true },
      { teamId: "probe", step: "error", test: true },
    ]);
    for (const metadata of failures) expect(skippedForTest(BusinessMetric.LapseFailures, metadata as Metadata)).toBe(false);
    expect(meta("probe").closedAt).toBeUndefined();
  });

  it("tags no failure for a team it couldn't read", async () => {
    team("probe", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY), test: true });
    // Its META item can't be read: nothing says it's a test team
    const policy = lapsePolicy(denied);
    const db = table.guarded((command, input) => !(command === "GetCommand" && JSON.stringify(input.Key).includes("TEAM#probe")) && policy(command, input));
    await createTeamLapseHandler({ db, obs: obs(), mailer: mails.mailer, stripe: async () => stripe, now: () => NOW, random: () => 0 })();
    expect(counts.filter(([m]) => m === BusinessMetric.LapseFailures).map(([, , metadata]) => metadata)).toEqual([{ teamId: "probe", step: "error" }]);
  });
});

describe("its role's reads (supply-checkout-3sv.23)", () => {
  // Both GetItem statements require dynamodb:Select SPECIFIC_ATTRIBUTES, so lapsePolicy refuses a read without a
  // projection: every test here, which fails on any refusal, then shows readLapseTeam and warnedAt project
  it("refuses a GetItem of a team or its own records without a projection, or with Select other than SPECIFIC_ATTRIBUTES", () => {
    const policy = lapsePolicy(denied);
    const warned = { PK: "LAPSE#team-a", SK: "WARNED#2026-10-01T12:00:00.000Z" };
    const meta = { PK: "TEAM#team-a", SK: "META" };
    expect(policy("GetCommand", { Key: warned })).toBe(false);
    expect(policy("GetCommand", { Key: meta })).toBe(false);
    expect(policy("GetCommand", { Key: warned, ProjectionExpression: "sentAt", Select: "ALL_ATTRIBUTES" })).toBe(false);
    expect(policy("GetCommand", { Key: warned, ProjectionExpression: "sentAt" })).toBe(true);
    expect(policy("GetCommand", { Key: warned, ProjectionExpression: "sentAt", Select: "SPECIFIC_ATTRIBUTES" })).toBe(true);
    expect(denied).toHaveLength(3);
    denied.length = 0;
  });
});
