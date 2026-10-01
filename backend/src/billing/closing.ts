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
// Setting `cancel_at_period_end` also stamps the subscription's metadata with
// the closure (CLOSED_AT_METADATA, its `closedAt`), so a reopen can tell a
// cancellation a closure made from one the owner made in the Customer Portal
// (below).
//
// Resuming after a reopen (supply-checkout-85qp). Reopening a team
// (data/teams.ts, reopenTeam, and data/operator.ts, reopenOpsTeam) doesn't
// call Stripe either: it records `stripeResyncFor` (the closure it ended) on
// the team, and the billing worker resyncs the subscription (reopening.ts).
// A subscription set to cancel at the period's end by one of our closures
// (`cancel_at_period_end` and CLOSED_AT_METADATA) is resumed: the update sets
// `cancel_at_period_end` back to false and removes the stamp. One cancelled
// at once, or that ended meanwhile, can't be resumed: the team's status says
// it ended, and its owners subscribe again (resumeAction, "needs_payment").
// The purge and the worker also resume one they set to cancel just as the
// team was reopened (the "Team reopened while its subscription was being
// ended" race), each with a key of its own, so none replays another's.
//
// Only IDs, statuses and actions are logged, never the key or a Stripe message.

import { createHash } from "node:crypto";
import { hasEnded } from "../data/index.js";
import type { SubscriptionLike } from "./worker.js";

/**
 * The subscription metadata key a closure stamps when it sets
 * `cancel_at_period_end`: the closure's `closedAt`. Removed when a reopen
 * resumes the subscription.
 */
export const CLOSED_AT_METADATA = "supply_checkout_closed_at";

/** What ending a closed team's subscription, or resuming a reopened team's, needs from the Stripe client. */
export interface ClosingStripe {
  readonly subscriptions: {
    retrieve(id: string): PromiseLike<SubscriptionLike>;
    update(id: string, params: { cancel_at_period_end: boolean; metadata: Record<string, string> }, options: { idempotencyKey: string }): PromiseLike<unknown>;
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
  // The update gained the closure's metadata stamp: a new key, so a retry from before can't meet different parameters
  const version = action === "cancel_at_period_end" ? "\nstamped" : "";
  const digest = createHash("sha256").update(`${teamId}\n${closedAt}\n${subscriptionId}${version}`).digest("hex");
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
    await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true, metadata: { [CLOSED_AT_METADATA]: team.closedAt } }, { idempotencyKey: closingKey(action, team.teamId, team.closedAt, sub.id) });
  } else if (action === "cancel_now") {
    await stripe.subscriptions.cancel(sub.id, {}, { idempotencyKey: closingKey(action, team.teamId, team.closedAt, sub.id) });
  }
  return action;
}

/** What a reopened team's subscription needs (see the top of this file). */
export type ResumeAction = "resume" | "none" | "needs_payment";

/**
 * What a reopened team's subscription needs: resuming, if one of our closures
 * set it to cancel at the period's end (`cancel_at_period_end` with
 * CLOSED_AT_METADATA); nothing, if it's live and not set to cancel by us (a
 * cancellation the owner made in the Customer Portal is theirs to undo); or,
 * if it has ended (cancelled at closing, or since), a new subscription
 * (`needs_payment`), which the team's status already says.
 */
export function resumeAction(sub: Pick<SubscriptionLike, "status" | "cancel_at_period_end" | "metadata">): ResumeAction {
  if (hasEnded(sub.status)) return "needs_payment";
  return sub.cancel_at_period_end && typeof sub.metadata?.[CLOSED_AT_METADATA] === "string" ? "resume" : "none";
}

/** Who resumes a reopened team's subscription: the worker's resync, or the purge or the worker that set it to cancel as the team was reopened. */
export type ResumeSource = "resync" | "purge" | "worker";

/**
 * The Stripe idempotency key for resuming `subscriptionId` after the team was
 * reopened from the closure `closedAt`, by `source`: one per source, so a
 * resume that has to follow another's (the purge setting it to cancel again
 * after the resync resumed it) is never answered from Stripe's cache.
 */
export function resumeKey(source: ResumeSource, teamId: string, closedAt: string, subscriptionId: string): string {
  const digest = createHash("sha256").update(`${teamId}\n${closedAt}\n${subscriptionId}`).digest("hex");
  return `team-reopened-${source}-${digest}`;
}

/**
 * Resumes a subscription a closure set to cancel at the period's end: sets
 * `cancel_at_period_end` back to false and removes the closure's stamp.
 * Throws on a Stripe failure, for the caller to retry.
 */
export async function resumeSubscription(stripe: ClosingStripe, subscriptionId: string, team: { readonly teamId: string; readonly closedAt: string }, source: ResumeSource): Promise<void> {
  // An empty value removes the key from the subscription's metadata
  await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false, metadata: { [CLOSED_AT_METADATA]: "" } }, { idempotencyKey: resumeKey(source, team.teamId, team.closedAt, subscriptionId) });
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
