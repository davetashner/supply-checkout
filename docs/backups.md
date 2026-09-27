# Backups and restores

How the `app` table and the S3 buckets are protected, how to set up the copy to a separate backup account, what to do when a backup fails, the restore drill (bead `supply-checkout-8x1`), the deletion records, and putting a restored table back into service (beads `supply-checkout-72d.4` and `supply-checkout-0ic7`).

The CDK is in `infra/lib/stacks/backup-stack.ts` (workload account), `infra/lib/stacks/backup-account-stack.ts` (backup account) and `infra/lib/backup.ts` (names and retention). The tests in `infra/test/backup.test.ts` check the plan, the retention, the copy rule, both vault locks and the IAM roles.

## What protects what

| Layer | Where | Covers | Kept | Delete protection |
| --- | --- | --- | --- | --- |
| Point-in-time recovery | On the table (data stack) | Any second in the window, to a new table | 35 days | Deletion protection on the table |
| Daily AWS Backup | `supply-checkout-<env>-backups` vault, same account | The table as of 2am Eastern each day | 35 days | Governance-mode vault lock, deny on `DeleteRecoveryPoint` |
| Daily copy | `supply-checkout-<env>-backup-copies` vault, **backup account** | The same backup, in an account the workload account can't touch | 90 days | **Compliance-mode** vault lock (30-day minimum), deny on `DeleteRecoveryPoint` |
| S3 versioning | Web and logs buckets (data stack) | Overwritten or deleted objects | 30 days after replacement | Bucket `RETAIN` policy |
| Deletion records | `supply-checkout-<env>-deletions-<region>-<account>` bucket (data stack) | Which accounts and teams were deleted, by ID, so a restore can delete them again | 400 days | **Compliance-mode** Object Lock on every record |

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
- **Not yet copied to the backup account.** If the workload account itself is lost, its records go with it, while the copies in the backup account survive. Until the bucket is replicated there, a restore from the backup account into a new account can't re-apply deletions from the records; see the note in [step 4](#4-re-apply-deletions-on-the-restored-table).

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
date -u +%FT%TZ   # writes stopped
```

From here the API answers 5xx and sign-in fails: the app is down. The API, Lambda and journey alarms fire, and the canary fails; that's expected. The email events and the scheduled purge are asynchronous: Lambda keeps retrying them for up to 6 hours, so they run once writes are back on.

Note the time: the live table's own PITR can take it back to this moment if the copy goes wrong.

#### 4. Re-apply deletions on the restored table

Now no more deletions can happen, so the records are complete:

```bash
npm run restore -- deletions --table $RESTORED $P --apply
npm run restore -- deletions --table $RESTORED $P      # again: purges 0, removes 0
```

For each record it finds in the restored table:

| Found | What it does |
| --- | --- |
| A deleted team, or a team a deleted account's deletion closed | Marks it closed and due, and purges it the way the scheduled purge does: every item, its members' team-switcher rows, its Stripe link |
| A team whose only members are deleted accounts | Purges it too (the account deletion closed it, and the purge followed) |
| A deleted account's membership of any other team | Removes it the way leaving does: the counts move, invites to their address in that team go, and the team's audit trail gets `member.left` with `account_deleted` |
| A deleted account's own `USER#` rows | Deletes them, except the daily limit counters, which expire |
| A deleted account that's the last owner of an open team with other members | Nothing: [left for a person](#a-team-left-for-a-person) |

Pending invites to a deleted account's address from teams it wasn't in can't be found (the record has no address). They expire within 7 days, by TTL.

It exits 1 while a team is left for a person. Every step is idempotent, so a run that stops (a throttle, an expired session) is finished by running it again.

> **Restoring from the backup account into a new account.** The records are in the old workload account's bucket. If that account is still reachable, pass its bucket with `--bucket` (and a profile that can read it). If it's gone, the records are gone with it: the deletions since the recovery point can't be re-applied, and every account and team deleted in the last 90 days may come back. Tell the owner, and delete them by hand as their owners ask again.

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
