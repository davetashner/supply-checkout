# 0010. Active-active in two US regions

- Status: Accepted
- Date: 2026-09-26 (proposed 2026-09-25)
- Note: The owner accepted this with one change: the MVP runs in us-east-1 only, and the code is region-ready so us-west-2 can be added after launch.

## Context

Crews use the app on the job, often before 7am. If AWS has a regional outage, checkouts shouldn't stop. We want both regions serving traffic all the time (active-active), so failover is something that happens every day rather than a rarely tested procedure.

Running two regions from day one also roughly doubles fixed cost before the first customer, and much of it (write forwarding, failover, a second set of canaries and alarms) is the hardest work in the design. The MVP needs to launch first.

## Decision

The **end state** (phase 2) runs the full stack in **us-east-1** and **us-west-2**. The **MVP runs in us-east-1 only** and is **region-ready**: adding us-west-2 later is new deployment and new code paths, not a rebuild.

### End state (phase 2)

| Layer | How it works across regions |
| --- | --- |
| Web app | CloudFront with an **origin group**: S3 bucket in each region (cross-region replication); CloudFront switches to the second origin on 5xx. |
| API | An HTTP API in each region behind one custom domain (`api.<domain>`). **Route 53 latency-based routing** with health checks on a `/health` route that tests DynamoDB and dependencies. An unhealthy region drops out of DNS within about a minute. |
| Live updates | An AppSync Events API in each region (`realtime.<domain>`, same routing). Clients reconnect to whichever region DNS returns. |
| Data | DynamoDB **global table** in both regions. |
| Write conflicts | Global tables are last-writer-wins. To keep a team's counters and sheets consistent, each team has a **home region** (the `homeRegion` field on the team). The API in the other region forwards that team's writes to the home region; reads are served locally. If the home region is unhealthy, the other region takes over writes for that team. |
| Receipt reading | Bedrock called from the local region. |
| Sign-in | Cognito lives only in us-east-1 ([ADR 0007](0007-identity-cognito.md)). Both regions check JWTs locally against cached signing keys, so signed-in users keep working during a us-east-1 outage for the life of their access token. New sign-ins and token refreshes wait for us-east-1. A spike evaluates closing this gap. |
| Secrets | Secrets Manager with replica secrets. |
| Stripe webhooks | Served by both regions; idempotency is kept in the global table. |
| Email | SES set up in both regions with the same verified domain. |

- A **game day** each quarter, and before active-active is announced: turn off one region in staging (fail its health check) and run the customer-journey tests against it.
- Targets: **RTO** under 5 minutes for reads and writes (DNS failover); **RPO** is DynamoDB replication lag, usually under a second.

### MVP: one region, region-ready

Everything runs in us-east-1: web bucket, HTTP API, AppSync Events, the stream publisher, Stripe webhooks, Bedrock, Secrets Manager, SES, canaries and alarms. Staging and prod each run in us-east-1.

"Region-ready" means all of the following, and CI checks the ones it can:

1. **Every stack takes the region as a parameter and synths in both regions.** No stack assumes it is in us-east-1. Names that must be unique (S3 buckets, IAM roles, SSM parameters, log groups) include the region.
2. **The DynamoDB table is designed to become a global table, and is not replicated yet.**
   - Create it with the CDK `TableV2` construct (CloudFormation `AWS::DynamoDB::GlobalTable`) with a single us-east-1 replica. Adding us-west-2 later is one more replica in the same resource. Starting with a plain `AWS::DynamoDB::Table` would mean removing it from the stack and importing it again later.
   - On-demand capacity, and streams with new and old images (needed for replication and already used for live updates).
   - Encryption uses a customer-managed KMS key per region; the us-west-2 key is created when the replica is added.
   - Writes use the `version` condition from [ADR 0005](0005-multi-tenant-dynamodb.md). No code relies on a transaction or a strongly consistent read spanning regions.
3. **The team `homeRegion` attribute exists from day one.** It's set when a team is created, from the region the API runs in (always us-east-1 in the MVP). The data layer has one function that decides where a team's writes go. In the MVP it always returns the local region; phase 2 adds forwarding there.
4. **There are no hard-coded region strings in app or infra code.** Lambdas read the region from `AWS_REGION`. Infra reads it from the stack's environment. The list of regions, and the places AWS requires us-east-1 (CloudFront's ACM certificate, WAF for CloudFront, the Cognito pool), live in one config module. A CI check fails on `us-east-1` or `us-west-2` anywhere else in `infra/` or the app and Lambda source.
5. **CI synths us-west-2.** Every PR runs `cdk synth` for every stack in both regions, with `cdk-nag` and the CDK assertion tests on both.

In the MVP, a us-east-1 outage takes the app down until the region recovers. Data is protected by point-in-time recovery and daily backups to a separate account.

### Moves to phase 2

- Deploying staging and prod to us-west-2, and the prod release order of us-west-2 first. (CDK bootstrap there is cheap and can happen early.)
- The table's us-west-2 replica, its KMS key, and the replication-lag alarm.
- The second S3 origin, bucket replication and the CloudFront origin group.
- The HTTP API, AppSync Events, stream publisher and Stripe webhook endpoint in us-west-2.
- Route 53 latency routing and health-check failover for `api.` and `realtime.`.
- Forwarding writes to the home region, and taking over when it fails.
- Secrets Manager replica secrets.
- Bedrock model access and quotas, ACM certificates and the SES identity in us-west-2.
- Canaries, alarms and dashboards in us-west-2, and the region failover runbook.
- The failover game day, and the spike on keeping sign-in working when us-east-1 is down.

## Alternatives considered

- **Active-passive (warm standby).** Simpler writes, but the standby region isn't exercised every day, so failover is less trustworthy.
- **DynamoDB multi-region strong consistency (MRSC).** Removes write conflicts, but needs three regions, adds latency to every write, and has feature limits. Revisit if home-region forwarding causes problems.
- **Two regions at launch.** The first version of this ADR. Rejected for the MVP on cost and time; it stays the phase-2 goal.
- **Single region for good.** Cheapest and simplest. Rejected as the end state because of the uptime goal.

## Consequences

- MVP fixed cost stays at one region. Phase 2 roughly doubles it, and DynamoDB replicated writes cost more than single-region writes.
- Until phase 2, a us-east-1 outage stops the app for every team.
- Every feature must keep the region-ready rules above, so phase 2 doesn't turn into a rewrite. Once phase 2 ships, every feature must work when its write is forwarded to another region, and the customer-journey tests run against both regions.
