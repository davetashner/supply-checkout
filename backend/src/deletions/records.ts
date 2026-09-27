// Deletion records (supply-checkout-0ic7): one small S3 object per deleted
// account or team, holding IDs and a time only, never emails, names or team
// data. Deleted data lives on in the table's backups (35 days of PITR and
// daily backups, 90 days of copies, docs/backups.md), and the purge also
// deletes a team's audit trail, so after a restore nothing in the table says
// what had been deleted since. These records do, for longer than any backup
// is kept (DELETION_RECORD_RETENTION_DAYS, under Object Lock), and the
// re-apply script (scripts/restore.ts) deletes them again from a restored
// table before it goes back into service.
//
// Writers: the account API, once a deleting user has left every team and
// before their rows and Cognito user go (api/account-handler.ts), and the
// team purge, before it deletes anything (ops/team-purge-handler.ts). Each
// may write only its own prefix (infra). A record is written once: a retry
// finds it there (If-None-Match) and keeps the first.

import { GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DELETION_PREFIXES, DELETIONS_ENV } from "./names.js";

export type DeletionKind = keyof typeof DELETION_PREFIXES;

export interface DeletionRecord {
  readonly kind: DeletionKind;
  /** The user's `sub` or the team's ID. */
  readonly id: string;
  /** When it was deleted (ISO 8601). */
  readonly deletedAt: string;
  /** A user's only: the teams they were alone in, which their deletion closed (the purge deletes them later). */
  readonly teamsClosed?: readonly string[];
}

/** Writes deletion records. */
export interface DeletionLog {
  record(record: DeletionRecord): Promise<void>;
}

