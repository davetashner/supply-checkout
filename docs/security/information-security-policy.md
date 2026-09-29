# Information Security Policy

> **DRAFT — not reviewed by the owner; not in effect.**
> Written for bead `supply-checkout-4p1`. It describes what is built and decided today, not what we hope to build. Anything planned is labeled as planned and names its bead. See [Open questions for the owner](#open-questions-for-the-owner) at the end.

- Version: 0.1 (draft)
- Last updated: 2026-09-28
- Owner: the Supply Checkout owner (sole administrator)
- Next review: **2027-09-28**, 12 months after this draft, or sooner after a security incident, a change to the AWS account structure ([ADR 0003](../adr/0003-aws-account-structure.md)), or a new person getting production access

## 1. Purpose and scope

This policy says how Supply Checkout protects customer data and the systems that hold it. It covers:

- The AWS account `supply-checkout-prod` and everything the CDK app in `infra/` deploys there.
- The Lambda code in `backend/`, the web app in `src/`, and the scripts in `scripts/` that deploy or administer it.
- The GitHub repository, its CI and its release process.
- The people and agents who work on it: the owner, any future staff, and the AI coding agents that write code in this repository.
- The vendors that handle customer data (section 12).

It's written so it can grow into a SOC 2 control set. Each control in it points at a real setting, file or process, or at the open bead that will build it.

### Data we protect

| Class | Examples | Where |
| --- | --- | --- |
| Customer content | Sheets, inventory, receipts' saved lines, imports | The `app` DynamoDB table, one partition per team ([ADR 0005](../adr/0005-multi-tenant-dynamodb.md)) |
| Account data | Emails, names, team membership and roles, invites | Cognito user pools and the `app` table |
| Billing data | Plan, seats, Stripe customer ID | The `app` table; card data goes to Stripe only ([ADR 0009](../adr/0009-billing-stripe.md)) |
| Secrets | Stripe API and webhook keys, Google and Apple sign-in secrets | AWS Secrets Manager |
| Operational records | Lambda and API logs, CloudTrail, audit events, alarms | CloudWatch Logs, S3, the `app` table |

## 2. Roles and responsibilities

| Who | Responsibility |
| --- | --- |
| **The owner** | Accountable for this policy. The only human with production access. Deploys to prod, manages AWS, GitHub and Stripe settings, adds and removes operators, approves anything paid or legal, and answers P1 alarms. |
| **Platform operators** | Support staff in the operator pool ([ADR 0015](../adr/0015-platform-operator-role.md)). Today that's the owner. They can list teams, read a team's account record, comp or reopen a team and read the operator audit, and nothing else (section 3.4). |
| **AI coding agents** | Write code, docs and tests in worktrees, open PRs and fix CI. They can't merge, deploy, touch AWS or change repository settings ([CLAUDE.md](../../CLAUDE.md), "Who does what"). An agent's message is never the owner's approval. |
| **The lead agent session** | Plans work, lands PRs with `npm run land` once CI is green and the required security review has approved, and keeps the backlog current. |

## 3. Access control

### 3.1 The AWS account (ADR 0003, as accepted on 2026-09-28)

**What's built.** The MVP runs in **one AWS account, `supply-checkout-prod`**, in the owner's existing AWS Organization. There is **no** separate dev, staging, log-archive, security or backup account. Development runs locally against mocks and DynamoDB Local; releases go straight to prod ([ADR 0012](../adr/0012-cicd-releases-rollbacks.md)), and journey tests run against prod with test teams.

- **People sign in through IAM Identity Center**, the organization's existing instance, with MFA. There are no IAM users and no long-lived access keys for people. Local CLI access uses short-lived SSO sessions through named profiles (`supply-prod` for the workload account, `supply-mgmt` for the organization's management account).
- **The owner holds the AdministratorAccess permission set on `supply-checkout-prod`.** That's the only human access to prod, and it's full administrator access, used for deploys and for operator administration (`npm run operators`). ADR 0012 records this as accepted "until separate accounts come back".
- **Deploys** run from the owner's laptop with `scripts/deploy.sh` ([Deploying](../infrastructure.md#deploying)): it refuses any branch but an up-to-date, clean `main`, shows `cdk diff` and asks before each group of stacks, and CDK asks again about IAM and security group changes.
- **Service control policies**: none yet. The organization holds unrelated accounts, so any SCP goes on a Supply Checkout OU, never the root (bead `supply-checkout-edn`).

