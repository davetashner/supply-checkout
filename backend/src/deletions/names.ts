// Names the deletion records and the CDK app share (infra/lib/stacks/data-stack.ts,
// api-stack.ts and observability/ops-checks.ts import this file), so the bucket,
// the grants and the writers can't drift apart. No imports.
//
// A deletion record says that a user's account or a team was deleted, by ID
// only, so a restore from a backup taken before the deletion can delete it
// again (docs/backups.md, "Re-apply deletions"). Records outlive every backup.

/**
 * How long a record is kept, under S3 Object Lock. Longer than the longest
 * any backup of the table can be kept: the vault locks' 365-day maximum
 * (infra/lib/backup.ts, COPY_LOCK and WORKLOAD_LOCK), plus a margin. Today's
 * backups are kept 35 and 90 days.
 */
export const DELETION_RECORD_RETENTION_DAYS = 400;

/** The primary region's bucket of deletion records. The account ID makes the name globally unique. */
export function deletionsBucketName(envName: string, region: string, account: string): string {
  return `supply-checkout-${envName}-deletions-${region}-${account}`;
}

/** Where each kind of record goes: `users/<userId>.json` and `teams/<teamId>.json`. */
export const DELETION_PREFIXES = { user: "users/", team: "teams/" } as const;

/** Environment variables the writers read. */
export const DELETIONS_ENV = {
  /** The bucket (deletionsBucketName). */
  bucket: "DELETIONS_BUCKET",
  /** The bucket's region: the primary region, wherever the writer runs. */
  region: "DELETIONS_REGION",
} as const;
