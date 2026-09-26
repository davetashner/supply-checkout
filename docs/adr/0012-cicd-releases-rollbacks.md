# 0012. CI/CD with GitHub Actions, canary deploys and automatic rollback

- Status: Proposed
- Date: 2026-09-25

## Context

The repo already has CI (lint, HTML validation, dependency audit, Playwright in desktop Chrome and iPhone Safari), Conventional Commit PR titles, and release-please publishing GitHub Releases. Nothing deploys automatically, because the artifact is published by hand from a Claude session. The SaaS needs every merge to reach production safely without anyone babysitting it, and a bad release has to roll back without a person noticing first.

## Decision

**Pipeline** (GitHub Actions, OIDC into each AWS account per [ADR 0003](0003-aws-account-structure.md)):

1. **Pull request**: the existing gates, plus infra unit tests, `cdk-nag`, `cdk diff` posted to the PR, CodeQL, secret scanning, and a **preview stack** in `dev` running the customer-journey tests. Previews are deleted when the PR closes.
2. **Merge to `main`**: build once, and keep the build artifacts (web bundle, Lambda zips, CDK cloud assembly). Deploy to **staging** in both regions, then run the full customer-journey suite and the smoke tests against staging.
3. **Release** (release-please PR merged, which tags the version): promote **the same artifacts** to **prod**, one region at a time: us-west-2 first, then us-east-1. GitHub environment protection holds prod behind a required review at first; switch it to automatic once the rollback path has been proven on a game day.
4. After each prod region deploys, the **CloudWatch Synthetics** canaries run the core journeys against that region.

**Automated rollback**:

- **Lambda**: every function is published as a version behind a `live` alias and deployed with **CodeDeploy** `Canary10Percent5Minutes`. CloudWatch alarms on 5xx rate, p95 latency, and business errors (failed writes, failed receipt reads) are attached. If an alarm fires, CodeDeploy moves the alias back to the previous version.
- **Web app**: each build goes to a versioned S3 prefix (`/releases/<version>/`), and a CloudFront Function points traffic at the current version. Rollback means pointing it at the previous version. A post-deploy canary failure triggers this automatically.
- **Infrastructure**: CloudFormation rolls back failed stack updates on its own. Stateful resources (DynamoDB, KMS, Cognito, S3) are in separate stacks with termination protection and `RETAIN` removal policies, so an app rollback can't touch data.
- **Database changes** follow expand/contract: add new fields and read both shapes first; remove old fields only in a later release. Then rolling back the code never needs a data rollback.
- **Mobile**: a new app build can't be pulled back from phones, so risky behavior goes behind server-controlled feature flags (AWS AppConfig), which can be turned off in seconds.

**Releases**: release-please stays the single source of version numbers and changelogs. The release workflow deploys to prod, builds the mobile apps (fastlane → TestFlight / Play internal), and still attaches `index.html` for the claude.ai artifact.

## Alternatives considered

- **AWS CodePipeline.** Native to AWS, but duplicates what the repo already does in Actions, and PR previews are harder.
- **Blue/green whole stacks.** Doubles resources during each deploy; per-function canaries give the same safety at lower cost.

## Consequences

- Production changes come only from the pipeline. Humans get read-only prod access, plus a break-glass role that raises an alert when used.
- A release reaches prod about 30–45 minutes after merge (staging tests plus two canary windows).
