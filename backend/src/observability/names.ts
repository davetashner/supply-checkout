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
  /** Items checked out to a project (J4). */
  Checkouts: "Checkouts",
  /** Items returned to storage from a project (J4). */
  Returns: "Returns",
  /** Writes to team data through the API: the denominator for ConditionalWriteConflicts. */
  Writes: "Writes",
  /** Writes rejected because the item changed since it was read (409 responses, J4). */
  ConditionalWriteConflicts: "ConditionalWriteConflicts",
  /**
   * Calls to the old `/teams/{teamId}/sheets...` routes, from clients not yet
   * on the projects rename (supply-checkout-005.6), the route key in
   * metadata. Flat zero for a day means the old routes can go.
   */
  LegacySheetsRouteCalls: "LegacySheetsRouteCalls",
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
  /** Units a receipt's lines added to existing projects, bought for the client rather than taken from storage (J5). */
  ReceiptLines: "ReceiptLines",
  /** Model tokens used reading receipts; the team ID goes in metadata (J5). */
  ReceiptTokens: "ReceiptTokens",
  /** Receipt reads refused by the per-user rate limit (supply-checkout-wxx); the team ID goes in metadata (J5). */
  ReceiptRateLimited: "ReceiptRateLimited",
  /** Receipt reads refused because the team's allowance (its month's or its trial's) was used up; the team ID and period go in metadata (J5). */
  ReceiptLimitReached: "ReceiptLimitReached",
  /** Trial teams whose read just reached RECEIPT_NEAR_LIMIT_SHARE (80%) of their trial's allowance, once per trial; the team ID goes in metadata (J5). Many at once suggests a farm of sign-ups. */
  ReceiptTrialsNearLimit: "ReceiptTrialsNearLimit",
  /** Paying or comped teams whose read just reached 80% of their month's allowance, once a month; the team ID goes in metadata (J5). Dashboard only. */
  ReceiptPaidTeamsNearLimit: "ReceiptPaidTeamsNearLimit",
  /** How long each receipt read's model call took, in milliseconds, success or not (J5). The dashboard reads its p95. */
  ReceiptReadLatency: "ReceiptReadLatency",
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
  /** Our API failing to list a team's invoices from Stripe for an owner (J7, supply-checkout-eja). */
  InvoiceListErrors: "InvoiceListErrors",
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
  /** Teams the nightly entitlement check found recorded with a different subscription, status, plan or seats than Stripe has: a Stripe event was lost or stuck (supply-checkout-8jc.9, J7, J8). */
  EntitlementDrift: "EntitlementDrift",
  /** Membership changes whose seat sync couldn't be queued; the nightly reconciliation fixes the quantity (J7). Also closures whose early subscription end couldn't be queued (reason `closed`, supply-checkout-8jc.30); the hourly purge ends it. */
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
  /** Gauge: closed teams whose subscription the purge set aside for a person for their current closure, from every hourly purge run, so the alarm stays on until each is dealt with (supply-checkout-8jc.36, J7, J11). */
  ClosedTeamsSetAside: "ClosedTeamsSetAside",
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
  /** Security notices emailed to an account's verified address: a password was set, or two-step sign-in turned on (supply-checkout-8jc.15). */
  SecurityNotices: "SecurityNotices",
  /** Security notices not sent (SES refused, or no verified address); the change stands. */
  SecurityNoticeFailures: "SecurityNoticeFailures",
  /** Welcome emails sent to a new account's verified address, once per account (supply-checkout-6uw.25); `via` (email, Google, SignInWithApple) in metadata (J1). */
  WelcomeEmails: "WelcomeEmails",
  /** Welcome emails not handed to the welcome email function, or not sent for a reason other than SES refusing them, each try; the reason in metadata. Sign-up goes ahead either way (J1). */
  WelcomeEmailFailures: "WelcomeEmailFailures",
  /** Welcome emails SES refused (sending paused, a suppressed address, or SES's sandbox refusing an unverified address until production access, supply-checkout-3sv.18); `via` in metadata (J1). */
  WelcomeEmailsRefused: "WelcomeEmailsRefused",
  /** Accounts their users deleted: the Cognito user and every row that named them. */
  AccountsDeleted: "AccountsDeleted",
  /** Closed teams deleted by the scheduled purge once their read-only period ended. */
  TeamsPurged: "TeamsPurged",
  /** Closed teams' Stripe subscriptions set to cancel at the period's end (or cancelled, if nothing was being paid), by the purge or the billing worker; the action goes in metadata. */
  ClosedTeamSubscriptionsEnded: "ClosedTeamSubscriptionsEnded",
  /** Subscriptions set to end (or ended) for a closure the team was reopened from, by the purge or the billing worker, while Stripe was being called: an owner or operator must resume it (J7, J11). Also one set to end whose team couldn't be read (or recorded) again afterwards, so a reopen in that moment can't be ruled out (metadata `checked: "no"`, supply-checkout-8jc.30). */
  ReopenedTeamSubscriptionsEnded: "ReopenedTeamSubscriptionsEnded",
  /** Reopened teams' subscriptions resumed in Stripe (a closure had set them to cancel at the period's end), by the billing worker's resync, or by the purge or the worker that ended one as its team was reopened; the source goes in metadata (supply-checkout-85qp). */
  ReopenedTeamSubscriptionsResumed: "ReopenedTeamSubscriptionsResumed",
  /** Reopened teams the nightly reconciliation found still waiting for their subscription to be resynced from Stripe: the reopen's own seat sync wasn't queued or didn't finish, so the night's message does it (supply-checkout-85qp, J7, J11). */
  ReopenResyncsLate: "ReopenResyncsLate",
  /** Reopened teams' subscriptions set to cancel that the resync couldn't attribute (no stamp, the purge recorded ending it for the closure, but Stripe gave no time it was set): left set to cancel for a person to decide (supply-checkout-85qp, J7, J11). */
  ReopenedTeamSubscriptionsUndecided: "ReopenedTeamSubscriptionsUndecided",
  /** Closed teams whose subscription was charged for a period that began after the team closed, found by the purge: a person refunds it (supply-checkout-8jc.18, J7, J11). */
  ClosedTeamRenewalsCharged: "ClosedTeamRenewalsCharged",
  /** Closed teams whose subscription Stripe doesn't have, found by the purge and recorded as nothing to end. Any at all may be a Stripe key or mode mismatch, under which every closed team would be recorded this way with none cancelled (supply-checkout-8jc.17, J7, J11). */
  ClosedTeamSubscriptionsNotFound: "ClosedTeamSubscriptionsNotFound",
  /** Closed teams' subscriptions the purge won't end and won't retry (another customer's subscription, not found in Stripe, or an error retrying won't change), as it sets each aside for a person, so they don't crowd newer closures out of the purge's listing (supply-checkout-8jc.17, J7, J11). The alarm reads the ClosedTeamsSetAside gauge. */
  ClosedTeamSubscriptionsSetAside: "ClosedTeamSubscriptionsSetAside",
  /** Purged teams' Stripe customers deleted (their name, email, address and cards). */
  StripeCustomersDeleted: "StripeCustomersDeleted",
  /** Purged teams' Stripe customers Stripe said were already gone (404). A purge run that stopped after deleting one also gets this, but so does every team under a Stripe key or mode mismatch, whose real customer keeps its details and any subscription; the team's Stripe IDs are kept in its deletion record (supply-checkout-8jc.37, J7, J11). */
  StripeCustomersAlreadyDeleted: "StripeCustomersAlreadyDeleted",
  /** Closed teams held back from the purge (their subscription set aside for a person) that it purged anyway HELD_PURGE_GRACE_DAYS after their deletion date, the subscription unresolved: a person ends it by hand in Stripe, from the IDs in the team's deletion record (supply-checkout-8jc.40, J7, J11). */
  HeldTeamsPurged: "HeldTeamsPurged",
  /** Purged teams whose Stripe customer couldn't be deleted when their data was (Stripe down, say): the data was deleted on schedule anyway and the customer's deletion queued for the next runs to retry (supply-checkout-8jc.42, J7, J11). */
  StripeCustomerDeletionsQueued: "StripeCustomerDeletionsQueued",
  /** Gauge, every purge run that can read the queue: the Stripe customer deletions still queued. */
  StripeCustomerDeletionsPending: "StripeCustomerDeletionsPending",
  /** Gauge, every purge run that can read the queue: how many hours the oldest queued Stripe customer deletion has waited (0 with none). "Stripe customer deletion retrying" (P2) and "stuck" (P1) read it (supply-checkout-8jc.42). */
  StripeCustomerDeletionOldestHours: "StripeCustomerDeletionOldestHours",
  /** Operator audit items (OPAUDIT#) changed or deleted other than by their TTL: the audit trail was tampered with (ADR 0015). From the operator audit watch (primary region). */
  OperatorAuditChanged: "OperatorAuditChanged",
  /** Heartbeats the operator audit watch read from the table's stream (OPERATOR_AUDIT_HEARTBEAT): none for a while means it isn't reading the stream, or its metrics aren't arriving. */
  OperatorAuditWatchHeartbeat: "OperatorAuditWatchHeartbeat",
  /** Operators added to or removed from the operators group, disabled or enabled, since the operator group watch last looked (supply-checkout-3sv.5, primary region). */
  OperatorGroupChanged: "OperatorGroupChanged",
  /** Times the operator group watch had to start its snapshot again: the deploy's initial value, or one it couldn't read. Alarms P1 with OperatorGroupChanged. */
  OperatorGroupBaselineReset: "OperatorGroupBaselineReset",
  /** Users in the operators group, sent by every run of the operator group watch that finishes: none for a while means it isn't running. */
  OperatorGroupMembers: "OperatorGroupMembers",
  /** Deletion records written over, deleted or hidden behind a delete marker, or objects in the bucket that aren't records: from the deletion records watch (primary region). */
  DeletionRecordRewrites: "DeletionRecordRewrites",
  /** Gauge, every lapsed-team job run that can list teams: the teams it checked (supply-checkout-qdx, J7, J8, J10). None for a while means it isn't running ("Lapsed-team job not running"). */
  LapseTeamsChecked: "LapseTeamsChecked",
  /** Gauge, every lapsed-team job run: teams read-only for billing (an ended trial or subscription, or an overdue payment) it saw. For the dashboard. */
  LapseTeamsReadOnly: "LapseTeamsReadOnly",
  /** Owners the lapsed-team job emailed: a trial ending, a trial ended, a payment overdue, or a deletion warning (kind in metadata). */
  LapseNotices: "LapseNotices",
  /** Owners the lapsed-team job couldn't email (SES refused, or no address); the claim stands, so it isn't retried. */
  LapseNoticeFailures: "LapseNoticeFailures",
  /** Lapsed teams the job closed for the hourly purge: their trial or subscription ended READ_ONLY_RETENTION_DAYS ago, owners were warned at least LAPSE_WARNING_DAYS before, and Stripe confirmed nothing live. */
  LapsedTeamsClosed: "LapsedTeamsClosed",
  /** Gauge, every lapsed-team job run: teams listed that it had no time left to start ("Lapsed-team job out of time" when every run for 3 hours leaves some). */
  LapseTeamsUnstarted: "LapseTeamsUnstarted",
  /** Lapsed teams due to close that a run held because it had already closed LAPSE_MAX_CLOSURES_PER_RUN: "Lapsed-team closures held". */
  LapseClosuresHeld: "LapseClosuresHeld",
  /** Teams the lapsed-team job couldn't handle this run (a read, write, email or Stripe call failed), or wouldn't close because Stripe disagrees with the team (a live subscription, or the team's subscription or customer missing), or that has no owner to warn or no readable deletion time: "Lapsed-team job failing". */
  LapseFailures: "LapseFailures",
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
