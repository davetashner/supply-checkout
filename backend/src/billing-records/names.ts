// Names the billing records and the CDK app share (infra/lib/stacks/data-stack.ts,
// infra/lib/billing-records.ts and observability/ops-checks.ts import this file), so
// the bucket, the grant and the writer can't drift apart. No imports.
//
// A billing record is a purged team's invoices (amounts, tax and dates, no card data,
// no name or email), kept under S3 Object Lock so the 7 years the privacy policy
// promises for tax and accounting records are enforced, not hoped for (supply-checkout-ijt7).

/**
 * How long a record is kept, under compliance-mode Object Lock: 7 years, counting
 * a leap day in each (7 x 366), so it is never shorter than 7 calendar years.
 */
export const BILLING_RECORD_RETENTION_DAYS = 2562;

/** The primary region's bucket of billing records. The account ID makes the name globally unique. */
export function billingRecordsBucketName(envName: string, region: string, account: string): string {
  return `supply-checkout-${envName}-billing-records-${region}-${account}`;
}

/** Where a team's record goes: `teams/<teamId>.json`. */
export const BILLING_RECORD_PREFIX = "teams/";

/** Environment variables the writer reads. */
export const BILLING_RECORDS_ENV = {
  /** The bucket (billingRecordsBucketName). */
  bucket: "BILLING_RECORDS_BUCKET",
  /** The bucket's region: the primary region, wherever the writer runs. */
  region: "BILLING_RECORDS_REGION",
} as const;
