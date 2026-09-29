# 0002. Serverless on AWS, defined with the AWS CDK in TypeScript

- Status: Accepted
- Date: 2026-09-28 (proposed 2026-09-25)
- Note: The owner accepted this on 2026-09-28. Lambdas run on Node.js 24, not 22. The context's "one AWS account" is out of date (see 0003). The Route 53 hosted zone for supplycheckout.com was made by hand in `supply-checkout-prod`, like the account bootstrap, and is the one other thing not made by the CDK.

## Context

At $3 per user per month, fixed hosting costs have to stay near zero while there are few customers, and costs have to grow only with usage. We have one AWS account available, and no one on the team to run servers. [ADR 0010](0010-multi-region-active-active.md) runs the MVP in us-east-1 and adds us-west-2 later, so the infrastructure tool has to deploy the same stack to more than one region.

## Decision

- Build only on managed, pay-per-use AWS services: CloudFront and S3 for the web app, API Gateway HTTP APIs and Lambda (Node.js 22, arm64) for the backend, DynamoDB for data, Cognito for sign-in, AppSync Events for live updates, Bedrock for receipt reading, SES for email, and EventBridge and SQS for background work.
- Define all infrastructure in the **AWS CDK v2 (TypeScript)**, in an `infra/` workspace in this repository. No resources are created by hand in the console, except the one-time account bootstrap in [ADR 0003](0003-aws-account-structure.md).
- Write the Lambda code in TypeScript and bundle it with esbuild (CDK's `NodejsFunction`).
- Run `cdk-nag` (AWS Solutions rules) on every synth, and fail CI on any finding that hasn't been suppressed with a written reason.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Amplify Gen 2 | Fastest way to get started, but it deploys each backend to one region and hides the CloudFormation underneath. Active-active across two regions and custom canary rollbacks would mean fighting the tool. |
| Terraform / OpenTofu | Good multi-region support, but adds a second language (HCL) and a state backend to run. The rest of the repo is JavaScript. |
| SST | Nice developer experience. It is built on Pulumi now, which adds another abstraction and a smaller support community for problems specific to AWS. |
| Containers (ECS/Fargate) | Always-on cost of about $30+ a month per region before the first customer. |

## Consequences

- Close to $0 fixed cost at launch. Most line items have free tiers or cost pennies at low volume (see the cost model in the business plan bead).
- Lambda cold starts add roughly 200–500 ms to the first request after a quiet period. That's acceptable for this app; provisioned concurrency can be added later for the busiest functions.
- Everyone working on infra needs to know the CDK. Unit tests with CDK assertions and snapshots keep changes reviewable.
