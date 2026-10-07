# 0005. Multi-tenant data in one DynamoDB table, partitioned by team

- Status: Accepted
- Date: 2026-09-28 (proposed 2026-09-25)
- Note: The owner accepted this on 2026-09-28, as built. A sheet's sort key is `SHEET#<id>`, not `SHEET#<date>#<id>`, because a sheet's date can be edited and the app reads sheets by ID. `dynamodb:LeadingKeys` is enforced with a per-request session tagged with the team ID, so a session can't reach another team's partition. Roles inside a team (owner, contributor, viewer) are enforced by the application only (see 0007).
- Superseded in part: sheets are now called projects ([rename plan](../projects-rename-plan.md)), so a project's sort key is `PROJECT#<id>` and its date index partition is `TEAM#<teamId>#PROJECTS`; items the rename's backfill hasn't moved yet keep `SHEET#<id>` and `TEAM#<teamId>#SHEETS`. The text below keeps its original wording.

## Context

Today every artifact user shares one database with two collections:

- `products/{key}`: `code`, `name`, `price`, `stock`, `updatedAt`
- `sheets/{id}`: `client`, `date`, prepared-by, `status`, `closedAt`, and an `items` map keyed by product (`out`, `returned`, `price`, `name`)

The product needs many **teams** (paying customers), each seeing only its own data, plus users, memberships, invites, subscriptions, receipt usage and an audit trail. Data has to replicate to a second region ([ADR 0010](0010-multi-region-active-active.md)).

## Decision

Use **one DynamoDB table** (`app`), on-demand capacity, point-in-time recovery on, deletion protection on, encrypted with a customer-managed KMS key, and replicated as a **global table**.

| Entity | PK | SK | Notes |
| --- | --- | --- | --- |
| Team | `TEAM#<teamId>` | `META` | name, plan, seats, subscription status, home region |
| Member | `TEAM#<teamId>` | `MEMBER#<userId>` | role: owner, contributor, viewer |
| User's teams | `USER#<userId>` | `TEAM#<teamId>` | reverse lookup for the team switcher |
| Invite | `TEAM#<teamId>` | `INVITE#<inviteId>` | email, role, expiry (TTL); GSI on hashed token, second GSI on hashed email (pending invites at first sign-in) |
| Teams created today | `USER#<userId>` | `LIMIT#TEAMS#<yyyy-mm-dd>` | per-user rate limit on team creation; TTL |
| Product | `TEAM#<teamId>` | `PRODUCT#<key>` | same fields as today; `stock` changed only with atomic `ADD` |
| Sheet | `TEAM#<teamId>` | `SHEET#<date>#<id>` | same fields as today; sorting by SK gives the existing date order |
| Receipt usage | `TEAM#<teamId>` | `USAGE#<yyyy-mm>` | atomic counter for the monthly limit |
| Trial receipt usage | `TEAM#<teamId>` | `USAGE#TRIAL` | atomic counter for a trial team's receipts, for the whole trial (supply-checkout-wxx) |
| Receipt rate | `RECEIPTRATE#<userId>` | `RECEIPTS#<MINUTE\|HOUR\|DAY>#<stamp>` | per-user rate counters, TTL a day after the window (supply-checkout-wxx) |
| Audit event | `TEAM#<teamId>` | `AUDIT#<ts>#<id>` | who changed what; TTL after the retention period |
| Stripe link | `STRIPE#<customerId>` | `TEAM` | maps webhook events to a team |
| Processed webhook | `WEBHOOK#<eventId>` | `DONE` | idempotency; TTL 30 days |

- **The server sets `teamId` from the caller's verified membership. The client never supplies it.** Every data-access function takes a `TeamContext` that can only be built by the authorizer. A lint rule bans calling the DynamoDB client from anywhere else.
- Each Lambda runs with an IAM policy that uses `dynamodb:LeadingKeys` to limit it to the caller's partition. This is a second line of defense behind the application check.
- One item holds a whole sheet, as it does today. DynamoDB's 400 KB item limit allows several thousand line items per sheet. If sheets ever get close, line items move into their own items.

## Alternatives considered

- **Aurora Serverless v2 (Postgres) with row-level security.** Strong isolation and SQL reporting. But it has a minimum cost (about $45+/month per region), and cross-region writes need Aurora Global Database, where only one region takes writes.
- **A table per team.** Strongest isolation, but doesn't scale (account table limits), and every schema change would have to run per team.

## Consequences

- Cost grows with usage and is close to $0 at small scale.
- Reports across teams (for us, not customers) go through a nightly export to S3, queried with Athena.
- Global tables are last-writer-wins between regions. [ADR 0010](0010-multi-region-active-active.md) routes each team's writes to one home region so counters and sheets don't conflict.