/** The S3 calls this module makes; an S3Client, or a fake in tests. */
export interface S3Like {
  send(command: PutObjectCommand | ListObjectVersionsCommand | GetObjectCommand): Promise<unknown>;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** The most closed teams one record lists: a user is in at most a few hundred teams. */
const MAX_TEAMS_CLOSED = 1000;

/** The object key for a record: `users/<id>.json` or `teams/<id>.json`. */
export function deletionKey(kind: DeletionKind, id: string): string {
  if (!(kind in DELETION_PREFIXES)) throw new Error("Unknown deletion kind");
  if (typeof id !== "string" || !ID.test(id)) throw new Error("Invalid ID in a deletion record");
  return `${DELETION_PREFIXES[kind]}${id}.json`;
}

/** The record, checked: known kind, IDs that are IDs, an ISO time. Throws on anything else. */
export function validRecord(value: unknown): DeletionRecord {
  const r = value as Partial<DeletionRecord> | null;
  if (!r || typeof r !== "object") throw new Error("Not a deletion record");
  const key = deletionKey(r.kind as DeletionKind, r.id as string);
  if (typeof r.deletedAt !== "string" || !ISO.test(r.deletedAt)) throw new Error(`Invalid deletedAt in ${key}`);
  if (r.teamsClosed !== undefined) {
    if (r.kind !== "user" || !Array.isArray(r.teamsClosed) || r.teamsClosed.length > MAX_TEAMS_CLOSED || !r.teamsClosed.every((t) => typeof t === "string" && ID.test(t))) {
      throw new Error(`Invalid teamsClosed in ${key}`);
    }
  }
  return { kind: r.kind as DeletionKind, id: r.id as string, deletedAt: r.deletedAt, ...(r.teamsClosed?.length ? { teamsClosed: [...r.teamsClosed] } : {}) };
}

const errorName = (error: unknown) => (error as { name?: string } | null)?.name;

/** A DeletionLog writing to the bucket. */
export function s3DeletionLog(options: { readonly bucket: string; readonly s3: S3Like }): DeletionLog {
  return {
    async record(input) {
      const record = validRecord(input);
      try {
        await options.s3.send(
          new PutObjectCommand({
            Bucket: options.bucket,
            Key: deletionKey(record.kind, record.id),
            Body: JSON.stringify(record),
            ContentType: "application/json",
            // Written once: a retry keeps the first record and its time
            IfNoneMatch: "*",
          }),
        );
      } catch (error) {
        if (errorName(error) !== "PreconditionFailed") throw error;
      }
    },
  };
}

/** The deletion log for a Lambda: DELETIONS_BUCKET, in DELETIONS_REGION. Fails closed when either isn't set. */
export function deletionLogFromEnv(env: NodeJS.ProcessEnv = process.env): DeletionLog {
  const bucket = env[DELETIONS_ENV.bucket];
  const region = env[DELETIONS_ENV.region];
  if (!bucket || !region) throw new Error(`${DELETIONS_ENV.bucket} and ${DELETIONS_ENV.region} must be set`);
  return s3DeletionLog({ bucket, s3: new S3Client({ region }) });
}

export interface ReadResult {
  /** One per key: every valid version of it merged (the earliest deletedAt, every closed team any version lists). */
  readonly records: DeletionRecord[];
  /**
   * Versions that aren't a valid record, don't match their key, or (with
   * `before`) have no time to check: left for a person to look at. Only the
   * key and S3's version ID, never the contents.
   */
  readonly invalid: { readonly key: string; readonly versionId: string }[];
  /** Keys with more than one version. Records are written once, so each is worth a look. */
  readonly rewritten: number;
  /** Delete markers. No writer may delete a record, so each is worth a look. */
  readonly deleteMarkers: number;
  /** Versions written at or after `before`, left out. */
  readonly ignored: number;
}

interface VersionsPage {
  Versions?: { Key?: string; VersionId?: string; LastModified?: Date }[];
  DeleteMarkers?: unknown[];
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextVersionIdMarker?: string;
}

/**
 * Every version of every record in the bucket, users and teams, in key order,
 * not only the current ones: Object Lock keeps each version, so a record
 * overwritten with junk, or hidden by a delete marker, still counts. Any valid
 * version of a key is a deletion. `before` leaves out versions written (S3's
 * LastModified) at or after it, for a restore after a suspected compromise of
 * a writer.
 */
export async function readDeletionRecords(s3: S3Like, bucket: string, options: { readonly before?: Date } = {}): Promise<ReadResult> {
  const byKey = new Map<string, DeletionRecord>();
  const versions = new Map<string, number>();
  const invalid: { key: string; versionId: string }[] = [];
  let deleteMarkers = 0;
  let ignored = 0;
  for (const [kind, prefix] of Object.entries(DELETION_PREFIXES) as [DeletionKind, string][]) {
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    let more = true;
    while (more) {
      const page = (await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker, VersionIdMarker }))) as VersionsPage;
      deleteMarkers += page.DeleteMarkers?.length ?? 0;
      for (const { Key, VersionId, LastModified } of page.Versions ?? []) {
        if (!Key) continue;
        // An unversioned object's version ID is "null"
        const versionId = VersionId ?? "null";
        versions.set(Key, (versions.get(Key) ?? 0) + 1);
        if (options.before) {
          if (!(LastModified instanceof Date) || Number.isNaN(LastModified.getTime())) {
            invalid.push({ key: Key, versionId });
            continue;
          }
          if (LastModified.getTime() >= options.before.getTime()) {
            ignored++;
            continue;
          }
        }
        // A failed read fails the whole listing: a record missed is a deletion not re-applied
        const object = (await s3.send(new GetObjectCommand({ Bucket: bucket, Key, VersionId: versionId }))) as { Body?: { transformToString(): Promise<string> } };
        const body = (await object.Body?.transformToString()) ?? "";
        let record: DeletionRecord;
        try {
          record = validRecord(JSON.parse(body));
          if (record.kind !== kind || deletionKey(kind, record.id) !== Key) throw new Error("Doesn't match its key");
        } catch {
          invalid.push({ key: Key, versionId });
          continue;
        }
        const seen = byKey.get(Key);
        byKey.set(Key, seen ? merge(seen, record) : record);
      }
      more = Boolean(page.IsTruncated);
      KeyMarker = page.NextKeyMarker;
      VersionIdMarker = page.NextVersionIdMarker;
      // A truncated page with no marker would list the same page forever
      if (more && !KeyMarker) throw new Error("ListObjectVersions was truncated without a marker");
    }
  }
  // Users then teams, each in S3's (byte) order
  const order = [...byKey.keys()].sort((a, b) => kindOrder(a) - kindOrder(b) || (a < b ? -1 : 1));
  return {
    records: order.map((key) => byKey.get(key) as DeletionRecord),
    invalid,
    rewritten: [...versions.values()].filter((n) => n > 1).length,
    deleteMarkers,
    ignored,
  };
}

const PREFIX_ORDER = Object.values(DELETION_PREFIXES);
const kindOrder = (key: string) => PREFIX_ORDER.findIndex((p) => key.startsWith(p));

/** Two valid versions of one key: the earlier time (a survivor is judged from the first deletion), and every closed team either lists. */
function merge(a: DeletionRecord, b: DeletionRecord): DeletionRecord {
  const teamsClosed = [...new Set([...(a.teamsClosed ?? []), ...(b.teamsClosed ?? [])])].sort();
  const deletedAt = Date.parse(b.deletedAt) < Date.parse(a.deletedAt) ? b.deletedAt : a.deletedAt;
  return { kind: a.kind, id: a.id, deletedAt, ...(teamsClosed.length ? { teamsClosed } : {}) };
}
