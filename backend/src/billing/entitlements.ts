// The nightly entitlement check (supply-checkout-8jc.9, ADR 0009,
// docs/infrastructure.md "Billing"): does a team's subscription, as we
// recorded it, match Stripe's?
//
// The billing worker applies every Stripe event, but a webhook can be lost
// (Stripe gave up after 3 days, the endpoint or its secret was wrong), or an
// event can sit in the billing dead-letter queue. Then the team's status,
// plan or seats are wrong: a team that paid is read-only, or one that
// stopped paying isn't. This check finds and fixes that within a day.
//
// It rides on the nightly seat reconciliation (ops/seat-reconcile-handler.ts):
// for each seat sync with reason `reconcile` the worker runs this check first,
// then the seat sync. No second schedule, queue or role: the reconciliation's
// listing already names every open team with a Stripe customer, and the
// worker already has the Stripe key and the team's billing grants.
//
// For each team (found from our own link for the customer, never from the
// message; a closed, purging or gone team is skipped):
// 1. Fetch the team's recorded subscription from Stripe. If there's none, or
//    it has ended, list the customer's subscriptions for a live one we never
//    recorded (a lost checkout or resubscribe), older than
//    UNRECORDED_GRACE_SECONDS so its own events have had time to arrive.
// 2. Compare Stripe's subscription, status, plan and seat quantity with the
//    team's (entitlementDrift). Any difference is drift.
// 3. Fix it: apply Stripe's state with applySubscription, conditioned on the
//    team's status, plan, seats and subscription being as they were read
//    (`asRead`), so an event applied meanwhile is almost never overwritten
//    with older state: that conflict throws, and the message's retry finds
//    the team in sync. The condition compares values, not a version, so an
//    event that changed a field and changed it back (A to B to A) between the
//    read and the write slips through, and `cancelAtPeriodEnd` and
//    `currentPeriodEnd` aren't compared at all. Then the older state can win
//    for a while; the next event for the subscription, or the next night,
//    puts it right. Only once the fix is written is
//    the drift counted in EntitlementDrift (the "Entitlements drifting"
//    alarm) and logged with the team and subscription IDs, the fields, and
//    both values (statuses, plan names and numbers only), so an event that
//    was merely in flight doesn't alarm.
//
// A recorded subscription, or a customer, Stripe no longer has is drift that
// can't be fixed here (`missing`): counted and logged for a person to look at,
// and the team's seat sync is skipped, so it doesn't fail every night.
//
// No owner email is sent for a fix: the event that would have sent one was
// lost, and the runbook (docs/runbooks/billing-dlq-replay.md) says how to
// replay it.
//
// Logged: team, subscription and message IDs, statuses, plans and numbers.
// Never a name, an email or the Stripe key.

import { type BillingAsRead, type BillingTeam, applySubscription, getBillingTeam, hasEnded, stripeCustomerTeam, type SubscriptionState, teamContextForStripeCustomer } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { customerOf } from "./closing.js";
import type { SeatSyncMessage } from "./seats.js";
import { type SubscriptionLike, subscriptionState } from "./subscription.js";
import type { DbForWorker } from "./worker-db.js";

/**
 * A live subscription the team never recorded counts only once it's this old:
 * one made minutes ago (a checkout finishing as the check runs) still has its
 * events on the way.
 */
export const UNRECORDED_GRACE_SECONDS = 60 * 60;

/** How many of a customer's subscriptions the check lists, newest first. A team has one; a few more are duplicates or history. */
export const SUBSCRIPTIONS_LISTED = 10;

/** What the entitlement check needs from the Stripe client. */
export interface EntitlementStripe {
  readonly subscriptions: {
    retrieve(id: string): PromiseLike<SubscriptionLike>;
    list(params: { customer: string; status: "all"; limit: number }): PromiseLike<{ readonly data: readonly SubscriptionLike[] }>;
  };
}

export interface EntitlementCheckDeps {
  readonly dbFor: DbForWorker;
  readonly stripe: () => Promise<EntitlementStripe>;
  readonly obs: Observability;
  readonly now?: () => number;
}

/** What one check found. */
export type EntitlementOutcome = "in_sync" | "fixed" | "missing" | "unknown_customer" | "team_gone" | "team_closed" | "no_subscription" | "not_ours";

/** The fields the check compares. */
export type EntitlementField = "subscription" | "status" | "plan" | "seats";

/** Where the team's record differs from Stripe's subscription. A price we don't sell has no plan, and leaves the plan alone. */
export function entitlementDrift(team: Pick<BillingTeam, "stripeSubscriptionId" | "status" | "plan" | "seats">, state: SubscriptionState): EntitlementField[] {
  const drift: EntitlementField[] = [];
  if (team.stripeSubscriptionId !== state.subscriptionId) drift.push("subscription");
  if (team.status !== state.status) drift.push("status");
  if (state.plan !== undefined && team.plan !== state.plan) drift.push("plan");
  if (team.seats !== state.seats) drift.push("seats");
  return drift;
}

