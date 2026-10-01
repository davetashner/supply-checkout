// A team's billing as Stripe has it, for `GET /ops/teams/{teamId}` (ADR 0015
// §2–3, supply-checkout-6uw.4): its subscription and its latest invoices.
//
// The ops function calls Stripe with its own restricted key, separate from
// the billing functions' secret key (stripeOpsKeySecretName in
// billing/names.ts; only the ops function's role may read it). The key is
// limited in Stripe to reading customers, subscriptions and invoices and
// writing coupons and promotion codes, so even a bug here can't charge,
// refund or cancel anything.
//
// The customer is the one on the team's index entry (GSI3), never anything
// from the request. Only what an operator needs comes back: IDs, statuses,
// the price's lookup key, seats, dates and amounts. Never the customer's
// email, name or address, a card or payment method, or a link to Stripe's
// hosted invoice page or PDF: those are bearer links that show the
// customer's billing details (and let anyone pay), and owners already have
// them in the app.
//
// It fails soft. Without the key (the owner hasn't stored it yet), or if
// Stripe errors or is slow, the team's record still comes back, with
// `stripe: { error: "unavailable" }`. The failure is logged with the team ID
// and Stripe's error type, code, status and request ID only (stripeErrorFields):
// never the key, Stripe's message (which can echo parameters) or an email.

import type { Observability } from "../observability/index.js";
import { planForLookupKey } from "../billing/catalog.js";
import { stripeErrorFields } from "../billing/stripe.js";
import { iso } from "../billing/subscription.js";

/** The fields of a Stripe subscription the ops detail reads. */
export interface OpsSubscriptionLike {
  readonly id: string;
  readonly customer: string | { readonly id: string };
  readonly status: string;
  readonly created?: number;
  readonly cancel_at_period_end: boolean;
  readonly cancel_at?: number | null;
  readonly trial_end?: number | null;
  readonly items: {
    readonly data: readonly {
      readonly quantity?: number;
      readonly current_period_end?: number;
      readonly price: { readonly lookup_key: string | null };
    }[];
  };
}

/** The fields of a Stripe invoice the ops detail reads. */
export interface OpsInvoiceLike {
  readonly id: string;
  readonly customer?: string | { readonly id: string } | null;
  readonly number: string | null;
  readonly status: string | null;
  readonly created: number;
  readonly currency: string;
  readonly total: number;
  readonly amount_due: number;
  readonly amount_paid: number;
}

/** What the ops detail calls on Stripe: two lists, by customer. */
export interface OpsStripe {
  readonly subscriptions: {
    list(params: { customer: string; status: "all"; limit: number }): PromiseLike<{ readonly data: readonly OpsSubscriptionLike[] }>;
  };
  readonly invoices: {
    list(params: { customer: string; limit: number }): PromiseLike<{ readonly data: readonly OpsInvoiceLike[]; readonly has_more: boolean }>;
  };
}

/** How many of the customer's subscriptions are read to find the current one. */
export const OPS_SUBSCRIPTION_PAGE = 10;
/** How many of the customer's latest invoices the detail shows. */
export const OPS_INVOICE_PAGE = 12;
/** How long the detail waits for Stripe before answering without it. */
export const OPS_STRIPE_DEADLINE_MS = 4_000;

/** Statuses after which a subscription is over: one in any other status is the team's current one. */
const ENDED = new Set(["canceled", "incomplete_expired"]);
const CUSTOMER = /^cus_[A-Za-z0-9]{1,64}$/;

const customerOf = (value: string | { readonly id: string } | null | undefined) => (typeof value === "string" ? value : value?.id);

export interface OpsSubscription {
  readonly id: string;
  readonly status: string;
  /** The first item's price lookup key, as in the catalog (billing/catalog.ts). */
  readonly lookupKey: string | null;
  /** The plan and interval that lookup key is, or null for a price the catalog doesn't know. */
  readonly plan: string | null;
  readonly interval: string | null;
  /** The quantity: billed seats, across the items. */
  readonly seats: number;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  /** When it's set to cancel, by date or at the period's end. */
  readonly cancelAt: string | null;
  readonly trialEnd: string | null;
  readonly createdAt: string | null;
}

