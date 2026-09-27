// The billing worker (ADR 0009, docs/infrastructure.md "Billing"): applies one
// verified Stripe event from the billing queue to its team.
//
// For each event, in order:
// 1. Skip it if its record says it was already applied (markWebhookProcessed).
// 2. Find the team from our own link for the event's customer (never from the
//    event). An unknown customer, a purged team (no META item), a closed team
//    or one the purge has started on: record the event and change nothing.
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
// Logged: event, team and subscription IDs, statuses, counts and SES error
// names. Never an owner's email or a name.

import { planForLookupKey } from "./catalog.js";
import {
  applySubscription,
  claimBillingNotice,
  type Db,
  getBillingTeam,
  hasEnded,
  isWebhookProcessed,
  listOwnerContacts,
  markWebhookProcessed,
  stripeCustomerTeam,
  type SubscriptionState,
  type TeamContext,
  teamContextForStripeCustomer,
} from "../data/index.js";
import { EmailNotSentError, type Mailer, sendTeamNotice } from "../email/mailer.js";
import type { EmailInput } from "../email/templates.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { BILLING_EVENTS, type BillingEventType } from "./names.js";
import type { BillingMessage } from "./webhook-handler.js";
import type { DbForWorker } from "./worker-db.js";

/** The fields of a Stripe subscription the worker reads. */
export interface SubscriptionLike {
  readonly id: string;
  readonly customer: string | { readonly id: string };
  readonly status: string;
  readonly cancel_at_period_end: boolean;
  readonly trial_end: number | null;
  readonly default_payment_method: string | { readonly id: string } | null;
  readonly items: {
    readonly data: readonly {
      readonly quantity?: number;
      readonly current_period_end: number;
      readonly price: { readonly lookup_key: string | null; readonly recurring: { readonly interval: string } | null };
    }[];
  };
}

/** What the worker needs from the Stripe client. */
export interface WorkerStripe {
  readonly subscriptions: {
    retrieve(id: string): PromiseLike<SubscriptionLike>;
    cancel(id: string, params: Record<string, never>, options: { idempotencyKey: string }): PromiseLike<unknown>;
  };
}

export interface BillingWorkerDeps {
  readonly dbFor: DbForWorker;
  readonly stripe: () => Promise<WorkerStripe>;
  readonly mailer: Mailer;
  readonly obs: Observability;
  readonly now?: () => number;
}

/** What happened to one event. */
export type Outcome = "applied" | "duplicate" | "unknown_customer" | "team_gone" | "team_closed" | "second_subscription_canceled" | "ignored";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const iso = (seconds: number | null | undefined) => (typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined);
const idOf = (value: string | { readonly id: string }) => (typeof value === "string" ? value : value.id);

/** A queue message, checked: the webhook wrote it, but the worker trusts no shape it didn't check. */
export function parseMessage(body: string): BillingMessage {
  const m = JSON.parse(body) as Partial<BillingMessage>;
  const ok =
    typeof m === "object" &&
    m !== null &&
    typeof m.eventId === "string" &&
    ID.test(m.eventId) &&
    typeof m.customer === "string" &&
    ID.test(m.customer) &&
    (BILLING_EVENTS as readonly string[]).includes(m.type as string) &&
    typeof m.created === "number" &&
    (m.subscription === undefined || (typeof m.subscription === "string" && ID.test(m.subscription)));
  if (!ok) throw new Error("Not a billing message");
  return m as BillingMessage;
}

/** Our view of a subscription: what applySubscription writes. */
export function subscriptionState(sub: SubscriptionLike, customerId: string, replaces?: string): SubscriptionState {
  const items = sub.items.data;
  const first = items[0];
  const known = planForLookupKey(first?.price.lookup_key);
  const end = first ? iso(first.current_period_end) : undefined;
  return {
    customerId,
    subscriptionId: sub.id,
    ...(replaces !== undefined ? { replaces } : {}),
    ...(known ? { plan: known.plan, interval: known.interval } : {}),
    seats: items.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
    status: sub.status,
    ...(end !== undefined ? { currentPeriodEnd: end } : {}),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  };
}

/** Statuses after which the team is read-only (ENDED_STATUSES) or on hold: an owner is told when it gets there. */
const readOnlyStatus = (status: string | undefined) => hasEnded(status) || status === "paused";

/** The owner email an event calls for, if any, decided from the event itself so a retry decides the same. */
export function noticeFor(message: BillingMessage, sub: SubscriptionLike | undefined, teamName: string): Exclude<EmailInput, { kind: "invite" }> | undefined {
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
  async function notify(db: Db, ctx: TeamContext, eventId: string, input: Exclude<EmailInput, { kind: "invite" }>): Promise<void> {
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
    // A closed team changes no more (supply-checkout-t0en), and a purging one is going
    if (team.closed || team.purging) return done("team_closed");
    if (!message.subscription) return done("ignored");
    const stripe = await deps.stripe();
    const sub = await stripe.subscriptions.retrieve(message.subscription);
    if (idOf(sub.customer) !== customer) return done("ignored");
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
    const result = await applySubscription(db, ctx, subscriptionState(sub, customer, chosen.replaces), now());
    if (result === "ignored") return done("team_closed");
    obs.count(BusinessMetric.BillingEventsApplied, 1, { teamId, type: message.type });
    const notice = noticeFor(message, sub, team.name);
    // Read-only only if no comp keeps the team going
    if (notice && (notice.kind !== "readOnly" || (await getBillingTeam(db, ctx, now()))?.readOnly)) await notify(db, ctx, eventId, notice);
    return done("applied");
  }

  return async (message: BillingMessage): Promise<Outcome> => {
    const outcome = await process(message);
    obs.logger.info("Billing event", { eventId: message.eventId, type: message.type, outcome });
    return outcome;
  };
}
