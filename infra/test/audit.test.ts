import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { APPROVED_REGIONS, type DeploymentConfig } from "../lib/config.js";
import { AuditStack, TRAIL_LOG_RETENTION_DAYS, auditOutputParameters, trailName } from "../lib/stacks/audit-stack.js";
import { addSupplyCheckout } from "../lib/supply-checkout.js";

// Region names live only in lib/config.ts (ADR 0010); tests use its constants.
const [EAST, WEST] = APPROVED_REGIONS;
const config: DeploymentConfig = { envName: "prod", domainName: "supplycheckout.com", regions: [EAST, WEST], primaryRegion: EAST };

function build(overrides: Partial<DeploymentConfig> = {}) {
  const app = new App({ context: { "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [] } });
  return addSupplyCheckout(app, { ...config, ...overrides });
}

const audit = () => Template.fromStack(build().audit);

/** The trail's ARN as the template builds it, for the SourceArn conditions. */
const TRAIL_ARN = {
  "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":cloudtrail:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":trail/supply-checkout-prod-trail"]],
};
const FROM_THIS_TRAIL = { "aws:SourceArn": TRAIL_ARN, "aws:SourceAccount": { Ref: "AWS::AccountId" } };

describe("CloudTrail trail (supply-checkout-3sv.3)", () => {
  it("is one multi-region trail with a fixed name, every management event, global services and log file validation, retained", () => {
    const t = audit();
    t.resourceCountIs("AWS::CloudTrail::Trail", 1);
    t.hasResource("AWS::CloudTrail::Trail", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        TrailName: "supply-checkout-prod-trail",
        IsLogging: true,
        IsMultiRegionTrail: true,
        IncludeGlobalServiceEvents: true,
        EnableLogFileValidation: true,
        // Read and write; no data events, no advanced selectors that could narrow it
        EventSelectors: [{ ReadWriteType: "All", IncludeManagementEvents: true, DataResources: Match.absent() }],
        AdvancedEventSelectors: Match.absent(),
        // Encrypted with the stack's own key, into its own bucket
        KMSKeyId: { "Fn::GetAtt": [Match.stringLikeRegexp("^TrailKey"), "Arn"] },
        S3BucketName: { Ref: Match.stringLikeRegexp("^TrailBucket") },
        // No CloudWatch Logs delivery
        CloudWatchLogsLogGroupArn: Match.absent(),
      },
      // CloudTrail checks the bucket policy and the key when it creates the trail
      DependsOn: Match.arrayWith([Match.stringLikeRegexp("^TrailBucketPolicy"), Match.stringLikeRegexp("^TrailKey")]),
    });
    expect(trailName("staging")).toBe("supply-checkout-staging-trail");
  });

  it("writes to a bucket with SSE-KMS, public access blocked, ACLs off, versioning, access logs and the retention, retained", () => {
    audit().hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        BucketName: { "Fn::Join": ["", [`supply-checkout-prod-trail-${EAST}-`, { Ref: "AWS::AccountId" }]] },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { BucketKeyEnabled: false, ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms", KMSMasterKeyID: { "Fn::GetAtt": [Match.stringLikeRegexp("^TrailKey"), "Arn"] } } },
          ],
        },
        PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
        OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] },
        VersioningConfiguration: { Status: "Enabled" },
        LifecycleConfiguration: { Rules: [{ ExpirationInDays: TRAIL_LOG_RETENTION_DAYS, NoncurrentVersionExpiration: { NoncurrentDays: 30 }, Status: "Enabled" }] },
        // The data stack's logs bucket, by name
        LoggingConfiguration: { DestinationBucketName: { "Fn::Join": ["", [`supply-checkout-prod-logs-${EAST}-`, { Ref: "AWS::AccountId" }]] }, LogFilePrefix: "s3/trail/" },
      },
    });
    // Longer than a year, like the deletion records (no written policy says otherwise)
    expect(TRAIL_LOG_RETENTION_DAYS).toBe(400);
  });

  it("has its access logs let into the data stack's logs bucket, from the trail bucket only", () => {
    const data = Template.fromStack(build().regions[EAST]?.data as never);
    const [policy] = Object.values(data.findResources("AWS::S3::BucketPolicy", { Properties: { Bucket: { Ref: Match.stringLikeRegexp("^LogsBucket") } } }));
    expect(policy?.Properties.PolicyDocument.Statement).toContainEqual({
      Sid: "TrailBucketAccessLogs",
      Effect: "Allow",
      Principal: { Service: "logging.s3.amazonaws.com" },
      Action: "s3:PutObject",
      Resource: { "Fn::Join": ["", [{ "Fn::GetAtt": [expect.stringMatching(/^LogsBucket/), "Arn"] }, "/s3/trail/*"]] },
      Condition: {
        StringEquals: { "aws:SourceAccount": { Ref: "AWS::AccountId" } },
        ArnLike: { "aws:SourceArn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, `:s3:::supply-checkout-prod-trail-${EAST}-`, { Ref: "AWS::AccountId" }]] } },
      },
    });
  });

  it("lets only this trail, in this account, write to the bucket, and refuses requests without TLS", () => {
    const policies = Object.values(audit().findResources("AWS::S3::BucketPolicy"));
    expect(policies).toHaveLength(1);
    const statements = policies[0]?.Properties.PolicyDocument.Statement as Record<string, unknown>[];
    expect(statements).toHaveLength(3);
    expect(statements).toContainEqual(expect.objectContaining({ Effect: "Deny", Action: "s3:*", Condition: { Bool: { "aws:SecureTransport": "false" } } }));
    const bucketArn = { "Fn::GetAtt": [expect.stringMatching(/^TrailBucket/), "Arn"] };
    expect(statements).toContainEqual({
      Sid: "CloudTrailChecksTheBucketAcl",
      Effect: "Allow",
      Principal: { Service: "cloudtrail.amazonaws.com" },
      Action: "s3:GetBucketAcl",
      Resource: bucketArn,
      Condition: { StringEquals: FROM_THIS_TRAIL },
    });
    expect(statements).toContainEqual({
      Sid: "CloudTrailWritesThisAccountsLogs",
      Effect: "Allow",
      Principal: { Service: "cloudtrail.amazonaws.com" },
      Action: "s3:PutObject",
      // Only under this account's prefix
      Resource: { "Fn::Join": ["", [bucketArn, "/AWSLogs/", { Ref: "AWS::AccountId" }, "/*"]] },
      Condition: { StringEquals: { ...FROM_THIS_TRAIL, "s3:x-amz-acl": "bucket-owner-full-control" } },
    });
    // Nobody else is granted anything on the bucket
    for (const s of statements.filter((s) => s.Effect === "Allow")) expect(s.Principal).toEqual({ Service: "cloudtrail.amazonaws.com" });
  });

  it("encrypts with its own rotating key, which CloudTrail may use only for this trail", () => {
    const t = audit();
    t.resourceCountIs("AWS::KMS::Key", 1);
    const [key] = Object.values(t.findResources("AWS::KMS::Key"));
    expect(key?.DeletionPolicy).toBe("Retain");
    expect(key?.Properties.EnableKeyRotation).toBe(true);
    const statements = key?.Properties.KeyPolicy.Statement as Record<string, unknown>[];
    const forCloudTrail = statements.filter((s) => JSON.stringify(s.Principal).includes("cloudtrail"));
    expect(forCloudTrail).toEqual([
      {
        Sid: "CloudTrailEncryptsThisTrailsLogs",
        Effect: "Allow",
        Principal: { Service: "cloudtrail.amazonaws.com" },
        Action: "kms:GenerateDataKey*",
        Resource: "*",
        Condition: {
          StringEquals: FROM_THIS_TRAIL,
          StringLike: { "kms:EncryptionContext:aws:cloudtrail:arn": { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":cloudtrail:*:", { Ref: "AWS::AccountId" }, ":trail/*"]] } },
        },
      },
      {
        Sid: "CloudTrailDescribesTheKey",
        Effect: "Allow",
        Principal: { Service: "cloudtrail.amazonaws.com" },
        Action: "kms:DescribeKey",
        Resource: "*",
        Condition: { StringEquals: FROM_THIS_TRAIL },
      },
    ]);
    // Every other statement is the account's own (IAM decides who reads the logs); no other service
    for (const s of statements.filter((s) => !forCloudTrail.includes(s))) expect(JSON.stringify(s.Principal)).toMatch(/:root/);
  });

  it("publishes the trail's name, bucket and key ARN to SSM", () => {
    const t = audit();
    const params = auditOutputParameters("prod");
    for (const name of Object.values(params)) t.hasResourceProperties("AWS::SSM::Parameter", { Name: name, Type: "String" });
    expect(params.trailKeyArn).toBe("/supply-checkout/prod/audit/trail-key-arn");
  });

  it("is in the primary region only, termination-protected, and the primary observability stack reads its key ARN", () => {
    const stacks = build({ envName: "staging", regions: [WEST], primaryRegion: WEST });
    expect(stacks.audit.region).toBe(WEST);
    expect(stacks.audit.terminationProtection).toBe(true);
    expect(stacks.audit.layer).toBe("stateful");
    const observability = Template.fromStack(stacks.regions[WEST]?.observability as never).toJSON();
    const defaults = Object.values(observability.Parameters as Record<string, { Default?: string }>).map((p) => p.Default);
    expect(defaults).toContain("/supply-checkout/staging/audit/trail-key-arn");
    // Only the primary region's observability stack has the operator rules
    expect(Object.keys(Template.fromStack(build().regions[WEST]?.observability as never).toJSON().Parameters ?? {}).filter((k) => k.includes("audittrailkeyarn"))).toEqual([]);
    const app = new App();
    expect(() => new AuditStack(app, config, WEST)).toThrow(/primary region only/);
  });
});
