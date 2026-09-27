// npm run stripe-catalog: creates or updates the Stripe products and prices in
// src/billing/catalog.ts (supply-checkout-8jc.10; docs/infrastructure.md,
// "Billing"). For the owner to run, never a Lambda. A dry run unless --apply
// is given.
//
//   npm run stripe-catalog -- --profile supply-prod --region <region> [--env prod] [--live] [--apply]
//
// It reads the Stripe secret key from Secrets Manager
// (supply-checkout/<env>/stripe/test-secret-key, or live-secret-key with
// --live) and refuses a key of the other mode, so it can only touch the live
// account when asked to. The key is never printed or logged.
//
// Idempotent by lookup key: a product is found by its ID (ours) and a price
// by its lookup key. One that matches the catalog is left alone; a product
// whose name or description changed is updated; a price whose amounts,
// interval or currency changed (which Stripe can't edit) is replaced by a new
// price that takes over the lookup key, and the old one is archived. So
// running it twice leaves one product per plan and one active price per plan
// and interval. Every create carries an idempotency key.

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { type Catalog, CATALOG, type CatalogPlan, type CatalogPrice } from "../src/billing/catalog.js";
import { createStripe, keyFromSecret, requireMode, type SecretReader, secretsManagerReader, stripeErrorFields, type StripeMode, stripeSecretName } from "../src/billing/stripe.js";

export const USAGE = `Usage: npm run stripe-catalog -- --profile <profile> --region <region> [--env prod] [--live] [--apply]

Creates or updates the Stripe products and prices in backend/src/billing/catalog.ts, found by
product ID and price lookup key. Without --apply it's a dry run: it reads Stripe and says what it
would change. It reads the Stripe secret key from Secrets Manager, supply-checkout/<env>/stripe/test-secret-key
(live-secret-key with --live), and refuses a key that isn't of that mode: without --live it only
ever uses a test-mode key.`;

const ENV_NAME = /^[a-z][a-z0-9-]{0,15}$/;

/** A Stripe product, as far as the script reads it. */
export interface ProductLike {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
  readonly metadata: Record<string, string>;
}

/** A Stripe price with its tiers (listed with expand data.tiers), as far as the script reads it. */
export interface TieredPriceLike {
  readonly id: string;
  readonly active: boolean;
  readonly lookup_key: string | null;
  readonly currency: string;
  readonly product: string | { readonly id: string };
  readonly nickname: string | null;
  readonly billing_scheme: string;
  readonly tiers_mode: string | null;
  readonly recurring: { readonly interval: string; readonly interval_count: number; readonly usage_type: string } | null;
  readonly tiers?: readonly { readonly up_to: number | null; readonly flat_amount: number | null; readonly unit_amount: number | null }[];
  readonly metadata: Record<string, string>;
}

/** The parameters the script creates a price with. */
export interface PriceParams {
  readonly product: string;
  readonly currency: string;
  readonly lookup_key: string;
  readonly transfer_lookup_key?: boolean;
  readonly nickname: string;
  readonly recurring: { readonly interval: "month" | "year"; readonly interval_count: 1; readonly usage_type: "licensed" };
  readonly billing_scheme: "tiered";
  readonly tiers_mode: "graduated";
  readonly tiers: ({ readonly up_to: number; readonly flat_amount: number; readonly unit_amount: number } | { readonly up_to: "inf"; readonly unit_amount: number })[];
  readonly metadata: Record<string, string>;
}

export interface ProductParams {
  readonly name: string;
  readonly description: string;
  readonly metadata: Record<string, string>;
}

/** What the script needs from the Stripe client (the `stripe` package's, or a fake in tests). */
export interface CatalogStripe {
  readonly products: {
    retrieve(id: string): PromiseLike<ProductLike>;
    create(params: ProductParams & { readonly id: string }, options: { idempotencyKey: string }): PromiseLike<ProductLike>;
    update(id: string, params: Partial<ProductParams> & { readonly active?: boolean }): PromiseLike<ProductLike>;
  };
  readonly prices: {
    list(params: { lookup_keys: string[]; limit: number; expand: string[] }): PromiseLike<{ readonly data: readonly TieredPriceLike[] }>;
    create(params: PriceParams, options: { idempotencyKey: string }): PromiseLike<TieredPriceLike>;
    update(id: string, params: { readonly active?: boolean; readonly nickname?: string; readonly metadata?: Record<string, string> }): PromiseLike<TieredPriceLike>;
  };
}

