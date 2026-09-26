# Architecture decision records

Each record captures one decision about turning Supply Checkout from a claude.ai artifact into a paid, multi-tenant product on AWS (target price: $3 per user per month). Records use a light [MADR](https://adr.github.io/madr/) shape: context, decision, alternatives considered, consequences.

A record starts as **Proposed**. Change it to **Accepted** once we agree, or **Superseded by NNNN** when a later record replaces it. Don't rewrite an accepted record; write a new one.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-serverless-aws-with-cdk.md) | Serverless on AWS, defined with the AWS CDK in TypeScript | Proposed |
| [0003](0003-aws-account-structure.md) | Separate AWS accounts for each environment under AWS Organizations | Proposed |
| [0004](0004-runtime-adapter.md) | Keep one web app behind a runtime adapter | Proposed |
| [0005](0005-multi-tenant-dynamodb.md) | Multi-tenant data in one DynamoDB table, partitioned by team | Proposed |
| [0006](0006-api-and-realtime-sync.md) | HTTP API for reads and writes, AppSync Events for live updates | Proposed |
| [0007](0007-identity-cognito.md) | Cognito for sign-in; teams and roles stored in our own data | Proposed |
| [0008](0008-receipt-reading-bedrock.md) | Read receipts with Claude on Amazon Bedrock | Proposed |
| [0009](0009-billing-stripe.md) | Stripe Billing for subscriptions, invoices and payments | Proposed |
| [0010](0010-multi-region-active-active.md) | Active-active in two US regions; the MVP runs in us-east-1 only | Accepted |
| [0011](0011-mobile-apps-capacitor.md) | Native iOS and Android apps wrap the web app with Capacitor | Proposed |
| [0012](0012-cicd-releases-rollbacks.md) | CI/CD with GitHub Actions, canary deploys and automatic rollback | Proposed |
| [0013](0013-web-billing-only.md) | Web billing only; the mobile apps link to web checkout | Proposed |
| [0014](0014-units-cost-and-rounding.md) | Count in eaches, keep cost apart from client price, and round money to cents | Accepted |
| [0015](0015-platform-operator-role.md) | A platform operator role, separate from teams | Accepted |

The architecture overview and diagrams are in [`docs/architecture/`](../architecture/README.md). The backlog that implements these decisions lives in beads (`bd list`, `bd ready`).
