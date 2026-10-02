// The lapsed-team job (src/ops/team-lapse-handler.ts, supply-checkout-qdx)
// against the in-memory table, each call passing only what its role allows
// (lapsePolicy in ops-policy.ts), with a fake Stripe and mailer. The closure
// it makes is the one the purge deletes (closing.test.ts runs the purge
// against DynamoDB Local); here the test checks the team is in the purge's
// index, due now.

import { beforeEach, describe, expect, it } from "vitest";
import type { SubscriptionLike } from "../src/billing/subscription.js";
import { LAPSE_WARNING_DAYS, LAPSED_CLOSER } from "../src/data/index.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { LAPSE_BUDGET_MS } from "../src/ops/names.js";
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
      return { data: [...subs.values()].filter((s) => (typeof s.customer === "string" ? s.customer : s.customer.id) === customer) };
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
const run = (at = NOW) => createTeamLapseHandler({ db: table.guarded(lapsePolicy(denied)), obs: obs(), mailer: mails.mailer, stripe: async () => stripe, now: () => at })();
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
});

describe("the app's own trial", () => {
  it("emails each owner once when it ends within 3 days, and not before, or for a Stripe trial", async () => {
    team("soon", { status: "trialing", trialEndsAt: iso(NOW + 2 * DAY) });
    team("later", { status: "trialing", trialEndsAt: iso(NOW + 4 * DAY) });
    team("stripe", { status: "trialing", trialEndsAt: iso(NOW + 2 * DAY), stripeSubscriptionId: "sub_s", stripeCustomerId: "cus_s" });
    team("comped", { status: "trialing", trialEndsAt: iso(NOW + 2 * DAY), compPlan: "starter", compUntil: iso(NOW + 30 * DAY) });
    // The comped one isn't even listed; the Stripe trial is, and read again
    expect(await run()).toEqual({ checked: 2, closed: 0, failed: 0 });
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
    const deletes = iso(end + 30 * DAY);
    expect(sentTo("ended").map((m) => m.input)).toEqual([
      { kind: "readOnly", teamName: "Name of ended", reason: "trial_ended", deletesAt: deletes },
      { kind: "readOnly", teamName: "Name of ended", reason: "trial_ended", deletesAt: deletes },
    ]);
    expect(gauges[BusinessMetric.LapseTeamsReadOnly]).toBe(1);
    // Nothing more until 7 days before the date
    mails.sent.length = 0;
    await run(end + 22 * DAY);
    expect(mails.sent).toEqual([]);
    const warnAt = end + 23 * DAY;
    await run(warnAt);
    expect(mails.sent.map((m) => m.input)).toEqual([
      { kind: "deletionWarning", teamName: "Name of ended", deletesAt: deletes },
      { kind: "deletionWarning", teamName: "Name of ended", deletesAt: deletes },
    ]);
    expect(table.get("LAPSE#ended", `WARNED#${deletes}`)).toMatchObject({ sentAt: iso(warnAt) });
    // Not before the date
    await run(end + 30 * DAY - 1);
    expect(meta("ended").closedAt).toBeUndefined();
    // On it: closed, due at once, in the purge's index
    const at = end + 30 * DAY;
    expect(await run(at)).toEqual({ checked: 1, closed: 1, failed: 0 });
    expect(meta("ended")).toMatchObject({ closedAt: iso(at), closedBy: LAPSED_CLOSER, purgeAfter: iso(at), GSI1PK: "TEAMS#CLOSED", GSI1SK: `${iso(at)}#ended`, version: 4 });
    expect(stripeCalls).toEqual([]);
    expect(counted(BusinessMetric.LapsedTeamsClosed)).toBe(1);
    expect(mails.sent).toHaveLength(2);
    // Closed: never listed again
    expect(await run(at + DAY)).toEqual({ checked: 0, closed: 0, failed: 0 });
    expect(denied).toEqual([]);
  });

  it("gives a team found long past its date (from before this job, or comped until now) a full 7 days' warning", async () => {
    team("old", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    await run();
    const deletes = iso(NOW + LAPSE_WARNING_DAYS * DAY);
    expect(sentTo("old").map((m) => m.input)).toEqual([
      { kind: "readOnly", teamName: "Name of old", reason: "trial_ended", deletesAt: deletes },
      { kind: "readOnly", teamName: "Name of old", reason: "trial_ended", deletesAt: deletes },
      { kind: "deletionWarning", teamName: "Name of old", deletesAt: deletes },
      { kind: "deletionWarning", teamName: "Name of old", deletesAt: deletes },
    ]);
    await run(NOW + 7 * DAY - 1);
    expect(meta("old").closedAt).toBeUndefined();
    await run(NOW + 7 * DAY);
    expect(meta("old").closedBy).toBe(LAPSED_CLOSER);
  });

  it("asks Stripe about a customer from an abandoned checkout before closing", async () => {
    team("abandoned", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY), stripeCustomerId: "cus_a" });
    customers.add("cus_a");
    subs.set("sub_old", sub("sub_old", "cus_a", "incomplete_expired"));
    await run();
    await run(NOW + 7 * DAY);
    expect(stripeCalls).toEqual(["list cus_a"]);
    expect(meta("abandoned").closedBy).toBe(LAPSED_CLOSER);
  });
});

