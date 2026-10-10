import { Aws, Duration, RemovalPolicy, Validations } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  ProjectionType,
  StreamViewType,
  TableEncryptionV2,
  TableV2,
} from "aws-cdk-lib/aws-dynamodb";
import { Effect, PolicyStatement, type Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { BlockPublicAccess, Bucket, BucketEncryption, type CfnBucket, ObjectLockRetention, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { GSI1, GSI1PK, GSI1SK, GSI2, GSI2PK, GSI2SK, GSI3, GSI3PK, GSI3SK, OPS_INDEX_ATTRIBUTES, PK, SK, TTL_ATTRIBUTE, tableName } from "../../../backend/src/data/schema.js";
import { DELETION_RECORD_RETENTION_DAYS, deletionsBucketName } from "../../../backend/src/deletions/names.js";
import { PHOTO_PREFIX, PHOTOS_METRICS_ID, photosBucketName } from "../../../backend/src/photos/names.js";
import { backupCopyFromContext, backupParameters } from "../backup.js";
import type { DeploymentConfig } from "../config.js";
import { backupAccountFromCopyVaultArn, replicateDeletionRecords } from "../deletions.js";
import { hasJourneys, JOURNEY_ACCESS_LOG_PREFIXES, journeyMailBucketName, journeyResultsBucketName } from "../journeys.js";
import { trailBucketName } from "./audit-stack.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * The web bucket in a region: releases of the web app and the demo under
 * releases/<version>/ (ADR 0010: the name includes the region). The account
 * ID makes the name globally unique; it's resolved at deploy time.
 */
export function webBucketName(envName: string, region: string, account: string = Aws.ACCOUNT_ID): string {
  return `supply-checkout-${envName}-web-${region}-${account}`;
}

/** Access logs for the web bucket and CloudFront, in the same region. */
export function logsBucketName(envName: string, region: string, account: string = Aws.ACCOUNT_ID): string {
  return `supply-checkout-${envName}-logs-${region}-${account}`;
}

/**
 * Stateful resources in each region: the DynamoDB global table and its KMS key
 * (ADR 0005), the regional web bucket (ADR 0010) and Secrets Manager replicas.
 *
 * - The `app` table is a TableV2 (AWS::DynamoDB::GlobalTable) owned by the
 *   primary region's data stack, with one replica: the primary region. The
 *   other regions' replicas, and the KMS keys in those regions, are phase 2
 *   (supply-checkout-72d.1); adding one is another entry in `replicas` plus its
 *   key ARN in `replicaKeyArns`, not a new table.
 * - Its name, ARN, stream ARN and key ARN are published to SSM under
 *   /supply-checkout/<env>/data/ for the API and realtime stacks.
 * - The web bucket (releases of the web app and demo, served only through
 *   CloudFront) and a logs bucket, in the primary region. The second region's
 *   bucket, replication and the origin group are phase 2 (supply-checkout-d79).
 * - The deletion records bucket, in the primary region: one object per deleted
 *   account or team, IDs only, kept under Object Lock in compliance mode for
 *   DELETION_RECORD_RETENTION_DAYS, longer than any backup of the table, so a
 *   restore can delete them again (supply-checkout-0ic7, docs/backups.md).
 *   It replicates to the backup account (deletions.ts), so the stack reads
 *   /supply-checkout/<env>/backup/copy-vault-arn and organization-id at
 *   deploy time; `-c backupCopy=false` leaves the replication out. Its object
 *   events go to EventBridge, for the deletion records watch.
 * - The profile photos bucket, in the primary region (supply-checkout-6uw.30):
 *   `photos/<photoId>.jpg`, private, read and written only by the account
 *   function (api-stack.ts) and served through presigned URLs. Not versioned
 *   and not backed up: a deleted or replaced photo is gone at once, which is
 *   the point, and a lost one is re-uploaded.
 * - Everything added here must use RemovalPolicy.RETAIN.
 */
export class DataStack extends SupplyCheckoutStack {
  /** The global table. Only the primary region's data stack has it. */
  readonly table?: TableV2;
  /** The table's customer-managed key in this region. */
  readonly tableKey?: Key;
  /** Web releases, read by CloudFront. Only the primary region's data stack has it (phase 2 adds one per region). */
  readonly webBucket?: Bucket;
  /** S3 server access logs and CloudFront standard logs. */
  readonly logsBucket?: Bucket;
  /** Deletion records (backend/src/deletions). Primary region only. */
  readonly deletionsBucket?: Bucket;
  /** Replicates the deletion records to the backup account. Primary region only, and not with `-c backupCopy=false`. */
  readonly deletionsReplicationRole?: Role;
  /** Profile photos (backend/src/photos). Primary region only. */
  readonly photosBucket?: Bucket;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "data", layer: "stateful" });
    if (!this.isPrimaryRegion) return;

    const prefix = `/supply-checkout/${config.envName}/data`;

    this.tableKey = new Key(this, "TableKey", {
      alias: `alias/supply-checkout-${config.envName}-app-table`,
      description: "Encrypts the Supply Checkout app table (ADR 0005)",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.table = new TableV2(this, "AppTable", {
      tableName: tableName(config.envName),
      partitionKey: { name: PK, type: AttributeType.STRING },
      sortKey: { name: SK, type: AttributeType.STRING },
      billing: Billing.onDemand(),
      encryption: TableEncryptionV2.customerManagedKey(this.tableKey),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      globalSecondaryIndexes: [
        {
          indexName: GSI1,
          partitionKey: { name: GSI1PK, type: AttributeType.STRING },
          sortKey: { name: GSI1SK, type: AttributeType.STRING },
        },
        // Invites by the invitee's hashed email (first sign-in's pending invites)
        {
          indexName: GSI2,
          partitionKey: { name: GSI2PK, type: AttributeType.STRING },
          sortKey: { name: GSI2SK, type: AttributeType.STRING },
        },
        // The operators' index (ADR 0015): team account records, owners and
        // the operator audit, and only the attributes it projects. The ops
        // role may query only this, so operators can't read a team's data
        {
          indexName: GSI3,
          partitionKey: { name: GSI3PK, type: AttributeType.STRING },
          sortKey: { name: GSI3SK, type: AttributeType.STRING },
          projectionType: ProjectionType.INCLUDE,
          nonKeyAttributes: [...OPS_INDEX_ATTRIBUTES],
        },
      ],
      // The stack's own region is always a replica; no others until phase 2.
      replicas: [],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const publish = (id: string, name: string, value: string, description: string) =>
      new StringParameter(this, id, { parameterName: `${prefix}/${name}`, stringValue: value, description });
    publish("TableNameParam", "table-name", this.table.tableName, "App table name");
    publish("TableArnParam", "table-arn", this.table.tableArn, "App table ARN in this region");
    publish("TableStreamArnParam", "table-stream-arn", this.table.tableStreamArn ?? "", "App table stream ARN in this region");
    publish("TableKeyArnParam", "table-key-arn", this.tableKey.keyArn, "KMS key ARN for the app table in this region");

    // CloudFront's standard logs are written with an ACL grant, so this bucket
    // keeps ACLs (object writer's grants are honoured, the bucket owner owns
    // the objects). One year, like the log groups (observability/defaults.ts).
    this.logsBucket = new Bucket(this, "LogsBucket", {
      bucketName: logsBucketName(config.envName, region),
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
      enforceSSL: true,
      // Versioned so an overwrite or delete of a log can be undone for 30 days
      // (supply-checkout-8x1: every bucket that holds data is versioned)
      versioned: true,
      lifecycleRules: [{ expiration: Duration.days(365), noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Validations.of(this.logsBucket).acknowledge({
      id: "AwsSolutions-S1",
      reason: "This is the access-log bucket; logging it to itself would loop.",
    });
    // The audit stack's trail bucket logs here too. It's another stack's bucket,
    // so its access-log grant is written out here, as CDK writes the ones for
    // this stack's buckets: S3's log delivery, from that bucket only, under
    // s3/trail/. Like the audit stack, this is the primary region only (the
    // early return above).
    const trailBucketArn = `arn:${Aws.PARTITION}:s3:::${trailBucketName(config.envName, region)}`;
    this.logsBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "TrailBucketAccessLogs",
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal("logging.s3.amazonaws.com")],
        actions: ["s3:PutObject"],
        resources: [this.logsBucket.arnForObjects("s3/trail/*")],
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID }, ArnLike: { "aws:SourceArn": trailBucketArn } },
      }),
    );

    // The journeys stack's mail and results buckets (supply-checkout-o60.3)
    // log here too, each under its own prefix. Prod only, like that stack.
    if (hasJourneys(config)) {
      const journeyBuckets = [
        { sid: "JourneyMailBucketAccessLogs", name: journeyMailBucketName(config.envName, region), prefix: JOURNEY_ACCESS_LOG_PREFIXES.mail },
        { sid: "JourneyResultsBucketAccessLogs", name: journeyResultsBucketName(config.envName, region), prefix: JOURNEY_ACCESS_LOG_PREFIXES.results },
      ];
      for (const { sid, name, prefix } of journeyBuckets) {
        this.logsBucket.addToResourcePolicy(
          new PolicyStatement({
            sid,
            effect: Effect.ALLOW,
            principals: [new ServicePrincipal("logging.s3.amazonaws.com")],
            actions: ["s3:PutObject"],
            resources: [this.logsBucket.arnForObjects(`${prefix}*`)],
            conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID }, ArnLike: { "aws:SourceArn": `arn:${Aws.PARTITION}:s3:::${name}` } },
          }),
        );
      }
    }

    // Releases are immutable prefixes, rewritten into by the CloudFront Function
    // (web/router.js). Readable only by CloudFront distributions in this
    // account, through origin access control. The web stack is in
    // GLOBAL_SERVICES_REGION and imports this bucket by name, so the grant
    // can't name its distribution without a cross-region reference; the
    // account condition keeps it to this account's distributions.
    this.webBucket = new Bucket(this, "WebBucket", {
      bucketName: webBucketName(config.envName, region),
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true,
      // Old object versions exist only to undo an accidental overwrite or delete
      lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30) }],
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: "s3/web/",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.webBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: "CloudFrontReadsReleases",
        effect: Effect.ALLOW,
        principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
        // ListBucket makes a missing object a 404 rather than a 403
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [this.webBucket.bucketArn, this.webBucket.arnForObjects("*")],
        conditions: {
          StringEquals: { "AWS:SourceAccount": Aws.ACCOUNT_ID },
          ArnLike: { "AWS:SourceArn": `arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/*` },
        },
      }),
    );
    publish("WebBucketParam", "web-bucket-name", this.webBucket.bucketName, "Web releases bucket in this region");

    // Deletion records: `users/<userId>.json` and `teams/<teamId>.json`, IDs and
    // times only. The account function may put only users/*, the team purge only
    // teams/* (api-stack.ts, observability/ops-checks.ts), and nothing reads them
    // but the owner's restore script. Compliance mode: nobody, the root user
    // included, can delete or shorten a record's retention, so a stolen
    // administrator session can't erase what a restore must delete again. Once
    // the lock lapses, the lifecycle rule expires the record and its version.
    const retention = Duration.days(DELETION_RECORD_RETENTION_DAYS);
    this.deletionsBucket = new Bucket(this, "DeletionsBucket", {
      bucketName: deletionsBucketName(config.envName, region, Aws.ACCOUNT_ID),
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: ObjectLockRetention.compliance(retention),
      lifecycleRules: [{ expiration: retention.plus(Duration.days(1)), noncurrentVersionExpiration: Duration.days(1) }],
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: "s3/deletions/",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Its object events go to EventBridge, where the deletion records watch
    // (observability/deletion-records-watch.ts) looks for a record written
    // over or deleted (supply-checkout-72d.16). Set on the CloudFormation
    // resource: the Bucket's eventBridgeEnabled adds a custom resource whose
    // function may change any bucket's notifications.
    (this.deletionsBucket.node.defaultChild as CfnBucket).notificationConfiguration = { eventBridgeConfiguration: { eventBridgeEnabled: true } };
    publish("DeletionsBucketParam", "deletions-bucket-name", this.deletionsBucket.bucketName, "Deletion records bucket (primary region)");

    // ...and replicated to the backup account (supply-checkout-72d.10), which
    // the copy vault's ARN names, so the records survive losing this account.
    // `-c backupCopy=false` (no backup account) leaves it out, as it does the copies.
    if (backupCopyFromContext(this.node)) {
      const params = backupParameters(config.envName);
      const ssm = (name: string) => StringParameter.valueForStringParameter(this, name);
      this.deletionsReplicationRole = replicateDeletionRecords(this, this.deletionsBucket, {
        envName: config.envName,
        region,
        backupAccount: backupAccountFromCopyVaultArn(ssm(params.copyVaultArn)),
        organizationId: ssm(params.organizationId),
      });
    }

    // Profile photos (supply-checkout-6uw.30): one object per photo,
    // `photos/<photoId>.jpg`, the ID random. Only the account function's role
    // may put, get or delete them, under photos/* only (api-stack.ts); people
    // see them through presigned GET URLs that last an hour, which the web
    // app's img-src allows for this bucket's host only. Not versioned, so a
    // photo its owner removed or replaced, or deleted with their account, is
    // gone at once rather than kept as an old version; and not in AWS Backup
    // (S3 isn't in the backup plan): a lost photo is re-uploaded. Uploads are
    // single PUTs, so the multipart rule only tidies up after anything else.
    this.photosBucket = new Bucket(this, "PhotosBucket", {
      bucketName: photosBucketName(config.envName, region, Aws.ACCOUNT_ID),
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: false,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: "s3/photos/",
      // S3 request metrics under photos/ only, for the P2 "Profile photo downloads high" alarm (observability/photos-alarm.ts):
      // presigned URLs are bearer links, and S3 charges for every byte out
      metrics: [{ id: PHOTOS_METRICS_ID, prefix: PHOTO_PREFIX }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    publish("PhotosBucketParam", "photos-bucket-name", this.photosBucket.bucketName, "Profile photos bucket (primary region)");
  }
}
