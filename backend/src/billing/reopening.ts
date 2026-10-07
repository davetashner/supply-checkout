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
// waiting. It uses the team the worker found for the seat sync (findSeatTeam),
// and when it did anything the worker reads the team again before the seat
// sync, so that sees what it applied (supply-checkout-8jc.39).
//
// For a team that's open and has `stripeResyncFor` (found from our own link
// for the customer, never from the message):
// 1. If the message is the nightly reconciliation's, the reopen's own sync
//    didn't do it: counted (ReopenResyncsLate, the "Reopened team's billing
//    not resynced" alarm) and warned of, before anything can fail.
// 2. A team with no subscription has nothing to resync. Otherwise fetch the
//    subscription.
// 3. If the closure it was reopened from set it to cancel at the period's
//    end (closing.ts, resumeAction: the stamp names that closure, or for an
//    older closure the purge recorded it, and Stripe's `canceled_at` is
//    before the reopen), resume it: `cancel_at_period_end` back to false,
//    with an idempotency key from the team, the closure and the
//    subscription. A cancellation the owner made in the Customer Portal
//    stays, and a stale stamp on one that isn't set to cancel is removed.
//    One that may be the closure's but Stripe gives no time for is left as
//    it is, counted (ReopenedTeamSubscriptionsUndecided, the "Reopened
//    team's subscription left to cancel" alarm) and warned of, for a person.
//    One that has ended (cancelled at closing because nothing was being
//    paid, or since) can't be resumed: the team needs a new subscription,
//    which its status says once it's applied, so its owners see "Subscribe"
//    (needs_payment).
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

import { applySubscription, finishReopenResync } from "../data/index.js";
import { BusinessMetric, type Observability, testMark } from "../observability/index.js";
import { type ClosingStripe, customerOf, removeStamp, resumeAction, resumeSubscription, staleStamp } from "./closing.js";
import type { SeatSyncMessage } from "./seat-queue.js";
import type { SeatTeam, SeatTeamMissing } from "./seats.js";
import { type SubscriptionLike, subscriptionState } from "./subscription.js";
import type { DbForWorker } from "./worker-db.js";

export interface ReopenResyncDeps {
  readonly dbFor: DbForWorker;
  readonly stripe: () => Promise<ClosingStripe>;
  readonly obs: Observability;
  readonly now?: () => number;
}

/**
 * What one resync did: nothing to do (`none`: no team, or nothing pending; the worker reads the team again after any other),
 * the subscription resumed and applied, applied as it was (`synced`), applied
 * as ended (`needs_payment`), no subscription to resync, or left pending for a
 * person (`missing`, `not_ours`) or for a later reopen (`team_closed`).
 */
export type ResyncOutcome = "none" | "resumed" | "synced" | "needs_payment" | "undecided" | "no_subscription" | "missing" | "not_ours" | "team_closed";

const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "resource_missing";

/** Resyncs a reopened team's subscription, if it's waiting for one (see the top of this file). Throws on a Stripe or DynamoDB failure. */
export function createReopenResync(deps: ReopenResyncDeps) {
  const { obs } = deps;
  const now = () => new Date((deps.now ?? Date.now)());

  async function resync(message: SeatSyncMessage, found: SeatTeam | SeatTeamMissing): Promise<ResyncOutcome> {
    if (typeof found === "string") return "none";
    const { id, customer } = message;
    const { db, ctx, team } = found;
    const { teamId } = ctx;
    const closedAt = team.resyncFor;
    if (!closedAt) return "none";
    // Closed again: that closure ends it, and the next reopen records itself
    if (team.closed || team.purging) return "team_closed";
    if (team.stripeCustomerId !== customer) {
      obs.logger.warn("Reopened team's subscription not resynced: the team has another Stripe customer", { teamId, messageId: id });
      return "not_ours";
    }
    if (message.reason === "reconcile") {
      obs.count(BusinessMetric.ReopenResyncsLate, 1, { teamId, ...testMark(team.test) });
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
    const action = resumeAction(sub, { closedAt, ...(team.reopenedAt ? { reopenedAt: team.reopenedAt } : {}), ...(team.cancelledFor ? { cancelledFor: team.cancelledFor } : {}) });
    if (action === "undecided") {
      // Maybe the closure's, maybe the owner's: a person decides (docs/journeys.md)
      obs.count(BusinessMetric.ReopenedTeamSubscriptionsUndecided, 1, { teamId, ...testMark(team.test) });
      obs.logger.warn("Reopened team's subscription left set to cancel", { teamId, subscriptionId: sub.id, closedAt });
    } else if (staleStamp(sub, action === "resume")) {
      // Done with this resync: any stamp left (the owner's cancellation or renewal after the reopen) means nothing now
      await removeStamp(stripe, sub, teamId, id);
    }
    if (action === "resume") {
      await resumeSubscription(stripe, sub.id, { teamId, closedAt }, "resync");
      obs.count(BusinessMetric.ReopenedTeamSubscriptionsResumed, 1, { teamId, source: "resync", ...testMark(team.test) });
      // Stripe's state after the change, as an event would have it
      sub = await stripe.subscriptions.retrieve(sub.id);
    }
    // Closed again since it was read: left for that closure, and recorded by the next reopen
    if ((await applySubscription(db, ctx, subscriptionState(sub, customer), now())) === "ignored") return "team_closed";
    await finishReopenResync(db, ctx, closedAt);
    obs.logger.info("Reopened team's subscription resynced", { teamId, subscriptionId: sub.id, status: sub.status, action });
    return action === "resume" ? "resumed" : action === "none" ? "synced" : action;
  }

  /** `found` is the seat sync's team for the message (seats.ts, findSeatTeam): its link, context and team aren't read again here. */
  return async (message: SeatSyncMessage, found: SeatTeam | SeatTeamMissing): Promise<ResyncOutcome> => {
    const outcome = await resync(message, found);
    if (outcome !== "none") obs.logger.info("Reopen resync", { messageId: message.id, reason: message.reason, outcome });
    return outcome;
  };
}
