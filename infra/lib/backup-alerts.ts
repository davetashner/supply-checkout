// Alerts on changes that could stop backups or copies, or make them
// unusable, in both the workload account (stacks/backup-stack.ts) and the
// backup account (stacks/backup-account-stack.ts). docs/backups.md, "When
// backups are tampered with", explains what to do.
import { Aws } from "aws-cdk-lib";
import { EventField, Rule, RuleTargetInput } from "aws-cdk-lib/aws-events";
import type { ITopic } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

/**
 * AWS Backup calls that weaken the backups: a vault's access policy or lock
 * changed or removed, the vault deleted, the plan changed (a copy rule can be
 * dropped that way) or deleted, a selection deleted, or the region's
 * resource opt-in changed (turning DynamoDB off stops the backups).
 */
export const BACKUP_CHANGE_EVENTS = [
  "PutBackupVaultAccessPolicy",
  "DeleteBackupVaultAccessPolicy",
  "PutBackupVaultLockConfiguration",
  "DeleteBackupVaultLockConfiguration",
  "DeleteBackupVault",
  "UpdateBackupPlan",
  "DeleteBackupPlan",
  "DeleteBackupSelection",
  "UpdateRegionSettings",
] as const;

/** KMS calls on a vault's key that make its recovery points unreadable or hand the key to someone else. */
export const BACKUP_KEY_EVENTS = ["ScheduleKeyDeletion", "DisableKey", "PutKeyPolicy"] as const;

/**
 * S3 calls on the backup account's deletion records copy that could stop
 * replication into it or weaken what it keeps: its bucket policy (who may
 * replicate), ownership controls (who owns the replicas), Object Lock
 * configuration (the default retention), versioning (which replication and
 * Object Lock need), lifecycle (expiry) and public access. CloudTrail names the IAM actions' API calls:
 * PutObjectLockConfiguration is the s3:PutBucketObjectLockConfiguration action.
 */
export const DELETIONS_COPY_CHANGE_EVENTS = [
  "PutBucketLifecycle",
  "DeleteBucketLifecycle",
  "PutBucketPublicAccessBlock",
  "DeleteBucketPublicAccessBlock",
  "PutBucketPolicy",
  "DeleteBucketPolicy",
  "PutBucketOwnershipControls",
  "DeleteBucketOwnershipControls",
  "PutObjectLockConfiguration",
  "PutBucketVersioning",
] as const;

/**
 * The backup account's rule on DELETIONS_COPY_CHANGE_EVENTS; fixed so the
 * alerts topic's policy can name it.
 */
export function deletionsCopyAlertRuleName(envName: string): string {
  return `supply-checkout-${envName}-backup-vault-deletions-copy-changes`;
}

/** Where the rules are, which names them. */
export type BackupAlertSide = "workload" | "backup-account";

/**
 * The rules' names, fixed so the workload account's P1 topic (observability
 * stack, deployed first) can let only these two rules publish to it.
 */
export function backupAlertRuleNames(envName: string, side: BackupAlertSide): { changes: string; keyChanges: string } {
  const prefix = side === "workload" ? `supply-checkout-${envName}-backup` : `supply-checkout-${envName}-backup-vault`;
  return { changes: `${prefix}-changes`, keyChanges: `${prefix}-key-changes` };
}

/** The ARNs of those rules in this stack's account and region. */
export function backupAlertRuleArns(envName: string, side: BackupAlertSide): string[] {
  const names = backupAlertRuleNames(envName, side);
  return [names.changes, names.keyChanges].map((name) => `arn:${Aws.PARTITION}:events:${Aws.REGION}:${Aws.ACCOUNT_ID}:rule/${name}`);
}

export interface BackupChangeAlertsProps {
  readonly envName: string;
  readonly side: BackupAlertSide;
  /** The vault key whose deletion, disabling or policy change alerts. */
  readonly vaultKeyArn: string;
  /** The topic told. Its policy must let these rules publish (backupAlertRuleArns). */
  readonly topic: ITopic;
}