export interface OpsInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly currency: string;
  readonly total: number;
  readonly amountDue: number;
  readonly amountPaid: number;
}

/** The `stripe` part of the answer: null for a team with no Stripe customer, or what Stripe has, or that it couldn't be read. */
export type OpsStripeDetail =
  | null
  | { readonly error: "unavailable" }
  | {
      readonly customerId: string;
      /** The current subscription (the newest not yet over), else the newest; null if the customer has none. */
      readonly subscription: OpsSubscription | null;
      /** How many subscriptions the customer has among the latest OPS_SUBSCRIPTION_PAGE, so a second live one stands out. */
      readonly subscriptionCount: number;
      readonly invoices: readonly OpsInvoice[];
      readonly hasMoreInvoices: boolean;
    };

export function opsSubscription(sub: OpsSubscriptionLike): OpsSubscription {
  const first = sub.items.data[0];
  const lookupKey = first?.price.lookup_key ?? null;
  const known = planForLookupKey(lookupKey);
  return {
    id: sub.id,
    status: sub.status,
    lookupKey,
    plan: known?.plan ?? null,
    interval: known?.interval ?? null,
    seats: sub.items.data.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
    currentPeriodEnd: iso(first?.current_period_end) ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    cancelAt: iso(sub.cancel_at) ?? null,
    trialEnd: iso(sub.trial_end) ?? null,
    createdAt: iso(sub.created) ?? null,
  };
}

/** The current subscription among a customer's, newest first: the first not over, else the newest. */
export function currentSubscription<S extends Pick<OpsSubscriptionLike, "status">>(subs: readonly S[]): S | undefined {
  return subs.find((s) => !ENDED.has(s.status)) ?? subs[0];
}

/** Rejects after `ms`, so a slow Stripe can't hold the answer. */
function deadline(ms: number): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Stripe took too long"), { name: "StripeDeadline" })), ms);
  });
  return { promise, clear: () => clearTimeout(timer) };
}

export interface OpsStripeDetailOptions {
  /** The client on the ops restricted key, read on first use; absent, the detail is unavailable. */
  readonly stripe?: () => Promise<OpsStripe>;
  readonly obs: Observability;
  readonly deadlineMs?: number;
}

/**
 * The team's subscription and latest invoices, for the customer on its index
 * entry. Never throws: see the top.
 */
export async function opsStripeDetail(teamId: string, customerId: string | undefined, options: OpsStripeDetailOptions): Promise<OpsStripeDetail> {
  if (customerId === undefined) return null;
  const { obs } = options;
  const limit = deadline(options.deadlineMs ?? OPS_STRIPE_DEADLINE_MS);
  try {
    if (!CUSTOMER.test(customerId)) throw Object.assign(new Error("Not a Stripe customer ID"), { name: "InvalidCustomer" });
    const client = options.stripe;
    if (!client) throw Object.assign(new Error("No ops Stripe key configured"), { name: "NotConfigured" });
    const read = async () => {
      const stripe = await client();
      return Promise.all([stripe.subscriptions.list({ customer: customerId, status: "all", limit: OPS_SUBSCRIPTION_PAGE }), stripe.invoices.list({ customer: customerId, limit: OPS_INVOICE_PAGE })]);
    };
    const [subs, invoices] = await Promise.race([read(), limit.promise]);
    // Listed by customer, so each is the team's own; checked anyway, so another customer's never shows here
    const own = subs.data.filter((s) => customerOf(s.customer) === customerId);
    const current = currentSubscription(own);
    return {
      customerId,
      subscription: current ? opsSubscription(current) : null,
      subscriptionCount: own.length,
      invoices: invoices.data
        .filter((i) => customerOf(i.customer) === customerId && i.status && i.status !== "draft")
        .map((i) => ({
          id: i.id,
          number: i.number,
          status: i.status as string,
          createdAt: new Date(i.created * 1000).toISOString(),
          currency: i.currency,
          total: i.total,
          amountDue: i.amount_due,
          amountPaid: i.amount_paid,
        })),
      hasMoreInvoices: invoices.has_more,
    };
  } catch (error) {
    obs.logger.warn("Stripe detail unavailable", { teamId, ...stripeErrorFields(error) });
    return { error: "unavailable" };
  } finally {
    limit.clear();
  }
}
