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
 * publish"). Each is a count, sent with count(), except the gauges at the
 * end (a level measured by a scheduled check), sent with gauge().
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
  /** Change events the stream consumer's publish budget stopped short of; sent by a later invocation, not failures (J4). */
  LiveUpdatesDeferred: "LiveUpdatesDeferred",
  /** Receipt reads attempted, not counting cancels, limit hits and unreadable photos (J5). */
  ReceiptReads: "ReceiptReads",
  /** Receipt reads that failed on our side or Bedrock's (J5). */
  ReceiptReadFailures: "ReceiptReadFailures",
  /** Units a receipt's lines added to existing sheets, bought for the client rather than taken from storage (J5). */
  ReceiptLines: "ReceiptLines",
  /** Model tokens used reading receipts; the team ID goes in metadata (J5). */
  ReceiptTokens: "ReceiptTokens",
  /** New teams created by sign-up (J1). */
  SignUps: "SignUps",
  /** Invitations sent (J3). */
  InvitesSent: "InvitesSent",
  /** Invitations accepted (J3). */
  InvitesAccepted: "InvitesAccepted",
  /** Invitations marked failed because their email bounced or drew a complaint (J3). */
  InvitesFailed: "InvitesFailed",
  /** Recipients SES reported as bounced, any message kind; the kind goes in metadata. */
  EmailBounces: "EmailBounces",
  /** Recipients who marked a message as spam, any message kind. */
  EmailComplaints: "EmailComplaints",
  /** Our API failing to create a Stripe Checkout session (J7). */
  CheckoutSessionErrors: "CheckoutSessionErrors",
  /** Our API failing to open the Stripe Customer Portal for an owner (J7, J8). */
  BillingPortalErrors: "BillingPortalErrors",
  /** Stripe webhooks rejected for a bad signature (J7). */
  WebhookSignatureFailures: "WebhookSignatureFailures",
  /** Stripe events the billing worker applied to a team's plan, seats and status (J7, J8). */
  BillingEventsApplied: "BillingEventsApplied",
  /** Owners emailed about their billing: a trial ending, a failed payment, or the team turning read-only (J7, J8). */
  BillingNotices: "BillingNotices",
  /** Owners who should have had a billing email and didn't (SES refused it, or no address on file) (J7, J8). */
  BillingNoticeFailures: "BillingNoticeFailures",
  /** Subscription seat quantities the billing worker changed to match the team's billed members (supply-checkout-l50); the reason goes in metadata (J7). */
  SeatQuantityUpdates: "SeatQuantityUpdates",
  /** Teams the nightly seat reconciliation found billed for a different number of seats than they have billed members: the event-driven sync missed them (J7). */
  SeatQuantityDrift: "SeatQuantityDrift",
  /** Membership changes whose seat sync couldn't be queued; the nightly reconciliation fixes the quantity (J7). */
  SeatSyncQueueFailures: "SeatSyncQueueFailures",
  /** Sign-outs whose refresh token Cognito didn't revoke: it stays valid until it expires (J0). */
  SignOutRevokeFailures: "SignOutRevokeFailures",
  /** Federated sign-ins whose provider-verified email couldn't be marked verified: the user stays unverified (J3). */
  EmailVerifyFailures: "EmailVerifyFailures",
  /** Federated sign-ins whose email the provider no longer verifies but couldn't be marked unverified: it stays verified (J3). */
  EmailUnverifyFailures: "EmailUnverifyFailures",
  /** POST /me/email/code requests that failed on our side or Cognito's (5xx): the caller got no code (J3). */
  EmailCodeSendFailures: "EmailCodeSendFailures",
  /** POST /me/email/verify requests that failed on our side or Cognito's (5xx): the address wasn't verified (J3). */
  EmailCodeVerifyFailures: "EmailCodeVerifyFailures",
  /** Gauge: inventory imports still committing an hour after they started, half applied (J2). */
  StuckImports: "StuckImports",
  /** Gauge: SES sends in the last 24 hours as a percentage of the daily sending quota (J3). */
  EmailQuotaUsedPercent: "EmailQuotaUsedPercent",
  /** Gauge: teams the nightly seat reconciliation queued for a check, from its run (J7). None for two days means it isn't running. */
  SeatReconcileTeams: "SeatReconcileTeams",
  /** Gauge: closed teams still not deleted more than a day after their deletion date, from the hourly purge (J11). */
  ClosedTeamsOverdue: "ClosedTeamsOverdue",
  /** Teams an owner closed (or that closed with their only member's account). */
  TeamsClosed: "TeamsClosed",
  /** Owners emailed that their team closed, with the day it'll be deleted. */
  TeamClosedNotices: "TeamClosedNotices",
  /** Owners of a closed team who couldn't be emailed about it (SES refused, no address, or the owners couldn't be listed); the team stays closed. */
  TeamClosedNoticeFailures: "TeamClosedNoticeFailures",
  /** Closed teams an owner reopened before the purge. */
  TeamsReopened: "TeamsReopened",
  /** Owners emailed that their team was reopened. */
  TeamReopenedNotices: "TeamReopenedNotices",
  /** Owners of a reopened team who couldn't be emailed about it (SES refused, no address, or the owners couldn't be listed); the team stays open. */
  TeamReopenedNoticeFailures: "TeamReopenedNoticeFailures",
  /** Accounts their users deleted: the Cognito user and every row that named them. */
  AccountsDeleted: "AccountsDeleted",
  /** Closed teams deleted by the scheduled purge once their read-only period ended. */
  TeamsPurged: "TeamsPurged",
  /** Closed teams' Stripe subscriptions set to cancel at the period's end (or cancelled, if nothing was being paid), by the purge or the billing worker; the action goes in metadata. */
  ClosedTeamSubscriptionsEnded: "ClosedTeamSubscriptionsEnded",
  /** Purged teams' Stripe customers deleted (their name, email, address and cards). */
  StripeCustomersDeleted: "StripeCustomersDeleted",
  /** Operator audit items (OPAUDIT#) changed or deleted other than by their TTL: the audit trail was tampered with (ADR 0015). From the operator audit watch (primary region). */
  OperatorAuditChanged: "OperatorAuditChanged",
  /** Heartbeats the operator audit watch read from the table's stream (OPERATOR_AUDIT_HEARTBEAT): none for a while means it isn't reading the stream, or its metrics aren't arriving. */
  OperatorAuditWatchHeartbeat: "OperatorAuditWatchHeartbeat",
  /** Deletion records written over, deleted or hidden behind a delete marker, or objects in the bucket that aren't records: from the deletion records watch (primary region). */
  DeletionRecordRewrites: "DeletionRecordRewrites",
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
