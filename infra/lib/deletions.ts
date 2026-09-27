// Writing deletion records (backend/src/deletions, supply-checkout-0ic7). The
// bucket is in the primary region's data stack (stacks/data-stack.ts); the
// writers are the account function (a deleted account, in every region) and
// the team purge (a purged team, primary region only). The bucket is
// replicated to the backup account (supply-checkout-72d.10,
// replicateDeletionRecords below and stacks/backup-account-stack.ts).

import { Aws, Fn, Stack, Validations } from "aws-cdk-lib";
import { PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import type { Bucket, CfnBucket } from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { DELETION_PREFIXES, DELETIONS_ENV, deletionsBucketName, deletionsReplicaBucketName } from "../../backend/src/deletions/names.js";
import type { DeploymentConfig } from "./config.js";

/**
 * The role S3 replication uses in each workload account. Fixed, so the backup
 * account's replica bucket policy can name it without knowing anything else
 * about the workload account.
 */
export function deletionsReplicationRoleName(envName: string): string {
  return `supply-checkout-${envName}-deletions-replication`;
}

/** The replication rule's ID, which the replication metrics carry as their RuleId dimension. */
export const DELETIONS_REPLICATION_RULE_ID = "deletion-records-to-backup-account";

/**
 * A record still waiting to replicate this long alarms ("Deletion records
 * replication stuck", backup stack). One replicates in seconds to minutes; a
 * record can stay pending without S3 counting it failed.
 */
export const DELETIONS_REPLICATION_STUCK_MINUTES = 60;

/**
 * The backup account's ID, from the copy vault's ARN
 * (arn:<partition>:backup:<region>:<account>:backup-vault:<name>), the SSM
 * parameter the owner sets for the backup copies (backup.ts, backupParameters).
 * One parameter says where the backup account is, for both.
 */
export function backupAccountFromCopyVaultArn(copyVaultArn: string): string {
  return Fn.select(4, Fn.split(":", copyVaultArn));
}

export interface DeletionsReplicationProps {
  readonly envName: string;
  /** The primary region, where both buckets are. */
  readonly region: string;
  /** The backup account's ID (a deploy-time token). */
  readonly backupAccount: string;
  /** The AWS Organization ID (a deploy-time token): the role may only replicate into a bucket inside it. */
  readonly organizationId: string;
}

/**
 * Replicates every new deletion record to the backup account's replica bucket
 * (deletionsReplicaBucketName, in the backup account and the same region),
 * where it is kept under its own compliance-mode lock. If the workload account
 * is lost, the records survive with the backup copies.
 *
 * - The role, trusted by S3 only for this bucket in this account, may read
 *   object versions (with their retention and legal hold, which the replica
 *   keeps) from this bucket only, and write replicas into that one bucket only,
 *   and only if it is in the organization. No ReplicateDelete, and delete
 *   markers aren't replicated: nothing done here can remove a replica.
 * - The replicas are owned by the backup account (AccessControlTranslation).
 * - Replication metrics are on, so a failed replication alarms (backup stack).
 * - Only objects written after this is deployed replicate; docs/backups.md
 *   says how to copy any earlier ones.
 */
export function replicateDeletionRecords(scope: Construct, bucket: Bucket, props: DeletionsReplicationProps): Role {
  // ARNs from the names, not the bucket's attributes: the bucket's replication
  // configuration needs the role, and the role's policy must exist first
  const sourceName = (account: string) => deletionsBucketName(props.envName, props.region, account);
  const sourceArn = `arn:${Aws.PARTITION}:s3:::${sourceName(Aws.ACCOUNT_ID)}`;
  const replicaName = (account: string) => deletionsReplicaBucketName(props.envName, props.region, account);
  const replicaArn = `arn:${Aws.PARTITION}:s3:::${replicaName(props.backupAccount)}`;
  const role = new Role(scope, "DeletionsReplicationRole", {
    roleName: deletionsReplicationRoleName(props.envName),
    description: "S3 replicates the Supply Checkout deletion records to the backup account",
    // Confused deputy: only S3 acting for this account's deletion records bucket
    assumedBy: new ServicePrincipal("s3.amazonaws.com", {
      conditions: { StringEquals: { "aws:SourceAccount": Aws.ACCOUNT_ID }, ArnLike: { "aws:SourceArn": sourceArn } },
    }),
  });
  role.addToPrincipalPolicy(
    new PolicyStatement({
      sid: "ReadTheReplicationConfiguration",
      actions: ["s3:GetReplicationConfiguration", "s3:ListBucket"],
      resources: [sourceArn],
    }),
  );
  role.addToPrincipalPolicy(
    new PolicyStatement({
      sid: "ReadRecordVersions",
      actions: ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectRetention", "s3:GetObjectLegalHold"],
      resources: [`${sourceArn}/*`],
    }),
  );
  const inOrg = { StringEquals: { "aws:ResourceAccount": props.backupAccount, "aws:ResourceOrgID": props.organizationId } };
  role.addToPrincipalPolicy(
    new PolicyStatement({
      sid: "WriteReplicasToTheBackupAccount",
      actions: ["s3:ReplicateObject", "s3:ObjectOwnerOverrideToBucketOwner"],
      resources: [`${replicaArn}/*`],
      conditions: inOrg,
    }),
  );
  role.addToPrincipalPolicy(
    new PolicyStatement({
      sid: "CheckTheReplicaBucket",
      actions: ["s3:GetBucketVersioning", "s3:GetBucketObjectLockConfiguration"],
      resources: [replicaArn],
      conditions: inOrg,
    }),
  );
  const policy = role.node.findChild("DefaultPolicy");
  // cdk-nag writes a token other than a pseudo parameter as its CloudFormation JSON
  const backupAccountInFinding = JSON.stringify(Stack.of(scope).resolve(props.backupAccount));
  Validations.of(policy).acknowledge({
    id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${sourceName("<AWS::AccountId>")}/*]`,
    reason: "Replication reads each new record's version, named at run time, in this one bucket; nothing in any other bucket.",
  });
  Validations.of(policy).acknowledge({
    id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${replicaName(backupAccountInFinding)}/*]`,
    reason:
      "Replication writes each record's replica, named at run time, into the one replica bucket in the backup account, if it's in " +
      "the organization; no delete, and no other bucket.",
  });

  const cfn = bucket.node.defaultChild as CfnBucket;
  cfn.node.addDependency(policy);
  cfn.replicationConfiguration = {
    role: role.roleArn,
    rules: [
      {
        id: DELETIONS_REPLICATION_RULE_ID,
        priority: 1,
        status: "Enabled",
        filter: { prefix: "" },
        deleteMarkerReplication: { status: "Disabled" },
        destination: {
          bucket: replicaArn,
          account: props.backupAccount,
          accessControlTranslation: { owner: "Destination" },
          metrics: { status: "Enabled" },
        },
      },
    ],
  };
  return role;
}

/**
 * Lets `fn` write one kind of deletion record: s3:PutObject under that kind's
 * prefix only. No reads, lists, deletes, retention or legal-hold changes, and
 * no other prefix, so the account function can't write a team's record or the
 * purge a user's. Only with If-None-Match, so no record can be overwritten. The object key names the ID, which only the function's own
 * checks choose (the caller's token `sub`, or a team the closed-teams index
 * lists), so IAM can't narrow it further than the prefix.
 */
export function grantPutDeletionRecords(fn: LambdaFunction, config: Pick<DeploymentConfig, "envName" | "primaryRegion">, kind: keyof typeof DELETION_PREFIXES): void {
  const bucket = deletionsBucketName(config.envName, config.primaryRegion, Aws.ACCOUNT_ID);
  fn.addToRolePolicy(
    new PolicyStatement({
      sid: kind === "user" ? "PutAccountDeletionRecords" : "PutTeamDeletionRecords",
      actions: ["s3:PutObject"],
      resources: [`arn:${Aws.PARTITION}:s3:::${bucket}/${DELETION_PREFIXES[kind]}*`],
      // Only a conditional write (If-None-Match: *, as records.ts sends it): a record,
      // once written, can't get a newer version on top of it
      conditions: { Null: { "s3:if-none-match": "false" } },
    }),
  );
  Validations.of(fn.role as Role).acknowledge({
    id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${deletionsBucketName(config.envName, config.primaryRegion, "<AWS::AccountId>")}/${DELETION_PREFIXES[kind]}*]`,
    reason: `Each deleted ${kind === "user" ? "account" : "team"} gets its own object, named by its ID, which the function chooses at run time; the grant is PutObject under ${DELETION_PREFIXES[kind]} only`,
  });
  fn.addEnvironment(DELETIONS_ENV.bucket, bucket);
  fn.addEnvironment(DELETIONS_ENV.region, config.primaryRegion);
}