describe("an ended subscription", () => {
  const ended = NOW - 40 * DAY;
  const deletes = iso(ended + 30 * DAY);
  beforeEach(() => {
    team("gone", { status: "canceled", subscriptionEndedAt: iso(ended), stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    customers.add("cus_1");
    subs.set("sub_1", sub("sub_1", "cus_1", "canceled"));
  });

  it("warns (no read-only email: the billing worker sent it), then closes once Stripe confirms nothing is live", async () => {
    await run();
    const floor = iso(NOW + 7 * DAY);
    expect(sentTo("gone").map((m) => m.input)).toEqual([
      { kind: "deletionWarning", teamName: "Name of gone", deletesAt: floor },
      { kind: "deletionWarning", teamName: "Name of gone", deletesAt: floor },
    ]);
    expect(Date.parse(deletes)).toBeLessThan(Date.parse(floor));
    expect(await run(NOW + 7 * DAY)).toMatchObject({ closed: 1 });
    expect(stripeCalls).toEqual(["retrieve sub_1", "list cus_1"]);
    expect(denied).toEqual([]);
  });

  it("doesn't close while Stripe has a live subscription for the customer, or disagrees about the team's, and counts it for a person", async () => {
    await run();
    const later = NOW + 7 * DAY;
    for (const [setup, why] of [
      [() => subs.set("sub_2", sub("sub_2", "cus_1", "active")), "SubscriptionLive"],
      [() => subs.set("sub_2", sub("sub_2", "cus_1", "unpaid")), "SubscriptionLive"],
      [() => subs.set("sub_1", sub("sub_1", "cus_1", "past_due")), "SubscriptionLive"],
      [() => subs.set("sub_1", sub("sub_1", "cus_other", "canceled")), "CustomerMismatch"],
      [() => subs.delete("sub_1"), "SubscriptionNotFound"],
      [() => customers.delete("cus_1"), "CustomerNotFound"],
    ] as const) {
      subs.clear();
      customers.add("cus_1");
      subs.set("sub_1", sub("sub_1", "cus_1", "canceled"));
      counts = [];
      setup();
      expect(await run(later)).toMatchObject({ closed: 0, failed: 1 });
      expect(counts.find(([m]) => m === BusinessMetric.LapseFailures)?.[2]).toMatchObject({ teamId: "gone", step: "stripe", why });
      expect(meta("gone").closedAt).toBeUndefined();
    }
    const line = logs.find(([, message]) => message === "Lapsed team not closed: Stripe disagrees");
    expect(line?.[2]).toMatchObject({ teamId: "gone", recordedSubscriptionId: "sub_1", customerId: "cus_1" });
  });

  it("leaves a team that changed between the read and the closure (a Stripe event, a comp, a customer linked) for the next run", async () => {
    await run();
    onStripe = () => table.put({ ...meta("gone"), version: 9 });
    expect(await run(NOW + 7 * DAY)).toEqual({ checked: 1, closed: 0, failed: 0 });
    expect(meta("gone").closedAt).toBeUndefined();
    onStripe = () => table.put({ ...meta("gone"), stripeCustomerId: "cus_new" });
    expect(await run(NOW + 7 * DAY)).toEqual({ checked: 1, closed: 0, failed: 0 });
    expect(meta("gone").closedAt).toBeUndefined();
    expect(logs.some(([, message]) => message === "Lapsed team changed before it was closed: left for the next run")).toBe(true);
  });

  it("counts a Stripe failure and still handles the other teams", async () => {
    team("trial", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    await run();
    stripeDown = true;
    expect(await run(NOW + 7 * DAY)).toEqual({ checked: 2, closed: 1, failed: 1 });
    expect(meta("trial").closedBy).toBe(LAPSED_CLOSER);
    expect(logs.find(([level]) => level === "error")?.[2]).toMatchObject({ teamId: "gone", error: "StripeConnectionError" });
  });

  it("never dates an ended team without subscriptionEndedAt (the nightly check records it first)", async () => {
    table.put({ ...meta("gone"), subscriptionEndedAt: undefined });
    table.put(Object.fromEntries(Object.entries(meta("gone")).filter(([, v]) => v !== undefined)));
    await run(NOW + 400 * DAY);
    expect(mails.sent).toEqual([]);
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
    // Same day: already claimed, so nothing is sent and it's still unwarned
    expect(await run(NOW + 3_600_000)).toMatchObject({ failed: 1 });
    mails.state.fail = undefined;
    const next = NOW + DAY;
    await run(next);
    expect(mails.sent.map((m) => m.input)).toEqual([
      { kind: "deletionWarning", teamName: "Name of quiet", deletesAt: iso(next + 7 * DAY) },
      { kind: "deletionWarning", teamName: "Name of quiet", deletesAt: iso(next + 7 * DAY) },
    ]);
    await run(NOW + 7 * DAY);
    expect(meta("quiet").closedAt).toBeUndefined();
    await run(next + 7 * DAY);
    expect(meta("quiet").closedBy).toBe(LAPSED_CLOSER);
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
    expect(gauges).toEqual({ [BusinessMetric.LapseTeamsChecked]: 0, [BusinessMetric.LapseTeamsReadOnly]: 0 });
    team("old", { status: "trialing", trialEndsAt: iso(NOW - 200 * DAY) });
    await run();
    await run(NOW + 7 * DAY);
    expect(JSON.stringify(logs)).not.toMatch(/example\.com|Name of/);
    expect(JSON.stringify(counts)).not.toMatch(/example\.com|Name of/);
  });

  it("starts no team after its budget, and counts only those it checked", async () => {
    team("a", { status: "trialing", trialEndsAt: iso(NOW - DAY) });
    team("b", { status: "trialing", trialEndsAt: iso(NOW - DAY) });
    let t = NOW;
    const handler = createTeamLapseHandler({ db: table.guarded(lapsePolicy(denied)), obs: obs(), mailer: mails.mailer, stripe: async () => stripe, now: () => (t += LAPSE_BUDGET_MS) });
    expect(await handler()).toEqual({ checked: 1, closed: 0, failed: 0 });
    expect(logs.some(([, message, data]) => message.startsWith("Lapsed-team job ran out of time") && data.unstarted === 1)).toBe(true);
  });

  it("fails the run when it can't list the teams, so no gauge goes out", async () => {
    const broken = createTeamLapseHandler({ db: table.guarded(() => false), obs: obs(), mailer: mails.mailer, stripe: async () => stripe, now: () => NOW });
    await expect(broken()).rejects.toThrow("not authorized");
    expect(gauges).toEqual({});
  });
});
