# Backups and restores

How the `app` table and the S3 buckets are protected, how to set up the copy to a separate backup account, what to do when a backup fails, and the restore drill (bead `supply-checkout-8x1`).

The CDK is in `infra/lib/stacks/backup-stack.ts` (workload account), `infra/lib/stacks/backup-account-stack.ts` (backup account), `infra/lib/backup.ts` (names and retention) and `infra/lib/backup-alerts.ts` (the alerts on changes, in both accounts). The tests in `infra/test/backup.test.ts` check the plan, the retention, the copy rule, both vault locks, the IAM roles and the alerts.

## What protects what

| Layer | Where | Covers | Kept | Delete protection |
| --- | --- | --- | --- | --- |
| Point-in-time recovery | On the table (data stack) | Any second in the window, to a new table | 35 days | Deletion protection on the table |
| Daily AWS Backup | `supply-checkout-<env>-backups` vault, same account | The table as of 2am Eastern each day | 35 days | Governance-mode vault lock, deny on `DeleteRecoveryPoint` |
| Daily copy | `supply-checkout-<env>-backup-copies` vault, **backup account** | The same backup, in an account the workload account can't touch | 90 days | **Compliance-mode** vault lock (30-day minimum), deny on `DeleteRecoveryPoint` |
| S3 versioning | Web and logs buckets (data stack) | Overwritten or deleted objects | 30 days after replacement | Bucket `RETAIN` policy |

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

> **`cdk deploy --all` fails until step 4 is done.** The backup stack reads `/supply-checkout/<env>/backup/copy-vault-arn` and `/supply-checkout/<env>/backup/organization-id` at deploy time, and CloudFormation fails when a parameter doesn't exist. Until the backup account's vault is in place, deploy with `-c backupCopy=false` (no copy, and no parameters needed), or leave the backup stack out.
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

   The stack is `supply-checkout-<env>-<region>-backup-vault`, and `-c envName=staging` deploys staging's vault. Confirm the subscription from the email AWS sends. The `copies-missing` alarm fires until the first copy lands (step 6), which also shows its email arrives. The `CopyVaultArn` output is the vault's ARN. `RestoreAccountIds` (default empty) lists the accounts a copy may be sent to for a restore; leave it empty until a drill or a real restore needs it. CloudFormation rejects anything but 12-digit account IDs and an `o-` organization ID. Every account must also be in the organization: the vault and key policies check `aws:PrincipalOrgID`.

4. **Tell the workload account where the copies go.** In the workload account, in the primary region. The organization ID lets the backup role copy only to a vault inside the organization (`aws:ResourceOrgID`), even if the vault ARN is wrong.

   ```bash
   aws ssm put-parameter --profile supply-prod --region us-east-1 --type String \
     --name /supply-checkout/prod/backup/copy-vault-arn --value <CopyVaultArn output>
   aws ssm put-parameter --profile supply-prod --region us-east-1 --type String \
     --name /supply-checkout/prod/backup/organization-id --value <o-...>
   ```

5. **Deploy the backup stack** (`supply-checkout-<env>-<region>-backup`). It deploys after the data and observability stacks, and `cdk deploy --all` includes it:

   ```bash
   npx cdk deploy supply-checkout-prod-us-east-1-backup --profile supply-prod
   ```

   An environment with no vault in the backup account (a dev account) deploys with `-c backupCopy=false`. It still gets the local vault and the daily backup, with no copy.

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

A restore always creates a new table. The live table is never overwritten, and the restore role can only create tables named `supply-checkout-<env>-app-restore-*`. Putting a restored table back into service is a separate procedure, not covered here.

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

## Drill log

Times are wall-clock minutes. For drill B, "copy" is the copy job and "restore" is the restore job, from creation to completion.

| Date | Drill | Recovery point (UTC) | Target | Items (restored / live) | Copy | Restore | Result | By |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Not run yet | | | | | | | | |
