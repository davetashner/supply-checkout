# 0003. Separate AWS accounts for each environment under AWS Organizations

- Status: Proposed
- Date: 2026-09-25

## Context

We have one AWS account today. If dev, staging and production share it, one mistake (a bad IAM policy, a runaway test, a `cdk destroy` run against the wrong stack) can hit customer data. The information security policy will also need to show that production access is separated and logged.

## Decision

Turn the existing account into the **management account** of an AWS Organization. It holds billing and nothing else. Under it, create:

| Account | Purpose |
| --- | --- |
| `log-archive` | Organization CloudTrail and AWS Config history. S3 Object Lock, write-only for other accounts. |
| `security` | Delegated admin for GuardDuty, Security Hub, IAM Access Analyzer. |
| `dev` | Shared development and pull-request preview stacks. One region. |
| `staging` | A copy of production in both regions. Every release deploys here first. |
| `prod` | Customer data. Both regions. |

- People sign in through **IAM Identity Center** with MFA. No IAM users and no long-lived access keys. An Identity Center instance already exists in us-east-1 on the current account. Confirm it is an **organization instance**; an account instance can't grant access to the other accounts, and would have to be replaced once AWS Organizations is turned on. Locally, `aws configure sso` sets up one CLI profile per account and role (`supply-dev`, `supply-staging`, `supply-prod`).
- GitHub Actions deploys through **OIDC** roles, one per account, limited to this repository and to the named branch or environment.
- Service control policies deny: leaving the organization, turning off CloudTrail or GuardDuty, and using any region outside the approved list (us-east-1, us-west-2, plus the global services).
- **AWS Budgets** alarms in each account at 50%, 80% and 100% of a monthly budget, with a cost anomaly monitor.

## Alternatives considered

- **One account, with environments separated by name prefix.** Cheapest to set up, but offers no real isolation, and IAM policies become hard to reason about.
- **Control Tower.** Automates most of the above, but adds cost and moving parts we don't need at this size. We can adopt it later; the account layout above matches its defaults.

## Consequences

- About a day of setup, once. Adds nothing to the AWS bill except CloudTrail/Config storage, which costs pennies.
- Supports the information security policy and any future SOC 2 work.
