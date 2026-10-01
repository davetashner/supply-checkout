// Ending a closed team's Stripe subscription and deleting a purged team's
// customer (src/billing/closing.ts). The purge's and the billing worker's use
// of it are in account-deletion-api.test.ts and billing-worker.test.ts.

import { describe, expect, it } from "vitest";
import { CLOSED_AT_METADATA, closingAction, closingKey, deleteStripeCustomer, endSubscriptionForClosedTeam, type PurgeStripe, resumeAction, resumeKey, resumeSubscription } from "../src/billing/closing.js";
import type { SubscriptionLike } from "../src/billing/subscription.js";

describe("ending a closed team's subscription", () => {
  it("cancels at the period's end what's being paid for or trialing, at once what isn't, and leaves what's ended or already ending", () => {
    const action = (status: string, cancel_at_period_end = false, cancel_at: number | null = null) => closingAction({ status, cancel_at_period_end, cancel_at });
    for (const status of ["trialing", "active", "past_due", "something_new"]) expect(action(status), status).toBe("cancel_at_period_end");
    for (const status of ["unpaid", "paused", "incomplete"]) expect(action(status), status).toBe("cancel_now");
    for (const status of ["canceled", "incomplete_expired"]) expect(action(status), status).toBe("none");
    expect(action("active", true)).toBe("none");
    expect(action("trialing", false, 1_900_000_000)).toBe("none");
    // Already set to cancel later, but nothing is being paid for: cancelled now
    expect(action("unpaid", true)).toBe("cancel_now");
  });

  it("keys each closure's request the same on every retry, differently for another closure or action, within Stripe's 255 characters", () => {
    const key = closingKey("cancel_at_period_end", "team-a", "2026-09-26T12:00:00.000Z", "sub_1");
    expect(closingKey("cancel_at_period_end", "team-a", "2026-09-26T12:00:00.000Z", "sub_1")).toBe(key);
    expect(closingKey("cancel_at_period_end", "team-a", "2026-10-01T12:00:00.000Z", "sub_1")).not.toBe(key);
    expect(closingKey("cancel_at_period_end", "team-b", "2026-09-26T12:00:00.000Z", "sub_1")).not.toBe(key);
    expect(closingKey("cancel_now", "team-a", "2026-09-26T12:00:00.000Z", "sub_1")).not.toBe(key);
    expect(closingKey("cancel_now", "t".repeat(128), "2026-09-26T12:00:00.000Z", "s".repeat(128)).length).toBeLessThanOrEqual(255);
    expect(key).toMatch(/^team-closed-cancel_at_period_end-[0-9a-f]{64}$/);
  });
});

describe("resuming a reopened team's subscription (supply-checkout-85qp)", () => {
  const CLOSED = "2026-09-26T12:00:00.000Z";
  const calls: { id: string; params: unknown; key: string }[] = [];
  const stripe = { subscriptions: { update: async (id: string, params: unknown, options: { idempotencyKey: string }) => calls.push({ id, params, key: options.idempotencyKey }) } } as unknown as PurgeStripe;

  it("stamps the closure on a subscription it sets to cancel, so a reopen can tell it from the owner's own", async () => {
    const sub = { id: "sub_1", status: "active", cancel_at_period_end: false } as SubscriptionLike;
    expect(await endSubscriptionForClosedTeam(stripe, sub, { teamId: "team-a", closedAt: CLOSED })).toBe("cancel_at_period_end");
    expect(calls.pop()).toEqual({ id: "sub_1", params: { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: CLOSED } }, key: closingKey("cancel_at_period_end", "team-a", CLOSED, "sub_1") });
  });

  it("resumes only what one of our closures set to cancel, and calls an ended one a new subscription", () => {
    const action = (status: string, cancel_at_period_end: boolean, metadata?: Record<string, string> | null) => resumeAction({ status, cancel_at_period_end, metadata });
    for (const status of ["trialing", "active", "past_due"]) expect(action(status, true, { [CLOSED_AT_METADATA]: CLOSED }), status).toBe("resume");
    // An earlier closure's stamp is ours too: closed again before the resync, that closure found it already ending
    expect(action("active", true, { [CLOSED_AT_METADATA]: "2026-01-01T00:00:00.000Z" })).toBe("resume");
    // The owner's own cancellation, or none
    expect(action("active", true, {})).toBe("none");
    expect(action("active", true, null)).toBe("none");
    expect(action("active", true)).toBe("none");
    expect(action("active", false, { [CLOSED_AT_METADATA]: CLOSED })).toBe("none");
    for (const status of ["canceled", "unpaid", "incomplete_expired"]) expect(action(status, true, { [CLOSED_AT_METADATA]: CLOSED }), status).toBe("needs_payment");
  });

  it("resumes with a key per closure, subscription and source, removing the stamp", async () => {
    await resumeSubscription(stripe, "sub_1", { teamId: "team-a", closedAt: CLOSED }, "resync");
    expect(calls.pop()).toEqual({ id: "sub_1", params: { cancel_at_period_end: false, metadata: { [CLOSED_AT_METADATA]: "" } }, key: resumeKey("resync", "team-a", CLOSED, "sub_1") });
    const key = resumeKey("resync", "team-a", CLOSED, "sub_1");
    expect(key).toMatch(/^team-reopened-resync-[0-9a-f]{64}$/);
    expect(resumeKey("resync", "team-a", CLOSED, "sub_1")).toBe(key);
    for (const other of [resumeKey("purge", "team-a", CLOSED, "sub_1"), resumeKey("worker", "team-a", CLOSED, "sub_1"), resumeKey("resync", "team-b", CLOSED, "sub_1"), resumeKey("resync", "team-a", "2026-10-01T12:00:00.000Z", "sub_1"), resumeKey("resync", "team-a", CLOSED, "sub_2")]) {
      expect(other).not.toBe(key);
    }
    expect(resumeKey("worker", "t".repeat(128), CLOSED, "s".repeat(128)).length).toBeLessThanOrEqual(255);
  });
});

describe("deleting a purged team's Stripe customer", () => {
  const stripe = (del: (id: string) => Promise<unknown>) => ({ customers: { del } }) as unknown as PurgeStripe;

  it("deletes it, counts one already deleted as done, and throws on anything else", async () => {
    expect(await deleteStripeCustomer(stripe(async () => ({ deleted: true })), "cus_1")).toBe("deleted");
    expect(await deleteStripeCustomer(stripe(async () => Promise.reject(Object.assign(new Error("No such customer"), { code: "resource_missing" }))), "cus_1")).toBe("already_deleted");
    expect(await deleteStripeCustomer(stripe(async () => Promise.reject(Object.assign(new Error("Not found"), { statusCode: 404 }))), "cus_1")).toBe("already_deleted");
    await expect(deleteStripeCustomer(stripe(async () => Promise.reject(Object.assign(new Error("Rate limited"), { statusCode: 429 }))), "cus_1")).rejects.toThrow("Rate limited");
    await expect(deleteStripeCustomer(stripe(async () => Promise.reject(null)), "cus_1")).rejects.toBeNull();
  });
});
