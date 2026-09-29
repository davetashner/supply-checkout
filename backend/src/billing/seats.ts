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
//    sync queue for the team's Stripe customer (queueSeatSync), if it has one. Best effort: the
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
//    message), skips a closed, purging or gone team, a team with no
//    subscription (a trial that never went through Checkout) or one that has
//    ended, and a subscription that's incomplete or not the customer's.
// 4. It counts the billed members now (countBilledMembers), retrieves the
//    subscription, and if its seat item's quantity differs, updates that
//    item to the count with proration (create_prorations). The quantity is
//    always computed from the membership as it is when the message is
//    handled, never incremented, so racing changes converge on the same
//    number, and a message handled late does no harm.
// 5. Stripe's customer.subscription.updated then records the new seats on
//    the team, like any other change.
//
// The worker also syncs after applying (or re-seeing) any Stripe event for a
// subscription, so the quantity an owner chose at Checkout is corrected to
// the billed members as soon as the subscription exists.
//
// Idempotency: the update's Stripe idempotency key is made from the team,
// the message (a queue retry sends the same one), the subscription item and
// the target quantity. A retry after Stripe applied the update finds the
// quantity already right and sends nothing.
//
// The nightly reconciliation (ops/seat-reconcile-handler.ts) queues a message with
// reason `reconcile` for every open team with a Stripe customer. When one
// finds the quantity wrong it's drift: counted in SeatQuantityDrift (the
// "Seat counts drifting" alarm) and logged with the IDs and both numbers, then
// fixed.
//
// Logged: team, subscription and message IDs, quantities and reasons. Never a
// name, an email or the Stripe key.

import { createHash, randomUUID } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { countBilledMembers, getBillingTeam, hasEnded, stripeCustomerTeam, teamContextForStripeCustomer } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { planForLookupKey } from "./catalog.js";
import type { DbForWorker } from "./worker-db.js";

/** Why a seat sync was queued: a membership change, the nightly reconciliation, or a Stripe event for the subscription. */
export const SEAT_SYNC_REASONS = ["membership", "reconcile", "subscription"] as const;
export type SeatSyncReason = (typeof SEAT_SYNC_REASONS)[number];

/** A seat sync on the seat sync queue. It names only the Stripe customer: the worker finds the team from our own link. */
export interface SeatSyncMessage {
  readonly kind: "seats";
  /** Unique per sync: the worker's session tag, and part of the Stripe idempotency key. */
  readonly id: string;
  readonly customer: string;
  readonly reason: SeatSyncReason;
  /** When it was queued (epoch seconds). */
  readonly created: number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A seat sync queue message, checked. The account function and the reconciliation wrote it, but the worker trusts no shape it didn't check. */
export function parseSeatSync(body: string): SeatSyncMessage {
  const m = JSON.parse(body) as Record<string, unknown> | null;
  const ok =
    typeof m === "object" &&
    m !== null &&
    m.kind === "seats" &&
    typeof m.id === "string" &&
    ID.test(m.id) &&
    typeof m.customer === "string" &&
    ID.test(m.customer) &&
    (SEAT_SYNC_REASONS as readonly unknown[]).includes(m.reason) &&
    typeof m.created === "number";
  if (!ok) throw new Error("Not a seat sync message");
  return { kind: "seats", id: m.id as string, customer: m.customer as string, reason: m.reason as SeatSyncReason, created: m.created as number };
}

/** The seat quantity for a number of billed members. A team always has an owner, so at least one. */
export function seatQuantity(billedMembers: number): number {
  return Math.max(1, billedMembers);
}

/** The Stripe idempotency key for one seat update: the same message, item and quantity give the same key. */
export function seatUpdateKey(teamId: string, messageId: string, itemId: string, quantity: number): string {
  return `seats-${teamId}-${createHash("sha256").update(JSON.stringify([messageId, itemId, quantity])).digest("hex")}`;
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
export type SeatOutcome = "updated" | "in_sync" | "unknown_customer" | "team_gone" | "team_closed" | "no_subscription" | "subscription_ended" | "not_ours";

const idOf = (value: string | { readonly id: string }) => (typeof value === "string" ? value : value.id);

/** Subscription statuses whose quantity isn't ours to change: ended, or not started (the first payment hasn't gone through). */
const unchangeable = (status: string) => hasEnded(status) || status === "incomplete";

/** Applies one seat sync (see the top of this file). Throws on a Stripe or DynamoDB failure, so the message is retried. */
export function createSeatSync(deps: SeatSyncDeps) {
  const { obs } = deps;
  const now = () => new Date((deps.now ?? Date.now)());

  async function sync(message: SeatSyncMessage): Promise<SeatOutcome> {
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
    if (!team.stripeSubscriptionId) return "no_subscription";
    if (hasEnded(team.status)) return "subscription_ended";
    const billed = await countBilledMembers(db, ctx);
    const stripe = await deps.stripe();
    const sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId);
    if (idOf(sub.customer) !== customer) return "not_ours";
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
    await stripe.subscriptionItems.update(item.id, { quantity, proration_behavior: "create_prorations" }, { idempotencyKey: seatUpdateKey(teamId, id, item.id, quantity) });
    obs.count(BusinessMetric.SeatQuantityUpdates, 1, { teamId, reason: message.reason });
    obs.logger.info("Seat quantity updated", { teamId, subscriptionId: sub.id, from: current, to: quantity, reason: message.reason });
    return "updated";
  }

  return async (message: SeatSyncMessage): Promise<SeatOutcome> => {
    const outcome = await sync(message);
    obs.logger.info("Seat sync", { messageId: message.id, reason: message.reason, outcome });
    return outcome;
  };
}

/** What sending a message to the seat sync queue needs from an SQS client: `send`, as SQSClient has it. */
export interface SeatQueueSender {
  send(command: SendMessageCommand): Promise<unknown>;
}

/** Queues a seat sync for a team's Stripe customer. */
export type SeatSyncQueue = (customer: string, reason: SeatSyncReason) => Promise<void>;

/**
 * Sends seat syncs to the seat sync queue (a FIFO queue): grouped by the
 * customer, so one team's syncs are handled one at a time, and deduplicated
 * by the message's own ID.
 */
export function sqsSeatSyncQueue(queueUrl: string, sqs: SeatQueueSender = new SQSClient({}), options: { readonly now?: () => number; readonly newId?: () => string } = {}): SeatSyncQueue {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => `seats-${randomUUID()}`);
  return async (customer, reason) => {
    if (!ID.test(customer)) throw new Error("Invalid Stripe customer ID");
    const message: SeatSyncMessage = { kind: "seats", id: newId(), customer, reason, created: Math.floor(now() / 1000) };
    await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message), MessageGroupId: customer, MessageDeduplicationId: message.id }));
  };
}
