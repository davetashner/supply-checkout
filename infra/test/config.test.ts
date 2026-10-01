import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALL_REGIONS,
  APPROVED_REGIONS,
  DEFAULT_DOMAIN_NAME,
  DEFAULT_REGIONS,
  GLOBAL_SERVICES_REGION,
  RECEIPT_BENCHMARK_MODEL_ID,
  RECEIPT_MODEL_ID,
  configFromContext,
  MAX_RECEIPTS_RESERVED_CONCURRENCY,
  receiptsReservedConcurrencyFromContext,
  stripeModeOf,
  stripeOpsKeySecretArn,
  stripeSecretArn,
  stripeWebhookSecretArn,
  validateConfig,
} from "../lib/config.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;

const context = (values: Record<string, unknown>) => ({ tryGetContext: (key: string) => values[key] });

describe("region constants", () => {
  it("approves two regions, deploys one of them, and keeps global services in the first", () => {
    expect(APPROVED_REGIONS).toHaveLength(2);
    expect(DEFAULT_REGIONS).toEqual([EAST]);
    expect(GLOBAL_SERVICES_REGION).toBe(EAST);
  });
});

describe("receipt reading models", () => {
  it("pins the Bedrock model IDs to US cross-region inference profiles (ADR 0008)", () => {
    expect(RECEIPT_MODEL_ID).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(RECEIPT_BENCHMARK_MODEL_ID).toBe("us.anthropic.claude-sonnet-4-6");
    for (const id of [RECEIPT_MODEL_ID, RECEIPT_BENCHMARK_MODEL_ID]) expect(id).toMatch(/^us\.anthropic\./);
  });
});

describe("receiptsReservedConcurrencyFromContext", () => {
  it("is off unless set, and a whole number from 1 to the maximum", () => {
    expect(receiptsReservedConcurrencyFromContext(context({}))).toBeUndefined();
    expect(receiptsReservedConcurrencyFromContext(context({ receiptsReservedConcurrency: "" }))).toBeUndefined();
    expect(receiptsReservedConcurrencyFromContext(context({ receiptsReservedConcurrency: "20" }))).toBe(20);
    expect(receiptsReservedConcurrencyFromContext(context({ receiptsReservedConcurrency: 5 }))).toBe(5);
    expect(receiptsReservedConcurrencyFromContext(context({ receiptsReservedConcurrency: String(MAX_RECEIPTS_RESERVED_CONCURRENCY) }))).toBe(100);
    for (const bad of ["0", "-1", "1.5", "ten", "07", String(MAX_RECEIPTS_RESERVED_CONCURRENCY + 1)]) {
      expect(() => receiptsReservedConcurrencyFromContext(context({ receiptsReservedConcurrency: bad })), bad).toThrow("receiptsReservedConcurrency must be a whole number");
    }
  });
});

describe("configFromContext", () => {
  it("defaults to prod in the deployed regions only, no account", () => {
    expect(configFromContext(context({}), {})).toEqual({
      envName: "prod",
      domainName: DEFAULT_DOMAIN_NAME,
      account: undefined,
      regions: [...DEFAULT_REGIONS],
      primaryRegion: DEFAULT_REGIONS[0],
      stripeMode: "test",
    });
  });

  it("reads the account from the CDK CLI environment", () => {
    const account = "0".repeat(12);
    expect(configFromContext(context({}), { CDK_DEFAULT_ACCOUNT: account }).account).toBe(account);
  });

  it("accepts regions as a comma-separated -c value", () => {
    const config = configFromContext(context({ envName: "staging", regions: `${WEST}, ${EAST}` }), {});
    expect(config).toMatchObject({ envName: "staging", regions: [WEST, EAST], primaryRegion: WEST });
  });

  it("accepts -c regions=all for every approved region", () => {
    const config = configFromContext(context({ regions: ALL_REGIONS }), {});
    expect(config).toMatchObject({ regions: [...APPROVED_REGIONS], primaryRegion: EAST });
  });

  it("takes the domain from context, defaulting to the registered one", () => {
    expect(DEFAULT_DOMAIN_NAME).toBe("supplycheckout.com");
    expect(configFromContext(context({ domainName: "example.com" }), {}).domainName).toBe("example.com");
  });

  it("accepts a single region with an explicit primary", () => {
    const config = configFromContext(context({ envName: "dev", regions: [EAST], primaryRegion: EAST }), {});
    expect(config.regions).toEqual([EAST]);
  });
});

describe("cdk.json", () => {
  it("sets the environment and leaves the regions to lib/config.ts", () => {
    const { context: ctx } = JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8"));
    expect(ctx).not.toHaveProperty("regions");
    expect(ctx).not.toHaveProperty("primaryRegion");
    expect(configFromContext(context(ctx), {})).toMatchObject({ envName: "prod", regions: [EAST], primaryRegion: EAST });
  });
});

describe("validateConfig", () => {
  const good = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };
  const unapproved = "xx-nowhere-1";

  it.each([
    [{ ...good, envName: "Prod" }, /envName/],
    [{ ...good, envName: "" }, /envName/],
    [{ ...good, regions: [] }, /At least one region/],
    [{ ...good, regions: [EAST, EAST] }, /must not repeat/],
    [{ ...good, regions: [unapproved], primaryRegion: unapproved }, /not approved/],
    [{ ...good, primaryRegion: unapproved }, /primaryRegion/],
    [{ ...good, account: "123" }, /12-digit/],
    [{ ...good, domainName: "Example.com" }, /domainName/],
    [{ ...good, domainName: "localhost" }, /domainName/],
    [{ ...good, domainName: "https://example.com" }, /domainName/],
  ])("rejects %o", (config, message) => {
    expect(() => validateConfig(config)).toThrow(message);
  });
});

describe("Stripe mode and secret", () => {
  it("uses the test key unless the environment is configured live", () => {
    expect(configFromContext(context({ stripeMode: "live" }), {}).stripeMode).toBe("live");
    expect(stripeModeOf({})).toBe("test");
    expect(stripeModeOf({ stripeMode: "live" })).toBe("live");
    expect(() => configFromContext(context({ stripeMode: "sandbox" }), {})).toThrow("stripeMode must be test or live");
  });

  it("names exactly one secret: the environment's key for the mode, with Secrets Manager's six-character suffix", () => {
    const where = { partition: "aws", region: EAST, account: "${AWS::AccountId}" };
    expect(stripeSecretArn(where, "prod", "test")).toBe(`arn:aws:secretsmanager:${EAST}:\${AWS::AccountId}:secret:supply-checkout/prod/stripe/test-secret-key-??????`);
    expect(stripeWebhookSecretArn(where, "prod", "test")).toBe(`arn:aws:secretsmanager:${EAST}:\${AWS::AccountId}:secret:supply-checkout/prod/stripe/test-webhook-secret-??????`);
    expect(stripeSecretArn({ ...where, region: WEST }, "staging", "live")).toBe(`arn:aws:secretsmanager:${WEST}:\${AWS::AccountId}:secret:supply-checkout/staging/stripe/live-secret-key-??????`);
    // The ops function's restricted key (supply-checkout-6uw.4): its own secret, never the billing key's
    expect(stripeOpsKeySecretArn(where, "prod", "test")).toBe(`arn:aws:secretsmanager:${EAST}:\${AWS::AccountId}:secret:supply-checkout/prod/stripe/test-ops-restricted-key-??????`);
  });
});
