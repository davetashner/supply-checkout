// Clearing an unpaid subscription a resubscription replaced
// (supply-checkout-8jc.44, docs/infrastructure.md "Billing").
//
// An owner of a team whose subscription is `unpaid` (a payment still owed)
// can start Checkout again. The owner's decision: once the new subscription
// is paid, the old debt is written off. The new subscription becomes the
// team's, and the old one is cleared in Stripe: cancelled at once, and its
// open invoices voided, so the customer isn't dunned for the old debt or
// charged twice. Draft invoices aren't touched (none is sent while the
// subscription is cancelled), nor are paid, void or uncollectible ones.
//
// The decisions, made by the worker (worker.ts) and by the nightly
// entitlement check when it picks up a resubscription whose events were lost
// (entitlements.ts):
// - Only a paid replacement writes the old debt off (isPaidReplacement): one
//   that's `active`, or `past_due` after at least one invoice that took money.
//   Never a `trialing` one, so a trial can't be used to have the debt voided
//   without paying (and Checkout never gives such a team a trial:
//   api/billing-handler.ts, trialAllowed). Until then the team stays on the
//   unpaid one, read-only as overdue. An `incomplete` one, whose first payment
//   hasn't gone through, doesn't replace it either: if it then expires
//   (`incomplete_expired`), the team is still the unpaid one's, and nothing in
//   Stripe was cancelled for a payment that never came.
// - The old one is cleared before the team takes the new one, so a failure
//   (Stripe or DynamoDB) retries the whole event: the team still names the
//   old one, so the retry clears it again. Clearing is idempotent: a
//   subscription that's no longer `unpaid` isn't cancelled again (no double
//   cancellation, even after Stripe's 24-hour idempotency window), Stripe's
//   own listing of open invoices leaves out the ones already voided, and each
//   request carries an idempotency key made from the object it changes. An
//   invoice Stripe refuses to void (an invalid-request error about it, which
//   no retry changes) is logged by ID for a person and skipped.
// - If the old one's own end arrives while the team still names it (the
//   clearing kept failing, say), the worker applies the paid replacement
//   instead of the end (worker.ts), so no deletion date starts while a paid
//   subscription exists.
// - Only the customer's own: an old subscription or invoice of another
//   customer is never touched.
//
// Logged: team, event, subscription and invoice IDs, statuses and counts.
// Never a name, an email or the Stripe key.

import { isPermanentStripeError, stripeErrorFields } from "./stripe.js";
import type { SubscriptionLike } from "./subscription.js";

/** The fields of an invoice the clearing reads. */
export interface InvoiceRef {
  readonly id: string;
  readonly customer: string | { readonly id: string } | null;
  readonly amount_paid?: number;
}

/** What clearing needs from the Stripe client: cancelling a subscription, and listing and voiding its invoices. */
export interface ReplacedStripe {
  readonly subscriptions: {
    cancel(id: string, params: Record<string, never>, options: { idempotencyKey: string }): PromiseLike<unknown>;
  };
  readonly invoices: {
    list(params: { subscription: string; status: "open" | "paid"; limit: number; starting_after?: string }): PromiseLike<{ readonly data: readonly InvoiceRef[]; readonly has_more: boolean }>;
    voidInvoice(id: string, params: Record<string, never>, options: { idempotencyKey: string }): PromiseLike<unknown>;
  };
}

/** How many invoices one listing asks for. A subscription goes unpaid after one invoice's retries fail, so there's rarely more than one. */
export const INVOICES_LISTED = 100;

const ownerOf = (customer: string | { readonly id: string } | null): string | undefined => (customer === null ? undefined : typeof customer === "string" ? customer : customer.id);

/**
 * Whether `sub` is paid enough to write off the unpaid one it replaces: `active`, or `past_due` after at
 * least one of its invoices took money (a trial's $0 invoice doesn't count). Never `trialing`, `incomplete`
 * or anything else. Reads Stripe only for `past_due`.
 */
export async function isPaidReplacement(stripe: ReplacedStripe, sub: Pick<SubscriptionLike, "id" | "status">): Promise<boolean> {
  if (sub.status === "active") return true;
  if (sub.status !== "past_due") return false;
  const { data } = await stripe.invoices.list({ subscription: sub.id, status: "paid", limit: INVOICES_LISTED });
  return data.some((invoice) => (invoice.amount_paid ?? 0) > 0);
}

/**
 * Whether `old`, the team's recorded subscription as Stripe has it now, is an unpaid one a
 * resubscription must clear: `unpaid` in Stripe, or `canceled` while the team still records it
 * as `unpaid` (a retry after the cancel went through, whose invoices may still be open).
 */
export function unpaidToClear(old: Pick<SubscriptionLike, "status">, recordedStatus: string | undefined): boolean {
  return old.status === "unpaid" || (old.status === "canceled" && recordedStatus === "unpaid");
}

/** The idempotency key for cancelling a replaced unpaid subscription. */
export const cancelReplacedKey = (subscriptionId: string) => `cancel-replaced-${subscriptionId}`;
/** The idempotency key for voiding one of its open invoices. */
export const voidReplacedKey = (invoiceId: string) => `void-replaced-${invoiceId}`;

/** What clearing did: whether it cancelled the subscription, how many invoices it voided, and those Stripe refused to void. */
export interface Cleared {
  readonly canceled: boolean;
  readonly voided: number;
  readonly refused: readonly string[];
}

/** Where clearing logs an invoice Stripe refused to void. */
export interface ClearLog {
  warn(message: string, data: Record<string, unknown>): void;
}

/**
 * Cancels `old` at once if it's still `unpaid`, and voids every open invoice of its that's the
 * customer's. Nothing for another customer's subscription. An invoice Stripe refuses for good
 * (isPermanentStripeError) is logged with its ID and skipped; any other Stripe failure throws, for
 * the caller to retry: what was done stays done, and the retry does only the rest.
 */
export async function clearReplacedUnpaid(stripe: ReplacedStripe, old: SubscriptionLike, customer: string, log: ClearLog, ids: Record<string, string>): Promise<Cleared> {
  if (ownerOf(old.customer) !== customer) return { canceled: false, voided: 0, refused: [] };
  let canceled = false;
  if (old.status === "unpaid") {
    // Cancelling doesn't void what's owed: Stripe only stops collecting it, so the invoices follow
    await stripe.subscriptions.cancel(old.id, {}, { idempotencyKey: cancelReplacedKey(old.id) });
    canceled = true;
  }
  let voided = 0;
  const refused: string[] = [];
  let after: string | undefined;
  do {
    const page = await stripe.invoices.list({ subscription: old.id, status: "open", limit: INVOICES_LISTED, ...(after ? { starting_after: after } : {}) });
    for (const invoice of page.data) {
      if (ownerOf(invoice.customer) !== customer) continue;
      try {
        await stripe.invoices.voidInvoice(invoice.id, {}, { idempotencyKey: voidReplacedKey(invoice.id) });
        voided++;
      } catch (error) {
        if (!isPermanentStripeError(error)) throw error;
        refused.push(invoice.id);
        log.warn("Replaced unpaid subscription's invoice not voided: void it by hand", { ...ids, subscriptionId: old.id, invoiceId: invoice.id, ...stripeErrorFields(error) });
      }
    }
    after = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (after);
  return { canceled, voided, refused };
}
