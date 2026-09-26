import { Aws, Duration, Fn, RemovalPolicy, TimeZone, Validations } from "aws-cdk-lib";
import { BackupPlan, BackupPlanRule, BackupResource, BackupVault } from "aws-cdk-lib/aws-backup";
import { Alarm, ComparisonOperator, MathExpression, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Schedule } from "aws-cdk-lib/aws-events";
import { AccountPrincipal, Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Topic } from "aws-cdk-lib/aws-sns";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { tableName } from "../../../backend/src/data/schema.js";
import {
  LOCAL_RETENTION,
  COPY_RETENTION,
  MAX_LOCK_RETENTION,
  MIN_LOCK_RETENTION,
  backupCopyFromContext,
  backupParameters,
  backupVaultName,
  restoreTablePrefix,
} from "../backup.js";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/** KMS actions another account needs to copy a recovery point encrypted with a key it doesn't own. */
const KEY_USE = ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"];

/**
 * AWS Backup for the app table, in the primary region of the workload account
 * (supply-checkout-8x1, docs/backups.md).
 *
 * - A vault with its own customer-managed key and a governance-mode vault
 *   lock: recovery points can't be deleted before MIN_LOCK_RETENTION, and the
 *   access policy denies deleting them at all (they expire on schedule).
 * - A daily plan for the table, kept LOCAL_RETENTION here and copied to the
 *   backup account's vault (compliance-mode lock, COPY_RETENTION). The copy
 *   vault's ARN is an SSM parameter the owner sets, read at deploy time, so no
 *   account ID is in this repository. `-c backupCopy=false` leaves the copy
 *   out, for an environment without a backup account vault.
 * - Least-privilege roles: one AWS Backup uses to back up the table and copy
 *   it, and one for restore jobs, which may only create tables named
 *   `<table>-restore-*`.
 * - Two P2 alarms (the observability stack's P2 topic, from SSM): a backup or
 *   copy job failed, or no backup finished in the last day.
 *
 * Point-in-time recovery is on the table itself (data stack). DynamoDB's
 * advanced backup features must be turned on in the account for cross-account
 * copies; that's an account setting, not a CloudFormation resource (see
 * docs/backups.md).
 */
