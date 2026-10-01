// The billing worker (ADR 0009, docs/infrastructure.md "Billing"): applies one
// verified Stripe event from the billing queue to its team.
//
// For each event, in order:
// 1. Skip it if its record says it was already applied (markWebhookProcessed).
// 2. Find the team from our own link for the event's customer (never from the
//    event). An unknown customer, a purged team (no META item), a closed team
//    or one the purge has started on: record the event and change nothing on
//    the team. For a closed team (not yet purging), its subscription is also
//    ended if it's still live (closing.ts): a checkout that finished after
//    the team closed, whose subscription the team never recorded, would
//    otherwise renew. The team is never reopened or written to. If an owner
//    reopened it while Stripe was being asked, a subscription set to cancel
//    at the period's end is resumed at once (supply-checkout-85qp); anything
//    else is an error, counted and alarmed ("Reopened team's subscription
//    ended"). Either way the event is retried, and applies to the open team.
// 3. Fetch the subscription's latest state from Stripe and apply it (plan,
//    seats, status, interval, period end) with applySubscription, whose
//    conditions never recreate a purged team or touch a closed one. Applying
//    the latest state is harmless to repeat and doesn't depend on the order
//    events arrive in; the queue also hands a customer's events over one at a
//    time (FIFO, grouped by customer).
// 4. Email each owner, at most once per event (claimBillingNotice before
//    sending), when the event is a trial ending without a card, a failed
//    payment, or the subscription ending (the team turns read-only).
// 5. Only then record the event as processed.
//
// A failure anywhere before 5 throws: the message goes back on the queue and
// is tried again, up to BILLING_MAX_RECEIVES times, then to the dead-letter
// queue (the "Billing events stuck" alarm). An email that fails doesn't: the
// claim stands, so it's never sent twice, and it's counted instead.
//
// 6. Then keep the seat quantity equal to the team's billed members
//    (seats.ts), for an event about a subscription that applied, or had
//    been: so the seats chosen at Checkout follow the members from the start.
//
// The worker also takes seat syncs (seats.ts) from their own queue: the
// account function queues one after a membership change, and the nightly
// reconciliation one per team, for which the worker first checks the team's
// status, plan and seats against Stripe (entitlements.ts). Before any seat
// sync it resyncs a reopened team's subscription, if it's waiting for that
// (reopening.ts): reopening queues a seat sync for the purpose. Only the webhook can send to the billing
// queue, so only a verified Stripe event reaches step 1.
//
// Logged: event, team and subscription IDs, statuses, counts and SES error
// names. Never an owner's email or a name.

import { type ClosingStripe, customerOf, endSubscriptionForClosedTeam, removeStamp, resumeSubscription, staleStamp } from "./closing.js";
import {
  applySubscription,
  type BillingTeam,
  claimBillingNotice,
  type Db,
  getBillingTeam,
  hasEnded,
  isWebhookProcessed,
  listOwnerContacts,
  markWebhookProcessed,
  stripeCustomerTeam,
  type TeamContext,
  teamContextForStripeCustomer,
} from "../data/index.js";
import { EmailNotSentError, type Mailer, sendTeamNotice } from "../email/mailer.js";
import type { TeamNoticeInput } from "../email/templates.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { BILLING_EVENTS, type BillingEventType } from "./names.js";
import type { BillingMessage } from "./webhook-handler.js";
import { createEntitlementCheck, type EntitlementOutcome, type EntitlementStripe } from "./entitlements.js";
import { createReopenResync } from "./reopening.js";
import { createSeatSync, parseSeatSync, type SeatOutcome, type SeatStripe, type SeatSyncMessage } from "./seats.js";
import { iso, type SubscriptionLike, subscriptionState } from "./subscription.js";
import type { DbForWorker } from "./worker-db.js";

export { type SubscriptionLike, subscriptionState } from "./subscription.js";

/** What the worker needs from the Stripe client: reading a subscription, cancelling a second one, and ending a closed team's (closing.ts). */
export type WorkerStripe = ClosingStripe;

export interface BillingWorkerDeps {
  readonly dbFor: DbForWorker;
  readonly stripe: () => Promise<WorkerStripe & SeatStripe & EntitlementStripe>;
  readonly mailer: Mailer;
  readonly obs: Observability;
  readonly now?: () => number;
}

/** What happened to one event. */
export type Outcome = "applied" | "duplicate" | "unknown_customer" | "team_gone" | "team_closed" | "second_subscription_canceled" | "ignored";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Logged when a team was reopened while its subscription was being ended: the same line as the purge's (ops/team-purge-handler.ts). */
const TEAM_REOPENED = "Team reopened while its subscription was being ended";

