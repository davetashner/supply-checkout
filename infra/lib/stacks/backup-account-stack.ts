import { Aws, CfnOutput, CfnParameter, Duration, RemovalPolicy, Validations } from "aws-cdk-lib";
import { BackupVault } from "aws-cdk-lib/aws-backup";
import { AnyPrincipal, Effect, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import type { Construct } from "constructs";
import { COMPLIANCE_GRACE_DAYS, MAX_LOCK_RETENTION, MIN_LOCK_RETENTION, copyVaultName } from "../backup.js";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/** KMS actions another account needs to copy a recovery point encrypted with a key it doesn't own. */
const KEY_USE = ["kms:Decrypt", "kms:DescribeKey", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*"];

/**
 * The vault in the separate backup account that holds one environment's daily
 * copies (supply-checkout-8x1, docs/backups.md). It is NOT part of the main
 * app: the owner deploys it with the backup account's profile, from
 * bin/backup-account.ts (`npm run deploy:backup-account`).
 *
 * - A customer-managed key and a **compliance-mode** vault lock: after
 *   COMPLIANCE_GRACE_DAYS nobody, not even this account's root user or
 *   someone holding the workload account, can delete a copy before
 *   MIN_LOCK_RETENTION, shorten its retention, or remove the lock.
 * - Account IDs are CloudFormation parameters, given at deploy time, so none
 *   is in this repository:
 *   - `SourceAccountIds`: workload accounts that may copy into the vault.
 *   - `RestoreAccountIds` (default none): accounts a copy may be sent to for a
 *     restore or a drill. They may use the vault key, and the copy-out role
 *     may copy into their `supply-checkout-*` vaults.
 */
export class BackupAccountStack extends SupplyCheckoutStack {
  readonly vault: BackupVault;
  readonly vaultKey: Key;
  readonly copyOutRole: Role;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "backup-vault", layer: "stateful" });

    const sourceAccounts = new CfnParameter(this, "SourceAccountIds", {
      type: "CommaDelimitedList",
      description: "Workload account IDs whose backups are copied into this vault (the prod account; staging when it exists)",
    });
    const restoreAccounts = new CfnParameter(this, "RestoreAccountIds", {
      type: "CommaDelimitedList",
      default: "",
      description: "Account IDs a copy may be sent to for a restore or restore drill (empty for none)",
    });
    const inSourceAccounts = { StringEquals: { "aws:PrincipalAccount": sourceAccounts.valueAsList } };
    const inRestoreAccounts = { StringEquals: { "aws:PrincipalAccount": restoreAccounts.valueAsList } };

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
        actions: KEY_USE,
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
      // ChangeableForDays makes this compliance mode: immutable once it passes
      lockConfiguration: {
        minRetention: MIN_LOCK_RETENTION,
        maxRetention: MAX_LOCK_RETENTION,
        changeableFor: Duration.days(COMPLIANCE_GRACE_DAYS),
      },
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
        sid: "CopyIntoRestoreAccountVaults",
        actions: ["backup:CopyIntoBackupVault", "backup:DescribeBackupVault"],
        resources: [`arn:${Aws.PARTITION}:backup:${Aws.REGION}:*:backup-vault:supply-checkout-*`],
        conditions: { StringEquals: { "aws:ResourceAccount": restoreAccounts.valueAsList } },
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
      id: "AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:backup:<AWS::Region>:*:backup-vault:supply-checkout-*]",
      reason:
        "Restore accounts are a deploy-time parameter, so the vault ARN can't name them; aws:ResourceAccount limits the " +
        "wildcard to those accounts' supply-checkout-* vaults.",
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
