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
//    conditions never recreate a purged team or touch a closed one. A new
//    subscription replaces the team's once that has ended; an unpaid one only
//    once the new one is paid (never a trial), and is then cancelled and its open invoices
//    voided first (replaced.ts, supply-checkout-8jc.44). Applying
//    the latest state is harmless to repeat and doesn't depend on the order
//    events arrive in; the queue also hands a customer's events over one at a
//    time (FIFO, grouped by customer).
// 4. Email each owner, at most once per event (claimBillingNotice before
//    sending), when the event is a trial ending without a card, a failed
//    payment, or the subscription ending (the team turns read-only, and the
//    notice says when it's deleted unless an owner subscribes). A payment
//    overdue past its grace period has no event, so no notice here
//    (supply-checkout-qdx adds a scheduled one).
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
// A message on the seat sync queue with reason `closed` isn't a seat sync: the
// account function sends one as a team closes, and the worker sets the closed
// team's subscription to cancel at the period's end within seconds instead of
// at the hourly purge's next run (endAtClose, supply-checkout-8jc.30).
//
// Nor is one with reason `comp`: the ops function sends one after an operator
// changes a team's comp, and the worker makes the subscription's comp
// discount match the team's comp (comp-discount.ts, supply-checkout-6e4b),
// recording the outcome in the operator audit. The nightly reconciliation
// does the same, after the seat sync, for a team that has ever been comped,
// and audits what it changes, and so does the seat sync after a reopen (a
// comp may have ended while the team was closed). It runs even when the seat
// sync failed; the message then still fails for the seat sync.
//
// Logged: event, team and subscription IDs, statuses, counts and SES error
// names. Never an owner's email or a name.

import { type CompDiscountOutcome, type CompDiscountStripe, reconcileCompDiscount } from "./comp-discount.js";
import { type ClosingStripe, closingAction, customerOf, endSubscriptionForClosedTeam, removeStamp, resumeSubscription, staleStamp } from "./closing.js";
import {
  applySubscription,
  type BillingTeam,
  claimBillingNotice,
  type Db,
  getBillingTeam,
  hasEnded,
  hasStopped,
  isWebhookProcessed,
  listOwnerContacts,
  markWebhookProcessed,
  recordCompDiscount,
  stripeCustomerTeam,
  type TeamContext,
  teamContextForStripeCustomer,
} from "../data/index.js";
import { EmailNotSentError, type Mailer, sendTeamNotice } from "../email/mailer.js";
import type { TeamNoticeInput } from "../email/templates.js";
import { BusinessMetric, type Observability, testMark } from "../observability/index.js";
import { BILLING_EVENTS, type BillingEventType } from "./names.js";
import type { BillingMessage } from "./webhook-handler.js";
import { createEntitlementCheck, type EntitlementOutcome, type EntitlementStripe, SUBSCRIPTIONS_LISTED } from "./entitlements.js";
import { createReopenResync } from "./reopening.js";
import { clearReplacedUnpaid, isPaidReplacement, type ReplacedStripe, unpaidToClear } from "./replaced.js";
import { createSeatSync, findSeatTeam, parseSeatSync, readSeatTeamAgain, type SeatOutcome, type SeatStripe, type SeatSyncMessage, type SeatTeam, type SeatTeamMissing } from "./seats.js";
import { iso, type SubscriptionLike, subscriptionState } from "./subscription.js";
import type { DbForWorker } from "./worker-db.js";

export { type SubscriptionLike, subscriptionState } from "./subscription.js";

/**
 * What the worker needs from the Stripe client: reading a subscription, cancelling a second one, ending a closed
 * team's (closing.ts), and clearing an unpaid one a resubscription replaced (replaced.ts).
 */
export type WorkerStripe = ClosingStripe & ReplacedStripe;

export interface BillingWorkerDeps {
  readonly dbFor: DbForWorker;
  readonly stripe: () => Promise<WorkerStripe & SeatStripe & EntitlementStripe & CompDiscountStripe>;
  readonly mailer: Mailer;
  readonly obs: Observability;
  readonly now?: () => number;
}

/** What happened to one event. */
export type Outcome = "applied" | "duplicate" | "unknown_customer" | "team_gone" | "team_closed" | "second_subscription_canceled" | "ignored";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Logged when a team was reopened while its subscription was being ended: the same line as the purge's (ops/team-purge-handler.ts). */
const TEAM_REOPENED = "Team reopened while its subscription was being ended";
/** Logged when the team couldn't be read again after its subscription was set to end: it may have been reopened (supply-checkout-8jc.30). The same line as the purge's. */
const NOT_READ_AGAIN = "Closed team's subscription set to end, but the team wasn't read again";