const optional = (value: unknown, type: "string" | "number") => value === undefined || typeof value === type;

/**
 * A queue message, checked: the webhook wrote it, but the worker trusts no
 * shape it didn't check. It returns only the fields it checked, and refuses
 * one with a `kind`, so nothing on the billing queue can be taken for a
 * seat sync (the worker tells them apart by `kind`).
 */
export function parseMessage(body: string): BillingMessage {
  const m = JSON.parse(body) as Record<string, unknown> | null;
  const ok =
    typeof m === "object" &&
    m !== null &&
    !Array.isArray(m) &&
    !("kind" in m) &&
    typeof m.eventId === "string" &&
    ID.test(m.eventId) &&
    typeof m.customer === "string" &&
    ID.test(m.customer) &&
    (BILLING_EVENTS as readonly unknown[]).includes(m.type) &&
    typeof m.created === "number" &&
    (m.subscription === undefined || (typeof m.subscription === "string" && ID.test(m.subscription))) &&
    optional(m.status, "string") &&
    optional(m.previousStatus, "string") &&
    optional(m.trialEnd, "number") &&
    optional(m.nextAttempt, "number");
  if (!ok) throw new Error("Not a billing message");
  const picked: Record<string, unknown> = { eventId: m.eventId, type: m.type, created: m.created, customer: m.customer };
  for (const field of ["subscription", "status", "previousStatus", "trialEnd", "nextAttempt"] as const) if (m[field] !== undefined) picked[field] = m[field];
  return picked as unknown as BillingMessage;
}

/** What the worker takes: a verified Stripe event from the billing queue, or a seat sync from the seat sync queue (seats.ts). */
export type QueueMessage = BillingMessage | SeatSyncMessage;

/** Statuses after which the team is read-only (ENDED_STATUSES) or on hold: an owner is told when it gets there. */
const readOnlyStatus = (status: string | undefined) => hasEnded(status) || status === "paused";

/** The owner email an event calls for, if any, decided from the event itself so a retry decides the same. */
export function noticeFor(message: BillingMessage, sub: SubscriptionLike | undefined, teamName: string): TeamNoticeInput | undefined {
  const type: BillingEventType = message.type;
  if (type === "customer.subscription.trial_will_end") {
    // Only when there's no card to charge: then the trial ends by cancelling
    const trialEndsAt = iso(message.trialEnd ?? sub?.trial_end);
    return sub?.status === "trialing" && !sub.default_payment_method && trialEndsAt ? { kind: "trialEnding", teamName, trialEndsAt } : undefined;
  }
  if (type === "invoice.payment_failed") {
    const nextAttemptAt = iso(message.nextAttempt);
    return { kind: "paymentFailed", teamName, ...(nextAttemptAt ? { nextAttemptAt } : {}) };
  }
  if (type === "customer.subscription.deleted") return { kind: "readOnly", teamName };
  if (type === "customer.subscription.updated" && readOnlyStatus(message.status) && message.previousStatus !== undefined && !readOnlyStatus(message.previousStatus)) {
    return { kind: "readOnly", teamName };
  }
  return undefined;
}

