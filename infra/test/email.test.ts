import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { EMAIL_ENV } from "../../backend/src/email/names.js";
import { APPROVED_REGIONS, type DeploymentConfig } from "../lib/config.js";
import { emailSettings, grantSendEmail } from "../lib/email.js";
import { EmailStack } from "../lib/stacks/email-stack.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names come from lib/config.ts only (ADR 0010)
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function build(overrides: Partial<DeploymentConfig> = {}) {
  // Bundling is skipped in tests (it needs backend/node_modules); `npm run synth` bundles for real
  const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [] } });
  return { app, stacks: addSupplyCheckout(app, { ...config, ...overrides }) };
}

type Resource = { Properties: Record<string, unknown> };
const resources = (t: Template, type: string) => Object.entries(t.findResources(type)) as [string, Resource][];
const statements = (t: Template) =>
  resources(t, "AWS::IAM::Policy").flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);

describe("settings", () => {
  it("sends from noreply at the env domain, links to the app, and uses SES in the primary region", () => {
    expect(emailSettings(config)).toEqual({
      fromAddress: "noreply@supplycheckout.com",
      identity: "supplycheckout.com",
      configurationSet: "supply-checkout-prod-transactional",
      region: EAST,
      appUrl: "https://app.supplycheckout.com",
    });
    expect(emailSettings({ ...config, envName: "staging" }).fromAddress).toBe("noreply@staging.supplycheckout.com");
  });
});

describe("domain stack: configuration set and events topic", () => {
  const domain = () => Template.fromStack(build().stacks.domain[EAST] as Stack);

  it("suppresses bounces and complaints, and is the identity's default", () => {
    const t = domain();
    t.hasResourceProperties("AWS::SES::ConfigurationSet", {
      Name: "supply-checkout-prod-transactional",
      SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
      ReputationOptions: { ReputationMetricsEnabled: true },
      SendingOptions: { SendingEnabled: true },
    });
    t.hasResourceProperties("AWS::SES::EmailIdentity", {
      EmailIdentity: "supplycheckout.com",
      ConfigurationSetAttributes: { ConfigurationSetName: Match.anyValue() },
    });
  });

  it("publishes bounces and complaints to an encrypted topic only SES, for this configuration set, may publish to", () => {
    const t = domain();
    const [[topicId]] = resources(t, "AWS::SNS::Topic") as [[string, Resource]];
    t.hasResourceProperties("AWS::SES::ConfigurationSetEventDestination", {
      EventDestination: { Enabled: true, MatchingEventTypes: ["bounce", "complaint"], SnsDestination: { TopicARN: { Ref: topicId } } },
    });
    t.hasResourceProperties("AWS::SNS::Topic", { TopicName: "supply-checkout-prod-email-events", KmsMasterKeyId: Match.anyValue() });
    const policy = JSON.stringify(t.findResources("AWS::SNS::TopicPolicy"));
    expect(policy).toContain("ses.amazonaws.com");
    expect(policy).toContain("AWS:SourceArn");
    expect(policy).toContain("aws:SecureTransport");
    t.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
      KeyPolicy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "SesPublishesEvents",
            Principal: { Service: "ses.amazonaws.com" },
            Action: ["kms:GenerateDataKey*", "kms:Decrypt"],
            Condition: { StringEquals: { "aws:SourceAccount": Match.anyValue(), "aws:SourceArn": Match.anyValue() } },
          }),
        ]),
      }),
    });
  });

  it("stays out of the other regions' domain stacks", () => {
    const t = Template.fromStack(build().stacks.domain[WEST] as Stack);
    t.resourceCountIs("AWS::SES::ConfigurationSet", 0);
    t.resourceCountIs("AWS::SNS::Topic", 0);
  });
});

