// Clearing an unpaid subscription a resubscription replaced
// (supply-checkout-8jc.44, docs/infrastructure.md "Billing").
//
// An owner of a team whose subscription is `unpaid` (a payment still owed)
// can start Checkout again. The new subscription becomes the team's, and the
// old one is cleared in Stripe: cancelled at once, and its open invoices
// voided, so the customer isn't dunned for the old debt or charged twice.
//
// The decisions, both made by the worker (worker.ts) and by the nightly
// entitlement check when it picks up a resubscription whose events were lost
// (entitlements.ts):
// - An unpaid subscription stays the team's until the new one is live
//   (LIVE_REPLACEMENT: trialing, active, past_due). An `incomplete` one, whose
//   first payment hasn't gone through, never replaces it: if it then expires
//   (`incomplete_expired`), the team is still the unpaid one's, read-only as
//   overdue and never dated for deletion, and nothing in Stripe was cancelled
//   for a payment that never came.
// - The old one is cleared before the team takes the new one, so a failure
//   (Stripe or DynamoDB) retries the whole event: the team still names the
//   old one, so the retry clears it again. Clearing is idempotent: a
//   subscription that's no longer `unpaid` isn't cancelled again (no double
//   cancellation, even after Stripe's 24-hour idempotency window), Stripe's
//   own listing of open invoices leaves out the ones already voided, and each
//   request carries an idempotency key made from the object it changes.
// - Only the customer's own: an old subscription or invoice of another
//   customer is never touched.
//
// Logged: team, event and subscription IDs, statuses and counts. Never a
// name, an email or the Stripe key.

import type { SubscriptionLike } from "./subscription.js";

/** The fields of an invoice the clearing reads. */
export interface OpenInvoice {
  readonly id: string;
  readonly customer: string | { readonly id: string } | null;
}

/** What clearing needs from the Stripe client: cancelling a subscription, and listing and voiding its open invoices. */
export interface ReplacedStripe {
  readonly subscriptions: {
    cancel(id: string, params: Record<string, never>, options: { idempotencyKey: string }): PromiseLike<unknown>;
  };
  readonly invoices: {
    list(params: { subscription: string; status: "open"; limit: number; starting_after?: string }): PromiseLike<{ readonly data: readonly OpenInvoice[]; readonly has_more: boolean }>;
    voidInvoice(id: string, params: Record<string, never>, options: { idempotencyKey: string }): PromiseLike<unknown>;
  };
}

/** Statuses of a new subscription that replace a team's unpaid one: live, and its first payment through (or a trial). */
export const LIVE_REPLACEMENT: readonly string[] = ["trialing", "active", "past_due"];

/** How many open invoices one listing asks for. A subscription goes unpaid after one invoice's retries fail, so there's rarely more than one. */
export const OPEN_INVOICES_LISTED = 100;

const ownerOf = (customer: string | { readonly id: string } | null): string | undefined => (customer === null ? undefined : typeof customer === "string" ? customer : customer.id);

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

/** What clearing did: whether it cancelled the subscription, and how many invoices it voided. */
export interface Cleared {
  readonly canceled: boolean;
  readonly voided: number;
}

/**
 * Cancels `old` at once if it's still `unpaid`, and voids every open invoice of its that's the
 * customer's. Nothing for another customer's subscription. Throws on a Stripe failure, for the
 * caller to retry; what was done stays done, and the retry does only the rest.
 */
export async function clearReplacedUnpaid(stripe: ReplacedStripe, old: SubscriptionLike, customer: string): Promise<Cleared> {
  if (ownerOf(old.customer) !== customer) return { canceled: false, voided: 0 };
  let canceled = false;
  if (old.status === "unpaid") {
    // Cancelling doesn't void what's owed: Stripe only stops collecting it, so the invoices follow
    await stripe.subscriptions.cancel(old.id, {}, { idempotencyKey: cancelReplacedKey(old.id) });
    canceled = true;
  }
  let voided = 0;
  let after: string | undefined;
  do {
    const page = await stripe.invoices.list({ subscription: old.id, status: "open", limit: OPEN_INVOICES_LISTED, ...(after ? { starting_after: after } : {}) });
    for (const invoice of page.data) {
      if (ownerOf(invoice.customer) !== customer) continue;
      await stripe.invoices.voidInvoice(invoice.id, {}, { idempotencyKey: voidReplacedKey(invoice.id) });
      voided++;
    }
    after = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (after);
  return { canceled, voided };
}
