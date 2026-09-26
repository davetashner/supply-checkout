# 0010. Active-active in two US regions

- Status: Proposed
- Date: 2026-09-25

## Context

Crews use the app on the job, often before 7am. If AWS has a regional outage, checkouts shouldn't stop. We want both regions serving traffic all the time (active-active), so failover is something that happens every day rather than a rarely tested procedure.

## Decision

Run the full stack in **us-east-1** and **us-west-2**.

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

- A **game day** each quarter, and before launch: turn off one region in staging (fail its health check) and run the customer-journey tests against it.
- Targets: **RTO** under 5 minutes for reads and writes (DNS failover); **RPO** is DynamoDB replication lag, usually under a second.

## Alternatives considered

- **Active-passive (warm standby).** Simpler writes, but the standby region isn't exercised every day, so failover is less trustworthy.
- **DynamoDB multi-region strong consistency (MRSC).** Removes write conflicts, but needs three regions, adds latency to every write, and has feature limits. Revisit if home-region forwarding causes problems.
- **Single region for MVP.** Cheapest and simplest. Rejected as the end state because of the uptime goal, but see the phasing below.

## Phasing

The MVP ships **multi-region-ready**: every stack is parameterized by region, the global table is created with both replicas from day one (changing a table to a global table later is harder than starting with one), and the team's `homeRegion` is set from the start. Turning on the second region's API and the Route 53 failover follows soon after launch; that is its own epic in the backlog.

## Consequences

- Roughly doubles the (small) fixed cost, and DynamoDB replicated writes cost more than single-region writes.
- Every feature must work when its write is forwarded to another region. The customer-journey tests run against both regions.
