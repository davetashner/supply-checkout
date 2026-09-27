import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { LIVE_AUDIENCE_ATTRIBUTES } from "../../backend/src/data/schema.js";
import { CONSUMER_TIMEOUT_SECONDS, REALTIME_ENV, STREAM_BATCH_SIZE } from "../../backend/src/realtime/channels.js";
import { APPROVED_REGIONS, type DeploymentConfig, GLOBAL_SERVICES_REGION } from "../lib/config.js";
import { realtimeOutputParameters } from "../lib/stacks/realtime-stack.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names come from lib/config.ts only (ADR 0010)
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function realtime(region: string = EAST, overrides: Partial<DeploymentConfig> = {}) {
  // Bundling is skipped in tests (it needs backend/node_modules); `npm run synth` bundles for real
  const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [] } });
  const stack = addSupplyCheckout(app, { ...config, ...overrides }).regions[region]?.realtime;
  if (!stack) throw new Error(`No realtime stack in ${region}`);
  return Template.fromStack(stack);
}

type Resource = { Properties: Record<string, unknown> };
const resources = (t: Template, type: string) => Object.entries(t.findResources(type)) as [string, Resource][];
const statements = (t: Template): ({ policy: string } & Record<string, unknown>)[] =>
  resources(t, "AWS::IAM::Policy").flatMap(([id, p]) =>
    ((p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement).map((s) => ({ policy: id, ...s })),
  );
const authorizerId = (t: Template) => {
  const [[id]] = resources(t, "AWS::Lambda::Function").filter(([id]) => id.startsWith("Authorizer")) as [[string, Resource]];
  return id;
};

describe("Event API authorization", () => {
  it("lets clients connect and subscribe only through the Lambda authorizer, and publish only with IAM, with nothing cached", () => {
    const t = realtime();
    t.hasResourceProperties("AWS::AppSync::Api", {
      Name: "supply-checkout-prod-realtime",
      EventConfig: {
        AuthProviders: [
          { AuthType: "AWS_IAM" },
          { AuthType: "AWS_LAMBDA", LambdaAuthorizerConfig: { AuthorizerResultTtlInSeconds: 0, AuthorizerUri: { "Fn::GetAtt": [authorizerId(t), "Arn"] } } },
        ],
        ConnectionAuthModes: [{ AuthType: "AWS_LAMBDA" }],
        DefaultPublishAuthModes: [{ AuthType: "AWS_IAM" }],
        DefaultSubscribeAuthModes: [{ AuthType: "AWS_LAMBDA" }],
        LogConfig: { LogLevel: "ERROR", CloudWatchLogsRoleArn: Match.anyValue() },
      },
    });
  });

  it("has one namespace, users, that clients can subscribe to and only IAM can publish to", () => {
    const t = realtime();
    t.resourceCountIs("AWS::AppSync::ChannelNamespace", 1);
    t.hasResourceProperties("AWS::AppSync::ChannelNamespace", {
      Name: "users",
      PublishAuthModes: [{ AuthType: "AWS_IAM" }],
      SubscribeAuthModes: [{ AuthType: "AWS_LAMBDA" }],
    });
    t.resourceCountIs("AWS::AppSync::ApiKey", 0);
  });

  it("lets only AppSync, for this API, invoke the authorizer", () => {
    const t = realtime();
    const permissions = resources(t, "AWS::Lambda::Permission").map(([, p]) => p.Properties);
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toMatchObject({
      Action: "lambda:InvokeFunction",
      FunctionName: { "Fn::GetAtt": [authorizerId(t), "Arn"] },
      Principal: "appsync.amazonaws.com",
      SourceArn: { "Fn::GetAtt": [expect.stringMatching(/^EventApi/), "ApiArn"] },
    });
  });

  it("gives the authorizer the user pool and client, read from SSM at deploy time, and no table", () => {
    const t = realtime();
    const [[, fn]] = resources(t, "AWS::Lambda::Function").filter(([id]) => id === authorizerId(t)) as [[string, Resource]];
    expect(fn.Properties).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"] });
    const vars = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(vars[REALTIME_ENV.userPoolId]).toEqual({ Ref: expect.stringMatching(/identityuserpoolid/) });
    expect(vars[REALTIME_ENV.clientId]).toEqual({ Ref: expect.stringMatching(/identitywebclientid/) });
    expect(vars[REALTIME_ENV.tableName]).toBeUndefined();
  });

  it("gives the authorizer no DynamoDB or KMS access: it only compares the channel with the token", () => {
    const t = realtime();
    const mine = statements(t).filter((s) => s.policy.startsWith("AuthorizerRole"));
    expect(mine.map((s) => s.Action)).toEqual([["logs:CreateLogStream", "logs:PutLogEvents"]]);
  });
});

describe("the stream consumer", () => {
  it("is the only principal that may publish, and only to the users namespace", () => {
    const t = realtime();
    const publish = statements(t).filter((s) => JSON.stringify(s.Action).includes("appsync:"));
    expect(publish).toHaveLength(1);
    expect(publish[0]?.policy).toMatch(/^PublisherRole/);
    expect(publish[0]?.Action).toBe("appsync:EventPublish");
    expect(JSON.stringify(publish[0]?.Resource)).toMatch(/\/channelNamespace\/users"\]\]\}$/);
  });

  it("reads the table's stream from SSM, filtered to products, sheets, members and team metadata, with partial batch failures and a dead-letter queue", () => {
    const t = realtime();
    const [[, mapping]] = resources(t, "AWS::Lambda::EventSourceMapping") as [[string, Resource]];
    expect(mapping.Properties).toMatchObject({
      EventSourceArn: { Ref: expect.stringMatching(/datatablestreamarn/) },
      StartingPosition: "LATEST",
      BatchSize: STREAM_BATCH_SIZE,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      BisectBatchOnFunctionError: true,
      MaximumBatchingWindowInSeconds: 0,
      MaximumRetryAttempts: 10,
      MaximumRecordAgeInSeconds: 3600,
      ParallelizationFactor: 1,
      DestinationConfig: { OnFailure: { Destination: { "Fn::GetAtt": [expect.stringMatching(/^DeadLetterQueue/), "Arn"] } } },
    });
    const patterns = (mapping.Properties.FilterCriteria as { Filters: { Pattern: string }[] }).Filters.map((f) => JSON.parse(f.Pattern));
    expect(patterns).toEqual([
      { dynamodb: { Keys: { SK: { S: [{ prefix: "PRODUCT#" }] } } } },
      { dynamodb: { Keys: { SK: { S: [{ prefix: "SHEET#" }] } } } },
      { dynamodb: { Keys: { SK: { S: [{ prefix: "MEMBER#" }] } } } },
      { dynamodb: { Keys: { SK: { S: ["META"] } } } },
    ]);
  });

  it("may read only who gets a team's changes: team partitions, and only the audience attributes", () => {
    const t = realtime();
    const reads = statements(t).filter((s) => s.policy.startsWith("PublisherRole") && JSON.stringify(s.Action).includes("dynamodb:") && !JSON.stringify(s.Action).includes("Stream"));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      Effect: "Allow",
      Action: ["dynamodb:GetItem", "dynamodb:Query"],
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "userId", "role", "status", "closedAt", "compPlan", "compUntil"] },
        StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
      },
    });
    // Closure ends notices; a live comp (ADR 0015) keeps an ended (but not closed) team's going
    expect([...LIVE_AUDIENCE_ATTRIBUTES]).toEqual(["PK", "SK", "userId", "role", "status", "closedAt", "compPlan", "compUntil"]);
    expect(JSON.stringify(reads[0]?.Resource)).toMatch(/table\/supply-checkout-prod-app"\]\]\}$/);
  });

  it("publishes to the API's own HTTP host, not the custom domain, and reads members from the app table", () => {
    realtime().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "supply-checkout-prod-live-updates",
      Timeout: CONSUMER_TIMEOUT_SECONDS,
      Environment: {
        Variables: Match.objectLike({
          [REALTIME_ENV.httpHost]: { "Fn::GetAtt": [Match.stringLikeRegexp("^EventApi"), "Dns.Http"] },
          [REALTIME_ENV.tableName]: "supply-checkout-prod-app",
        }),
      },
    });
  });

  it("has an encrypted dead-letter queue that refuses plain HTTP", () => {
    const t = realtime();
    t.hasResourceProperties("AWS::SQS::Queue", { QueueName: "supply-checkout-prod-live-updates-dlq", SqsManagedSseEnabled: true, MessageRetentionPeriod: 1209600 });
    t.hasResourceProperties("AWS::SQS::QueuePolicy", {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) },
    });
  });

  it("runs in the primary region only until phase 2", () => {
    const west = realtime(WEST);
    west.resourceCountIs("AWS::Lambda::EventSourceMapping", 0);
    west.resourceCountIs("AWS::SQS::Queue", 0);
    west.resourceCountIs("AWS::AppSync::Api", 1);
    const westPrimary = realtime(WEST, { regions: [WEST], primaryRegion: WEST });
    westPrimary.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
  });
});