/** What endForClosedTeam did. */
type EndOutcome = "ended" | "nothing_to_end" | "not_ours" | "left_to_purge" | "reopened" | "unchecked";

/** What a message with reason `closed` did (endAtClose). */
export type ClosedSyncOutcome =
  | "closed_team_ended"
  | "closed_team_deferred"
  | "nothing_to_end"
  | "left_to_purge"
  | "team_reopened"
  | "unchecked"
  | "team_open"
  | "team_closed"
  | "team_gone"
  | "unknown_customer"
  | "not_ours"
  | "no_subscription";

/** What a message with reason `comp` did (compDiscount): the reconcile's outcome, or why it didn't run. */
export type CompSyncOutcome = CompDiscountOutcome | SeatTeamMissing | "team_closed";

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

/**
 * Whether `sub` is another subscription than the team's, it's over (STOPPED_STATUSES), and it must not replace
 * the team's, so it's ignored:
 * - the team's is `unpaid`: a payment still owed on a live subscription, never deleted for (billingAccess). An
 *   over one replacing it would give the team a deletion date (often past) that nothing puts back. Only a live
 *   subscription (a resubscription) replaces an unpaid one.
 * - the team's is over too, and `sub` ended no later than its recorded `subscriptionEndedAt`: applying it would
 *   replace the team's subscription with an older one and move its deletion date earlier. One that ended
 *   later, one without `ended_at`, or a team with no recorded end, is applied as before (the date is kept if
 *   it's there).
 */
export function endedEarlier(sub: SubscriptionLike, team: Pick<BillingTeam, "stripeSubscriptionId" | "status" | "subscriptionEndedAt">): boolean {
  if (!team.stripeSubscriptionId || sub.id === team.stripeSubscriptionId || !hasStopped(sub.status)) return false;
  if (team.status === "unpaid") return true;
  if (!hasStopped(team.status)) return false;
  const recorded = Date.parse(team.subscriptionEndedAt ?? "");
  if (!Number.isFinite(recorded)) return false;
  // Without ended_at the date can only be when the worker first saw it: never earlier, so only a dated older one is ignored
  return typeof sub.ended_at === "number" && sub.ended_at * 1000 <= recorded;
}

