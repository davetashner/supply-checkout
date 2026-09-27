// Finds a catalog price's Stripe price ID by its lookup key, at runtime
// (catalog.ts): the IDs are never written down, so the catalog script can
// replace a price and the code follows its lookup key. Each answer is kept for
// PRICE_TTL_MS.

import { type Catalog, CATALOG, type CatalogPlan, type CatalogPrice } from "./catalog.js";

/** What a price lookup needs from the Stripe client. */
export interface PriceLister {
  readonly prices: {
    list(params: { lookup_keys: string[]; active: boolean; limit: number }): PromiseLike<{ readonly data: readonly StripePriceLike[] }>;
  };
}

/** The fields of a Stripe price the lookup checks. */
export interface StripePriceLike {
  readonly id: string;
  readonly lookup_key: string | null;
  readonly active: boolean;
  readonly currency: string;
  readonly product: string | { readonly id: string };
  readonly recurring: { readonly interval: string } | null;
}

/** The catalog's price isn't in Stripe as the catalog describes it: the catalog script hasn't been run, or someone changed the price by hand. */
export class PriceNotFoundError extends Error {
  override readonly name = "PriceNotFoundError";
}

export const PRICE_TTL_MS = 10 * 60_000;

const productOf = (price: StripePriceLike) => (typeof price.product === "string" ? price.product : price.product.id);

/**
 * A lookup of the active Stripe price for a catalog plan and price. The price
 * must belong to the plan's product, recur at the catalog's interval and be
 * in the catalog's currency, or it's refused (PriceNotFoundError).
 */
export function priceResolver(stripe: () => Promise<PriceLister>, options: { readonly now?: () => number; readonly catalog?: Catalog } = {}) {
  const now = options.now ?? Date.now;
  const catalog = options.catalog ?? CATALOG;
  const cache = new Map<string, { id: string; at: number }>();
  return async (plan: CatalogPlan, price: CatalogPrice): Promise<string> => {
    const hit = cache.get(price.lookupKey);
    if (hit && now() - hit.at < PRICE_TTL_MS) return hit.id;
    const { data } = await (await stripe()).prices.list({ lookup_keys: [price.lookupKey], active: true, limit: 2 });
    const found = data.filter((p) => p.lookup_key === price.lookupKey && p.active);
    const match = found.length === 1 ? found[0] : undefined;
    if (!match || productOf(match) !== plan.productId || match.recurring?.interval !== price.interval || match.currency !== catalog.currency) {
      throw new PriceNotFoundError(`No active Stripe price matches ${price.lookupKey}; run the catalog script (docs/infrastructure.md, "Billing")`);
    }
    cache.set(price.lookupKey, { id: match.id, at: now() });
    return match.id;
  };
}
