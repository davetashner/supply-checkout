// The deletion records watch (supply-checkout-72d.16): a record written over,
// deleted or hidden behind a delete marker, or an object that isn't a record,
// counts in DeletionRecordRewrites.

import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createDeletionRecordsWatchHandler, isRecordKey, type S3ObjectEvent, type S3ObjectEventDetail } from "../src/deletions/watch-handler.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";

const BUCKET = "supply-checkout-test-deletions-test-local-1-000000000000";
const USER_KEY = "users/user-sub-1.json";

function event(detailType: string, detail: S3ObjectEventDetail = {}): S3ObjectEvent {
  return {
    id: "event-1",
    version: "0",
    account: "000000000000",
    time: "2026-09-27T12:00:00Z",
    region: "test-local-1",
    resources: [],
    source: "aws.s3",
    "detail-type": detailType,
    detail: { bucket: { name: BUCKET }, object: { key: USER_KEY, "version-id": "v2.abc" }, "request-id": "REQ123", reason: "PutObject", ...detail },
  };
}

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

/** A fake S3 that answers ListObjectVersions with the given page. */
function fakeS3(page: { Versions?: { Key?: string }[]; DeleteMarkers?: { Key?: string }[] } = {}) {
  const calls: ListObjectVersionsCommand[] = [];
  return {
    calls,
    s3: {
      async send(command: ListObjectVersionsCommand) {
        calls.push(command);
        return page;
      },
    },
  };
}

function setup(page?: Parameters<typeof fakeS3>[0]) {
  const { obs, logs, counts } = fakeObservability();
  const { s3, calls } = fakeS3(page);
  return { handler: createDeletionRecordsWatchHandler({ obs, s3, bucket: BUCKET }), logs, counts, calls };
}

describe("deletion records watch", () => {
  it("knows a record's key", () => {
    expect(isRecordKey("users/abc_DEF-1.json")).toBe(true);
    expect(isRecordKey("teams/team-1.json")).toBe(true);
    for (const bad of ["users/abc.txt", "users/a/b.json", "junk.json", "teams/.json", "other/abc.json", `users/${"a".repeat(129)}.json`, 7, undefined]) {
      expect(isRecordKey(bad), String(bad)).toBe(false);
    }
  });

  it("lets a record's first write through, after checking its versions", async () => {
    const { handler, logs, counts, calls } = setup({ Versions: [{ Key: USER_KEY }, { Key: "users/user-sub-1.jsonx" }] });
    expect(await handler(event("Object Created"))).toEqual({ outcome: "first-write" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ Bucket: BUCKET, Prefix: USER_KEY, MaxKeys: 10 });
    expect(counts).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("counts a write to a record that already had a version or a delete marker", async () => {
    for (const page of [{ Versions: [{ Key: USER_KEY }, { Key: USER_KEY }] }, { Versions: [{ Key: USER_KEY }], DeleteMarkers: [{ Key: USER_KEY }] }]) {
      const { handler, logs, counts } = setup(page);
      expect(await handler(event("Object Created"))).toEqual({ outcome: "rewritten" });
      expect(counts).toEqual([{ metric: BusinessMetric.DeletionRecordRewrites, value: undefined }]);
      expect(logs).toEqual([
        {
          level: "error",
          message: "Deletion record rewritten",
          data: { outcome: "rewritten", event: "Object Created", kind: "users", versionId: "v2.abc", requestId: "REQ123", reason: "PutObject", deletionType: "(unexpected)", versions: 2 },
        },
      ]);
      // Never the ID in the key
      expect(JSON.stringify(logs)).not.toContain("user-sub-1");
    }
  });

  it("counts a write to a key that isn't a record's, without listing it", async () => {
    const { handler, logs, counts, calls } = setup();
    expect(await handler(event("Object Created", { object: { key: "junk/<script>", "version-id": "<bad>" }, "request-id": undefined }))).toEqual({ outcome: "unexpected-key" });
    expect(calls).toEqual([]);
    expect(counts).toHaveLength(1);
    expect(logs[0]?.data).toEqual({ outcome: "unexpected-key", event: "Object Created", kind: "(other)", versionId: "(unexpected)", requestId: "(unexpected)", reason: "PutObject", deletionType: "(unexpected)" });
    const noKey = setup();
    expect(await noKey.handler(event("Object Created", { object: {} }))).toEqual({ outcome: "unexpected-key" });
    expect(noKey.logs[0]?.data.kind).toBe("(none)");
  });

  it("counts a delete marker or a deleted version, but not the lifecycle rule's expirations", async () => {
    const marker = setup();
    expect(await marker.handler(event("Object Deleted", { object: { key: "teams/team-1.json" }, reason: "DeleteObject", "deletion-type": "Delete Marker Created" }))).toEqual({ outcome: "deleted" });
    expect(marker.counts).toHaveLength(1);
    expect(marker.logs[0]?.data).toMatchObject({ outcome: "deleted", kind: "teams", deletionType: "Delete Marker Created" });
    expect(marker.calls).toEqual([]);
    const permanent = setup();
    expect(await permanent.handler(event("Object Deleted", { reason: "DeleteObject", "deletion-type": "Permanently Deleted" }))).toEqual({ outcome: "deleted" });
    const expired = setup();
    expect(await expired.handler(event("Object Deleted", { reason: "Lifecycle Expiration", "deletion-type": "Delete Marker Created" }))).toEqual({ outcome: "expired" });
    expect(expired.counts).toEqual([]);
    expect(expired.logs).toEqual([]);
  });

  it("ignores other S3 events", async () => {
    const { handler, counts, calls } = setup();
    expect(await handler(event("Object Tags Added"))).toEqual({ outcome: "ignored" });
    expect(counts).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("fails on an event for another bucket, or with no detail, so the failing alarm sees a misrouted rule", async () => {
    const { handler, counts } = setup();
    await expect(handler(event("Object Created", { bucket: { name: "someone-elses" } }))).rejects.toThrow(/another bucket/);
    await expect(handler({ ...event("Object Created"), detail: undefined } as unknown as S3ObjectEvent)).rejects.toThrow(/another bucket/);
    expect(counts).toEqual([]);
  });

  it("fails when the versions can't be listed, rather than letting a write through unchecked", async () => {
    const { obs, counts } = fakeObservability();
    const handler = createDeletionRecordsWatchHandler({ obs, bucket: BUCKET, s3: { send: () => Promise.reject(new Error("AccessDenied")) } });
    await expect(handler(event("Object Created"))).rejects.toThrow("AccessDenied");
    expect(counts).toEqual([]);
    // An empty listing is one version at most
    const empty = setup({});
    expect(await empty.handler(event("Object Created"))).toEqual({ outcome: "first-write" });
  });
});