/** One thing the script did, or would do in a dry run. */
export interface Change {
  readonly kind: "product" | "price";
  /** The product ID or the price's lookup key. */
  readonly name: string;
  readonly action: "unchanged" | "create" | "update" | "replace";
  /** The Stripe price the lookup key points at afterwards (not in a dry run's create or replace). */
  readonly priceId?: string;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const productOf = (price: TieredPriceLike) => (typeof price.product === "string" ? price.product : price.product.id);

export function productParams(plan: CatalogPlan): ProductParams {
  return { name: plan.name, description: plan.description, metadata: { plan: plan.plan } };
}

export function priceParams(plan: CatalogPlan, price: CatalogPrice, currency: string): PriceParams {
  return {
    product: plan.productId,
    currency,
    lookup_key: price.lookupKey,
    nickname: `${plan.name}, ${price.interval === "month" ? "monthly" : "annual"}`,
    recurring: { interval: price.interval, interval_count: 1, usage_type: "licensed" },
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: [
      { up_to: plan.includedSeats, flat_amount: price.flatAmount, unit_amount: 0 },
      { up_to: "inf", unit_amount: price.perSeatAmount },
    ],
    metadata: { plan: plan.plan, interval: price.interval },
  };
}

/** True if an existing price charges what the catalog says: the parts Stripe can't change on a price. */
export function priceMatches(existing: TieredPriceLike, wanted: PriceParams): boolean {
  const tiers = (existing.tiers ?? []).map((t) => [t.up_to, t.flat_amount ?? 0, t.unit_amount ?? 0]);
  const want = wanted.tiers.map((t) => [t.up_to === "inf" ? null : t.up_to, "flat_amount" in t ? t.flat_amount : 0, t.unit_amount]);
  return (
    existing.active &&
    productOf(existing) === wanted.product &&
    existing.currency === wanted.currency &&
    existing.billing_scheme === wanted.billing_scheme &&
    existing.tiers_mode === wanted.tiers_mode &&
    existing.recurring?.interval === wanted.recurring.interval &&
    existing.recurring.interval_count === wanted.recurring.interval_count &&
    existing.recurring.usage_type === wanted.recurring.usage_type &&
    JSON.stringify(tiers) === JSON.stringify(want)
  );
}

const sameMetadata = (a: Record<string, string>, b: Record<string, string>) => Object.entries(b).every(([k, v]) => a[k] === v);

async function syncProduct(stripe: CatalogStripe, plan: CatalogPlan, apply: boolean): Promise<Change> {
  const wanted = productParams(plan);
  let existing: ProductLike | undefined;
  try {
    existing = await stripe.products.retrieve(plan.productId);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 404) throw error;
  }
  if (!existing) {
    if (apply) await stripe.products.create({ id: plan.productId, ...wanted }, { idempotencyKey: `catalog-product-${plan.productId}-${hash(wanted)}` });
    return { kind: "product", name: plan.productId, action: "create" };
  }
  if (existing.active && existing.name === wanted.name && existing.description === wanted.description && sameMetadata(existing.metadata, wanted.metadata)) {
    return { kind: "product", name: plan.productId, action: "unchanged" };
  }
  if (apply) await stripe.products.update(plan.productId, { ...wanted, active: true });
  return { kind: "product", name: plan.productId, action: "update" };
}