export function createBillingWorker(deps: BillingWorkerDeps) {
  const { obs } = deps;
  const now = () => new Date((deps.now ?? Date.now)());

  /**
   * The subscription to apply, and the one it replaces: the team's own, or a
   * new one once the team's has ended. A second live subscription for a team
   * that has one isn't applied: it's a duplicate checkout (two Checkout pages
 * finished before the first webhook landed), and the worker cancels it.
   */
  async function choose(stripe: WorkerStripe, sub: SubscriptionLike, stored: string | undefined, storedStatus: string): Promise<{ replaces?: string } | undefined> {
    if (!stored || stored === sub.id) return {};
    if (hasEnded(storedStatus)) return { replaces: stored };
    const current = await stripe.subscriptions.retrieve(stored);
    return hasEnded(current.status) ? { replaces: stored } : undefined;
  }

  /** Emails each owner about the event, once each whatever the retries (claimBillingNotice first). */
  async function notify(db: Db, ctx: TeamContext, eventId: string, input: TeamNoticeInput): Promise<void> {
    const owners = await listOwnerContacts(db, ctx);
    let sent = 0;
    const failures: string[] = [];
    for (const owner of owners) {
      if (!(await claimBillingNotice(db, eventId, owner.userId, now()))) continue;
      try {
        if (!owner.email) throw new EmailNotSentError("NoAddress");
        await sendTeamNotice(deps.mailer, owner.email, ctx.teamId, input);
        sent++;
      } catch (error) {
        failures.push(error instanceof EmailNotSentError ? error.code : ((error as { name?: string } | null)?.name ?? "Unknown"));
      }
    }
    if (sent) obs.count(BusinessMetric.BillingNotices, sent, { teamId: ctx.teamId, kind: input.kind });
    if (failures.length) {
      obs.count(BusinessMetric.BillingNoticeFailures, failures.length, { teamId: ctx.teamId, kind: input.kind });
      obs.logger.warn("Billing emails not sent", { teamId: ctx.teamId, eventId, kind: input.kind, failed: failures.length, codes: [...new Set(failures)].join(",") });
    }
  }

  /**
   * Ends the event's subscription if it's still live on a closed team (closing.ts): the
   * subscription as fetched (`sub`), or fetched here. Only the customer's own. Throws on a
   * Stripe failure, so the event is retried.
   *
   * Then, if Stripe was asked to change anything, reads the team again (consistent): an
   * owner who reopened it meanwhile (or reopened and closed it again) now has a subscription
   * set to end that they meant to keep. If it's open and the change was setting it to cancel
   * at the period's end, that's undone at once (resumeSubscription, its own key), since the
   * reopen's resync may already have run (supply-checkout-85qp), and warned of. Otherwise
   * (cancelled at once, closed again, or the resume failed) it's counted
   * (ReopenedTeamSubscriptionsEnded, the "Reopened team's subscription ended" alarm) and
   * logged as an error as the purge does. Either way it throws, so the event isn't recorded
   * and its retry applies the subscription to the open team. A team purged meanwhile is
   * fine: deleting its customer ends the subscription anyway.
   */
  async function endForClosedTeam(db: Db, ctx: TeamContext, message: BillingMessage, team: BillingTeam, sub?: SubscriptionLike): Promise<void> {
    if (!message.subscription || !team.closedAt) return;
    const stripe = await deps.stripe();
    const current = sub ?? (await stripe.subscriptions.retrieve(message.subscription));
    if (customerOf(current) !== message.customer) return;
    // Keyed by the event too: a later event's request (after the subscription changed) is never a cached replay of this one
    const action = await endSubscriptionForClosedTeam(stripe, current, { teamId: team.teamId, closedAt: team.closedAt }, message.eventId);
    if (action !== "none") {
      const after = await getBillingTeam(db, ctx, now());
      if (after && after.closedAt !== team.closedAt) {
        const ids = { teamId: team.teamId, eventId: message.eventId, subscriptionId: current.id, action };
        if (await resumedAfterReopen(stripe, current.id, after, team.closedAt, action)) {
          obs.count(BusinessMetric.ReopenedTeamSubscriptionsResumed, 1, { teamId: team.teamId, source: "worker" });
          obs.logger.warn("Team reopened while its subscription was being ended: resumed", ids);
        } else {
          obs.count(BusinessMetric.ReopenedTeamSubscriptionsEnded, 1, { teamId: team.teamId, action });
          obs.logger.error(TEAM_REOPENED, ids);
        }
        throw Object.assign(new Error(TEAM_REOPENED), { name: "TeamReopened" });
      }
      obs.count(BusinessMetric.ClosedTeamSubscriptionsEnded, 1, { teamId: team.teamId, action });
      obs.logger.info("Closed team's subscription ended", { teamId: team.teamId, eventId: message.eventId, subscriptionId: current.id, status: current.status, action });
    }
  }

  /**
   * Resumes a subscription this worker just set to cancel at the period's end for a closure
   * the team has since been reopened from: true if it did. False for a team closed again
   * (that closure keeps it ending), for one cancelled at once (nothing to resume), and when
   * Stripe fails, logged, so the caller alarms instead.
   */
  async function resumedAfterReopen(stripe: WorkerStripe, subscriptionId: string, after: BillingTeam, closedAt: string, action: string): Promise<boolean> {
    if (after.closed || action !== "cancel_at_period_end") return false;
    try {
      await resumeSubscription(stripe, subscriptionId, { teamId: after.teamId, closedAt }, "worker");
      return true;
    } catch (error) {
      obs.logger.warn("Reopened team's subscription not resumed", { teamId: after.teamId, subscriptionId, error: (error as { name?: string } | null)?.name ?? "Unknown" });
      return false;
    }
  }

  /** Applies one event. Throws to have it retried. */
  async function process(message: BillingMessage): Promise<Outcome> {
    const { eventId, customer } = message;
    const own = deps.dbFor({ eventId, stripeCustomer: customer });
    if (await isWebhookProcessed(own, eventId)) return "duplicate";
    const done = async (outcome: Outcome): Promise<Outcome> => {
      await markWebhookProcessed(own, eventId, now());
      return outcome;
    };
    const teamId = await stripeCustomerTeam(own, customer);
    if (!teamId) return done("unknown_customer");
    const db = deps.dbFor({ eventId, stripeCustomer: customer, teamId });
    const ctx = await teamContextForStripeCustomer(db, customer);
    if (!ctx || ctx.teamId !== teamId) return done("team_gone");
    const team = await getBillingTeam(db, ctx, now());
    if (!team) return done("team_gone");
    // A purging team is going: the purge deletes its Stripe customer, which ends any subscription
    if (team.purging) return done("team_closed");
    // A closed team changes no more (supply-checkout-t0en), but a subscription still live on it is ended
    if (team.closed) {
      await endForClosedTeam(db, ctx, message, team);
      return done("team_closed");
    }
    if (!message.subscription) return done("ignored");
    const stripe = await deps.stripe();
    const sub = await stripe.subscriptions.retrieve(message.subscription);
    if (customerOf(sub) !== customer) return done("ignored");
    const chosen = await choose(stripe, sub, team.stripeSubscriptionId, team.status);
    if (!chosen) {
      // One subscription per team: cancel the second at once, so its trial never turns
      // into a charge. One that was already paid is logged for a refund by hand
      if (!hasEnded(sub.status)) {
        await stripe.subscriptions.cancel(sub.id, {}, { idempotencyKey: `cancel-second-${sub.id}` });
        obs.logger.warn("Second subscription canceled", { teamId, eventId, subscriptionId: sub.id, status: sub.status, kept: team.stripeSubscriptionId ?? "" });
      }
      return done("second_subscription_canceled");
    }
    // Renewed (in the Customer Portal) after a closure set it to cancel: its stamp goes, so a later cancellation is never taken for a closure's
    if (staleStamp(sub)) await removeStamp(stripe, sub, teamId, eventId);
    const result = await applySubscription(db, ctx, subscriptionState(sub, customer, chosen.replaces), now());
    if (result === "ignored") {
      // Closed (or gone) since it was read: a subscription it never recorded is ended here, or it would renew
      const after = await getBillingTeam(db, ctx, now());
      if (after?.closed && !after.purging) await endForClosedTeam(db, ctx, message, after, sub);
      return done("team_closed");
    }
    obs.count(BusinessMetric.BillingEventsApplied, 1, { teamId, type: message.type });
    const notice = noticeFor(message, sub, team.name);
    // Read-only only if no comp keeps the team going
    if (notice && (notice.kind !== "readOnly" || (await getBillingTeam(db, ctx, now()))?.readOnly)) await notify(db, ctx, eventId, notice);
    return done("applied");
  }

  const seats = createSeatSync({ dbFor: deps.dbFor, stripe: deps.stripe, obs, now: deps.now });
  const reopened = createReopenResync({ dbFor: deps.dbFor, stripe: deps.stripe, obs, now: deps.now });
  const entitlements = createEntitlementCheck({ dbFor: deps.dbFor, stripe: deps.stripe, obs, now: deps.now });

  /** `delivery` is the SQS message ID that delivered it, when a queue did: part of a seat update's idempotency key (seats.ts). */
  return async (message: QueueMessage, delivery?: string): Promise<Outcome | SeatOutcome | EntitlementOutcome> => {
    // Checked again here, whatever handed it over: only a well-formed seat sync goes to the seat sync
    if ("kind" in message) {
      const sync = parseSeatSync(JSON.stringify(message));
      // A reopened team's subscription first (reopening.ts): the reopen's own sync, or the night's for one still waiting
      await reopened(sync);
      // The nightly reconciliation: the team's status, plan and seats against Stripe's first (entitlements.ts), then the quantity.
      // A recorded subscription or customer Stripe no longer has is counted there; the seat sync would only fail on it
      if (sync.reason === "reconcile" && (await entitlements(sync)) === "missing") return "missing";
      return seats(sync, delivery);
    }
    const outcome = await process(message);
    obs.logger.info("Billing event", { eventId: message.eventId, type: message.type, outcome });
    // 6: after the event is recorded, so a failure here retries only this (the event is a duplicate then)
    if (message.subscription && (outcome === "applied" || outcome === "duplicate")) {
      await seats({ kind: "seats", id: message.eventId, customer: message.customer, reason: "subscription", created: message.created }, delivery);
    }
    return outcome;
  };
}
