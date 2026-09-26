# Backups and restores

How the `app` table and the S3 buckets are protected, how to set up the copy to a separate backup account, what to do when a backup fails, and the restore drill (bead `supply-checkout-8x1`).

The CDK is in `infra/lib/stacks/backup-stack.ts` (workload account), `infra/lib/stacks/backup-account-stack.ts` (backup account) and `infra/lib/backup.ts` (names and retention). The tests in `infra/test/backup.test.ts` check the plan, the retention, the copy rule, both vault locks and the IAM roles.

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
- **What the lock doesn't stop.** An administrator of the backup account can still make the copies unusable: by scheduling deletion of the vault's KMS key (after which nothing in the vault can be decrypted), or by changing the vault access policy so no new copies arrive. The lock only protects the recovery points themselves. A service control policy on the backup account that denies `kms:ScheduleKeyDeletion`, `kms:DisableKey` and `kms:PutKeyPolicy` on that key, and `backup:PutBackupVaultAccessPolicy` and `backup:DeleteBackupVaultAccessPolicy` on the vault, closes that gap (a bead is coming for it). Until then, keep administrator access to the backup account to the owner.
- **Workload account: governance mode.** It's the fast, local restore path, and it sits in the account an attacker would already be in. Its lock and deny policy stop accidental deletion, and an administrator can still fix a misconfiguration. Compliance mode here would add no protection the copy doesn't already give.
- **Grace period.** For the first 3 days after deploying the vault stack, the lock can still be changed or removed (`aws backup delete-backup-vault-lock-configuration`). Check the first copy lands in that window.

### Which account holds the copies

Any account in the same AWS Organization other than the workload accounts. [ADR 0003](adr/0003-aws-account-structure.md) proposes a `log-archive` account; the ADR review also suggests one audit account for logs and backups at this size. The vault stack works in either. Only one backup account is needed for every environment: each environment gets its own vault there.

## Setting it up

The owner does this once. Agents can't create accounts or deploy. The profile names below are examples: `supply-backup` is whatever profile reaches the backup account.

> **`cdk deploy --all` fails until step 4 is done.** The backup stack reads `/supply-checkout/<env>/backup/copy-vault-arn` and `/supply-checkout/<env>/backup/organization-id` at deploy time, and CloudFormation fails when a parameter doesn't exist. Until the backup account's vault is in place, deploy with `-c backupCopy=false` (no copy, and no parameters needed), or leave the backup stack out.
>
> **Check the vault stack's settings before its first deploy.** Its lock can't be changed after 72 hours (see [the lock's limits](#why-governance-mode-here-and-compliance-mode-there)).

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

3. **Deploy the vault stack in the backup account.** Bootstrap CDK there once, then deploy with the workload account IDs as a parameter. Account IDs are never committed: they're CloudFormation parameters, given on the command line.

   ```bash
   cd infra
   npx cdk bootstrap --profile supply-backup --app "npx tsx bin/backup-account.ts"
   npm run deploy:backup-account -- --profile supply-backup \
     --parameters SourceAccountIds=<prod account ID> --parameters OrganizationId=<o-...>
   ```

   The stack is `supply-checkout-<env>-<region>-backup-vault`, and `-c envName=staging` deploys staging's vault. The `CopyVaultArn` output is the vault's ARN. `RestoreAccountIds` (default empty) lists the accounts a copy may be sent to for a restore; leave it empty until a drill or a real restore needs it. CloudFormation rejects anything but 12-digit account IDs and an `o-` organization ID. Every account must also be in the organization: the vault and key policies check `aws:PrincipalOrgID`.

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

6. **Check the next morning.** The plan runs at 2am Eastern. Both jobs should be `COMPLETED`:

   ```bash
   aws backup list-backup-jobs --by-backup-vault-name supply-checkout-prod-backups --profile supply-prod --region us-east-1
   aws backup list-copy-jobs --profile supply-prod --region us-east-1
   aws backup list-recovery-points-by-backup-vault --backup-vault-name supply-checkout-prod-backup-copies --profile supply-backup --region us-east-1
   ```

   The `no-recent-backup` alarm fires on the first day, before the first backup runs. It clears once a backup completes.

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
