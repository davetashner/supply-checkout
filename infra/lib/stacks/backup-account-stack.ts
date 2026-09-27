import { Aws, CfnOutput, CfnParameter, Duration, RemovalPolicy, Validations } from "aws-cdk-lib";
import { BackupVault } from "aws-cdk-lib/aws-backup";
import { Alarm, ComparisonOperator, MathExpression, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { AnyPrincipal, Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectLockRetention, ObjectOwnership } from "aws-cdk-lib/aws-s3";
import { Subscription, SubscriptionProtocol, Topic } from "aws-cdk-lib/aws-sns";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { BackupChangeAlerts, backupAlertRuleArns } from "../backup-alerts.js";
import { COMPLIANCE_GRACE_DAYS, COPY_LOCK, copyVaultName } from "../backup.js";
import { alarmContactParameter, alarmContactsFromContext } from "../observability/alarm-topics.js";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

import { COPY_KEY_USE } from "./backup-stack.js";
import { DELETION_RECORD_RETENTION_DAYS, deletionsReplicaBucketName } from "../../../backend/src/deletions/names.js";
import { deletionsReplicationRoleName } from "../deletions.js";

/** S3 access logs for the replica bucket, in the backup account. */
export function backupLogsBucketName(envName: string, region: string, account: string = Aws.ACCOUNT_ID): string {
  return `supply-checkout-${envName}-backup-logs-${region}-${account}`;
}

/**
 * The copies-missing alarm fires when this many hours in a row pass with no
 * copy completed in the vault. The plan runs daily, so this allows one
 * copy's worth of lateness before alarming, not a whole missed day and more.
 */
export const COPIES_MISSING_AFTER_HOURS = 36;
const COPIES_MISSING_PERIOD_HOURS = 12;

/** One 12-digit account ID per list item (CloudFormation applies AllowedPattern to each). */
export const ACCOUNT_ID_PATTERN = "^\\d{12}$";
/** The same, or empty (RestoreAccountIds' default). */
export const OPTIONAL_ACCOUNT_ID_PATTERN = "^(\\d{12})?$";
export const ORGANIZATION_ID_PATTERN = "^o-[a-z0-9]{10,32}$";

/**
 * The vault in the separate backup account that holds one environment's daily
 * copies (supply-checkout-8x1, docs/backups.md). It is NOT part of the main
 * app: the owner deploys it with the backup account's profile, from
 * bin/backup-account.ts (`npm run deploy:backup-account`).
 *
 * - A customer-managed key and a **compliance-mode** vault lock: after
 *   COMPLIANCE_GRACE_DAYS nobody, not even this account's root user or
 *   someone holding the workload account, can delete a copy before
 *   COPY_LOCK's minimum, shorten its retention, or remove the lock.
 * - Account IDs are CloudFormation parameters, given at deploy time, so none
 *   is in this repository:
 *   - `SourceAccountIds`: workload accounts that may copy into the vault.
 *   - `RestoreAccountIds` (default none): accounts a copy may be sent to for a
 *     restore or a drill. They may use the vault key, and the copy-out role
 *     may copy into their `supply-checkout-*` vaults.
 *   - `OrganizationId`: every other account must also be in this organization.
 * - Alerts, on its own encrypted SNS topic (`supply-checkout-<env>-backup-alerts`),
 *   emailed to the addresses in this account's SSM parameters
 *   `/supply-checkout/<env>/alarms/email-<n>` (as in the observability stack,
 *   so none is in this repository; `-c alarmContacts` sets how many):
 *   - `supply-checkout-<env>-backup-copies-missing`: no copy completed in the
 *     vault for COPIES_MISSING_AFTER_HOURS. This is what notices a workload
 *     account whose plan, copy rule or alarms were deleted by someone holding it.
 *   - EventBridge rules (backup-alerts.ts) when a vault's access policy or
 *     lock is changed or removed, a plan or selection is changed or deleted,
 *     or the vault key is disabled, scheduled for deletion or re-policied.
 * - The deletion records' replica (supply-checkout-72d.10): S3 replication
 *   from each source account's deletion records bucket writes here, as the
 *   role named deletionsReplicationRoleName and nothing else. Each record is
 *   kept under a compliance-mode Object Lock for DELETION_RECORD_RETENTION_DAYS,
 *   as in the source, and owned by this account. The restore script reads it
 *   with this account's profile (`--records-profile`).
 */
export class BackupAccountStack extends SupplyCheckoutStack {
  readonly vault: BackupVault;
  readonly vaultKey: Key;
  readonly copyOutRole: Role;
  readonly alertTopic: Topic;
  readonly copiesMissing: Alarm;
  readonly changeAlerts: BackupChangeAlerts;
  /** The replica of the workload accounts' deletion records (supply-checkout-72d.10). */
  readonly deletionsReplica: Bucket;
  readonly logsBucket: Bucket;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "backup-vault", layer: "stateful" });

    const sourceAccounts = new CfnParameter(this, "SourceAccountIds", {
      type: "CommaDelimitedList",
      description: "Workload account IDs whose backups are copied into this vault (the prod account; staging when it exists)",
      allowedPattern: ACCOUNT_ID_PATTERN,
      constraintDescription: "must be comma-separated 12-digit account IDs",
    });
    const restoreAccounts = new CfnParameter(this, "RestoreAccountIds", {
      type: "CommaDelimitedList",
      default: "",
      description: "Account IDs a copy may be sent to for a restore or restore drill (empty for none)",
      allowedPattern: OPTIONAL_ACCOUNT_ID_PATTERN,
      constraintDescription: "must be empty, or comma-separated 12-digit account IDs",
    });
    const organization = new CfnParameter(this, "OrganizationId", {
      type: "String",
      description: "The AWS Organization ID (o-...) the source and restore accounts belong to",
      allowedPattern: ORGANIZATION_ID_PATTERN,
      constraintDescription: "must be an organization ID like o-abcdefghij",
    });
    const inOrg = { "aws:PrincipalOrgID": organization.valueAsString };
    const inSourceAccounts = { StringEquals: { "aws:PrincipalAccount": sourceAccounts.valueAsList, ...inOrg } };
    const inRestoreAccounts = { StringEquals: { "aws:PrincipalAccount": restoreAccounts.valueAsList, ...inOrg } };

    this.vaultKey = new Key(this, "VaultKey", {
      alias: `alias/supply-checkout-${config.envName}-backup-copies`,
      description: `Encrypts the Supply Checkout ${config.envName} backup copies`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Copying a recovery point out of this vault (to restore it in another
    // account) needs that account to read it with this key
    this.vaultKey.addToResourcePolicy(
      new PolicyStatement({
        sid: "RestoreAccountsCopyRecoveryPoints",
        principals: [new AnyPrincipal()],
        actions: COPY_KEY_USE,
        resources: ["*"],
        conditions: inRestoreAccounts,
      }),
    );
    this.vaultKey.addToResourcePolicy(
      new PolicyStatement({
        sid: "RestoreAccountsGrantToAwsBackup",
        principals: [new AnyPrincipal()],
        actions: ["kms:CreateGrant"],
        resources: ["*"],
        conditions: { ...inRestoreAccounts, Bool: { "kms:GrantIsForAWSResource": "true" } },
      }),
    );

    this.vault = new BackupVault(this, "Vault", {
      backupVaultName: copyVaultName(config.envName),
      encryptionKey: this.vaultKey,
      // ChangeableForDays makes this compliance mode: immutable once it passes.
      // See COPY_LOCK: these values can never change after that.
      lockConfiguration: { ...COPY_LOCK, changeableFor: Duration.days(COMPLIANCE_GRACE_DAYS) },
      blockRecoveryPointDeletion: true,
      accessPolicy: new PolicyDocument(),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.vault.addToAccessPolicy(
      new PolicyStatement({
        sid: "SourceAccountsCopyIn",
        effect: Effect.ALLOW,
        principals: [new AnyPrincipal()],
        actions: ["backup:CopyIntoBackupVault"],
        resources: ["*"],
        conditions: inSourceAccounts,
      }),
    );

    // Copy jobs started here (a restore, or the drill) pass this role
    this.copyOutRole = new Role(this, "CopyOutRole", {
      roleName: `supply-checkout-${config.envName}-backup-copy-out`,
      description: "AWS Backup copies a Supply Checkout recovery point to a restore account's vault",
      assumedBy: new ServicePrincipal("backup.amazonaws.com"),
    });
    this.vaultKey.grantDecrypt(this.copyOutRole);
    this.copyOutRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "CopyFromThisVault",
        actions: ["backup:CopyFromBackupVault"],
        resources: [`arn:${Aws.PARTITION}:backup:${Aws.REGION}:${Aws.ACCOUNT_ID}:recovery-point:*`],
      }),
    );
    this.copyOutRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "CopyIntoRestoreAccountVaults",
        actions: ["backup:CopyIntoBackupVault", "backup:DescribeBackupVault"],
        resources: [`arn:${Aws.PARTITION}:backup:${Aws.REGION}:*:backup-vault:supply-checkout-*`],
        conditions: { StringEquals: { "aws:ResourceAccount": restoreAccounts.valueAsList, "aws:ResourceOrgID": organization.valueAsString } },
      }),
    );
    this.copyOutRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "GrantTheVaultKeyToAwsBackup",
        actions: ["kms:CreateGrant"],
        resources: [this.vaultKey.keyArn],
        conditions: { Bool: { "kms:GrantIsForAWSResource": "true" } },
      }),
    );
    Validations.of(this.copyOutRole.node.findChild("DefaultPolicy")).acknowledge({
      id: "AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:backup:<AWS::Region>:<AWS::AccountId>:recovery-point:*]",
      reason: "Recovery point ARNs are generated per copy; the role can only copy from recovery points in this account and region.",
    });
    Validations.of(this.copyOutRole.node.findChild("DefaultPolicy")).acknowledge({
      id: "AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:backup:<AWS::Region>:*:backup-vault:supply-checkout-*]",
      reason:
        "Restore accounts are a deploy-time parameter, so the vault ARN can't name them; aws:ResourceAccount limits the " +
        "wildcard to those accounts' supply-checkout-* vaults.",
    });

    // Alerts: an encrypted topic only this account's alarms and the two change rules may publish to
    const alertKey = new Key(this, "AlertKey", {
      alias: `alias/supply-checkout-${config.envName}-backup-alerts`,
      description: `Encrypts the Supply Checkout ${config.envName} backup alerts topic`,
      enableKeyRotation: true,
      // Nothing is kept under this key: a message is gone once it's delivered
      removalPolicy: RemovalPolicy.DESTROY,
    });
    alertKey.addToResourcePolicy(
      new PolicyStatement({
        sid: "AlarmsAndRulesPublishToTheTopic",
        principals: [new ServicePrincipal("cloudwatch.amazonaws.com"), new ServicePrincipal("events.amazonaws.com")],
        actions: ["kms:Decrypt", "kms:GenerateDataKey*"],
        resources: ["*"],
        conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID } },
      }),
    );
    this.alertTopic = new Topic(this, "AlertTopic", {
      topicName: `supply-checkout-${config.envName}-backup-alerts`,
      displayName: `Supply Checkout ${config.envName} backups`,
      masterKey: alertKey,
      enforceSSL: true,
    });
    this.alertTopic.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowCloudWatchAlarmsToPublish",
        principals: [new ServicePrincipal("cloudwatch.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [this.alertTopic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID },
          ArnLike: { "aws:SourceArn": `arn:${Aws.PARTITION}:cloudwatch:${Aws.REGION}:${Aws.ACCOUNT_ID}:alarm:*` },
        },
      }),
    );
    this.alertTopic.addToResourcePolicy(
      new PolicyStatement({
        sid: "AllowBackupChangeAlertsToPublish",
        principals: [new ServicePrincipal("events.amazonaws.com")],
        actions: ["sns:Publish"],
        resources: [this.alertTopic.topicArn],
        conditions: { ArnEquals: { "aws:SourceArn": backupAlertRuleArns(config.envName, "backup-account") } },
      }),
    );
    for (let n = 1; n <= alarmContactsFromContext(this.node).email; n++) {
      new Subscription(this, `AlertEmail${n}`, {
        topic: this.alertTopic,
        protocol: SubscriptionProtocol.EMAIL,
        // Resolved at deploy time from this account's SSM parameter, so the address is never in the template
        endpoint: StringParameter.valueForStringParameter(this, alarmContactParameter(config.envName, "email", n)),
      });
    }

    // Recovery point metrics are only sent when non-zero, and it isn't
    // documented which dimensions a copy's recovery point carries in the
    // destination account, so this adds the vault's metric with and without
    // ResourceType. If neither exists the sum is 0 and the alarm fires, so a
    // wrong guess is loud, not silent (docs/backups.md says how to check).
    const period = Duration.hours(COPIES_MISSING_PERIOD_HOURS);
    const completed = (dimensionsMap: Record<string, string>) =>
      new Metric({ namespace: "AWS/Backup", metricName: "NumberOfRecoveryPointsCompleted", dimensionsMap, statistic: "Sum", period });
    const periods = COPIES_MISSING_AFTER_HOURS / COPIES_MISSING_PERIOD_HOURS;
    this.copiesMissing = new Alarm(this, "CopiesMissing", {
      alarmName: `supply-checkout-${config.envName}-backup-copies-missing`,
      alarmDescription:
        `No copy of the ${config.envName} app table's daily backup completed in ${copyVaultName(config.envName)} in the last ` +
        `${COPIES_MISSING_AFTER_HOURS} hours. The workload account's plan, copy rule or permissions may have been changed or deleted. ` +
        "Runbook: docs/backups.md, When copies stop arriving.",
      metric: new MathExpression({
        expression: "FILL(vault, 0) + FILL(dynamodb, 0)",
        usingMetrics: {
          vault: completed({ BackupVaultName: copyVaultName(config.envName) }),
          dynamodb: completed({ BackupVaultName: copyVaultName(config.envName), ResourceType: "DynamoDB" }),
        },
        period,
        label: "Copies completed in the vault",
      }),
      threshold: 1,
      comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: periods,
      datapointsToAlarm: periods,
      // No data at all means no copy arrived
      treatMissingData: TreatMissingData.BREACHING,
    });
    const notify = new SnsAction(this.alertTopic);
    this.copiesMissing.addAlarmAction(notify);
    this.copiesMissing.addOkAction(notify);

    this.changeAlerts = new BackupChangeAlerts(this, "ChangeAlerts", {
      envName: config.envName,
      side: "backup-account",
      vaultKeyArn: this.vaultKey.keyArn,
      topic: this.alertTopic,
    });

    // The deletion records' replica. Its access logs go to a logs bucket here,
    // set up like the data stack's (log delivery may use an ACL grant)
    this.logsBucket = new Bucket(this, "LogsBucket", {
      bucketName: backupLogsBucketName(config.envName, Aws.REGION),
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{ expiration: Duration.days(365), noncurrentVersionExpiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    Validations.of(this.logsBucket).acknowledge({
      id: "AwsSolutions-S1",
      reason: "This is the access-log bucket; logging it to itself would loop.",
    });
    const retention = Duration.days(DELETION_RECORD_RETENTION_DAYS);
    this.deletionsReplica = new Bucket(this, "DeletionsReplica", {
      bucketName: deletionsReplicaBucketName(config.envName, Aws.REGION, Aws.ACCOUNT_ID),
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      // ACLs off: every replica belongs to this account, whatever the writer asks
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: true,
      objectLockEnabled: true,
      // A replica keeps its source record's retain-until date; this covers any that has none
      objectLockDefaultRetention: ObjectLockRetention.compliance(retention),
      lifecycleRules: [{ expiration: retention.plus(Duration.days(1)), noncurrentVersionExpiration: Duration.days(1) }],
      serverAccessLogsBucket: this.logsBucket,
      serverAccessLogsPrefix: "s3/deletions-copy/",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // Only the source accounts' replication role, in the organization, may write replicas, and nothing else
    const replicationRole = {
      StringEquals: { ...inSourceAccounts.StringEquals },
      ArnLike: { "aws:PrincipalArn": `arn:${Aws.PARTITION}:iam::*:role/${deletionsReplicationRoleName(config.envName)}` },
    };
    this.deletionsReplica.addToResourcePolicy(
      new PolicyStatement({
        sid: "SourceAccountsReplicateRecords",
        principals: [new AnyPrincipal()],
        actions: ["s3:ReplicateObject", "s3:ObjectOwnerOverrideToBucketOwner"],
        resources: [this.deletionsReplica.arnForObjects("*")],
        conditions: replicationRole,
      }),
    );
    this.deletionsReplica.addToResourcePolicy(
      new PolicyStatement({
        sid: "SourceAccountsCheckTheBucket",
        principals: [new AnyPrincipal()],
        actions: ["s3:GetBucketVersioning", "s3:GetBucketObjectLockConfiguration"],
        resources: [this.deletionsReplica.bucketArn],
        conditions: replicationRole,
      }),
    );

    new CfnOutput(this, "DeletionsReplicaBucket", {
      value: this.deletionsReplica.bucketName,
      description: "The deletion records' replica; the restore script reads it with --records-profile",
    });
    new CfnOutput(this, "CopyVaultArn", {
      value: this.vault.backupVaultArn,
      description: `Put this in /supply-checkout/${config.envName}/backup/copy-vault-arn in each source account`,
    });
    new CfnOutput(this, "CopyOutRoleArn", {
      value: this.copyOutRole.roleArn,
      description: "Pass this role to copy jobs that send a recovery point to a restore account",
    });
  }
}