async function syncPrice(stripe: CatalogStripe, plan: CatalogPlan, price: CatalogPrice, currency: string, apply: boolean): Promise<Change> {
  const wanted = priceParams(plan, price, currency);
  const { data } = await stripe.prices.list({ lookup_keys: [price.lookupKey], limit: 10, expand: ["data.tiers"] });
  const existing = data.find((p) => p.lookup_key === price.lookupKey);
  const base = { kind: "price" as const, name: price.lookupKey };
  if (existing && priceMatches(existing, wanted)) {
    if (existing.nickname === wanted.nickname && sameMetadata(existing.metadata, wanted.metadata)) return { ...base, action: "unchanged", priceId: existing.id };
    if (apply) await stripe.prices.update(existing.id, { nickname: wanted.nickname, metadata: wanted.metadata });
    return { ...base, action: "update", priceId: existing.id };
  }
  const action = existing ? "replace" : "create";
  if (!apply) return { ...base, action };
  // The key names the price this replaces, so going back to an earlier price within Stripe's
  // 24 hours of idempotency makes a new price rather than replaying the archived one
  const created = await stripe.prices.create(existing ? { ...wanted, transfer_lookup_key: true } : wanted, {
    idempotencyKey: `catalog-price-${price.lookupKey}-${hash({ wanted, replaces: existing?.id ?? null })}`,
  });
  if (existing?.active) await stripe.prices.update(existing.id, { active: false });
  return { ...base, action, priceId: created.id };
}

/** Brings Stripe in line with the catalog (or, without `apply`, says what that would change). Products first: a price needs its product. */
export async function syncCatalog(stripe: CatalogStripe, catalog: Catalog, apply: boolean): Promise<Change[]> {
  const changes: Change[] = [];
  for (const plan of catalog.plans) {
    changes.push(await syncProduct(stripe, plan, apply));
    for (const price of plan.prices) changes.push(await syncPrice(stripe, plan, price, catalog.currency, apply));
  }
  return changes;
}

export interface Deps {
  /** A secret reader on Secrets Manager for the profile and region. */
  readonly reader: (region: string, profile: string) => SecretReader;
  /** The Stripe client for a key (createStripe). */
  readonly stripe: (key: string) => CatalogStripe;
}

const defaultDeps: Deps = {
  reader: (region, profile) => secretsManagerReader(region, defaultProvider({ profile })),
  stripe: (key) => createStripe(key),
};

/** Runs the CLI. Returns the exit code: 0 done (or a clean dry run), 1 failed or refused, 2 bad arguments. */
export async function main(argv: string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error, deps: Deps = defaultDeps, catalog: Catalog = CATALOG): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        profile: { type: "string" },
        region: { type: "string" },
        env: { type: "string", default: "prod" },
        live: { type: "boolean", default: false },
        apply: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (e) {
    err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (!values.profile || !values.region) {
    err(`--profile and --region are required\n\n${USAGE}`);
    return 2;
  }
  if (!ENV_NAME.test(values.env)) {
    err(`--env must be an environment name like prod\n\n${USAGE}`);
    return 2;
  }
  const mode: StripeMode = values.live ? "live" : "test";
  const secretId = stripeSecretName(values.env, mode);
  let stripe: CatalogStripe;
  try {
    // Never printed: only whether it's a key of the right mode
    const key = requireMode(keyFromSecret(await deps.reader(values.region, values.profile)(secretId)), mode);
    stripe = deps.stripe(key);
  } catch (e) {
    err(`Refused: ${secretId}: ${(e as Error).message}. Nothing was read from or written to Stripe.`);
    return 1;
  }
  out(`Stripe ${mode} mode, key from ${secretId}${values.apply ? "" : " (dry run)"}`);
  out(catalog.status);
  try {
    const changes = await syncCatalog(stripe, catalog, values.apply);
    for (const c of changes) out(`${c.kind} ${c.name}: ${values.apply || c.action === "unchanged" ? c.action : `would ${c.action}`}${c.priceId ? ` (${c.priceId})` : ""}`);
    const pending = changes.filter((c) => c.action !== "unchanged").length;
    if (!values.apply) out(pending ? `Dry run: ${pending} to change. Run again with --apply to change them.` : "Dry run: Stripe matches the catalog.");
    else out(pending ? `Done: ${pending} changed.` : "Done: Stripe already matched the catalog.");
    return 0;
  } catch (e) {
    // Stripe's error type, code, status and request ID: never its message or the key
    err(`Failed: ${JSON.stringify(stripeErrorFields(e))}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
