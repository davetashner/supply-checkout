import { fileURLToPath } from "node:url";
import { Aws, Duration } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, MathExpression, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { EventField, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { DELETION_PREFIXES, DELETIONS_ENV, LIFECYCLE_EXPIRATION, deletionsBucketName } from "../../../backend/src/deletions/names.js";
import { BusinessMetric } from "../../../backend/src/observability/names.js";
import { opsResourceNames } from "../../../backend/src/ops/names.js";
import { bundling } from "../stacks/api-stack.js";
import type { AlarmTopics } from "./alarm-topics.js";
import { LOG_RETENTION } from "./defaults.js";
import { business, FIVE_MINUTES } from "./metrics.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

/**
 * S3 calls on the deletion records bucket that could silence the watch or
 * weaken the records: a lifecycle rule (its expirations make delete markers
 * the watch leaves out), notifications (turning EventBridge off starves it),
 * the bucket policy, replication, ownership, public access, Object Lock and
 * versioning. CloudTrail's names: PutBucketLifecycle is
 * PutBucketLifecycleConfiguration, PutBucketNotification
 * PutBucketNotificationConfiguration.
 */
export const DELETIONS_BUCKET_CHANGE_EVENTS = [
  "PutBucketLifecycle",
  "DeleteBucketLifecycle",
  "PutBucketNotification",
  "PutBucketPolicy",
  "DeleteBucketPolicy",
  "PutBucketReplication",
  "DeleteBucketReplication",
  "PutBucketOwnershipControls",
  "DeleteBucketOwnershipControls",
  "PutBucketPublicAccessBlock",
  "DeleteBucketPublicAccessBlock",
  "PutObjectLockConfiguration",
  "PutBucketVersioning",
] as const;

export interface DeletionRecordsWatchProps {
  readonly envName: string;
  /** The primary region, where the deletion records bucket is. */
  readonly region: string;
  readonly topics: AlarmTopics;
}

/**
 * The deletion records watch (supply-checkout-72d.16), primary region only.
 * A record is written once (If-None-Match), and Object Lock keeps every
 * version, but a version written over a record or a delete marker in front of
 * it would otherwise only be noticed when a restore reads the records.
 *
 * - The bucket sends its object events to EventBridge (data stack). `rule`
 *   passes the function its Object Created events and its Object Deleted
 *   events other than the lifecycle rule's expirations.
 * - `fn` (backend/src/deletions/watch-handler.ts) counts in
 *   DeletionRecordRewrites any deletion, any write to a key that isn't a
 *   record's, and any write to a record's key that now has more than one
 *   version or a delete marker (S3's events don't say whether a write replaced
 *   an object, so it lists the key's versions).
 * - `rewritten`: P2 when DeletionRecordRewrites is above 0 in 5 minutes
 *   ("Deletion record rewritten"). An alarm of its own, never part of an
 *   aggregate like "Needs attention" or "Security attention": an alarm in
 *   ALARM doesn't email again, and users can hold those in ALARM, so this one
 *   must be the only thing that sets it off (supply-checkout-7pe.1).
 * - `failing`: P2 when the watch misses an event ("Deletion records watch
 *   failing"): events Lambda dropped after its retries (AsyncEventsDropped),
 *   and invocations EventBridge couldn't make (FailedInvocations). After
 *   that the event is gone and the bucket's access log is what's left. An
 *   error Lambda's retry gets past loses nothing, so the function's Errors
 *   alone don't alarm (supply-checkout-7pe.1). No reserved concurrency: a new
 *   account's limit can leave nothing to reserve, and a throttled event waits
 *   in Lambda's queue for up to 6 hours, and alarms if it's dropped.
 * - `bucketChanges`: P1 (the level of the rule-tampering alerts) on
 *   DELETIONS_BUCKET_CHANGE_EVENTS, from CloudTrail, CloudFormation's calls
 *   included: one such call (a one-day lifecycle rule, notifications off)
 *   would silence the watch. The P1 topic lets only this rule, by ARN,
 *   publish. The deletions rule-tampering rule (observability-stack.ts),
 *   which the operator rule-tampering rules watch in turn, alerts when this
 *   rule or `rule` is deleted, disabled or retargeted.
 *
 * Why S3's events and not CloudTrail data events: neither says whether a
 * write replaced an object, so either needs the version check. S3's events to
 * EventBridge need no trail, and a trail with S3 data events costs a trail,
 * its bucket and per-event charges for nothing more.
 *
 * Its role may list the versions of record keys (users/*, teams/*) in the
 * one bucket, and nothing else: no reads of a record's contents, no writes.
 */
export class DeletionRecordsWatch extends Construct {
  readonly fn: NodejsFunction;
  readonly rule: Rule;
  readonly rewritten: Alarm;
  readonly failing: Alarm;
  readonly bucketChanges: Rule;

  constructor(scope: Construct, id: string, props: DeletionRecordsWatchProps) {
    super(scope, id);
    const bucket = deletionsBucketName(props.envName, props.region, Aws.ACCOUNT_ID);
    const logGroup = new LogGroup(this, "Logs", { retention: LOG_RETENTION });
    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the deletion records watch",
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    role.addToPolicy(
      new PolicyStatement({
        sid: "ListRecordVersions",
        actions: ["s3:ListBucketVersions"],
        resources: [`arn:${Aws.PARTITION}:s3:::${bucket}`],
        conditions: { StringLike: { "s3:prefix": Object.values(DELETION_PREFIXES).map((p) => `${p}*`) } },
      }),
    );
    this.fn = new NodejsFunction(this, "Function", {
      functionName: opsResourceNames(props.envName).deletionRecordsWatchFunction,
      role,
      logGroup,
      entry: `${BACKEND}src/deletions/watch.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      description: "Alarms when a deletion record is written over or deleted",
      environment: { NODE_OPTIONS: "--enable-source-maps", [DELETIONS_ENV.bucket]: bucket, [DELETIONS_ENV.region]: props.region },
      bundling,
    });

    this.rule = new Rule(this, "Rule", {
      description: "Deletion records: objects written or deleted (not by the lifecycle rule), for the deletion records watch",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["Object Created", "Object Deleted"],
        detail: { bucket: { name: [bucket] }, reason: [{ "anything-but": [LIFECYCLE_EXPIRATION] }] },
      },
    });
    this.rule.addTarget(new LambdaFunction(this.fn, { retryAttempts: 2, maxEventAge: Duration.hours(1) }));

    this.rewritten = new Alarm(this, "Rewritten", {
      alarmName: `supply-checkout-${props.envName}-p2-deletion-record-rewritten`,
      alarmDescription:
        "P2. Deletion record rewritten: a deletion record was written over, deleted or hidden behind a delete marker, or something that isn't a record was written to the bucket. " +
        "The watch's log has the version and request IDs. Runbook: docs/backups.md, When a deletion record is rewritten.",
      metric: business(BusinessMetric.DeletionRecordRewrites, props.region, FIVE_MINUTES),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    props.topics.notify(this.rewritten, "P2");

    this.failing = new Alarm(this, "Failing", {
      alarmName: `supply-checkout-${props.envName}-p2-deletion-records-watch-failing`,
      alarmDescription:
        "P2. Deletion records watch failing: the function that checks deletion records for rewrites gave up on an event after its retries, or EventBridge couldn't invoke it, so a rewrite could go unseen. " +
        "Its log has the error. Runbook: docs/backups.md, When a deletion record is rewritten.",
      metric: new MathExpression({
        expression: "FILL(dropped, 0) + FILL(failed, 0)",
        usingMetrics: {
          dropped: this.fn.metric("AsyncEventsDropped", { period: FIVE_MINUTES, statistic: "Sum" }),
          failed: new Metric({ namespace: "AWS/Events", metricName: "FailedInvocations", dimensionsMap: { RuleName: this.rule.ruleName }, period: FIVE_MINUTES, statistic: "Sum" }),
        },
        period: FIVE_MINUTES,
        label: "Deletion records watch missed events",
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    props.topics.notify(this.failing, "P2");

    this.bucketChanges = new Rule(this, "BucketChanges", {
      description: "Deletion records bucket: lifecycle, notifications, policy, replication, ownership, public access, Object Lock or versioning changed",
      eventPattern: {
        source: ["aws.s3"],
        detailType: ["AWS API Call via CloudTrail"],
        detail: { eventSource: ["s3.amazonaws.com"], eventName: [...DELETIONS_BUCKET_CHANGE_EVENTS], requestParameters: { bucketName: [bucket] } },
      },
    });
    const p1 = props.topics.topics.P1;
    // EventBridge may already use the topics' key (the operator alerts add that, for this account's rules)
    p1.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowDeletionsBucketAlertToPublish",
        principals: [new ServicePrincipal("events.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [p1.topicArn],
        conditions: { ArnEquals: { "aws:SourceArn": this.bucketChanges.ruleArn } },
      }),
    );
    const message = RuleTargetInput.fromText(
      `Supply Checkout ${props.envName}: ${EventField.fromPath("$.detail.eventName")} on the deletion records bucket at ${EventField.fromPath("$.detail.eventTime")} (CloudTrail event ${EventField.fromPath("$.detail.eventID")} says who). Expected only during a deploy of the data stack. Otherwise follow "When the deletion records bucket is changed" in docs/backups.md.`,
    );
    // A plain target: events-targets' SnsTopic would add a topic policy for every rule in the account
    this.bucketChanges.addTarget({ bind: () => ({ arn: p1.topicArn, input: message }) });
  }
}
