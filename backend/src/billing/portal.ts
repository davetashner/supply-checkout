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
// While a team is comped, or was in the last day (COMPED_PORTAL_GRACE_MS), its
// owners get a second configuration, `owners-comped`, the same but with no
// switching of price (supply-checkout-6e4b): a comp for months puts a 100%-off
// repeating coupon on the subscription (comp-discount.ts), and a switch from
// monthly to annual invoices the annual price at once, inside the coupon's
// months, which would make a whole year $0. The catalog script makes both.
//
// No imports but the catalog's types, so the script and the Lambda share it.

import type { Catalog } from "./catalog.js";

/** How the script and the billing function recognize our portal configuration. */
export const PORTAL_METADATA = { app: "supply-checkout", portal: "owners" } as const;

/** The configuration's name in the Stripe Dashboard. */
export const PORTAL_NAME = "Supply Checkout owners";

/** Which of our two configurations: the usual one, or the one for a comped team, with no switching of price (see the top). */
export type PortalVariant = "owners" | "comped";
export const PORTAL_VARIANTS: readonly PortalVariant[] = ["owners", "comped"];

/** How the comped configuration is recognized, and its name. */
export const COMPED_PORTAL_METADATA = { app: "supply-checkout", portal: "owners-comped" } as const;
export const COMPED_PORTAL_NAME = "Supply Checkout owners, comped";

/** A variant's metadata. */
export const portalMetadata = (variant: PortalVariant = "owners"): Readonly<Record<string, string>> => (variant === "comped" ? COMPED_PORTAL_METADATA : PORTAL_METADATA);

/** How long after a comp ends its team still gets the comped configuration: until the worker has surely removed its discount. */
export const COMPED_PORTAL_GRACE_MS = 24 * 60 * 60_000;

/**
 * The configuration a team's owners get: `comped` while it has a comp, or had
 * one that ended in the last COMPED_PORTAL_GRACE_MS (`compUntil` stays after a
 * comp ends, as when it stopped), whatever kind, so its discount, if any, is
 * gone before price switching is back. Otherwise `owners`.
 */
export function portalVariantFor(team: { readonly compUntil?: unknown }, now: Date): PortalVariant {
  const until = typeof team.compUntil === "string" ? Date.parse(team.compUntil) : Number.NaN;
  return Number.isFinite(until) && until + COMPED_PORTAL_GRACE_MS > now.getTime() ? "comped" : "owners";
}

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
    readonly subscription_update:
      | {
          readonly enabled: true;
          readonly default_allowed_updates: "price"[];
          readonly products: { readonly product: string; readonly prices: string[] }[];
          readonly proration_behavior: "create_prorations";
          readonly trial_update_behavior: "continue_trial";
        }
      | { readonly enabled: false };
  };
}

/**
 * Our portal configuration, for the catalog and the Stripe price IDs of its
 * prices (by lookup key). Throws if a price has no ID: the catalog's prices
 * must be in Stripe first. The `comped` variant is the same with no switching
 * of price.
 */
export function portalConfiguration(catalog: Catalog, priceIds: ReadonlyMap<string, string>, variant: PortalVariant = "owners"): PortalConfigurationParams {
  const products = catalog.plans.map((plan) => ({
    product: plan.productId,
    prices: plan.prices.map((price) => {
      const id = priceIds.get(price.lookupKey);
      if (!id) throw new Error(`No Stripe price for ${price.lookupKey}: sync the catalog first`);
      return id;
    }),
  }));
  return {
    name: variant === "comped" ? COMPED_PORTAL_NAME : PORTAL_NAME,
    metadata: { ...portalMetadata(variant) },
    features: {
      customer_update: { enabled: true, allowed_updates: ["name", "email", "address", "tax_id"] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none", cancellation_reason: { enabled: true, options: [...CANCELLATION_REASONS] } },
      subscription_update:
        variant === "comped" ? { enabled: false } : { enabled: true, default_allowed_updates: ["price"], products, proration_behavior: "create_prorations", trial_update_behavior: "continue_trial" },
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

/** True for our configuration of `variant`: its metadata is that variant's. */
export const isOurPortal = (config: Pick<PortalConfigurationLike, "metadata">, variant: PortalVariant = "owners") => Object.entries(portalMetadata(variant)).every(([k, v]) => config.metadata?.[k] === v);

export const PORTAL_CONFIGURATION_TTL_MS = 10 * 60_000;

/**
 * A lookup of our active portal configuration's ID, kept for
 * PORTAL_CONFIGURATION_TTL_MS. Exactly one active configuration must be ours,
 * or it's refused (PortalConfigurationNotFoundError): the portal then never
 * opens with the Dashboard's default one.
 */
export function portalConfigurationResolver(stripe: () => Promise<PortalConfigurationLister>, options: { readonly now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const cached = new Map<PortalVariant, { id: string; at: number }>();
  return async (variant: PortalVariant = "owners"): Promise<string> => {
    const hit = cached.get(variant);
    if (hit && now() - hit.at < PORTAL_CONFIGURATION_TTL_MS) return hit.id;
    const { data } = await (await stripe()).billingPortal.configurations.list({ active: true, limit: 100 });
    const ours = data.filter((c) => c.active && isOurPortal(c, variant));
    const match = ours.length === 1 ? ours[0] : undefined;
    if (!match) throw new PortalConfigurationNotFoundError(`${ours.length} active ${variant} portal configurations are ours; run the catalog script (docs/infrastructure.md, "Billing")`);
    cached.set(variant, { id: match.id, at: now() });
    return match.id;
  };
}
