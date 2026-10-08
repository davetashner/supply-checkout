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
import { GSI2, PASSWORD_RESET_LIMIT_ATTRIBUTES, PASSWORD_RESET_LIMIT_PREFIX, SECURITY_NOTICE_ATTRIBUTES, tableName, WELCOME_INVITE_ATTRIBUTES, WELCOME_RECORD_ATTRIBUTES, WELCOME_TEAM_ATTRIBUTES } from "../../../backend/src/data/schema.js";
import { EMAIL_EVENTS_READS, EMAIL_EVENTS_WRITES, emailResourceNames, PASSWORD_RESET_ENV, WELCOME_ENV } from "../../../backend/src/email/names.js";
import { SECURITY_NOTICE_EVENTS, SECURITY_NOTICES_ENV } from "../../../backend/src/identity/names.js";
import { TEST_MAIL_DOMAIN_ENV } from "../../../backend/src/data/test-accounts.js";
import type { DeploymentConfig } from "../config.js";
import { hostNames } from "../domain.js";
import { grantSendEmail, supportAddress } from "../email.js";
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
 *   AdminSetUserMFAPreference (supply-checkout-8jc.14), UpdateUserAttributes
 *   and VerifyUserAttribute calls (SECURITY_NOTICE_EVENTS)
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
 *   They include `totpOnAt` (supply-checkout-8jc.14): when two-step sign-in
 *   was turned on, from the VerifySoftwareToken and SetUserMFAPreference
 *   events, which the billing routes compare with a session's auth_time.
 * - Lambda tries a failed event twice more, then puts it on the security
 *   notices dead-letter queue (SQS-encrypted, 14 days), as EventBridge does
 *   with one it couldn't deliver, so it can be replayed. A notice SES refuses
 *   isn't retried; it's counted (SecurityNoticeFailures).
 *
 * The welcome email (supply-checkout-6uw.25, backend/src/email/welcome-handler.ts):
 *
 * - The user pool's post confirmation and pre token generation triggers (the
 *   identity stack) invoke the function asynchronously, by its fixed name
 *   (emailResourceNames().welcomeFunction), with a new account's sub and how it
 *   signed up. Their roles may invoke it and nothing else of Lambda's; no other
 *   principal is granted it.
 * - The function may call ListUsers and AdminGetUser on the app pool only (it's
 *   handed a sub), send the app's email (grantSendEmail), and in the table:
 *   UpdateItem naming only WELCOME_RECORD_ATTRIBUTES, returning nothing, and
 *   ConditionCheckItem (the DELETING mark, keys only), in `USER#` partitions:
 *   its once-only record; Query of `USER#` partitions naming only the keys (is
 *   the user in a team); and Query of GSI2's `INVITEE#` partitions naming only
 *   WELCOME_INVITE_ATTRIBUTES (is an invite waiting), both with Select
 *   SPECIFIC_ATTRIBUTES. No GetItem, PutItem, DeleteItem or Scan.
 * - Lambda tries a failed request twice more, then puts it on the welcome
 *   dead-letter queue (SQS-encrypted, 14 days: a sub and a sign-up method, no
 *   address), which alarms ("Welcome emails dropped").
 *
 * Password resets asked for in the app (supply-checkout-6uw.26,
 * backend/src/email/password-reset-handler.ts):
 *
 * - The api stack's password reset function invokes this one asynchronously,
 *   by its fixed name (emailResourceNames().passwordResetFunction), with the
 *   address and the caller's IP address. Only that function's role is granted
 *   it.
 * - The function may call AdminGetUser and ListUsers on the app pool only,
 *   send the app's email (grantSendEmail), and UpdateItem naming only
 *   PASSWORD_RESET_LIMIT_ATTRIBUTES, returning nothing, in `RESETLIMIT#`
 *   partitions (its limits, keyed by hashes). Cognito's ForgotPassword is a
 *   public call (the web client's ID), so it needs no permission.
 * - No retries and no dead-letter queue: a request holds an address, and the
 *   person can simply ask again. A request older than 15 minutes is dropped.
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
  readonly welcome: NodejsFunction;
  readonly welcomeDeadLetterQueue: Queue;
  /** Password resets asked for in the app: a code, or help for an address with no account (supply-checkout-6uw.26). */
  readonly passwordReset: NodejsFunction;

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
    [this.welcome, this.welcomeDeadLetterQueue] = this.addWelcome(config, table, tableArn, tableKeyArn);
    this.passwordReset = this.addPasswordReset(config, table, tableArn, tableKeyArn);
  }

  /** The password reset function (see the class comment). */
  private addPasswordReset(config: DeploymentConfig, table: string, tableArn: string, tableKeyArn: string): NodejsFunction {
    const identity = identityOutputParameters(config.envName);
    const userPoolArn = StringParameter.valueForStringParameter(this, identity.userPoolArn);
    const logGroup = new LogGroup(this, "PasswordResetLogs", { retention: LOG_RETENTION });
    const role = new Role(this, "PasswordResetRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the password reset function",
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    // A fixed name: the api stack's password reset function invokes it by name
    const fn = new NodejsFunction(this, "PasswordResetFunction", {
      functionName: emailResourceNames(config.envName).passwordResetFunction,
      role,
      logGroup,
      entry: `${BACKEND}src/email/password-reset.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      description: "Sends a password reset code, or help for an address with no account (supply-checkout-6uw.26)",
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        TABLE_NAME: table,
        [PASSWORD_RESET_ENV.userPoolId]: StringParameter.valueForStringParameter(this, identity.userPoolId),
        [PASSWORD_RESET_ENV.clientId]: StringParameter.valueForStringParameter(this, identity.webClientId),
        [WELCOME_ENV.supportAddress]: supportAddress(config),
      },
      // The request holds an address: never kept in a queue, and not tried again
      retryAttempts: 0,
      maxEventAge: Duration.minutes(15),
      bundling,
    });
    // noreply@ only, through the configuration set (lib/email.ts)
    grantSendEmail(fn, config);
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "FindAppUsers",
        actions: ["cognito-idp:AdminGetUser", "cognito-idp:ListUsers"],
        resources: [userPoolArn],
      }),
    );
    // backend/src/data/password-resets.ts: the limits' counters, by hashes, returning nothing
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "CountPasswordResets",
        actions: ["dynamodb:UpdateItem"],
        resources: [tableArn],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${PASSWORD_RESET_LIMIT_PREFIX}*`] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...PASSWORD_RESET_LIMIT_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
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
    return fn;
  }

  /** The welcome email function and its dead-letter queue (see the class comment). */
  private addWelcome(config: DeploymentConfig, table: string, tableArn: string, tableKeyArn: string): [NodejsFunction, Queue] {
    const names = emailResourceNames(config.envName);
    const identity = identityOutputParameters(config.envName);
    const userPoolId = StringParameter.valueForStringParameter(this, identity.userPoolId);
    const userPoolArn = StringParameter.valueForStringParameter(this, identity.userPoolArn);
    const logGroup = new LogGroup(this, "WelcomeLogs", { retention: LOG_RETENTION });
    const role = new Role(this, "WelcomeRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: "Execution role for the welcome email function",
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    // Requests the function gave up on, to replay: a user's sub and how they signed up, no address
    const deadLetters = new Queue(this, "WelcomeDeadLetterQueue", {
      queueName: names.welcomeDeadLetterQueue,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(deadLetters).acknowledge({
      id: "AwsSolutions-SQS3",
      reason: "This is the dead-letter queue: it holds welcome email requests the function failed on after Lambda's retries.",
    });
    // A fixed name: the user pool's triggers invoke it by name (the identity stack deploys first)
    const fn = new NodejsFunction(this, "WelcomeFunction", {
      functionName: names.welcomeFunction,
      role,
      logGroup,
      entry: `${BACKEND}src/email/welcome.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      description: "Emails a new account its welcome, once (supply-checkout-6uw.25)",
      environment: {
        NODE_OPTIONS: "--enable-source-maps",
        TABLE_NAME: table,
        [WELCOME_ENV.userPoolId]: userPoolId,
        [WELCOME_ENV.supportAddress]: supportAddress(config),
        // A test account's welcome is left out of WelcomeEmails (supply-checkout-o60.2)
        [TEST_MAIL_DOMAIN_ENV]: hostNames(config).testMail,
      },
      retryAttempts: 2,
      maxEventAge: Duration.hours(6),
      deadLetterQueue: deadLetters,
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
    const userPartitions = { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] } };
    // backend/src/data/welcome.ts: claimWelcome and releaseWelcome, returning nothing; the DELETING mark's check names only the keys
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "ClaimWelcome",
        actions: ["dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
        resources: [tableArn],
        conditions: {
          ...userPartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...WELCOME_RECORD_ATTRIBUTES] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
      }),
    );
    // hasTeam: the keys of the user's own rows
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadTeamKeys",
        actions: ["dynamodb:Query"],
        resources: [tableArn],
        conditions: {
          ...userPartitions,
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...WELCOME_TEAM_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
    );
    // hasLiveInvite: an invite's type, address and expiry, in GSI2's invitee partitions
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadWaitingInvites",
        actions: ["dynamodb:Query"],
        resources: [`${tableArn}/index/${GSI2}`],
        conditions: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["INVITEE#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": [...WELCOME_INVITE_ATTRIBUTES] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
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
    return [fn, deadLetters];
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
    // Events the function or EventBridge gave up on, to replay: CloudTrail records (the user's sub, IP
    // and user agent; no address or token), encrypted by SQS, kept 14 days. Any message alarms
    // ("Security notices dropped", journey-alarms.ts), as each failed try does ("Security notices failing")
    const deadLetters = new Queue(this, "SecurityNoticesDeadLetterQueue", {
      queueName: emailResourceNames(config.envName).securityNoticesDeadLetterQueue,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(deadLetters).acknowledge({
      id: "AwsSolutions-SQS3",
      reason: "This is the dead-letter queue: it holds security notice events the function or EventBridge couldn't deliver.",
    });
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
      deadLetterQueue: deadLetters,
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
    // ConditionCheckItem: recordNoticeAddress checks the DELETING mark in the same transaction, naming only the keys
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "WriteNoticeRecords",
        actions: ["dynamodb:UpdateItem", "dynamodb:ConditionCheckItem"],
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
        // This account's own events only (defense in depth: a bus only gets another account's if it's allowed to)
        account: [Stack.of(this).account],
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
    rule.addTarget(new LambdaFunction(fn, { retryAttempts: 4, maxEventAge: Duration.hours(6), deadLetterQueue: deadLetters }));
    return [fn, rule];
  }
}
