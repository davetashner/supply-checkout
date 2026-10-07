// The plans we sell, as Stripe products and prices (ADR 0009). The catalog
// script (scripts/stripe-catalog.ts) creates or updates them in Stripe from
// this file, and the billing function finds each price by its lookup key at
// runtime, so no price ID is ever written down here or in the app.
//
// PROVISIONAL, pending supply-checkout-akz (subscription tiers and pricing):
// this is ADR 0009's starting proposal. Starter is $9 a month including 3
// seats, then $3 for each extra seat; annual is 2 months free ($90 a year
// including 3 seats, then $30 a seat); every team gets a 14-day trial without
// a card. When akz settles the tiers, change this file and rerun the script
// (docs/infrastructure.md, "Billing"): a price whose amounts change gets a new
// Stripe price that takes over the lookup key, and the old one is archived.
//
// No imports, so the script and the Lambda share it as it is.

/** Why this catalog isn't final. The script prints it on every run. */
export const CATALOG_STATUS = "Provisional: ADR 0009's proposal, pending supply-checkout-akz (subscription tiers and pricing).";

export type BillingInterval = "month" | "year";
export const BILLING_INTERVALS: readonly BillingInterval[] = ["month", "year"];

/**
 * One price: a flat amount that includes the plan's seats, then a price for
 * each seat after them. In Stripe it's one graduated, tiered price per seat
 * (the subscription's quantity is the seat count): the first tier is up to
 * `includedSeats` for `flatAmount`, the second every seat after that at
 * `perSeatAmount`. Amounts are in cents.
 */
export interface CatalogPrice {
  /** Stripe's lookup key. Stable: the code finds the price by it. */
  readonly lookupKey: string;
  readonly interval: BillingInterval;
  readonly flatAmount: number;
  readonly perSeatAmount: number;
}

export interface CatalogPlan {
  /** The plan's name in our data (a team's `plan`) and in the API. */
  readonly plan: string;
  /** The Stripe product's ID, which we choose, so finding it needs no lookup. */
  readonly productId: string;
  readonly name: string;
  readonly description: string;
  /** Seats the flat amount covers. */
  readonly includedSeats: number;
  readonly prices: readonly CatalogPrice[];
}

export interface Catalog {
  readonly status: string;
  /** ISO 4217, lowercase, as Stripe takes it. */
  readonly currency: string;
  readonly plans: readonly CatalogPlan[];
}

export const CATALOG: Catalog = {
  status: CATALOG_STATUS,
  currency: "usd",
  plans: [
    {
      plan: "starter",
      productId: "supply_checkout_starter",
      name: "Supply Checkout Starter",
      description: "Supply checkout by project, inventory, and barcode and receipt scanning for your crew. Includes 3 seats.",
      includedSeats: 3,
      prices: [
        { lookupKey: "supply_checkout_starter_monthly", interval: "month", flatAmount: 900, perSeatAmount: 300 },
        // Two months free: 10 × the monthly amounts
        { lookupKey: "supply_checkout_starter_annual", interval: "year", flatAmount: 9000, perSeatAmount: 3000 },
      ],
    },
  ],
};

/** The catalog's price for a plan and interval, or undefined if we don't sell that. */
export function catalogPrice(plan: string, interval: string, catalog: Catalog = CATALOG): { readonly plan: CatalogPlan; readonly price: CatalogPrice } | undefined {
  const found = catalog.plans.find((p) => p.plan === plan);
  const price = found?.prices.find((p) => p.interval === interval);
  return found && price ? { plan: found, price } : undefined;
}

/** The plan a price's lookup key belongs to, for the webhook worker, or undefined for a price we don't sell. */
export function planForLookupKey(lookupKey: string | null | undefined, catalog: Catalog = CATALOG): { readonly plan: string; readonly interval: BillingInterval } | undefined {
  for (const plan of catalog.plans) {
    const price = plan.prices.find((p) => p.lookupKey === lookupKey);
    if (price) return { plan: plan.plan, interval: price.interval };
  }
  return undefined;
}
