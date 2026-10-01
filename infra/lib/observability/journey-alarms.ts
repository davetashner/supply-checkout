import { Duration } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  type IMetric,
  MathExpression,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { billingResourceNames } from "../../../backend/src/billing/names.js";
import { emailResourceNames } from "../../../backend/src/email/names.js";
import { identityResourceNames } from "../../../backend/src/identity/names.js";
import { BusinessMetric } from "../../../backend/src/observability/names.js";
import { PURGE_EVERY_HOURS, PURGE_OVERDUE_AFTER_HOURS } from "../../../backend/src/ops/names.js";
import { realtimeResourceNames } from "../../../backend/src/realtime/channels.js";
import type { AlarmTopics, Severity } from "./alarm-topics.js";
import { apiGateway, business, dynamoDbSystemErrors, dynamoDbThrottles, FIVE_MINUTES, lambda } from "./metrics.js";

/**
 * One alarm from docs/journeys.md, "Alarms for blocked journeys". Only alarms
 * whose metrics exist, or will exist as soon as the code that sends them is
 * deployed, are here. The rest are listed in docs/journeys.md with the bead
 * that adds them.
 */
export interface JourneyAlarmSpec {
  /** Construct ID, and the end of the alarm name. */
  readonly id: string;
  /** The alarm's name in docs/journeys.md. */
  readonly title: string;
  /** Journeys it guards: "Every journey", "J4", ... */
  readonly journeys: string;
  readonly severity: Severity;
  /** The threshold from docs/journeys.md, in words, and any difference from it. */
  readonly rule: string;
  readonly metric: IMetric;
  readonly threshold: number;
  /** Consecutive periods that must breach before it alarms, for "sustained" rules. Defaults to 1. */
  readonly periods?: number;
  /**
   * Only in the primary region: the metric comes from something that runs
   * only there (a scheduled check or the closed-team purge, ops-checks.ts),
   * so the alarm would never see data anywhere else.
   */
  readonly primaryOnly?: boolean;
}

export interface JourneyAlarmsProps {
  readonly envName: string;
  readonly region: string;
  /** Whether this is the primary region, which alone gets the primaryOnly alarms. */
  readonly primary: boolean;
  /** The app table's name in this region (a global table has the same name in every region). */
  readonly tableName: string;
  /** The HTTP API's ID in this region (the api stack publishes it to SSM). */
  readonly apiId: string;
  readonly topics: AlarmTopics;
}

/** Invites sent in an hour, across every team, that "Invite surge" alarms above. */
export const INVITE_SURGE_PER_HOUR = 300;

/**
 * Closed teams set aside at once that "Many closed-team subscriptions set
 * aside" treats as an incident (P1): more than a one-off, most likely a Stripe
 * key or mode mismatch setting every closed team aside (supply-checkout-8jc.37).
 */
export const SET_ASIDE_INCIDENT_AT = 5;

const TEN_MINUTES = Duration.minutes(10);
const FIFTEEN_MINUTES = Duration.minutes(15);
/** Two of the hourly purge's runs, so every period holds at least one gauge reading. */
const TWO_PURGE_RUNS = Duration.hours(2 * PURGE_EVERY_HOURS);

/** `numerator / denominator` as a percentage, or 0 while the denominator is below `minimum`. */
function percent(numerator: Metric, denominator: Metric, minimum: number, label: string): MathExpression {
  return new MathExpression({
    expression: `IF(d >= ${minimum}, 100 * FILL(n, 0) / d, 0)`,
    usingMetrics: { n: numerator, d: denominator },
    period: numerator.period,
    label,
  });
}