describe("email stack", () => {
  const email = () => Template.fromStack(build().stacks.email);

  it("subscribes the events function to the topic, with a dead-letter queue for SNS and Lambda", () => {
    const t = email();
    const [[fnId]] = resources(t, "AWS::Lambda::Function").filter(([, r]) => (r.Properties.Handler as string) === "index.handler") as [[string, Resource]];
    const [[dlqId]] = resources(t, "AWS::SQS::Queue") as [[string, Resource]];
    t.hasResourceProperties("AWS::SQS::Queue", { QueueName: "supply-checkout-prod-email-events-dlq" });
    t.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "lambda",
      Endpoint: { "Fn::GetAtt": [fnId, "Arn"] },
      TopicArn: { "Fn::Join": ["", Match.arrayWith([Match.stringLikeRegexp(":supply-checkout-prod-email-events$")])] },
      RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": [dlqId, "Arn"] } },
    });
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      DeadLetterConfig: { TargetArn: { "Fn::GetAtt": [dlqId, "Arn"] } },
      Environment: { Variables: Match.objectLike({ TABLE_NAME: "supply-checkout-prod-app" }) },
    });
    t.hasResourceProperties("AWS::Lambda::EventInvokeConfig", { MaximumRetryAttempts: 2 });
  });

  it("lets the function read only a team's home region and write only an invite's failure fields, and nothing in SES", () => {
    const all = statements(email());
    const dynamo = all.filter((s) => JSON.stringify(s.Action).includes("dynamodb:"));
    expect(dynamo).toEqual([
      expect.objectContaining({
        Sid: "ReadTeamHomeRegion",
        Action: "dynamodb:GetItem",
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "homeRegion"] },
          StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
        },
      }),
      expect.objectContaining({
        Sid: "MarkInvitesFailed",
        Action: "dynamodb:UpdateItem",
        Condition: {
          "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["TEAM#*"] },
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "status", "failureReason", "failedAt", "type", "GSI2PK"] },
          StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
        },
      }),
    ]);
    for (const s of dynamo) expect(JSON.stringify(s.Resource)).not.toContain("*");
    expect(JSON.stringify(all)).not.toMatch(/"ses:|"sesv2:/);
    const kms = all.find((s) => s.Sid === "TableKeyThroughDynamoDb");
    expect(kms?.Condition).toMatchObject({ StringEquals: { "kms:ViaService": expect.anything() } });
  });

  it("encrypts the dead-letter queue, which holds addresses, with its own rotating key that SNS may use only for the events topic", () => {
    const t = email();
    const [[keyId]] = resources(t, "AWS::KMS::Key") as [[string, Resource]];
    t.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "supply-checkout-prod-email-events-dlq",
      KmsMasterKeyId: { "Fn::GetAtt": [keyId, "Arn"] },
      MessageRetentionPeriod: 7 * 24 * 60 * 60,
    });
    t.hasResourceProperties("AWS::KMS::Key", {
      EnableKeyRotation: true,
      KeyPolicy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: "SnsRedrivesFailedDeliveries",
            Principal: { Service: "sns.amazonaws.com" },
            Condition: { ArnEquals: { "aws:SourceArn": { "Fn::Join": ["", Match.arrayWith([Match.stringLikeRegexp(":supply-checkout-prod-email-events$")])] } } },
          }),
        ]),
      }),
    });
    // Lambda sends failed events with the function's role, so the role may use the key
    const all = statements(t);
    expect(all.some((s) => JSON.stringify(s.Action).includes("kms:GenerateDataKey") && JSON.stringify(s.Resource).includes(keyId))).toBe(true);
  });

  it("is only for the primary region", () => {
    const app = new App();
    expect(() => new EmailStack(app, config, WEST)).toThrow("primary region only");
  });
});

describe("grantSendEmail", () => {
  function sender() {
    const stack = new Stack(new App(), "Test", { env: { region: WEST } });
    const fn = new LambdaFunction(stack, "Sender", { runtime: Runtime.NODEJS_24_X, handler: "index.handler", code: Code.fromInline("export const handler = () => {}") });
    grantSendEmail(fn, config);
    return Template.fromStack(stack);
  }

  it("allows ses:SendEmail only on the identity and the configuration set, only from noreply", () => {
    const [statement, ...rest] = statements(sender());
    expect(rest).toEqual([]);
    expect(statement).toMatchObject({
      Sid: "SendAppEmail",
      Action: "ses:SendEmail",
      Effect: "Allow",
      Condition: { StringEquals: { "ses:FromAddress": "noreply@supplycheckout.com" } },
    });
    const arns = JSON.stringify(statement?.Resource);
    // SES is in the primary region even when the sender isn't
    expect(arns).toContain(`:ses:${EAST}:`);
    expect(arns).toContain(":identity/supplycheckout.com");
    expect(arns).toContain(":configuration-set/supply-checkout-prod-transactional");
    expect(arns).not.toContain("*");
  });

  it("tells the function where and how to send", () => {
    sender().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: {
          [EMAIL_ENV.fromAddress]: "noreply@supplycheckout.com",
          [EMAIL_ENV.configurationSet]: "supply-checkout-prod-transactional",
          [EMAIL_ENV.region]: EAST,
          [EMAIL_ENV.appUrl]: "https://app.supplycheckout.com",
        },
      },
    });
  });

  it("isn't given to any function yet: invites and billing add it when they send", () => {
    const { app, stacks } = build();
    void app;
    for (const stack of stacks.all) expect(JSON.stringify(Template.fromStack(stack).findResources("AWS::IAM::Policy"))).not.toContain("ses:SendEmail");
  });
});
