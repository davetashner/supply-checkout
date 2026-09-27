import { fileURLToPath } from "node:url";
import { Aws, Duration, Validations } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { Policy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, EventSourceMapping, FilterCriteria, FilterRule, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { OPERATOR_AUDIT_PREFIX } from "../../../backend/src/data/schema.js";
import { BusinessMetric } from "../../../backend/src/observability/names.js";
import { opsResourceNames } from "../../../backend/src/ops/names.js";
import { bundling } from "../stacks/api-stack.js";
import type { AlarmTopics } from "./alarm-topics.js";
import { LOG_RETENTION } from "./defaults.js";
import { business, FIVE_MINUTES } from "./metrics.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

export interface OperatorAuditWatchProps {
  readonly envName: string;
  /** The primary region, where the ops function writes the audit. */
  readonly region: string;
  readonly topics: AlarmTopics;
}

/**
 * The operator audit watch (supply-checkout-6uw.5, ADR 0015), primary region
 * only. Operator audit items are append-only, but the operator-access role's
 * PutItem could replace one; nothing in the app ever changes or deletes one.
 *
 * - `fn` (backend/src/ops/operator-audit-watch-handler.ts) reads the table's
 *   stream through an event source mapping whose filter passes only MODIFY
 *   and REMOVE records of `OPAUDIT#` partitions, so it never sees team data.
 *   It counts each change that isn't a TTL expiry in OperatorAuditChanged.
 *   One region is enough: a global table's stream holds every replica's
 *   writes. It's the stream's second consumer, after the live-update
 *   publisher; DynamoDB advises at most two per shard.
 * - `changed`: P1 when OperatorAuditChanged is above 0 in 5 minutes
 *   ("Operator audit changed").
 * - `failing`: P2 when the watch itself fails, since then a change could go
 *   unseen ("Operator audit watch failing"). After its retries a batch is
 *   dropped, and the log and CloudTrail are what's left.
 *
 * Its role may read only the stream (and decrypt through DynamoDB); it has no
 * table access at all.
 */
export class OperatorAuditWatch extends Construct {
  readonly fn: NodejsFunction;
  readonly changed: Alarm;
  readonly failing: Alarm;

  constructor(scope: Construct, id: string, props: OperatorAuditWatchProps) {
    super(scope, id);
    const logGroup = new LogGroup(this, "Logs", { retention: LOG_RETENTION });
    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the operator audit watch",
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    this.fn = new NodejsFunction(this, "Function", {
      functionName: opsResourceNames(props.envName).operatorAuditWatchFunction,
      role,
      logGroup,
      entry: `${BACKEND}src/ops/operator-audit-watch.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      description: "Alarms on any change or deletion of an operator audit item other than its TTL expiry",
      environment: { NODE_OPTIONS: "--enable-source-maps" },
      bundling,
    });

    const streamArn = StringParameter.valueForStringParameter(this, `/supply-checkout/${props.envName}/data/table-stream-arn`);
    const tableKey = StringParameter.valueForStringParameter(this, `/supply-checkout/${props.envName}/data/table-key-arn`);
    role.addToPolicy(
      new PolicyStatement({
        sid: "ReadTableStream",
        actions: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"],
        resources: [streamArn],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [tableKey],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );
    // Lambda's stream poller also asks for ListStreams, which has no resource-level permissions
    const listStreams = new Policy(this, "ListStreams", {
      statements: [new PolicyStatement({ actions: ["dynamodb:ListStreams"], resources: ["*"] })],
    });
    listStreams.attachToRole(role);
    Validations.of(listStreams).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "dynamodb:ListStreams doesn't support resource-level permissions; it lists stream ARNs and reads no data.",
    });

    new EventSourceMapping(this, "TableStream", {
      target: this.fn,
      eventSourceArn: streamArn,
      startingPosition: StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: Duration.seconds(0),
      bisectBatchOnError: true,
      retryAttempts: 5,
      // Only changes and deletions of operator audit items reach the function
      filters: [
        FilterCriteria.filter({
          eventName: FilterRule.or("MODIFY", "REMOVE"),
          dynamodb: { Keys: { PK: { S: FilterRule.beginsWith(OPERATOR_AUDIT_PREFIX) } } },
        }),
      ],
    });

    this.changed = new Alarm(this, "Changed", {
      alarmName: `supply-checkout-${props.envName}-p1-operator-audit-changed`,
      alarmDescription:
        "P1. Operator audit changed: an OPAUDIT# item was modified, replaced or deleted other than by its TTL. Operator audit items are append-only, so this is tampering or a bug. The watch's log has the item's keys; follow \"Operators\" in docs/infrastructure.md.",
      metric: business(BusinessMetric.OperatorAuditChanged, props.region, FIVE_MINUTES),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    props.topics.notify(this.changed, "P1");

    this.failing = new Alarm(this, "Failing", {
      alarmName: `supply-checkout-${props.envName}-p2-operator-audit-watch-failing`,
      alarmDescription: "P2. Operator audit watch failing: the function that watches operator audit items for changes threw, so a change could go unseen. Its log has the error.",
      metric: this.fn.metricErrors({ period: FIVE_MINUTES, statistic: "Sum" }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    props.topics.notify(this.failing, "P2");
  }
}
