// The operator audit watch (supply-checkout-6uw.5): every change or deletion
// of an OPAUDIT# item, other than its TTL expiry, counts as tampering.

import type { DynamoDBRecord } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { createOperatorAuditWatchHandler, isExpiry, isTampering } from "../src/ops/operator-audit-watch-handler.js";

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const LATER = Math.floor(NOW / 1000) + 3600;
const EARLIER = Math.floor(NOW / 1000) - 60;

function record(eventName: "INSERT" | "MODIFY" | "REMOVE", pk: string, extra: Partial<DynamoDBRecord> & { expiresAt?: number } = {}): DynamoDBRecord {
  const { expiresAt, ...rest } = extra;
  const keys = { PK: { S: pk }, SK: { S: "AUDIT#2026-09-27T11:00:00.000Z#evt-1" } };
  return {
    eventID: "stream-event-1",
    eventName,
    awsRegion: "test-local-1",
    dynamodb: {
      Keys: keys,
      ...(eventName === "INSERT" ? {} : { OldImage: { ...keys, reason: { S: "a secret reason" }, operatorSub: { S: "operator-sub" }, ...(expiresAt === undefined ? {} : { expiresAt: { N: String(expiresAt) } }) } }),
    },
    ...rest,
  };
}

const TTL = { userIdentity: { type: "Service", principalId: "dynamodb.amazonaws.com" } };

function fakeObservability() {
  const logs: { level: string; message: string; data: Record<string, unknown> }[] = [];
  const counts: { metric: string; value?: number }[] = [];
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push({ level, message, data });
  const obs: Observability = {
    region: "test-local-1",
    logger: { info: log("info"), warn: log("warn"), error: log("error") } as unknown as Observability["logger"],
    count: (metric, value) => counts.push({ metric, value }),
    gauge: () => {},
    flush: () => {},
  };
  return { obs, logs, counts };
}

describe("operator audit watch", () => {
  it("counts a MODIFY of an audit item or an idempotency record as tampering, whatever it changed", () => {
    expect(isTampering(record("MODIFY", "OPAUDIT#team-1", { expiresAt: LATER }), NOW)).toBe(true);
    expect(isTampering(record("MODIFY", "OPAUDIT#PLATFORM", { expiresAt: EARLIER }), NOW)).toBe(true);
    // Even one that looks like it came from TTL: TTL never modifies
    expect(isTampering(record("MODIFY", "OPAUDIT#team-1", { ...TTL, expiresAt: EARLIER }), NOW)).toBe(true);
  });

  it("counts a REMOVE of a live item as tampering, with or without an expiry on it", () => {
    expect(isTampering(record("REMOVE", "OPAUDIT#team-1", { expiresAt: LATER }), NOW)).toBe(true);
    expect(isTampering(record("REMOVE", "OPAUDIT#team-1"), NOW)).toBe(true);
    expect(isTampering(record("REMOVE", "OPAUDIT#team-1", { expiresAt: 0 }), NOW)).toBe(true);
    // Someone else's identity isn't TTL's
    expect(isTampering(record("REMOVE", "OPAUDIT#team-1", { userIdentity: { type: "Service", principalId: "someone.amazonaws.com" }, expiresAt: LATER }), NOW)).toBe(true);
    expect(isTampering(record("REMOVE", "OPAUDIT#team-1", { userIdentity: { type: "User", principalId: "dynamodb.amazonaws.com" }, expiresAt: LATER }), NOW)).toBe(true);
  });

  it("leaves out TTL deletions, and deletions of items already past their expiry (another replica's TTL)", () => {
    expect(isExpiry(record("REMOVE", "OPAUDIT#team-1", { ...TTL, expiresAt: LATER }), NOW)).toBe(true);
    expect(isTampering(record("REMOVE", "OPAUDIT#team-1", { ...TTL }), NOW)).toBe(false);
    expect(isTampering(record("REMOVE", "OPAUDIT#team-1", { expiresAt: EARLIER }), NOW)).toBe(false);
    expect(isTampering(record("REMOVE", "OPAUDIT#team-1", { expiresAt: Math.floor(NOW / 1000) }), NOW)).toBe(false);
    expect(isExpiry(record("MODIFY", "OPAUDIT#team-1", { ...TTL, expiresAt: EARLIER }), NOW)).toBe(false);
  });

  it("ignores inserts and every other partition", () => {
    expect(isTampering(record("INSERT", "OPAUDIT#team-1"), NOW)).toBe(false);
    expect(isTampering(record("MODIFY", "TEAM#team-1"), NOW)).toBe(false);
    expect(isTampering(record("REMOVE", "TEAM#OPAUDIT#x"), NOW)).toBe(false);
    expect(isTampering({ eventName: "MODIFY" } as DynamoDBRecord, NOW)).toBe(false);
    expect(isTampering({ eventName: "MODIFY", dynamodb: { Keys: { PK: { N: "1" } } } } as DynamoDBRecord, NOW)).toBe(false);
  });

  it("counts the batch's tampering in OperatorAuditChanged and logs each by its keys, never its attributes", async () => {
    const { obs, logs, counts } = fakeObservability();
    const handler = createOperatorAuditWatchHandler({ obs, now: () => NOW });
    const odd = record("REMOVE", "OPAUDIT#team-2", { expiresAt: LATER });
    (odd.dynamodb as { Keys: Record<string, unknown> }).Keys.SK = { S: "AUDIT#<script>" };
    delete (odd as { eventID?: string }).eventID;
    const result = await handler({
      Records: [record("MODIFY", "OPAUDIT#team-1", { expiresAt: LATER }), record("REMOVE", "OPAUDIT#team-1", { ...TTL, expiresAt: EARLIER }), record("INSERT", "OPAUDIT#team-1"), odd],
    });
    expect(result).toEqual({ changed: 2 });
    expect(counts).toEqual([{ metric: BusinessMetric.OperatorAuditChanged, value: 2 }]);
    expect(logs).toEqual([
      { level: "error", message: "Operator audit item changed", data: { eventName: "MODIFY", pk: "OPAUDIT#team-1", sk: "AUDIT#2026-09-27T11:00:00.000Z#evt-1", eventId: "stream-event-1", region: "test-local-1" } },
      { level: "error", message: "Operator audit item changed", data: { eventName: "REMOVE", pk: "OPAUDIT#team-2", sk: "(unexpected key)", eventId: "(unexpected key)", region: "test-local-1" } },
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/secret reason|operator-sub/);
  });

  it("sends nothing for a batch with no tampering, and copes with an empty event", async () => {
    const { obs, logs, counts } = fakeObservability();
    const handler = createOperatorAuditWatchHandler({ obs });
    expect(await handler({ Records: [record("REMOVE", "OPAUDIT#team-1", { ...TTL })] })).toEqual({ changed: 0 });
    expect(await handler({} as never)).toEqual({ changed: 0 });
    expect(counts).toEqual([]);
    expect(logs).toEqual([]);
  });
});
