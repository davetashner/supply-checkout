import { fileURLToPath } from "node:url";
import { Aws, Duration, Stack, Validations } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { billingResourceNames, STRIPE_ENV, stripeSecretName, type StripeMode } from "../../../backend/src/billing/names.js";
import {
  CLOSED_TEAMS_PARTITION,
  COMMITTING_IMPORTS_PARTITION,
  GSI1,
  GSI3,
  LAPSE_CLOSE_ATTRIBUTES,
  LAPSE_LIST_ATTRIBUTES,
  LAPSE_OWNER_ATTRIBUTES,
  LAPSE_PREFIX,
  LAPSE_READ_ATTRIBUTES,
  LAPSE_RECORD_ATTRIBUTES,
  OPS_OWNERS_PREFIX,
  OPS_TEAMS_PARTITION,
  SEAT_RECONCILE_ATTRIBUTES,
  STRIPE_DELETION_ATTRIBUTES,
  STRIPE_DELETIONS_PARTITION,
  STUCK_IMPORT_ATTRIBUTES,
  TEAM_PURGE_ATTRIBUTES,
  TEAM_PURGE_MARK_ATTRIBUTES,
  TEAM_PURGE_READ_ATTRIBUTES,
} from "../../../backend/src/data/schema.js";
import { BusinessMetric } from "../../../backend/src/observability/names.js";
import {
  CHECK_EVERY_MINUTES,
  LAPSE_BUDGET_MS,
  LAPSE_EVERY_HOURS,
  LAPSE_SILENT_ALARM_HOURS,
  OPS_ENV,
  opsResourceNames,
  PURGE_BUDGET_MS,
  PURGE_EVERY_HOURS,
  PURGE_SILENT_ALARM_HOURS,
  SEAT_RECONCILE_HOUR_UTC,
  SEAT_RECONCILE_SILENT_ALARM_DAYS,
} from "../../../backend/src/ops/names.js";
import { type DeploymentConfig, stripeSecretArn } from "../config.js";
import { grantPutDeletionRecords } from "../deletions.js";
import { grantSendEmail } from "../email.js";
import { bundling } from "../stacks/api-stack.js";
import type { AlarmTopics } from "./alarm-topics.js";
import { LOG_RETENTION } from "./defaults.js";
import { business } from "./metrics.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

export interface OpsChecksProps {
  readonly envName: string;
  /** The app table's name (a global table has the same name in every region). */
  readonly tableName: string;
  /** This region's alarm topics, for the alarm on the purge itself. */
  readonly topics: AlarmTopics;
  /** Which Stripe secret key the purge reads (stripeModeOf), to end closed teams' subscriptions and delete purged teams' customers. */
  readonly stripeMode: StripeMode;
  /** The deployment, for the app's email settings (grantSendEmail): the lapsed-team job emails owners. */
  readonly config: DeploymentConfig;
}