/** Whether a Stripe error says the object doesn't exist. */
const isMissing = (error: unknown) => (error as { code?: unknown } | null)?.code === "resource_missing";

/** Checks one team's entitlements against Stripe (see the top of this file). Throws on a Stripe or DynamoDB failure, or a change meanwhile, so the message is retried. */
export function createEntitlementCheck(deps: EntitlementCheckDeps) {
  const { obs } = deps;
  const nowMs = deps.now ?? Date.now;

  /**
   * The newest live subscription of the customer's that isn't `recorded`, once past the grace period, or
   * "customer_missing" when Stripe doesn't have the customer. `incomplete` doesn't count: its first
   * payment hasn't gone through, and it expires by itself.
   */
  async function unrecorded(stripe: EntitlementStripe, customer: string, recorded: string | undefined): Promise<SubscriptionLike | "customer_missing" | undefined> {
    const cutoff = Math.floor(nowMs() / 1000) - UNRECORDED_GRACE_SECONDS;
    let data: readonly SubscriptionLike[];
    try {
      ({ data } = await stripe.subscriptions.list({ customer, status: "all", limit: SUBSCRIPTIONS_LISTED }));
    } catch (error) {
      if (!isMissing(error)) throw error;
      return "customer_missing";
    }
    const live = data.filter((s) => s.id !== recorded && customerOf(s) === customer && !hasEnded(s.status) && s.status !== "incomplete" && (s.created ?? 0) <= cutoff);
    return live[0];
  }

  async function check(message: SeatSyncMessage): Promise<EntitlementOutcome> {
    const { id, customer } = message;
    const own = deps.dbFor({ eventId: id, stripeCustomer: customer });
    const teamId = await stripeCustomerTeam(own, customer);
    if (!teamId) return "unknown_customer";
    const db = deps.dbFor({ eventId: id, stripeCustomer: customer, teamId });
    const ctx = await teamContextForStripeCustomer(db, customer);
    if (!ctx || ctx.teamId !== teamId) return "team_gone";
    const now = new Date(nowMs());
    const team = await getBillingTeam(db, ctx, now);
    if (!team) return "team_gone";
    if (team.closed || team.purging) return "team_closed";
    const stripe = await deps.stripe();

    let sub: SubscriptionLike | undefined;
    if (team.stripeSubscriptionId) {
      try {
        sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId);
      } catch (error) {
        if (!isMissing(error)) throw error;
        obs.count(BusinessMetric.EntitlementDrift, 1, { teamId });
        obs.logger.warn("Entitlement drift: subscription missing in Stripe", { teamId, subscriptionId: team.stripeSubscriptionId, status: team.status });
        return "missing";
      }
      if (customerOf(sub) !== customer) {
        obs.logger.warn("Entitlement check skipped: subscription isn't the customer's", { teamId, subscriptionId: sub.id });
        return "not_ours";
      }
    }
    let replaces: string | undefined;
    if (!sub || hasEnded(sub.status)) {
      const newer = await unrecorded(stripe, customer, team.stripeSubscriptionId);
      if (newer === "customer_missing") {
        // Deleted in Stripe (by hand, or the wrong mode's): nothing here can fix it, and retrying won't help
        obs.count(BusinessMetric.EntitlementDrift, 1, { teamId });
        obs.logger.warn("Entitlement drift: customer missing in Stripe", { teamId, status: team.status });
        return "missing";
      }
      if (newer) {
        replaces = sub ? team.stripeSubscriptionId : undefined;
        sub = newer;
      }
    }
    if (!sub) return "no_subscription";

    const state = subscriptionState(sub, customer, replaces);
    const fields = entitlementDrift(team, state);
    if (!fields.length) return "in_sync";
    const asRead: BillingAsRead = { status: team.status, plan: team.plan, seats: team.seats, ...(team.stripeSubscriptionId ? { subscriptionId: team.stripeSubscriptionId } : {}) };
    // Counted once the fix is written: a team an event changed meanwhile throws here, and the retry finds it in sync
    if ((await applySubscription(db, ctx, state, now, asRead)) === "ignored") return "team_closed";
    obs.count(BusinessMetric.EntitlementDrift, 1, { teamId });
    obs.logger.warn("Entitlement drift", {
      teamId,
      fields: fields.join(","),
      ours: { subscriptionId: team.stripeSubscriptionId ?? "", status: team.status, plan: team.plan, seats: team.seats },
      stripe: { subscriptionId: state.subscriptionId, status: state.status, plan: state.plan ?? "", seats: state.seats },
    });
    return "fixed";
  }

  return async (message: SeatSyncMessage): Promise<EntitlementOutcome> => {
    const outcome = await check(message);
    obs.logger.info("Entitlement check", { messageId: message.id, outcome });
    return outcome;
  };
}
