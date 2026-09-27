// The catalog script (scripts/stripe-catalog.ts) against an in-memory Stripe
// that keeps products, prices, lookup keys and idempotency keys as Stripe does.

import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { type CatalogStripe, main, type PriceParams, priceMatches, priceParams, type ProductLike, syncCatalog, type TieredPriceLike } from "../scripts/stripe-catalog.js";
import { type Catalog, CATALOG } from "../src/billing/catalog.js";

// Made-up keys: the right shape, never real
const TEST_KEY = `sk_test_${"a".repeat(24)}`;
const LIVE_KEY = `sk_live_${"c".repeat(24)}`;

function memoryStripe() {
  const products = new Map<string, ProductLike>();
  const prices: (TieredPriceLike & { tiers: NonNullable<TieredPriceLike["tiers"]> })[] = [];
  const replays = new Map<string, unknown>();
  const calls: string[] = [];
  const idempotent = <T>(key: string, make: () => T): T => {
    if (!replays.has(key)) replays.set(key, make());
    return replays.get(key) as T;
  };
  const notFound = () => new Stripe.errors.StripeInvalidRequestError({ type: "invalid_request_error", message: "No such product", code: "resource_missing", statusCode: 404 } as never);
  const client: CatalogStripe = {
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
  return { client, products, prices, calls };
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
    expect(r.out.at(-1)).toBe("Dry run: 3 to change. Run again with --apply to change them.");
    expect(r.stripe.prices).toHaveLength(0);
    expect([...r.out, ...r.err].join("\n")).not.toContain(TEST_KEY);
  });

  it("applies with --apply, then finds nothing to do", async () => {
    const r = run([...BASE, "--apply"]);
    expect(await r.done).toBe(0);
    expect(r.out).toContain("price supply_checkout_starter_monthly: create (price_1)");
    expect(r.out.at(-1)).toBe("Done: 3 changed.");
    const again = await main([...BASE, "--apply"], (l) => r.out.push(l), (l) => r.err.push(l), { reader: () => async () => TEST_KEY, stripe: () => r.stripe.client });
    expect(again).toBe(0);
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
    const r = run(BASE, Object.assign(new Error("Secrets Manager can't find the specified secret."), { name: "ResourceNotFoundException" }));
    expect(await r.done).toBe(1);
    expect(r.err[0]).toContain("Refused: supply-checkout/prod/stripe/test-secret-key: Secrets Manager can't find");
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