describe("realtime.<env domain>", () => {
  it("is the API's custom domain in the global services region, with a CNAME in the imported zone", () => {
    const t = realtime(GLOBAL_SERVICES_REGION);
    t.hasResourceProperties("AWS::AppSync::DomainName", {
      DomainName: "realtime.supplycheckout.com",
      CertificateArn: { Ref: Match.stringLikeRegexp("domainrealtimecertificatearn") },
    });
    t.hasResourceProperties("AWS::AppSync::DomainNameApiAssociation", { DomainName: "realtime.supplycheckout.com" });
    t.hasResourceProperties("AWS::Route53::RecordSet", {
      Name: "realtime.supplycheckout.com.",
      Type: "CNAME",
      HostedZoneId: { Ref: Match.stringLikeRegexp("dnshostedzoneid") },
      ResourceRecords: [{ "Fn::GetAtt": [Match.stringLikeRegexp("^EventApiDomainName"), "AppSyncDomainName"] }],
    });
    const outputs = realtimeOutputParameters("prod");
    t.hasResourceProperties("AWS::SSM::Parameter", { Name: outputs.websocketUrl, Value: "wss://realtime.supplycheckout.com/event/realtime" });
    t.hasResourceProperties("AWS::SSM::Parameter", { Name: outputs.host, Value: "realtime.supplycheckout.com" });
    t.hasResourceProperties("AWS::SSM::Parameter", { Name: outputs.apiId });
  });

  it("follows the environment's domain", () => {
    realtime(GLOBAL_SERVICES_REGION, { envName: "staging" }).hasResourceProperties("AWS::AppSync::DomainName", {
      DomainName: "realtime.staging.supplycheckout.com",
    });
  });

  it("isn't added where the certificate isn't", () => {
    const other = APPROVED_REGIONS.find((r) => r !== GLOBAL_SERVICES_REGION) as string;
    const t = realtime(other);
    t.resourceCountIs("AWS::AppSync::DomainName", 0);
    t.resourceCountIs("AWS::Route53::RecordSet", 0);
  });
});
