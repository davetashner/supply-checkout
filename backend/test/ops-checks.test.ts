// The scheduled operations checks (src/ops): stuck imports, the SES sending
// quota and the nightly seat reconciliation. The stuck-import query itself runs against DynamoDB Local in
// imports.test.ts; here it runs against a fake that answers like DynamoDB.

import type { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { SEAT_RECONCILE_ATTRIBUTES, STUCK_IMPORT_ATTRIBUTES } from "../src/data/schema.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { createEmailQuotaHandler, quotaUsedPercent } from "../src/ops/email-quota-handler.js";
import { MAX_LOGGED_STUCK_IMPORTS, STUCK_IMPORT_AFTER_MINUTES } from "../src/ops/names.js";
import { createSeatReconcileHandler } from "../src/ops/seat-reconcile-handler.js";
import { createStuckImportsHandler } from "../src/ops/stuck-imports-handler.js";
import { fakeDb } from "./helpers.js";

type Logged = { level: string; message: string; data: Record<string, unknown> };

function fakeObservability() {
  const logs: Logged[] = [];
  const gauges: { metric: string; value: number; unit?: string }[] = [];
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push({ level, message, data });
  const obs: Observability = {
    region: "test-local-1",
    logger: { info: log("info"), warn: log("warn"), error: log("error") } as unknown as Observability["logger"],
    count: () => {},
    gauge: (metric, value, unit) => gauges.push({ metric, value, unit }),
    flush: () => {},
  };
  return { obs, logs, gauges };
}

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const job = (n: number, startedAt = "2026-09-26T10:00:00.000Z") => ({
  PK: `TEAM#team-${n}`,
  SK: `IMPORT#import-${n}`,
  GSI1PK: "IMPORTS#COMMITTING",
  GSI1SK: `${startedAt}#import-${n}`,
  committed: 49,
  total: 120,
});

describe("stuck-import check", () => {
  it("counts imports committing for over an hour, from the committing partition of GSI1, reading only their keys and progress", async () => {
    const queries: Record<string, unknown>[] = [];
    const pages = [
      { Items: [job(1)], LastEvaluatedKey: { PK: "TEAM#team-1" } },
      { Items: [job(2, "2026-09-26T10:30:00.000Z")] },
    ];
    const db = fakeDb(async (command) => {
      queries.push(command.input);
      return pages.shift();
    });
    const { obs, logs, gauges } = fakeObservability();
    expect(await createStuckImportsHandler({ db, obs, now: () => NOW })()).toEqual({ stuck: 2 });

    expect(gauges).toEqual([{ metric: BusinessMetric.StuckImports, value: 2, unit: undefined }]);
    const [first, second] = queries;
    expect(first).toMatchObject({
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK < :before",
      // The policy's StringEquals on dynamodb:Select fails when the request leaves it out
      Select: "SPECIFIC_ATTRIBUTES",
      ExpressionAttributeValues: { ":pk": "IMPORTS#COMMITTING", ":before": new Date(NOW - STUCK_IMPORT_AFTER_MINUTES * 60_000).toISOString() },
    });
    // The IAM policy allows exactly these names
    const names = first?.ExpressionAttributeNames as Record<string, string>;
    expect(Object.values(names).sort()).toEqual([...STUCK_IMPORT_ATTRIBUTES].sort());
    expect(String(first?.ProjectionExpression).split(", ").map((p) => names[p])).toEqual([...STUCK_IMPORT_ATTRIBUTES]);
    expect(second?.ExclusiveStartKey).toEqual({ PK: "TEAM#team-1" });

    expect(logs.filter((l) => l.level === "warn")).toEqual([
      { level: "warn", message: "Import stuck", data: { teamId: "team-1", importId: "import-1", startedAt: "2026-09-26T10:00:00.000Z", committed: 49, total: 120 } },
      { level: "warn", message: "Import stuck", data: { teamId: "team-2", importId: "import-2", startedAt: "2026-09-26T10:30:00.000Z", committed: 49, total: 120 } },
    ]);
  });

  it("sends zero when nothing is stuck, so the alarm recovers", async () => {
    const { obs, logs, gauges } = fakeObservability();
    const db = fakeDb(async () => ({}));
    expect(await createStuckImportsHandler({ db, obs })()).toEqual({ stuck: 0 });
    expect(gauges).toEqual([{ metric: BusinessMetric.StuckImports, value: 0, unit: undefined }]);
    expect(logs).toEqual([{ level: "info", message: "Checked imports", data: { stuck: 0 } }]);
  });

  it("logs a bounded number of stuck imports but counts them all", async () => {
    const { obs, logs, gauges } = fakeObservability();
    const many = Array.from({ length: MAX_LOGGED_STUCK_IMPORTS + 5 }, (_, i) => job(i));
    const db = fakeDb(async () => ({ Items: many }));
    await createStuckImportsHandler({ db, obs, now: () => NOW })();
    expect(gauges[0]?.value).toBe(many.length);
    expect(logs.filter((l) => l.level === "warn")).toHaveLength(MAX_LOGGED_STUCK_IMPORTS);
  });
});

describe("SES quota check", () => {
  it("sends the share of the 24-hour quota used as a percentage", async () => {
    const { obs, gauges, logs } = fakeObservability();
    const handler = createEmailQuotaHandler({ obs, getSendQuota: async () => ({ max24HourSend: 50_000, sentLast24Hours: 41_234 }) });
    expect(await handler()).toEqual({ usedPercent: 82.5 });
    expect(gauges).toEqual([{ metric: BusinessMetric.EmailQuotaUsedPercent, value: 82.5, unit: "Percent" }]);
    expect(logs).toEqual([{ level: "info", message: "Checked the SES quota", data: { usedPercent: 82.5, sentLast24Hours: 41_234, max24HourSend: 50_000 } }]);
  });

  it("is 0% for no sends, an unlimited quota or a missing one", () => {
    expect(quotaUsedPercent({ max24HourSend: 200, sentLast24Hours: 0 })).toBe(0);
    expect(quotaUsedPercent({ max24HourSend: -1, sentLast24Hours: 10 })).toBe(0);
    expect(quotaUsedPercent({ max24HourSend: 0, sentLast24Hours: 10 })).toBe(0);
    expect(quotaUsedPercent({ max24HourSend: 200, sentLast24Hours: 200 })).toBe(100);
    expect(quotaUsedPercent({ max24HourSend: 200, sentLast24Hours: 250 })).toBe(125);
  });

  it("fails the run when SES can't be asked, so the Lambda errors alarm sees it", async () => {
    const { obs, gauges } = fakeObservability();
    const handler = createEmailQuotaHandler({ obs, getSendQuota: async () => Promise.reject(new Error("AccessDenied")) });
    await expect(handler()).rejects.toThrow("AccessDenied");
    expect(gauges).toEqual([]);
  });
});

describe("nightly seat reconciliation (supply-checkout-l50)", () => {
  const teamItem = (n: number, extra: Record<string, unknown> = {}) => ({ PK: `TEAM#team-${n}`, SK: "META", GSI3PK: "OPS#TEAMS", GSI3SK: `team-${n}`, stripeCustomerId: `cus_${n}`, status: "active", ...extra });

  function fakeSqs(failIds: string[] = []) {
    const batches: SendMessageBatchCommand["input"][] = [];
    return {
      batches,
      sqs: {
        async send(command: SendMessageBatchCommand) {
          batches.push(command.input);
          return { Failed: (command.input.Entries ?? []).filter((e) => failIds.includes(String(e.MessageGroupId))).map((e) => ({ Id: e.Id, Code: "InternalError" })) };
        },
      },
    };
  }

  it("queues a seat check for each open team with a Stripe customer, read from the operators' index by keys, customer, closure and status only", async () => {
    const queries: Record<string, unknown>[] = [];
    const first = Array.from({ length: 11 }, (_, i) => teamItem(i + 1));
    const pages = [
      { Items: [...first, teamItem(90, { stripeCustomerId: undefined }), teamItem(91, { closedAt: "2026-09-20T00:00:00.000Z" })], LastEvaluatedKey: { PK: "TEAM#team-91" } },
      { Items: [teamItem(92, { status: "canceled" }), teamItem(12, { status: "trialing" })] },
    ];
    const db = fakeDb(async (command) => {
      queries.push(command.input);
      return pages.shift();
    });
    const { obs, logs, gauges } = fakeObservability();
    const { sqs, batches } = fakeSqs();
    expect(await createSeatReconcileHandler({ db, queueUrl: "https://sqs.example/billing.fifo", sqs, obs, now: () => NOW })()).toEqual({ queued: 12 });

    const [query, second] = queries;
    expect(query).toMatchObject({ IndexName: "GSI3", Select: "SPECIFIC_ATTRIBUTES", ExpressionAttributeValues: { ":pk": "OPS#TEAMS" } });
    const names = query?.ExpressionAttributeNames as Record<string, string>;
    expect(Object.values(names).sort()).toEqual([...SEAT_RECONCILE_ATTRIBUTES].sort());
    expect(names[String(query?.KeyConditionExpression).split(" ")[0] as string]).toBe("GSI3PK");
    expect(second?.ExclusiveStartKey).toEqual({ PK: "TEAM#team-91" });

    // Ten a batch, grouped by customer, one message per customer per day
    expect(batches.map((b) => b.Entries?.length)).toEqual([10, 2]);
    expect(batches[0]?.QueueUrl).toBe("https://sqs.example/billing.fifo");
    const entry = batches[0]?.Entries?.[0];
    expect(entry).toEqual({
      Id: "0",
      MessageBody: JSON.stringify({ kind: "seats", id: "reconcile-2026-09-26-cus_1", customer: "cus_1", reason: "reconcile", created: NOW / 1000 }),
      MessageGroupId: "cus_1",
      MessageDeduplicationId: "reconcile-2026-09-26-cus_1",
    });
    expect(batches.flatMap((b) => b.Entries ?? []).map((e) => e.MessageGroupId)).not.toContain("cus_90");
    expect(gauges).toEqual([{ metric: BusinessMetric.SeatReconcileTeams, value: 12, unit: undefined }]);
    expect(logs).toEqual([{ level: "info", message: "Seat reconciliation queued", data: { teams: 12, queued: 12, failed: 0 } }]);
  });

  it("sends zero when there's nothing to check, so the not-running alarm still sees it ran", async () => {
    const { obs, gauges } = fakeObservability();
    const { sqs, batches } = fakeSqs();
    expect(await createSeatReconcileHandler({ db: fakeDb(async () => ({})), queueUrl: "q", sqs, obs })()).toEqual({ queued: 0 });
    expect(batches).toEqual([]);
    expect(gauges).toEqual([{ metric: BusinessMetric.SeatReconcileTeams, value: 0, unit: undefined }]);
  });

  it("queues the rest when some aren't taken, then fails the run, naming the teams by ID only", async () => {
    const db = fakeDb(async () => ({ Items: [teamItem(1), teamItem(2), teamItem(3)] }));
    const { obs, logs, gauges } = fakeObservability();
    const { sqs } = fakeSqs(["cus_2"]);
    await expect(createSeatReconcileHandler({ db, queueUrl: "q", sqs, obs, now: () => NOW })()).rejects.toThrow("1 seat reconciliation messages weren't queued (InternalError)");
    expect(gauges).toEqual([{ metric: BusinessMetric.SeatReconcileTeams, value: 2, unit: undefined }]);
    expect(logs.filter((l) => l.level === "warn")).toEqual([{ level: "warn", message: "Seat reconciliation not queued", data: { teamId: "team-2", code: "InternalError" } }]);
  });
});
