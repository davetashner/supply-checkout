// Keeps a team's Stripe seat quantity equal to its billed members
// (supply-checkout-l50, ADR 0009, docs/infrastructure.md "Billing").
//
// Who's billed is data/seats.ts's BILLED_ROLES (owners and editors; viewers
// are free). The seat quantity is simply that count: the Stripe price is
// graduated (catalog.ts), with the plan's included seats in its first, flat
// tier, so quantity 2 on Starter still bills the flat amount, and each seat
// past the included ones bills per seat. Nothing here does that arithmetic.
//
// How a change reaches Stripe, asynchronously, through the seat sync queue:
// 1. After a membership change that commits (an invite accepted, a member's
//    role changed, a member removed or leaving, an account deleted, a team
//    reopened), the account function puts a seat sync message on the seat
//    sync queue for the team's Stripe customer (queueSeatSync), if it has
//    one, and so does the ops function after an operator reopens a team
//    (operator/ops-handler.ts). Best effort: the
//    change has already happened, and a message that couldn't be queued is
//    logged and counted (SeatSyncQueueFailures); the nightly reconciliation
//    puts it right.
// 2. The billing worker takes it: FIFO, grouped by the customer, so one at a
//    time per team, retried up to BILLING_MAX_RECEIVES times, then the seat
//    sync dead-letter queue (the "Seat syncs stuck" alarm). A queue of its
//    own, not the billing queue: only the webhook sends Stripe events, and
//    nothing else can put one in front of the worker. Ordering with the
//    customer's Stripe events doesn't matter, since the quantity is always
//    recomputed and Stripe's own update event records it.
// 3. It finds the team from our own link for the customer (never from the
//    message), skips a closed, purging or gone team, a team whose own Stripe
//    customer isn't the message's (not_ours, logged as a warning), a team
//    with no subscription (a trial that never went through Checkout) or one
//    that has ended, and a subscription that's incomplete or not the
//    customer's (not_ours too).
// 4. It counts the billed members now (countBilledMembers), retrieves the
//    subscription, and if its seat item's quantity differs, updates that
//    item to the count with proration (create_prorations). The quantity is
//    always computed from the membership as it is when the message is
//    handled, never incremented, so racing changes converge on the same
//    number, and a message handled late does no harm. More billed members
//    than a team can have (MEMBERS_PER_TEAM) means something went wrong
//    elsewhere: it changes nothing, logs both numbers and counts
//    SeatQuantityDrift, so the "Seat counts drifting" alarm brings a person.
// 5. Stripe's customer.subscription.updated then records the new seats on
//    the team, like any other change.
//
// The worker also syncs after applying (or re-seeing) any Stripe event for a
// subscription, so the quantity an owner chose at Checkout is corrected to
// the billed members as soon as the subscription exists.
//
// Idempotency: the update's Stripe idempotency key is made from the team,
// the message, the SQS message that delivered it (the same on every receive
// of one message, so a queue retry sends the same key; a new one for every
// new delivery, such as the nightly reconciliation run twice in a day, whose
// message ID is fixed per day), the subscription item, and the current and
// target quantities. A retry after Stripe applied the update finds the
// quantity already right and sends nothing, and a new delivery never replays
// an earlier update Stripe has cached.
//
// The nightly reconciliation (ops/seat-reconcile-handler.ts) queues a message with
// reason `reconcile` for every open team with a Stripe customer. When one
// finds the quantity wrong it's drift: counted in SeatQuantityDrift (the
// "Seat counts drifting" alarm) and logged with the IDs and both numbers, then
// fixed.
//
// Logged: team, subscription and message IDs, quantities and reasons. Never a
// name, an email or the Stripe key.

import { createHash } from "node:crypto";
import { countBilledMembers, getBillingTeam, hasEnded, MEMBERS_PER_TEAM, stripeCustomerTeam, teamContextForStripeCustomer } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { planForLookupKey } from "./catalog.js";
import type { SeatSyncMessage } from "./seat-queue.js";
import type { DbForWorker } from "./worker-db.js";

// The message, its check and its sender live in seat-queue.ts, which imports no data code: the functions that only send (account, ops) need nothing else
export { parseSeatSync, SEAT_SYNC_REASONS, type SeatQueueSender, type SeatSyncMessage, type SeatSyncQueue, type SeatSyncReason, sqsSeatSyncQueue } from "./seat-queue.js";

/** The seat quantity for a number of billed members. A team always has an owner, so at least one. */
export function seatQuantity(billedMembers: number): number {
  return Math.max(1, billedMembers);
}

/**
 * The Stripe idempotency key for one seat update: the same message, delivery
 * (the SQS message ID, when a queue delivered it), item, current quantity and
 * target give the same key. The current quantity is in it so a later change
 * back to the same target (within Stripe's 24 hours of keeping keys) is a new
 * request, not a replay of the old one; the delivery, so a message ID used
 * again (the reconciliation's, fixed per day) never replays one either.
 */
export function seatUpdateKey(teamId: string, messageId: string, itemId: string, from: number, quantity: number, delivery?: string): string {
  return `seats-${teamId}-${createHash("sha256").update(JSON.stringify([messageId, delivery ?? null, itemId, from, quantity])).digest("hex")}`;
}

