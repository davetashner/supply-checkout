import { testApp } from "./cdk-app.js";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { describe, expect, it } from "vitest";
import { APPROVED_REGIONS, DEFAULT_GITHUB_REPOSITORY, type DeploymentConfig, GITHUB_DEPLOY_ENVIRONMENTS, GITHUB_JOURNEYS_ENVIRONMENT, type GithubRepository } from "../lib/config.js";
import { journeyMailDomain, journeyMailBucketName, journeyResultsBucketName, journeyReceiptRuleSetName, journeysRoleName } from "../lib/journeys.js";
import { JourneysStack, journeysOutputParameters } from "../lib/stacks/journeys-stack.js";
import { addJourneys, addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST], primaryRegion: EAST };
const REPO: GithubRepository = { name: "example-owner/example-repo", ownerId: 1234, repositoryId: 567890 };
const SUBJECT = "repo:example-owner@1234/example-repo@567890:environment:production-journeys";

function build(overrides: Partial<DeploymentConfig> = {}, repository = REPO) {
  const app = testApp();
  const stack = addJourneys(app, { ...config, ...overrides }, repository);
  return { app, stack, template: Template.fromStack(stack) };
}

type Statement = { Sid?: string; Effect: string; Action: string | string[]; Resource?: unknown; Condition?: unknown; Principal?: unknown };
const actions = (s: Statement) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

const ref = (prefix: string) => Match.stringLikeRegexp(`^${prefix}[0-9A-F]{8}$`);
const objects = (bucketLogicalId: string, pattern: string) => ({ "Fn::Join": ["", [{ "Fn::GetAtt": [bucketLogicalId, "Arn"] }, `/${pattern}`]] });

function logicalId(template: Template, type: string, prefix: string): string {
  const ids = Object.keys(template.findResources(type)).filter((id) => id.startsWith(prefix));
  expect(ids, `${type} ${prefix}`).toHaveLength(1);
  return ids[0] as string;
}

function bucketPolicyStatements(template: Template, bucketLogicalId: string): Statement[] {
  const policies = Object.values(template.findResources("AWS::S3::BucketPolicy")).filter((p) => p.Properties.Bucket.Ref === bucketLogicalId);
  expect(policies).toHaveLength(1);
  return policies[0]?.Properties.PolicyDocument.Statement as Statement[];
}

