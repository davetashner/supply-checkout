// Backup settings shared by the workload account's backup stack
// (stacks/backup-stack.ts), the backup account's vault stack
// (stacks/backup-account-stack.ts) and the tests. docs/backups.md explains
// the design and the restore drill.
import { Duration } from "aws-cdk-lib";
import { tableName } from "../../backend/src/data/schema.js";

/** How long each daily backup stays in the workload account's vault (PITR also covers 35 days). */
export const LOCAL_RETENTION = Duration.days(35);
/** How long each copy stays in the backup account's vault. */
export const COPY_RETENTION = Duration.days(90);

/**
 * Vault lock limits, the same in both vaults. A recovery point can't be
 * deleted before MIN_LOCK_RETENTION, and no rule may keep one longer than
 * MAX_LOCK_RETENTION (so a mistaken rule can't pin storage for years under a
 * compliance-mode lock).
 */
export const MIN_LOCK_RETENTION = Duration.days(7);
export const MAX_LOCK_RETENTION = Duration.days(365);

/**
 * The backup account's vault lock becomes compliance mode, immutable even to
 * that account's root user, this many days after it's created. Until then it
 * can be changed or removed, to fix a mistake in the first deploy.
 */
export const COMPLIANCE_GRACE_DAYS = 3;

/** The workload account's vault, in each account that runs the app. */
export function backupVaultName(envName: string): string {
  return `supply-checkout-${envName}-backups`;
}

/** The backup account's vault that holds an environment's copies. */
export function copyVaultName(envName: string): string {
  return `supply-checkout-${envName}-backup-copies`;
}

/**
 * Restore jobs may only create tables with this prefix, so a restore can
 * never write into the live table (DynamoDB restores always create a new
 * table; this makes the name obvious too).
 */
export function restoreTablePrefix(envName: string): string {
  return `${tableName(envName)}-restore-`;
}

/** SSM parameters the backup stack reads and publishes, under /supply-checkout/<env>/backup/. */
export function backupParameters(envName: string) {
  const prefix = `/supply-checkout/${envName}/backup`;
  return {
    /** Input, set by the owner: the backup account vault's ARN (the vault stack's CopyVaultArn output). */
    copyVaultArn: `${prefix}/copy-vault-arn`,
    /** Outputs. */
    vaultArn: `${prefix}/vault-arn`,
    restoreRoleArn: `${prefix}/restore-role-arn`,
  };
}

interface ContextReader {
  tryGetContext(key: string): unknown;
}

/**
 * `-c backupCopy=false` leaves out the copy to the backup account, for an
 * environment that has no vault there (a dev account). Default on: a deploy
 * then needs the copy-vault-arn parameter, so prod can't lose its copies by
 * forgetting a flag.
 */
export function backupCopyFromContext(node: ContextReader): boolean {
  const value = node.tryGetContext("backupCopy");
  if (value === undefined || value === "" || value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`backupCopy must be true or false (got "${String(value)}")`);
}
