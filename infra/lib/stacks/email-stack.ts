import { fileURLToPath } from "node:url";
import { Aws, Duration, Stack, Validations } from "aws-cdk-lib";
import { Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { Topic } from "aws-cdk-lib/aws-sns";
import { LambdaSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { SECURITY_NOTICE_ATTRIBUTES, tableName } from "../../../backend/src/data/schema.js";
import { EMAIL_EVENTS_READS, EMAIL_EVENTS_WRITES, emailResourceNames } from "../../../backend/src/email/names.js";
import { SECURITY_NOTICE_EVENTS, SECURITY_NOTICES_ENV } from "../../../backend/src/identity/names.js";
import type { DeploymentConfig } from "../config.js";
import { grantSendEmail } from "../email.js";
import { identityOutputParameters } from "../identity.js";
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
 *   may read only `homeRegion` from team items, and update only an invite's
 *   failure fields, in team partitions (dynamodb:LeadingKeys `TEAM#*`,
 *   dynamodb:Attributes), and nothing else: no Scan, Query, Put or Delete,
 *   and no SES permissions.
 * - Lambda retries a failed event twice; SNS retries a failed delivery. Both
 *   end up in the dead-letter queue, which alarms ("Email events dropped",
 *   docs/journeys.md). It holds addresses, so it has its own KMS key and
 *   keeps messages 7 days.
 *
 * Security notices for changes made directly against Cognito
 * (supply-checkout-8jc.28, 8jc.29, backend/src/identity/security-notices-handler.ts):
 *
 * - A rule on CloudTrail's management events (the audit stack's trail) sends
 *   the app pool's ChangePassword, VerifySoftwareToken, SetUserMFAPreference,
 *   UpdateUserAttributes and VerifyUserAttribute calls (SECURITY_NOTICE_EVENTS)
 *   to the security notices function. CloudTrail puts the pool ID in
 *   requestParameters or additionalEventData, so the rule matches either, and
 *   an event naming no pool too: the function looks the user up in the app
 *   pool only, so another pool's user is never found.
 * - The function may call ListUsers and AdminGetUser on the app pool only (the
 *   events name the user's sub, not their username), send the app's email
 *   (grantSendEmail: noreply@ only, through the configuration set), and read
 *   and update only SECURITY_NOTICE_ATTRIBUTES in `USER#` partitions, which no
 *   other item has (dynamodb:Attributes), with nothing returned. IAM can't
 *   name the user or the sort key, so it's every user's partition, but only
 *   those attributes: it can't read or change a user's teams, proofs or TTL.
 * - Lambda tries a failed event twice more. A notice SES refuses isn't
 *   retried; it's counted (SecurityNoticeFailures).
 *
 * Deploy after the data stack (the table's key ARN, from SSM), the primary
 * region's domain stack (the topic) and the identity stack (the app pool's ID
 * and ARN, from SSM).
 */
export class EmailStack extends SupplyCheckoutStack {
  readonly eventsFunction: NodejsFunction;
  readonly deadLetterQueue: Queue;
  readonly securityNotices: NodejsFunction;
  readonly securityNoticeEvents: Rule;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "email", layer: "stateless" });
    if (region !== config.primaryRegion) throw new Error("The email stack is in the primary region only");

    const resources = emailResourceNames(config.envName);
    const table = tableName(config.envName);
    const tableArn = Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: table });
    const tableKeyArn = StringParameter.valueForStringParameter(this, `/supply-checkout/${config.envName}/data/table-key-arn`);

    // The dead-letter queue holds whole SES events, recipients' addresses
    // included, so it gets its own key and a short retention
    const topicArn = Stack.of(this).formatArn({ service: "sns", resource: resources.eventsTopic });
    const queueKey = new Key(this, "DeadLetterQueueKey", {
      description: "Encrypts the email-events dead-letter queue (it holds recipients' addresses)",
      enableKeyRotation: true,
    });
    // SNS encrypts the messages it redrives here, from the events topic only
    queueKey.addToResourcePolicy(
      new PolicyStatement({
        sid: "SnsRedrivesFailedDeliveries",
        principals: [new ServicePrincipal("sns.amazonaws.com")],
        actions: ["kms:GenerateDataKey*", "kms:Decrypt"],
        resources: ["*"],
        conditions: { ArnEquals: { "aws:SourceArn": topicArn } },
      }),
    );
    this.deadLetterQueue = new Queue(this, "DeadLetterQueue", {
      queueName: resources.deadLetterQueue,
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: queueKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(7),
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
    // Lambda puts events that keep failing on the queue with the function's
    // role, so the role may encrypt with the queue's key, through SQS only
    this.eventsFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "DeadLetterQueueKeyThroughSqs",
        actions: ["kms:GenerateDataKey", "kms:Decrypt"],
        resources: [queueKey.keyArn],
        conditions: { StringEquals: { "kms:ViaService": `sqs.${Aws.REGION}.amazonaws.com` } },
      }),
    );
    // Each call, and only the attributes it needs (backend/src/data/team-context.ts
    // teamContextForEmailEvent, backend/src/data/invites.ts markInviteFailed)
    const teamPartitions = { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] } };
    this.eventsFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadTeamHomeRegion",
        actions: ["dynamodb:GetItem"],
        resources: [tableArn],
        conditions: {
          ...teamPartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...EMAIL_EVENTS_READS] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    this.eventsFunction.addToRolePolicy(
      new PolicyStatement({
        sid: "MarkInvitesFailed",
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: {
          ...teamPartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...EMAIL_EVENTS_WRITES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
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
    const topic = Topic.fromTopicArn(this, "EmailEvents", topicArn);
    topic.addSubscription(new LambdaSubscription(this.eventsFunction, { deadLetterQueue: this.deadLetterQueue }));

    [this.securityNotices, this.securityNoticeEvents] = this.addSecurityNotices(config, table, tableArn, tableKeyArn);
  }

  /** The security notices function and its CloudTrail rule (see the class comment). */
  private addSecurityNotices(config: DeploymentConfig, table: string, tableArn: string, tableKeyArn: string): [NodejsFunction, Rule] {
    const identity = identityOutputParameters(config.envName);
    const userPoolId = StringParameter.valueForStringParameter(this, identity.userPoolId);
    const userPoolArn = StringParameter.valueForStringParameter(this, identity.userPoolArn);
    const logGroup = new LogGroup(this, "SecurityNoticesLogs", { retention: LOG_RETENTION });
    const role = new Role(this, "SecurityNoticesRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the security notices function",
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    const fn = new NodejsFunction(this, "SecurityNoticesFunction", {
      role,
      logGroup,
      entry: `${BACKEND}src/identity/security-notices.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      description: "Emails the account when its password, two-step sign-in or email is changed directly against Cognito",
      environment: { NODE_OPTIONS: "--enable-source-maps", TABLE_NAME: table, [SECURITY_NOTICES_ENV.userPoolId]: userPoolId },
      retryAttempts: 2,
      bundling,
    });
    // noreply@ only, through the configuration set (lib/email.ts)
    grantSendEmail(fn, config);
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "FindAppUsers",
        actions: ["cognito-idp:ListUsers", "cognito-idp:AdminGetUser"],
        resources: [userPoolArn],
      }),
    );
    // backend/src/data/security-notices.ts: GetItem with a projection, UpdateItem returning nothing
    const noticeRecords = {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
      "ForAllValues:StringEquals": { "dynamodb:Attributes": [...SECURITY_NOTICE_ATTRIBUTES] },
    };
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadNoticeRecords",
        actions: ["dynamodb:GetItem"],
        resources: [tableArn],
        conditions: { ...noticeRecords, StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" } },
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "WriteNoticeRecords",
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: { ...noticeRecords, StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" } },
      }),
    );
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [tableKeyArn],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      }),
    );

    const rule = new Rule(this, "SecurityNoticeEvents", {
      ruleName: `supply-checkout-${config.envName}-security-notices`,
      description: "App pool: a password, two-step sign-in or email changed, by any client (supply-checkout-8jc.28, 8jc.29)",
      eventPattern: {
        source: ["aws.cognito-idp"],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          eventSource: ["cognito-idp.amazonaws.com"],
          eventName: Object.keys(SECURITY_NOTICE_EVENTS),
          $or: [
            { requestParameters: { userPoolId: [userPoolId] } },
            { additionalEventData: { userPoolId: [userPoolId] } },
            { requestParameters: { userPoolId: [{ exists: false }] }, additionalEventData: { userPoolId: [{ exists: false }] } },
          ],
        },
      },
    });
    rule.addTarget(new LambdaFunction(fn, { retryAttempts: 4, maxEventAge: Duration.hours(6) }));
    return [fn, rule];
  }
}