/** The fields of a Stripe subscription a seat sync reads. */
export interface SeatSubscription {
  readonly id: string;
  readonly customer: string | { readonly id: string };
  readonly status: string;
  readonly items: { readonly data: readonly { readonly id: string; readonly quantity?: number; readonly price: { readonly lookup_key: string | null } }[] };
}

/** What a seat sync needs from the Stripe client. */
export interface SeatStripe {
  readonly subscriptions: { retrieve(id: string): PromiseLike<SeatSubscription> };
  readonly subscriptionItems: {
    update(id: string, params: { quantity: number; proration_behavior: "create_prorations" }, options: { idempotencyKey: string }): PromiseLike<unknown>;
  };
}

export interface SeatSyncDeps {
  readonly dbFor: DbForWorker;
  readonly stripe: () => Promise<SeatStripe>;
  readonly obs: Observability;
  readonly now?: () => number;
}

/** What one seat sync did. */
export type SeatOutcome = "updated" | "in_sync" | "unknown_customer" | "team_gone" | "team_closed" | "no_subscription" | "subscription_ended" | "not_ours" | "over_cap";

const idOf = (value: string | { readonly id: string }) => (typeof value === "string" ? value : value.id);

/** Subscription statuses whose quantity isn't ours to change: ended, or not started (the first payment hasn't gone through). */
const unchangeable = (status: string) => hasEnded(status) || status === "incomplete";

/** Applies one seat sync (see the top of this file). Throws on a Stripe or DynamoDB failure, so the message is retried. */
export function createSeatSync(deps: SeatSyncDeps) {
  const { obs } = deps;
  const now = () => new Date((deps.now ?? Date.now)());

  async function sync(message: SeatSyncMessage, delivery: string | undefined): Promise<SeatOutcome> {
    const { id, customer } = message;
    const own = deps.dbFor({ eventId: id, stripeCustomer: customer });
    const teamId = await stripeCustomerTeam(own, customer);
    if (!teamId) return "unknown_customer";
    const db = deps.dbFor({ eventId: id, stripeCustomer: customer, teamId });
    const ctx = await teamContextForStripeCustomer(db, customer);
    if (!ctx || ctx.teamId !== teamId) return "team_gone";
    const team = await getBillingTeam(db, ctx, now());
    if (!team) return "team_gone";
    if (team.closed || team.purging) return "team_closed";
    // The link names this team, but the team names another customer: leave both alone
    if (team.stripeCustomerId !== customer) {
      obs.logger.warn("Seat sync skipped: the team has another Stripe customer", { teamId, messageId: id });
      return "not_ours";
    }
    if (!team.stripeSubscriptionId) return "no_subscription";
    if (hasEnded(team.status)) return "subscription_ended";
    const billed = await countBilledMembers(db, ctx);
    if (billed > MEMBERS_PER_TEAM) {
      // More than a team can have: not a number to bill without a person looking
      obs.count(BusinessMetric.SeatQuantityDrift, 1, { teamId });
      obs.logger.warn("Seat sync skipped: more billed members than a team can have", { teamId, billedMembers: billed, cap: MEMBERS_PER_TEAM });
      return "over_cap";
    }
    const stripe = await deps.stripe();
    const sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId);
    if (idOf(sub.customer) !== customer) {
      obs.logger.warn("Seat sync skipped: another customer's subscription", { teamId, subscriptionId: sub.id });
      return "not_ours";
    }
    if (unchangeable(sub.status)) return "subscription_ended";
    // The seat item: the one item on a price we sell. Anything else was set up by hand, and is left alone
    const items = sub.items.data.filter((item) => planForLookupKey(item.price.lookup_key) !== undefined);
    const item = items.length === 1 && sub.items.data.length === 1 ? items[0] : undefined;
    if (!item) {
      obs.logger.warn("Seat sync skipped: not one catalog item", { teamId, subscriptionId: sub.id, items: sub.items.data.length });
      return "not_ours";
    }
    const quantity = seatQuantity(billed);
    const current = item.quantity ?? 0;
    if (current === quantity) return "in_sync";
    if (message.reason === "reconcile") {
      // The event-driven path missed this one: alarm, then fix it
      obs.count(BusinessMetric.SeatQuantityDrift, 1, { teamId });
      obs.logger.warn("Seat quantity drift", { teamId, subscriptionId: sub.id, stripeQuantity: current, billedMembers: billed });
    }
    await stripe.subscriptionItems.update(item.id, { quantity, proration_behavior: "create_prorations" }, { idempotencyKey: seatUpdateKey(teamId, id, item.id, current, quantity, delivery) });
    obs.count(BusinessMetric.SeatQuantityUpdates, 1, { teamId, reason: message.reason });
    obs.logger.info("Seat quantity updated", { teamId, subscriptionId: sub.id, from: current, to: quantity, reason: message.reason });
    return "updated";
  }

  /** `delivery` is the SQS message ID that delivered it, when a queue did (see "Idempotency" at the top). */
  return async (message: SeatSyncMessage, delivery?: string): Promise<SeatOutcome> => {
    const outcome = await sync(message, delivery);
    obs.logger.info("Seat sync", { messageId: message.id, reason: message.reason, outcome });
    return outcome;
  };
}