export function journeyAlarmSpecs(region: string, tableName: string, apiId: string, envName: string): JourneyAlarmSpec[] {
  const realtime = realtimeResourceNames(envName);
  const email = emailResourceNames(envName);
  const billing = billingResourceNames(envName);
  const identity = identityResourceNames(envName);
  return [
    // Every journey
    {
      id: "functions-failing",
      title: "Functions failing",
      journeys: "Every journey",
      severity: "P1",
      rule: "Lambda Errors above 1% of invocations for 5 minutes, across every function in the region, once there are at least 20 invocations. Per-function alarms come with the functions.",
      metric: percent(lambda("Errors", region), lambda("Invocations", region), 20, `Lambda error rate % (${region})`),
      threshold: 1,
    },
    {
      id: "functions-throttled",
      title: "Functions throttled",
      journeys: "Every journey",
      severity: "P2",
      rule: "Any Lambda throttles for 5 minutes, across every function in the region.",
      metric: lambda("Throttles", region),
      threshold: 0,
    },
    {
      id: "api-errors",
      title: "API errors",
      journeys: "Every journey",
      severity: "P1",
      rule: "API Gateway 5xx above 2% of requests for 5 minutes, once there are at least 20 requests. Across all of the API's routes: per-route metrics need detailed metrics, billed per route; the access logs have the route.",
      metric: percent(apiGateway("5xx", apiId, region), apiGateway("Count", apiId, region), 20, `API 5xx rate % (${region})`),
      threshold: 2,
    },
    {
      id: "api-slow",
      title: "API slow",
      journeys: "Every journey",
      severity: "P2",
      rule: "API Gateway Latency p95 above 2 seconds over 10 minutes.",
      metric: apiGateway("Latency", apiId, region, "p95", TEN_MINUTES),
      threshold: 2000,
    },
    {
      id: "database-errors",
      title: "Database errors",
      journeys: "Every journey",
      severity: "P1",
      rule: "Any DynamoDB SystemErrors on the app table for 5 minutes.",
      metric: dynamoDbSystemErrors(tableName, region),
      threshold: 0,
    },
    {
      id: "database-throttled",
      title: "Database throttled",
      journeys: "Every journey",
      severity: "P2",
      rule: "Any read or write throttle events on the app table for 5 minutes.",
      metric: dynamoDbThrottles(tableName, region),
      threshold: 0,
    },
    // J0. Sign in
    {
      id: "sign-out-not-revoking",
      title: "Sign-out not revoking",
      journeys: "J0",
      severity: "P2",
      rule: "SignOutRevokeFailures at least 3 in 15 minutes: Cognito didn't revoke the refresh tokens of people who signed out, so they stay valid until they expire (30 days). Sign-out still clears the cookie. Usually Cognito unreachable or erroring.",
      metric: business(BusinessMetric.SignOutRevokeFailures, region, FIFTEEN_MINUTES),
      threshold: 2,
    },
    {
      id: "security-notices-failing",
      title: "Security notices failing",
      journeys: "J0",
      severity: "P2",
      rule: "Any SecurityNoticeFailures over 15 minutes: someone set a password or turned on two-step sign-in and the account's own verified address wasn't told (SES refused the message or took more than 3 seconds, or there's no verified address). The change stands anyway, so an account taken over this way goes unnoticed by its owner (supply-checkout-8jc.15).",
      metric: business(BusinessMetric.SecurityNoticeFailures, region, FIFTEEN_MINUTES),
      threshold: 0,
    },
    {
      id: "security-notices-dropped",
      title: "Security notices dropped",
      journeys: "J0",
      severity: "P2",
      rule: "Any message in the security notices dead-letter queue: a CloudTrail record of a password, two-step or email change that the security notices function failed on after its retries, or EventBridge couldn't deliver, so the account may not have been told (supply-checkout-8jc.28). The message has the event to replay.",
      metric: new Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: email.securityNoticesDeadLetterQueue },
        statistic: "Maximum",
        period: FIVE_MINUTES,
        region,
      }),
      threshold: 0,
    },
    // J1. Sign up
    {
      id: "sign-up-trigger-failing",
      title: "Sign-up trigger failing",
      journeys: "J1",
      severity: "P1",
      rule: "Any Errors or Throttles of the app pool's post confirmation trigger in 5 minutes: Cognito reports a failed trigger to the person confirming their sign-up (they're confirmed, but see an error), and the trigger never fails on purpose (a failed notice-address write is counted in SecurityNoticeFailures instead), so this is a crash, a timeout or a throttle (supply-checkout-8jc.31). Its logs are the function's log group.",
      metric: new MathExpression({
        expression: "FILL(e, 0) + FILL(t, 0)",
        usingMetrics: {
          e: new Metric({ namespace: "AWS/Lambda", metricName: "Errors", dimensionsMap: { FunctionName: identity.postConfirmationFunction }, statistic: "Sum", period: FIVE_MINUTES, region }),
          t: new Metric({ namespace: "AWS/Lambda", metricName: "Throttles", dimensionsMap: { FunctionName: identity.postConfirmationFunction }, statistic: "Sum", period: FIVE_MINUTES, region }),
        },
        period: FIVE_MINUTES,
        label: `Post confirmation trigger errors and throttles (${region})`,
      }),
      threshold: 0,
      primaryOnly: true,
    },
    // J2. Set up the inventory
    {
      id: "imports-stuck",
      title: "Imports stuck",
      journeys: "J2",
      severity: "P2",
      rule: "StuckImports above 0 at its maximum over 15 minutes: an inventory import has been committing for over an hour and is half applied until it's finished. The stuck-import check runs in the primary region every 10 minutes and logs each one's team and import IDs.",
      metric: business(BusinessMetric.StuckImports, region, FIFTEEN_MINUTES, "Maximum"),
      threshold: 0,
      primaryOnly: true,
    },
    // J3. Invite the crew
    {
      id: "email-verification-not-saved",
      title: "Email verification not saved",
      journeys: "J3",
      severity: "P2",
      rule: "Any EmailVerifyFailures or EmailUnverifyFailures over 15 minutes: the sign-in trigger couldn't copy a Google or Apple user's email_verified, so they stay unverified (and can't accept invites) or, for a downgrade, stay verified; or couldn't unverify or record a linked user's changed email. The sign-in goes ahead (a linked user's failed downgrade fails it) and the next one retries, so the Lambda Errors alarm doesn't see it.",
      metric: new MathExpression({
        expression: "FILL(v, 0) + FILL(u, 0)",
        usingMetrics: {
          v: business(BusinessMetric.EmailVerifyFailures, region, FIFTEEN_MINUTES),
          u: business(BusinessMetric.EmailUnverifyFailures, region, FIFTEEN_MINUTES),
        },
        period: FIFTEEN_MINUTES,
        label: `Email verification failures (${region})`,
      }),
      threshold: 0,
    },
    {
      id: "email-codes-failing",
      title: "Email codes failing",
      journeys: "J3",
      severity: "P2",
      rule: "EmailCodeSendFailures + EmailCodeVerifyFailures at least 3 in 15 minutes: POST /me/email/code or /me/email/verify answered 5xx (Cognito erroring or unreachable, or couldn't deliver the code), so people can't verify their address, and can't accept invites. Refusals (a wrong or expired code, too many attempts) aren't counted. Too few requests for the API errors alarm's 2% to notice.",
      metric: new MathExpression({
        expression: "FILL(s, 0) + FILL(c, 0)",
        usingMetrics: {
          s: business(BusinessMetric.EmailCodeSendFailures, region, FIFTEEN_MINUTES),
          c: business(BusinessMetric.EmailCodeVerifyFailures, region, FIFTEEN_MINUTES),
        },
        period: FIFTEEN_MINUTES,
        label: `Email code failures (${region})`,
      }),
      threshold: 2,
    },
    {
      id: "near-sending-limit",
      title: "Near the sending limit",
      journeys: "J3",
      severity: "P2",
      rule: "EmailQuotaUsedPercent above 80 at its maximum over 15 minutes: SES has sent over 80% of its rolling 24-hour quota, and stops sending (invites, sign-in codes) at 100%. The SES quota check runs in the primary region every 10 minutes.",
      metric: business(BusinessMetric.EmailQuotaUsedPercent, region, FIFTEEN_MINUTES, "Maximum"),
      threshold: 80,
      primaryOnly: true,
    },
    {
      id: "invite-surge",
      title: "Invite surge",
      journeys: "J3",
      severity: "P2",
      rule: `InvitesSent above ${INVITE_SURGE_PER_HOUR} in an hour, across every team: far more than crews joining, so a bug resending invites, or free trial teams used to send mail. Per-team, per-address and per-inviter daily limits bound each sender; this is the account-wide watch (SES's own quota is the hard ceiling, see Near the sending limit).`,
      metric: business(BusinessMetric.InvitesSent, region, Duration.hours(1)),
      threshold: INVITE_SURGE_PER_HOUR,
    },
    {
      id: "email-bouncing",
      title: "Email bouncing",
      journeys: "J3",
      severity: "P1",
      rule: "SES Reputation.BounceRate above 4%. AWS reviews accounts at 5% and can pause sending at 10%.",
      metric: new Metric({ namespace: "AWS/SES", metricName: "Reputation.BounceRate", statistic: "Maximum", period: FIFTEEN_MINUTES, region }),
      threshold: 0.04,
    },
    {
      id: "email-complaints",
      title: "Email complaints",
      journeys: "J3",
      severity: "P1",
      rule: "SES Reputation.ComplaintRate above 0.08%. AWS reviews at 0.1%.",
      metric: new Metric({ namespace: "AWS/SES", metricName: "Reputation.ComplaintRate", statistic: "Maximum", period: FIFTEEN_MINUTES, region }),
      threshold: 0.0008,
    },
    {
      id: "email-events-dropped",
      title: "Email events dropped",
      journeys: "J3",
      severity: "P2",
      rule: "Any message in the email-events dead-letter queue: a bounce or complaint the handler couldn't record after retries, so an invite that bounced may still show as pending. SES has already suppressed the address; the message has the event to replay.",
      metric: new Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: email.deadLetterQueue },
        statistic: "Maximum",
        period: FIVE_MINUTES,
        region,
      }),
      threshold: 0,
    },
    // J4. Check supplies out and back in
    {
      id: "writes-rejected",
      title: "Writes rejected",
      journeys: "J4",
      severity: "P2",
      rule: "ConditionalWriteConflicts above 5% of Writes over 15 minutes, once there are at least 20 writes. A spike means a sync bug.",
      metric: percent(
        business(BusinessMetric.ConditionalWriteConflicts, region, FIFTEEN_MINUTES),
        business(BusinessMetric.Writes, region, FIFTEEN_MINUTES),
        20,
        `Write conflict rate % (${region})`,
      ),
      threshold: 5,
    },
    {
      id: "live-updates-failing",
      title: "Live updates failing",
      journeys: "J4",
      severity: "P2",
      rule: "LiveUpdateFailures above 1% of LiveUpdates over 10 minutes, once there are at least 20 events: the stream consumer can't publish to AppSync Events. Failed batches are retried; see Live updates dropped.",
      metric: percent(
        business(BusinessMetric.LiveUpdateFailures, region, TEN_MINUTES),
        business(BusinessMetric.LiveUpdates, region, TEN_MINUTES),
        20,
        `Live update failure rate % (${region})`,
      ),
      threshold: 1,
    },
    {
      id: "live-updates-delayed",
      title: "Live updates delayed",
      journeys: "J4",
      severity: "P2",
      rule: "The stream consumer's IteratorAge above 30 seconds at its maximum for 5 minutes: changes reach other devices late (the goal is 2 seconds).",
      metric: new Metric({
        namespace: "AWS/Lambda",
        metricName: "IteratorAge",
        dimensionsMap: { FunctionName: realtime.consumerFunction },
        statistic: "Maximum",
        period: FIVE_MINUTES,
        region,
      }),
      threshold: 30_000,
    },
    {
      id: "live-updates-deferred",
      title: "Live updates deferred",
      journeys: "J4",
      severity: "P2",
      rule: "Any LiveUpdatesDeferred in each of 3 consecutive 5-minute periods: the stream consumer keeps running out of its per-invocation publish budget (AppSync slow, or big teams busier than a batch's budget fits), so changes reach other devices late. Every invocation still sends the batch's first chunk, so it can't stall; see Live updates delayed and dropped.",
      metric: business(BusinessMetric.LiveUpdatesDeferred, region, FIVE_MINUTES),
      threshold: 0,
      periods: 3,
    },
    {
      id: "live-updates-dropped",
      title: "Live updates dropped",
      journeys: "J4",
      severity: "P2",
      rule: "Any message in the stream consumer's dead-letter queue: a batch of changes was never published. Clients catch up when they reconnect or resync; the message says which stream records to look at.",
      metric: new Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: realtime.deadLetterQueue },
        statistic: "Maximum",
        period: FIVE_MINUTES,
        region,
      }),
      threshold: 0,
    },
    // J5. Read a receipt
    {
      id: "receipt-reading-failing",
      title: "Receipt reading failing",
      journeys: "J5",
      severity: "P2",
      rule: "ReceiptReadFailures above 10% of ReceiptReads over 15 minutes, once there are at least 5 reads.",
      metric: percent(
        business(BusinessMetric.ReceiptReadFailures, region, FIFTEEN_MINUTES),
        business(BusinessMetric.ReceiptReads, region, FIFTEEN_MINUTES),
        5,
        `Receipt failure rate % (${region})`,
      ),
      threshold: 10,
    },
    // J7. Subscribe, add seats and see invoices
    {
      id: "checkout-broken",
      title: "Checkout broken",
      journeys: "J7",
      severity: "P1",
      rule: "Any CheckoutSessionErrors for 5 minutes.",
      metric: business(BusinessMetric.CheckoutSessionErrors, region, FIVE_MINUTES),
      threshold: 0,
    },
    {
      id: "billing-portal-broken",
      title: "Billing portal broken",
      journeys: "J7, J8",
      severity: "P1",
      rule: "Any BillingPortalErrors for 5 minutes: owners can't open the Stripe Customer Portal to add or fix a card, change plans or cancel. Usually the portal configuration is missing in this Stripe mode (run the catalog script).",
      metric: business(BusinessMetric.BillingPortalErrors, region, FIVE_MINUTES),
      threshold: 0,
    },
    {
      id: "webhook-signature-failures",
      title: "Webhook signature failures",
      journeys: "J7",
      severity: "P1",
      rule: "Any WebhookSignatureFailures. Usually a rotated or wrong signing secret.",
      metric: business(BusinessMetric.WebhookSignatureFailures, region, FIVE_MINUTES),
      threshold: 0,
    },
    {
      id: "billing-events-stuck",
      title: "Billing events stuck",
      journeys: "J7, J8",
      severity: "P1",
      rule: "Any message in the billing events dead-letter queue: a Stripe event the billing worker couldn't apply after 5 tries, so a team's plan, seats or status may be out of date. The message holds the event's IDs, to replay it.",
      metric: new Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: billing.deadLetterQueue },
        statistic: "Maximum",
        period: FIVE_MINUTES,
        region,
      }),
      threshold: 0,
    },
    {
      id: "billing-events-late",
      title: "Billing events late",
      journeys: "J7, J8",
      severity: "P2",
      rule: "The oldest message in the billing events queue is more than 5 minutes old: the worker is failing or behind, so a payment takes longer to show.",
      metric: new Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateAgeOfOldestMessage",
        dimensionsMap: { QueueName: billing.queue },
        statistic: "Maximum",
        period: FIVE_MINUTES,
        region,
      }),
      threshold: 300,
    },
    {
      id: "seat-syncs-stuck",
      title: "Seat syncs stuck",
      journeys: "J7",
      severity: "P2",
      rule: "Any message in the seat syncs dead-letter queue: a seat sync the billing worker couldn't apply after 5 tries (Stripe or DynamoDB failing), so a team may be billed for the wrong number of seats until the nightly reconciliation fixes it. The message holds the Stripe customer's ID.",
      metric: new Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: billing.seatDeadLetterQueue },
        statistic: "Maximum",
        period: FIVE_MINUTES,
        region,
      }),
      threshold: 0,
    },
    {
      id: "seat-counts-drifting",
      title: "Seat counts drifting",
      journeys: "J7",
      severity: "P2",
      rule: "Any SeatQuantityDrift over an hour: the nightly seat reconciliation (primary region) found a team billed for a different number of seats than it has billed members (owners and editors), so the sync after a membership change missed it. The billing worker has already set the quantity right; the log line \"Seat quantity drift\" has the team and subscription IDs and both numbers. Look for a seat sync that couldn't be queued (SeatSyncQueueFailures) or went to the seat syncs dead-letter queue.",
      metric: business(BusinessMetric.SeatQuantityDrift, region, Duration.hours(1)),
      threshold: 0,
      primaryOnly: true,
    },
    {
      id: "entitlements-drifting",
      title: "Entitlements drifting",
      journeys: "J7, J8",
      severity: "P2",
      rule: "Any EntitlementDrift over an hour: the nightly entitlement check (primary region, with the seat reconciliation) found a team whose subscription, status, plan or seats weren't what Stripe has, so a Stripe event was lost or is stuck. The billing worker has already applied Stripe's state (a missing subscription it can't fix); the log line \"Entitlement drift\" has the team and subscription IDs, the fields and both values. Owners weren't emailed about it. See docs/runbooks/billing-dlq-replay.md.",
      metric: business(BusinessMetric.EntitlementDrift, region, Duration.hours(1)),
      threshold: 0,
      primaryOnly: true,
    },
    // J11. Delete an account
    {
      id: "deletion-overdue",
      title: "Deletion overdue",
      journeys: "J11",
      severity: "P2",
      rule: `ClosedTeamsOverdue above 0 at its maximum over ${2 * PURGE_EVERY_HOURS} hours: a closed team is still there more than ${PURGE_OVERDUE_AFTER_HOURS} hours after the day it was due to be deleted, which the privacy policy promises. The hourly closed-team purge (primary region) sends the gauge every run and logs each failed team's ID.`,
      metric: business(BusinessMetric.ClosedTeamsOverdue, region, TWO_PURGE_RUNS, "Maximum"),
      threshold: 0,
      primaryOnly: true,
    },
    {
      id: "team-closed-notices-failing",
      title: "Team closure emails failing",
      journeys: "J11",
      severity: "P2",
      rule: "Any TeamClosedNoticeFailures over 15 minutes: an owner of a team that just closed wasn't emailed the day it will be deleted (SES refused the message, no address on file, or the owners couldn't be listed). The team closed anyway.",
      metric: business(BusinessMetric.TeamClosedNoticeFailures, region, FIFTEEN_MINUTES),
      threshold: 0,
    },
    {
      id: "reopened-team-subscription-ended",
      title: "Reopened team's subscription ended",
      journeys: "J7, J11",
      severity: "P2",
      rule: "Any ReopenedTeamSubscriptionsEnded over 15 minutes: an owner reopened a closed team while the billing worker or the closed-team purge was asking Stripe to end its subscription, so a team that's open again has a subscription set to cancel (or cancelled). The log line \"Team reopened while its subscription was being ended\" has the team and subscription IDs and the action: resume the subscription in the Stripe Dashboard, or ask an owner to.",
      metric: business(BusinessMetric.ReopenedTeamSubscriptionsEnded, region, FIFTEEN_MINUTES),
      threshold: 0,
    },
    {
      id: "reopen-resync-late",
      title: "Reopened team's billing not resynced",
      journeys: "J7, J11",
      severity: "P2",
      rule: "Any ReopenResyncsLate over an hour: the nightly seat reconciliation (primary region) found a team reopened before the night whose Stripe subscription still hadn't been resynced (stripeResyncFor on its META item): the reopen's seat sync wasn't queued, or failed. The billing worker then resyncs it with the night's message, resuming a subscription its closure set to cancel. If it fires again the next night, that resync is failing too: the log line \"Reopened team's subscription not yet resynced\" has the team ID, and the worker's warnings or the seat syncs dead-letter queue say why. See docs/runbooks/billing-dlq-replay.md.",
      metric: business(BusinessMetric.ReopenResyncsLate, region, Duration.hours(1)),
      threshold: 0,
      primaryOnly: true,
    },
    {
      id: "reopened-team-subscription-undecided",
      title: "Reopened team's subscription left to cancel",
      journeys: "J7, J11",
      severity: "P2",
      rule: "Any ReopenedTeamSubscriptionsUndecided over an hour: the billing worker resynced a reopened team whose Stripe subscription is set to cancel at the period's end, maybe by the closure (no closure stamp, but the purge recorded ending it for that closure, from before the stamp existed) or maybe by an owner, and Stripe gave no time it was set (canceled_at), or the team has no reopen time. It left it set to cancel rather than risk charging an owner who cancelled. The log line \"Reopened team's subscription left set to cancel\" has the team and subscription IDs: a person decides, from the subscription's history in the Stripe Dashboard.",
      metric: business(BusinessMetric.ReopenedTeamSubscriptionsUndecided, region, Duration.hours(1)),
      threshold: 0,
    },
    {
      id: "closed-team-charged",
      title: "Closed team charged",
      journeys: "J7, J11",
      severity: "P2",
      rule: "Any ClosedTeamRenewalsCharged over an hour: the hourly closed-team purge (primary region) found a closed team's subscription charged for a period that began after the team closed (a renewal or trial conversion in the hour before the purge set it to end). The log line \"Closed team's subscription renewed after it closed\" has the team and subscription IDs: refund that invoice in the Stripe Dashboard.",
      metric: business(BusinessMetric.ClosedTeamRenewalsCharged, region, Duration.hours(1)),
      threshold: 0,
      primaryOnly: true,
    },
    {
      id: "closed-team-subscription-not-found",
      title: "Closed-team subscription not found in Stripe",
      journeys: "J7, J11",
      severity: "P2",
      rule: "Any ClosedTeamSubscriptionsNotFound over an hour: the hourly closed-team purge (primary region) asked Stripe for a closed team's subscription, Stripe said it doesn't exist, and the purge set the team aside (stripeSetAsideFor, reason NotFound) rather than retry it every hour. Usually the subscription went with its customer, but a Stripe key or mode mismatch looks the same for every closed team, with none cancelled. The log line \"Closed team's subscription not found in Stripe\" has the team and subscription IDs: look the subscription up in the Stripe Dashboard, in the purge's mode. Once the key or mode is fixed, removing stripeSetAsideFor from each team's META item has the next run end its subscription.",
      metric: business(BusinessMetric.ClosedTeamSubscriptionsNotFound, region, Duration.hours(1)),
      threshold: 0,
      primaryOnly: true,
    },
    {
      id: "closed-team-subscription-set-aside",
      title: "Closed-team subscription set aside",
      journeys: "J7, J11",
      severity: "P2",
      rule: `ClosedTeamsSetAside above 0 at its maximum over ${2 * PURGE_EVERY_HOURS} hours: closed teams whose subscription the hourly closed-team purge (primary region) won't end or retry for this closure, until a person deals with each one: it belongs to another Stripe customer (CustomerMismatch), Stripe doesn't have it (NotFound), or Stripe refused to end it with an error retrying won't change (PermanentError). The purge sends the gauge every run, so this stays on until each team is handled (stripeSetAsideFor removed), and logs "Closed team's subscription still set aside" with each team's ID and reason. A team set aside isn't purged, even past its deletion date (when Deletion overdue fires for it too), so deal with each one before then. See docs/journeys.md.`,
      metric: business(BusinessMetric.ClosedTeamsSetAside, region, TWO_PURGE_RUNS, "Maximum"),
      threshold: 0,
      primaryOnly: true,
    },
    {
      id: "closed-team-subscriptions-set-aside-many",
      title: "Many closed-team subscriptions set aside",
      journeys: "J7, J11",
      severity: "P1",
      rule: `ClosedTeamsSetAside at ${SET_ASIDE_INCIDENT_AT} or more at its maximum over ${2 * PURGE_EVERY_HOURS} hours: that many closed teams set aside at once is most likely a Stripe key or mode mismatch (every closed team's subscription not found), or set-asides left uncleared; under a mismatch no closed team's subscription is ended and none of those teams is purged. Check the purge's Stripe key and mode first. See docs/journeys.md, "Closed-team subscription not found in Stripe".`,
      metric: business(BusinessMetric.ClosedTeamsSetAside, region, TWO_PURGE_RUNS, "Maximum"),
      threshold: SET_ASIDE_INCIDENT_AT - 1,
      primaryOnly: true,
    },
    {
      id: "stripe-customer-already-deleted",
      title: "Stripe customer already deleted",
      journeys: "J7, J11",
      severity: "P2",
      rule: "Any StripeCustomersAlreadyDeleted over an hour: the hourly closed-team purge (primary region) asked Stripe to delete a purged team's customer and was told it doesn't exist, took it as deleted and purged the team. A run that stopped after deleting the customer does that, but so does a Stripe key or mode mismatch, under which the real customer keeps its details and any subscription keeps billing. The log line \"Stripe customer already deleted\" has the team and customer IDs, and the team's deletion record keeps its customer and subscription IDs: look the customer up in the Stripe Dashboard, in both modes.",
      metric: business(BusinessMetric.StripeCustomersAlreadyDeleted, region, Duration.hours(1)),
      threshold: 0,
      primaryOnly: true,
    },
    {
      id: "team-reopened-notices-failing",
      title: "Team reopened emails failing",
      journeys: "J11",
      severity: "P2",
      rule: "Any TeamReopenedNoticeFailures over 15 minutes: an owner of a team that was just reopened wasn't told it will no longer be deleted (SES refused the message, no address on file, or the owners couldn't be listed). The team reopened anyway.",
      metric: business(BusinessMetric.TeamReopenedNoticeFailures, region, FIFTEEN_MINUTES),
      threshold: 0,
    },
  ];
}

/**
 * The journey alarms for one region, each notifying its severity's topic.
 * Outside the primary region, the primaryOnly ones are left out. Missing
 * data never alarms: most of these metrics only exist once traffic does.
 */
export class JourneyAlarms extends Construct {
  readonly alarms: Alarm[] = [];

  constructor(scope: Construct, id: string, props: JourneyAlarmsProps) {
    super(scope, id);
    for (const spec of journeyAlarmSpecs(props.region, props.tableName, props.apiId, props.envName)) {
      if (spec.primaryOnly && !props.primary) continue;
      const alarm = new Alarm(this, spec.id, {
        alarmName: `supply-checkout-${props.envName}-${spec.severity.toLowerCase()}-${spec.id}`,
        alarmDescription: [
          `${spec.severity} ${spec.title} (${spec.journeys}, ${props.region}).`,
          spec.rule,
          "Thresholds and runbooks: docs/journeys.md, Alarms for blocked journeys.",
        ].join(" "),
        metric: spec.metric,
        threshold: spec.threshold,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: spec.periods ?? 1,
        datapointsToAlarm: spec.periods ?? 1,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
      props.topics.notify(alarm, spec.severity);
      this.alarms.push(alarm);
    }
  }
}