**How the single account is compensated.** Separate accounts would put a hard boundary between development and customer data, and would keep the audit logs and backups out of reach of anyone who compromised prod. Instead we rely on:

1. **MFA on every human sign-in** through Identity Center, and short-lived credentials only.
2. **The account's CloudTrail trail** (section 6.1): every management event, read and write, in every region, with log file validation.
3. **Alerts on the changes that matter** (section 6.2): EventBridge rules on CloudTrail events page the owner (P1) when someone changes the operator pool, the audit trail, the alarm path, the backup vault or the deletion records, including changes that would silence those alerts.
4. **Least-privilege roles for the workloads** (sections 3.3 and 3.4): no Lambda has a wildcard over the table; each one is scoped by `dynamodb:LeadingKeys` and `dynamodb:Attributes`, and cdk-nag fails any synth with an unacknowledged finding.
5. **Deletion protection, termination protection and `RETAIN`** on stateful resources, and point-in-time recovery plus a vault lock on backups (section 8).
6. **No development data in prod**: development and CI never use the prod account. CI synthesizes without AWS credentials.

**What's weaker because of it.** Plainly:

- **Anyone holding the owner's Identity Center session can do anything in prod**, including reading customer data, turning off the trail, deleting the trail's logs and deleting backups. The alerts make most of that loud, but they don't prevent it, and an administrator can silence them (the residual risks are listed in [Operators](../infrastructure.md#operators), "The alerts").
- **The audit trail lives in the account it audits.** Its bucket is versioned (30 days) and its key is watched, but there's no organization trail and no log-archive account with Object Lock, so a prod administrator could delete the logs.
- **Backups live in the account they protect.** The workload vault's lock is governance mode, which an administrator can override. The cross-account copy (compliance-mode lock) and the deletion records' copy are built but off (`-c backupCopy=false`).
- **No staging.** A change's first run against real AWS is in prod. The canary after each deploy and automatic rollback on alarms ([ADR 0012](../adr/0012-cicd-releases-rollbacks.md), beads `supply-checkout-qq7`, `supply-checkout-9lj`) are what catch a bad release.
- **No GuardDuty, Security Hub, AWS Config or SCPs yet** (bead `supply-checkout-edn`), and no AWS Budgets alerts yet (bead `supply-checkout-jxq`).
- **One administrator.** There's no second person to review a production change or to recover access, so break-glass depends on the organization's management account (section 3.6).

We'll revisit separate accounts after launch, as ADR 0003 says.

### 3.2 GitHub Actions deploy role (planned)

PR #222 (not yet merged; bead `supply-checkout-5ik`) adds an IAM OIDC provider for GitHub Actions and one role, `supply-checkout-prod-github-deploy`. Its trust policy accepts only this repository's `production` environment, with no wildcards, and it may only assume the CDK bootstrap roles. It's a separate CDK app so a pipeline can't change its own trust. No workflow deploys with it yet; that's bead `supply-checkout-qq7`.

Two owner steps are needed before it's safe to use:

- **The `production` environment's protection rules** (bead `supply-checkout-pbp.22`): deployment branches and tags limited to `main` and `v*`, with required reviewers. Without the branch limit a workflow on any branch could declare `environment: production` and get the role.
- **Narrowing the CDK bootstrap execution policy** (bead `supply-checkout-3x3.2`). The default CloudFormation execution role that `cdk bootstrap` creates has AdministratorAccess, so anyone who can run a job in the `production` environment can change anything in the account through CloudFormation, even though the deploy role itself only assumes the bootstrap roles. The fix is a managed policy scoped to what the stacks create, and a re-bootstrap with `--cloudformation-execution-policies`.

