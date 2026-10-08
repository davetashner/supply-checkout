import { Stack } from "aws-cdk-lib";
import { testApp } from "./cdk-app.js";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { EMAIL_ENV } from "../../backend/src/email/names.js";
import { APPROVED_REGIONS, type DeploymentConfig } from "../lib/config.js";
import { emailSettings, grantSendEmail } from "../lib/email.js";
import { SECURITY_NOTICE_EVENTS } from "../../backend/src/identity/names.js";
import { EmailStack } from "../lib/stacks/email-stack.js";
import { EVENT_PATTERN_LIMIT } from "../lib/stacks/observability-stack.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names come from lib/config.ts only (ADR 0010)
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function build(overrides: Partial<DeploymentConfig> = {}) {
  // Bundling is skipped in tests (it needs backend/node_modules); `npm run synth` bundles for real
  const app = testApp();
  return { app, stacks: addSupplyCheckout(app, { ...config, ...overrides }) };
}

type Resource = { Properties: Record<string, unknown> };
const resources = (t: Template, type: string) => Object.entries(t.findResources(type)) as [string, Resource][];
const statements = (t: Template, rolePrefix?: string) =>
  resources(t, "AWS::IAM::Policy")
    .filter(([, p]) => !rolePrefix || JSON.stringify(p.Properties.Roles).includes(`"${rolePrefix}`))
    .flatMap(([, p]) => (p.Properties.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement);

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
            Action: ["kms:Decrypt", "kms:GenerateDataKey*"],
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
    const all = statements(email(), "EventsFunctionRole");
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
          "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "inviteStatus", "failureReason", "failedAt", "GSI2PK"] },
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
    const app = testApp();
    expect(() => new EmailStack(app, config, WEST)).toThrow("primary region only");
  });

  // supply-checkout-8jc.28, 8jc.29
  describe("security notices", () => {
    const rule = (t: Template) => {
      const [[, r]] = resources(t, "AWS::Events::Rule").filter(([, x]) => x.Properties.Name === "supply-checkout-prod-security-notices") as [[string, Resource]];
      return r.Properties;
    };
    const noticesFn = (t: Template) =>
      resources(t, "AWS::Lambda::Function").find(([, r]) => String(r.Properties.Description).startsWith("Emails the account when its password")) as [string, Resource];

    it("sends the app pool's password, two-step and email calls, from any client, to the function", () => {
      const t = email();
      const props = rule(t);
      const pattern = props.EventPattern as { account: unknown[]; source: string[]; "detail-type": string[]; detail: Record<string, unknown> };
      // This account's events only
      expect(pattern.account).toEqual([{ Ref: "AWS::AccountId" }]);
      expect(pattern.source).toEqual(["aws.cognito-idp"]);
      expect(pattern["detail-type"]).toEqual(["AWS API Call via CloudTrail"]);
      expect(pattern.detail.eventSource).toEqual(["cognito-idp.amazonaws.com"]);
      expect(pattern.detail.eventName).toEqual(Object.keys(SECURITY_NOTICE_EVENTS));
      expect(pattern.detail.eventName).toEqual(["ChangePassword", "VerifySoftwareToken", "SetUserMFAPreference", "AdminSetUserMFAPreference", "UpdateUserAttributes", "VerifyUserAttribute"]);
      // The app pool, wherever CloudTrail puts its ID, or none named; never the operator pool's parameter
      const or = pattern.detail.$or as Record<string, { userPoolId: unknown[] }>[];
      expect(or).toHaveLength(3);
      expect(JSON.stringify(or)).toMatch(/SsmParameterValuesupplycheckoutprodidentityuserpoolid/);
      expect(JSON.stringify(props)).not.toMatch(/opsuserpool/i);
      expect(or[2]).toEqual({ requestParameters: { userPoolId: [{ exists: false }] }, additionalEventData: { userPoolId: [{ exists: false }] } });
      // No caller filter: a direct call with the user's own token is the point
      expect(JSON.stringify(pattern)).not.toContain("userIdentity");
      expect(JSON.stringify(pattern).length).toBeLessThan(EVENT_PATTERN_LIMIT * 0.5);
      const [fnId] = noticesFn(t);
      const [[dlqId]] = resources(t, "AWS::SQS::Queue").filter(([, q]) => q.Properties.QueueName === "supply-checkout-prod-security-notices-dlq") as [[string, Resource]];
      expect(props.Targets).toEqual([
        expect.objectContaining({
          Arn: { "Fn::GetAtt": [fnId, "Arn"] },
          RetryPolicy: { MaximumRetryAttempts: 4, MaximumEventAgeInSeconds: 6 * 3600 },
          DeadLetterConfig: { Arn: { "Fn::GetAtt": [dlqId, "Arn"] } },
        }),
      ]);
      t.hasResourceProperties("AWS::Lambda::Permission", { Action: "lambda:InvokeFunction", Principal: "events.amazonaws.com", FunctionName: { "Fn::GetAtt": [fnId, "Arn"] } });
    });

    it("runs the function on Node.js 24 with the app pool, the table and the mailer's settings, retrying twice", () => {
      const t = email();
      const [, fn] = noticesFn(t);
      expect(fn.Properties).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"], Timeout: 30 });
      const vars = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(vars).toMatchObject({ TABLE_NAME: "supply-checkout-prod-app", [EMAIL_ENV.fromAddress]: "noreply@supplycheckout.com", [EMAIL_ENV.appUrl]: "https://app.supplycheckout.com" });
      expect(JSON.stringify(vars.USER_POOL_ID)).toMatch(/SsmParameterValuesupplycheckoutprodidentityuserpoolid/);
      t.hasResourceProperties("AWS::Lambda::EventInvokeConfig", { FunctionName: { Ref: Match.anyValue() }, MaximumRetryAttempts: 2 });
      // What Lambda and EventBridge gave up on waits to be replayed, encrypted
      const [[dlqId, dlq]] = resources(t, "AWS::SQS::Queue").filter(([, q]) => q.Properties.QueueName === "supply-checkout-prod-security-notices-dlq") as [[string, Resource]];
      expect(dlq.Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 86400 });
      expect(fn.Properties.DeadLetterConfig).toEqual({ TargetArn: { "Fn::GetAtt": [dlqId, "Arn"] } });
      t.hasResourceProperties("AWS::SQS::QueuePolicy", {
        Queues: [{ Ref: dlqId }],
        PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({ Action: "sqs:SendMessage", Principal: { Service: "events.amazonaws.com" } })]) }),
      });
    });

    it("lets the function look users up in the app pool, send only the app's email, and touch only the notices' attributes", () => {
      const all = statements(email(), "SecurityNoticesRole");
      const byAction = (prefix: string) => all.filter((s) => JSON.stringify(s.Action).includes(prefix));
      expect(byAction("cognito-idp:")).toEqual([
        expect.objectContaining({ Sid: "FindAppUsers", Action: ["cognito-idp:AdminGetUser", "cognito-idp:ListUsers"], Resource: expect.objectContaining({ Ref: expect.stringMatching(/userpoolarn/i) }) }),
      ]);
      expect(byAction("dynamodb:")).toEqual([
        expect.objectContaining({
          Sid: "ReadNoticeRecords",
          Action: "dynamodb:GetItem",
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "noticeSentAt", "noticeFor", "noticeAddress", "noticeAddressAt", "noticeSeenHash", "totpOnAt"] },
            StringEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          },
        }),
        expect.objectContaining({
          Sid: "WriteNoticeRecords",
          Action: ["dynamodb:ConditionCheckItem", "dynamodb:UpdateItem"],
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "noticeSentAt", "noticeFor", "noticeAddress", "noticeAddressAt", "noticeSeenHash", "totpOnAt"] },
            StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
          },
        }),
      ]);
      // No TTL attribute: it can't make DynamoDB delete a user's rows
      expect(JSON.stringify(byAction("dynamodb:"))).not.toContain("expiresAt");
      expect(byAction("ses:")).toEqual([expect.objectContaining({ Sid: "SendAppEmail", Action: "ses:SendEmail", Condition: { StringEquals: { "ses:FromAddress": "noreply@supplycheckout.com" } } })]);
      // Only X-Ray's (every function traces, observability/defaults.ts) is on "*"
      for (const s of all) if (!JSON.stringify(s.Action).includes("xray:")) expect(JSON.stringify(s.Resource)).not.toBe('"*"');
      expect(all.find((s) => s.Sid === "TableKeyThroughDynamoDb")?.Condition).toMatchObject({ StringEquals: { "kms:ViaService": expect.anything() } });
      // Nothing else: no Put, Delete, Query or Scan, no other Cognito action
      expect(JSON.stringify(all)).not.toMatch(/dynamodb:(PutItem|DeleteItem|Query|Scan|BatchWriteItem)|cognito-idp:Admin(?!GetUser)|"cognito-idp:\*"/);
    });

    it("deploys after the identity stack, whose pool it names", () => {
      const { stacks } = build();
      expect(stacks.email.dependencies.map((d) => d.stackName)).toContain(stacks.identity.stackName);
    });
  });

  // supply-checkout-6uw.25
  describe("welcome email", () => {
    const welcomeFn = (t: Template) => resources(t, "AWS::Lambda::Function").find(([, r]) => r.Properties.FunctionName === "supply-checkout-prod-welcome-email") as [string, Resource];

    it("runs the function by its fixed name on Node.js 24, with the app pool, the table, the mailer's settings and the support address, retrying twice into its own queue", () => {
      const t = email();
      const [fnId, fn] = welcomeFn(t);
      expect(fn.Properties).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"], Timeout: 30 });
      const vars = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(vars).toMatchObject({
        TABLE_NAME: "supply-checkout-prod-app",
        SUPPORT_ADDRESS: "support@supplycheckout.com",
        // A test account's welcome is left out of WelcomeEmails (supply-checkout-o60.2)
        TEST_MAIL_DOMAIN: "e2e.supplycheckout.com",
        [EMAIL_ENV.fromAddress]: "noreply@supplycheckout.com",
        [EMAIL_ENV.appUrl]: "https://app.supplycheckout.com",
      });
      expect(JSON.stringify(vars.USER_POOL_ID)).toMatch(/SsmParameterValuesupplycheckoutprodidentityuserpoolid/);
      t.hasResourceProperties("AWS::Lambda::EventInvokeConfig", { FunctionName: { Ref: fnId }, MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 6 * 3600 });
      const [[dlqId, dlq]] = resources(t, "AWS::SQS::Queue").filter(([, q]) => q.Properties.QueueName === "supply-checkout-prod-welcome-email-dlq") as [[string, Resource]];
      expect(dlq.Properties).toMatchObject({ SqsManagedSseEnabled: true, MessageRetentionPeriod: 14 * 86400 });
      expect(fn.Properties.DeadLetterConfig).toEqual({ TargetArn: { "Fn::GetAtt": [dlqId, "Arn"] } });
      // Nobody is granted it through the function's own policy: the triggers' roles are (the identity stack)
      expect(resources(t, "AWS::Lambda::Permission").filter(([, p]) => JSON.stringify(p.Properties.FunctionName).includes(fnId))).toEqual([]);
    });

    it("lets the function look users up in the app pool, send only the app's email, claim only its record, and read only keys and an invite's type, address and expiry", () => {
      const all = statements(email(), "WelcomeRole");
      const byAction = (prefix: string) => all.filter((s) => JSON.stringify(s.Action).includes(prefix));
      expect(byAction("cognito-idp:")).toEqual([
        expect.objectContaining({ Sid: "FindAppUsers", Action: ["cognito-idp:AdminGetUser", "cognito-idp:ListUsers"], Resource: expect.objectContaining({ Ref: expect.stringMatching(/userpoolarn/i) }) }),
      ]);
      const table = { "Fn::Join": ["", [`arn:aws:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app"]] };
      expect(byAction("dynamodb:")).toEqual([
        {
          Sid: "ClaimWelcome",
          Effect: "Allow",
          Action: ["dynamodb:ConditionCheckItem", "dynamodb:UpdateItem"],
          Resource: table,
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "welcomeSentAt"] },
            StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
          },
        },
        {
          Sid: "ReadTeamKeys",
          Effect: "Allow",
          Action: "dynamodb:Query",
          Resource: table,
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["USER#*"] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK"] },
            StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          },
        },
        {
          Sid: "ReadWaitingInvites",
          Effect: "Allow",
          Action: "dynamodb:Query",
          Resource: { "Fn::Join": ["", [`arn:aws:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app/index/GSI2"]] },
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["INVITEE#*"] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "GSI2PK", "GSI2SK", "type", "email", "expiresAt"] },
            StringEquals: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" },
          },
        },
      ]);
      expect(byAction("ses:")).toEqual([expect.objectContaining({ Sid: "SendAppEmail", Action: "ses:SendEmail", Condition: { StringEquals: { "ses:FromAddress": "noreply@supplycheckout.com" } } })]);
      for (const s of all) if (!JSON.stringify(s.Action).includes("xray:")) expect(JSON.stringify(s.Resource)).not.toBe('"*"');
      expect(all.find((s) => s.Sid === "TableKeyThroughDynamoDb")?.Condition).toMatchObject({ StringEquals: { "kms:ViaService": expect.anything() } });
      // Nothing else: no Get, Put, Delete or Scan, no other Cognito action, no Lambda
      expect(JSON.stringify(all)).not.toMatch(/dynamodb:(GetItem|PutItem|DeleteItem|Scan|BatchWriteItem|BatchGetItem)|cognito-idp:Admin(?!GetUser)|"cognito-idp:\*"|lambda:/);
    });
  });

  // supply-checkout-6uw.26
  describe("password reset", () => {
    const resetFn = (t: Template) => resources(t, "AWS::Lambda::Function").find(([, r]) => r.Properties.FunctionName === "supply-checkout-prod-password-reset") as [string, Resource];

    it("runs the function by its fixed name, with the app pool, its web client and the support address, never retrying and with no dead-letter queue", () => {
      const t = email();
      const [fnId, fn] = resetFn(t);
      expect(fn.Properties).toMatchObject({ Runtime: "nodejs24.x", Architectures: ["arm64"], Timeout: 30 });
      const vars = (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(vars).toMatchObject({ TABLE_NAME: "supply-checkout-prod-app", SUPPORT_ADDRESS: "support@supplycheckout.com", [EMAIL_ENV.fromAddress]: "noreply@supplycheckout.com" });
      expect(JSON.stringify(vars.USER_POOL_ID)).toMatch(/SsmParameterValuesupplycheckoutprodidentityuserpoolid/);
      expect(JSON.stringify(vars.CLIENT_ID)).toMatch(/SsmParameterValuesupplycheckoutprodidentitywebclientid/);
      // A request holds an address: it's never kept in a queue
      t.hasResourceProperties("AWS::Lambda::EventInvokeConfig", { FunctionName: { Ref: fnId }, MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 900 });
      expect(fn.Properties.DeadLetterConfig).toBeUndefined();
      expect(resources(t, "AWS::Lambda::Permission").filter(([, p]) => JSON.stringify(p.Properties.FunctionName).includes(fnId))).toEqual([]);
    });

    it("lets the function look addresses up in the app pool, send only the app's email, and count only its limits", () => {
      const all = statements(email(), "PasswordResetRole");
      const byAction = (prefix: string) => all.filter((s) => JSON.stringify(s.Action).includes(prefix));
      expect(byAction("cognito-idp:")).toEqual([
        expect.objectContaining({ Sid: "FindAppUsers", Action: ["cognito-idp:AdminGetUser", "cognito-idp:ListUsers"], Resource: expect.objectContaining({ Ref: expect.stringMatching(/userpoolarn/i) }) }),
      ]);
      expect(byAction("dynamodb:")).toEqual([
        {
          Sid: "CountPasswordResets",
          Effect: "Allow",
          Action: "dynamodb:UpdateItem",
          Resource: { "Fn::Join": ["", [`arn:aws:dynamodb:${EAST}:`, { Ref: "AWS::AccountId" }, ":table/supply-checkout-prod-app"]] },
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["RESETLIMIT#*"] },
            "ForAllValues:StringEquals": { "dynamodb:Attributes": ["PK", "SK", "count", "expiresAt"] },
            StringEqualsIfExists: { "dynamodb:ReturnValues": "NONE" },
          },
        },
      ]);
      expect(byAction("ses:")).toEqual([expect.objectContaining({ Sid: "SendAppEmail", Action: "ses:SendEmail", Condition: { StringEquals: { "ses:FromAddress": "noreply@supplycheckout.com" } } })]);
      for (const s of all) if (!JSON.stringify(s.Action).includes("xray:")) expect(JSON.stringify(s.Resource)).not.toBe('"*"');
      expect(all.find((s) => s.Sid === "TableKeyThroughDynamoDb")?.Condition).toMatchObject({ StringEquals: { "kms:ViaService": expect.anything() } });
      expect(JSON.stringify(all)).not.toMatch(/dynamodb:(GetItem|PutItem|DeleteItem|Query|Scan|BatchWriteItem|BatchGetItem|ConditionCheckItem)|cognito-idp:Admin(?!GetUser)|"cognito-idp:\*"|lambda:/);
    });
  });
});

