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

import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
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
  send(command: PutObjectCommand | ListObjectsV2Command | GetObjectCommand): Promise<unknown>;
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
  readonly records: DeletionRecord[];
  /** Keys whose object isn't a valid record, or doesn't match its key: left for a person to look at. */
  readonly invalid: string[];
}

/** Every record in the bucket, users and teams, in key order. */
export async function readDeletionRecords(s3: S3Like, bucket: string): Promise<ReadResult> {
  const records: DeletionRecord[] = [];
  const invalid: string[] = [];
  for (const [kind, prefix] of Object.entries(DELETION_PREFIXES) as [DeletionKind, string][]) {
    let ContinuationToken: string | undefined;
    do {
      const page = (await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }))) as {
        Contents?: { Key?: string }[];
        NextContinuationToken?: string;
      };
      for (const { Key } of page.Contents ?? []) {
        if (!Key) continue;
        // A failed read fails the whole listing: a record missed is a deletion not re-applied
        const object = (await s3.send(new GetObjectCommand({ Bucket: bucket, Key }))) as { Body?: { transformToString(): Promise<string> } };
        const body = (await object.Body?.transformToString()) ?? "";
        try {
          const record = validRecord(JSON.parse(body));
          if (record.kind !== kind || deletionKey(kind, record.id) !== Key) throw new Error("Doesn't match its key");
          records.push(record);
        } catch {
          invalid.push(Key);
        }
      }
      ContinuationToken = page.NextContinuationToken;
    } while (ContinuationToken);
  }
  return { records, invalid };
}