Until both are done, deploys stay with the owner's SSO session.

### 3.3 Customer access and team isolation

- **Sign-in** is Amazon Cognito ([ADR 0007](../adr/0007-identity-cognito.md), `infra/lib/stacks/identity-stack.ts`): email codes, passkeys and passwords, and Google when turned on. Sign in with Apple is built but off until the Apple Developer account exists. The web client is public, authorization code with PKCE, no secret; access and ID tokens last 60 minutes, refresh tokens 30 days with rotation.
- **MFA** is optional for customers, because Cognito requires optional MFA for passwordless sign-in. The billing routes refuse (`mfa_required`) unless the caller has TOTP on; users who sign in only with Google or Apple rely on the provider's MFA. That's the accepted policy in ADR 0007.
- **Team isolation has two layers** ([ADR 0005](../adr/0005-multi-tenant-dynamodb.md)):
  1. The server sets `teamId` from the caller's verified membership; the client never supplies it. Every data-access function takes a `TeamContext` that only the authorizer can build, and a lint rule bans calling the DynamoDB client from anywhere but `backend/src/data`.
  2. Each request runs under a per-request STS session tagged with the team (`DataAccessRole`) or the user (`AccountAccessRole`), and the role's policy limits `dynamodb:LeadingKeys` to that tag's partitions (`infra/lib/stacks/api-stack.ts`). A bug in the first layer can't reach another team's partition.
- **Roles inside a team** (owner, contributor, viewer) are enforced by the application only, not IAM (ADR 0007).
- **API limits**: API Gateway validates JWTs (issuer, audience, expiry) before any function runs, and has a stage throttle with tighter per-route throttles. The web app is behind AWS WAF with a per-IP rate limit and AWS managed rules (`infra/lib/stacks/web-stack.ts`).

### 3.4 Platform operators (ADR 0015)

