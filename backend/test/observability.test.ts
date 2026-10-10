// Structured logs and business metrics (src/observability). Powertools writes
// both to stdout as JSON lines; these tests read them back.

import type { Context } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BusinessMetric,
  createObservability,
  METRICS_NAMESPACE,
  NEEDS_ATTENTION_METRICS,
  NEEDS_ATTENTION_ONCE_A_DAY,
  REGION_DIMENSION,
  SECURITY_ATTENTION_METRICS,
  TEST_SKIPPED_METRICS,
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
  functionName: "supply-checkout-prod-projects",
  functionVersion: "7",
  memoryLimitInMB: "512",
} as Context;

describe("business metrics", () => {
  it("sends counts in the SupplyCheckout namespace with Region as the only dimension", () => {
    const obs = createObservability({ service: "projects", env });
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

  it("logs a test account's or team's customer-activity metric instead of sending it, and still sends its failures (supply-checkout-o60.2)", () => {
    const obs = createObservability({ service: "projects", env });
    obs.count(BusinessMetric.Checkouts, 3, { teamId: "t-test", test: true });
    obs.count(BusinessMetric.SignUps, 1, { teamId: "t-test", test: true });
    obs.flush();
    expect(emf()).toEqual([]);
    expect(logs()).toEqual([
      expect.objectContaining({ level: "INFO", message: "Business metric not sent for a test account or team", metric: "Checkouts", value: 3, teamId: "t-test", test: true }),
      expect.objectContaining({ metric: "SignUps", value: 1, test: true }),
    ]);
    // A failure is a real failure: sent, with the mark beside it, and so is its ratio's denominator
    obs.count(BusinessMetric.ReceiptReadFailures, 1, { teamId: "t-test", test: true });
    obs.count(BusinessMetric.ReceiptReads, 1, { teamId: "t-test", test: true });
    expect(emf()).toEqual([expect.objectContaining({ ReceiptReadFailures: 1, teamId: "t-test", test: "true" }), expect.objectContaining({ ReceiptReads: 1, teamId: "t-test", test: "true" })]);
    // A customer's, and a mark that isn't exactly true, are sent
    obs.count(BusinessMetric.Checkouts, 2, { teamId: "t-customer" });
    obs.count(BusinessMetric.Checkouts, 1, { teamId: "t-other", test: false });
    expect(emf().slice(2)).toEqual([expect.objectContaining({ Checkouts: 2, teamId: "t-customer" }), expect.objectContaining({ Checkouts: 1, teamId: "t-other", test: "false" })]);
  });

  it("adds every non-zero count of a rare event to NeedsAttention, on the same line, for the one alarm (supply-checkout-7pe.1)", () => {
    const obs = createObservability({ service: "team-purge", env });
    obs.count(BusinessMetric.ClosedTeamRenewalsCharged, 2, { teamId: "t1" });
    const [withMetadata] = emf();
    expect(withMetadata).toMatchObject({ ClosedTeamRenewalsCharged: 2, NeedsAttention: 2, teamId: "t1" });
    expect(withMetadata._aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: "ClosedTeamRenewalsCharged", Unit: "Count" },
      { Name: "NeedsAttention", Unit: "Count" },
    ]);
    expect(withMetadata._aws.CloudWatchMetrics[0].Dimensions).toEqual([[REGION_DIMENSION]]);
    // Without metadata, two in one flush add up on one line
    obs.count(BusinessMetric.HeldTeamsPurged);
    obs.count(BusinessMetric.LapseFailures);
    obs.flush();
    expect(emf()[1]).toMatchObject({ HeldTeamsPurged: 1, LapseFailures: 1, NeedsAttention: [1, 1] });
    // A zero count of one, and any count of a metric that isn't one, add nothing
    obs.count(BusinessMetric.LapseFailures, 0);
    obs.count(BusinessMetric.Checkouts, 3);
    obs.flush();
    expect(emf()[2]).toMatchObject({ LapseFailures: 0, Checkouts: 3 });
    expect(emf()[2]).not.toHaveProperty("NeedsAttention");
    expect(NEEDS_ATTENTION_METRICS.has(BusinessMetric.NeedsAttention)).toBe(false);
    for (const metric of [...NEEDS_ATTENTION_METRICS, ...SECURITY_ATTENTION_METRICS]) expect(TEST_SKIPPED_METRICS.has(metric), metric).toBe(false);
    // The trial cap tells it once a day itself (receipts-handler.ts), not on every refused read
    expect(NEEDS_ATTENTION_METRICS.has(BusinessMetric.ReceiptTrialCapReached)).toBe(false);
    expect(NEEDS_ATTENTION_ONCE_A_DAY).toEqual([BusinessMetric.ReceiptTrialCapReached]);
  });

  it("adds every non-zero count of a security event to SecurityAttention instead, so the two alarms can't hide each other (supply-checkout-7pe.1)", () => {
    const obs = createObservability({ service: "auth", env });
    obs.count(BusinessMetric.SignOutRevokeFailures, 1, { reason: "cognito" });
    obs.count(BusinessMetric.DeletionRecordRewrites, 2);
    obs.count(BusinessMetric.SecurityNoticeFailures, 0);
    obs.flush();
    const [withMetadata, rest] = emf();
    expect(withMetadata).toMatchObject({ SignOutRevokeFailures: 1, SecurityAttention: 1 });
    expect(withMetadata).not.toHaveProperty("NeedsAttention");
    expect(rest).toMatchObject({ DeletionRecordRewrites: 2, SecurityNoticeFailures: 0, SecurityAttention: 2 });
    expect(rest).not.toHaveProperty("NeedsAttention");
    expect([...SECURITY_ATTENTION_METRICS].sort()).toEqual([BusinessMetric.DeletionRecordRewrites, BusinessMetric.SecurityNoticeFailures, BusinessMetric.SignOutRevokeFailures]);
    for (const metric of SECURITY_ATTENTION_METRICS) expect(NEEDS_ATTENTION_METRICS.has(metric), metric).toBe(false);
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

  it("sends gauges, zero included, in their unit beside counts", () => {
    const obs = createObservability({ service: "ops", env });
    obs.gauge(BusinessMetric.StuckImports, 0);
    obs.gauge(BusinessMetric.EmailQuotaUsedPercent, 42.5, "Percent");
    obs.flush();
    const [blob] = emf();
    expect(blob._aws.CloudWatchMetrics[0].Dimensions).toEqual([[REGION_DIMENSION]]);
    expect(blob._aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: "StuckImports", Unit: "Count" },
      { Name: "EmailQuotaUsedPercent", Unit: "Percent" },
    ]);
    expect(blob).toMatchObject({ Region: REGION, StuckImports: 0, EmailQuotaUsedPercent: 42.5 });
  });

  it("rejects negative and non-numeric gauges", () => {
    const obs = createObservability({ env });
    expect(() => obs.gauge(BusinessMetric.StuckImports, -1)).toThrow(/0 or more/);
    expect(() => obs.gauge(BusinessMetric.EmailQuotaUsedPercent, Number.POSITIVE_INFINITY, "Percent")).toThrow(/0 or more/);
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
    const obs = createObservability({ service: "projects", env });
    obs.logger.info("Checked out", { projectId: "s1" });
    expect(logs()).toEqual([
      expect.objectContaining({ level: "INFO", message: "Checked out", service: "projects", env: "prod", region: REGION, projectId: "s1" }),
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
    const obs = createObservability({ service: "projects", env });
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
