// The deletion records watch (supply-checkout-72d.16), in the primary region
// with the deletion records bucket.
//
// A record is written once: the writers may only PutObject with If-None-Match
// (infra/lib/deletions.ts), so a second write to the same key fails. Object
// Lock keeps every version, so nothing is lost when a record is written over
// or hidden behind a delete marker, but the restore would only find out when
// it runs. This finds out at once. The bucket sends its events to EventBridge,
// and a rule (infra/lib/observability/deletion-records-watch.ts) passes this
// function the bucket's Object Created events and its Object Deleted events
// other than lifecycle expirations. Each of these counts in
// DeletionRecordRewrites, which alarms P2 ("Deletion record rewritten"):
//
// - a deletion (a delete marker, or a version deleted) that the lifecycle
//   rule didn't make;
// - a write to a key that isn't a record's (`users/<id>.json` or
//   `teams/<id>.json`): nothing in the app writes one;
// - a write to a record's key that now has more than one version or a delete
//   marker. S3's events don't say whether a write replaced an object, so the
//   function lists the key's versions.
//
// It logs the kind of record, the S3 version ID and request ID (the server
// access log has the request, with who made it), never the key's ID.

import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import type { EventBridgeEvent } from "aws-lambda";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { DELETION_PREFIXES, LIFECYCLE_EXPIRATION } from "./names.js";

/** The S3 call this module makes; an S3Client, or a fake in tests. */
export interface S3VersionLister {
  send(command: ListObjectVersionsCommand): Promise<unknown>;
}

/** The parts of an S3 event (EventBridge) this reads. */
export interface S3ObjectEventDetail {
  readonly bucket?: { readonly name?: string };
  readonly object?: { readonly key?: string; readonly "version-id"?: string };
  readonly reason?: string;
  readonly "deletion-type"?: string;
  readonly "request-id"?: string;
}

export type S3ObjectEvent = EventBridgeEvent<string, S3ObjectEventDetail>;

export type WatchOutcome = "first-write" | "rewritten" | "unexpected-key" | "deleted" | "expired" | "ignored";

/** Outcomes that count in DeletionRecordRewrites. */
export const REWRITE_OUTCOMES: readonly WatchOutcome[] = ["rewritten", "unexpected-key", "deleted"];

const PREFIXES = Object.values(DELETION_PREFIXES).map((p) => p.replace(/\/$/, "")).join("|");
const RECORD_KEY = new RegExp(`^(${PREFIXES})/[A-Za-z0-9_-]{1,128}\\.json$`);
const LOGGABLE = /^[A-Za-z0-9._+= -]{1,1024}$/;

/** The key is a record's, `users/<id>.json` or `teams/<id>.json`. */
export function isRecordKey(key: unknown): key is string {
  return typeof key === "string" && RECORD_KEY.test(key);
}

/** Which kind of record a key is for, without its ID. */
function kindOf(key: unknown): string {
  if (typeof key !== "string") return "(none)";
  const prefix = Object.values(DELETION_PREFIXES).find((p) => key.startsWith(p));
  return prefix ? prefix.slice(0, -1) : "(other)";
}

function loggable(value: unknown): string {
  return typeof value === "string" && LOGGABLE.test(value) ? value : "(unexpected)";
}

export interface DeletionRecordsWatchDeps {
  readonly obs: Observability;
  readonly s3: S3VersionLister;
  /** The deletion records bucket; an event for any other bucket is an error. */
  readonly bucket: string;
}

/** How many versions and delete markers the key has (at most a few: it's listed with a small MaxKeys). */
async function versionsOf(s3: S3VersionLister, bucket: string, key: string): Promise<number> {
  const page = (await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: 10 }))) as {
    Versions?: { Key?: string }[];
    DeleteMarkers?: { Key?: string }[];
  };
  return [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].filter((v) => v.Key === key).length;
}

export function createDeletionRecordsWatchHandler(deps: DeletionRecordsWatchDeps) {
  const { obs, s3, bucket } = deps;
  return async (event: S3ObjectEvent): Promise<{ outcome: WatchOutcome }> => {
    const detail = event.detail ?? {};
    if (detail.bucket?.name !== bucket) throw new Error("An event for another bucket reached the deletion records watch");
    const key = detail.object?.key;
    let outcome: WatchOutcome;
    let versions: number | undefined;
    if (event["detail-type"] === "Object Deleted") {
      outcome = detail.reason === LIFECYCLE_EXPIRATION ? "expired" : "deleted";
    } else if (event["detail-type"] === "Object Created") {
      if (!isRecordKey(key)) outcome = "unexpected-key";
      else {
        versions = await versionsOf(s3, bucket, key);
        outcome = versions > 1 ? "rewritten" : "first-write";
      }
    } else {
      outcome = "ignored";
    }
    if (REWRITE_OUTCOMES.includes(outcome)) {
      obs.logger.error("Deletion record rewritten", {
        outcome,
        event: loggable(event["detail-type"]),
        kind: kindOf(key),
        versionId: loggable(detail.object?.["version-id"]),
        requestId: loggable(detail["request-id"]),
        reason: loggable(detail.reason),
        deletionType: loggable(detail["deletion-type"]),
        ...(versions === undefined ? {} : { versions }),
      });
      obs.count(BusinessMetric.DeletionRecordRewrites);
    }
    return { outcome };
  };
}