Built as described in [Operators](../infrastructure.md#operators):

- A **separate Cognito user pool** with no self sign-up. Operators are created only by an administrator under an SSO role (`npm run operators`); no Lambda role or app client can create users or change groups, and an `infra` test checks that no policy in any stack grants those calls.
- **TOTP is required**: the pool can't issue a token without it. Passwords are 16+ characters; there are no email codes, passkeys, SMS or social sign-in. Access tokens last 15 minutes and refresh tokens 8 hours; the CLI stores only the access token, mode 600.
- **Separate `/ops/*` routes** with their own JWT authorizer. On every request the ops function also checks the token with Cognito (`GetUser`, so a revoked token or a disabled user fails at once) and that the user is still in the `operators` group.
- **Least privilege**: the ops function's role reaches no table. Per request it assumes `OperatorAccessRole` (or `OperatorReopenRole`), which can read only the operators' sparse index and change only named comp or reopen attributes. Operators **can't read a team's sheets, inventory, invites or receipts**; support access with an owner's approval is a later bead.
- **Every operator action is audited**, including reads and searches, in append-only `OPAUDIT#` items kept 2 years. Owners see actions on their team at `GET /teams/{teamId}/support-actions`. The operator audit watch pages P1 on any change or deletion of an audit item, and on any change to who is an operator.

### 3.5 GitHub and the repository

- `main` is protected by the "Protect main" ruleset, with no bypass actors: pull request required, squash merge only, linear history, no force pushes or deletion, the `CI passed` check required, and CodeQL code scanning must show no security alert of medium or higher (section 9).
- The repository is **public**. Nothing that identifies the AWS account or a person is committed (section 7).

### 3.6 Break-glass

- If the owner loses access to Identity Center, access is recovered from the organization's management account (`supply-mgmt`), which administers Identity Center and can reassign the permission set.
- The account's root user is not used for daily work.
- There's no written break-glass procedure yet, and no second person who could use one (see the open questions).

### 3.7 Access reviews

Quarterly, the owner reviews and records in the backlog:

- Identity Center users and permission sets on `supply-checkout-prod`.
- Operator pool users and the `operators` group (`npm run operators -- list`).
- GitHub collaborators, deploy keys, Actions secrets and environments.
- Alarm recipients (`/supply-checkout/<env>/alarms/*` in SSM).
- Stripe dashboard users.

No review has run yet; the first one is due before launch.

## 4. Onboarding and offboarding

Today the owner is the only person with access. When someone joins:

1. An Identity Center user with MFA, and the narrowest permission set that fits the job. Nobody but the owner gets AdministratorAccess on prod.
2. If they do support, an operator account (`npm run operators -- add`), which alerts P1 when created.
3. GitHub access at the lowest role that fits. They can't bypass the ruleset.
4. If they're on call, their email and phone as alarm recipients.
5. They read this policy and the "Who does what" rules in [CLAUDE.md](../../CLAUDE.md).

When someone leaves, the same day:

1. Disable their Identity Center user and end their sessions.
2. Disable and remove their operator account (`npm run operators -- disable`, then `remove`), which signs them out everywhere.
3. Remove their GitHub access and any Stripe dashboard access.
4. Remove them as an alarm recipient and redeploy the observability stack.
5. Rotate any secret they could read (the Stripe keys, sign-in provider secrets).

## 5. Encryption

**At rest.** Customer-managed KMS keys with yearly rotation for: the `app` table (`data` stack), the CloudTrail trail and its bucket (`audit` stack), the alarm topics (`lib/observability/alarm-topics.ts`), the backup vault (`backup` stack), and the email stack's dead-letter queue. The logs bucket uses S3-managed encryption, because CloudFront's standard logs can't be written to an SSE-KMS bucket. Every bucket blocks public access.

**In transit.** TLS everywhere. CloudFront requires TLS 1.2 or later (`TLS_V1_2_2021`) and sends HSTS for two years with subdomains (`infra/lib/stacks/web-stack.ts`). The API and Cognito are HTTPS only. Every bucket's policy refuses non-TLS requests (`enforceSSL`).

**Key access.** Key policies grant only the services and roles that need each key. Disabling, scheduling deletion of, or changing the policy of the table, trail or alarm topic keys outside a deploy pages P1 (section 6.2).

## 6. Logging and monitoring

### 6.1 What's logged, and how long it's kept

This section **sets the retention periods**. They're what `infra/` deploys today, and they must match the Privacy Policy draft ([docs/legal/privacy-policy.md](../legal/privacy-policy.md), section 7, "How long we keep it"). Change both together, and the code with them.

| Record | Kept | Set in |
| --- | --- | --- |
| Lambda, API Gateway access, AppSync and Cognito trigger logs (CloudWatch Logs) | **1 year** | `LOG_RETENTION` in `infra/lib/observability/defaults.ts` |
| CloudFront and S3 access logs (the logs bucket) | **1 year** (old versions 30 days more) | Lifecycle rule in `infra/lib/stacks/data-stack.ts` |
| CloudTrail log files | **400 days** (old versions 30 days more) | `TRAIL_LOG_RETENTION_DAYS` in `infra/lib/stacks/audit-stack.ts` |
| Front-end errors (CloudWatch RUM) | 30 days | AWS's fixed RUM retention (`infra/lib/web/rum.ts`) |
| Team activity history (audit events) | 1 year | `AUDIT_RETENTION_DAYS` in `backend/src/data/audit.ts` |
| Operator audit | 2 years | `OPERATOR_AUDIT_RETENTION_DAYS` in `backend/src/data/operator.ts` |
| Deletion records | 400 days | `DELETION_RECORD_RETENTION_DAYS` in `backend/src/deletions/names.ts` |

Why these values: one year of operational logs is enough to investigate an incident found late and to answer a customer's question about the last year, without keeping IP addresses longer than that. CloudTrail keeps 400 days so an investigation can always look back a full year plus the time it takes to notice. The previous "placeholder" notes in `infra/lib/stacks/audit-stack.ts`, [observability.md](../observability.md) and the Privacy Policy's open question 6 can point here once this policy is accepted.

**The CloudTrail trail** (`supply-checkout-prod-trail`, [The CloudTrail trail](../infrastructure.md#the-cloudtrail-trail), bead `supply-checkout-3sv.3`): multi-region, every management event (read and write), global services included, log file validation on, SSE-KMS with its own key, only this trail may write to its bucket, termination-protected and `RETAIN`. No data events.

**What logs must not contain.** No secrets, tokens, passwords or personal data (emails, names) in logs, errors or metrics. Application logs record IDs and counts. The ops function logs the route, team ID, operator `sub` and status, never emails or tokens. This is checked in the security review (section 9.3).

### 6.2 Alerting

- **Two alarm topics per region** ([Observability](../observability.md)): P1 (email and SMS, any hour, start within 15 minutes) and P2 (email, same business day), with severities defined in [journeys.md](../journeys.md#severity-and-who-is-told). Recipients live in SSM, not in the repository ([Alarm recipients](../observability.md#alarm-recipients)).
- **Journey alarms** for every customer journey that must not break, the web app down, and the scheduled checks ([journeys.md](../journeys.md#which-alarms-exist)).
- **Security alerts on CloudTrail events** (P1), in the primary region's `observability` stack ([Operators](../infrastructure.md#operators), "The alerts"): changes to the operator pool and its users; operators' own MFA changes; anything that would silence the operator audit watch, its alarms, the alarm topics or their key; `StopLogging`, `DeleteTrail`, `UpdateTrail` or event selector changes on any trail; and tampering with these rules themselves. The backup stack alerts on changes to the vault, its lock, the plan and the vault key ([backups.md](../backups.md#alerts-on-the-backups)).
- **Front-end errors** go to CloudWatch RUM, tagged with the release.

**Limits.** These rules only see what CloudTrail records. The alerts and their residual risks are listed in [Operators](../infrastructure.md#operators): one KMS key encrypts both alarm topics; deploys through any CloudFormation stack are exempt from the "outside a deploy" rules; and an email subscription confirmed by its link can be cancelled by anyone holding the email. The drill that checks each rule fires against real CloudTrail events hasn't been run yet.

## 7. Secrets

- **Secrets live in AWS Secrets Manager**: the Stripe secret key and webhook signing secret (each Lambda's IAM policy names only that one secret, `infra/lib/config.ts`), and the Google and Apple sign-in secrets (resolved by CloudFormation dynamic references, never in a template).
- **Configuration that isn't a secret but mustn't be public** (alarm recipients, the hosted zone, the DMARC address) is in SSM Parameter Store.
- **Never in the repository**: no secrets, account IDs, SSO URLs or personal email addresses in code, docs, commit messages or bead text. The account ID comes from the AWS profile at synth time.
- **Enforced three ways**: the pre-commit hook (`scripts/git-hooks/pre-commit`, `npm run hooks:install`) runs `scripts/check-public-safety.mjs` on staged files; CI's "Secret scan" job runs it on every file and runs gitleaks (checksum-verified) over the pull request's commits and over every commit on `main`; and GitHub's code scanning gate (section 9).
- **Operator passwords** from `npm run operators` go to the AWS CLI in an owner-only request file that's deleted right after the call, and are printed once, to a terminal only.
- **If a secret leaks**, rotate it first, then remove it from history, then look for use of it in CloudTrail and the vendor's logs.

## 8. Backup and recovery

As built for the MVP ([Backups and restores](../backups.md)):

- **Point-in-time recovery** on the `app` table, 35 days, plus deletion protection.
- **A daily AWS Backup** of the table at 2am Eastern, kept 35 days (`LOCAL_RETENTION` in `infra/lib/backup.ts`), in a vault with a governance-mode lock and a deny on `DeleteRecoveryPoint`, encrypted with its own key.
- **Prod only.** ADR 0003 as accepted keeps backups in the prod account. The cross-account copy (90 days, compliance-mode lock) and the deletion records' replica are in the code but off (`-c backupCopy=false`). That's weaker than the design: see section 3.1.
- **Deletion records** (400 days, compliance-mode Object Lock) let a restore delete again what a customer deleted, so deleted data leaves backups within 35 days.
- **Recovery objectives**: PITR restores to about 5 minutes before now. Recovery time is unknown until the first restore drill, which is due before launch and is recorded in the [drill log](../backups.md#drill-log).
- **Code and infrastructure** are in Git; any stack can be redeployed from `main`.

## 9. Secure development and change management

### 9.1 Every change goes through a pull request

- Work happens on a branch in its own worktree and merges to `main` only by pull request, squash-merged, with `CI passed` green. The ruleset has no bypass.
- PR titles are Conventional Commits; release-please turns them into releases.
- Commits are signed off (`git commit -s`). This is a convention in [CLAUDE.md](../../CLAUDE.md); CI doesn't check it.
- The ruleset requires no approving review, because the owner is the only human reviewer. The review that stands in for it is the required security review below, done by a separate agent.

### 9.2 What CI checks

On every pull request ([.github/workflows/ci.yml](../../.github/workflows/ci.yml)):

- Secret scan: gitleaks and the public-safety check (section 7).
- Dependency audit: `npm audit --audit-level=high` in the root, `infra/` and `backend/`.
- CodeQL for JavaScript/TypeScript and GitHub Actions, on every PR and push to `main` and weekly ([.github/workflows/codeql.yml](../../.github/workflows/codeql.yml)). The ruleset blocks a merge with a CodeQL security alert of medium or higher.
- `infra/`: type-check, lint, tests, template snapshots and a synth of every stack in every approved region with **cdk-nag** AwsSolutions, which fails on any unacknowledged finding. Acknowledgements are on the narrowest construct with a written reason.
- `backend/`: type-check, lint (including the DynamoDB client ban), handler and OpenAPI tests, and data-access tests against DynamoDB Local.
- The app: lint, HTML validation, browser tests in two browsers against both builds, and the 98% coverage gate.
- Workflow lint (actionlint). Third-party actions are pinned to a commit SHA, and workflows default to read-only permissions.

### 9.3 Security review

A pull request that touches `backend/`, IAM roles or policies in `infra/`, or identity and auth (Cognito, tokens, sign-in, invites, team membership) needs an **adversarial security review by a separate reviewer agent** before it merges, ending in approve or block. Findings are fixed and the review runs again. It covers cross-team isolation, IAM scope, token validation, input validation and logging ([CLAUDE.md](../../CLAUDE.md), "Security review"; bead `supply-checkout-pbp.7`). A full security review before launch is bead `supply-checkout-nsn`.

### 9.4 Releases

Until the deploy pipeline (bead `supply-checkout-qq7`) exists, the owner deploys from `main` with `scripts/deploy.sh` (section 3.1). The pipeline in [ADR 0012](../adr/0012-cicd-releases-rollbacks.md) will deploy each release to prod, run the core canary once, and roll back on alarms.

## 10. Vulnerability and patch management

- **Dependabot** opens weekly grouped updates for npm in the root, `infra/` and `backend/`, and for GitHub Actions ([.github/dependabot.yml](../../.github/dependabot.yml)). They go through the same CI and review as any change.
- **`npm audit`** fails CI on any high or critical advisory. We don't adopt a library with a known critical CVE.
- **CodeQL** alerts of medium or higher block merges; the weekly scan catches new queries against unchanged code.
- **Managed runtimes.** Lambda runs on AWS's managed Node.js runtime; there are no servers or containers of ours to patch.
- **Targets** (proposed): fix critical findings within 7 days and high within 30, or record why not in a bead.

## 11. Incident response

The full plan, including breach notification, is bead `supply-checkout-dgv`. Until then:

1. **Detect.** P1 and P2 alarms (section 6.2), customer reports, and vendor notices.
2. **Contain.** Follow the runbook for the alarm: each journey alarm's response is in [journeys.md](../journeys.md#which-alarms-exist); [When the web app is down](../observability.md#when-the-web-app-is-down); [When a backup fails](../backups.md#when-a-backup-fails); and for an unexpected operator alert, sign every operator out, disable the user who made the change and compare `OPAUDIT#` with point-in-time recovery ([Operators](../infrastructure.md#operators)). For a suspected credential compromise, disable the Identity Center user or operator, revoke sessions and rotate secrets.
3. **Investigate** with CloudTrail (400 days), the application logs (1 year) and the audit items.
4. **Recover** from point-in-time recovery or the daily backup ([Put a restored table back into service](../backups.md#put-a-restored-table-back-into-service)).
5. **Tell** affected customers and authorities as the law requires (bead `supply-checkout-dgv`), and post on the status page (bead `supply-checkout-iuw`) for a P1 that lasts more than 15 minutes.
6. **Learn.** Write up what happened and open beads for the fixes.

## 12. Vendor management

| Vendor | What it does | Data it handles |
| --- | --- | --- |
| Amazon Web Services | Hosting, database, sign-in, email (SES), receipt reading (Bedrock), logs | Everything we store |
| Stripe | Payments and subscriptions | Billing contacts, plan and seats, payment details |
| GitHub | Source code, CI, releases | Code only; no customer data |
| Google | Sign in with Google (when on); Google Fonts | What their sign-in collects; visitors' IP addresses |
| Apple | Sign in with Apple (off in the MVP) | What its sign-in collects |
| Namecheap | Domain registration (DNS is in Route 53) | None |

Before adding a vendor that handles customer data: check its security posture (a SOC 2 report or equivalent), sign its data processing terms, add it to the Privacy Policy's list, and record the decision in a bead. A public subprocessor list is bead `supply-checkout-q3g` (phase 2).

## 13. Exceptions and changes

An exception to this policy is recorded as a bead with the reason, the compensating control and an end date, and the owner approves it. This policy changes by pull request like any other doc, and the owner approves each change.

## Controls and where they live

| Control | Setting or process | Status |
| --- | --- | --- |
| Human sign-in with MFA, no IAM users | IAM Identity Center, `supply-prod` profile | Built |
| Separate accounts per environment | [ADR 0003](../adr/0003-aws-account-structure.md) | Deferred; one account for the MVP |
| GuardDuty, Security Hub, Config, SCPs, organization trail | Bead `supply-checkout-edn` | Open |
| Budgets and cost anomaly alerts | Bead `supply-checkout-jxq` | Open |
| Account CloudTrail trail | `infra/lib/stacks/audit-stack.ts`, bead `supply-checkout-3sv.3` | Built |
| Security alerts on CloudTrail events | `infra/lib/stacks/observability-stack.ts` | Built; drill pending |
| Team isolation (session tags, `dynamodb:LeadingKeys`) | `infra/lib/stacks/api-stack.ts`, [ADR 0005](../adr/0005-multi-tenant-dynamodb.md) | Built |
| Operator role with required TOTP and audit | `infra/lib/stacks/identity-stack.ts`, `backend/src/operator/`, [ADR 0015](../adr/0015-platform-operator-role.md) | Built |
| Billing requires TOTP | Billing routes, [ADR 0007](../adr/0007-identity-cognito.md), bead `supply-checkout-8jc.12` | Built |
| Encryption at rest with rotating KMS keys | `data`, `audit`, `backup`, `email` stacks, `alarm-topics.ts` | Built |
| TLS 1.2+, HSTS, TLS-only buckets | `infra/lib/stacks/web-stack.ts`, bucket `enforceSSL` | Built |
| WAF and API throttling | `web-stack.ts`, `api-stack.ts` | Built |
| Log retention (1 year; CloudTrail 400 days) | `LOG_RETENTION`, data stack lifecycle, `TRAIL_LOG_RETENTION_DAYS` | Built |
| PITR and daily backups, 35 days | `infra/lib/backup.ts`, [backups.md](../backups.md) | Built; first drill pending |
| Cross-account backup copy | `backup-account-stack.ts` | Built, off in the MVP |
| Secrets in Secrets Manager | `infra/lib/config.ts`, `identity-stack.ts` | Built |
| Pre-commit public-safety check, gitleaks | `scripts/git-hooks/pre-commit`, `ci.yml` "Secret scan" | Built |
| Branch ruleset, required CI, CodeQL gate | GitHub ruleset "Protect main" | Built |
| Security review for backend, IAM and auth PRs | [CLAUDE.md](../../CLAUDE.md), bead `supply-checkout-pbp.7` | In practice |
| Pre-launch security review | Bead `supply-checkout-nsn` | Open |
| Dependabot, `npm audit`, CodeQL | `dependabot.yml`, `ci.yml`, `codeql.yml` | Built |
| cdk-nag on every synth | `infra/` | Built |
| GitHub OIDC deploy role | PR #222, bead `supply-checkout-5ik` | Planned |
| `production` environment rules | Bead `supply-checkout-pbp.22` | Open (owner) |
| Narrow the CDK bootstrap execution policy | Bead `supply-checkout-3x3.2` | Open (owner) |
| Deploy pipeline with canary and rollback | Beads `supply-checkout-qq7`, `supply-checkout-9lj` | Open |
| Incident response and breach notification plan | Bead `supply-checkout-dgv` | Open |
| Subprocessor list | Bead `supply-checkout-q3g` | Phase 2 |
| Quarterly access review | Section 3.7 | Not started |

## Open questions for the owner

1. **Identity Center MFA setting.** The repository can't show it. Confirm Identity Center requires MFA at every sign-in (not "only when context changes"), which MFA types are allowed, and whether you'd accept only phishing-resistant ones (security keys, passkeys) for the AdministratorAccess permission set.
2. **Admin access day to day.** Would you use a narrower permission set for daily work (read-only, plus a deploy set once the bootstrap policy is narrowed) and keep AdministratorAccess for break-glass? That would shrink the biggest single-account risk.
3. **Root user and break-glass.** Is the `supply-checkout-prod` root user protected with MFA (or, with AWS Organizations' centralized root access, are root credentials removed)? Who can use the management account if you can't, and should this policy name a written break-glass procedure?
4. **Log retention.** This draft sets operational logs at 1 year and CloudTrail at 400 days, which is what's deployed and what the Privacy Policy draft says. Keep them, or change both (for example, shorter for IP addresses, or longer for CloudTrail if a customer contract asks for it)?
5. **Signed-off commits.** CI doesn't check the `Signed-off-by` line, and squash merges keep only the PR's squash commit. Keep it as a convention, add a CI check, or drop it?
6. **Up-to-date branches.** [CLAUDE.md](../../CLAUDE.md) says a branch must be up to date to merge, but the ruleset's required status check isn't "strict", so GitHub doesn't enforce it; `npm run land` updates branches itself. Turn on the strict setting?
7. **Required human review.** The ruleset requires no approving review; the agent security review stands in. Is that acceptable for SOC 2 purposes, or do you want to approve changes to `backend/`, IAM and auth yourself?
8. **Patch targets.** Section 10 proposes 7 days for critical and 30 for high. Agree?
9. **Before launch.** Which of these must be done before the `MVP live in AWS` milestone: GuardDuty and an SCP on a Supply Checkout OU (`supply-checkout-edn`), Budgets (`supply-checkout-jxq`), the first restore drill, the CloudTrail alert drill, turning on the cross-account backup copy?
10. **Who else is on call.** [journeys.md](../journeys.md#severity-and-who-is-told) says P1 goes to "both of us". Who is the second person, and what access should they have under section 4?
11. **Compliance goal.** Is SOC 2 (Type I, then Type II) a goal, and when? That decides whether we add policies for things this draft skips (risk assessment, security awareness training, device security for the laptops that hold SSO sessions).
