// Ending a closed team's Stripe subscription, and deleting a purged team's
// Stripe customer (supply-checkout-t0en, docs/infrastructure.md "Billing").
//
// Closing a team (data/teams.ts, closeTeam) is a DynamoDB transaction only: it
// never waits on Stripe, so a Stripe outage can't leave a team half-closed or
// refuse the close. Instead the closure is the pending cancellation. Two
// places end the subscription, both through endSubscriptionForClosedTeam:
//
// - The closed-team purge (ops/team-purge-handler.ts), every hour, for each
//   closed team whose subscription hasn't been set to end for this closure
//   (no `stripeCancelledFor` equal to its `closedAt`), and then records it. A
//   Stripe failure fails the run (the Functions failing alarm) and the next
//   run tries again.
// - The billing worker (worker.ts), for any event about a closed team's live
//   subscription: a checkout that finished after the team closed, say, so its
//   subscription was never recorded on the team.
//
// What it does depends on the subscription's status:
// - trialing, active, past_due (and anything new): cancel at the period's end
//   (`cancel_at_period_end`), so nothing more is charged and nothing already
//   paid for is taken away. A trial ends at its trial end, uncharged.
// - unpaid, paused, incomplete: cancel now. Nothing is being paid for, and a
//   closed team shouldn't be dunned or charged later.
// - canceled, incomplete_expired, or already set to cancel: nothing.
//
// Each call carries a Stripe idempotency key made from the action, the team,
// the closure (`closedAt`) and the subscription, so a retry (from either
// place, or both) sends Stripe the same request and is answered the same.
// After Stripe's 24 hours the key is new again, but setting
// `cancel_at_period_end` twice, or cancelling a canceled subscription (which
// the status check skips), changes nothing.
//
// Only IDs, statuses and actions are logged, never the key or a Stripe message.

import { createHash } from "node:crypto";
import type { SubscriptionLike } from "./worker.js";

/** What ending a closed team's subscription needs from the Stripe client. */
export interface ClosingStripe {
  readonly subscriptions: {
    retrieve(id: string): PromiseLike<SubscriptionLike>;
    update(id: string, params: { cancel_at_period_end: true }, options: { idempotencyKey: string }): PromiseLike<unknown>;
    cancel(id: string, params: Record<string, never>, options: { idempotencyKey: string }): PromiseLike<unknown>;
  };
}

/** What the purge also needs: deleting a purged team's customer. */
export interface PurgeStripe extends ClosingStripe {
  readonly customers: { del(id: string): PromiseLike<unknown> };
}

/** What ending a closed team's subscription did (or would do). */
export type ClosingAction = "none" | "cancel_at_period_end" | "cancel_now";

/** Statuses where nothing is left to end. */
const ENDED = ["canceled", "incomplete_expired"];
/** Statuses where nothing is being paid for: cancelled at once. */
const CANCEL_NOW = ["unpaid", "paused", "incomplete"];

/** What a closed team's subscription needs, from its status and whether it's already set to cancel. */
export function closingAction(sub: Pick<SubscriptionLike, "status" | "cancel_at_period_end" | "cancel_at">): ClosingAction {
  if (ENDED.includes(sub.status)) return "none";
  if (CANCEL_NOW.includes(sub.status)) return "cancel_now";
  if (sub.cancel_at_period_end || typeof sub.cancel_at === "number") return "none";
  return "cancel_at_period_end";
}

/**
 * The Stripe idempotency key for ending `subscriptionId` for one closure of a
 * team: the same for every retry of it, and different for another closure (a
 * team reopened and closed again). Hashed, so it's always within Stripe's 255
 * characters whatever the IDs.
 */
export function closingKey(action: Exclude<ClosingAction, "none">, teamId: string, closedAt: string, subscriptionId: string): string {
  const digest = createHash("sha256").update(`${teamId}\n${closedAt}\n${subscriptionId}`).digest("hex");
  return `team-closed-${action}-${digest}`;
}

/** The subscription's customer ID. */
export const customerOf = (sub: Pick<SubscriptionLike, "customer">): string => (typeof sub.customer === "string" ? sub.customer : sub.customer.id);

/**
 * Ends a closed team's subscription (see the top of this file): at the
 * period's end, or now if nothing's being paid for, or not at all if it's
 * ended or already set to. Returns what it did. Throws on a Stripe failure,
 * for the caller to retry.
 */
export async function endSubscriptionForClosedTeam(stripe: ClosingStripe, sub: SubscriptionLike, team: { readonly teamId: string; readonly closedAt: string }): Promise<ClosingAction> {
  const action = closingAction(sub);
  if (action === "cancel_at_period_end") {
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true }, { idempotencyKey: closingKey(action, team.teamId, team.closedAt, sub.id) });
  } else if (action === "cancel_now") {
    await stripe.subscriptions.cancel(sub.id, {}, { idempotencyKey: closingKey(action, team.teamId, team.closedAt, sub.id) });
  }
  return action;
}

/**
 * Deletes a purged team's Stripe customer: its name, email, address and saved
 * cards go, and Stripe cancels any subscription still on it at once. Stripe
 * keeps the invoices and payments already made, which the business's records
 * need. A customer already deleted (404, `resource_missing`) counts as done,
 * so a purge run that stopped after this step can carry on.
 */
export async function deleteStripeCustomer(stripe: PurgeStripe, customerId: string): Promise<"deleted" | "already_deleted"> {
  try {
    await stripe.customers.del(customerId);
    return "deleted";
  } catch (error) {
    const { code, statusCode } = (error ?? {}) as { code?: unknown; statusCode?: unknown };
    if (code === "resource_missing" || statusCode === 404) return "already_deleted";
    throw error;
  }
}
