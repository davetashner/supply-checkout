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
  DATA_ROUTES,
  IDEMPOTENCY_HEADER,
  routeKey,
  TEAM_SESSION_TAG,
} from "../../../backend/src/api/routes.js";
import { GSI1, GSI2, tableName } from "../../../backend/src/data/schema.js";
import type { DeploymentConfig } from "../config.js";
import { domainOutputParameters, hostNames, importZone } from "../domain.js";
import { cognitoJwtAuthorizer, identityOptionsFromContext, identityOutputParameters, LOCAL_DEV_ORIGIN } from "../identity.js";
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
 * - Account routes (/me, POST /teams, POST /invites/{inviteId}/accept): the
 *   signed-in user's teams and invites, creating a team and accepting an
 *   invite, behind the same authorizer, served by the `account` function.
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
 *   (always the token's `sub`), `teamId` and `invitee`, and that role may only
 *   touch items whose partition key is `USER#<userId>` or `TEAM#<teamId>`, or
 *   GSI2's `INVITEE#<invitee>` (the hashed verified email). The handler tags a
 *   team only when the request is entitled to it (backend/src/api/account-db.ts).
 *   No Scan, no BatchWriteItem, and never another user's partition.
 * - Functions are NodejsFunction (Node.js 24, arm64) behind a `live` alias,
 *   ready for CodeDeploy canaries (ADR 0012). The data function has 1 GB of
 *   memory for CPU: its work is JSON and TLS, and more memory means less
 *   latency (the README's "Data API" says how to measure p95).
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
      description: "The signed-in user's teams and invites; creates teams and accepts invites",
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
      description: "Assumed by the account function per request, tagged with the user and at most one team and invitee; reaches only those partitions",
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
            tableKeyStatement(),
          ],
        }),
      },
    });
    this.accountFunction.addToRolePolicy(
      new PolicyStatement({ actions: ["sts:AssumeRole", "sts:TagSession"], resources: [this.accountAccessRole.roleArn] }),
    );
    this.accountFunction.addEnvironment(API_ENV.accountRoleArn, this.accountAccessRole.roleArn);

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
        // Logs Insights can take percentiles of them (see the README's "Data API")
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
    const dataIntegration = new HttpLambdaIntegration("DataIntegration", this.live(this.dataFunction));
    for (const route of DATA_ROUTES) {
      this.api.addRoutes({ path: route.path, methods: [route.method as HttpMethod], integration: dataIntegration, authorizer });
    }
    const accountIntegration = new HttpLambdaIntegration("AccountIntegration", this.live(this.accountFunction));
    // RouteSettings is a JSON map in CloudFormation, so it takes CloudFormation's casing
    const routeSettings: Record<string, { ThrottlingRateLimit: number; ThrottlingBurstLimit: number }> = {};
    for (const route of ACCOUNT_ROUTES) {
      const added = this.api.addRoutes({ path: route.path, methods: [route.method as HttpMethod], integration: accountIntegration, authorizer });
      // Route settings name the route, so it must exist first
      stage.node.addDependency(...added);
      routeSettings[routeKey(route)] = { ThrottlingRateLimit: route.throttle.rate, ThrottlingBurstLimit: route.throttle.burst };
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

  /** A function from backend/src/api/<name>.ts. */
  private handler(id: string, name: string, props: { memorySize: number; description: string; environment: Record<string, string> }): NodejsFunction {
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
      entry: `${BACKEND}src/api/${name}.ts`,
      projectRoot: BACKEND,
      depsLockFilePath: `${BACKEND}package-lock.json`,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: props.memorySize,
      timeout: Duration.seconds(10),
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
