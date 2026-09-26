import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { APPROVED_REGIONS, configFromContext, validateConfig } from "../lib/config.js";

const context = (values: Record<string, unknown>) => ({ tryGetContext: (key: string) => values[key] });

describe("configFromContext", () => {
  it("defaults to prod in us-east-1 only, no account", () => {
    expect(configFromContext(context({}), {})).toEqual({
      envName: "prod",
      account: undefined,
      regions: ["us-east-1"],
      primaryRegion: "us-east-1",
    });
  });

  it("reads the account from the CDK CLI environment", () => {
    const account = "0".repeat(12);
    expect(configFromContext(context({}), { CDK_DEFAULT_ACCOUNT: account }).account).toBe(account);
  });

  it("accepts regions as a comma-separated -c value", () => {
    const config = configFromContext(context({ envName: "staging", regions: "us-west-2, us-east-1" }), {});
    expect(config).toMatchObject({ envName: "staging", regions: ["us-west-2", "us-east-1"], primaryRegion: "us-west-2" });
  });

  it("accepts a single region with an explicit primary", () => {
    const config = configFromContext(context({ envName: "dev", regions: ["us-east-1"], primaryRegion: "us-east-1" }), {});
    expect(config.regions).toEqual(["us-east-1"]);
  });
});

describe("cdk.json", () => {
  it("deploys us-east-1 only, with us-west-2 approved for later", () => {
    const { context: ctx } = JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8"));
    expect(configFromContext(context(ctx), {})).toMatchObject({ envName: "prod", regions: ["us-east-1"], primaryRegion: "us-east-1" });
    expect(APPROVED_REGIONS).toContain("us-west-2");
  });
});

describe("validateConfig", () => {
  const good = { envName: "prod", regions: ["us-east-1", "us-west-2"], primaryRegion: "us-east-1" };

  it.each([
    [{ ...good, envName: "Prod" }, /envName/],
    [{ ...good, envName: "" }, /envName/],
    [{ ...good, regions: [] }, /At least one region/],
    [{ ...good, regions: ["us-east-1", "us-east-1"] }, /must not repeat/],
    [{ ...good, regions: ["eu-west-1"], primaryRegion: "eu-west-1" }, /not approved/],
    [{ ...good, primaryRegion: "eu-west-1" }, /primaryRegion/],
    [{ ...good, account: "123" }, /12-digit/],
  ])("rejects %o", (config, message) => {
    expect(() => validateConfig(config)).toThrow(message);
  });
});
