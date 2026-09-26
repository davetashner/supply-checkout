import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALL_REGIONS,
  APPROVED_REGIONS,
  DEFAULT_DOMAIN_NAME,
  DEFAULT_REGIONS,
  GLOBAL_SERVICES_REGION,
  configFromContext,
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

describe("configFromContext", () => {
  it("defaults to prod in the deployed regions only, no account", () => {
    expect(configFromContext(context({}), {})).toEqual({
      envName: "prod",
      domainName: DEFAULT_DOMAIN_NAME,
      account: undefined,
      regions: [...DEFAULT_REGIONS],
      primaryRegion: DEFAULT_REGIONS[0],
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
