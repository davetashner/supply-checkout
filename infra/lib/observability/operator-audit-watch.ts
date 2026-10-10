import { fileURLToPath } from "node:url";
import { Aws, Duration, Stack, Validations } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { Policy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, EventSourceMapping, FilterCriteria, FilterRule, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { OPERATOR_AUDIT_HEARTBEAT, OPERATOR_AUDIT_PREFIX } from "../../../backend/src/data/schema.js";
import { BusinessMetric } from "../../../backend/src/observability/names.js";
import { HEARTBEAT_EVERY_MINUTES, HEARTBEAT_SILENT_ALARM_MINUTES, opsResourceNames } from "../../../backend/src/ops/names.js";
import { bundling } from "../stacks/api-stack.js";
import type { AlarmTopics } from "./alarm-topics.js";
import { LOG_RETENTION } from "./defaults.js";
import { business, FIVE_MINUTES } from "./metrics.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

export interface OperatorAuditWatchProps {
  readonly envName: string;
  /** The primary region, where the ops function writes the audit. */
  readonly region: string;
  /** The app table's name, for the heartbeat. */
  readonly tableName: string;
  readonly topics: AlarmTopics;
}

/**
 * The operator audit watch (supply-checkout-6uw.5, ADR 0015), primary region
 * only. Operator audit items are append-only, but the operator-access role's
 * PutItem could replace one; nothing in the app ever changes or deletes one.
 *
 * - `fn` (backend/src/ops/operator-audit-watch-handler.ts) reads the table's
 *   stream through an event source mapping (`mapping`) whose filter passes
 *   only MODIFY and REMOVE records of `OPAUDIT#` partitions, and INSERTs of
 *   their `AUDIT#` items, so it never sees team data. It counts each change
 *   that isn't a TTL expiry, and each new audit entry set to expire well
 *   before its 2 years (supply-checkout-6uw.11), in OperatorAuditChanged.
 *   One region is enough: a global table's stream holds every replica's
 *   writes. It's the stream's second consumer, after the live-update
 *   publisher; DynamoDB advises at most two per shard.
 * - `changed`: P1 when OperatorAuditChanged is above 0 in 5 minutes
 *   ("Operator audit changed").
 * - No alarm on the function's own errors (there was one, "Operator audit
 *   watch failing", until supply-checkout-7pe.1): a batch that fails is
 *   retried, so an error that passes loses nothing, and one that doesn't
 *   ends in the dead-letter queue (`dropped`) within its retries, while a
 *   watch that keeps failing stops counting heartbeats (`silent`).
 * - `deadLetterQueue`: where a batch the watch gave up on after its retries
 *   is recorded (its shard and sequence numbers, never the items), and
 *   `dropped`: P2 when anything is in it ("Operator audit watch dropped
 *   records"). The records are still in the stream for 24 hours, and in the
 *   table's point-in-time recovery after that.
 * - `heartbeat`: an EventBridge Scheduler schedule that rewrites one item,
 *   OPERATOR_AUDIT_HEARTBEAT, every HEARTBEAT_EVERY_MINUTES with DynamoDB's
 *   PutItem directly (no function), and `silent`: P2 when the watch hasn't
 *   counted one in HEARTBEAT_SILENT_ALARM_MINUTES ("Operator audit watch
 *   silent"; missing data breaches). Whatever stops the watch reading the
 *   stream or its metric reaching CloudWatch shows here: the mapping disabled
 *   or deleted, zero concurrency, the role, a stream resource policy, the
 *   stream turned off, the table key disabled or its policy changed, the log
 *   group deleted (the role can't recreate it) or transformed, or the
 *   schedule itself stopped. An iterator-age alarm was the other choice, but
 *   Lambda sends IteratorAge only when it invokes the function, and the
 *   filter means it's rarely invoked: a stalled read would look like quiet.
 *   The schedule's role may PutItem only that item's keys and `at`.
 *
 * The observability stack's EventBridge rules alert P1 when the mapping, the
 * function, its role, its log group, the table's stream or key, or these
 * alarms are changed outside a deploy.
 *
 * Its role may read only the stream (and decrypt through DynamoDB); it has no
 * table access at all.
 */
export class OperatorAuditWatch extends Construct {
  readonly fn: NodejsFunction;
  readonly role: Role;
  readonly mapping: EventSourceMapping;
  readonly deadLetterQueue: Queue;
  readonly changed: Alarm;
  readonly dropped: Alarm;
  readonly silent: Alarm;
  readonly logGroup: LogGroup;
  readonly heartbeat: CfnSchedule;
  /** The app table's ARN in this region, and its key's (from SSM), for the rules on its stream and key. */
  readonly tableArn: string;
  readonly tableKeyArn: string;

  constructor(scope: Construct, id: string, props: OperatorAuditWatchProps) {
    super(scope, id);
    const logGroup = (this.logGroup = new LogGroup(this, "Logs", { retention: LOG_RETENTION }));
    const role = (this.role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the operator audit watch",
    }));
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
    const tableKey = (this.tableKeyArn = StringParameter.valueForStringParameter(this, `/supply-checkout/${props.envName}/data/table-key-arn`));
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

    this.deadLetterQueue = new Queue(this, "DeadLetterQueue", {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(this.deadLetterQueue).acknowledge({
      id: "AwsSolutions-SQS3",
      reason: "This is the dead-letter queue: it holds the stream positions of batches the operator audit watch gave up on.",
    });

    this.mapping = new EventSourceMapping(this, "TableStream", {
      target: this.fn,
      eventSourceArn: streamArn,
      startingPosition: StartingPosition.LATEST,
      batchSize: 100,
      maxBatchingWindow: Duration.seconds(0),
      bisectBatchOnError: true,
      retryAttempts: 5,
      // A batch given up on is recorded, and alarms (`dropped`)
      onFailure: new SqsDlq(this.deadLetterQueue),
      filters: [
        // Changes and deletions of operator audit items
        FilterCriteria.filter({
          eventName: FilterRule.or("MODIFY", "REMOVE"),
          dynamodb: { Keys: { PK: { S: FilterRule.beginsWith(OPERATOR_AUDIT_PREFIX) } } },
        }),
        // New audit entries, for their expiry (not the idempotency records, which live 24 hours by design)
        FilterCriteria.filter({
          eventName: FilterRule.isEqual("INSERT"),
          dynamodb: { Keys: { PK: { S: FilterRule.beginsWith(OPERATOR_AUDIT_PREFIX) }, SK: { S: FilterRule.beginsWith("AUDIT#") } } },
        }),
        // Its heartbeat
        FilterCriteria.filter({
          eventName: FilterRule.or("INSERT", "MODIFY"),
          dynamodb: { Keys: { PK: { S: FilterRule.isEqual(OPERATOR_AUDIT_HEARTBEAT.PK) }, SK: { S: FilterRule.isEqual(OPERATOR_AUDIT_HEARTBEAT.SK) } } },
        }),
      ],
    });

    this.changed = new Alarm(this, "Changed", {
      alarmName: `supply-checkout-${props.envName}-p1-operator-audit-changed`,
      alarmDescription:
        "P1. Operator audit changed: an OPAUDIT# item was modified, replaced or deleted other than by its TTL, or a new audit entry was written to expire well before its 2 years. Operator audit items are append-only, so this is tampering or a bug. The watch's log has the item's keys; follow \"Operators\" in docs/infrastructure.md.",
      metric: business(BusinessMetric.OperatorAuditChanged, props.region, FIVE_MINUTES),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    props.topics.notify(this.changed, "P1");

    this.dropped = new Alarm(this, "Dropped", {
      alarmName: `supply-checkout-${props.envName}-p2-operator-audit-watch-dropped`,
      alarmDescription:
        "P2. Operator audit watch dropped records: the watch gave up on a batch of the table's stream after its retries, so a change to an operator audit item could have gone unseen. Each message in its dead-letter queue names the shard and sequence numbers; the records stay in the stream for 24 hours. Follow \"Operators\" in docs/infrastructure.md.",
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: FIVE_MINUTES, statistic: "Maximum" }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    props.topics.notify(this.dropped, "P2");

    // The heartbeat: Scheduler writes the item itself, so nothing else can fail
    const tableArn = (this.tableArn = Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: props.tableName }));
    const heartbeatRole = new Role(this, "HeartbeatRole", {
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com", { conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } } }),
      description: "Writes the operator audit watch's heartbeat item, and nothing else",
    });
    heartbeatRole.addToPolicy(
      new PolicyStatement({
        sid: "HeartbeatItemOnly",
        actions: ["dynamodb:PutItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [OPERATOR_AUDIT_HEARTBEAT.PK], "dynamodb:Attributes": [...OPERATOR_AUDIT_HEARTBEAT.attributes] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
      }),
    );
    heartbeatRole.addToPolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [tableKey],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );
    this.heartbeat = new CfnSchedule(this, "Heartbeat", {
      description: "Rewrites the operator audit watch's heartbeat item (supply-checkout-6uw.11)",
      scheduleExpression: `rate(${HEARTBEAT_EVERY_MINUTES} minutes)`,
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: "arn:aws:scheduler:::aws-sdk:dynamodb:putItem",
        roleArn: heartbeatRole.roleArn,
        // `at` changes each time, so every write is a stream record
        input: Stack.of(this).toJsonString({
          TableName: props.tableName,
          Item: { PK: { S: OPERATOR_AUDIT_HEARTBEAT.PK }, SK: { S: OPERATOR_AUDIT_HEARTBEAT.SK }, at: { S: "<aws.scheduler.scheduled-time>" } },
        }),
        // A missed write shows in the alarm: no long retries
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 300 },
      },
    });

    this.silent = new Alarm(this, "Silent", {
      alarmName: `supply-checkout-${props.envName}-p2-operator-audit-watch-silent`,
      alarmDescription: `P2. Operator audit watch silent: no heartbeat from the operator audit watch for ${HEARTBEAT_SILENT_ALARM_MINUTES} minutes, so it isn't reading the table's stream or its metrics aren't arriving, and "Operator audit changed" can't fire. Check its event source mapping, concurrency, role, log group and log transformers, the table's stream and resource policy, the table key and the heartbeat schedule; follow "Operators" in docs/infrastructure.md.`,
      metric: business(BusinessMetric.OperatorAuditWatchHeartbeat, props.region, Duration.minutes(HEARTBEAT_SILENT_ALARM_MINUTES)),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.BREACHING,
    });
    props.topics.notify(this.silent, "P2");
  }
}
