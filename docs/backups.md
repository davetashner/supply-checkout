# Backups and restores

How the `app` table and the S3 buckets are protected, how to set up the copy to a separate backup account, what to do when a backup fails, the restore drill (bead `supply-checkout-8x1`), the deletion records, and putting a restored table back into service (beads `supply-checkout-72d.4` and `supply-checkout-0ic7`).

The CDK is in `infra/lib/stacks/backup-stack.ts` (workload account), `infra/lib/stacks/backup-account-stack.ts` (backup account), `infra/lib/backup.ts` (names and retention), `infra/lib/backup-alerts.ts` (the alerts on changes, in both accounts) and `infra/lib/deletions.ts` (the deletion records' grants and their replication to the backup account). The tests in `infra/test/backup.test.ts` check the plan, the retention, the copy rule, both vault locks, the IAM roles, the alerts and the deletion records' replica; `infra/test/web.test.ts` checks the deletion records bucket and its replication.

## What protects what

| Layer | Where | Covers | Kept | Delete protection |
| --- | --- | --- | --- | --- |
| Point-in-time recovery | On the table (data stack) | Any second in the window, to a new table | 35 days | Deletion protection on the table |
| Daily AWS Backup | `supply-checkout-<env>-backups` vault, same account | The table as of 2am Eastern each day | 35 days | Governance-mode vault lock, deny on `DeleteRecoveryPoint` |
| Daily copy | `supply-checkout-<env>-backup-copies` vault, **backup account** | The same backup, in an account the workload account can't touch | 90 days | **Compliance-mode** vault lock (30-day minimum), deny on `DeleteRecoveryPoint` |
| S3 versioning | Web and logs buckets (data stack) | Overwritten or deleted objects | 30 days after replacement | Bucket `RETAIN` policy |
| Deletion records | `supply-checkout-<env>-deletions-<region>-<account>` bucket (data stack) | Which accounts and teams were deleted, by ID, so a restore can delete them again | 400 days | **Compliance-mode** Object Lock on every record |
| Deletion records' copy | `supply-checkout-<env>-deletions-copy-<region>-<backup account>` bucket, **backup account** | The same records, replicated by S3 as they're written, so they survive losing the workload account | 400 days | **Compliance-mode** Object Lock on every replica |

- **Recovery point objectives.** PITR can restore to about 5 minutes before now. If the workload account itself is lost or compromised, the copy in the backup account is up to 24 hours old.
- **Recovery time.** Unknown until the first drill. Record it in the [drill log](#drill-log).
- **Regions.** Everything is in the primary region (us-east-1 in the MVP). A region outage is handled by the second region's replica in phase 2 ([ADR 0010](adr/0010-multi-region-active-active.md)), not by backups. A cross-region copy can be added later as a second copy action.
- **Buckets.** The web bucket holds releases, which CI can rebuild, and the logs bucket holds access logs. Both are versioned, and old versions expire after 30 days. Neither is in AWS Backup: nothing in them would be lost for good if the account were.
- **Audit items.** Operator audit items ([ADR 0015](adr/0015-platform-operator-role.md)) are in the table, so they're in PITR and in both vaults.

### Why governance mode here and compliance mode there

- **Backup account: compliance mode.** This copy is the one that has to survive a stolen administrator session in the workload account, ransomware, or a mistake. Once the lock's grace period ends (`COMPLIANCE_GRACE_DAYS`, 3 days after the vault stack is first deployed), nobody can delete a copy within its first 30 days, shorten its retention, or remove the lock. That includes the backup account's root user and AWS Support. The cost of getting it wrong is bounded: DynamoDB backups of this table are small, and `MaxRetentionDays` (365) stops a mistaken rule from keeping copies for years.
- **The lock's limits are permanent.** After the grace period, the compliance vault's minimum (30 days) and maximum (365 days) can never change. A stack update that changes `COPY_LOCK` in `infra/lib/backup.ts` will fail, and the only way out is a new vault. The workload vault's limits (`WORKLOAD_LOCK`: 7 and 365 days) can still be changed.
- **What the lock doesn't stop.** An administrator of the backup account can still make the copies unusable: by scheduling deletion of the vault's KMS key (after which nothing in the vault can be decrypted), or by changing the vault access policy so no new copies arrive. The lock only protects the recovery points themselves. A service control policy on the backup account that denies `kms:ScheduleKeyDeletion`, `kms:DisableKey` and `kms:PutKeyPolicy` on that key, and `backup:PutBackupVaultAccessPolicy` and `backup:DeleteBackupVaultAccessPolicy` on the vault, closes that gap (a bead is coming for it). Until then, keep administrator access to the backup account to the owner. Each of those calls does [alert](#alerts-on-the-backups), and a key scheduled for deletion waits at least 7 days, time to cancel it.
- **Workload account: governance mode.** It's the fast, local restore path, and it sits in the account an attacker would already be in. Its lock and deny policy stop accidental deletion, and an administrator can still fix a misconfiguration. Compliance mode here would add no protection the copy doesn't already give.
- **Grace period.** For the first 3 days after deploying the vault stack, the lock can still be changed or removed (`aws backup delete-backup-vault-lock-configuration`). Check the first copy lands in that window.

### Which account holds the copies

Any account in the same AWS Organization other than the workload accounts. [ADR 0003](adr/0003-aws-account-structure.md) proposes a `log-archive` account; the ADR review also suggests one audit account for logs and backups at this size. The vault stack works in either. Only one backup account is needed for every environment: each environment gets its own vault there.

## Setting it up

The owner does this once. Agents can't create accounts or deploy. The profile names below are examples: `supply-backup` is whatever profile reaches the backup account.

> **`cdk deploy --all` fails until step 4 is done.** The backup stack and the data stack (for the deletion records' replication) read `/supply-checkout/<env>/backup/copy-vault-arn` and `/supply-checkout/<env>/backup/organization-id` at deploy time, and CloudFormation fails when a parameter doesn't exist. Until the backup account's vault stack is in place, deploy with `-c backupCopy=false` (no copy, no replication, and no parameters needed). The order is: the vault stack in the backup account (step 3), the parameters (step 4), then the data stack and the backup stack (step 5).
>
> **Check the vault stack's settings before its first deploy.** Its lock can't be changed after 72 hours (see [the lock's limits](#why-governance-mode-here-and-compliance-mode-there)).
>
> **Do steps 3 to 6 in one session, and prove a copy lands the same day.** The 72-hour clock starts when the vault stack deploys. The copy path's `kms:ViaService` and `aws:ResourceOrgID` conditions haven't been tested against real AWS, so don't wait for the nightly plan to find out whether copies work.

1. **Allow cross-account backup in the organization.** From the management account, in the primary region:

   ```bash
   aws backup update-global-settings --global-settings isCrossAccountBackupEnabled=true --profile supply-mgmt --region us-east-1
   ```

2. **Turn on DynamoDB's advanced backup features in the workload account.** Without them, AWS Backup can't copy DynamoDB backups to another account, and the backup is encrypted with the table's key rather than the vault's.

   ```bash
   aws backup update-region-settings --profile supply-prod --region us-east-1 \
     --resource-type-opt-in-preference DynamoDB=true \
     --resource-type-management-preference DynamoDB=true
   ```

3. **Deploy the vault stack in the backup account.** First, give it somewhere to send its alerts: the same email parameter the observability stack reads, created in the backup account (`String`, never committed). `-c alarmContacts='{"email":2}'` on the deploy subscribes `email-1` and `email-2`.

   ```bash
   aws ssm put-parameter --profile supply-backup --region us-east-1 --type String \
     --name /supply-checkout/prod/alarms/email-1 --value '<address>'
   ```

   Bootstrap CDK there once, then deploy with the workload account IDs as a parameter. Account IDs are never committed: they're CloudFormation parameters, given on the command line.

   ```bash
   cd infra
   npx cdk bootstrap --profile supply-backup --app "npx tsx bin/backup-account.ts"
   npm run deploy:backup-account -- --profile supply-backup \
     --parameters SourceAccountIds=<prod account ID> --parameters OrganizationId=<o-...>
   ```

   The stack is `supply-checkout-<env>-<region>-backup-vault`, and `-c envName=staging` deploys staging's vault. It also creates the deletion records' copy, `supply-checkout-<env>-deletions-copy-<region>-<backup account>` (the `DeletionsReplicaBucket` output), and a bucket for its access logs. **The copy's Object Lock is in compliance mode from the start:** every record replicated into it stays 400 days, with no grace period, so there's nothing to undo in it. The bucket policy lets only the role `supply-checkout-<env>-deletions-replication` in a `SourceAccountIds` account in the organization replicate into it. Confirm the subscription from the email AWS sends. The `copies-missing` alarm fires until the first copy lands (step 6), which also shows its email arrives. The `CopyVaultArn` output is the vault's ARN. `RestoreAccountIds` (default empty) lists the accounts a copy may be sent to for a restore; leave it empty until a drill or a real restore needs it. CloudFormation rejects anything but 12-digit account IDs and an `o-` organization ID. Every account must also be in the organization: the vault and key policies check `aws:PrincipalOrgID`.

4. **Tell the workload account where the copies go.** In the workload account, in the primary region. The organization ID lets the backup role copy only to a vault inside the organization (`aws:ResourceOrgID`), even if the vault ARN is wrong.

   ```bash
   aws ssm put-parameter --profile supply-prod --region us-east-1 --type String \
     --name /supply-checkout/prod/backup/copy-vault-arn --value <CopyVaultArn output>
   aws ssm put-parameter --profile supply-prod --region us-east-1 --type String \
     --name /supply-checkout/prod/backup/organization-id --value <o-...>
   ```

5. **Deploy the data stack, then the backup stack** (`supply-checkout-<env>-<region>-data` and `-backup`). The data stack turns on replication of the deletion records into the backup account's copy, which has to exist first (step 3). The backup stack deploys after the data and observability stacks, and `cdk deploy --all` includes both:

   ```bash
   npx cdk deploy supply-checkout-prod-us-east-1-data supply-checkout-prod-us-east-1-backup --profile supply-prod
   ```

   An environment with no vault in the backup account (a dev account) deploys with `-c backupCopy=false`. It still gets the local vault and the daily backup, with no copy, and its deletion records aren't replicated.

6. **Prove the copy path now, with an on-demand backup and copy.** Use the backup role, the same one the plan uses, so this tests the same permissions:

   ```bash
   P="--profile supply-prod --region us-east-1"
   TABLE_ARN=$(aws dynamodb describe-table --table-name supply-checkout-prod-app --query Table.TableArn --output text $P)
   ROLE_ARN=$(aws iam get-role --role-name supply-checkout-prod-backup --query Role.Arn --output text --profile supply-prod)
   COPY_VAULT=$(aws ssm get-parameter --name /supply-checkout/prod/backup/copy-vault-arn --query Parameter.Value --output text $P)

   aws backup start-backup-job $P --backup-vault-name supply-checkout-prod-backups \
     --resource-arn "$TABLE_ARN" --iam-role-arn "$ROLE_ARN" --lifecycle DeleteAfterDays=35
   aws backup describe-backup-job $P --backup-job-id <id>   # until COMPLETED; note RecoveryPointArn

   aws backup start-copy-job $P --recovery-point-arn <RecoveryPointArn> \
     --source-backup-vault-name supply-checkout-prod-backups \
     --destination-backup-vault-arn "$COPY_VAULT" --iam-role-arn "$ROLE_ARN" \
     --lifecycle DeleteAfterDays=90
   aws backup describe-copy-job $P --copy-job-id <id>       # until COMPLETED

   aws backup list-recovery-points-by-backup-vault --backup-vault-name supply-checkout-prod-backup-copies \
     --profile supply-backup --region us-east-1               # the copy is here
   ```

   A copy retention of 90 days must be inside the vault lock's 30 to 365. If a job fails, `StatusMessage` and CloudTrail show which call was refused. See [Key sharing](#key-sharing-and-what-the-first-drill-should-confirm) for the conditions to loosen first.

   Then check the deletion records replicate ([Deletion records' copy](#deletion-records-copy-in-the-backup-account)): copy any records written before replication was turned on, and check the next record lands in the copy.

7. **If no copy has landed about 48 hours after the vault stack deployed, decide before the 72 hours are up.** After 72 hours the lock is permanent, whether or not a copy has ever worked.
   - **Remove the lock and try again later.** In the backup account:

     ```bash
     aws backup delete-backup-vault-lock-configuration --backup-vault-name supply-checkout-prod-backup-copies \
       --profile supply-backup --region us-east-1
     ```

     Once copies work, put it back. CloudFormation may not re-apply it, because the template hasn't changed. If `aws backup describe-backup-vault` shows no lock after a redeploy, set the same values as `COPY_LOCK` by hand. That starts a new 72-hour grace period:

     ```bash
     aws backup put-backup-vault-lock-configuration --backup-vault-name supply-checkout-prod-backup-copies \
       --min-retention-days 30 --max-retention-days 365 --changeable-for-days 3 --profile supply-backup --region us-east-1
     ```

   - **Or accept 30 and 365 days as final** and keep fixing the copy path. Only the lock's limits are permanent. Key policies, the vault access policy and the roles can still change.

8. **Check the next morning.** The plan runs at 2am Eastern. Both jobs should be `COMPLETED`:

   ```bash
   aws backup list-backup-jobs --by-backup-vault-name supply-checkout-prod-backups --profile supply-prod --region us-east-1
   aws backup list-copy-jobs --profile supply-prod --region us-east-1
   aws backup list-recovery-points-by-backup-vault --backup-vault-name supply-checkout-prod-backup-copies --profile supply-backup --region us-east-1
   ```

   The `no-recent-backup` alarm can fire before the first backup completes. It clears once one does.

9. **Check the alerts once.** In the backup account, `aws cloudwatch list-metrics --namespace AWS/Backup --metric-name NumberOfRecoveryPointsCompleted --profile supply-backup --region us-east-1` should list the copy vault, and `supply-checkout-prod-backup-copies-missing` should be `OK` (`aws cloudwatch describe-alarms --alarm-names ...`). If the metric isn't there, or has other dimensions than `BackupVaultName` (alone or with `ResourceType`), the alarm stays in `ALARM`: change its metrics in `backup-account-stack.ts` to match. Then check a change rule fires, in each account: re-applying a vault's access policy unchanged is harmless (`aws backup get-backup-vault-access-policy`, then `put-backup-vault-access-policy` with the same policy) and should send a `PutBackupVaultAccessPolicy` message, to P1 in the workload account and to the backup alerts topic in the backup account. If nothing arrives, look at that CloudTrail event and the rule's pattern.

## Roles

| Role | Account | Can |
| --- | --- | --- |
| `supply-checkout-<env>-backup` | Workload | Back up the `app` table, manage its backups, use the table key and vault key, copy from this account's recovery points, and copy into the one vault named by `copy-vault-arn`, if it's in the organization. No AWS managed policy. |
| `supply-checkout-<env>-restore` | Workload | Restore into, and write items to, tables named `supply-checkout-<env>-app-restore-*` only. It can't touch the live table. Its ARN is in `/supply-checkout/<env>/backup/restore-role-arn`. |
| `supply-checkout-<env>-backup-copy-out` | Backup | Copy a recovery point out of this vault into a `supply-checkout-*` vault in one of the `RestoreAccountIds` accounts, if it's in the organization. |
| `supply-checkout-<env>-deletions-replication` | Workload | Assumed only by S3, for this account's deletion records bucket (`aws:SourceAccount`, `aws:SourceArn`). Read that bucket's replication configuration and its records' versions, retention and legal hold, and write replicas (`s3:ReplicateObject`, `s3:ObjectOwnerOverrideToBucketOwner`) into the one copy bucket named from the backup account, if it's in the organization (`aws:ResourceAccount`, `aws:ResourceOrgID`). No `ReplicateDelete`, no tags, nothing else in either account. |

The role trust policies trust `backup.amazonaws.com` with no `aws:SourceAccount` condition. AWS Backup's confused-deputy guidance only covers resource policies (KMS keys, SNS topics), not role trust, and doesn't say AWS Backup sets that key when it assumes a role. A condition it doesn't set would break every job.

### Key sharing, and what the first drill should confirm

The workload vault key lets the backup account use `kms:Decrypt`, `kms:DescribeKey`, `kms:GenerateDataKey` and `kms:CreateGrant` (for AWS resources only), and only through AWS Backup in the primary region (`kms:ViaService`). That's the minimum AWS documents for a vault key. There's no `kms:Encrypt` or `ReEncrypt`: a copy only reads the source, and AWS Backup re-encrypts it with the destination vault's key. The backup vault's key gives the restore accounts the same actions.

The permissions haven't been checked against a real job yet. In the first copy and the drill, look for `AccessDenied` from KMS in CloudTrail. If the `kms:ViaService` condition or the missing `kms:Encrypt` is the cause, change the key policy (key policies, unlike the compliance lock, can be changed any time) and record it here.

Whoever starts a restore or copy job needs `iam:PassRole` on the role, and their own permission to call AWS Backup.

## Alerts on the backups

A compromised workload administrator can delete the plan and its alarms in the same account, so the backup account watches too.

| Where | Alert | Fires when | Goes to |
| --- | --- | --- | --- |
| Workload | `supply-checkout-<env>-p2-backup-failed` | A backup or copy job failed, aborted or expired in the last hour | P2 topic |
| Workload | `supply-checkout-<env>-p2-no-recent-backup` | No backup completed in 24 hours | P2 topic |
| Workload | `supply-checkout-<env>-p2-deletions-replication-failed` | S3 failed to replicate a deletion record to the backup account's copy in the last hour (not with `-c backupCopy=false`) | P2 topic |
| Workload | Rule `supply-checkout-<env>-backup-changes` | A vault's access policy or lock was put or deleted, a vault deleted, the plan updated or deleted, a selection deleted, or the region's opt-in settings changed (`BACKUP_CHANGE_EVENTS`) | P1 topic |
| Workload | Rule `supply-checkout-<env>-backup-key-changes` | The vault key was scheduled for deletion, disabled or given a new key policy (`BACKUP_KEY_EVENTS`) | P1 topic |
| Backup | `supply-checkout-<env>-backup-copies-missing` | No copy completed in the copy vault for 36 hours (three 12-hour periods; no data counts as none) | `supply-checkout-<env>-backup-alerts` |
| Backup | Rules `supply-checkout-<env>-backup-vault-changes` and `-backup-vault-key-changes` | The same calls, in the backup account, on its vaults and its vault key | `supply-checkout-<env>-backup-alerts` |

- The rules read CloudTrail's management events, which reach EventBridge in the region of the call, and send a message naming the event, its time and its CloudTrail event ID, never who made it. Look that up in CloudTrail.
- The change rules match CloudFormation's own calls too: a deploy of a backup stack that changes a vault policy or the plan alerts. That's rare and worth knowing about.
- The workload rules alert on any vault, plan or selection in the account and region, not only Supply Checkout's; there are no others.
- The copies-missing alarm is what notices a workload account whose plan, copy rule or alarms were deleted: nothing in the workload account can stop it.
- The backup account's topic is encrypted with its own key and lets only that account's alarms and its two rules publish. Its recipients are the `/supply-checkout/<env>/alarms/email-<n>` parameters in the backup account ([step 3](#setting-it-up)).

### When copies stop arriving

1. In the workload account, check the backup alarms and the jobs (`aws backup list-copy-jobs`, [When a backup fails](#when-a-backup-fails)). A failed copy job says why.
2. If there's no copy job at all, check the plan still exists and still has its copy rule (`aws backup list-backup-plans`, `get-backup-plan`), and look in CloudTrail for `DeleteBackupPlan`, `UpdateBackupPlan` or `DeleteBackupSelection`. If someone removed them, treat it as the workload account being compromised: follow the incident response process, and keep the backup account's copies (which nobody can delete within 30 days) out of reach of the workload account.
3. If copy jobs completed but no copy is in the vault, check the vault access policy in the backup account (`get-backup-vault-access-policy`) and CloudTrail there for `PutBackupVaultAccessPolicy`.
4. Redeploying the backup stack puts the plan and selection back. Then start an on-demand backup and copy ([step 6](#setting-it-up)) and watch the alarm go back to `OK`.

### When deletion records stop replicating

`supply-checkout-<env>-p2-deletions-replication-failed` fired: S3 couldn't write a record into the backup account's copy. The record itself is safe in the workload bucket; only the copy is behind.

1. Find the record: `aws s3api list-object-versions --bucket supply-checkout-prod-deletions-us-east-1-<prod account> --profile supply-prod --region us-east-1`, then `head-object` on the newest ones. `ReplicationStatus: FAILED` marks the ones that didn't go.
2. The usual causes: the copy bucket's policy changed, `SourceAccountIds` or `OrganizationId` on the vault stack no longer include this account, the copy bucket isn't there (the vault stack not yet deployed in that region), or `copy-vault-arn` names another account. CloudTrail in the backup account shows the refused `PutObject` (replication writes appear as it).
3. After the fix, re-replicate the failed records with S3 Batch Replication ([Deletion records' copy](#deletion-records-copy-in-the-backup-account), with `ReplicationStatus` `FAILED` in the manifest filter).

### When backups are tampered with

A change rule fired. If it matches a deploy someone just ran of a backup stack, it's expected. Otherwise:

1. Find the event: in CloudTrail, in the account and region named in the message, look up the event ID. It shows who made the call, from where, and what it changed.
2. **Key scheduled for deletion or disabled:** cancel it now (`aws kms cancel-key-deletion`, then `enable-key`). A key waits at least 7 days before it's deleted; after that, nothing it encrypted can be read.
3. **Vault access policy or lock changed or deleted:** compare with the template (redeploy the stack to put it back). A compliance-mode lock can't be removed after its grace period, so a `DeleteBackupVaultLockConfiguration` that succeeded means it was still in the grace period.
4. **Plan or selection deleted or changed:** redeploy the backup stack, and see [When copies stop arriving](#when-copies-stop-arriving).
5. If nobody expected it, treat the account as compromised: revoke the principal's sessions and credentials, and review what else it did in CloudTrail.

## When a backup fails

The backup stack has two P2 alarms on the observability stack's P2 topic:

- `supply-checkout-<env>-p2-backup-failed`: a backup or copy job for a DynamoDB resource failed, was aborted or expired in the last hour.
- `supply-checkout-<env>-p2-no-recent-backup`: no DynamoDB backup completed in the last 24 hours.

1. Find the job and its message: `aws backup list-backup-jobs --by-state FAILED` and `aws backup list-copy-jobs --by-state FAILED` (add `--profile` and `--region`). `describe-backup-job` or `describe-copy-job` gives the `StatusMessage`.
2. `AccessDenied` on a KMS or `backup:` call usually means a setup step is missing: the organization setting (step 1), DynamoDB advanced features (step 2), or a stale `copy-vault-arn` or `organization-id`. CloudTrail shows which call was refused and by whom.
3. A copy job refused by the destination vault usually means its lock rejected the retention: the copy's 90 days must be between the lock's 30 and 365.
4. PITR is unaffected by all of this. While backups are broken, the table can still be restored to any point in the last 35 days.
5. After a fix, start an on-demand backup to check it: `aws backup start-backup-job --backup-vault-name supply-checkout-prod-backups --resource-arn <table ARN> --iam-role-arn <backup role ARN> --lifecycle DeleteAfterDays=35`.

## Restore drill

Run it after setup, then every quarter and after any change to the backup stacks. **It hasn't been run yet**: the first run is the owner's, and closes `supply-checkout-8x1`.

A restore always creates a new table. The live table is never overwritten, and the restore role can only create tables named `supply-checkout-<env>-app-restore-*`. Putting a restored table back into service is [its own procedure](#put-a-restored-table-back-into-service).

**Where.** Restore into **staging**, in a new table. Until staging exists, restore into the prod account instead (same steps, `<target env>` is `prod`). A restore into staging puts customer data in the staging account: keep access to the people running the drill, and delete the table the same day.

Use the date for `<yyyymmdd>`, and write every time down as you go. The [drill log](#drill-log) needs them.

### A. Point-in-time recovery (workload account, 10 minutes)

```bash
KEY=$(aws ssm get-parameter --name /supply-checkout/prod/data/table-key-arn --query Parameter.Value --output text --profile supply-prod)
date -u +%FT%TZ   # start
aws dynamodb restore-table-to-point-in-time --profile supply-prod --region us-east-1 \
  --source-table-name supply-checkout-prod-app \
  --target-table-name supply-checkout-prod-app-restore-pitr-<yyyymmdd> \
  --use-latest-restorable-time \
  --sse-specification-override Enabled=true,SSEType=KMS,KMSMasterKeyId=$KEY
aws dynamodb wait table-exists --table-name supply-checkout-prod-app-restore-pitr-<yyyymmdd> --profile supply-prod --region us-east-1
date -u +%FT%TZ   # restored
```

Then [verify](#verify-the-restored-table) and [clean up](#clean-up).

### B. From the backup account (the one that matters)

This is the path after losing the workload account: copy a recovery point out of the backup account, then restore it.

1. **Let the target account receive the copy.** Redeploy the vault stack with the target account in `RestoreAccountIds`, keeping `SourceAccountIds`:

   ```bash
   npm run deploy:backup-account -- --profile supply-backup --parameters SourceAccountIds=<prod account ID> \
     --parameters OrganizationId=<o-...> --parameters RestoreAccountIds=<target account ID>
   ```

   The target account's backup stack must be deployed, with its `copy-vault-arn` pointing at a vault in this backup account. That is how its vault learns to accept copies from here.

2. **Pick the newest copy** and note its creation time:

   ```bash
   aws backup list-recovery-points-by-backup-vault --profile supply-backup --region us-east-1 \
     --backup-vault-name supply-checkout-prod-backup-copies \
     --query 'reverse(sort_by(RecoveryPoints,&CreationDate))[0].[RecoveryPointArn,CreationDate]'
   ```

3. **Copy it to the target account's vault.** The retention must be at least that vault's 7-day lock minimum (the workload vault's governance lock), and the copy can't be deleted before then.

   ```bash
   date -u +%FT%TZ   # copy started
   aws backup start-copy-job --profile supply-backup --region us-east-1 \
     --recovery-point-arn <recovery point ARN> \
     --source-backup-vault-name supply-checkout-prod-backup-copies \
     --destination-backup-vault-arn <target vault-arn, from /supply-checkout/<target env>/backup/vault-arn> \
     --iam-role-arn <CopyOutRoleArn output> \
     --lifecycle DeleteAfterDays=7
   aws backup describe-copy-job --copy-job-id <id> --profile supply-backup --region us-east-1   # until COMPLETED
   ```

4. **Restore it in the target account.** The copy's ARN is in the target vault (`list-recovery-points-by-backup-vault`). Encrypt the new table with that account's table key:

   ```bash
   aws backup start-restore-job --profile <target profile> --region us-east-1 \
     --recovery-point-arn <recovery point ARN in the target vault> \
     --iam-role-arn <value of /supply-checkout/<target env>/backup/restore-role-arn> \
     --metadata TargetTableName=supply-checkout-<target env>-app-restore-<yyyymmdd>,encryptionType=KMS,kmsMasterKeyArn=<value of /supply-checkout/<target env>/data/table-key-arn>
   aws backup describe-restore-job --restore-job-id <id> --profile <target profile> --region us-east-1   # until COMPLETED
   ```

   `describe-restore-job` gives `CreationDate` and `CompletionDate`. Its difference is the restore time; with the copy job's, it's the time to restore from the backup account.

5. **Take the target account back out.** Redeploy the vault stack with only `SourceAccountIds`. `--no-previous-parameters` puts `RestoreAccountIds` back to its empty default; without it, CDK keeps the last value.

   ```bash
   npm run deploy:backup-account -- --profile supply-backup --no-previous-parameters \
     --parameters SourceAccountIds=<prod account ID> --parameters OrganizationId=<o-...>
   ```

### Verify the restored table

1. **Settings.** `aws dynamodb describe-table --table-name <restored>`: `TableStatus` is `ACTIVE`, both `GSI1` and `GSI2` are there and `ACTIVE`, and `SSEDescription` names the table key. A restore doesn't carry TTL, the stream, PITR, deletion protection or tags; that's expected.
2. **Item counts.** Count both tables. The CLI pages through and adds up `Count`:

   ```bash
   aws dynamodb scan --table-name <restored> --select COUNT --query Count --profile <target profile> --region us-east-1
   aws dynamodb scan --table-name supply-checkout-prod-app --select COUNT --query Count --profile supply-prod --region us-east-1
   ```

   The live table has changed since the recovery point, so the counts won't match exactly. Record both. A difference of more than a day's writes needs explaining.
3. **One team, item for item.** Pick a team with no changes since the recovery point, and compare its partition in both tables:

   ```bash
   aws dynamodb query --table-name <table> --key-condition-expression "PK = :pk" \
     --expression-attribute-values '{":pk":{"S":"TEAM#<teamId>"}}' --select COUNT --query Count
   ```

4. **An index.** Query `GSI1` for the same team on both tables, and compare the counts.

Never paste item contents into the drill log, a bead or a PR. They're customer data.

### Clean up

```bash
aws dynamodb delete-table --table-name <restored> --profile <target profile> --region us-east-1
```

Restored tables have no deletion protection. The drill's copy in the target vault expires by itself after 7 days.

## Deletion records

Deleted data lives on in the backups: up to 35 days in PITR and the workload vault, and 90 days in the backup account's copies. The purge also deletes a team's audit trail, and an account's deletion mark expires after 30 days, so a restored table has nothing that says what was deleted after its recovery point. Without help, a restore would bring deleted accounts and teams back.

So every deletion also writes a record to the deletion records bucket, `supply-checkout-<env>-deletions-<region>-<account>` in the primary region (its name is in `/supply-checkout/<env>/data/deletions-bucket-name`). The code is `backend/src/deletions/`.

| Record | Written by | Holds | When |
| --- | --- | --- | --- |
| `users/<userId>.json` | The account function, deleting an account | The user's `sub`, the time, and the teams the deletion closed (ones the user was alone in) | After the user has left every team, before their `USER#` rows and Cognito user are deleted. If it can't be written, the request fails and the user can try again. |
| `teams/<teamId>.json` | The team purge | The team ID and the time | Before anything of the team is deleted. If it can't be written, the purge leaves the team for the next run (and the Lambda errors alarm sees the failure). |

- **No personal data.** IDs and times only: no emails, names, team names or items. A user's `sub` is a random ID that nothing links to a person once their Cognito user is deleted.
- **Kept for 400 days** (`DELETION_RECORD_RETENTION_DAYS` in `backend/src/deletions/names.ts`), longer than the vault locks' 365-day maximum, so a record outlives every backup that could hold the data. Object Lock in **compliance mode** means nobody, the root user included, can delete a record or shorten its retention: a stolen administrator session can't erase what a restore has to delete again. After 401 days the lifecycle rule expires it.
- **Written once.** A retry finds the record there (`If-None-Match`) and keeps the first.
- **Least privilege.** The account function may only `s3:PutObject` under `users/`, and the team purge only under `teams/`. Neither can read, list or delete a record. Only the owner, with SSO, reads them.
- **Copied to the backup account.** S3 replicates each record, as it's written, to the backup account's copy (below), so a restore into a new account after losing the workload account can still re-apply deletions.

### Deletion records' copy in the backup account

Bead `supply-checkout-72d.10`. The data stack sets up S3 replication on the deletion records bucket (`infra/lib/deletions.ts`); the vault stack in the backup account has the destination (`infra/lib/stacks/backup-account-stack.ts`).

- **Where.** `supply-checkout-<env>-deletions-copy-<region>-<backup account>`, in the backup account and the primary region. The workload account finds the backup account from the account in `/supply-checkout/<env>/backup/copy-vault-arn`, so there's no other parameter to set, and no account ID is in this repository.
- **Locked the same way.** Versioned, Object Lock in compliance mode with the same 400-day default retention, and each replica keeps its source record's retain-until date. Nobody in either account can delete a replica or shorten its retention. After 401 days the lifecycle rule expires it.
- **Owned by the backup account.** The rule translates ownership to the destination (`AccessControlTranslation`), and the bucket has ACLs off (`BucketOwnerEnforced`).
- **Only the replication role writes to it.** Its bucket policy allows `s3:ReplicateObject` and `s3:ObjectOwnerOverrideToBucketOwner` on its objects, and `s3:GetBucketVersioning` and `s3:GetBucketObjectLockConfiguration` on the bucket, only to a role named `supply-checkout-<env>-deletions-replication` in a `SourceAccountIds` account in the organization. Delete markers aren't replicated, and the role has no `ReplicateDelete`.
- **Metrics on.** Replication metrics are on for the rule, which the `p2-deletions-replication-failed` alarm watches.
- **Only new records replicate.** S3 replication copies objects written after it's turned on. Records written before (if the data stack was deployed with `-c backupCopy=false`, or before this change) need a one-off S3 Batch Replication job.
- **Not yet tested against real AWS.** Object Lock replication across accounts with ownership translation hasn't been run yet. The first real record is the test: check it below.

**After step 5 of [Setting it up](#setting-it-up)**, in the workload account:

1. If the bucket already has records, replicate them with a Batch Replication job. S3 generates the manifest from the bucket's replication configuration and can create its own role for the job; use the console (bucket, Management, Replication rules, "Create Batch Operations job" is offered when you save or change the rule), or `aws s3control create-job` with `--operation '{"S3ReplicateObject":{}}'` and a `--manifest-generator` for the bucket with `"EligibleForReplication": true` and `"ObjectReplicationStatuses": ["NONE","FAILED"]`. The job's completion report lists anything that failed.
2. Check the next record written lands: `aws s3api head-object --bucket <deletions bucket> --key <key> --profile supply-prod` shows `ReplicationStatus: COMPLETED`, and in the backup account `aws s3api list-objects-v2 --bucket supply-checkout-prod-deletions-copy-us-east-1-<backup account> --profile supply-backup` lists it, with `get-object-retention` showing `COMPLIANCE` and the same retain-until date. If it says `FAILED`, see [When deletion records stop replicating](#when-deletion-records-stop-replicating); the permissions most likely to need loosening are the role's `aws:ResourceOrgID` condition and the bucket-level reads.

**A new workload account** (after losing the old one) replicates into the same copy once it's in `SourceAccountIds` (redeploy the vault stack with it added) and its data stack is deployed. The copy then holds both accounts' records, which is what a restore wants.

## Put a restored table back into service

A restore gives you a new table, `supply-checkout-<env>-app-restore-<suffix>`. This is how its data goes live.

**The approach: copy back.** The live table stays; only its items change. `npm run restore -- copy-back` makes the live table's items the same as the restored table's: it puts every item that differs and deletes every item the restored table doesn't have. The live table keeps its name, keys, indexes, KMS key, TTL, stream, point-in-time recovery, deletion protection, tags, its place in the data stack, the backup plan that names it, and the live-update function's event source mapping on its stream. None of them need turning back on, because none were turned off.

Why not the other two ways:

- **Rename.** DynamoDB can't rename a table. Restoring under the live name means deleting the live table first (turning off deletion protection, outside CloudFormation), and the data stack would then own a table it didn't create: TTL, the stream, PITR, deletion protection and tags would all have to be set again by hand, the stream would have a new ARN, and the next deploy could fail or replace it. The restore role is also, on purpose, unable to create a table with the live name.
- **Config switch.** Pointing the app at the restored table means changing `tableName()` in `backend/src/data/schema.ts`, which every IAM policy, SSM parameter, alarm, the backup plan and the stream mapping are built from, and redeploying every stack. The restored table still has no TTL, stream, PITR, deletion protection or tags, and no stack owns it.

**When the live table is gone** (a new account after losing the workload account): deploy the stacks first (`cdk deploy --all`, [Setting it up](#setting-it-up) and [infrastructure](infrastructure.md)). That creates an empty live table with every setting, publishes its stream ARN to `/supply-checkout/<env>/data/table-stream-arn`, and the realtime stack, which reads that parameter at deploy time, points the event source mapping at it. Then restore into the new account and copy back as below. If a table's stream is ever turned off and on by hand, it gets a new ARN: redeploy the data stack and then the realtime stack so the mapping follows it.

**What's lost.** Everything written to the live table after the recovery point: sheets, stock changes, new teams, memberships. Accounts created after it still sign in (Cognito isn't restored) but have no teams. Deletions after it are re-applied (step 4), so they stay deleted.

### Expected downtime

The app is down from step 3 (writes stopped) to step 8 (writes back on). The restore itself (step 1) happens before, while the app is still up, unless the incident has taken it down anyway.

| Step | Time |
| --- | --- |
| Stop writes | 5 minutes |
| Re-apply deletions | 1 to 5 minutes (one scan, then a few writes per deleted account or team) |
| Copy back | About 1 minute per 50,000 items it puts or deletes (the dry run's counts), a scan of each table, and batches of 25 writes, one batch at a time. Not measured yet |
| Check and verify | 15 minutes |
| Writes back on | 5 minutes |

For today's table (well under 100,000 items) expect **30 to 45 minutes**. Record the real times in the [drill log](#drill-log), and change this table after the first drill.

### The steps

Run these from `backend/` with the owner's SSO profile. Every command prints the account it's about to use in its first line: check it. `deletions` and `copy-back` are dry runs until given `--apply`.

```bash
aws sso login --profile supply-prod
cd backend && npm ci
P="--region us-east-1 --profile supply-prod"
LIVE=supply-checkout-prod-app
RESTORED=supply-checkout-prod-app-restore-<yyyymmdd>
export SUPPLY_CHECKOUT_EXPECTED_ACCOUNT=<prod account ID>   # in your shell only: the script refuses any other account
```

#### 1. Restore, and verify the restored table

Use [drill A or B](#restore-drill) with the target account the live table is in, then [verify it](#verify-the-restored-table). Pick the recovery point with the incident's time in mind: PITR can go to any second, so choose one just before the bad write.

#### 2. Preview

```bash
npm run restore -- deletions --table $RESTORED $P      # what would be deleted again
npm run restore -- copy-back --from $RESTORED --to $LIVE $P   # how many items would be put and deleted
```

Nothing is written. The copy-back counts tell you how long step 5 will take. A `deletions` line listing teams "left for a person" needs [a decision](#a-team-left-for-a-person) before step 4.

#### 3. Stop writes

Throttle every function that uses the live table to zero, except the live-update function (`supply-checkout-<env>-live-updates`), which only reads the stream and publishes to clients:

```bash
FNS=$(aws lambda list-functions $P --query "Functions[?Environment.Variables.TABLE_NAME=='$LIVE'].FunctionName" --output text \
  | tr '\t' '\n' | grep -v -- '-live-updates$')
echo "$FNS"   # the data, account and ops API functions, the email events handler, the scheduled checks and purge, and the sign-in triggers
for f in $FNS; do aws lambda put-function-concurrency $P --function-name "$f" --reserved-concurrent-executions 0; done
date -u +%FT%TZ   # throttled
```

Throttling stops new invocations, not ones already running. Wait until none are: the longest timeout is the purge's, 5 minutes. Check each function's `ConcurrentExecutions` is 0 for the last minute before going on (`date -u -v-2M` is BSD/macOS syntax; on Linux use `date -u -d '-2 minutes' +%FT%TZ`):

```bash
for f in $FNS; do
  echo "$f $(aws cloudwatch get-metric-statistics $P --namespace AWS/Lambda --metric-name ConcurrentExecutions \
    --dimensions Name=FunctionName,Value=$f --statistics Maximum --period 60 \
    --start-time $(date -u -v-2M +%FT%TZ) --end-time $(date -u +%FT%TZ) --query 'max(Datapoints[].Maximum)')"
done   # every one None or 0; if not, wait a minute and check again
date -u +%FT%TZ   # writes stopped
```

From here the API answers 5xx and sign-in fails: the app is down. The API, Lambda and journey alarms fire, and the canary fails; that's expected. The email events and the scheduled purge are asynchronous: Lambda keeps retrying them for up to 6 hours, so they run once writes are back on.

Note the time: the live table's own PITR can take it back to this moment if the copy goes wrong.

#### 4. Re-apply deletions on the restored table

Now no more deletions can happen, so the records are complete. It runs only on a restored table (`--live` would allow the live table, with a warning; the runbook never needs it):

```bash
npm run restore -- deletions --table $RESTORED $P --apply
npm run restore -- deletions --table $RESTORED $P      # again: purges 0, removes 0
```

For each record it finds in the restored table:

| Found | What it does |
| --- | --- |
| A deleted team, or a team a deleted account's deletion closed | Marks it closed and due, and purges it the way the scheduled purge does: every item, its members' team-switcher rows, its Stripe link |
| A team whose only members are deleted accounts | Purges it too (the account deletion closed it, and the purge followed) |
| A team a deleted account's record says its deletion closed, but that has members who aren't deleted, or that the account isn't in and isn't closed | Nothing: left for a person (the record and the table disagree) |
| A recorded account that outlived its record: still in the environment's user pool | Nothing at all. A deletion that wrote its record and then failed, where the user never retried, leaves one; they're counted, not named. The pool is read from `/supply-checkout/<env>/identity/user-pool-id`, never given on the command line, and it alone decides: an account the pool no longer has is deleted even if it joined or made teams after its record's time (a first deletion that failed, a return, then a real deletion). Only without AWS (`--endpoint`) do the timestamps decide instead |
| A deleted account's membership of any other team | Removes it the way leaving does: the counts move, invites to their address in that team go, and the team's audit trail gets `member.left` with `account_deleted` |
| A deleted account's own `USER#` rows | Deletes them, except the daily limit counters, which expire |
| A deleted account that's the last owner of an open team with other members | Nothing: [left for a person](#a-team-left-for-a-person) |

Pending invites to a deleted account's address from teams it wasn't in can't be found (the record has no address). They expire within 7 days, by TTL.

It exits 1 while a team is left for a person. Records can't be changed or deleted (Object Lock), so this check against the table and the user pool is what keeps a wrong or stale record from deleting someone's data. Every step is idempotent, so a run that stops (a throttle, an expired session) is finished by running it again.

> **Restoring from the backup account into a new account.** The old workload account's records are in the backup account's copy. Read them from there with that account's profile, `--records-profile`; the table, the user pool and `SUPPLY_CHECKOUT_EXPECTED_ACCOUNT` are still the new account's (`--profile`):
>
> ```bash
> aws sso login --profile supply-backup
> npm run restore -- deletions --table $RESTORED $P --records-profile supply-backup          # dry run
> npm run restore -- deletions --table $RESTORED $P --records-profile supply-backup --apply
> ```
>
> The first line names the copy bucket and the backup account. It's `supply-checkout-<env>-deletions-copy-<region>-<backup account>` unless `--bucket` names another (the old account's own bucket, if that account is still reachable, with a profile that can read it). A record written in the old account's last minutes may not have replicated before it was lost (replication usually takes seconds to minutes); nothing can recover those. If the copy is missing altogether (replication was never set up), the deletions since the recovery point can't be re-applied, and every account and team deleted in the last 90 days may come back: tell the owner, and delete them by hand as their owners ask again.

##### A team left for a person

The app never lets an account be deleted while it's the only owner of an open team with other members. So if the restored table has that, the team changed after the recovery point: someone else was made an owner, and that change was lost. Ask the remaining members who should own the team, then make them owner in one transaction (their `MEMBER#<userId>` item's `role` and their `USER#<userId>` / `TEAM#<teamId>` row's `role` set to `owner`, and 1 added to the `META` item's `owners`), and run `deletions` again. The deleted account's own rows are kept until then.

#### 5. Copy back

```bash
date -u +%FT%TZ   # copy started
npm run restore -- copy-back --from $RESTORED --to $LIVE $P --apply
npm run restore -- copy-back --from $RESTORED --to $LIVE $P   # again: put 0, deleted 0
date -u +%FT%TZ   # copy finished
```

Every write goes through the live table's stream, so the live-update function publishes a change for each copied sheet or item. Clients that are still connected refetch, and fail until writes are back on; the rest resync when they reconnect. Nothing needs pausing.

#### 6. Check the live table's settings

```bash
npm run restore -- check --table $LIVE $P
```

It checks the table is active, has `GSI1`, `GSI2` and `GSI3` active, KMS encryption, TTL on `expiresAt`, the stream with new and old images, point-in-time recovery, deletion protection and the stack's tags, and exits 1 if anything is wrong. After a copy-back all of these are as they were. If one is wrong, the data stack has drifted: `npx cdk diff supply-checkout-prod-us-east-1-data` shows it, and a deploy of the data stack puts it back.

Also confirm the stream mapping is enabled and on the table's current stream:

```bash
aws dynamodb describe-table --table-name $LIVE $P --query Table.LatestStreamArn
aws lambda list-event-source-mappings --function-name supply-checkout-prod-live-updates $P \
  --query 'EventSourceMappings[].[EventSourceArn,State]'   # the same ARN, Enabled
```

#### 7. Verify

Repeat [verify the restored table](#verify-the-restored-table)'s item count and team comparison against the live table: the live table's counts now match the restored table's (less what step 4 deleted).

#### 8. Writes back on

```bash
for f in $FNS; do aws lambda delete-function-concurrency $P --function-name "$f"; done
date -u +%FT%TZ   # writes back on
```

Sign in, open a team, add a sheet line, and watch the alarms clear and the canary pass. Then delete the restored table ([Clean up](#clean-up)), and write the times in the [drill log](#drill-log).

### How it's tested

`backend/test/restore.test.ts` runs `deletions` and `copy-back` against DynamoDB Local (`npm run test:ddb -- test/restore.test.ts`): deleted teams and accounts in every case above, the dry runs writing nothing, a second run finding nothing, numbers, sets and binary copied exactly, and the CLI end to end. `check` is tested against a restored table's and a live table's settings. The records' writers are tested in `backend/test/account-deletion-api.test.ts` (a failed write stops the deletion before anything is lost for good), and the bucket and grants in `infra/test/web.test.ts`, `api.test.ts` and `observability.test.ts`. What isn't tested yet is the whole procedure against real AWS: throttling the functions, the real copy speed and the downtime. The first run should be a drill in staging (restore, then `deletions` and `copy-back` into staging's live table), before it's ever needed in prod.

## Drill log

Times are wall-clock minutes. For drill B, "copy" is the copy job and "restore" is the restore job, from creation to completion.

| Date | Drill | Recovery point (UTC) | Target | Items (restored / live) | Copy | Restore | Result | By |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Not run yet | | | | | | | | |
