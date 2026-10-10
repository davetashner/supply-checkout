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
import {
  HELD_PURGE_GRACE_DAYS,
  LAPSE_CLOSURES_ALARM_COUNT,
  LAPSE_CLOSURES_ALARM_HOURS,
  LAPSE_EVERY_HOURS,
  LAPSE_UNSTARTED_ALARM_HOURS,
  PURGE_EVERY_HOURS,
  PURGE_OVERDUE_AFTER_HOURS,
  PURGE_SILENT_ALARM_HOURS,
  STRIPE_DELETION_RETRY_ALARM_HOURS,
  STRIPE_DELETION_STUCK_DAYS,
} from "../../../backend/src/ops/names.js";
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
   * How many of those `periods` must breach, when fewer than all of them
   * (an M out of N alarm). Defaults to `periods`.
   */
  readonly datapoints?: number;
  /**
   * Missing data breaches: the metric is a gauge a scheduled job sends every
   * run, so no data means the job isn't running. Defaults to false (missing
   * data never alarms).
   */
  readonly missingBreaches?: boolean;
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
 * Receipt reads in an hour, across every team, that "Receipt volume high"
 * alarms above (supply-checkout-wxx). Provisional: about $3 an hour of model
 * calls, far above the pilot's use. Raise it with real traffic.
 */
export const RECEIPT_READS_ALARM_PER_HOUR = 300;

/**
 * Trial teams reaching 80% of their trial's receipts in an hour that "Receipt
 * trials near their limit" alarms at (supply-checkout-wxx). Provisional: one
 * or two a day is a healthy trial; several in an hour is likely a farm.
 */
export const RECEIPT_TRIALS_NEAR_LIMIT_ALARM_PER_HOUR = 5;

/**
 * The receipt model's spend in a day, in US dollars, that "Bedrock spend
 * high" alarms near (supply-checkout-i1d.3). Provisional: several times the
 * pilot's use and twice the account-wide trial cap's worst day. Raise it with
 * real traffic.
 */
export const BEDROCK_SPEND_ALARM_USD_PER_DAY = 5;

/** What one receipt read costs in model calls, in US dollars, about (supply-checkout-kx8): half a cent. */
export const RECEIPT_READ_ESTIMATED_USD = 0.005;

/**
 * Receipt reads in a day above which "Bedrock spend high" alarms: about
 * BEDROCK_SPEND_ALARM_USD_PER_DAY at RECEIPT_READ_ESTIMATED_USD a read.
 * ReceiptReads counts every model call the receipts function makes (the only
 * caller of the model), so one metric stands in for Bedrock's four token
 * counts, each billed as an alarm metric (supply-checkout-7pe.1).
 */
export const RECEIPT_READS_ALARM_PER_DAY = Math.round(BEDROCK_SPEND_ALARM_USD_PER_DAY / RECEIPT_READ_ESTIMATED_USD);

/**
 * Rare events in this long, at least one, that "Needs attention" alarms on:
 * 15-minute periods, alarming on the first one with any, and staying in alarm
 * until 2 hours pass without one, so an event the hourly purge or lapsed-team
 * job sends every run keeps it in alarm rather than flapping.
 */
