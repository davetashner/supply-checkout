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
 * The workload account vault's governance-mode lock: a recovery point can't be
 * deleted before the minimum, and no rule may keep one longer than the
 * maximum. Governance mode can be changed later by an administrator.
 */
export const WORKLOAD_LOCK = { minRetention: Duration.days(7), maxRetention: Duration.days(365) } as const;

/**
 * The backup account vault's compliance-mode lock.
 *
 * FIXED FOREVER: once COMPLIANCE_GRACE_DAYS (72 hours) pass after the vault
 * stack's first deploy, AWS refuses any change to these on that vault, even
 * from the root user, and a stack update that changes them will fail. Get them
 * right before the first deploy. The maximum keeps a mistaken rule from
 * pinning storage for years; the minimum means every copy survives at least
 * a month whatever happens to either account.
 */
export const COPY_LOCK = { minRetention: Duration.days(30), maxRetention: Duration.days(365) } as const;

/**
 * The backup account's vault lock becomes compliance mode, immutable even to
 * that account's root user, this many days after it's created. Until then it
 * can be changed or removed, to fix a mistake in the first deploy. AWS
 * requires at least 3.
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
    /** Input, set by the owner: the AWS Organization ID (o-...), so copies only go to a vault in the organization. */
    organizationId: `${prefix}/organization-id`,
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