/**
 * Scheduled checks that turn state no AWS metric shows into business-metric
 * gauges for the journey alarms (backend/src/ops), in the primary region
 * only: the table is global, so one region's index sees every team's imports,
 * and SES sends from the primary region.
 *
 * - `stuckImports`: counts inventory imports still committing an hour after
 *   they started (StuckImports, "Imports stuck"). Its role may only Query
 *   GSI1's committing-imports partition, naming and reading only the keys and
 *   progress (dynamodb:LeadingKeys, dynamodb:Attributes, dynamodb:Select), so
 *   it can't read any team's data. A scheduled check was chosen over counting
 *   starts and finishes because an import can be retried and finished hours
 *   later, which counts can't tell from a stuck one; the index lists exactly
 *   the jobs not finished, and the Query is of a partition that's normally
 *   empty.
 * - `emailQuota`: SES's 24-hour sends against its quota
 *   (EmailQuotaUsedPercent, "Near the sending limit"). ses:GetAccount only.
 * - `teamPurge` isn't a check: every PURGE_EVERY_HOURS it deletes the closed
 *   teams whose read-only period has ended (backend/src/ops/team-purge-handler.ts).
 *   It may Query only GSI1's closed-teams partition there (listing keys, or
 *   Select COUNT for its overdue gauge), and on the table only GetItem, Query
 *   (SPECIFIC_ATTRIBUTES) and DeleteItem on `TEAM#`, `USER#` and `STRIPE#`
 *   partitions, naming only TEAM_PURGE_ATTRIBUTES (keys, the closure fields,
 *   the Stripe customer and link), and UpdateItem on `TEAM#` partitions
 *   naming only TEAM_PURGE_MARK_ATTRIBUTES, to mark a team `purging` before
 *   it deletes anything: it deletes whole items without reading documents,
 *   emails or names. A GetItem of a `TEAM#` item may also name the team's
 *   test mark (TEAM_PURGE_READ_ATTRIBUTES, supply-checkout-o60.12), which
 *   only tags its metrics. The partitions are wildcards because it acts on
 *   whichever teams are due, which only the table's own index names; no
 *   request reaches it. `purgeNotRunning` alarms when its ClosedTeamsOverdue
 *   gauge stops arriving ("Deletion job not running", docs/journeys.md).
 *   Once a team is marked, and before it deletes anything, it writes the
 *   team's deletion record: s3:PutObject under `teams/` in the deletion
 *   records bucket only. It also ends closed teams' Stripe subscriptions
 *   and deletes purged teams' Stripe customers (supply-checkout-t0en,
 *   backend/src/billing/closing.ts): it reads GSI1's closed-teams partition
 *   for them (TEAM_PURGE_ATTRIBUTES includes the Stripe subscription and
 *   `stripeCancelledFor`), records each with the same UpdateItem grant
 *   (TEAM_PURGE_MARK_ATTRIBUTES includes `stripeCancelledFor`, still never
 *   `closedAt`), records one it sets aside for a person the same way
 *   (`stripeSetAsideFor` and `stripeSetAsideReason`, in both lists,
 *   supply-checkout-8jc.17, supply-checkout-8jc.36), counts those on the same
 *   index for its ClosedTeamsSetAside gauge, and may read the one Stripe secret key for this
 *   environment and mode (secretsmanager:GetSecretValue on its ARN only).
 *   When Stripe can't delete a purged team's customer, it still deletes the
 *   team's data and queues the customer's deletion (supply-checkout-8jc.42):
 *   PutItem, Query (SPECIFIC_ATTRIBUTES) and DeleteItem on the one
 *   STRIPE_DELETIONS_PARTITION only, naming only STRIPE_DELETION_ATTRIBUTES
 *   (keys, the team, its Stripe customer, when it was queued). Its
 *   StripeCustomerDeletionOldestHours gauge has its own alarms
 *   ("Stripe customer deletion retrying" and "stuck", journey-alarms.ts).
 *
 * - `seatReconcile` (supply-checkout-l50): nightly at SEAT_RECONCILE_HOUR_UTC,
 *   it queues a seat check on the seat sync queue for every open team with a
 *   Stripe customer (backend/src/ops/seat-reconcile-handler.ts); the billing
 *   worker compares and alarms on drift ("Seat counts drifting"). It may Query
 *   only GSI3's OPS#TEAMS partition, naming and reading only
 *   SEAT_RECONCILE_ATTRIBUTES (keys, Stripe customer, closure, status), and
 *   sqs:SendMessage on the seat sync queue (by its name, from the api stack).
 *   No team partition, no Stripe key. `seatReconcileNotRunning` alarms when
 *   its SeatReconcileTeams gauge stops arriving.
 *
 * - `teamLapse` (supply-checkout-qdx): every LAPSE_EVERY_HOURS it emails the
 *   owners of teams whose billing lapsed or is about to (an app trial ending
 *   or ended, a payment overdue past its grace, a deletion warning) and closes
 *   lapsed teams for the purge once they were warned and Stripe confirms
 *   nothing is live (backend/src/ops/team-lapse-handler.ts). Its role may:
 *   Query GSI3's OPS#TEAMS partition naming only LAPSE_LIST_ATTRIBUTES and
 *   its OPS#OWNERS#* partitions naming only LAPSE_OWNER_ATTRIBUTES (an owner's
 *   email, for the notices); GetItem on `TEAM#` items naming only
 *   LAPSE_READ_ATTRIBUTES (billing fields, the name, Stripe IDs, version,
 *   and the test mark, which only tags its metrics);
 *   UpdateItem there naming only LAPSE_CLOSE_ATTRIBUTES, returning nothing
 *   (the closure: never status, plan, comps or Stripe IDs); GetItem and
 *   PutItem in `LAPSE#` partitions (its own records) naming only
 *   LAPSE_RECORD_ATTRIBUTES; send the app's email (grantSendEmail); and read
 *   the Stripe secret key. No Scan, no DeleteItem, no Query of a team's
 *   partition, so it never reads projects, inventory or members' data.
 *   `lapseNotRunning` alarms when its LapseTeamsChecked gauge stops arriving.
 *   It has no async retries, and one run at a time holds its lease (a
 *   `LAPSE#RUN` record), so a timeout or duplicate never doubles its closures.
 *
 * The checks run every CHECK_EVERY_MINUTES from an EventBridge rule, each with its own
 * log group and a role that writes only to it. A failed run shows in the
 * Lambda errors alarm; the gauge alarms treat missing data as not breaching.
 */
