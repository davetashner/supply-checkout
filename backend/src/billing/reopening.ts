// Resyncing a reopened team's Stripe subscription (supply-checkout-85qp,
// docs/infrastructure.md "Billing").
//
// While a team is closed the billing worker applies none of its Stripe events
// (worker.ts), and the closure may have set its subscription to cancel at the
// period's end, or cancelled it (closing.ts). Reopening a team, by an owner
// (data/teams.ts, reopenTeam) or an operator (data/operator.ts,
// reopenOpsTeam), calls no Stripe: a Stripe outage must never refuse a
// reopen. Instead the reopen records `stripeResyncFor` (the closure it
// ended) on the team in the same update, and the function that reopened it
// queues a seat sync for the team's customer (seats.ts). The billing worker
// runs this before every seat sync, so the reopen's own sync does it within
// seconds, and the nightly reconciliation's does it for any team still
// waiting.
//
// For a team that's open and has `stripeResyncFor` (found from our own link
// for the customer, never from the message):
// 1. If the message is the nightly reconciliation's, the reopen's own sync
//    didn't do it: counted (ReopenResyncsLate, the "Reopened team's billing
//    not resynced" alarm) and warned of, before anything can fail.
// 2. A team with no subscription has nothing to resync. Otherwise fetch the
//    subscription.
// 3. If one of our closures set it to cancel at the period's end (closing.ts,
//    resumeAction), resume it: `cancel_at_period_end` back to false, with an
//    idempotency key from the team, the closure and the subscription. A
//    cancellation the owner made in the Customer Portal stays. One that has
//    ended (cancelled at closing because nothing was being paid, or since)
//    can't be resumed: the team needs a new subscription, which its status
//    says once it's applied, so its owners see "Subscribe" (needs_payment).
// 4. Apply the subscription's latest state to the team (applySubscription),
//    as for a Stripe event: the events the worker skipped while it was closed.
// 5. Remove `stripeResyncFor`, on the condition it's still that closure.
//
// A Stripe or DynamoDB failure throws, so the seat sync is retried, then goes
// to its dead-letter queue ("Seat syncs stuck"), and the next night tries
// again (and counts it late). A subscription Stripe doesn't have, or that
// isn't the customer's, is warned of and left with `stripeResyncFor`, so the
// nightly alarm brings a person; the entitlement check reports it too.
//
// Logged: team, subscription and message IDs, statuses and outcomes. Never a
// name, an email or the Stripe key.

import { applySubscription, finishReopenResync, getBillingTeam, stripeCustomerTeam, teamContextForStripeCustomer } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { type ClosingStripe, customerOf, resumeAction, resumeSubscription } from "./closing.js";
import type { SeatSyncMessage } from "./seat-queue.js";
import { type SubscriptionLike, subscriptionState } from "./subscription.js";
import type { DbForWorker } from "./worker-db.js";

export interface ReopenResyncDeps {
  readonly dbFor: DbForWorker;
  readonly stripe: () => Promise<ClosingStripe>;
  readonly obs: Observability;
  readonly now?: () => number;
}

/**
 * What one resync did: nothing to do (`none`: no team, or nothing pending),
 * the subscription resumed and applied, applied as it was (`synced`), applied
 * as ended (`needs_payment`), no subscription to resync, or left pending for a
 * person (`missing`, `not_ours`) or for a later reopen (`team_closed`).
 */
export type ResyncOutcome = "none" | "resumed" | "synced" | "needs_payment" | "no_subscription" | "missing" | "not_ours" | "team_closed";

const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "resource_missing";

/** Resyncs a reopened team's subscription, if it's waiting for one (see the top of this file). Throws on a Stripe or DynamoDB failure. */
export function createReopenResync(deps: ReopenResyncDeps) {
  const { obs } = deps;
  const now = () => new Date((deps.now ?? Date.now)());

  async function resync(message: SeatSyncMessage): Promise<ResyncOutcome> {
    const { id, customer } = message;
    const own = deps.dbFor({ eventId: id, stripeCustomer: customer });
    const teamId = await stripeCustomerTeam(own, customer);
    if (!teamId) return "none";
    const db = deps.dbFor({ eventId: id, stripeCustomer: customer, teamId });
    const ctx = await teamContextForStripeCustomer(db, customer);
    if (!ctx || ctx.teamId !== teamId) return "none";
    const team = await getBillingTeam(db, ctx, now());
    const closedAt = team?.resyncFor;
    if (!team || !closedAt) return "none";
    // Closed again: that closure ends it, and the next reopen records itself
    if (team.closed || team.purging) return "team_closed";
    if (team.stripeCustomerId !== customer) {
      obs.logger.warn("Reopened team's subscription not resynced: the team has another Stripe customer", { teamId, messageId: id });
      return "not_ours";
    }
    if (message.reason === "reconcile") {
      obs.count(BusinessMetric.ReopenResyncsLate, 1, { teamId });
      obs.logger.warn("Reopened team's subscription not yet resynced", { teamId, closedAt, subscriptionId: team.stripeSubscriptionId ?? "" });
    }
    if (!team.stripeSubscriptionId) {
      await finishReopenResync(db, ctx, closedAt);
      return "no_subscription";
    }
    const stripe = await deps.stripe();
    let sub: SubscriptionLike;
    try {
      sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId);
    } catch (error) {
      if (!isMissing(error)) throw error;
      obs.logger.warn("Reopened team's subscription not resynced: not found in Stripe", { teamId, subscriptionId: team.stripeSubscriptionId });
      return "missing";
    }
    if (customerOf(sub) !== customer) {
      obs.logger.warn("Reopened team's subscription not resynced: another customer's subscription", { teamId, subscriptionId: sub.id });
      return "not_ours";
    }
    const action = resumeAction(sub);
    if (action === "resume") {
      await resumeSubscription(stripe, sub.id, { teamId, closedAt }, "resync");
      obs.count(BusinessMetric.ReopenedTeamSubscriptionsResumed, 1, { teamId, source: "resync" });
      // Stripe's state after the change, as an event would have it
      sub = await stripe.subscriptions.retrieve(sub.id);
    }
    // Closed again since it was read: left for that closure, and recorded by the next reopen
    if ((await applySubscription(db, ctx, subscriptionState(sub, customer), now())) === "ignored") return "team_closed";
    await finishReopenResync(db, ctx, closedAt);
    obs.logger.info("Reopened team's subscription resynced", { teamId, subscriptionId: sub.id, status: sub.status, action });
    return action === "resume" ? "resumed" : action === "needs_payment" ? "needs_payment" : "synced";
  }

  return async (message: SeatSyncMessage): Promise<ResyncOutcome> => {
    const outcome = await resync(message);
    if (outcome !== "none") obs.logger.info("Reopen resync", { messageId: message.id, reason: message.reason, outcome });
    return outcome;
  };
}
