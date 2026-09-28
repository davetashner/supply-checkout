// The Stripe Customer Portal (supply-checkout-121): where owners update their
// card, switch between monthly and annual, download invoices and cancel.
//
// Its configuration is ours, made by the catalog script
// (scripts/stripe-catalog.ts, `npm run stripe-catalog`) from this file, in
// test and live mode alike, and found at runtime by its metadata
// (PORTAL_METADATA), never by an ID written down anywhere. The billing
// function passes it on every portal session, so the account's default portal
// configuration (the Dashboard's) is never used.
//
// What owners can do there, and what they can't:
// - Update their card and billing details (name, email for receipts,
//   address, tax ID), and see and download invoices.
// - Switch the plan's price (monthly or annual) of the catalog's plans. Not
//   the quantity: seats follow the team's members (supply-checkout-l50).
//   Switching during the free trial keeps the trial.
// - Cancel, at the end of the period (never at once, and with no refund), with
//   a reason. The webhook records `cancelAtPeriodEnd`, and then `canceled`
//   when the period ends.
//
// No imports but the catalog's types, so the script and the Lambda share it.

import type { Catalog } from "./catalog.js";

/** How the script and the billing function recognize our portal configuration. */
export const PORTAL_METADATA = { app: "supply-checkout", portal: "owners" } as const;

/** The configuration's name in the Stripe Dashboard. */
export const PORTAL_NAME = "Supply Checkout owners";

/** Why an owner canceled: Stripe's own list, all of it. */
export const CANCELLATION_REASONS = ["too_expensive", "missing_features", "switched_service", "unused", "customer_service", "too_complex", "low_quality", "other"] as const;

/** The portal configuration's parameters, as the script creates or updates it (a subset of Stripe's). */
export interface PortalConfigurationParams {
  readonly name: string;
  readonly metadata: Record<string, string>;
  readonly features: {
    readonly customer_update: { readonly enabled: true; readonly allowed_updates: ("address" | "email" | "name" | "tax_id")[] };
    readonly invoice_history: { readonly enabled: true };
    readonly payment_method_update: { readonly enabled: true };
    readonly subscription_cancel: {
      readonly enabled: true;
      readonly mode: "at_period_end";
      readonly proration_behavior: "none";
      readonly cancellation_reason: { readonly enabled: true; readonly options: string[] };
    };
    readonly subscription_update: {
      readonly enabled: true;
      readonly default_allowed_updates: "price"[];
      readonly products: { readonly product: string; readonly prices: string[] }[];
      readonly proration_behavior: "create_prorations";
      readonly trial_update_behavior: "continue_trial";
    };
  };
}

/**
 * Our portal configuration, for the catalog and the Stripe price IDs of its
 * prices (by lookup key). Throws if a price has no ID: the catalog's prices
 * must be in Stripe first.
 */
export function portalConfiguration(catalog: Catalog, priceIds: ReadonlyMap<string, string>): PortalConfigurationParams {
  const products = catalog.plans.map((plan) => ({
    product: plan.productId,
    prices: plan.prices.map((price) => {
      const id = priceIds.get(price.lookupKey);
      if (!id) throw new Error(`No Stripe price for ${price.lookupKey}: sync the catalog first`);
      return id;
    }),
  }));
  return {
    name: PORTAL_NAME,
    metadata: { ...PORTAL_METADATA },
    features: {
      customer_update: { enabled: true, allowed_updates: ["name", "email", "address", "tax_id"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none", cancellation_reason: { enabled: true, options: [...CANCELLATION_REASONS] } },
      subscription_update: { enabled: true, default_allowed_updates: ["price"], products, proration_behavior: "create_prorations", trial_update_behavior: "continue_trial" },
    },
  };
}

/** The fields of a Stripe portal configuration the lookup reads. */
export interface PortalConfigurationLike {
  readonly id: string;
  readonly active: boolean;
  readonly metadata: Record<string, string> | null;
}

/** What finding the configuration needs from the Stripe client. */
export interface PortalConfigurationLister {
  readonly billingPortal: {
    readonly configurations: {
      list(params: { active: boolean; limit: number }): PromiseLike<{ readonly data: readonly PortalConfigurationLike[] }>;
    };
  };
}

/** Our portal configuration isn't in Stripe: the catalog script hasn't been run in this mode. */
export class PortalConfigurationNotFoundError extends Error {
  override readonly name = "PortalConfigurationNotFoundError";
}

/** True for our configuration: its metadata is PORTAL_METADATA's. */
export const isOurPortal = (config: Pick<PortalConfigurationLike, "metadata">) => Object.entries(PORTAL_METADATA).every(([k, v]) => config.metadata?.[k] === v);

export const PORTAL_CONFIGURATION_TTL_MS = 10 * 60_000;

/**
 * A lookup of our active portal configuration's ID, kept for
 * PORTAL_CONFIGURATION_TTL_MS. Exactly one active configuration must be ours,
 * or it's refused (PortalConfigurationNotFoundError): the portal then never
 * opens with the Dashboard's default one.
 */
export function portalConfigurationResolver(stripe: () => Promise<PortalConfigurationLister>, options: { readonly now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let cached: { id: string; at: number } | undefined;
  return async (): Promise<string> => {
    if (cached && now() - cached.at < PORTAL_CONFIGURATION_TTL_MS) return cached.id;
    const { data } = await (await stripe()).billingPortal.configurations.list({ active: true, limit: 100 });
    const ours = data.filter((c) => c.active && isOurPortal(c));
    const match = ours.length === 1 ? ours[0] : undefined;
    if (!match) throw new PortalConfigurationNotFoundError(`${ours.length} active portal configurations are ours; run the catalog script (docs/infrastructure.md, "Billing")`);
    cached = { id: match.id, at: now() };
    return match.id;
  };
}