describe("journeys stack (supply-checkout-o60.3)", () => {
  it("is prod only, in the primary region, stateful, and a separate app from the main one", () => {
    const { stack } = build();
    expect(stack.stackName).toBe(`supply-checkout-prod-${EAST}-journeys`);
    expect(stack.region).toBe(EAST);
    expect(stack.terminationProtection).toBe(true);
    expect(() => build({ envName: "staging" })).toThrow(/prod only/);
    // The main app never has it, so the pipeline never deploys it
    const main = addSupplyCheckout(testApp(), { ...config, regions: [EAST, WEST] });
    expect(main.all.map((s) => s.component)).not.toContain("journeys");
  });

  it("refuses a region other than the primary", () => {
    expect(() => new JourneysStack(testApp(), { ...config, regions: [EAST, WEST] }, WEST, REPO)).toThrow(/primary region only/);
  });

  describe("the journeys role", () => {
    it("is trusted only by a job in the production-journeys environment of this repository, by GitHub's immutable subject and the STS audience, for an hour", () => {
      const { template } = build();
      template.resourceCountIs("AWS::IAM::Role", 1);
      const [role] = Object.values(template.findResources("AWS::IAM::Role"));
      expect(role?.Properties.RoleName).toBe("supply-checkout-prod-journeys");
      expect(role?.Properties.MaxSessionDuration).toBe(3600);
      expect(role?.Properties.ManagedPolicyArns).toBeUndefined();
      expect(role?.Properties.PermissionsBoundary).toBeUndefined();
      expect(role?.Properties.AssumeRolePolicyDocument).toEqual({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: "sts:AssumeRoleWithWebIdentity",
            Principal: {
              Federated: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":iam::", { Ref: "AWS::AccountId" }, ":oidc-provider/token.actions.githubusercontent.com"]] },
            },
            Condition: {
              StringEquals: {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": SUBJECT,
              },
            },
          },
        ],
      });
    });

    it("trusts this repository by default, and an environment the deploy role doesn't", () => {
      const { template } = build({}, DEFAULT_GITHUB_REPOSITORY);
      const [role] = Object.values(template.findResources("AWS::IAM::Role"));
      expect(role?.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]).toBe(
        "repo:davetashner@5702882/supply-checkout@1388338851:environment:production-journeys",
      );
      expect(GITHUB_JOURNEYS_ENVIRONMENT).toBe("production-journeys");
      expect(GITHUB_DEPLOY_ENVIRONMENTS).not.toContain(GITHUB_JOURNEYS_ENVIRONMENT as never);
    });

    it("may only list the mail bucket under inbox/ and runs/, read and delete inbox/, read and write runs/, and write runs/ in the results bucket", () => {
      const { template } = build();
      const mail = logicalId(template, "AWS::S3::Bucket", "MailBucket");
      const results = logicalId(template, "AWS::S3::Bucket", "ResultsBucket");
      // One inline policy, nothing else attached to anything in the stack
      template.resourceCountIs("AWS::IAM::Policy", 1);
      template.resourceCountIs("AWS::IAM::ManagedPolicy", 0);
      const [policy] = Object.values(template.findResources("AWS::IAM::Policy"));
      expect(policy?.Properties.Roles).toEqual([{ Ref: logicalId(template, "AWS::IAM::Role", "JourneysRole") }]);
      expect(policy?.Properties.PolicyDocument.Statement).toEqual([
        {
          Sid: "ListTestMailAndRunRecords",
          Effect: "Allow",
          Action: "s3:ListBucket",
          Resource: { "Fn::GetAtt": [mail, "Arn"] },
          Condition: { StringLike: { "s3:prefix": ["inbox/*", "runs/*"] } },
        },
        { Sid: "ReadAndDeleteTestMail", Effect: "Allow", Action: ["s3:DeleteObject", "s3:GetObject"], Resource: objects(mail, "inbox/*") },
        { Sid: "ReadAndWriteRunRecords", Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject"], Resource: objects(mail, "runs/*") },
        { Sid: "UploadTraces", Effect: "Allow", Action: "s3:PutObject", Resource: objects(results, "runs/*") },
      ]);
      for (const statement of policy?.Properties.PolicyDocument.Statement as Statement[]) {
        for (const action of actions(statement)) {
          expect(action).toMatch(/^s3:[A-Za-z]+$/);
        }
      }
    });
  });

  describe("buckets", () => {
    const { template } = build();
    const mail = logicalId(template, "AWS::S3::Bucket", "MailBucket");
    const results = logicalId(template, "AWS::S3::Bucket", "ResultsBucket");
    const name = (bucketName: string) => ({ "Fn::Join": ["", [bucketName, { Ref: "AWS::AccountId" }]] });

    it.each([
      ["mail", mail, name(`supply-checkout-prod-journey-mail-${EAST}-`), "s3/journey-mail/"],
      ["results", results, name(`supply-checkout-prod-journey-results-${EAST}-`), "s3/journey-results/"],
    ])("the %s bucket is private, SSE-S3, unversioned, access-logged and retained", (_, id, bucketName, logPrefix) => {
      const bucket = template.toJSON().Resources[id];
      expect(bucket.DeletionPolicy).toBe("Retain");
      expect(bucket.Properties).toMatchObject({
        BucketName: bucketName,
        BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        LoggingConfiguration: { DestinationBucketName: name(`supply-checkout-prod-logs-${EAST}-`), LogFilePrefix: logPrefix },
      });
      // A deleted sign-in code is gone, not kept as an old version
      expect(bucket.Properties.VersioningConfiguration).toBeUndefined();
      // TLS only
      expect(bucketPolicyStatements(template, id)).toContainEqual({
        Effect: "Deny",
        Principal: { AWS: "*" },
        Action: "s3:*",
        Condition: { Bool: { "aws:SecureTransport": "false" } },
        Resource: [{ "Fn::GetAtt": [id, "Arn"] }, { "Fn::Join": ["", [{ "Fn::GetAtt": [id, "Arn"] }, "/*"]] }],
      });
    });

    it("keeps mail a day and run records and traces 30 days", () => {
      const resources = template.toJSON().Resources;
      expect(resources[mail].Properties.LifecycleConfiguration.Rules).toEqual([
        { Id: "Inbox", Prefix: "inbox/", ExpirationInDays: 1, Status: "Enabled" },
        { Id: "Everything", ExpirationInDays: 30, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: "Enabled" },
      ]);
      expect(resources[results].Properties.LifecycleConfiguration.Rules).toEqual([
        { Id: "Everything", ExpirationInDays: 30, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }, Status: "Enabled" },
      ]);
    });

    it("lets only SES write the mail bucket, under inbox/, for this account's receipt rule; the results bucket grants nothing", () => {
      const allows = (id: string) => bucketPolicyStatements(template, id).filter((s) => s.Effect === "Allow");
      expect(allows(mail)).toEqual([
        {
          Sid: "SesWritesTestMail",
          Effect: "Allow",
          Principal: { Service: "ses.amazonaws.com" },
          Action: "s3:PutObject",
          Resource: objects(mail, "inbox/*"),
          Condition: {
            StringEquals: {
              "aws:SourceAccount": { Ref: "AWS::AccountId" },
              "aws:SourceArn": {
                "Fn::Join": [
                  "",
                  ["arn:", { Ref: "AWS::Partition" }, ":ses:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":receipt-rule-set/supply-checkout-prod-journeys:receipt-rule/test-mail"],
                ],
              },
            },
          },
        },
      ]);
      expect(allows(results)).toEqual([]);
    });
  });

  describe("the test mail subdomain", () => {
    it("receives mail for exactly the domain the account and welcome functions treat as test accounts' (supply-checkout-o60.2)", () => {
      const { template } = build();
      const rules = Object.values(template.findResources("AWS::SES::ReceiptRule")) as { Properties: { Rule: { Recipients: string[] } } }[];
      const recipients = rules.flatMap((r) => r.Properties.Rule.Recipients);
      expect(recipients).toEqual([journeyMailDomain(config)]);
      const main = addSupplyCheckout(testApp(), config);
      const testMailDomains = [Template.fromStack((main.regions[EAST] as (typeof main.regions)[string]).api), Template.fromStack(main.email)].flatMap((t) =>
        Object.values(t.findResources("AWS::Lambda::Function"))
          .map((fn) => (fn as { Properties: { Environment?: { Variables?: Record<string, unknown> } } }).Properties.Environment?.Variables?.TEST_MAIL_DOMAIN)
          .filter((v) => v !== undefined),
      );
      // The account function and the welcome function, both the receipt rule's recipient
      expect(testMailDomains).toEqual([recipients[0], recipients[0]]);
    });

    it("routes e2e.<domain>'s mail to SES inbound in the primary region, and verifies it with Easy DKIM", () => {
      const { template } = build();
      expect(journeyMailDomain(config)).toBe("e2e.supplycheckout.com");
      template.hasResourceProperties("AWS::Route53::RecordSet", {
        Name: "e2e.supplycheckout.com.",
        Type: "MX",
        ResourceRecords: [`10 inbound-smtp.${EAST}.amazonaws.com`],
      });
      template.resourceCountIs("AWS::SES::EmailIdentity", 1);
      template.hasResourceProperties("AWS::SES::EmailIdentity", { EmailIdentity: "e2e.supplycheckout.com" });
      const cnames = Object.values(template.findResources("AWS::Route53::RecordSet")).filter((r) => r.Properties.Type === "CNAME");
      expect(cnames).toHaveLength(3);
      // Nothing at the apex: the domain stack owns its MX, SPF and DMARC
      for (const record of Object.values(template.findResources("AWS::Route53::RecordSet"))) {
        expect(record.Properties.Name).not.toBe("supplycheckout.com.");
      }
    });

    it("has one receipt rule set with one rule: the subdomain exactly, TLS required, scanned, written under inbox/ after the bucket policy", () => {
      const { template } = build();
      const mail = logicalId(template, "AWS::S3::Bucket", "MailBucket");
      template.resourceCountIs("AWS::SES::ReceiptRuleSet", 1);
      template.hasResourceProperties("AWS::SES::ReceiptRuleSet", { RuleSetName: "supply-checkout-prod-journeys" });
      template.resourceCountIs("AWS::SES::ReceiptRule", 1);
      template.hasResource("AWS::SES::ReceiptRule", {
        Properties: {
          RuleSetName: { Ref: ref("TestMailRuleSet") },
          Rule: {
            Name: "test-mail",
            Enabled: true,
            Recipients: ["e2e.supplycheckout.com"],
            ScanEnabled: true,
            TlsPolicy: "Require",
            Actions: [{ S3Action: { BucketName: { Ref: mail }, ObjectKeyPrefix: "inbox/" } }],
          },
        },
        DependsOn: [logicalId(template, "AWS::S3::BucketPolicy", "MailBucketPolicy")],
      });
    });
  });

  it("has no KMS key, function, table, secret or SNS topic", () => {
    const { template } = build();
    for (const type of ["AWS::KMS::Key", "AWS::Lambda::Function", "AWS::DynamoDB::Table", "AWS::DynamoDB::GlobalTable", "AWS::SecretsManager::Secret", "AWS::SNS::Topic", "Custom::AWS"]) {
      template.resourceCountIs(type, 0);
    }
  });

  it("publishes the names and the role ARN to SSM and as outputs", () => {
    const { template } = build();
    const params = journeysOutputParameters("prod");
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: params.mailDomain, Value: "e2e.supplycheckout.com" });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: params.mailBucketName, Value: { Ref: ref("MailBucket") } });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: params.resultsBucketName, Value: { Ref: ref("ResultsBucket") } });
    template.hasResourceProperties("AWS::SSM::Parameter", { Name: params.roleArn, Value: { "Fn::GetAtt": [ref("JourneysRole"), "Arn"] } });
    for (const output of ["JourneysRoleArn", "MailBucketName", "ResultsBucketName", "ReceiptRuleSetName"]) template.hasOutput(output, {});
    expect(journeysRoleName("prod")).toBe("supply-checkout-prod-journeys");
    expect(journeyReceiptRuleSetName("prod")).toBe("supply-checkout-prod-journeys");
    expect(journeyMailBucketName("prod", EAST, "0")).toBe(`supply-checkout-prod-journey-mail-${EAST}-0`);
    expect(journeyResultsBucketName("prod", EAST, "0")).toBe(`supply-checkout-prod-journey-results-${EAST}-0`);
  });

  it("is cdk-nag clean (the three object-prefix wildcards are acknowledged in the stack)", () => {
    const { app } = build();
    const report = new AwsSolutionsChecks(app).validateScope(app);
    expect(report.violations).toEqual([]);
    expect(() => app.synth()).not.toThrow();
  });
});

describe("the data stack's logs bucket (supply-checkout-o60.3)", () => {
  const logsStatements = (envName: string) => {
    const stacks = addSupplyCheckout(testApp(), { ...config, envName });
    const template = Template.fromStack(stacks.regions[EAST]?.data as never);
    const policies = Object.values(template.findResources("AWS::S3::BucketPolicy")).filter((p) => String(p.Properties.Bucket.Ref).startsWith("LogsBucket"));
    return policies.flatMap((p) => p.Properties.PolicyDocument.Statement as Statement[]);
  };

  it("takes the journey buckets' access logs in prod, each from its own bucket under its own prefix", () => {
    const statements = logsStatements("prod");
    for (const [sid, kind] of [
      ["JourneyMailBucketAccessLogs", "mail"],
      ["JourneyResultsBucketAccessLogs", "results"],
    ] as const) {
      expect(statements.find((s) => s.Sid === sid)).toEqual({
        Sid: sid,
        Effect: "Allow",
        Principal: { Service: "logging.s3.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": [expect.stringMatching(/^LogsBucket/), "Arn"] }, `/s3/journey-${kind}/*`]] },
        Condition: {
          StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
          ArnLike: { "aws:SourceArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:s3:::supply-checkout-prod-journey-${kind}-${EAST}-`, { Ref: "AWS::AccountId" }]] } },
        },
      });
    }
  });

  it("doesn't in another environment, which has no journeys stack", () => {
    expect(logsStatements("staging").filter((s) => s.Sid?.startsWith("Journey"))).toEqual([]);
  });
});
