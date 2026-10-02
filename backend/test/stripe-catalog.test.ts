// The catalog script (scripts/stripe-catalog.ts) against an in-memory Stripe
// that keeps products, prices, lookup keys and idempotency keys as Stripe does.

import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import {
  type CatalogStripe,
  contains,
  main,
  type PortalConfigLike,
  portalMatches,
  type PriceParams,
  priceMatches,
  priceParams,
  type ProductLike,
  syncCatalog,
  syncPortal,
  type TieredPriceLike,
} from "../scripts/stripe-catalog.js";
import { type Catalog, CATALOG } from "../src/billing/catalog.js";
import { COMPED_PORTAL_METADATA, PORTAL_METADATA, portalConfiguration, type PortalConfigurationParams } from "../src/billing/portal.js";

// Made-up keys: the right shape, never real
const TEST_KEY = `sk_test_${"a".repeat(24)}`;
const LIVE_KEY = `sk_live_${"c".repeat(24)}`;

function memoryStripe() {
  const products = new Map<string, ProductLike>();
  const prices: (TieredPriceLike & { tiers: NonNullable<TieredPriceLike["tiers"]> })[] = [];
  // As Stripe keeps them: whatever was sent, plus fields of its own
  const configurations: (PortalConfigLike & { features: Record<string, unknown> })[] = [];
  const withStripeFields = (params: PortalConfigurationParams) => {
    const f = params.features;
    return {
      ...f,
      payment_method_update: { ...f.payment_method_update, payment_method_configuration: null },
      subscription_update: f.subscription_update.enabled
        ? { ...f.subscription_update, billing_cycle_anchor: null, products: f.subscription_update.products.map((x) => ({ ...x, adjustable_quantity: { enabled: false, maximum: null, minimum: 1 } })) }
        : { ...f.subscription_update, billing_cycle_anchor: null, products: [] },
    };
  };
  const replays = new Map<string, unknown>();
  const calls: string[] = [];
  const idempotent = <T>(key: string, make: () => T): T => {
    if (!replays.has(key)) replays.set(key, make());
    return replays.get(key) as T;
  };
  const notFound = () => new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "No such product", code: "resource_missing", statusCode: 404 } as never);
  const client: CatalogStripe = {
    billingPortal: {
      configurations: {
        async list(params) {
          calls.push("configurations.list");
          expect(params).toEqual({ limit: 100 });
          return { data: configurations };
        },
        async create(params, options) {
          calls.push("configurations.create");
          return idempotent(options.idempotencyKey, () => {
            const made = { id: `bpc_${configurations.length + 1}`, active: true, name: params.name, metadata: { ...params.metadata }, features: withStripeFields(params) };
            configurations.push(made);
            return made;
          });
        },
        async update(id, params) {
          calls.push(`configurations.update ${id}`);
          const found = configurations.find((c) => c.id === id) as (typeof configurations)[number];
          Object.assign(found, { active: params.active, name: params.name, metadata: { ...found.metadata, ...params.metadata }, features: withStripeFields(params) });
          return found;
        },
      },
    },
    products: {
      async retrieve(id) {
        calls.push(`products.retrieve ${id}`);
        const found = products.get(id);
        if (!found) throw notFound();
        return found;
      },
      async create(params, options) {
        calls.push(`products.create ${params.id}`);
        return idempotent(options.idempotencyKey, () => {
          const made = { id: params.id, name: params.name, description: params.description, active: true, metadata: { ...params.metadata } };
          products.set(params.id, made);
          return made;
        });
      },
      async update(id, params) {
        calls.push(`products.update ${id}`);
        const next = { ...(products.get(id) as ProductLike), ...params } as ProductLike;
        products.set(id, next);
        return next;
      },
    },
    prices: {
      async list(params) {
        calls.push(`prices.list ${params.lookup_keys.join(",")}`);
        expect(params.expand).toEqual(["data.tiers"]);
        return { data: prices.filter((p) => params.lookup_keys.includes(p.lookup_key as string)) };
      },
      async create(params: PriceParams, options) {
        calls.push(`prices.create ${params.lookup_key}`);
        return idempotent(options.idempotencyKey, () => {
          const holder = prices.find((p) => p.lookup_key === params.lookup_key);
          if (holder && !params.transfer_lookup_key) throw new Error("lookup key in use");
          if (holder) Object.assign(holder, { lookup_key: null });
          const made = {
            id: `price_${prices.length + 1}`,
            active: true,
            lookup_key: params.lookup_key,
            currency: params.currency,
            product: params.product,
            nickname: params.nickname,
            billing_scheme: params.billing_scheme,
            tiers_mode: params.tiers_mode,
            recurring: { ...params.recurring },
            // As Stripe returns them: the last tier's up_to is null, and a tier without a flat amount has null
            tiers: params.tiers.map((t) => ({ up_to: t.up_to === "inf" ? null : t.up_to, flat_amount: "flat_amount" in t ? t.flat_amount : null, unit_amount: t.unit_amount })),
            metadata: { ...params.metadata },
          };
          prices.push(made);
          return made;
        });
      },
      async update(id, params) {
        calls.push(`prices.update ${id}`);
        const found = prices.find((p) => p.id === id) as (typeof prices)[number];
        Object.assign(found, params);
        return found;
      },
    },
  };
  return { client, products, prices, configurations, calls };
}