describe("grantSendEmail", () => {
  function sender() {
    const stack = new Stack(testApp(), "Test", { env: { region: WEST } });
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
    // No wildcard resource (no recipient identities: SES is out of the sandbox, supply-checkout-3sv.21) and no wildcard action
    expect(arns).not.toContain("*");
    expect(JSON.stringify(statement?.Action)).not.toContain("*");
  });

  // A real deploy knows the account, so cdk-nag prints it in any ARN it finds a wildcard in, where the
  // tests above (no account) get <AWS::AccountId>: any acknowledgement must match both
  // (the first deploy with the SES sandbox grant, supply-checkout-3sv.20, failed on exactly this)
  it("passes cdk-nag in a deploy that knows the account, for every role that sends", () => {
    const { stacks } = build({ account: "123456789012" });
    // Every stack is synthesized and validated with the account (the api, email and observability stacks send)
    expect(() => Template.fromStack(stacks.all[0] as Stack)).not.toThrow();
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

  it("is given only to the account function, which sends invites, the billing worker, which emails owners about billing, the security notices, welcome email and password reset functions, and the lapsed-team job", () => {
    const { app, stacks } = build();
    void app;
    for (const stack of stacks.all) {
      const policies = Template.fromStack(stack).findResources("AWS::IAM::Policy");
      const senders = Object.entries(policies)
        .filter(([, p]) => JSON.stringify(p).includes("ses:SendEmail"))
        .map(([id]) => id);
      // In every region's api stack, the account function's role; nowhere else
      const expected = stack.stackName.endsWith("-api")
        ? [expect.stringMatching(/^AccountFunctionRole/), expect.stringMatching(/^BillingWorkerFunctionRole/)]
        : stack.stackName.endsWith("-email")
          ? [expect.stringMatching(/^SecurityNoticesRole/), expect.stringMatching(/^WelcomeRole/), expect.stringMatching(/^PasswordResetRole/)]
          : stack.stackName === `supply-checkout-prod-${EAST}-observability`
            ? [expect.stringMatching(/^OpsChecksTeamLapseRole/)]
            : [];
      expect(senders, stack.stackName).toEqual(expected);
      // No other SES send anywhere: no templated or bulk sends, and raw sends
      // only for the support SMTP user (supply-checkout-6qd), as support@
      expect(JSON.stringify(policies)).not.toMatch(/ses:Send(Templated|Bulk)/);
      const rawSenders = Object.entries(policies)
        .filter(([, p]) => JSON.stringify(p).includes("ses:SendRawEmail"))
        .map(([id]) => id);
      expect(rawSenders, stack.stackName).toEqual(stack.stackName === `supply-checkout-prod-${EAST}-domain` ? [expect.stringMatching(/^SupportSmtpUserDefaultPolicy/)] : []);
    }
  });
});
