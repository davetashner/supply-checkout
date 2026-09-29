import { fileURLToPath } from "node:url";
import { Aws, Duration, Stack, Validations } from "aws-cdk-lib";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";
import {
  ApiMapping,
  CfnStage,
  CorsHttpMethod,
  DomainName,
  HttpApi,
  HttpMethod,
  HttpStage,
  LogGroupLogDestination,
  SecurityPolicy,
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { ArnPrincipal, Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Alias, Architecture, type IFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { type BundlingOptions, NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import { AaaaRecord, ARecord, RecordTarget } from "aws-cdk-lib/aws-route53";
import { ApiGatewayv2DomainProperties } from "aws-cdk-lib/aws-route53-targets";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import {
  ACCOUNT_ROUTES,
  ACCOUNT_SESSION_TAGS,
  API_ENV,
  AUTH_ROUTES,
  BILLING_ROUTES,
  BILLING_SESSION_TAGS,
  DATA_ROUTES,
  IDEMPOTENCY_HEADER,
  OPS_ROUTES,
  OPS_SESSION_TAG,
  routeKey,
  TEAM_SESSION_TAG,
  WEBHOOK_ROUTES,
} from "../../../backend/src/api/routes.js";
import {
  COMMITTING_IMPORTS_PARTITION,
  BILLING_READ_ATTRIBUTES,
  BILLING_UPDATE_ATTRIBUTES,
  COMP_ATTRIBUTES,
  CUSTOMER_LINK_TEAM_ATTRIBUTES,
  GSI1,
  GSI2,
  GSI3,
  IMPORT_INDEX_ATTRIBUTES,
  INVITE_LIMIT_ATTRIBUTES,
  INVITE_LIMIT_PREFIX,
  MEMBER_ROW_ATTRIBUTES,
  OPERATOR_AUDIT_PREFIX,
  OPS_AUDIT_INDEX_PREFIX,
  OPS_OWNERS_PREFIX,
  OPS_TEAMS_PARTITION,
  OWNER_OPERATOR_AUDIT_ATTRIBUTES,
  REOPEN_ATTRIBUTES,
  STRIPE_LINK_ATTRIBUTES,
  STRIPE_LINK_PREFIX,
  STRIPE_LINK_READ_ATTRIBUTES,
  STUCK_IMPORT_ATTRIBUTES,
  tableName,
  WEBHOOK_RECORD_ATTRIBUTES,
  WEBHOOK_RECORD_PREFIX,
} from "../../../backend/src/data/schema.js";
import { BILLING_ENV, BILLING_MAX_RECEIVES, billingResourceNames, STRIPE_ENV, stripeSecretName, stripeWebhookSecretName } from "../../../backend/src/billing/names.js";
import { BILLING_WORKER_TAGS } from "../../../backend/src/billing/worker-db.js";
import { type DeploymentConfig, stripeModeOf, stripeSecretArn, stripeWebhookSecretArn } from "../config.js";
import { domainOutputParameters, hostNames, importZone } from "../domain.js";
import { grantPutDeletionRecords } from "../deletions.js";
import { grantSendEmail } from "../email.js";
import { cognitoJwtAuthorizer, identityOptionsFromContext, identityOutputParameters, LOCAL_DEV_ORIGIN, opsJwtAuthorizer } from "../identity.js";
import { LOG_RETENTION } from "../observability/defaults.js";
import { SupplyCheckoutStack } from "./base-stack.js";

const BACKEND = fileURLToPath(new URL("../../../backend/", import.meta.url));

/** SSM parameters the api stack publishes in its region. */
export const apiOutputParameters = (envName: string) => ({
  /** The HTTP API's ID, for the observability stack's API alarms. */
  apiId: `/supply-checkout/${envName}/api/api-id`,
  /** `https://api.<env domain>` */
  url: `/supply-checkout/${envName}/api/url`,
});

/**
 * Bundles a handler with esbuild: ESM, minified and tree-shaken, AWS SDK v3
 * included (only the clients a handler imports, at the version the tests
 * ran). No Docker: esbuild runs from backend/node_modules.
 */
export const bundling: BundlingOptions = {
  format: OutputFormat.ESM,
  target: "node24",
  minify: true,
  sourceMap: true,
  sourcesContent: false,
  mainFields: ["module", "main"],
  externalModules: [],
  // Some dependencies still call require(); give ESM output one
  banner: "import{createRequire}from'module';const require=createRequire(import.meta.url);",
};

/**
 * The HTTP API with its JWT authorizer and the Lambda functions behind it, in
 * every region (ADR 0006, 0010), at `api.<env domain>`.
 *
 * - Data routes (backend/src/api/routes.ts, docs/api/openapi.yaml): the app's
 *   products and sheets documents, and the checkout, return and stock
 *   commands next to them, behind the Cognito JWT authorizer, served by the
 *   `data` function.
 * - Account routes (/me, POST /teams, POST /invites/{inviteId}/accept, and a
 *   team's members): the signed-in user's teams and invites, creating a team
 *   and accepting an invite, and owners managing members and roles, behind
 *   the same authorizer, served by the `account` function.
 * - Auth routes: the sign-in session endpoints, which keep the refresh token
 *   in an HttpOnly cookie, served by the `auth` function. No authorizer: they
 *   run on the cookie, with SameSite=Strict and an Origin check.
 * - Team isolation, second layer (ADR 0005): the data function's own role
 *   can't reach the table. For each request it assumes the data-access role
 *   with the session tag `teamId=<path team>`, and that role may only touch
 *   items whose partition key is `TEAM#<tag>` or `TEAM#<tag>#SHEETS`
 *   (dynamodb:LeadingKeys). The first layer, the membership check, is in the
 *   handler.
 * - The account function can't use the data-access role: creating a team or
 *   accepting an invite writes items outside any team the caller is in. It
 *   assumes the account-access role instead, with session tags `userId`
 *   (always the token's `sub`), `teamId`, `invitee`, `member` and `inviteLimit`, and that
 *   role may only touch items whose partition key is `USER#<userId>` or
 *   `TEAM#<teamId>`, or GSI2's `INVITEE#<invitee>` (the hashed verified
 *   email), and only update or delete items in `USER#<member>` (another
 *   member's team-switcher row), and only update the day's invite counter in
 *   `INVITELIMIT#<inviteLimit>` (the address an owner is inviting). It may
 *   also send the invite emails (grantSendEmail). The handler tags a team only when the
 *   request is entitled to it, and a member only after an owner's checks
 *   (backend/src/api/account-db.ts).
 *   No Scan, no BatchWriteItem, and never another user's partition.
 * - Functions are NodejsFunction (Node.js 24, arm64) behind a `live` alias,
 *   ready for CodeDeploy canaries (ADR 0012). The data function has 1 GB of
 *   memory for CPU: its work is JSON and TLS, and more memory means less
 *   latency ("Data API" in docs/infrastructure.md says how to measure p95).
 * - Access logs as JSON, and stage throttling as a ceiling against abuse
 *   (per-user limits are supply-checkout-wxx).
 * - The execute-api endpoint is off: the only way in is the custom domain.
 *   Its DNS records use latency routing from the start, so the second region
 *   (phase 2) adds records instead of replacing them.
 *
 * Reads from SSM in its own region at deploy time: the table's KMS key ARN
 * (data stack), the issuer, web client ID and auth URL (identity stack, which
 * is in the primary region; a second region needs copies), and the `api.`
 * certificate (domain stack).
 */
export class ApiStack extends SupplyCheckoutStack {
  readonly api: HttpApi;
  readonly dataFunction: NodejsFunction;
  readonly authFunction: NodejsFunction;
  readonly accountFunction: NodejsFunction;
  readonly dataAccessRole: Role;
  readonly accountAccessRole: Role;
  /** Starts Stripe Checkout (ADR 0009): one of only two kinds of function that may read the Stripe secret key. */
  readonly billingFunction: NodejsFunction;
  readonly billingAccessRole: Role;
  /** Stripe's webhook: verifies each event and puts it on the billing queue (ADR 0009). */
  readonly webhookFunction: NodejsFunction;
  /** Verified Stripe events, FIFO per customer, and the events that kept failing. */
  readonly billingQueue: Queue;
  readonly billingDeadLetterQueue: Queue;
  /** Seat syncs for the billing worker (supply-checkout-l50), from the account function and the nightly reconciliation. */
  readonly seatQueue: Queue;
  readonly seatDeadLetterQueue: Queue;
  /** Applies queued events to teams (ADR 0009). */
  readonly billingWorker: NodejsFunction;
  readonly billingWorkerRole: Role;
  readonly opsFunction?: NodejsFunction;
  readonly operatorAccessRole?: Role;
  /** Primary region only: reopens closed teams for the ops function (supply-checkout-6uw.6). */
  readonly opsReopenFunction?: NodejsFunction;
  readonly operatorReopenRole?: Role;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "api", layer: "stateless" });

    const names = hostNames(config);
    const identity = identityOutputParameters(config.envName);
    const outputs = apiOutputParameters(config.envName);
    const ssm = (name: string) => StringParameter.valueForStringParameter(this, name);
    const appOrigin = `https://${names.app}`;
    const origins = identityOptionsFromContext(this.node, config.envName).localhostCallbacks ? [appOrigin, LOCAL_DEV_ORIGIN] : [appOrigin];

    // The global table has the same name in every region; the ARN is this region's replica
    const table = tableName(config.envName);
    const tableArn = Stack.of(this).formatArn({ service: "dynamodb", resource: "table", resourceName: table });

    this.dataFunction = this.handler("DataFunction", "data", {
      memorySize: 1024,
      description: "Products and sheets for the app (the data API)",
      environment: { [API_ENV.tableName]: table },
    });
    this.authFunction = this.handler("AuthFunction", "auth", {
      memorySize: 256,
      description: "Sign-in sessions: code exchange, refresh and sign-out with an HttpOnly cookie",
      environment: {
        [API_ENV.authUrl]: ssm(identity.authUrl),
        [API_ENV.clientId]: ssm(identity.webClientId),
        [API_ENV.allowedOrigins]: origins.join(","),
      },
    });

    this.accountFunction = this.handler("AccountFunction", "account", {
      memorySize: 512,
      description: "The signed-in user's teams and invites; creates teams, manages members and invites, and accepts invites",
      environment: { [API_ENV.tableName]: table, [API_ENV.issuerUrl]: ssm(identity.issuerUrl) },
    });
    const tableKeyStatement = () =>
      new PolicyStatement({
        sid: "TableKeyThroughDynamoDb",
        effect: Effect.ALLOW,
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [ssm(`/supply-checkout/${config.envName}/data/table-key-arn`)],
        conditions: { StringEquals: { "kms:ViaService": `dynamodb.${Aws.REGION}.amazonaws.com` } },
      });

    // The data-access role: DynamoDB on one team's partitions, chosen by the session tag
    const dataRole = this.dataFunction.role;
    if (!dataRole) throw new Error("The data function has no role");
    const teamTag = `\${aws:PrincipalTag/${TEAM_SESSION_TAG}}`;
    this.dataAccessRole = new Role(this, "DataAccessRole", {
      description: "Assumed by the data function per request, tagged with the team; reaches only that team's items",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new ArnPrincipal(dataRole.roleArn)
        .withConditions({
          // Every session must name exactly one team, and nothing else
          StringLike: { [`aws:RequestTag/${TEAM_SESSION_TAG}`]: "?*" },
          "ForAllValues:StringEquals": { "aws:TagKeys": [TEAM_SESSION_TAG] },
        })
        .withSessionTags(),
      inlinePolicies: {
        TeamPartitionOnly: new PolicyDocument({
          statements: [
            new PolicyStatement({
              sid: "TeamItemsOnly",
              effect: Effect.ALLOW,
              // GetItem also covers TransactGetItems (the membership check).
              // Put, Update and ConditionCheck cover the inventory commands'
              // TransactWriteItems (backend/src/data/commands.ts), whose items
              // are all in the team's partition.
              actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"],
              resources: [tableArn, `${tableArn}/index/${GSI1}`],
              conditions: {
                "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [`TEAM#${teamTag}`, `TEAM#${teamTag}#SHEETS`] },
              },
            }),
            // Owners read what operators did to their team (ADR 0015): read
            // only, only the team's own OPAUDIT# partition, and only the
            // attributes that don't name the operator
            new PolicyStatement({
              sid: "OwnOperatorAuditReadOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:Query"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [`${OPERATOR_AUDIT_PREFIX}${teamTag}`],
                  "dynamodb:Attributes": [...OWNER_OPERATOR_AUDIT_ATTRIBUTES],
                },
                StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
              },
            }),
            tableKeyStatement(),
          ],
        }),
      },
    });
    this.dataFunction.addToRolePolicy(
      new PolicyStatement({ actions: ["sts:AssumeRole", "sts:TagSession"], resources: [this.dataAccessRole.roleArn] }),
    );
    this.dataFunction.addEnvironment(API_ENV.dataRoleArn, this.dataAccessRole.roleArn);

    // The account-access role: the caller's own partition, plus at most one
    // team and one invitee partition, each chosen by a session tag
    const accountRole = this.accountFunction.role;
    if (!accountRole) throw new Error("The account function has no role");
    const tag = (key: string) => `\${aws:PrincipalTag/${key}}`;
    const accountTags = Object.values(ACCOUNT_SESSION_TAGS);
    this.accountAccessRole = new Role(this, "AccountAccessRole", {
      description: "Assumed by the account function per request, tagged with the user and at most one team, invitee, member and invited address; reaches only those partitions",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new ArnPrincipal(accountRole.roleArn)
        .withConditions({
          // Every session names a user, a team and an invitee (or the unused marker), and nothing else
          StringLike: Object.fromEntries(accountTags.map((key) => [`aws:RequestTag/${key}`, "?*"])),
          "ForAllValues:StringEquals": { "aws:TagKeys": accountTags },
        })
        .withSessionTags(),
      inlinePolicies: {
        CallerPartitionsOnly: new PolicyDocument({
          statements: [
            new PolicyStatement({
              sid: "CallerItemsOnly",
              effect: Effect.ALLOW,
              // GetItem also covers TransactGetItems; Put, Delete, Update and
              // ConditionCheck cover TransactWriteItems (team creation, invite acceptance)
              actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem", "dynamodb:UpdateItem", "dynamodb:ConditionCheckItem", "dynamodb:Query"],
              resources: [tableArn, `${tableArn}/index/${GSI2}`],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [
                    `USER#${tag(ACCOUNT_SESSION_TAGS.userId)}`,
                    `TEAM#${tag(ACCOUNT_SESSION_TAGS.teamId)}`,
                    `INVITEE#${tag(ACCOUNT_SESSION_TAGS.invitee)}`,
                  ],
                },
              },
            }),
            // Another member's team-switcher row, which an owner's role change
            // or removal updates or deletes in the same transaction as the
            // membership. No reads or puts in that partition, an update may
            // name only the keys and `role` (so it can't write anything else,
            // and with its attribute_exists(PK) condition can't create a row),
            // and nothing is returned. IAM can't limit the sort key, so a
            // delete could still reach the member's other rows in it; the
            // handler sets the tag only after its checks (docs/infrastructure.md)
            new PolicyStatement({
              sid: "MemberSwitcherRowOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:UpdateItem", "dynamodb:DeleteItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [`USER#${tag(ACCOUNT_SESSION_TAGS.member)}`],
                  "dynamodb:Attributes": [...MEMBER_ROW_ATTRIBUTES],
                },
                StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
              },
            }),
            // The day's invite counter for the address an owner is inviting
            // (the per-invitee rate limit), moved in the same transaction as
            // the invite. Only UpdateItem, only the counter's attributes, and
            // nothing returned, so a session with this tag can't read or
            // write anything else about that address. The handler sets the
            // tag only after an owner's checks, for the address in the invite
            new PolicyStatement({
              sid: "InviteLimitCounterOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:UpdateItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [`${INVITE_LIMIT_PREFIX}${tag(ACCOUNT_SESSION_TAGS.inviteLimit)}`],
                  "dynamodb:Attributes": [...INVITE_LIMIT_ATTRIBUTES],
                },
                StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
              },
            }),
            tableKeyStatement(),
          ],
        }),
      },
    });
    this.accountFunction.addToRolePolicy(
      new PolicyStatement({ actions: ["sts:AssumeRole", "sts:TagSession"], resources: [this.accountAccessRole.roleArn] }),
    );
    this.accountFunction.addEnvironment(API_ENV.accountRoleArn, this.accountAccessRole.roleArn);
    // Invite emails (supply-checkout-5tp): ses:SendEmail on the domain identity and the
    // configuration set only, from noreply@<env domain> only (lib/email.ts)
    grantSendEmail(this.accountFunction, config);
    // A deleted account's record (user ID, time, teams it closed), in the primary region's bucket
    grantPutDeletionRecords(this.accountFunction, config, "user");

    const billing = this.addBilling(config, table, tableArn, region, appOrigin, ssm(identity.issuerUrl), tableKeyStatement);
    this.billingFunction = billing.fn;
    this.billingAccessRole = billing.role;
    const events = this.addBillingEvents(config, table, tableArn, region, tableKeyStatement);
    this.webhookFunction = events.webhook;
    this.billingQueue = events.queue;
    this.billingDeadLetterQueue = events.deadLetterQueue;
    this.billingWorker = events.worker;
    this.billingWorkerRole = events.role;
    this.seatQueue = events.seatQueue;
    this.seatDeadLetterQueue = events.seatDeadLetterQueue;
    // Seat syncs after a membership change (supply-checkout-l50, backend/src/billing/seats.ts):
    // the account function may send to the seat sync queue, and never to the billing queue
    this.accountFunction.addToRolePolicy(new PolicyStatement({ sid: "QueueSeatSyncs", actions: ["sqs:SendMessage"], resources: [events.seatQueue.queueArn] }));
    this.accountFunction.addEnvironment(BILLING_ENV.seatQueueUrl, events.seatQueue.queueUrl);

    // The API
    this.api = new HttpApi(this, "HttpApi", {
      apiName: `supply-checkout-${config.envName}`,
      description: "Supply Checkout data and sign-in API (docs/api/openapi.yaml)",
      createDefaultStage: false,
      disableExecuteApiEndpoint: true,
      corsPreflight: {
        allowOrigins: origins,
        allowMethods: [CorsHttpMethod.GET, CorsHttpMethod.PUT, CorsHttpMethod.PATCH, CorsHttpMethod.DELETE, CorsHttpMethod.POST],
        allowHeaders: ["authorization", "content-type", IDEMPOTENCY_HEADER],
        // The auth routes' cookie
        allowCredentials: true,
        maxAge: Duration.hours(1),
      },
    });
    const accessLogs = new LogGroup(this, "AccessLogs", { retention: LOG_RETENTION });
    const stage = new HttpStage(this, "DefaultStage", {
      httpApi: this.api,
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 200, burstLimit: 400 },
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogs),
        // One JSON object per request. Status and latency are bare numbers, so
        // Logs Insights can take percentiles of them (see "Data API" in docs/infrastructure.md)
        format: AccessLogFormat.custom(
          [
            '{"requestId":"$context.requestId"',
            '"routeKey":"$context.routeKey"',
            '"status":$context.status',
            '"latencyMs":$context.responseLatency',
            '"integrationLatencyMs":"$context.integrationLatency"',
            '"integrationError":"$context.integrationErrorMessage"',
            '"authorizerError":"$context.authorizer.error"',
            '"sub":"$context.authorizer.claims.sub"',
            '"ip":"$context.identity.sourceIp"',
            '"userAgent":"$context.identity.userAgent"',
            '"time":$context.requestTimeEpoch}',
          ].join(","),
        ),
      },
    });

    const authorizer = cognitoJwtAuthorizer(this, { envName: config.envName });
    // RouteSettings is a JSON map in CloudFormation, so it takes CloudFormation's casing
    const routeSettings: Record<string, { ThrottlingRateLimit: number; ThrottlingBurstLimit: number }> = {};
    const dataIntegration = new HttpLambdaIntegration("DataIntegration", this.live(this.dataFunction));
    for (const route of DATA_ROUTES) {
      const added = this.api.addRoutes({ path: route.path, methods: [route.method as HttpMethod], integration: dataIntegration, authorizer });
      // Heavy routes (the CSV import) get their own throttle, below the stage's
      if (route.throttle) {
        stage.node.addDependency(...added);
        routeSettings[routeKey(route)] = { ThrottlingRateLimit: route.throttle.rate, ThrottlingBurstLimit: route.throttle.burst };
      }
    }
    const accountIntegration = new HttpLambdaIntegration("AccountIntegration", this.live(this.accountFunction));
    for (const route of ACCOUNT_ROUTES) {
      const added = this.api.addRoutes({ path: route.path, methods: [route.method as HttpMethod], integration: accountIntegration, authorizer });
      // Route settings name the route, so it must exist first
      stage.node.addDependency(...added);
      routeSettings[routeKey(route)] = { ThrottlingRateLimit: route.throttle.rate, ThrottlingBurstLimit: route.throttle.burst };
    }
    const billingIntegration = new HttpLambdaIntegration("BillingIntegration", this.live(this.billingFunction));
    for (const route of BILLING_ROUTES) {
      const added = this.api.addRoutes({ path: route.path, methods: [route.method as HttpMethod], integration: billingIntegration, authorizer });
      stage.node.addDependency(...added);
      routeSettings[routeKey(route)] = { ThrottlingRateLimit: route.throttle.rate, ThrottlingBurstLimit: route.throttle.burst };
    }
    if (this.isPrimaryRegion) {
      const ops = this.addOps(config, table, tableArn, tableKeyStatement);
      this.opsFunction = ops.fn;
      this.operatorAccessRole = ops.role;
      this.opsReopenFunction = ops.reopen;
      this.operatorReopenRole = ops.reopenRole;
      const opsAuthorizer = opsJwtAuthorizer(this, { envName: config.envName });
      const opsIntegration = new HttpLambdaIntegration("OpsIntegration", this.live(ops.fn));
      for (const route of OPS_ROUTES) {
        const added = this.api.addRoutes({ path: route.path, methods: [route.method as HttpMethod], integration: opsIntegration, authorizer: opsAuthorizer });
        stage.node.addDependency(...added);
        routeSettings[routeKey(route)] = { ThrottlingRateLimit: route.throttle.rate, ThrottlingBurstLimit: route.throttle.burst };
      }
    }
    // Stripe's webhook: no authorizer, the Stripe signature is checked in the function
    const webhookIntegration = new HttpLambdaIntegration("WebhookIntegration", this.live(this.webhookFunction));
    for (const route of WEBHOOK_ROUTES) {
      const added = this.api.addRoutes({ path: route.path, methods: [route.method as HttpMethod], integration: webhookIntegration });
      stage.node.addDependency(...added);
      routeSettings[routeKey(route)] = { ThrottlingRateLimit: route.throttle.rate, ThrottlingBurstLimit: route.throttle.burst };
      Validations.of(added[0] as Construct).acknowledge({
        id: "AwsSolutions-APIG4",
        reason: "Stripe calls the webhook without a Cognito token; the function verifies the Stripe-Signature header against the endpoint's signing secret before it does anything.",
      });
    }
    (stage.node.defaultChild as CfnStage).routeSettings = routeSettings;
    const authIntegration = new HttpLambdaIntegration("AuthIntegration", this.live(this.authFunction));
    for (const route of AUTH_ROUTES) {
      const [added] = this.api.addRoutes({ path: route.path, methods: [route.method as HttpMethod], integration: authIntegration });
      Validations.of(added as Construct).acknowledge({
        id: "AwsSolutions-APIG4",
        reason: "Sign-in session endpoints run before the app has an access token; they authenticate with the HttpOnly refresh-token cookie (SameSite=Strict) plus an Origin check, in the auth function.",
      });
    }

    // api.<env domain>
    const domain = new DomainName(this, "ApiDomain", {
      domainName: names.api,
      certificate: Certificate.fromCertificateArn(this, "ApiCertificate", ssm(domainOutputParameters(config.envName).apiCertificateArn)),
      securityPolicy: SecurityPolicy.TLS_1_2,
    });
    new ApiMapping(this, "ApiMapping", { api: this.api, domainName: domain, stage });
    const zone = importZone(this, config);
    const target = RecordTarget.fromAlias(new ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId));
    // Latency records: one per region, told apart by the region (ADR 0010)
    const routing = { zone, recordName: names.api, target, region, setIdentifier: `api-${region}` };
    new ARecord(this, "ApiAlias", routing);
    new AaaaRecord(this, "ApiAliasIpv6", routing);

    new StringParameter(this, "ApiIdParam", { parameterName: outputs.apiId, stringValue: this.api.apiId, description: "HTTP API ID in this region" });
    new StringParameter(this, "ApiUrlParam", { parameterName: outputs.url, stringValue: `https://${names.api}`, description: "API base URL" });
  }

  /**
   * The billing function and the billing-access role it assumes (ADR 0009,
   * supply-checkout-x0l). Owners start Stripe Checkout through it. Its own
   * role can't reach the table: it may assume the billing-access role, and
   * read the one Stripe secret key for this environment and mode
   * (secretsmanager:GetSecretValue on that secret's ARN only). The
   * billing-access role, tagged with the path's team and (once Stripe has
   * made it) the team's Stripe customer, may:
   *
   * - GetItem in `TEAM#<teamId>` (the membership check and the team).
   * - UpdateItem in `TEAM#<teamId>` naming only the keys and
   *   `stripeCustomerId`, returning nothing (linking the customer).
   * - PutItem in `STRIPE#<stripeCustomer>` naming only the link's
   *   attributes, returning nothing.
   *
   * No Query, Scan or DeleteItem, and no other team's partition.
   */
  private addBilling(config: DeploymentConfig, table: string, tableArn: string, region: string, appOrigin: string, issuerUrl: string, tableKeyStatement: () => PolicyStatement) {
    const mode = stripeModeOf(config);
    const fn = this.handler("BillingFunction", "billing", {
      memorySize: 512,
      description: "Starts Stripe Checkout for a team's owner (ADR 0009)",
      environment: {
        [API_ENV.tableName]: table,
        [API_ENV.issuerUrl]: issuerUrl,
        [API_ENV.appUrl]: appOrigin,
        [STRIPE_ENV.secretId]: stripeSecretName(config.envName, mode),
        [STRIPE_ENV.mode]: mode,
      },
    });
    const fnRole = fn.role;
    if (!fnRole) throw new Error("The billing function has no role");
    const tag = (key: string) => `\${aws:PrincipalTag/${key}}`;
    const tags = Object.values(BILLING_SESSION_TAGS);
    const team = `TEAM#${tag(BILLING_SESSION_TAGS.teamId)}`;
    const role = new Role(this, "BillingAccessRole", {
      description: "Assumed by the billing function per request, tagged with the team and its Stripe customer: reads the team, and links the customer",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new ArnPrincipal(fnRole.roleArn)
        .withConditions({
          // Every session names a team and a customer (or the unused marker), and nothing else
          StringLike: Object.fromEntries(tags.map((key) => [`aws:RequestTag/${key}`, "?*"])),
          "ForAllValues:StringEquals": { "aws:TagKeys": tags },
        })
        .withSessionTags(),
      inlinePolicies: {
        TeamAndCustomerLinkOnly: new PolicyDocument({
          statements: [
            // GetItem also covers TransactGetItems (the membership check)
            new PolicyStatement({
              sid: "TeamReadOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:GetItem"],
              resources: [tableArn],
              conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [team] } },
            }),
            // The team's Stripe customer, in the same transaction as the link
            new PolicyStatement({
              sid: "TeamStripeCustomerOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:UpdateItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [team], "dynamodb:Attributes": [...CUSTOMER_LINK_TEAM_ATTRIBUTES] },
                StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
              },
            }),
            // The customer's link to the team: only the customer Stripe returned (the tag)
            new PolicyStatement({
              sid: "StripeLinkOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:PutItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [`${STRIPE_LINK_PREFIX}${tag(BILLING_SESSION_TAGS.stripeCustomer)}`],
                  "dynamodb:Attributes": [...STRIPE_LINK_ATTRIBUTES],
                },
                StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
              },
            }),
            tableKeyStatement(),
          ],
        }),
      },
    });
    fn.addToRolePolicy(new PolicyStatement({ actions: ["sts:AssumeRole", "sts:TagSession"], resources: [role.roleArn] }));
    fn.addEnvironment(API_ENV.billingRoleArn, role.roleArn);
    // The Stripe secret key: this one secret only. It's encrypted with Secrets Manager's
    // AWS managed key, which needs no KMS grant here
    fn.addToRolePolicy(
      new PolicyStatement({
        sid: "ReadStripeSecretKey",
        actions: ["secretsmanager:GetSecretValue"],
        resources: [stripeSecretArn({ partition: Aws.PARTITION, region, account: Aws.ACCOUNT_ID }, config.envName, mode)],
      }),
    );
    return { fn, role };
  }

  /**
   * Stripe's webhook, the billing queue and the billing worker (ADR 0009,
   * supply-checkout-2kl), in every region.
   *
   * - The webhook function verifies an event's Stripe signature with the
   *   endpoint's signing secret, puts it on the queue, and answers. It may
   *   read that one secret and send to that one queue: no table, no Stripe
   *   API key.
   * - The queue is FIFO, grouped by Stripe customer and deduplicated by
   *   event ID. A message that fails BILLING_MAX_RECEIVES times goes to the
   *   dead-letter queue (the "Billing events stuck" alarm). Only the webhook
   *   may send to it.
   * - The seat sync queue (supply-checkout-l50) is FIFO too, grouped by
   *   Stripe customer, with its own dead-letter queue ("Seat syncs stuck"):
   *   the account function sends one after a membership change, and the
   *   nightly seat reconciliation (observability/ops-checks.ts) one per team.
   *   A seat sync names only a Stripe customer; the worker finds the team
   *   from its link, and takes only seat syncs from this queue
   *   (SEAT_QUEUE_ARN), so neither sender can pass off a Stripe event.
   * - The worker applies each event, and sets a subscription's seat
   *   quantity to the team's billed members. Its own role can't reach the
   *   table: it may read the Stripe secret key, send owner emails (grantSendEmail), and
   *   assume the billing-worker role tagged with the event, its customer and
   *   (once the link is read) the team. That role may:
   *   - GetItem and PutItem in `WEBHOOK#<eventId>`, naming only the event
   *     records' attributes (WEBHOOK_RECORD_ATTRIBUTES), returning nothing.
   *   - GetItem in `STRIPE#<stripeCustomer>` naming only the keys and `teamId`.
   *   - GetItem and Query in `TEAM#<teamId>` naming only
   *     BILLING_READ_ATTRIBUTES (projected reads only).
   *   - UpdateItem in `TEAM#<teamId>` naming only BILLING_UPDATE_ATTRIBUTES,
   *     returning nothing.
   */
  private addBillingEvents(config: DeploymentConfig, table: string, tableArn: string, region: string, tableKeyStatement: () => PolicyStatement) {
    const mode = stripeModeOf(config);
    const names = billingResourceNames(config.envName);
    const where = { partition: Aws.PARTITION, region, account: Aws.ACCOUNT_ID };
    const deadLetterQueue = new Queue(this, "BillingEventsDeadLetterQueue", {
      queueName: names.deadLetterQueue,
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(deadLetterQueue).acknowledge({
      id: "AwsSolutions-SQS3",
      reason: "This is the dead-letter queue: it holds Stripe events the billing worker couldn't apply, for replay.",
    });
    const workerTimeout = Duration.seconds(30);
    const queue = new Queue(this, "BillingEventsQueue", {
      queueName: names.queue,
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // Six times the worker's timeout, as Lambda recommends for an SQS event source
      visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: BILLING_MAX_RECEIVES },
    });

    const seatDeadLetterQueue = new Queue(this, "SeatSyncsDeadLetterQueue", {
      queueName: names.seatDeadLetterQueue,
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    Validations.of(seatDeadLetterQueue).acknowledge({
      id: "AwsSolutions-SQS3",
      reason: "This is the dead-letter queue: it holds seat syncs the billing worker couldn't apply; the nightly reconciliation fixes their teams anyway.",
    });
    const seatQueue = new Queue(this, "SeatSyncsQueue", {
      queueName: names.seatQueue,
      fifo: true,
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: seatDeadLetterQueue, maxReceiveCount: BILLING_MAX_RECEIVES },
    });

    const webhook = this.handler(
      "BillingWebhookFunction",
      "webhook",
      {
        memorySize: 256,
        description: "Stripe's webhook: verifies each event's signature and queues it (ADR 0009)",
        environment: { [STRIPE_ENV.mode]: mode, [BILLING_ENV.webhookSecretId]: stripeWebhookSecretName(config.envName, mode), [BILLING_ENV.queueUrl]: queue.queueUrl },
      },
      "billing",
    );
    webhook.addToRolePolicy(new PolicyStatement({ sid: "ReadStripeWebhookSecret", actions: ["secretsmanager:GetSecretValue"], resources: [stripeWebhookSecretArn(where, config.envName, mode)] }));
    webhook.addToRolePolicy(new PolicyStatement({ sid: "QueueBillingEvents", actions: ["sqs:SendMessage"], resources: [queue.queueArn] }));

    const worker = this.handler(
      "BillingWorkerFunction",
      "worker-entry",
      {
        memorySize: 512,
        timeout: workerTimeout,
        description: "Applies queued Stripe events to teams' plans, seats and status, and emails owners (ADR 0009)",
        environment: { [API_ENV.tableName]: table, [STRIPE_ENV.secretId]: stripeSecretName(config.envName, mode), [STRIPE_ENV.mode]: mode },
      },
      "billing",
    );
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 1, reportBatchItemFailures: true }));
    worker.addEventSource(new SqsEventSource(seatQueue, { batchSize: 1, reportBatchItemFailures: true }));
    worker.addEnvironment(BILLING_ENV.seatQueueArn, seatQueue.queueArn);
    worker.addToRolePolicy(new PolicyStatement({ sid: "ReadStripeSecretKey", actions: ["secretsmanager:GetSecretValue"], resources: [stripeSecretArn(where, config.envName, mode)] }));
    // Trial-ending, payment-failed and read-only emails to owners
    grantSendEmail(worker, config);
    const workerFnRole = worker.role;
    if (!workerFnRole) throw new Error("The billing worker has no role");
    const tag = (key: string) => `\${aws:PrincipalTag/${key}}`;
    const tags = Object.values(BILLING_WORKER_TAGS);
    const team = `TEAM#${tag(BILLING_WORKER_TAGS.teamId)}`;
    const role = new Role(this, "BillingWorkerRole", {
      description: "Assumed by the billing worker per event, tagged with the event, its Stripe customer and the customer's team: the event's records, the link, and the team's billing attributes",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new ArnPrincipal(workerFnRole.roleArn)
        .withConditions({
          StringLike: Object.fromEntries(tags.map((key) => [`aws:RequestTag/${key}`, "?*"])),
          "ForAllValues:StringEquals": { "aws:TagKeys": tags },
        })
        .withSessionTags(),
      inlinePolicies: {
        BillingEventScope: new PolicyDocument({
          statements: [
            new PolicyStatement({
              sid: "EventRecordsOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [`${WEBHOOK_RECORD_PREFIX}${tag(BILLING_WORKER_TAGS.eventId)}`],
                  "dynamodb:Attributes": [...WEBHOOK_RECORD_ATTRIBUTES],
                },
                StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES", "dynamodb:ReturnValues": "NONE" },
              },
            }),
            new PolicyStatement({
              sid: "StripeLinkTeamOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:GetItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [`${STRIPE_LINK_PREFIX}${tag(BILLING_WORKER_TAGS.stripeCustomer)}`],
                  "dynamodb:Attributes": [...STRIPE_LINK_READ_ATTRIBUTES],
                },
                // As AWS's attribute-level examples do: a read must name its attributes
                StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
              },
            }),
            new PolicyStatement({
              sid: "TeamBillingReadOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [team], "dynamodb:Attributes": [...BILLING_READ_ATTRIBUTES] },
                StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
              },
            }),
            new PolicyStatement({
              sid: "TeamBillingUpdateOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:UpdateItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [team], "dynamodb:Attributes": [...BILLING_UPDATE_ATTRIBUTES] },
                StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
              },
            }),
            tableKeyStatement(),
          ],
        }),
      },
    });
    worker.addToRolePolicy(new PolicyStatement({ actions: ["sts:AssumeRole", "sts:TagSession"], resources: [role.roleArn] }));
    worker.addEnvironment(BILLING_ENV.workerRoleArn, role.roleArn);
    return { webhook, queue, deadLetterQueue, seatQueue, seatDeadLetterQueue, worker, role };
  }

  /**
   * The ops function and the operator-access role it assumes (ADR 0015),
   * primary region only. The function's own role can't reach the table: it
   * may assume the operator-access role (tagged with the team a comp changes,
   * or "."), and call AdminListGroupsForUser on the operator pool. The
   * operator-access role may:
   *
   * - Query GSI3's OPS#TEAMS, OPS#OWNERS#* and OPS#AUDIT#* partitions, and
   *   only for what the index projects (dynamodb:Select), so never a team's
   *   sheets, inventory or invites: no base-table read of a TEAM# partition.
   * - UpdateItem in the tagged team's partition, naming only COMP_ATTRIBUTES
   *   (dynamodb:Attributes) and returning at most those.
   * - PutItem and Query in OPAUDIT#* partitions, never update or delete.
   * - Query GSI1's IMPORTS#COMMITTING partition for STUCK_IMPORT_ATTRIBUTES,
   *   and UpdateItem in the tagged team's partition naming only its GSI1
   *   keys (IMPORT_INDEX_ATTRIBUTES): listing stuck imports and taking one
   *   out of the stuck-import check.
   */
  private addOps(config: DeploymentConfig, table: string, tableArn: string, tableKeyStatement: () => PolicyStatement) {
    const identity = identityOutputParameters(config.envName);
    const ssm = (name: string) => StringParameter.valueForStringParameter(this, name);
    const fn = this.handler(
      "OpsFunction",
      "ops",
      {
        memorySize: 512,
        description: "Platform operators: teams, comps and the operator audit (ADR 0015)",
        environment: {
          [API_ENV.tableName]: table,
          [API_ENV.opsIssuerUrl]: ssm(identity.opsIssuerUrl),
          [API_ENV.opsClientId]: ssm(identity.opsClientId),
          [API_ENV.opsUserPoolId]: ssm(identity.opsUserPoolId),
        },
      },
      "operator",
    );
    const fnRole = fn.role;
    if (!fnRole) throw new Error("The ops function has no role");
    const tag = `\${aws:PrincipalTag/${OPS_SESSION_TAG}}`;
    const role = new Role(this, "OperatorAccessRole", {
      description: "Assumed by the ops function per request (ADR 0015): the operators' index, one team's comp attributes, and append-only operator audit",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new ArnPrincipal(fnRole.roleArn)
        .withConditions({
          StringLike: { [`aws:RequestTag/${OPS_SESSION_TAG}`]: "?*" },
          "ForAllValues:StringEquals": { "aws:TagKeys": [OPS_SESSION_TAG] },
        })
        .withSessionTags(),
      inlinePolicies: {
        OperatorScope: new PolicyDocument({
          statements: [
            new PolicyStatement({
              sid: "OpsIndexProjectionOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:Query"],
              resources: [`${tableArn}/index/${GSI3}`],
              conditions: {
                "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [OPS_TEAMS_PARTITION, `${OPS_OWNERS_PREFIX}*`, `${OPS_AUDIT_INDEX_PREFIX}*`] },
                StringEquals: { "dynamodb:Select": ["ALL_PROJECTED_ATTRIBUTES", "SPECIFIC_ATTRIBUTES"] },
              },
            }),
            // The comp: only UpdateItem, only the tagged team's partition,
            // only the comp attributes (and the keys, type and version its
            // condition names). No PutItem or DeleteItem there, which would
            // replace or remove whole items
            new PolicyStatement({
              sid: "CompAttributesOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:UpdateItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [`TEAM#${tag}`],
                  "dynamodb:Attributes": [...COMP_ATTRIBUTES],
                },
                StringEqualsIfExists: { "dynamodb:ReturnValues": ["NONE", "UPDATED_OLD", "UPDATED_NEW"] },
              },
            }),
            // Stuck imports (docs/journeys.md, J2): list GSI1's committing-imports
            // partition, naming only the keys and progress, as the scheduled
            // check does; and take one out of it by removing its GSI1 keys,
            // naming nothing else. The update's condition (GSI1PK is that
            // partition) keeps it to an import job: IAM can't limit the sort key
            new PolicyStatement({
              sid: "StuckImportsListOnly",
              effect: Effect.ALLOW,
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
            new PolicyStatement({
              sid: "StuckImportIndexKeysOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:UpdateItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [`TEAM#${tag}`],
                  "dynamodb:Attributes": [...IMPORT_INDEX_ATTRIBUTES],
                },
                StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
              },
            }),
            new PolicyStatement({
              sid: "OperatorAuditAppendOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:PutItem", "dynamodb:Query"],
              resources: [tableArn],
              conditions: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": [`${OPERATOR_AUDIT_PREFIX}*`] } },
            }),
            tableKeyStatement(),
          ],
        }),
      },
    });
    fn.addToRolePolicy(new PolicyStatement({ actions: ["sts:AssumeRole", "sts:TagSession"], resources: [role.roleArn] }));
    fn.addToRolePolicy(new PolicyStatement({ actions: ["cognito-idp:AdminListGroupsForUser"], resources: [ssm(identity.opsUserPoolArn)] }));
    fn.addEnvironment(API_ENV.opsRoleArn, role.roleArn);

    // The operator reopen function (supply-checkout-6uw.6). Reopening a team
    // removes its closure fields; IAM can't tell removing an attribute from
    // setting it, so a role that could reopen a team could also close one and
    // have the purge delete it. The operator-access role gets none of them.
    // This function, with no route and only the ops function allowed to
    // invoke it, takes plain values and only removes them. Like the others,
    // its own role can't reach the table: per request it assumes the
    // operator-reopen role, tagged with the team, which may GetItem and
    // UpdateItem only that team's items naming only REOPEN_ATTRIBUTES,
    // returning nothing, and put and query only that team's operator audit.
    const reopen = this.handler(
      "OpsReopenFunction",
      "reopen",
      { memorySize: 256, description: "Reopens a closed team for the ops function, audited (ADR 0015)", environment: { [API_ENV.tableName]: table } },
      "operator",
    );
    const reopenFnRole = reopen.role;
    if (!reopenFnRole) throw new Error("The reopen function has no role");
    const reopenRole = new Role(this, "OperatorReopenRole", {
      description: "Assumed by the operator reopen function per request, tagged with the team (ADR 0015): that team's closure fields, and its operator audit",
      maxSessionDuration: Duration.hours(1),
      assumedBy: new ArnPrincipal(reopenFnRole.roleArn)
        .withConditions({
          StringLike: { [`aws:RequestTag/${OPS_SESSION_TAG}`]: "?*" },
          "ForAllValues:StringEquals": { "aws:TagKeys": [OPS_SESSION_TAG] },
        })
        .withSessionTags(),
      inlinePolicies: {
        ReopenScope: new PolicyDocument({
          statements: [
            new PolicyStatement({
              sid: "ReopenClosureFieldsOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
              resources: [tableArn],
              conditions: {
                "ForAllValues:StringEquals": {
                  "dynamodb:LeadingKeys": [`TEAM#${tag}`],
                  "dynamodb:Attributes": [...REOPEN_ATTRIBUTES],
                },
                // A GetItem without a projection names no attributes and would return the whole
                // item: Select must be SPECIFIC_ATTRIBUTES (a ProjectionExpression implies it)
                StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES", "dynamodb:ReturnValues": "NONE" },
              },
            }),
            new PolicyStatement({
              sid: "TeamOperatorAuditAppendOnly",
              effect: Effect.ALLOW,
              actions: ["dynamodb:PutItem", "dynamodb:Query"],
              resources: [tableArn],
              conditions: { "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": [`${OPERATOR_AUDIT_PREFIX}${tag}`] } },
            }),
            tableKeyStatement(),
          ],
        }),
      },
    });
    reopen.addToRolePolicy(new PolicyStatement({ actions: ["sts:AssumeRole", "sts:TagSession"], resources: [reopenRole.roleArn] }));
    reopen.addEnvironment(API_ENV.opsReopenRoleArn, reopenRole.roleArn);
    // Only the ops function may invoke it, and only the unqualified function
    fn.addToRolePolicy(new PolicyStatement({ sid: "InvokeReopenOnly", actions: ["lambda:InvokeFunction"], resources: [reopen.functionArn] }));
    fn.addEnvironment(API_ENV.opsReopenFunction, reopen.functionName);
    return { fn, role, reopen, reopenRole };
  }

  /** A function from backend/src/<dir>/<name>.ts. */
  private handler(id: string, name: string, props: { memorySize: number; description: string; environment: Record<string, string>; timeout?: Duration }, dir = "api"): NodejsFunction {
    // Its own log group and a role that can write only to it (instead of
    // AWSLambdaBasicExecutionRole, which allows every log group)
    const logGroup = new LogGroup(this, `${id}Logs`, { retention: LOG_RETENTION });
    const role = new Role(this, `${id}Role`, {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      description: `Execution role for the ${name} function`,
    });
    role.addToPolicy(new PolicyStatement({ actions: ["logs:CreateLogStream", "logs:PutLogEvents"], resources: [logGroup.logGroupArn] }));
    return new NodejsFunction(this, id, {
      role,
      logGroup,
      entry: `${BACKEND}src/${dir}/${name}.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: props.memorySize,
      timeout: props.timeout ?? Duration.seconds(10),
      description: props.description,
      environment: { NODE_OPTIONS: "--enable-source-maps", ...props.environment },
      bundling,
    });
  }

  /** The `live` alias the API invokes, which CodeDeploy will shift between versions (ADR 0012). */
  private live(fn: NodejsFunction): IFunction {
    return new Alias(this, `${fn.node.id}Live`, { aliasName: "live", version: fn.currentVersion });
  }
}
