import { fileURLToPath } from "node:url";
import { Aws, Duration, Stack, Validations } from "aws-cdk-lib";
import { AppSyncAuthorizationType, AppSyncFieldLogLevel, type CfnApi, type ChannelNamespace, EventApi } from "aws-cdk-lib/aws-appsync";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { Effect, Policy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Architecture, EventSourceMapping, FilterCriteria, FilterRule, Runtime, StartingPosition } from "aws-cdk-lib/aws-lambda";
import { SqsDlq } from "aws-cdk-lib/aws-lambda-event-sources";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { CnameRecord } from "aws-cdk-lib/aws-route53";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { tableName } from "../../../backend/src/data/schema.js";
import { DOCUMENT_SK_PREFIXES, REALTIME_ENV, realtimeResourceNames, TEAMS_NAMESPACE } from "../../../backend/src/realtime/channels.js";
import { type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../config.js";
import { domainOutputParameters, hostNames, importZone } from "../domain.js";
import { LOG_RETENTION } from "../observability/defaults.js";
import { identityOutputParameters } from "../identity.js";
import { bundling } from "./api-stack.js";
import { SupplyCheckoutStack } from "./base-stack.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

/** SSM parameters the realtime stack publishes in its region. */
export const realtimeOutputParameters = (envName: string) => ({
  /** The Event API's ID, for alarms and the measurement steps in docs/api/realtime.md. */
  apiId: `/supply-checkout/${envName}/realtime/api-id`,
  /** `wss://realtime.<env domain>/event/realtime`: where clients connect. */
  websocketUrl: `/supply-checkout/${envName}/realtime/websocket-url`,
  /** `realtime.<env domain>`: the `host` clients put in their authorization header. */
  host: `/supply-checkout/${envName}/realtime/host`,
});

/**
 * Live updates (ADR 0006, docs/api/realtime.md): an AppSync Events API with
 * one channel per team, `/teams/<teamId>`, fed by a DynamoDB stream consumer.
 *
 * - Clients connect and subscribe with their Cognito access token. A Lambda
 *   authorizer (backend/src/realtime/authorizer.ts) allows a subscription only
 *   to exactly `/teams/<teamId>`, and only for a member of that team, with the
 *   same membership check as the data API. Its answers aren't cached.
 * - Only IAM may publish, and only the consumer's role has
 *   appsync:EventPublish, on the `teams` namespace. Clients can't publish.
 * - The consumer (backend/src/realtime/publisher.ts) reads the table's stream,
 *   filtered to product and sheet items, and publishes a small change event
 *   per write. Partial batch failures are retried from the first record that
 *   didn't go out; a batch that keeps failing goes to a dead-letter queue,
 *   which alarms (observability stack, "Live updates dropped").
 * - The custom domain `realtime.<env domain>` uses the certificate in
 *   GLOBAL_SERVICES_REGION (AppSync requires it there), so it's added in that
 *   region. The consumer reads the stream of this region's table replica,
 *   which only the primary region has until phase 2 (the second region's consumer,
 *   supply-checkout-72d.1); each region's consumer will then publish its own
 *   region's writes to its own Event API.
 */
export class RealtimeStack extends SupplyCheckoutStack {
  readonly api: EventApi;
  readonly teams: ChannelNamespace;
  readonly authorizer: NodejsFunction;
  readonly publisher?: NodejsFunction;
  readonly deadLetterQueue?: Queue;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "realtime", layer: "stateless" });

    const names = hostNames(config);
    const identity = identityOutputParameters(config.envName);
    const outputs = realtimeOutputParameters(config.envName);
    const resources = realtimeResourceNames(config.envName);
    const ssm = (name: string) => StringParameter.valueForStringParameter(this, name);
    const table = tableName(config.envName);
    const tableArn = Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: table });
    const tableKeyArn = ssm(`/supply-checkout/${config.envName}/data/table-key-arn`);
    const decryptThroughDynamoDb = new PolicyStatement({
      actions: ["kms:Decrypt", "kms:DescribeKey"],
      resources: [tableKeyArn],
      conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
    });

    // The authorizer reads only team metadata and membership items
    this.authorizer = this.handler("Authorizer", "authorizer", {
      description: "AppSync Events authorizer: Cognito access token, and team membership to subscribe",
      environment: {
        [REALTIME_ENV.tableName]: table,
        [REALTIME_ENV.userPoolId]: ssm(identity.userPoolId),
        [REALTIME_ENV.clientId]: ssm(identity.webClientId),
      },
    });
    this.authorizer.addToRolePolicy(
      new PolicyStatement({
        sid: "TeamMembershipReads",
        // GetItem also covers TransactGetItems (authorizeTeam's one read)
        actions: ["dynamodb:GetItem"],
        resources: [tableArn],
        conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] } },
      }),
    );
    this.authorizer.addToRolePolicy(decryptThroughDynamoDb);

    // AppSync writes its logs to /aws/appsync/apis/<api id>; errors only
    const logsRole = new Role(this, "ApiLogsRole", {
      assumedBy: new ServicePrincipal("appsync.amazonaws.com"),
      description: "Lets the Event API write its own log group",
    });
    const certificateInRegion = region === GLOBAL_SERVICES_REGION;
    this.api = new EventApi(this, "EventApi", {
      apiName: `supply-checkout-${config.envName}-realtime`,
      authorizationConfig: {
        authProviders: [
          { authorizationType: AppSyncAuthorizationType.IAM },
          {
            authorizationType: AppSyncAuthorizationType.LAMBDA,
            lambdaAuthorizerConfig: { handler: this.authorizer, resultsCacheTtl: Duration.seconds(0) },
          },
        ],
        connectionAuthModeTypes: [AppSyncAuthorizationType.LAMBDA],
        defaultPublishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        defaultSubscribeAuthModeTypes: [AppSyncAuthorizationType.LAMBDA],
      },
      ...(certificateInRegion
        ? {
            domainName: {
              domainName: names.realtime,
              certificate: Certificate.fromCertificateArn(this, "RealtimeCertificate", ssm(domainOutputParameters(config.envName).realtimeCertificateArn)),
            },
          }
        : {}),
    });
    // Set on the resource, not through the construct's logConfig, which adds a
    // log-retention custom resource
    const apiLogs = new LogGroup(this, "ApiLogs", { logGroupName: `/aws/appsync/apis/${this.api.apiId}`, retention: LOG_RETENTION });
    logsRole.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [apiLogs.logGroupArn] }));
    (this.api.node.defaultChild as CfnApi).addPropertyOverride("EventConfig.LogConfig", {
      CloudWatchLogsRoleArn: logsRole.roleArn,
      LogLevel: AppSyncFieldLogLevel.ERROR,
    });

    this.teams = this.api.addChannelNamespace("Teams", {
      channelNamespaceName: TEAMS_NAMESPACE,
      authorizationConfig: {
        publishAuthModeTypes: [AppSyncAuthorizationType.IAM],
        subscribeAuthModeTypes: [AppSyncAuthorizationType.LAMBDA],
      },
    });

    if (certificateInRegion) {
      new CnameRecord(this, "RealtimeAlias", {
        zone: importZone(this, config),
        recordName: names.realtime,
        domainName: this.api.appSyncDomainName,
        ttl: Duration.minutes(5),
      });
      new StringParameter(this, "WebsocketUrlParam", {
        parameterName: outputs.websocketUrl,
        stringValue: `wss://${names.realtime}/event/realtime`,
        description: "Where clients connect for live updates",
      });
      new StringParameter(this, "HostParam", { parameterName: outputs.host, stringValue: names.realtime, description: "Live updates host for the authorization header" });
    }
    new StringParameter(this, "ApiIdParam", { parameterName: outputs.apiId, stringValue: this.api.apiId, description: "AppSync Event API ID in this region" });

    if (this.isPrimaryRegion) {
      this.deadLetterQueue = new Queue(this, "DeadLetterQueue", {
        queueName: resources.deadLetterQueue,
        encryption: QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        retentionPeriod: Duration.days(14),
      });
      Validations.of(this.deadLetterQueue).acknowledge({
        id: "AwsSolutions-SQS3",
        reason: "This is the dead-letter queue: it holds the stream positions of batches the consumer gave up on.",
      });
      this.publisher = this.consumer(config, resources.consumerFunction, decryptThroughDynamoDb, this.deadLetterQueue);
    }
  }

  /** The stream consumer: publishes each product and sheet write to its team's channel. */
  private consumer(config: DeploymentConfig, functionName: string, decrypt: PolicyStatement, dlq: Queue): NodejsFunction {
    const fn = this.handler("Publisher", "publisher", {
      functionName,
      description: "Publishes product and sheet changes from the table's stream to each team's AppSync Events channel",
      environment: { [REALTIME_ENV.httpHost]: this.api.httpDns },
    });
    this.teams.grantPublish(fn);
    const streamArn = StringParameter.valueForStringParameter(this, `/supply-checkout/${config.envName}/data/table-stream-arn`);
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadTableStream",
        effect: Effect.ALLOW,
        actions: ["dynamodb:DescribeStream", "dynamodb:GetRecords", "dynamodb:GetShardIterator"],
        resources: [streamArn],
      }),
    );
    // Lambda's stream poller also asks for ListStreams, which has no resource-level permissions
    const listStreams = new Policy(this, "PublisherListStreams", {
      statements: [new PolicyStatement({ actions: ["dynamodb:ListStreams"], resources: ["*"] })],
    });
    listStreams.attachToRole(fn.role as Role);
    Validations.of(listStreams).acknowledge({
      id: "AwsSolutions-IAM5[Resource::*]",
      reason: "dynamodb:ListStreams doesn't support resource-level permissions; it lists stream ARNs and reads no data.",
    });
    fn.addToRolePolicy(decrypt);
    new EventSourceMapping(this, "TableStream", {
      target: fn,
      eventSourceArn: streamArn,
      // Live updates are about now: a new mapping doesn't replay the last 24 hours
      startingPosition: StartingPosition.LATEST,
      batchSize: 100,
      // No batching window: publish as soon as records arrive (the 2-second goal)
      maxBatchingWindow: Duration.seconds(0),
      parallelizationFactor: 1,
      reportBatchItemFailures: true,
      bisectBatchOnError: true,
      retryAttempts: 10,
      // Clients resync on reconnect, so an event an hour old is worth less than moving on
      maxRecordAge: Duration.hours(1),
      onFailure: new SqsDlq(dlq),
      filters: DOCUMENT_SK_PREFIXES.map((prefix) => FilterCriteria.filter({ dynamodb: { Keys: { SK: { S: FilterRule.beginsWith(prefix) } } } })),
    });
    return fn;
  }

  /** A function from backend/src/realtime/<name>.ts, with its own log group and a role that can write only to it. */
  private handler(id: string, name: string, props: { description: string; environment: Record<string, string>; functionName?: string }): NodejsFunction {
    const logGroup = new LogGroup(this, `${id}Logs`, { retention: LOG_RETENTION });
    const role = new Role(this, `${id}Role`, {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: `Execution role for the realtime ${name} function`,
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    return new NodejsFunction(this, id, {
      functionName: props.functionName,
      role,
      logGroup,
      entry: `${BACKEND}src/realtime/${name}.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      description: props.description,
      environment: { NODE_OPTIONS: "--enable-source-maps", ...props.environment },
      bundling,
    });
  }
}
