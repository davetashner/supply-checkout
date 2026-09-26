import { fileURLToPath } from "node:url";
import { Aws, Duration, Stack, Validations } from "aws-cdk-lib";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { tableName } from "../../../backend/src/data/schema.js";
import { emailResourceNames } from "../../../backend/src/email/names.js";
import type { DeploymentConfig } from "../config.js";
import { LOG_RETENTION } from "../observability/defaults.js";
import { bundling } from "./api-stack.js";
import { SupplyCheckoutStack } from "./base-stack.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

/**
 * Bounce and complaint handling for the app's email (supply-checkout-5hx), in
 * the primary region, where SES and the table's writes are.
 *
 * - The domain stack's configuration set publishes bounce and complaint
 *   events to the email-events topic; SES itself suppresses the addresses
 *   (account-level suppression list).
 * - The handler (backend/src/email/events.ts) marks the invite a bounced
 *   message was for as failed, so its owner can correct the address. Its role
 *   may read a team's META item and update items in team partitions
 *   (dynamodb:LeadingKeys `TEAM#*`), and nothing else: no Scan, Query, Put or
 *   Delete, and no SES permissions.
 * - Lambda retries a failed event twice; SNS retries a failed delivery. Both
 *   end up in the dead-letter queue, which alarms ("Email events dropped",
 *   docs/journeys.md).
 *
 * Deploy after the data stack (the table's key ARN, from SSM) and the primary
 * region's domain stack (the topic).
 */
export class EmailStack extends SupplyCheckoutStack {
  readonly eventsFunction: NodejsFunction;
  readonly deadLetterQueue: Queue;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "email", layer: "stateless" });
    if (region !== config.primaryRegion) throw new Error("The email stack is in the primary region only");

    const resources = emailResourceNames(config.envName);
    const table = tableName(config.envName);
    const tableArn = Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: table });
    const tableKeyArn = StringParameter.valueForStringParameter(this, `/supply-checkout/${config.envName}/data/table-key-arn`);

    this.deadLetterQueue = new Queue(this, "DeadLetterQueue", {
      queueName: resources.deadLetterQueue,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(this.deadLetterQueue).acknowledge({
      id: "AwsSolutions-SQS3",
      reason: "This is the dead-letter queue: it holds bounce and complaint events the handler couldn't record.",
    });

    const logGroup = new LogGroup(this, "EventsFunctionLogs", { retention: LOG_RETENTION });
    const role = new Role(this, "EventsFunctionRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the email-events function",
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    this.eventsFunction = new NodejsFunction(this, "EventsFunction", {
      role,
      logGroup,
      entry: `${BACKEND}src/email/events.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      description: "Marks invites failed when SES reports a bounce or complaint",
      environment: { NODE_OPTIONS: "--enable-source-maps", TABLE_NAME: table },
      retryAttempts: 2,
      deadLetterQueue: this.deadLetterQueue,
      bundling,
    });
    this.eventsFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "MarkInvitesFailed",
        // GetItem: the team's home region (teamContextForEmailEvent). UpdateItem: the invite
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] } },
      }),
    );
    this.eventsFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [tableKeyArn],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );

    // The topic is the domain stack's; its name is fixed, so no cross-stack export
    const topic = Topic.fromTopicArn(this, "EmailEvents", Stack.of(this).formatArn({ service: "sns", resource: resources.eventsTopic }));
    topic.addSubscription(new LambdaSubscription(this.eventsFunction, { deadLetterQueue: this.deadLetterQueue }));
  }
}