export function createBillingWorker(deps: BillingWorkerDeps) {
  const { obs } = deps;
  const now = () => new Date((deps.now ?? Date.now)());

  /**
   * The subscription to apply, and the one it replaces: the team's own, or a
   * new one once the team's has ended. A second live subscription for a team
   * that has one isn't applied: it's a duplicate checkout (two Checkout pages
   * finished before the first webhook landed), and the worker cancels it
   * (`second`). The team's subscription is read from Stripe unless the team
   * records it as over (canceled, incomplete_expired). An unpaid one
   * (replaced.ts, supply-checkout-8jc.44) is replaced only by a paid one
   * (isPaidReplacement: never a trial), and comes back as `unpaid` to be
   * cleared first; for any other (a trial, an `incomplete` checkout) the team
   * keeps it (`wait`), and the new one's later event applies it once it's paid.
   */
  async function choose(stripe: WorkerStripe, sub: SubscriptionLike, stored: string | undefined, storedStatus: string): Promise<{ replaces?: string; unpaid?: SubscriptionLike } | "second" | "wait"> {
    if (!stored || stored === sub.id) return {};
    if (hasStopped(storedStatus)) return { replaces: stored };
    const current = await stripe.subscriptions.retrieve(stored);
    if (!hasEnded(current.status)) return "second";
    if (!unpaidToClear(current, storedStatus)) return { replaces: stored };
    return (await isPaidReplacement(stripe, sub)) ? { replaces: stored, unpaid: current } : "wait";
  }

  /** The customer's newest paid subscription other than `ended` (isPaidReplacement), if any: what replaced it. */
  async function paidReplacementFor(stripe: WorkerStripe & EntitlementStripe, customer: string, ended: string): Promise<SubscriptionLike | undefined> {
    const { data } = await stripe.subscriptions.list({ customer, status: "all", limit: SUBSCRIPTIONS_LISTED });
    for (const candidate of data) {
      if (candidate.id !== ended && customerOf(candidate) === customer && (await isPaidReplacement(stripe, candidate))) return candidate;
    }
    return undefined;
  }

  /** Emails each owner about the event, once each whatever the retries (claimBillingNotice first). */
  async function notify(db: Db, ctx: TeamContext, eventId: string, input: TeamNoticeInput, mark: { readonly test?: true }): Promise<void> {
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
    if (sent) obs.count(BusinessMetric.BillingNotices, sent, { teamId: ctx.teamId, kind: input.kind, ...mark });
    if (failures.length) {
      obs.count(BusinessMetric.BillingNoticeFailures, failures.length, { teamId: ctx.teamId, kind: input.kind, ...mark });
      obs.logger.warn("Billing emails not sent", { teamId: ctx.teamId, eventId, kind: input.kind, failed: failures.length, codes: [...new Set(failures)].join(",") });
    }
  }

  /**
   * Ends a subscription still live on a closed team (closing.ts): the subscription as fetched
   * (`sub`), or fetched here. Only the customer's own. `request` is the Stripe event or the
   * closing message asking (its ID keys the Stripe request, and is logged as `log` names it).
   * With `atClose`, only a cancellation at the period's end is made: one to cancel at once
   * can't be resumed by a reopen right after, so it's left to the purge (`left_to_purge`).
   * Throws on a Stripe failure, for the caller to retry or defer.
   *
   * Then, if Stripe was asked to change anything, reads the team again (consistent): an
   * owner who reopened it meanwhile (or reopened and closed it again) now has a subscription
   * set to end that they meant to keep. If it's open and the change was setting it to cancel
   * at the period's end, that's undone at once (resumeSubscription, its own key), since the
   * reopen's resync may already have run (supply-checkout-85qp), and warned of. Otherwise
   * (cancelled at once, closed again, or the resume failed) it's counted
   * (ReopenedTeamSubscriptionsEnded, the "Reopened team's subscription ended" alarm) and
   * logged as an error as the purge does: `reopened`. If that read fails, the team may have
   * been reopened with nothing to see it (supply-checkout-8jc.30), so it's counted for the
   * same alarm and logged as an error too: `unchecked`. A team purged meanwhile is fine:
   * deleting its customer ends the subscription anyway.
   */
  async function endForClosedTeam(
    db: Db,
    ctx: TeamContext,
    request: { readonly id: string; readonly log: Record<string, string>; readonly customer: string; readonly subscription?: string },
    team: BillingTeam,
    options: { readonly sub?: SubscriptionLike; readonly atClose?: boolean } = {},
  ): Promise<EndOutcome> {
    if (!request.subscription || !team.closedAt) return "nothing_to_end";
    const stripe = await deps.stripe();
    const current = options.sub ?? (await stripe.subscriptions.retrieve(request.subscription));
    if (customerOf(current) !== request.customer) return "not_ours";
    const planned = closingAction(current, team.closedAt);
    if (options.atClose && planned === "cancel_now") return "left_to_purge";
    // Keyed by the event or message too: a later one's request (after the subscription changed) is never a cached replay of this one
    const action = await endSubscriptionForClosedTeam(stripe, current, { teamId: team.teamId, closedAt: team.closedAt }, request.id);
    if (action === "none") return "nothing_to_end";
    const ids = { teamId: team.teamId, ...request.log, subscriptionId: current.id, action };
    let after: BillingTeam | undefined;
    try {
      after = await getBillingTeam(db, ctx, now());
    } catch (error) {
      obs.count(BusinessMetric.ReopenedTeamSubscriptionsEnded, 1, { teamId: team.teamId, action, checked: "no", ...testMark(team.test) });
      obs.logger.error(NOT_READ_AGAIN, { ...ids, error: (error as { name?: string } | null)?.name ?? "Unknown" });
      return "unchecked";
    }
    if (after && after.closedAt !== team.closedAt) {
      if (await resumedAfterReopen(stripe, current.id, after, team.closedAt, action)) {
        obs.count(BusinessMetric.ReopenedTeamSubscriptionsResumed, 1, { teamId: team.teamId, source: "worker", ...testMark(team.test) });
        obs.logger.warn("Team reopened while its subscription was being ended: resumed", ids);
      } else {
        obs.count(BusinessMetric.ReopenedTeamSubscriptionsEnded, 1, { teamId: team.teamId, action, ...testMark(team.test) });
        obs.logger.error(TEAM_REOPENED, ids);
      }
      return "reopened";
    }
    obs.count(BusinessMetric.ClosedTeamSubscriptionsEnded, 1, { teamId: team.teamId, action, ...testMark(team.test) });
    obs.logger.info("Closed team's subscription ended", { teamId: team.teamId, ...request.log, subscriptionId: current.id, status: current.status, action });
    return "ended";
  }

  /**
   * endForClosedTeam for a Stripe event. A team reopened meanwhile, or one that couldn't be
   * read again, throws, so the event isn't recorded and its retry applies the subscription
   * to the open team.
   */
  async function endForEvent(db: Db, ctx: TeamContext, message: BillingMessage, team: BillingTeam, sub?: SubscriptionLike): Promise<void> {
    const request = { id: message.eventId, log: { eventId: message.eventId }, customer: message.customer, ...(message.subscription ? { subscription: message.subscription } : {}) };
    const outcome = await endForClosedTeam(db, ctx, request, team, sub ? { sub } : {});
    if (outcome === "reopened") throw Object.assign(new Error(TEAM_REOPENED), { name: "TeamReopened" });
    if (outcome === "unchecked") throw Object.assign(new Error(NOT_READ_AGAIN), { name: "TeamNotReadAgain" });
  }

  /**
   * Ending a subscription at close (supply-checkout-8jc.30): a message with reason `closed`
   * on the seat sync queue, which the account function sends as a team closes. Sets the
   * team's recorded subscription to cancel at the period's end, stamped with the closure
   * (endForClosedTeam, `atClose`), within seconds of the closure, so a renewal or trial
   * conversion before the hourly purge's next run isn't charged. Nothing is written to the
   * team: the stamp is the record of whose cancellation it is, so a reopen right after
   * resumes it (reopening.ts), and the purge, finding it already set to cancel for this
   * closure (closingAction `none`), sends Stripe nothing and records it. The team comes
   * from our own link, as for any seat sync. Best effort: a Stripe or DynamoDB failure is logged and
   * left to the purge, so the message never fails and never holds up the customer's later
   * syncs (the reopen's, say). A reopen while Stripe was asked is handled and alarmed as
   * for an event, and isn't retried: the team is open then, so a retry would do nothing.
   */
  async function endAtClose(message: SeatSyncMessage): Promise<ClosedSyncOutcome> {
    const { id, customer } = message;
    let teamId: string | undefined;
    // Any failure (DynamoDB or Stripe) is left to the purge: the message never fails, so it never holds up the customer's FIFO group
    try {
      const own = deps.dbFor({ eventId: id, stripeCustomer: customer });
      teamId = await stripeCustomerTeam(own, customer);
      if (!teamId) return "unknown_customer";
      const db = deps.dbFor({ eventId: id, stripeCustomer: customer, teamId });
      const ctx = await teamContextForStripeCustomer(db, customer);
      if (!ctx || ctx.teamId !== teamId) return "team_gone";
      const team = await getBillingTeam(db, ctx, now());
      if (!team) return "team_gone";
      // Being purged: deleting its customer ends the subscription
      if (team.purging) return "team_closed";
      // Reopened before this ran: nothing to end
      if (!team.closed) return "team_open";
      if (team.stripeCustomerId !== customer) return "not_ours";
      if (!team.stripeSubscriptionId) return "no_subscription";
      const outcome = await endForClosedTeam(db, ctx, { id, log: { messageId: id }, customer, subscription: team.stripeSubscriptionId }, team, { atClose: true });
      return outcome === "ended" ? "closed_team_ended" : outcome === "reopened" ? "team_reopened" : outcome;
    } catch (error) {
      obs.logger.warn("Closed team's subscription not ended at close: the purge will", { teamId: teamId ?? "", messageId: id, error: (error as { name?: string } | null)?.name ?? "Unknown" });
      return "closed_team_deferred";
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

  /**
   * A comp's Stripe discount (comp-discount.ts): makes the team's subscription match its comp. For a
   * `comp` message every outcome on a found team is audited (`all`); for the nightly reconciliation,
   * only a change (`changes`). The team comes from our own link, never from the message. Throws on a
   * Stripe or DynamoDB failure, so the message is retried.
   */
  async function compDiscount(message: SeatSyncMessage, found: SeatTeam | SeatTeamMissing, audit: "all" | "changes"): Promise<CompSyncOutcome> {
    if (typeof found === "string") return found;
    const { db, ctx, team } = found;
    const record = async (result: { outcome: string; subscriptionId: string | null; before: string | null; coupon: string | null; until: string | null }) => {
      if (audit === "all" || result.outcome === "applied" || result.outcome === "removed") await recordCompDiscount(db, ctx, message.id, result, now());
    };
    const skip = async (outcome: "team_closed" | "not_ours"): Promise<CompSyncOutcome> => {
      await record({ outcome, subscriptionId: null, before: null, coupon: null, until: null });
      return outcome;
    };
    // A closed team keeps what it had: its subscription is ending, and the purge deletes its customer
    if (team.closed || team.purging) return skip("team_closed");
    if (team.stripeCustomerId !== message.customer) {
      obs.logger.warn("Comp discount skipped: the team has another Stripe customer", { teamId: ctx.teamId, messageId: message.id });
      return skip("not_ours");
    }
    const result = await reconcileCompDiscount(await deps.stripe(), team, message.customer, now());
    await record(result);
    obs.logger.info("Comp discount", { teamId: ctx.teamId, messageId: message.id, reason: message.reason, subscriptionId: result.subscriptionId ?? "", outcome: result.outcome, coupon: result.coupon ?? "", before: result.before ?? "" });
    return result.outcome;
  }

  /**
   * A read-only notice only if the team is read-only now, as it was just applied (no comp keeps it going),
   * with the date it's deleted unless an owner subscribes (billingAccess). Any other notice as it is.
   */
  async function withAccess(db: Db, ctx: TeamContext, notice: TeamNoticeInput | undefined): Promise<TeamNoticeInput | undefined> {
    if (notice?.kind !== "readOnly") return notice;
    const after = await getBillingTeam(db, ctx, now());
    if (!after?.readOnly) return undefined;
    return { ...notice, ...(after.readOnlyReason ? { reason: after.readOnlyReason } : {}), ...(after.deleteAfter ? { deletesAt: after.deleteAfter } : {}) };
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
      await endForEvent(db, ctx, message, team);
      return done("team_closed");
    }
    if (!message.subscription) return done("ignored");
    const stripe = await deps.stripe();
    let sub = await stripe.subscriptions.retrieve(message.subscription);
    if (customerOf(sub) !== customer) return done("ignored");
    // The team's own subscription has ended (or gone unpaid): if a paid one has replaced it whose own events
    // failed (clearing an unpaid one kept failing, say), the team takes that one instead, so no deletion date
    // starts while a paid subscription exists (replaced.ts)
    if (sub.id === team.stripeSubscriptionId && hasEnded(sub.status)) sub = (await paidReplacementFor(stripe, customer, sub.id)) ?? sub;
    // An older ended subscription (a replayed or late event) never replaces the team's unpaid one, or an ended
    // one that ended later: it would give the team a deletion date, or pull it in (billingAccess)
    if (endedEarlier(sub, team)) return done("ignored");
    const chosen = await choose(stripe, sub, team.stripeSubscriptionId, team.status);
    if (chosen === "wait") {
      obs.logger.info("Resubscription not live yet: the team keeps its unpaid subscription", { teamId, eventId, subscriptionId: sub.id, status: sub.status, kept: team.stripeSubscriptionId ?? "" });
      return done("ignored");
    }
    if (chosen === "second") {
      // One subscription per team: cancel the second at once, so its trial never turns
      // into a charge. One that was already paid is logged for a refund by hand
      if (!hasEnded(sub.status)) {
        await stripe.subscriptions.cancel(sub.id, {}, { idempotencyKey: `cancel-second-${sub.id}` });
        obs.logger.warn("Second subscription canceled", { teamId, eventId, subscriptionId: sub.id, status: sub.status, kept: team.stripeSubscriptionId ?? "" });
      }
      // An ended one (a replaced subscription's own end, say) changes nothing
      return done(hasEnded(sub.status) ? "ignored" : "second_subscription_canceled");
    }
    // A stamp that no longer means anything goes (closing.ts): with no resync pending, any; while one is, one on a renewed
    // subscription. So an owner's later cancellation is never taken for a closure's, or stamped again at the next closing
    if (staleStamp(sub, team.resyncFor !== undefined)) await removeStamp(stripe, sub, teamId, eventId);
    // The unpaid one it replaces is cleared before the team takes the new one: a failure retries the event, and
    // the team still names the old one, so the retry clears what's left (replaced.ts)
    if (chosen.unpaid) {
      const cleared = await clearReplacedUnpaid(stripe, chosen.unpaid, customer, obs.logger, { teamId, eventId });
      obs.logger.info("Replaced unpaid subscription cleared", { teamId, eventId, subscriptionId: chosen.unpaid.id, status: chosen.unpaid.status, canceled: cleared.canceled, voided: cleared.voided, refused: cleared.refused.length, by: sub.id });
    }
    const result = await applySubscription(db, ctx, subscriptionState(sub, customer, chosen.replaces), now());
    if (result === "ignored") {
      // Closed (or gone) since it was read: a subscription it never recorded is ended here, or it would renew
      const after = await getBillingTeam(db, ctx, now());
      if (after?.closed && !after.purging) await endForEvent(db, ctx, message, after, sub);
      return done("team_closed");
    }
    obs.count(BusinessMetric.BillingEventsApplied, 1, { teamId, type: message.type, ...testMark(team.test) });
    const notice = await withAccess(db, ctx, noticeFor(message, sub, team.name));
    if (notice) await notify(db, ctx, eventId, notice, testMark(team.test));
    return done("applied");
  }

  const seats = createSeatSync({ dbFor: deps.dbFor, stripe: deps.stripe, obs, now: deps.now });
  const reopened = createReopenResync({ dbFor: deps.dbFor, stripe: deps.stripe, obs, now: deps.now });
  const entitlements = createEntitlementCheck({ dbFor: deps.dbFor, stripe: deps.stripe, obs, now: deps.now });

  /** `delivery` is the SQS message ID that delivered it, when a queue did: part of a seat update's idempotency key (seats.ts). */
  return async (message: QueueMessage, delivery?: string): Promise<Outcome | SeatOutcome | EntitlementOutcome | ClosedSyncOutcome | CompSyncOutcome> => {
    // Checked again here, whatever handed it over: only a well-formed seat sync goes to the seat sync
    if ("kind" in message) {
      const sync = parseSeatSync(JSON.stringify(message));
      // A team that just closed: its subscription is set to end, and nothing else (supply-checkout-8jc.30)
      if (sync.reason === "closed") {
        const outcome = await endAtClose(sync);
        obs.logger.info("Seat sync", { messageId: sync.id, reason: sync.reason, outcome });
        return outcome;
      }
      // The link, the team context and the team, read once for the resync and the seat sync (supply-checkout-8jc.39)
      let found = await findSeatTeam(deps.dbFor, sync, now());
      // An operator changed the team's comp: its Stripe discount, and nothing else (comp-discount.ts)
      if (sync.reason === "comp") {
        const outcome = await compDiscount(sync, found, "all");
        obs.logger.info("Seat sync", { messageId: sync.id, reason: sync.reason, outcome });
        return outcome;
      }
      // A reopened team's subscription first (reopening.ts): the reopen's own sync, or the night's for one still waiting.
      // Whatever it did, the seat sync sees the team as it left it
      const resync = await reopened(sync, found);
      if (resync !== "none") found = await readSeatTeamAgain(found, now());
      // Only a resync that reached the subscription: not a subscription Stripe doesn't have, another customer's, or a closed team
      const resynced = !["none", "missing", "not_ours", "team_closed"].includes(resync);
      // The nightly reconciliation: the team's status, plan and seats against Stripe's first (entitlements.ts), then the quantity.
      // A recorded subscription or customer Stripe no longer has is counted there; the seat sync would only fail on it
      if (sync.reason === "reconcile") {
        if ((await entitlements(sync)) === "missing") return "missing";
        // It may have fixed the team
        found = await readSeatTeamAgain(found, now());
      }
      // Then, every night and right after a reopen, a comp's discount, for a team ever comped (compUntil stays after a comp
      // ends): a `comp` message that was never queued, failed for good, or came while the team was closed, is put right here
      // (comp-discount.ts). Whether or not the seat sync failed: one team's seat trouble mustn't keep its discount on
      const compToo = (sync.reason === "reconcile" || resynced) && typeof found !== "string" && found.team.compUntil !== undefined;
      if (!compToo) return seats(sync, delivery, found);
      let outcome: SeatOutcome | undefined;
      let failure: unknown;
      try {
        outcome = await seats(sync, delivery, found);
      } catch (error) {
        failure = error;
      }
      try {
        await compDiscount(sync, found, "changes");
      } catch (error) {
        if (failure === undefined) throw error;
        // Both failed: the seat sync's error fails the message (retried, then the dead-letter queue); this one is logged too
        obs.logger.error("Comp discount failed", { messageId: sync.id, reason: sync.reason, code: (error as { name?: string } | null)?.name ?? "Unknown" });
      }
      if (failure !== undefined) throw failure;
      return outcome as SeatOutcome;
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
