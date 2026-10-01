// The Stripe client's key handling (src/billing/stripe.ts), the price lookup
// by lookup key (src/billing/prices.ts) and the catalog (src/billing/catalog.ts).

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BILLING_INTERVALS, CATALOG, catalogPrice, planForLookupKey } from "../src/billing/catalog.js";
import { PRICE_TTL_MS, PriceNotFoundError, priceResolver, type StripePriceLike } from "../src/billing/prices.js";
import {
  cachedStripe,
  createStripe,
  keyFromSecret,
  keyMode,
  requireMode,
  requireRestricted,
  secretsManagerClientConfig,
  secretsManagerReader,
  STRIPE_CLIENT_TTL_MS,
  stripeErrorFields,
  stripeModeFrom,
  stripeSecretName,
} from "../src/billing/stripe.js";

// Made-up keys: the right shape, never real
const TEST_KEY = `sk_test_${"a".repeat(24)}`;
const RESTRICTED_TEST_KEY = `rk_test_${"b".repeat(24)}`;
const LIVE_KEY = `sk_live_${"c".repeat(24)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stripe keys", () => {
  it("tells a key's mode", () => {
    expect(keyMode(TEST_KEY)).toBe("test");
    expect(keyMode(RESTRICTED_TEST_KEY)).toBe("test");
    expect(keyMode(LIVE_KEY)).toBe("live");
    expect(keyMode("pk_test_abc")).toBeUndefined();
    expect(keyMode(`${TEST_KEY}\n`)).toBeUndefined();
    expect(keyMode("")).toBeUndefined();
  });

  it("reads the key from a plain secret, or from the one key field of a JSON secret", () => {
    expect(keyFromSecret(` ${TEST_KEY}\n`)).toBe(TEST_KEY);
    expect(keyFromSecret(JSON.stringify({ secretKey: TEST_KEY, note: "sandbox" }))).toBe(TEST_KEY);
  });

  it.each([
    ["nothing", undefined],
    ["an empty string", ""],
    ["a publishable key", "pk_test_abc"],
    ["broken JSON", "{not json"],
    ["JSON without a key", JSON.stringify({ note: "none" })],
    ["JSON with two keys", JSON.stringify({ a: TEST_KEY, b: RESTRICTED_TEST_KEY })],
    ["a JSON string", JSON.stringify(TEST_KEY)],
  ])("refuses a secret holding %s, without echoing it", (_what, value) => {
    expect(() => keyFromSecret(value)).toThrow("doesn't hold a Stripe secret or restricted key");
    try {
      keyFromSecret(value);
    } catch (error) {
      expect((error as Error).message).not.toContain("sk_test");
    }
  });

  it("refuses a key of the other mode, naming the modes and not the key", () => {
    expect(requireMode(TEST_KEY, "test")).toBe(TEST_KEY);
    expect(requireMode(LIVE_KEY, "live")).toBe(LIVE_KEY);
    expect(() => requireMode(LIVE_KEY, "test")).toThrow("holds a live key, not a test-mode key");
    expect(() => requireMode(TEST_KEY, "live")).toThrow("holds a test key, not a live-mode key");
    expect(() => requireMode("nope", "test")).toThrow("holds a non-Stripe key");
    expect(() => requireMode(LIVE_KEY, "test")).not.toThrow(LIVE_KEY);
  });

  it("names the secret for an environment and mode", () => {
    expect(stripeSecretName("prod", "test")).toBe("supply-checkout/prod/stripe/test-secret-key");
    expect(stripeSecretName("staging", "live")).toBe("supply-checkout/staging/stripe/live-secret-key");
  });

  it("takes the mode from the environment: test or live only", () => {
    expect(stripeModeFrom("test")).toBe("test");
    expect(stripeModeFrom("live")).toBe("live");
    expect(() => stripeModeFrom(undefined)).toThrow("STRIPE_MODE must be test or live");
    expect(() => stripeModeFrom("sandbox")).toThrow("STRIPE_MODE must be test or live");
  });
});

describe("cachedStripe", () => {
  function setup(values: (string | Error)[]) {
    let now = 1_000_000;
    const read = vi.fn(async (id: string) => {
      expect(id).toBe("the-secret");
      const next = values.shift();
      if (next instanceof Error) throw next;
      return next;
    });
    const create = vi.fn((key: string) => ({ key }));
    const get = cachedStripe({ secretId: "the-secret", mode: "test", read, create, now: () => now });
    return { get, read, create, tick: (ms: number) => (now += ms) };
  }

  it("reads the secret once and shares the client, including between requests that arrive together", async () => {
    const { get, read, create } = setup([TEST_KEY]);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    expect(await get()).toBe(a);
    expect(read).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(TEST_KEY);
  });

  it("reads it again after an hour, so a rotated key is picked up", async () => {
    const { get, read, tick } = setup([TEST_KEY, RESTRICTED_TEST_KEY]);
    expect(await get()).toEqual({ key: TEST_KEY });
    tick(STRIPE_CLIENT_TTL_MS - 1);
    expect(await get()).toEqual({ key: TEST_KEY });
    tick(1);
    expect(await get()).toEqual({ key: RESTRICTED_TEST_KEY });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a failure: the next request reads again", async () => {
    const { get } = setup([new Error("ThrottlingException"), TEST_KEY]);
    await expect(get()).rejects.toThrow("ThrottlingException");
    expect(await get()).toEqual({ key: TEST_KEY });
  });

  it("refuses a live key where test mode is configured, and never builds a client with it", async () => {
    const { get, create } = setup([LIVE_KEY]);
    await expect(get()).rejects.toThrow("not a test-mode key");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("requireRestricted", () => {
  it("takes a restricted key and refuses a full secret key without naming it", () => {
    expect(requireRestricted(RESTRICTED_TEST_KEY)).toBe(RESTRICTED_TEST_KEY);
    expect(() => requireRestricted(TEST_KEY)).toThrow("not a restricted key");
    try {
      requireRestricted(TEST_KEY);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(TEST_KEY.slice(8));
    }
  });
});

describe("secretsManagerReader", () => {
  // supply-checkout-6uw.4 review: a hung read mustn't hold cachedSecret's shared pending read
  it("bounds every read: 1 second to connect, 3 to answer (failing the call, not only warning), 2 tries", async () => {
    expect(secretsManagerClientConfig("test-local-1")).toEqual({ region: "test-local-1", maxAttempts: 2, requestHandler: { connectionTimeout: 1_000, requestTimeout: 3_000, throwOnRequestTimeout: true } });
    const client = new SecretsManagerClient(secretsManagerClientConfig("test-local-1", { accessKeyId: "a", secretAccessKey: "b" }));
    const handler = client.config.requestHandler as unknown as { configProvider: Promise<Record<string, unknown>> };
    expect(await handler.configProvider).toMatchObject({ connectionTimeout: 1_000, requestTimeout: 3_000, throwOnRequestTimeout: true });
    client.destroy();
  });

  it("reads the secret's string by ID", async () => {
    const send = vi.spyOn(SecretsManagerClient.prototype, "send").mockImplementation(async (command: unknown) => {
      expect(command).toBeInstanceOf(GetSecretValueCommand);
      expect((command as GetSecretValueCommand).input).toEqual({ SecretId: "the-secret" });
      return { SecretString: TEST_KEY };
    });
    const read = secretsManagerReader("test-local-1", { accessKeyId: "a", secretAccessKey: "b" });
    expect(await read("the-secret")).toBe(TEST_KEY);
    expect(await secretsManagerReader(undefined)("the-secret")).toBe(TEST_KEY);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("createStripe", () => {
  it("pins the SDK's API version", () => {
    const client = createStripe(TEST_KEY);
    expect(client).toBeInstanceOf(Stripe);
    expect(Stripe.API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\./);
  });
});

describe("stripeErrorFields", () => {
  it("keeps a Stripe error's type, code, status and request ID, never its message", () => {
    const error = new Stripe.errors.StripeCardError({ type: "card_error", message: "Your card number 4242 was declined", code: "card_declined", statusCode: 402, requestId: "req_1" } as never);
    expect(stripeErrorFields(error)).toEqual({ type: "StripeCardError", code: "card_declined", status: 402, requestId: "req_1" });
    const bare = new Stripe.errors.StripeAPIError({ type: "api_error", message: "oops" } as never);
    expect(stripeErrorFields(bare)).toEqual({ type: "StripeAPIError" });
  });

  it("names anything else by its error name", () => {
    expect(stripeErrorFields(new TypeError("x"))).toEqual({ code: "TypeError" });
    expect(stripeErrorFields(null)).toEqual({ code: "Unknown" });
  });
});

describe("the catalog", () => {
  it("is marked provisional pending the pricing decision", () => {
    expect(CATALOG.status).toContain("Provisional");
    expect(CATALOG.status).toContain("supply-checkout-akz");
  });

  it("sells Starter monthly and annually, as ADR 0009 proposes: $9 with 3 seats, $3 a seat, a year for 10 months", () => {
    const monthly = catalogPrice("starter", "month");
    const annual = catalogPrice("starter", "year");
    expect(monthly?.plan.includedSeats).toBe(3);
    expect(monthly?.price).toMatchObject({ flatAmount: 900, perSeatAmount: 300 });
    expect(annual?.price).toMatchObject({ flatAmount: 10 * 900, perSeatAmount: 10 * 300 });
    expect(CATALOG.currency).toBe("usd");
  });

  it("has a price for every interval of every plan, with unique lookup keys and products", () => {
    for (const plan of CATALOG.plans) expect(plan.prices.map((p) => p.interval).sort()).toEqual([...BILLING_INTERVALS].sort());
    const keys = CATALOG.plans.flatMap((p) => p.prices.map((x) => x.lookupKey));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(CATALOG.plans.map((p) => p.productId)).size).toBe(CATALOG.plans.length);
  });

  it("finds nothing for a plan or interval we don't sell", () => {
    expect(catalogPrice("enterprise", "month")).toBeUndefined();
    expect(catalogPrice("starter", "week")).toBeUndefined();
    expect(catalogPrice("toString", "month")).toBeUndefined();
  });

  it("maps a lookup key back to its plan and interval", () => {
    expect(planForLookupKey("supply_checkout_starter_annual")).toEqual({ plan: "starter", interval: "year" });
    expect(planForLookupKey("someone_elses_price")).toBeUndefined();
    expect(planForLookupKey(null)).toBeUndefined();
  });
});

describe("priceResolver", () => {
  const plan = CATALOG.plans[0] as (typeof CATALOG.plans)[number];
  const monthly = plan.prices[0] as (typeof plan.prices)[number];
  const good: StripePriceLike = { id: "price_1", lookup_key: monthly.lookupKey, active: true, currency: "usd", product: plan.productId, recurring: { interval: "month" } };

  function setup(data: StripePriceLike[]) {
    let now = 0;
    const list = vi.fn(async (params: { lookup_keys: string[]; active: boolean; limit: number }) => {
      expect(params).toEqual({ lookup_keys: [monthly.lookupKey], active: true, limit: 2 });
      return { data };
    });
    const resolve = priceResolver(async () => ({ prices: { list } }), { now: () => now });
    return { resolve, list, tick: (ms: number) => (now += ms) };
  }

  it("finds the active price by lookup key, and keeps it for ten minutes", async () => {
    const { resolve, list, tick } = setup([good]);
    expect(await resolve(plan, monthly)).toBe("price_1");
    tick(PRICE_TTL_MS - 1);
    expect(await resolve(plan, monthly)).toBe("price_1");
    tick(1);
    await resolve(plan, monthly);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("accepts an expanded product", async () => {
    const { resolve } = setup([{ ...good, product: { id: plan.productId } }]);
    expect(await resolve(plan, monthly)).toBe("price_1");
  });

  it.each([
    ["no price", []],
    ["two prices", [good, { ...good, id: "price_2" }]],
    ["another product's price", [{ ...good, product: "someone_else" }]],
    ["the wrong interval", [{ ...good, recurring: { interval: "year" } }]],
    ["a one-off price", [{ ...good, recurring: null }]],
    ["another currency", [{ ...good, currency: "eur" }]],
    ["an archived price", [{ ...good, active: false }]],
    ["another lookup key", [{ ...good, lookup_key: "other" }]],
  ])("refuses %s", async (_what, data) => {
    const { resolve } = setup(data as StripePriceLike[]);
    await expect(resolve(plan, monthly)).rejects.toBeInstanceOf(PriceNotFoundError);
  });
});
