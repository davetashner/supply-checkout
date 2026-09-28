import { Annotations, Aws, Duration, RemovalPolicy } from "aws-cdk-lib";
import { CfnTrail } from "aws-cdk-lib/aws-cloudtrail";
import { Effect, PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";
import { logsBucketName } from "./data-stack.js";

/**
 * How long the trail's log files are kept. There's no information security
 * policy yet (supply-checkout-4p1; log groups and access logs keep a
 * placeholder year), so the trail keeps 400 days, like the deletion records
 * (DELETION_RECORD_RETENTION_DAYS): an investigation can always look back a
 * full year, as far as any backup reaches. Change it with that policy.
 */
export const TRAIL_LOG_RETENTION_DAYS = 400;

/** The trail's fixed name, so the key and bucket policies can name it before it exists. */
export const trailName = (envName: string) => `supply-checkout-${envName}-trail`;

/** The trail's bucket: the account ID makes the name globally unique; it's resolved at deploy time. */
export function trailBucketName(envName: string, region: string, account: string = Aws.ACCOUNT_ID): string {
  return `supply-checkout-${envName}-trail-${region}-${account}`;
}

/** SSM parameters the audit stack publishes, in its own region. */
export const auditOutputParameters = (envName: string) => {
  const prefix = `/supply-checkout/${envName}/audit`;
  return { trailName: `${prefix}/trail-name`, trailBucketName: `${prefix}/trail-bucket-name`, trailKeyArn: `${prefix}/trail-key-arn` };
};

/**
 * The account's CloudTrail trail, in the primary region (supply-checkout-3sv.3).
 *
 * Every EventBridge rule on "AWS API Call via CloudTrail" (the operator
 * alerts, the backup and deletion records change alerts) needs a trail
 * logging in the account: without one, EventBridge receives none of those
 * events and the rules never fire.
 *
 * - One multi-region trail, `supply-checkout-<env>-trail`, logging every
 *   management event (read and write), global services' (IAM, STS) included,
 *   with log file validation. No data events and no CloudWatch Logs delivery.
 *   The first copy of management events is free; the bucket and key cost
 *   cents a month.
 * - Its own bucket: SSE-KMS with its own rotating key, public access blocked,
 *   TLS only, versioned, ACLs off, server access logs to the data stack's
 *   logs bucket (whose policy grants them), log files expired after TRAIL_LOG_RETENTION_DAYS.
 * - Only this trail may write to the bucket or encrypt with the key
 *   (`aws:SourceArn` is the trail's ARN, and `aws:SourceAccount` this
 *   account). Reading the logs takes IAM permissions in this account; the key
 *   policy's account statement defers to IAM, as every key here does.
 * - Stateful, so it's in a stack of its own with termination protection and
 *   RETAIN, not in the observability stack, which is stateless and may be
 *   replaced. Deploy it after the data stack (the logs bucket) and before the
 *   observability stack, whose trail rule also watches this trail's key
 *   (its ARN from SSM).
 */
export class AuditStack extends SupplyCheckoutStack {
  readonly trail: CfnTrail;
  readonly bucket: Bucket;
  readonly key: Key;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "audit", layer: "stateful" });
    if (region !== config.primaryRegion) throw new Error("The audit stack is in the primary region only (its trail is multi-region)");

    const name = trailName(config.envName);
    const trailArn = `arn:${Aws.PARTITION}:cloudtrail:${Aws.REGION}:${Aws.ACCOUNT_ID}:trail/${name}`;
    const fromThisTrail = { StringEquals: { "aws:SourceArn": trailArn, "aws:SourceAccount": Aws.ACCOUNT_ID } };
    const cloudTrail = new ServicePrincipal("cloudtrail.amazonaws.com");

    this.key = new Key(this, "TrailKey", {
      alias: `alias/supply-checkout-${config.envName}-trail`,
      description: "Encrypts the Supply Checkout CloudTrail trail's log and digest files",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // CloudTrail's documented key policy, for this trail only
    this.key.addToResourcePolicy(
      new PolicyStatement({
        sid: "CloudTrailEncryptsThisTrailsLogs",
        principals: [cloudTrail],
        actions: ["kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: {
          ...fromThisTrail,
          StringLike: { "kms:EncryptionContext:aws:cloudtrail:arn": `arn:${Aws.PARTITION}:cloudtrail:*:${Aws.ACCOUNT_ID}:trail/*` },
        },
      }),
    );
    this.key.addToResourcePolicy(
      new PolicyStatement({
        sid: "CloudTrailDescribesTheKey",
        principals: [cloudTrail],
        actions: ["kms:DescribeKey"],
        resources: ["*"],
        conditions: fromThisTrail,
      }),
    );

    const logs = Bucket.fromBucketName(this, "LogsBucket", logsBucketName(config.envName, region));
    this.bucket = new Bucket(this, "TrailBucket", {
      bucketName: trailBucketName(config.envName, region),
      encryption: BucketEncryption.KMS,
      encryptionKey: this.key,
      // CloudTrail encrypts each file with the key itself; a bucket key would
      // change the encryption context the key policy checks
      bucketKeyEnabled: false,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      // Versioned so an overwrite or delete of a log file can be undone for 30
      // days (supply-checkout-8x1: every bucket that holds data is versioned);
      // log file validation shows one was changed
      versioned: true,
      lifecycleRules: [{ expiration: Duration.days(TRAIL_LOG_RETENTION_DAYS), noncurrentVersionExpiration: Duration.days(30) }],
      serverAccessLogsBucket: logs,
      serverAccessLogsPrefix: "s3/trail/",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Annotations.of(this.bucket).acknowledgeWarning(
      "@aws-cdk/aws-s3:accessLogsPolicyNotAdded",
      "The logs bucket is the data stack's: its policy grants S3 log delivery from this bucket under s3/trail/ (TrailBucketAccessLogs in data-stack.ts).",
    );
    // CloudTrail's documented bucket policy, for this trail only
    const aclCheck = new PolicyStatement({
      sid: "CloudTrailChecksTheBucketAcl",
      effect: Effect.ALLOW,
      principals: [cloudTrail],
      actions: ["s3:GetBucketAcl"],
      resources: [this.bucket.bucketArn],
      conditions: fromThisTrail,
    });
    const write = new PolicyStatement({
      sid: "CloudTrailWritesThisAccountsLogs",
      effect: Effect.ALLOW,
      principals: [cloudTrail],
      actions: ["s3:PutObject"],
      resources: [this.bucket.arnForObjects(`AWSLogs/${Aws.ACCOUNT_ID}/*`)],
      conditions: { StringEquals: { ...fromThisTrail.StringEquals, "s3:x-amz-acl": "bucket-owner-full-control" } },
    });
    this.bucket.addToResourcePolicy(aclCheck);
    this.bucket.addToResourcePolicy(write);

    this.trail = new CfnTrail(this, "Trail", {
      trailName: name,
      s3BucketName: this.bucket.bucketName,
      kmsKeyId: this.key.keyArn,
      isLogging: true,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableLogFileValidation: true,
      // Every management event, read and write: the alert rules need the
      // writes, an investigation the reads (who looked up an operator, read a
      // secret). The first copy of management events is free.
      eventSelectors: [{ readWriteType: "All", includeManagementEvents: true }],
    });
    // Deleting the stack, or a change that would replace the trail, leaves it logging
    this.trail.applyRemovalPolicy(RemovalPolicy.RETAIN);
    // CloudTrail checks the bucket policy and the key when the trail is created
    this.trail.node.addDependency(this.key);
    if (this.bucket.policy) this.trail.node.addDependency(this.bucket.policy);

    const params = auditOutputParameters(config.envName);
    new StringParameter(this, "TrailNameParam", { parameterName: params.trailName, stringValue: name, description: "The account's CloudTrail trail" });
    new StringParameter(this, "TrailBucketParam", { parameterName: params.trailBucketName, stringValue: this.bucket.bucketName, description: "The CloudTrail trail's bucket" });
    new StringParameter(this, "TrailKeyArnParam", { parameterName: params.trailKeyArn, stringValue: this.key.keyArn, description: "KMS key ARN for the CloudTrail trail's files" });
  }
}
