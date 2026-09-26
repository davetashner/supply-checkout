// Names shared by the Lambda code and the CDK app (infra/lib/observability),
// so the metrics the code sends and the ones the dashboard and alarms read
// can't drift apart. No dependencies: infra imports this file directly.

/** CloudWatch namespace for every business metric. */
export const METRICS_NAMESPACE = "SupplyCheckout";

/**
 * The only dimension on business metrics. Its value is the Lambda's region, so
 * metrics split cleanly by region once the second region is added (ADR 0010). Keep the
 * dimension set this small: every extra dimension value is a separate metric,
 * billed separately. Per-team detail goes in metadata (searchable in Logs
 * Insights), never in a dimension.
 */
export const REGION_DIMENSION = "Region";

/**
 * Business metrics, from docs/journeys.md ("Business metrics the app must
 * publish"). Each is a count, sent with count().
 */
export const BusinessMetric = {
  /** Items checked out to a sheet (J4). */
  Checkouts: "Checkouts",
  /** Items returned to storage from a sheet (J4). */
  Returns: "Returns",
  /** Writes to team data through the API: the denominator for ConditionalWriteConflicts. */
  Writes: "Writes",
  /** Writes rejected because the item changed since it was read (409 responses, J4). */
  ConditionalWriteConflicts: "ConditionalWriteConflicts",
  /** Change events the stream consumer tried to publish to team channels: the denominator for LiveUpdateFailures (J4). */
  LiveUpdates: "LiveUpdates",
  /** Change events that didn't go out on the first try; the batch is retried (J4). */
  LiveUpdateFailures: "LiveUpdateFailures",
  /** Receipt reads attempted, not counting cancels, limit hits and unreadable photos (J5). */
  ReceiptReads: "ReceiptReads",
  /** Receipt reads that failed on our side or Bedrock's (J5). */
  ReceiptReadFailures: "ReceiptReadFailures",
  /** Model tokens used reading receipts; the team ID goes in metadata (J5). */
  ReceiptTokens: "ReceiptTokens",
  /** New teams created by sign-up (J1). */
  SignUps: "SignUps",
  /** Invitations sent (J3). */
  InvitesSent: "InvitesSent",
  /** Invitations accepted (J3). */
  InvitesAccepted: "InvitesAccepted",
  /** Our API failing to create a Stripe Checkout session (J7). */
  CheckoutSessionErrors: "CheckoutSessionErrors",
  /** Stripe webhooks rejected for a bad signature (J7). */
  WebhookSignatureFailures: "WebhookSignatureFailures",
} as const;

export type BusinessMetricName = (typeof BusinessMetric)[keyof typeof BusinessMetric];

/**
 * Environment variables the CDK app sets on every Lambda function
 * (infra/lib/observability/defaults.ts) and this module reads.
 */
export const ENV = {
  service: "POWERTOOLS_SERVICE_NAME",
  namespace: "POWERTOOLS_METRICS_NAMESPACE",
  logLevel: "POWERTOOLS_LOG_LEVEL",
  envName: "SUPPLY_CHECKOUT_ENV",
} as const;