/**
 * Two EventBridge rules on CloudTrail's management events (they reach
 * EventBridge in the region of the call) that send the topic a message naming
 * the CloudTrail event, not the person:
 *
 * - `changes`: BACKUP_CHANGE_EVENTS on any vault or plan in this account and
 *   region. CloudFormation's own calls count too: a stack update that changes
 *   a vault policy or removes the plan is a change worth knowing about, and
 *   the backup stacks change rarely.
 * - `keyChanges`: BACKUP_KEY_EVENTS on the vault's key.
 */
export class BackupChangeAlerts extends Construct {
  readonly rules: Rule[];

  constructor(scope: Construct, id: string, props: BackupChangeAlertsProps) {
    super(scope, id);
    const names = backupAlertRuleNames(props.envName, props.side);
    const base = { detailType: ["AWS API Call via CloudTrail"] };
    const where = props.side === "workload" ? "workload account" : "backup account";
    const changes = new Rule(this, "Changes", {
      ruleName: names.changes,
      description: `Backups (${where}): a vault's access policy or lock, the plan, a selection or the region's settings changed or deleted`,
      eventPattern: {
        ...base,
        source: ["aws.backup"],
        detail: { eventSource: ["backup.amazonaws.com"], eventName: [...BACKUP_CHANGE_EVENTS] },
      },
    });
    const keyChanges = new Rule(this, "KeyChanges", {
      ruleName: names.keyChanges,
      description: `Backups (${where}): the vault key was scheduled for deletion, disabled or given a new policy`,
      eventPattern: {
        ...base,
        source: ["aws.kms"],
        detail: { eventSource: ["kms.amazonaws.com"], eventName: [...BACKUP_KEY_EVENTS], resources: { ARN: [props.vaultKeyArn] } },
      },
    });
    const message = RuleTargetInput.fromText(
      `Supply Checkout ${props.envName} backups, ${where} ${EventField.account}: ${EventField.fromPath("$.detail.eventName")} at ${EventField.fromPath("$.detail.eventTime")} (CloudTrail event ${EventField.fromPath("$.detail.eventID")} says who). Expected only during a deploy of the backup stacks. Otherwise follow "When backups are tampered with" in docs/backups.md.`,
    );
    this.rules = [changes, keyChanges];
    for (const rule of this.rules) {
      // A plain target: events-targets' SnsTopic would add a topic policy for every rule in the account
      rule.addTarget({ bind: () => ({ arn: props.topic.topicArn, input: message }) });
    }
  }
}

export interface DeletionsCopyChangeAlertProps {
  readonly envName: string;
  /** The deletion records copy's bucket name. */
  readonly bucketName: string;
  /** The topic told. Its policy must let deletionsCopyAlertRuleName publish. */
  readonly topic: ITopic;
}

/**
 * An EventBridge rule in the backup account on DELETIONS_COPY_CHANGE_EVENTS
 * for the deletion records copy (supply-checkout-72d.13). They're CloudTrail
 * management events, so no trail is needed. Like the rules above, it matches
 * CloudFormation's own calls: a deploy of the vault stack that changes the
 * bucket alerts. The message names the CloudTrail event, not the person.
 */
export function deletionsCopyChangeAlert(scope: Construct, id: string, props: DeletionsCopyChangeAlertProps): Rule {
  const rule = new Rule(scope, id, {
    ruleName: deletionsCopyAlertRuleName(props.envName),
    description: "Deletion records copy (backup account): its policy, ownership, Object Lock, versioning, lifecycle or public access changed",
    eventPattern: {
      source: ["aws.s3"],
      detailType: ["AWS API Call via CloudTrail"],
      detail: { eventSource: ["s3.amazonaws.com"], eventName: [...DELETIONS_COPY_CHANGE_EVENTS], requestParameters: { bucketName: [props.bucketName] } },
    },
  });
  const message = RuleTargetInput.fromText(
    `Supply Checkout ${props.envName} deletion records copy, backup account ${EventField.account}: ${EventField.fromPath("$.detail.eventName")} at ${EventField.fromPath("$.detail.eventTime")} (CloudTrail event ${EventField.fromPath("$.detail.eventID")} says who). Expected only during a deploy of the backup vault stack. Otherwise follow "When backups are tampered with" in docs/backups.md.`,
  );
  // A plain target, as above
  rule.addTarget({ bind: () => ({ arn: props.topic.topicArn, input: message }) });
  return rule;
}