/** The catalog with the monthly price's amounts changed, as a pricing decision would. */
function repriced(flatAmount: number): Catalog {
  const [plan] = CATALOG.plans as [(typeof CATALOG.plans)[number]];
  return { ...CATALOG, plans: [{ ...plan, prices: plan.prices.map((p) => (p.interval === "month" ? { ...p, flatAmount } : p)) }] };
}

describe("syncCatalog", () => {
  it("creates the catalog, and a second run changes nothing: one product per plan, one price per plan and interval", async () => {
    const stripe = memoryStripe();
    const first = await syncCatalog(stripe.client, CATALOG, true);
    expect(first.map((c) => `${c.name} ${c.action}`)).toEqual(["supply_checkout_starter create", "supply_checkout_starter_monthly create", "supply_checkout_starter_annual create"]);
    const second = await syncCatalog(stripe.client, CATALOG, true);
    expect(second.map((c) => c.action)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(stripe.products.size).toBe(1);
    expect(stripe.prices).toHaveLength(2);
    expect(stripe.prices.map((p) => p.lookup_key)).toEqual(["supply_checkout_starter_monthly", "supply_checkout_starter_annual"]);
    expect(stripe.prices[0]).toMatchObject({
      product: "supply_checkout_starter",
      currency: "usd",
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      tiers: [
        { up_to: 3, flat_amount: 900, unit_amount: 0 },
        { up_to: null, flat_amount: null, unit_amount: 300 },
      ],
    });
    expect(stripe.calls.filter((c) => c.includes("create"))).toHaveLength(3);
  });

  it("changes nothing in a dry run", async () => {
    const stripe = memoryStripe();
    const changes = await syncCatalog(stripe.client, CATALOG, false);
    expect(changes.map((c) => c.action)).toEqual(["create", "create", "create"]);
    expect(stripe.products.size).toBe(0);
    expect(stripe.prices).toHaveLength(0);
  });

  it("replaces a price whose amounts changed: the new one takes the lookup key and the old one is archived", async () => {
    const stripe = memoryStripe();
    await syncCatalog(stripe.client, CATALOG, true);
    const changes = await syncCatalog(stripe.client, repriced(1200), true);
    expect(changes.map((c) => c.action)).toEqual(["unchanged", "replace", "unchanged"]);
    expect(stripe.prices.filter((p) => p.active).map((p) => p.lookup_key).sort()).toEqual(["supply_checkout_starter_annual", "supply_checkout_starter_monthly"]);
    expect(stripe.prices.find((p) => p.id === "price_1")).toMatchObject({ active: false, lookup_key: null });
    expect(changes[1]?.priceId).toBe("price_3");
    // And back again the same day: a new price, not a replay of the archived one
    const back = await syncCatalog(stripe.client, CATALOG, true);
    expect(back[1]).toMatchObject({ action: "replace", priceId: "price_4" });
    expect(stripe.prices.filter((p) => p.active)).toHaveLength(2);
    expect(await syncCatalog(stripe.client, CATALOG, true)).toSatisfy((c: { action: string }[]) => c.every((x) => x.action === "unchanged"));
  });

  it("says a replacement is due in a dry run without making it", async () => {
    const stripe = memoryStripe();
    await syncCatalog(stripe.client, CATALOG, true);
    const changes = await syncCatalog(stripe.client, repriced(1200), false);
    expect(changes[1]).toEqual({ kind: "price", name: "supply_checkout_starter_monthly", action: "replace" });
    expect(stripe.prices).toHaveLength(2);
  });

  it("updates a product's name and a price's nickname, which Stripe lets us change in place", async () => {
    const stripe = memoryStripe();
    await syncCatalog(stripe.client, CATALOG, true);
    const [plan] = CATALOG.plans as [(typeof CATALOG.plans)[number]];
    const renamed: Catalog = { ...CATALOG, plans: [{ ...plan, name: "Supply Checkout Crew" }] };
    const changes = await syncCatalog(stripe.client, renamed, true);
    expect(changes.map((c) => c.action)).toEqual(["update", "update", "update"]);
    expect(stripe.products.get("supply_checkout_starter")?.name).toBe("Supply Checkout Crew");
    expect(stripe.prices[0]?.nickname).toBe("Supply Checkout Crew, monthly");
    expect(stripe.prices).toHaveLength(2);
    // A dry run of the same says so without changing anything
    expect((await syncCatalog(stripe.client, CATALOG, false)).map((c) => c.action)).toEqual(["update", "update", "update"]);
    expect(stripe.products.get("supply_checkout_starter")?.name).toBe("Supply Checkout Crew");
  });

  it("reactivates an archived product", async () => {
    const stripe = memoryStripe();
    await syncCatalog(stripe.client, CATALOG, true);
    await stripe.client.products.update("supply_checkout_starter", { active: false });
    expect((await syncCatalog(stripe.client, CATALOG, true))[0]?.action).toBe("update");
    expect(stripe.products.get("supply_checkout_starter")?.active).toBe(true);
  });

  it("replaces an archived price that still holds the lookup key", async () => {
    const stripe = memoryStripe();
    await syncCatalog(stripe.client, CATALOG, true);
    await stripe.client.prices.update("price_1", { active: false });
    const changes = await syncCatalog(stripe.client, CATALOG, true);
    expect(changes[1]?.action).toBe("replace");
    expect(stripe.prices.filter((p) => p.active)).toHaveLength(2);
  });

  it("stops on any Stripe error but a missing product", async () => {
    const stripe = memoryStripe();
    stripe.client.products.retrieve = async () => {
      throw new Stripe.errors.StripeAuthenticationError({ type: "invalid_request_error", message: "Invalid API Key", statusCode: 401 } as never);
    };
    await expect(syncCatalog(stripe.client, CATALOG, true)).rejects.toThrow("Invalid API Key");
  });

  it("compares every part of a price Stripe can't change", () => {
    const [plan] = CATALOG.plans as [(typeof CATALOG.plans)[number]];
    const wanted = priceParams(plan, plan.prices[0] as (typeof plan.prices)[number], "usd");
    const existing: TieredPriceLike = {
      id: "price_1",
      active: true,
      lookup_key: wanted.lookup_key,
      currency: "usd",
      product: { id: plan.productId },
      nickname: null,
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      tiers: [
        { up_to: 3, flat_amount: 900, unit_amount: null },
        { up_to: null, flat_amount: null, unit_amount: 300 },
      ],
      metadata: {},
    };
    expect(priceMatches(existing, wanted)).toBe(true);
    for (const change of [
      { active: false },
      { currency: "eur" },
      { product: "other" },
      { billing_scheme: "per_unit" },
      { tiers_mode: "volume" },
      { recurring: null },
      { recurring: { interval: "month", interval_count: 3, usage_type: "licensed" } },
      { recurring: { interval: "month", interval_count: 1, usage_type: "metered" } },
      { tiers: [] },
      { tiers: undefined },
    ]) {
      expect(priceMatches({ ...existing, ...change } as TieredPriceLike, wanted), JSON.stringify(change)).toBe(false);
    }
  });
});

describe("npm run stripe-catalog", () => {
  function run(argv: string[], secret: string | Error = TEST_KEY) {
    const out: string[] = [];
    const err: string[] = [];
    const stripe = memoryStripe();
    const reads: { region: string; profile: string; secretId: string }[] = [];
    const keys: string[] = [];
    const deps = {
      reader: (region: string, profile: string) => async (secretId: string) => {
        reads.push({ region, profile, secretId });
        if (secret instanceof Error) throw secret;
        return secret;
      },
      stripe: (key: string) => {
        keys.push(key);
        return stripe.client;
      },
    };
    return { done: main(argv, (l) => out.push(l), (l) => err.push(l), deps), out, err, stripe, reads, keys };
  }
  const BASE = ["--profile", "supply-prod", "--region", "test-local-1"];

  it("dry-runs in test mode by default, with the key from the test secret, never printing it", async () => {
    const r = run(BASE);
    expect(await r.done).toBe(0);
    expect(r.reads).toEqual([{ region: "test-local-1", profile: "supply-prod", secretId: "supply-checkout/prod/stripe/test-secret-key" }]);
    expect(r.keys).toEqual([TEST_KEY]);
    expect(r.out[0]).toBe("Stripe test mode, key from supply-checkout/prod/stripe/test-secret-key (dry run)");
    expect(r.out).toContain(CATALOG.status);
    expect(r.out).toContain("price supply_checkout_starter_monthly: would create");
    expect(r.out).toContain("portal owners: would create");
    expect(r.out).toContain("portal owners-comped: would create");
    expect(r.out.at(-1)).toBe("Dry run: 5 to change. Run again with --apply to change them.");
    expect(r.stripe.configurations).toHaveLength(0);
    expect(r.stripe.prices).toHaveLength(0);
    expect([...r.out, ...r.err].join("\n")).not.toContain(TEST_KEY);
  });

  it("applies with --apply, then finds nothing to do", async () => {
    const r = run([...BASE, "--apply"]);
    expect(await r.done).toBe(0);
    expect(r.out).toContain("price supply_checkout_starter_monthly: create (price_1)");
    expect(r.out).toContain("portal owners: create (bpc_1)");
    expect(r.out).toContain("portal owners-comped: create (bpc_2)");
    expect(r.out.at(-1)).toBe("Done: 5 changed.");
    const again = await main([...BASE, "--apply"], (l) => r.out.push(l), (l) => r.err.push(l), { reader: () => async () => TEST_KEY, stripe: () => r.stripe.client });
    expect(again).toBe(0);
    expect(r.out).toContain("portal owners: unchanged (bpc_1)");
    expect(r.out).toContain("portal owners-comped: unchanged (bpc_2)");
    expect(r.out.at(-1)).toBe("Done: Stripe already matched the catalog.");
    const dry = await main(BASE, (l) => r.out.push(l), (l) => r.err.push(l), { reader: () => async () => TEST_KEY, stripe: () => r.stripe.client });
    expect(dry).toBe(0);
    expect(r.out.at(-1)).toBe("Dry run: Stripe matches the catalog.");
  });

  it("refuses a live key without --live, and a test key with it, touching nothing", async () => {
    const live = run(BASE, LIVE_KEY);
    expect(await live.done).toBe(1);
    expect(live.err[0]).toBe("Refused: supply-checkout/prod/stripe/test-secret-key: The Stripe secret holds a live key, not a test-mode key. Nothing was read from or written to Stripe.");
    expect(live.keys).toEqual([]);
    const test = run([...BASE, "--live", "--env", "staging"], TEST_KEY);
    expect(await test.done).toBe(1);
    expect(test.reads[0]?.secretId).toBe("supply-checkout/staging/stripe/live-secret-key");
    expect(test.err[0]).toContain("holds a test key, not a live-mode key");
    expect([...live.err, ...test.err].join("\n")).not.toMatch(/sk_(live|test)_/);
  });

  it("uses the live key with --live", async () => {
    const r = run([...BASE, "--live"], LIVE_KEY);
    expect(await r.done).toBe(0);
    expect(r.out[0]).toBe("Stripe live mode, key from supply-checkout/prod/stripe/live-secret-key (dry run)");
  });

  it("says when the secret can't be read", async () => {
    const r = run(BASE, Object.assign(new Error("User: arn:aws:sts::ACCOUNT:assumed-role/x is not authorized on arn:aws:secretsmanager:r:ACCOUNT:secret:y"), { name: "AccessDeniedException" }));
    expect(await r.done).toBe(1);
    // The error's name only: AWS's message holds ARNs with the account ID
    expect(r.err).toEqual(["Refused: supply-checkout/prod/stripe/test-secret-key: couldn't read it (AccessDeniedException). Nothing was read from or written to Stripe."]);
    expect(r.err.join("")).not.toContain("ACCOUNT");
  });

  it("reports Stripe's error fields, not its message", async () => {
    const r = run([...BASE, "--apply"]);
    r.stripe.client.prices.list = async () => {
      throw new Stripe.errors.StripePermissionError({ type: "invalid_request_error", message: "The provided key 'rk_test_xyz' does not have access", code: "secret_key_required", statusCode: 403, requestId: "req_9" } as never);
    };
    expect(await r.done).toBe(1);
    expect(r.err).toEqual(['Failed: {"type":"StripePermissionError","code":"secret_key_required","status":403,"requestId":"req_9"}']);
  });

  it.each([
    [["--help"], 0],
    [["--region", "x"], 2],
    [["--profile", "x"], 2],
    [[...BASE, "--env", "Prod!"], 2],
    [[...BASE, "--bogus"], 2],
  ])("handles the arguments %j", async (argv, code) => {
    const r = run(argv);
    expect(await r.done).toBe(code);
    expect(r.reads).toEqual([]);
    if (code === 0) expect(r.out[0]).toContain("Usage:");
    else expect(r.err[0]).toContain("Usage:");
  });
});

describe("syncPortal", () => {
  it("makes the comped teams' configuration beside ours, the same but with no switching of price (supply-checkout-6e4b)", async () => {
    const stripe = memoryStripe();
    const changes = await syncCatalog(stripe.client, CATALOG, true);
    expect(await syncPortal(stripe.client, CATALOG, changes, true)).toMatchObject({ name: "owners", action: "create", configurationId: "bpc_1" });
    expect(await syncPortal(stripe.client, CATALOG, changes, true, "comped")).toEqual({ kind: "portal", name: "owners-comped", action: "create", configurationId: "bpc_2" });
    expect(stripe.configurations[1]).toMatchObject({
      name: "Supply Checkout owners, comped",
      metadata: COMPED_PORTAL_METADATA,
      features: { subscription_update: { enabled: false }, subscription_cancel: { enabled: true, mode: "at_period_end" }, payment_method_update: { enabled: true } },
    });
    // Each finds its own: neither takes the other's for its own
    expect(await syncPortal(stripe.client, CATALOG, changes, true)).toMatchObject({ action: "unchanged", configurationId: "bpc_1" });
    expect(await syncPortal(stripe.client, CATALOG, changes, true, "comped")).toMatchObject({ action: "unchanged", configurationId: "bpc_2" });
  });

  const IDS = new Map([
    ["supply_checkout_starter_monthly", "price_1"],
    ["supply_checkout_starter_annual", "price_2"],
  ]);

  async function synced() {
    const stripe = memoryStripe();
    const changes = await syncCatalog(stripe.client, CATALOG, true);
    return { stripe, changes };
  }

  it("creates our configuration with the catalog's prices, and a second run leaves it alone", async () => {
    const { stripe, changes } = await synced();
    expect(await syncPortal(stripe.client, CATALOG, changes, true)).toEqual({ kind: "portal", name: "owners", action: "create", configurationId: "bpc_1" });
    expect(stripe.configurations).toHaveLength(1);
    expect(stripe.configurations[0]).toMatchObject({
      name: "Supply Checkout owners",
      metadata: PORTAL_METADATA,
      features: {
        customer_update: { enabled: true, allowed_updates: ["name", "email", "address", "tax_id"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none" },
        // Price only: seats follow the team's members
        subscription_update: { enabled: true, default_allowed_updates: ["price"], products: [{ product: "supply_checkout_starter", prices: ["price_1", "price_2"] }], trial_update_behavior: "continue_trial" },
      },
    });
    expect(await syncPortal(stripe.client, CATALOG, await syncCatalog(stripe.client, CATALOG, true), true)).toEqual({ kind: "portal", name: "owners", action: "unchanged", configurationId: "bpc_1" });
    expect(stripe.calls.filter((c) => c.startsWith("configurations.") && c !== "configurations.list")).toEqual(["configurations.create"]);
  });

  it("points it at a replacement price, and reactivates it if it was archived", async () => {
    const { stripe, changes } = await synced();
    await syncPortal(stripe.client, CATALOG, changes, true);
    const repricedChanges = await syncCatalog(stripe.client, { ...CATALOG, plans: CATALOG.plans.map((p) => ({ ...p, prices: p.prices.map((x) => (x.interval === "month" ? { ...x, flatAmount: 1200 } : x)) })) }, true);
    const configuration = stripe.configurations[0] as (typeof stripe.configurations)[number];
    Object.assign(configuration, { active: false });
    expect((await syncPortal(stripe.client, CATALOG, repricedChanges, true)).action).toBe("update");
    expect(configuration).toMatchObject({ active: true, features: { subscription_update: { products: [{ prices: ["price_3", "price_2"] }] } } });
    expect(stripe.configurations).toHaveLength(1);
  });

  it("prefers an active configuration of ours, and ignores other configurations", async () => {
    const { stripe, changes } = await synced();
    stripe.configurations.push({ id: "bpc_default", active: true, name: null, metadata: {}, features: {} });
    stripe.configurations.push({ id: "bpc_archived", active: false, name: null, metadata: { ...PORTAL_METADATA }, features: {} });
    stripe.configurations.push({ id: "bpc_live", active: true, name: null, metadata: { ...PORTAL_METADATA }, features: {} });
    expect(await syncPortal(stripe.client, CATALOG, changes, true)).toMatchObject({ action: "update", configurationId: "bpc_live" });
    expect(stripe.configurations.find((c) => c.id === "bpc_default")?.features).toEqual({});
  });

  it("changes nothing in a dry run, and says what it would do even before the prices exist", async () => {
    const stripe = memoryStripe();
    const dry = await syncCatalog(stripe.client, CATALOG, false);
    expect(await syncPortal(stripe.client, CATALOG, dry, false)).toEqual({ kind: "portal", name: "owners", action: "create" });
    stripe.configurations.push({ id: "bpc_9", active: true, name: null, metadata: { ...PORTAL_METADATA }, features: {} });
    expect(await syncPortal(stripe.client, CATALOG, dry, false)).toEqual({ kind: "portal", name: "owners", action: "update", configurationId: "bpc_9" });
    // With the prices there, a dry run compares
    const applied = await syncCatalog(stripe.client, CATALOG, true);
    expect((await syncPortal(stripe.client, CATALOG, applied, false)).action).toBe("update");
    stripe.configurations.length = 0;
    expect(await syncPortal(stripe.client, CATALOG, applied, false)).toEqual({ kind: "portal", name: "owners", action: "create" });
    expect(stripe.calls.filter((c) => c.startsWith("configurations.") && c !== "configurations.list")).toEqual([]);
  });

  it("refuses to apply without every price's ID", async () => {
    const stripe = memoryStripe();
    await expect(syncPortal(stripe.client, CATALOG, [], true)).rejects.toThrow("No Stripe price for supply_checkout_starter_monthly");
  });

  it("compares only what we set, in any order", () => {
    const wanted = portalConfiguration(CATALOG, IDS);
    const existing: PortalConfigLike = { id: "bpc_1", active: true, name: wanted.name, metadata: { ...wanted.metadata, extra: "x" }, features: JSON.parse(JSON.stringify(wanted.features)) };
    expect(portalMatches(existing, wanted)).toBe(true);
    const f = existing.features as PortalConfigurationParams["features"];
    expect(portalMatches({ ...existing, features: { ...f, customer_update: { ...f.customer_update, allowed_updates: ["tax_id", "address", "email", "name"] } } }, wanted)).toBe(true);
    for (const change of [{ active: false }, { name: "Other" }, { metadata: null }, { features: { ...f, subscription_cancel: { ...f.subscription_cancel, mode: "immediately" } } }]) {
      expect(portalMatches({ ...existing, ...change } as PortalConfigLike, wanted), JSON.stringify(change)).toBe(false);
    }
  });

  it("matches arrays as sets and objects by the wanted keys", () => {
    expect(contains([1, 2, 2], [2, 1, 2])).toBe(true);
    expect(contains([1, 2, 3], [2, 1, 1])).toBe(false);
    expect(contains([1], [1, 1])).toBe(false);
    expect(contains("x", ["x"])).toBe(false);
    expect(contains({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    expect(contains({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(contains(null, { a: 1 })).toBe(false);
    expect(contains([{ a: 1 }], { 0: { a: 1 } })).toBe(false);
    expect(contains(null, null)).toBe(true);
  });
});
