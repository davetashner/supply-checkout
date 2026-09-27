import { fileURLToPath } from "node:url";
import { Aws, Duration } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { Rule } from "aws-cdk-lib/aws-events";
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
 *   ("Deletion record rewritten").
 * - `failing`: P2 when the watch itself fails ("Deletion records watch
 *   failing"). EventBridge retries it twice; after that the event is gone and
 *   the bucket's access log is what's left.
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
        "P2. Deletion records watch failing: the function that checks deletion records for rewrites threw, so a rewrite could go unseen. " +
        "Its log has the error. Runbook: docs/backups.md, When a deletion record is rewritten.",
      metric: this.fn.metricErrors({ period: FIVE_MINUTES, statistic: "Sum" }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    props.topics.notify(this.failing, "P2");
  }
}