export class OpsChecks extends Construct {
  readonly stuckImports: NodejsFunction;
  readonly emailQuota: NodejsFunction;
  readonly teamPurge: NodejsFunction;
  /** "Deletion job not running": no ClosedTeamsOverdue sample for PURGE_SILENT_ALARM_HOURS (J11). */
  readonly purgeNotRunning: Alarm;
  readonly seatReconcile: NodejsFunction;
  /** "Seat reconciliation not running": no SeatReconcileTeams sample for SEAT_RECONCILE_SILENT_ALARM_DAYS (J7). */
  readonly seatReconcileNotRunning: Alarm;
  readonly teamLapse: NodejsFunction;
  /** "Lapsed-team job not running": no LapseTeamsChecked sample for LAPSE_SILENT_ALARM_HOURS (J7, J8, J10). */
  readonly lapseNotRunning: Alarm;

  constructor(scope: Construct, id: string, props: OpsChecksProps) {
    super(scope, id);
    const names = opsResourceNames(props.envName);
    const tableArn = Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: props.tableName });

    this.stuckImports = this.check("StuckImports", "stuck-imports", {
      functionName: names.stuckImportsFunction,
      description: "Counts inventory imports still committing an hour after they started",
      environment: { [OPS_ENV.tableName]: props.tableName },
    });
    this.stuckImports.addToRolePolicy(
      new PolicyStatement({
        sid: "CommittingImportsOnly",
        actions: ["dynamodb:Query"],
        resources: [`${tableArn}/index/${GSI1}`],
        conditions: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": [COMMITTING_IMPORTS_PARTITION],
            "dynamodb:Attributes": [...STUCK_IMPORT_ATTRIBUTES],
          },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    const tableKey = StringParameter.valueForStringParameter(this, `/supply-checkout/${props.envName}/data/table-key-arn`);
    this.stuckImports.addToRolePolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [tableKey],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );

    this.emailQuota = this.check("EmailQuota", "email-quota", {
      functionName: names.emailQuotaFunction,
      description: "Sends the share of the SES 24-hour sending quota used",
      environment: {},
    });
    this.emailQuota.addToRolePolicy(new PolicyStatement({ sid: "ReadSendQuota", actions: ["ses:GetAccount"], resources: ["*"] }));
    Validations.of(this.emailQuota.role as Role).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "ses:GetAccount reads the account's sending quota and has no resource-level permissions",
    });

    this.teamPurge = this.check(
      "TeamPurge",
      "team-purge",
      {
        functionName: names.teamPurgeFunction,
        description: "Ends closed teams' Stripe subscriptions, deletes closed teams once their 30-day read-only period ends, and deletes their Stripe customers (retrying those Stripe couldn't)",
        environment: { [OPS_ENV.tableName]: props.tableName, [STRIPE_ENV.secretId]: stripeSecretName(props.envName, props.stripeMode), [STRIPE_ENV.mode]: props.stripeMode },
      },
      { every: Duration.hours(PURGE_EVERY_HOURS), timeout: Duration.millis(PURGE_BUDGET_MS + 60_000) },
    );
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "ClosedTeamsIndexOnly",
        actions: ["dynamodb:Query"],
        resources: [`${tableArn}/index/${GSI1}`],
        conditions: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": [CLOSED_TEAMS_PARTITION],
            "dynamodb:Attributes": [...TEAM_PURGE_ATTRIBUTES],
          },
          // Keys for the listing, or only a count for the overdue gauge
          StringEquals: { "dynamodb:Select": ["SPECIFIC_ATTRIBUTES", "COUNT"] },
        },
      }),
    );
    const purgePartitions = { "dynamodb:LeadingKeys": ["TEAM#*", "USER#*", "STRIPE#*"] };
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "ListClosedTeamKeys",
        // A team partition's keys, and nothing else: the Select must be explicit
        actions: ["dynamodb:Query"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": purgePartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...TEAM_PURGE_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "DeleteClosedTeamItems",
        // GetItem reads a team's closure fields (dynamodb:Attributes), DeleteItem
        // removes each item, returning nothing
        actions: ["dynamodb:GetItem", "dynamodb:DeleteItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": purgePartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...TEAM_PURGE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
      }),
    );
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadClosedTeamTestMark",
        // A closed team's META item read as DeleteClosedTeamItems allows, with its test mark
        // (supply-checkout-o60.12), which only tags the purge's metrics. GetItem only, team
        // partitions only, projected: the index, the key listings and the deletes never name it
        actions: ["dynamodb:GetItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...TEAM_PURGE_READ_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "MarkClosedTeamPurging",
        // Two updates, each conditioned on the META item's purgeAfter: `purging`, before
        // anything is deleted, so reopenTeam refuses it from then on, and
        // `stripeCancelledFor`, once its subscription is set to end (or `stripeSetAsideFor` and
        // `stripeSetAsideReason`, once it's set aside for a person). Not closedAt: this
        // grant can't close or reopen a team
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...TEAM_PURGE_MARK_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
      }),
    );
    // The Stripe customer deletions it still owes (supply-checkout-8jc.42): one fixed partition, a
    // team's ID, its customer's and a time, so it can't reach a team's or anyone's other items here
    const stripeDeletions = { "dynamodb:LeadingKeys": [STRIPE_DELETIONS_PARTITION], "dynamodb:Attributes": [...STRIPE_DELETION_ATTRIBUTES] };
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "QueueStripeCustomerDeletions",
        // Queued before a team's items go when Stripe can't delete its customer, removed once it has
        actions: ["dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringEquals": stripeDeletions,
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
      }),
    );
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "ListStripeCustomerDeletions",
        actions: ["dynamodb:Query"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringEquals": stripeDeletions,
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        // DynamoDB encrypts and decrypts items with its cached table key, so reads, deletes and writes
        // (the UpdateItem marks, and the PutItem of a queued Stripe customer deletion) need only Decrypt.
        // Checked after the first deploy: KMS AccessDenied for this role in CloudTrail would mean adding
        // kms:Encrypt and kms:GenerateDataKey here, with the same ViaService condition (docs/journeys.md, J11)
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [tableKey],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );
    // The Stripe secret key: this one secret only, in this (the primary) region. It's encrypted
    // with Secrets Manager's AWS-managed key, which allows its use through Secrets Manager
    this.teamPurge.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadStripeSecretKey",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [stripeSecretArn({ partition: Aws.PARTITION, region: Stack.of(this).region, account: Aws.ACCOUNT_ID }, props.envName, props.stripeMode)],
      }),
    );
    // The checks run in the primary region only, so this stack's region is the bucket's
    grantPutDeletionRecords(this.teamPurge, { envName: props.envName, primaryRegion: Stack.of(this).region }, "team");
    Validations.of(this.teamPurge.role as Role).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "The purge deletes whichever closed teams are due, named only by the table's own closed-teams index: the TEAM#, USER# and STRIPE# partition wildcards are in dynamodb:LeadingKeys, with dynamodb:Attributes limiting it to keys and closure fields",
    });

    // The purge sends its gauge every run that reads the index. No sample for this long means the
    // schedule is off or deleted, or every run fails before it can count: missing data breaches.
    this.purgeNotRunning = new Alarm(this, "PurgeNotRunning", {
      alarmName: `supply-checkout-${props.envName}-p2-deletion-not-running`,
      alarmDescription: [
        `P2 Deletion job not running (J11, ${Stack.of(this).region}).`,
        `No ClosedTeamsOverdue sample from the hourly closed-team purge for ${PURGE_SILENT_ALARM_HOURS} hours: its schedule is disabled or deleted, or every run fails before it reads the closed-teams index. Closed teams aren't being deleted, and Deletion overdue can't see it.`,
        "Thresholds and runbooks: docs/journeys.md, Alarms for blocked journeys.",
      ].join(" "),
      metric: business(BusinessMetric.ClosedTeamsOverdue, Stack.of(this).region, Duration.hours(PURGE_SILENT_ALARM_HOURS), "SampleCount"),
      threshold: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: TreatMissingData.BREACHING,
    });
    props.topics.notify(this.purgeNotRunning, "P2");

    // The nightly seat reconciliation: lists teams from the operators' index, queues checks for the billing worker on the seat sync queue
    const seatQueue = billingResourceNames(props.envName).seatQueue;
    this.seatReconcile = this.check(
      "SeatReconcile",
      "seat-reconcile",
      {
        functionName: names.seatReconcileFunction,
        description: "Queues a nightly seat quantity check for every open team with a Stripe customer",
        environment: {
          [OPS_ENV.tableName]: props.tableName,
          [OPS_ENV.seatQueueUrl]: `https://sqs.${Aws.REGION}.${Aws.URL_SUFFIX}/${Aws.ACCOUNT_ID}/${seatQueue}`,
        },
      },
      { schedule: Schedule.cron({ minute: "0", hour: String(SEAT_RECONCILE_HOUR_UTC) }), timeout: Duration.minutes(5) },
    );
    this.seatReconcile.addToRolePolicy(
      new PolicyStatement({
        sid: "TeamsIndexOnly",
        actions: ["dynamodb:Query"],
        resources: [`${tableArn}/index/${GSI3}`],
        conditions: {
          "ForAllValues:StringEquals": {
            "dynamodb:LeadingKeys": [OPS_TEAMS_PARTITION],
            "dynamodb:Attributes": [...SEAT_RECONCILE_ATTRIBUTES],
          },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.seatReconcile.addToRolePolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [tableKey],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );
    // SendMessageBatch is authorized as sqs:SendMessage
    this.seatReconcile.addToRolePolicy(new PolicyStatement({ sid: "QueueSeatChecks", actions: ["sqs:SendMessage"], resources: [Stack.of(this).formatArn({ service: "sqs", resource: seatQueue })] }));

    // The run sends its gauge every night. Two days without one means the schedule is off or
    // every run fails before it can count: missing data breaches, and drift would go unseen.
    this.seatReconcileNotRunning = new Alarm(this, "SeatReconcileNotRunning", {
      alarmName: `supply-checkout-${props.envName}-p2-seat-reconcile-not-running`,
      alarmDescription: [
        `P2 Seat reconciliation not running (J7, ${Stack.of(this).region}).`,
        `No SeatReconcileTeams sample from the nightly seat reconciliation for ${SEAT_RECONCILE_SILENT_ALARM_DAYS} days: its schedule is disabled or deleted, or every run fails before it lists the teams. Seat drift isn't being caught, and Seat counts drifting can't see it.`,
        "Thresholds and runbooks: docs/journeys.md, Alarms for blocked journeys.",
      ].join(" "),
      metric: business(BusinessMetric.SeatReconcileTeams, Stack.of(this).region, Duration.days(1), "SampleCount"),
      threshold: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: SEAT_RECONCILE_SILENT_ALARM_DAYS,
      datapointsToAlarm: SEAT_RECONCILE_SILENT_ALARM_DAYS,
      treatMissingData: TreatMissingData.BREACHING,
    });
    props.topics.notify(this.seatReconcileNotRunning, "P2");

    // The lapsed-team job (supply-checkout-qdx): emails owners of lapsing teams and closes lapsed ones for the purge
    this.teamLapse = this.check(
      "TeamLapse",
      "team-lapse",
      {
        functionName: names.teamLapseFunction,
        description: "Emails owners of teams whose trial or subscription lapsed, and closes lapsed teams for deletion once warned",
        environment: { [OPS_ENV.tableName]: props.tableName, [STRIPE_ENV.secretId]: stripeSecretName(props.envName, props.stripeMode), [STRIPE_ENV.mode]: props.stripeMode },
      },
      { every: Duration.hours(LAPSE_EVERY_HOURS), timeout: Duration.millis(LAPSE_BUDGET_MS + 60_000) },
    );
    // No async retries either (the schedule's target has none): a run that times out waits for the next hour, so its
    // closure cap holds per hour. Duplicates and hand-started runs are kept out by its lease (claimLapseRun), not by
    // reserved concurrency, which would take from the account's unreserved pool (it must keep 100) and can fail the deploy
    this.teamLapse.configureAsyncInvoke({ retryAttempts: 0 });
    this.teamLapse.addToRolePolicy(
      new PolicyStatement({
        sid: "LapsingTeamsIndexOnly",
        actions: ["dynamodb:Query"],
        resources: [`${tableArn}/index/${GSI3}`],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [OPS_TEAMS_PARTITION], "dynamodb:Attributes": [...LAPSE_LIST_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.teamLapse.addToRolePolicy(
      new PolicyStatement({
        sid: "OwnerEmailsIndexOnly",
        actions: ["dynamodb:Query"],
        resources: [`${tableArn}/index/${GSI3}`],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${OPS_OWNERS_PREFIX}*`] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...LAPSE_OWNER_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.teamLapse.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadTeamBilling",
        actions: ["dynamodb:GetItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...LAPSE_READ_ATTRIBUTES] },
          // As the reopen role's: a projection (which sets Select SPECIFIC_ATTRIBUTES), never the whole item
          StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.teamLapse.addToRolePolicy(
      new PolicyStatement({
        sid: "CloseLapsedTeam",
        // The closure only, conditioned in code on the version read; never status, plan, comps or Stripe IDs
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...LAPSE_CLOSE_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
      }),
    );
    this.teamLapse.addToRolePolicy(
      new PolicyStatement({
        sid: "LapseRecords",
        // Its own notice and warning records, in LAPSE# partitions only
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${LAPSE_PREFIX}*`] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...LAPSE_RECORD_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
      }),
    );
    this.teamLapse.addToRolePolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        // As the purge's: Decrypt only, checked after the first deploy (docs/runbooks/lapsed-teams.md)
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [tableKey],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );
    this.teamLapse.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadStripeSecretKey",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [stripeSecretArn({ partition: Aws.PARTITION, region: Stack.of(this).region, account: Aws.ACCOUNT_ID }, props.envName, props.stripeMode)],
      }),
    );
    grantSendEmail(this.teamLapse, props.config);
    Validations.of(this.teamLapse.role as Role).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "The lapsed-team job reads and closes whichever teams the operators' index lists as lapsing: the TEAM#*, OPS#OWNERS#* and LAPSE#* partition wildcards are in dynamodb:LeadingKeys, with dynamodb:Attributes limiting each to the billing fields, the closure, owners' emails and its own records. LeadingKeys can't limit the sort key, so GetItem and UpdateItem could reach any item in a team's partition, but only those attributes (the code names only the META item, and the closure is conditioned on attribute_exists(PK) and the version)",
    });

    this.lapseNotRunning = new Alarm(this, "LapseNotRunning", {
      alarmName: `supply-checkout-${props.envName}-p2-lapse-not-running`,
      alarmDescription: [
        `P2 Lapsed-team job not running (J7, J8, J10, ${Stack.of(this).region}).`,
        `No LapseTeamsChecked sample from the hourly lapsed-team job for ${LAPSE_SILENT_ALARM_HOURS} hours: its schedule is disabled or deleted, or every run fails before it lists the teams. Owners of lapsing teams aren't being emailed, and lapsed teams aren't being closed for deletion as the Terms say.`,
        "Thresholds and runbooks: docs/journeys.md, Alarms for blocked journeys, and docs/runbooks/lapsed-teams.md.",
      ].join(" "),
      metric: business(BusinessMetric.LapseTeamsChecked, Stack.of(this).region, Duration.hours(LAPSE_SILENT_ALARM_HOURS), "SampleCount"),
      threshold: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: TreatMissingData.BREACHING,
    });
    props.topics.notify(this.lapseNotRunning, "P2");
  }

  /** A function from backend/src/ops/<name>.ts, run on the schedule (every CHECK_EVERY_MINUTES unless `every` says). */
  private check(
    id: string,
    name: string,
    props: { functionName: string; description: string; environment: Record<string, string> },
    options: { every?: Duration; schedule?: Schedule; timeout?: Duration } = {},
  ): NodejsFunction {
    const every = options.every ?? Duration.minutes(CHECK_EVERY_MINUTES);
    const schedule = options.schedule ?? Schedule.rate(every);
    const logGroup = new LogGroup(this, `${id}Logs`, { retention: LOG_RETENTION });
    const role = new Role(this, `${id}Role`, {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: `Execution role for the ${name} check`,
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    const fn = new NodejsFunction(this, id, {
      functionName: props.functionName,
      role,
      logGroup,
      entry: `${BACKEND}src/ops/${name}.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: options.timeout ?? Duration.seconds(30),
      description: props.description,
      environment: { NODE_OPTIONS: "--enable-source-maps", ...props.environment },
      bundling,
    });
    new Rule(this, `${id}Schedule`, {
      description: options.schedule ? `Runs the ${name} function on ${schedule.expressionString}` : `Runs the ${name} function every ${every.toHumanString()}`,
      schedule,
      // The next run is soon; a retry would only double the gauge (or the purge's work)
      targets: [new LambdaFunction(fn, { retryAttempts: 0 })],
    });
    return fn;
  }
}
