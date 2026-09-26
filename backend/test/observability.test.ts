// Structured logs and business metrics (src/observability). Powertools writes
// both to stdout as JSON lines; these tests read them back.

import type { Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BusinessMetric,
  createObservability,
  METRICS_NAMESPACE,
  REGION_DIMENSION,
  withObservability,
} from "../src/observability/index.js";

// Made-up regions: real region names belong only in infra/lib/config.ts (ADR 0010)
const REGION = "test-local-1";
const OTHER_REGION = "test-local-2";
const env = { AWS_REGION: REGION, SUPPLY_CHECKOUT_ENV: "prod" };

let lines: Record<string, unknown>[] = [];
beforeEach(() => {
  lines = [];
  const capture = (chunk: string | Uint8Array) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(line));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

interface Emf {
  _aws: { CloudWatchMetrics: { Namespace: string; Dimensions: string[][]; Metrics: { Name: string; Unit: string }[] }[] };
  [key: string]: unknown;
}
const emf = () => lines.filter((l): l is Emf => "_aws" in l);
const logs = () => lines.filter((l) => !("_aws" in l));

const context = {
  awsRequestId: "req-1",
  functionName: "supply-checkout-prod-sheets",
  functionVersion: "7",
  memoryLimitInMB: "512",
} as Context;

describe("business metrics", () => {
  it("sends counts in the SupplyCheckout namespace with Region as the only dimension", () => {
    const obs = createObservability({ service: "sheets", env });
    obs.count(BusinessMetric.Checkouts, 3);
    obs.count(BusinessMetric.Returns);
    obs.flush();

    const [blob, ...rest] = emf();
    expect(rest).toEqual([]);
    const [directive] = blob._aws.CloudWatchMetrics;
    expect(directive.Namespace).toBe(METRICS_NAMESPACE);
    expect(directive.Namespace).toBe("SupplyCheckout");
    expect(directive.Dimensions).toEqual([[REGION_DIMENSION]]);
    expect(directive.Metrics).toEqual([
      { Name: "Checkouts", Unit: "Count" },
      { Name: "Returns", Unit: "Count" },
    ]);
    expect(blob).toMatchObject({ Region: REGION, Checkouts: 3, Returns: 1 });
    expect(blob).not.toHaveProperty("service");
  });

  it("uses the Lambda's region, falling back to AWS_DEFAULT_REGION", () => {
    const obs = createObservability({ env: { AWS_DEFAULT_REGION: OTHER_REGION } });
    expect(obs.region).toBe(OTHER_REGION);
    obs.count(BusinessMetric.SignUps);
    obs.flush();
    expect(emf()[0]).toMatchObject({ Region: OTHER_REGION, SignUps: 1 });
  });

  it("fails fast without a region, so no metric is sent without its dimension", () => {
    expect(() => createObservability({ env: {} })).toThrow("AWS_REGION is not set");
  });

  it("writes metadata beside the metric, not as a dimension", () => {
    const obs = createObservability({ service: "receipts", env });
    obs.count(BusinessMetric.ReceiptReads);
    obs.count(BusinessMetric.ReceiptTokens, 1234, { teamId: "t1", cached: false });
    // The earlier metric goes out first, without the metadata
    const [earlier, blob] = emf();
    expect(earlier).toMatchObject({ ReceiptReads: 1 });
    expect(earlier).not.toHaveProperty("teamId");
    expect(blob._aws.CloudWatchMetrics[0].Dimensions).toEqual([[REGION_DIMENSION]]);
    expect(blob).toMatchObject({ Region: REGION, ReceiptTokens: 1234, teamId: "t1", cached: "false" });
    // Sent at once; nothing left to flush
    obs.flush();
    expect(emf()).toHaveLength(2);
  });

  it("does nothing on flush when no metric was counted", () => {
    const { flush } = createObservability({ env });
    flush();
    expect(lines).toEqual([]);
  });

  it("rejects negative and non-numeric counts", () => {
    const obs = createObservability({ env });
    expect(() => obs.count(BusinessMetric.Checkouts, -1)).toThrow(/0 or more/);
    expect(() => obs.count(BusinessMetric.Checkouts, Number.NaN)).toThrow(/0 or more/);
  });

  it("takes the namespace and service from the environment the CDK app sets", () => {
    const obs = createObservability({
      env: { ...env, POWERTOOLS_SERVICE_NAME: "billing", POWERTOOLS_METRICS_NAMESPACE: "SupplyCheckoutTest" },
    });
    obs.logger.info("hello");
    obs.count(BusinessMetric.CheckoutSessionErrors);
    obs.flush();
    expect(emf()[0]._aws.CloudWatchMetrics[0].Namespace).toBe("SupplyCheckoutTest");
    expect(logs()[0]).toMatchObject({ service: "billing" });
  });
});

describe("structured logs", () => {
  it("writes one JSON object per line with the service, environment and region", () => {
    const obs = createObservability({ service: "sheets", env });
    obs.logger.info("Checked out", { sheetId: "s1" });
    expect(logs()).toEqual([
      expect.objectContaining({ level: "INFO", message: "Checked out", service: "sheets", env: "prod", region: REGION, sheetId: "s1" }),
    ]);
  });

  it("defaults the service and environment when neither is set", () => {
    const obs = createObservability({ env: { AWS_REGION: REGION } });
    obs.logger.info("hi");
    expect(logs()[0]).toMatchObject({ service: "supply-checkout", env: "local" });
  });

  it("honours POWERTOOLS_LOG_LEVEL", () => {
    const obs = createObservability({ env: { ...env, POWERTOOLS_LOG_LEVEL: "WARN" } });
    obs.logger.info("quiet");
    obs.logger.warn("loud");
    expect(logs().map((l) => l.message)).toEqual(["loud"]);
  });
});

describe("withObservability", () => {
  it("adds the request ID to every line and flushes metrics after the handler", async () => {
    const obs = createObservability({ service: "sheets", env });
    const handler = withObservability(obs, async (event: { n: number }) => {
      obs.logger.info("working");
      obs.count(BusinessMetric.Checkouts, event.n);
      return "ok";
    });
    await expect(handler({ n: 2 }, context)).resolves.toBe("ok");
    expect(logs()[0]).toMatchObject({ message: "working", function_request_id: "req-1", function_name: context.functionName });
    expect(emf()[0]).toMatchObject({ Checkouts: 2 });
  });

  it("logs an unhandled error once, rethrows it, and still flushes metrics", async () => {
    const obs = createObservability({ service: "billing", env });
    const handler = withObservability(obs, async () => {
      obs.count(BusinessMetric.CheckoutSessionErrors);
      throw new Error("Stripe is down");
    });
    await expect(handler({}, context)).rejects.toThrow("Stripe is down");
    const errors = logs().filter((l) => l.level === "ERROR");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ message: "Unhandled error", error: expect.objectContaining({ message: "Stripe is down" }) });
    expect(emf()[0]).toMatchObject({ CheckoutSessionErrors: 1 });
  });
});