export class BackupStack extends SupplyCheckoutStack {
  readonly vault: BackupVault;
  readonly vaultKey: Key;
  readonly plan: BackupPlan;
  readonly backupRole: Role;
  readonly restoreRole: Role;
  readonly alarms: Alarm[];
  /** Whether the daily backup is copied to the backup account. */
  readonly copiesToBackupAccount: boolean;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "backup", layer: "stateful" });
    this.copiesToBackupAccount = backupCopyFromContext(this.node);
    const params = backupParameters(config.envName);
    const ssm = (name: string) => StringParameter.valueForStringParameter(this, name);
    // The table's name is fixed (backend/src/data/schema.ts); its key ARN is
    // published by the data stack, which deploys first
    const tableArn = `arn:${Aws.PARTITION}:dynamodb:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${tableName(config.envName)}`;
    const tableBackups = `${tableArn}/backup/*`;
    const tableKeyArn = ssm(`/supply-checkout/${config.envName}/data/table-key-arn`);
    const copyVaultArn = this.copiesToBackupAccount ? ssm(params.copyVaultArn) : undefined;
    // arn:<partition>:backup:<region>:<account>:backup-vault:<name>
    const backupAccount = copyVaultArn ? new AccountPrincipal(Fn.select(4, Fn.split(":", copyVaultArn))) : undefined;

    this.vaultKey = new Key(this, "VaultKey", {
      alias: `alias/supply-checkout-${config.envName}-backups`,
      description: "Encrypts the Supply Checkout backup vault",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    if (backupAccount) {
      // A cross-account copy reads the source recovery point with this key
      this.vaultKey.addToResourcePolicy(
        new PolicyStatement({
          sid: "BackupAccountCopiesRecoveryPoints",
          principals: [backupAccount],
          actions: KEY_USE,
          resources: ["*"],
        }),
      );
      this.vaultKey.addToResourcePolicy(
        new PolicyStatement({
          sid: "BackupAccountGrantsToAwsBackup",
          principals: [backupAccount],
          actions: ["kms:CreateGrant"],
          resources: ["*"],
          conditions: { Bool: { "kms:GrantIsForAWSResource": "true" } },
        }),
      );
    }

    this.vault = new BackupVault(this, "Vault", {
      backupVaultName: backupVaultName(config.envName),
      encryptionKey: this.vaultKey,
      // Governance mode (no ChangeableForDays): an administrator here can still
      // fix a mistake. The copy in the backup account is the one nobody can
      // delete (compliance mode there).
      lockConfiguration: { minRetention: MIN_LOCK_RETENTION, maxRetention: MAX_LOCK_RETENTION },
      // Denies backup:DeleteRecoveryPoint and UpdateRecoveryPointLifecycle to everyone
      blockRecoveryPointDeletion: true,
      accessPolicy: new PolicyDocument(),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    if (backupAccount) {
      // Restoring from the backup account starts with a copy back into this vault
      this.vault.addToAccessPolicy(
        new PolicyStatement({
          sid: "BackupAccountCopiesBackForRestores",
          effect: Effect.ALLOW,
          principals: [backupAccount],
          actions: ["backup:CopyIntoBackupVault"],
          resources: ["*"],
        }),
      );
    }

    this.backupRole = new Role(this, "BackupRole", {
      roleName: `supply-checkout-${config.envName}-backup`,
      description: "AWS Backup backs up the Supply Checkout app table and copies it to the backup account",
      assumedBy: new ServicePrincipal("backup.amazonaws.com"),
    });
    this.backupRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "BackUpTheTable",
        actions: ["dynamodb:CreateBackup", "dynamodb:DescribeTable", "dynamodb:ListTagsOfResource", "dynamodb:StartAwsBackupJob"],
        resources: [tableArn],
      }),
    );
    this.backupRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "ManageTheTablesBackups",
        actions: ["dynamodb:DeleteBackup", "dynamodb:DescribeBackup"],
        resources: [tableBackups],
      }),
    );
    // With advanced backup features the backup is re-encrypted with the vault key
    this.backupRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "ReadTheTablesKey",
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [tableKeyArn],
      }),
    );
    this.backupRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "UseTheVaultKey",
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [this.vaultKey.keyArn],
      }),
    );
    this.backupRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "GrantKeysToAwsBackup",
        actions: ["kms:CreateGrant"],
        resources: [tableKeyArn, this.vaultKey.keyArn],
        conditions: { Bool: { "kms:GrantIsForAWSResource": "true" } },
      }),
    );
    if (copyVaultArn) {
      this.backupRole.addToPrincipalPolicy(
        new PolicyStatement({
          sid: "CopyToTheBackupAccount",
          actions: ["backup:CopyIntoBackupVault", "backup:DescribeBackupVault"],
          resources: [copyVaultArn],
        }),
      );
    }
    Validations.of(this.backupRole.node.findChild("DefaultPolicy")).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:dynamodb:<AWS::Region>:<AWS::AccountId>:table/${tableName(config.envName)}/backup/*]`,
      reason: "Backup ARNs are generated per backup (<table>/backup/<id>), so the role manages the table's own backups by that prefix.",
    });

    this.plan = new BackupPlan(this, "Plan", {
      backupPlanName: `supply-checkout-${config.envName}-daily`,
      backupPlanRules: [
        new BackupPlanRule({
          ruleName: "daily",
          backupVault: this.vault,
          // 2am Eastern, the quietest hour for US customers
          scheduleExpression: Schedule.cron({ minute: "0", hour: "2" }),
          scheduleExpressionTimezone: TimeZone.AMERICA_NEW_YORK,
          deleteAfter: LOCAL_RETENTION,
          copyActions: copyVaultArn
            ? [{ destinationBackupVault: BackupVault.fromBackupVaultArn(this, "CopyVault", copyVaultArn), deleteAfter: COPY_RETENTION }]
            : undefined,
        }),
      ],
    });
    this.plan.addSelection("AppTable", {
      backupSelectionName: "app-table",
      resources: [BackupResource.fromArn(tableArn)],
      role: this.backupRole,
      // Only the scoped policies above, not AWSBackupServiceRolePolicyForBackup
      disableDefaultBackupPolicy: true,
    });

    // Restore jobs (the drill in docs/backups.md, or a real restore) pass this
    // role. DynamoDB restores always create a new table; this role can only
    // create and fill tables named <table>-restore-*.
    const restoreTables = `arn:${Aws.PARTITION}:dynamodb:${Aws.REGION}:${Aws.ACCOUNT_ID}:table/${restoreTablePrefix(config.envName)}*`;
    this.restoreRole = new Role(this, "RestoreRole", {
      roleName: `supply-checkout-${config.envName}-restore`,
      description: "AWS Backup restores the Supply Checkout app table into a new <table>-restore-* table",
      assumedBy: new ServicePrincipal("backup.amazonaws.com"),
    });
    this.restoreRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "RestoreIntoANewTable",
        actions: [
          "dynamodb:BatchWriteItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:RestoreTableFromAwsBackup",
          "dynamodb:RestoreTableFromBackup",
          "dynamodb:Scan",
          "dynamodb:UpdateItem",
        ],
        resources: [restoreTables],
      }),
    );
    this.restoreRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "RestoreFromTheTablesBackups",
        actions: ["dynamodb:RestoreTableFromBackup"],
        resources: [tableBackups],
      }),
    );
    this.restoreRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "ReadTheVaultKey",
        actions: ["kms:Decrypt", "kms:DescribeKey"],
        resources: [this.vaultKey.keyArn],
      }),
    );
    // The restored table is encrypted with the app table's key
    this.restoreRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "EncryptTheRestoredTable",
        actions: ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey"],
        resources: [tableKeyArn],
      }),
    );
    this.restoreRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: "GrantKeysToDynamoDb",
        actions: ["kms:CreateGrant"],
        resources: [tableKeyArn, this.vaultKey.keyArn],
        conditions: { Bool: { "kms:GrantIsForAWSResource": "true" } },
      }),
    );
    const restorePolicy = this.restoreRole.node.findChild("DefaultPolicy");
    Validations.of(restorePolicy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:dynamodb:<AWS::Region>:<AWS::AccountId>:table/${restoreTablePrefix(config.envName)}*]`,
      reason: "Restored tables are named at restore time, so the role is limited to tables named <table>-restore-*, never the live table.",
    });
    Validations.of(restorePolicy).acknowledge({
      id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:dynamodb:<AWS::Region>:<AWS::AccountId>:table/${tableName(config.envName)}/backup/*]`,
      reason: "Backup ARNs are generated per backup (<table>/backup/<id>), so the role reads the table's own backups by that prefix.",
    });

    // Job metrics are published by resource type; the table is the only
    // DynamoDB resource AWS Backup protects in this account.
    const jobs = (metricName: string, period: Duration) =>
      new Metric({ namespace: "AWS/Backup", metricName, dimensionsMap: { ResourceType: "DynamoDB" }, statistic: "Sum", period });
    const p2 = new SnsAction(
      Topic.fromTopicArn(this, "P2Topic", ssm(`/supply-checkout/${config.envName}/observability/alarm-topic-p2-arn`)),
    );
    const alarm = (id: string, props: Omit<ConstructorParameters<typeof Alarm>[2], "alarmName" | "evaluationPeriods">) => {
      const a = new Alarm(this, id, { ...props, alarmName: `supply-checkout-${config.envName}-p2-${id}`, evaluationPeriods: 1 });
      a.addAlarmAction(p2);
      a.addOkAction(p2);
      return a;
    };
    this.alarms = [
      alarm("backup-failed", {
        alarmDescription:
          "P2 Backup failed. A backup or copy job for the app table failed, was aborted or expired in the last hour. " +
          "Runbook: docs/backups.md, When a backup fails.",
        metric: new MathExpression({
          expression: "FILL(bf, 0) + FILL(ba, 0) + FILL(be, 0) + FILL(cf, 0)",
          usingMetrics: {
            bf: jobs("NumberOfBackupJobsFailed", Duration.hours(1)),
            ba: jobs("NumberOfBackupJobsAborted", Duration.hours(1)),
            be: jobs("NumberOfBackupJobsExpired", Duration.hours(1)),
            cf: jobs("NumberOfCopyJobsFailed", Duration.hours(1)),
          },
          period: Duration.hours(1),
          label: "Failed backup and copy jobs",
        }),
        threshold: 0,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
      alarm("no-recent-backup", {
        alarmDescription:
          "P2 No recent backup. No backup of the app table finished in the last 24 hours (the plan runs daily at 2am Eastern). " +
          "It also fires on the first day after the backup stack is deployed. Runbook: docs/backups.md, When a backup fails.",
        metric: jobs("NumberOfBackupJobsCompleted", Duration.days(1)),
        threshold: 1,
        comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
        // No data at all means no backup ran
        treatMissingData: TreatMissingData.BREACHING,
      }),
    ];

    const publish = (id: string, name: string, value: string, description: string) =>
      new StringParameter(this, id, { parameterName: name, stringValue: value, description });
    publish("VaultArnParam", params.vaultArn, this.vault.backupVaultArn, "Backup vault for the app table");
    publish("RestoreRoleArnParam", params.restoreRoleArn, this.restoreRole.roleArn, "Role to pass to AWS Backup restore jobs");
  }
}