export const NEEDS_ATTENTION_PERIOD = Duration.minutes(15);
export const NEEDS_ATTENTION_PERIODS = 8;

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
    {
      id: "needs-attention",
      title: "Needs attention",
      journeys: "J0, J1, J3, J5, J7, J8, J10, J11",
      severity: "P2",
      rule: `Any NeedsAttention in 15 minutes, and until 2 hours pass without one: one of the rare events in NEEDS_ATTENTION_METRICS (backend/src/observability/names.ts) happened, each sent beside its own metric, or the trial receipt cap was first reached that UTC day. They should almost never happen and each needs a person to look (a notice not sent, billing drift, a closed team charged, and the rest). An alarm already in ALARM doesn't email again: while one keeps it there, another source shows only on the per-metric graphs. See which in the dashboard's Needs attention row or the metrics console (SupplyCheckout, by Region), or in Logs Insights: filter ispresent(NeedsAttention). Each one's runbook: docs/observability.md, When Needs attention fires.`,
      metric: business(BusinessMetric.NeedsAttention, region, NEEDS_ATTENTION_PERIOD),
      threshold: 0,
      periods: NEEDS_ATTENTION_PERIODS,
      datapoints: 1,
    },
    {
      id: "security-attention",
      title: "Security attention",
      journeys: "J0, J11",
      severity: "P2",
      rule: `Any SecurityAttention in 15 minutes, and until 2 hours pass without one: one of the security events in SECURITY_ATTENTION_METRICS (backend/src/observability/names.ts) happened: a sign-out whose refresh token Cognito didn't revoke (SignOutRevokeFailures), an account not told of a security change (SecurityNoticeFailures), or a deletion record rewritten (DeletionRecordRewrites). Apart from Needs attention, so an ordinary event that keeps it in alarm can't hide these: an alarm already in ALARM doesn't email again, so look at each metric, not only the first email. Runbook: docs/observability.md, When Security attention fires.`,
      metric: business(BusinessMetric.SecurityAttention, region, NEEDS_ATTENTION_PERIOD),
      threshold: 0,
      periods: NEEDS_ATTENTION_PERIODS,
      datapoints: 1,
    },
    // J0. Sign in
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
    {
      id: "sign-in-trigger-failing",
      title: "Sign-in trigger failing",
      journeys: "J0",
      severity: "P1",
      rule: "Any Errors or Throttles of the app pool's pre token generation trigger in 5 minutes. It exists only while Google or Apple sign-in is on, and runs at every token Cognito issues, refreshes included, for every user: a failed call fails that sign-in or refresh. It fails on purpose only when it can't unverify a linked user's changed email (also counted in EmailUnverifyFailures), so this is a crash, a timeout, a throttle or that (supply-checkout-3sv.16). Its logs are the function's log group.",
      metric: new MathExpression({
        expression: "FILL(e, 0) + FILL(t, 0)",
        usingMetrics: {
          e: new Metric({ namespace: "AWS/Lambda", metricName: "Errors", dimensionsMap: { FunctionName: identity.emailVerifiedFunction }, statistic: "Sum", period: FIVE_MINUTES, region }),
          t: new Metric({ namespace: "AWS/Lambda", metricName: "Throttles", dimensionsMap: { FunctionName: identity.emailVerifiedFunction }, statistic: "Sum", period: FIVE_MINUTES, region }),
        },
        period: FIVE_MINUTES,
        label: `Pre token generation trigger errors and throttles (${region})`,
      }),
      threshold: 0,
      primaryOnly: true,
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
    {
      id: "welcome-email-function-failing",
      title: "Welcome email function failing",
      journeys: "J1",
      severity: "P2",
      rule: "Any Errors of the welcome email function in 15 minutes: a try that threw (also counted in WelcomeEmailFailures) or died, by a timeout or a crash, which counts nothing else. One that died after claiming the account's welcome record sent nothing, and Lambda's retry finds it claimed, so that account has no welcome until an operator gives the claim up and replays it (supply-checkout-6uw.25).",
      metric: new Metric({ namespace: "AWS/Lambda", metricName: "Errors", dimensionsMap: { FunctionName: email.welcomeFunction }, statistic: "Sum", period: FIFTEEN_MINUTES, region }),
      threshold: 0,
      primaryOnly: true,
    },
    {
      id: "welcome-emails-dropped",
      title: "Welcome emails dropped",
      journeys: "J1",
      severity: "P2",
      rule: "Any message in the welcome email dead-letter queue: a welcome request (a new account's sub and how it signed up) the function failed on after Lambda's retries, so that account may get no welcome until it's replayed (supply-checkout-6uw.25).",
      metric: new Metric({
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        dimensionsMap: { QueueName: email.welcomeDeadLetterQueue },
        statistic: "Maximum",
        period: FIVE_MINUTES,
        region,
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
    {
      id: "receipt-volume-high",
      title: "Receipt volume high",
      journeys: "J5",
      severity: "P2",
      rule: `ReceiptReads above ${RECEIPT_READS_ALARM_PER_HOUR} in an hour, across every team: far more than crews scanning receipts, so a client retrying in a loop, many users or trial teams used to reach the model, or real growth. Per-user rate limits and per-team allowances bound each caller; this is the account-wide watch on model spend.`,
      metric: business(BusinessMetric.ReceiptReads, region, Duration.hours(1)),
      threshold: RECEIPT_READS_ALARM_PER_HOUR,
    },
    {
      id: "receipt-trials-near-limit",
      title: "Receipt trials near their limit",
      journeys: "J5",
      severity: "P2",
      rule: `ReceiptTrialsNearLimit at ${RECEIPT_TRIALS_NEAR_LIMIT_ALARM_PER_HOUR} or more in an hour: that many trial teams' reads reached 80% of their trial's allowance at once, which suggests a farm of sign-ups using trials to reach the model. Paying teams near their month's limit (ReceiptPaidTeamsNearLimit) are on the dashboard only.`,
      metric: business(BusinessMetric.ReceiptTrialsNearLimit, region, Duration.hours(1)),
      // Above the threshold: at least RECEIPT_TRIALS_NEAR_LIMIT_ALARM_PER_HOUR
      threshold: RECEIPT_TRIALS_NEAR_LIMIT_ALARM_PER_HOUR - 1,
    },
    {
      id: "bedrock-spend-high",
      title: "Bedrock spend high",
      journeys: "J5",
      severity: "P2",
      rule: `ReceiptReads above ${RECEIPT_READS_ALARM_PER_DAY} in a day (RECEIPT_READS_ALARM_PER_DAY): the receipt model's spend near $${BEDROCK_SPEND_ALARM_USD_PER_DAY} a day (BEDROCK_SPEND_ALARM_USD_PER_DAY) at about half a cent a read. Faster than the Bedrock budget, which sees billed cost hours later.`,
      metric: business(BusinessMetric.ReceiptReads, region, Duration.days(1)),
      threshold: RECEIPT_READS_ALARM_PER_DAY,
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
    // J11. Delete an account
    {
      id: "deletion-overdue",
      title: "Deletion overdue or not running",
      journeys: "J11",
      severity: "P2",
      rule: `ClosedTeamsOverdue above 0 at its maximum over ${PURGE_SILENT_ALARM_HOURS} hours: a closed team is still there more than ${PURGE_OVERDUE_AFTER_HOURS} hours after the day it was due to be deleted, which the privacy policy promises. The hourly closed-team purge (primary region) sends the gauge every run and logs each failed team's ID. A team held because its subscription is set aside counts too, until the purge deletes it anyway ${HELD_PURGE_GRACE_DAYS} days after its deletion date (then Needs attention fires, HeldTeamsPurged). Or no sample at all in those ${PURGE_SILENT_ALARM_HOURS} hours (missing data breaches): the purge isn't running (its schedule is disabled or deleted, or every run fails before it reads the closed-teams index), so closed teams aren't being deleted. See docs/journeys.md.`,
      metric: business(BusinessMetric.ClosedTeamsOverdue, region, Duration.hours(PURGE_SILENT_ALARM_HOURS), "Maximum"),
      threshold: 0,
      missingBreaches: true,
      primaryOnly: true,
    },
    {
      id: "closed-team-subscription-set-aside",
      title: "Closed-team subscription set aside",
      journeys: "J7, J11",
      severity: "P2",
      rule: `ClosedTeamsSetAside above 0 at its maximum over ${2 * PURGE_EVERY_HOURS} hours: closed teams whose subscription the hourly closed-team purge (primary region) won't end or retry for this closure, until a person deals with each one: it belongs to another Stripe customer (CustomerMismatch), Stripe doesn't have it (NotFound), or Stripe refused to end it with an error retrying won't change (PermanentError). The purge sends the gauge every run, so this stays on until each team is handled (stripeSetAsideFor removed), and logs "Closed team's subscription still set aside" with each team's ID and reason. A team set aside isn't purged until ${HELD_PURGE_GRACE_DAYS} days past its deletion date (Deletion overdue fires for it from a day past), and then it's purged with its subscription unresolved, so deal with each one before its deletion date. See docs/journeys.md.`,
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
      id: "stripe-customer-deletion-retrying",
      title: "Stripe customer deletion retrying",
      journeys: "J7, J11",
      severity: "P2",
      rule: `StripeCustomerDeletionOldestHours above ${STRIPE_DELETION_RETRY_ALARM_HOURS} at its maximum over ${2 * PURGE_EVERY_HOURS} hours: the hourly closed-team purge (primary region) deleted a closed team's data on schedule but couldn't delete its Stripe customer (Stripe down, a timeout, a rate limit, a key it couldn't read), queued the customer's deletion, and has retried it every hour for a day without Stripe deleting it. The customer's name, email, address and cards are still in Stripe, and any subscription on it may still bill. The log lines "Stripe customer deletion queued" and "Queued Stripe customer deletion failed" have the team and customer IDs and Stripe's error type and status; the team's deletion record keeps the Stripe IDs. Check Stripe's status and the purge's Stripe key; the purge clears it on its own once Stripe deletes the customer. See docs/journeys.md.`,
      metric: business(BusinessMetric.StripeCustomerDeletionOldestHours, region, TWO_PURGE_RUNS, "Maximum"),
      threshold: STRIPE_DELETION_RETRY_ALARM_HOURS,
      primaryOnly: true,
    },
    {
      id: "stripe-customer-deletion-stuck",
      title: "Stripe customer deletion stuck",
      journeys: "J7, J11",
      severity: "P1",
      rule: `StripeCustomerDeletionOldestHours above ${STRIPE_DELETION_STUCK_DAYS * 24} (${STRIPE_DELETION_STUCK_DAYS} days) at its maximum over ${2 * PURGE_EVERY_HOURS} hours: a purged team's Stripe customer has been queued for deletion for a week, retried every hour, and Stripe still hasn't deleted it, so it isn't an outage: most likely the purge's Stripe key is wrong, revoked or can't be read, or Stripe refuses that customer. Its details stay in Stripe and any subscription may still bill. Delete the customer by hand in the Stripe Dashboard from the IDs in the log line "Queued Stripe customer deletion failed" (or the team's deletion record), then remove its entry from the queue partition (PURGE#STRIPE_DELETIONS). See docs/journeys.md.`,
      metric: business(BusinessMetric.StripeCustomerDeletionOldestHours, region, TWO_PURGE_RUNS, "Maximum"),
      threshold: STRIPE_DELETION_STUCK_DAYS * 24,
      primaryOnly: true,
    },
    {
      id: "lapse-closures-high",
      title: "Lapsed-team closures high",
      journeys: "J10",
      severity: "P2",
      rule: `More than ${LAPSE_CLOSURES_ALARM_COUNT} LapsedTeamsClosed in ${LAPSE_CLOSURES_ALARM_HOURS} hours: the hourly lapsed-team job (primary region) is closing more teams for deletion than expected, even if no single run reached its cap. Check they really lapsed (Logs Insights: "Lapsed team closed for deletion"), and disable the TeamLapseSchedule rule if not: each closed team is purged 24 hours after it closed, and can be reopened until then. See docs/runbooks/lapsed-teams.md.`,
      metric: business(BusinessMetric.LapsedTeamsClosed, region, Duration.hours(LAPSE_CLOSURES_ALARM_HOURS)),
      threshold: LAPSE_CLOSURES_ALARM_COUNT,
      primaryOnly: true,
    },
    {
      id: "lapse-job-out-of-time",
      title: "Lapsed-team job out of time or not running",
      journeys: "J7, J8, J10",
      severity: "P2",
      rule: `LapseTeamsUnstarted above 0, or missing, in every hour for ${LAPSE_UNSTARTED_ALARM_HOURS} hours. Above 0: each run of the hourly lapsed-team job (primary region) ran out of time before it started every lapsing team, so owners' emails and closures are late; runs start at a random place in the list, so no team is always left, but the list has outgrown one run. Missing (missing data breaches): the job isn't running (its schedule is disabled or deleted, or every run fails before it lists the teams, and it sends this gauge with LapseTeamsChecked), so owners of lapsing teams aren't emailed and lapsed teams aren't closed for deletion as the Terms say. See docs/runbooks/lapsed-teams.md.`,
      metric: business(BusinessMetric.LapseTeamsUnstarted, region, Duration.hours(LAPSE_EVERY_HOURS), "Maximum"),
      threshold: 0,
      periods: LAPSE_UNSTARTED_ALARM_HOURS / LAPSE_EVERY_HOURS,
      missingBreaches: true,
      primaryOnly: true,
    },
  ];
}

/**
 * The journey alarms for one region, each notifying its severity's topic.
 * Outside the primary region, the primaryOnly ones are left out. Missing
 * data never alarms (most of these metrics only exist once traffic does),
 * except on a scheduled job's gauge (missingBreaches).
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
        datapointsToAlarm: spec.datapoints ?? spec.periods ?? 1,
        treatMissingData: spec.missingBreaches ? TreatMissingData.BREACHING : TreatMissingData.NOT_BREACHING,
      });
      props.topics.notify(alarm, spec.severity);
      this.alarms.push(alarm);
    }
  }
}
