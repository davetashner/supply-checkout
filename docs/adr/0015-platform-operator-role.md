# 0015. A platform operator role, separate from teams

- Status: Accepted (2026-09-26)
- Date: 2026-09-26

## Context

Every role today belongs to a team: owner, contributor or viewer, stored in `MEMBER#` items ([ADR 0007](0007-identity-cognito.md)), plus the `system` role that server processes such as the Stripe webhook use. Nobody can act on the platform as a whole. We need that for three things:

- **Pilot teams on free plans** (`supply-checkout-p0e`, `supply-checkout-3ww`), before billing and promo campaigns exist.
- **Promo campaigns** (`supply-checkout-8jc.8`): create, pause and end Stripe coupons and promotion codes without the Stripe dashboard.
- **Support**: find a team, see its plan and billing state, and later look at its data when the owner asks for help.

What's built constrains the design:

- One Cognito user pool with passwordless first factors (email code, passkey), so MFA can only be optional in it: Cognito doesn't allow one-time-password sign-in in a pool that requires MFA. In an MFA-optional pool, a user who has turned MFA on can no longer use an email code or a passkey and is asked for TOTP after their password. But tokens carry no claim saying how the session signed in (user pool tokens have no `amr`), so the API can't tell a session that used TOTP from one that didn't. The billing routes plan to check that an owner has TOTP enrolled (`AdminGetUser`). That proves the user has TOTP now, not that this session used it. For example, tokens refreshed for up to 30 days from a sign-in made before TOTP was set up, or from an Apple or Google sign-in (Cognito leaves MFA to the identity provider), still pass.
- API Gateway's JWT authorizer checks signature, expiry, issuer and audience locally. It doesn't see revoked tokens: only Cognito's own APIs (such as `GetUser`) reject them.
- Team isolation has two layers ([ADR 0005](0005-multi-tenant-dynamodb.md)): `TeamContext`, issued only from a verified membership, and per-request STS sessions tagged with the team (`DataAccessRole`) or the user (`AccountAccessRole`), limited by `dynamodb:LeadingKeys`. IAM can limit a partition key, but not a sort key, so a role that may read `TEAM#<id>` can read that team's sheets and products too.
- [ADR 0009](0009-billing-stripe.md) makes the billing Lambda the only code that changes a team's `plan` or `status`.

## Decision

The owner accepted this design on 2026-09-26, including each choice that had been left open:

1. **A separate operator user pool** with required MFA, not an `operators` group in the main pool.
2. **TOTP** is the operators' second factor.
3. **Sessions:** 15-minute access and ID tokens, 8-hour refresh tokens.
4. **Comps** last at most 12 months and can be renewed.
5. **A CLI first, then an operator page on its own origin (`ops.<env domain>`)**, not a screen inside the customer app.
6. **Support access needs an owner's approval**, with no break-glass path.
7. **Owners see operator actions on their team**, attributed to "Supply Checkout support".

The sections below give the details.

### 1. Identity: an operator user pool with required MFA, and an `operators` group in it

- **A second Cognito user pool, `supply-checkout-<env>-ops`**, in the primary region only (operators don't need the phase 2 failover). Essentials tier, Managed Login at `ops-auth.<env domain>`.
  - **Self sign-up off.** Users are created only with `aws cognito-idp admin-create-user` (or the console), with the `supply-mgmt` or `supply-prod` SSO role. No app code, no Lambda role and no app client can create users or change groups.
  - **MFA required, TOTP only.** The first sign-in forces TOTP setup. Password plus TOTP is the only way in: no email codes, no Apple or Google, no SMS. Because the pool can't issue a token without MFA, **every token from it proves the session used MFA**. That's why this ADR doesn't use `amr` (Cognito doesn't set it) or the enrolled-TOTP check (it can't see how a session signed in; see Context).
  - **An `operators` group**, also granted only with `admin-add-user-to-group`. Being in the pool isn't enough; the group is what the API checks. It leaves room for a read-only `support` group later.
  - One public app client, `ops`: authorization code with PKCE, callbacks only for the ops page and `http://localhost:<port>/` for the CLI. **Access and ID tokens last 15 minutes; refresh tokens last 8 hours**, with rotation and revocation on. An operator signs in once per working day. Managed Login keeps its own session cookie for one hour, so within that hour a sign-in page can hand out new tokens without asking again; the CLI and the ops page sign out through the logout endpoint, and removal is enforced by the per-request checks below, not by token lifetime.
- **The API reads the group from the access token's `cognito:groups` claim**, after the ops authorizer checks the ops pool's issuer and the `ops` client ID. Then, on every request, the ops function also:
  - calls `GetUser` with the caller's access token, which fails for a token revoked by sign-out or `admin-user-global-sign-out`, and
  - calls `AdminListGroupsForUser` for the token's `sub` and requires `operators`.

  So **removing someone from the group, disabling them, or signing them out globally takes effect on their next request**, not at token expiry. Operator traffic is a few requests a minute, so two Cognito calls per request cost nothing that matters.
- An operator who is also a customer (the owner runs the family business's team) has **two separate identities**: their customer account in the main pool and their operator account in the ops pool. Nothing links them.

### 2. Authorization: separate routes, function and role

- **Routes under `/ops/...`**, on the same HTTP API, behind a **separate JWT authorizer** for the ops pool. They're served by a new `ops` function, not the `data` or `account` functions. A main-pool token fails the ops authorizer (wrong issuer and audience), and an ops-pool token fails the existing one.
- **The team routes never honor the operator group.** The `data` and `account` handlers don't read `cognito:groups`, and `authorizeTeam` still needs a `MEMBER#` item. An operator gets no `TeamContext`; the ops code has its own module and a lint rule keeps it from importing `team-context.ts`.
- **`OperatorAccessRole`**, assumed per request by the ops function (whose own role can't reach the table), like the other two roles. Its policy:

  | What | Keys (`dynamodb:LeadingKeys`) | Actions |
  | --- | --- | --- |
  | Team list and one team's account record | New sparse **GSI3**, partitions `OPS#TEAMS` and `OPS#OWNERS#<teamId>` | `Query` on the index only |
  | Comp a plan | `TEAM#<teamId>`, from a session tag, as in `DataAccessRole` | `UpdateItem` only, with `dynamodb:Attributes` limited to `PK`, `SK`, `type`, `version` and the `comp*` attributes, and `dynamodb:ReturnValues` limited to `NONE`, `UPDATED_OLD` or `UPDATED_NEW` |
  | Operator audit | `OPAUDIT#<teamId>`, `OPAUDIT#PLATFORM` | `PutItem` and `Query`. No update or delete |
  | Campaigns | `CAMPAIGN#<campaignId>` | `GetItem`, `PutItem`, `UpdateItem`, `Query` |

  - **How `dynamodb:Attributes` works here.** It lists the top-level attributes a request names anywhere in its parameters: the update, the condition and any projection. It says nothing about what an item already holds. So the allowed list must include every attribute the comp update touches or tests, including `type` and `version` from its condition, and the table's key attributes `PK` and `SK` (DynamoDB requires them whenever `dynamodb:Attributes` is used). `dynamodb:ReturnValues` uses `StringEqualsIfExists` (changed from `StringEquals` when this was built, `supply-checkout-6uw.1`): the comp's update goes in a `TransactWriteItems`, whose items carry no `ReturnValues`, so `StringEquals` would refuse it. A standalone `UpdateItem` always sends the key (`NONE` by default), so `ALL_OLD` and `ALL_NEW` still can't return the rest of an item. Neither covers `ReturnValuesOnConditionCheckFailure`; the code never sets it (a residual risk in docs/infrastructure.md). The role gets no `PutItem` or `DeleteItem` on `TEAM#` partitions, since those replace or remove whole items. An `UpdateItem` could create a new item under the team's partition key; the code's condition (`#type = :team`) prevents that, and such an item could only hold comp attributes. The GSI3 `Query` statement also requires `dynamodb:Select` to be `ALL_PROJECTED_ATTRIBUTES` or `SPECIFIC_ATTRIBUTES`.
  - **Why a GSI, not a broader grant:** listing every team would otherwise need a `Scan` or read access to every `TEAM#` partition, which includes sheets and products. Instead, team `META` items get `GSI3PK = OPS#TEAMS` (`GSI3SK = <createdAt>#<teamId>`), and owner `MEMBER#` items get `GSI3PK = OPS#OWNERS#<teamId>`. GSI3 uses an **INCLUDE projection** of only `name`, `plan`, `seats`, `status`, `trialEndsAt`, `owners`, `createdAt`, `stripeCustomerId`, the `comp*` attributes, and, on owner items, `email` and `joinedAt`. Sheet, product, movement and invite items never carry `GSI3PK`, so they aren't in the index, and a query on an index can't fetch unprojected attributes. The role has no `GetItem` or `Query` on the base table's `TEAM#` partitions.
  - Search by name filters the `OPS#TEAMS` partition in the function. At pilot and launch scale (hundreds of teams) that's one or two pages; shard the partition if it ever becomes hot.
  - **Comp is a separate set of attributes**, so ADR 0009's rule holds: only the billing Lambda writes `plan` and `status`. The ops function writes `compPlan`, `compSeats`, `compUntil`, `compReason`, `compBy` and `compAt` on `META`. The entitlement check treats a team as active on `compPlan` while `compUntil` is in the future, whatever Stripe says, and falls back to the Stripe status after it. Every comp has an expiry, at most 12 months ahead, and can be extended. The update's condition (`#type = :team AND version = :v`) keeps it to the `META` item and to the version the operator saw.
- **A Stripe restricted key for the ops function**, separate from the billing Lambda's: read customers, subscriptions and invoices; write coupons and promotion codes. Nothing else.

### 3. Capabilities in the MVP

| Route | Does |
| --- | --- |
| `GET /ops/teams?q=` | List and search teams: name, owners (emails), plan, seats, status, comp, created |
| `GET /ops/teams/{teamId}` | One team's account record from GSI3, plus its Stripe subscription and recent invoices |
| `PUT /ops/teams/{teamId}/comp` | Comp or extend a plan (plan, seats, `until`, reason), including free for pilot teams |
| `DELETE /ops/teams/{teamId}/comp` | End a comp early |
| `POST /ops/campaigns`, `GET /ops/campaigns`, `POST /ops/campaigns/{id}/pause`, `.../end` | Promo campaigns (`supply-checkout-8jc.8`) |
| `GET /ops/audit` | The operator audit trail |

**Not in the MVP: reading a team's data** (sheets, products, movements, invites, receipts). The role can't, by construction.

Every route validates its path, query and body like the team routes do, and every write takes an `Idempotency-Key`.

### 4. Support access (later; this is its shape)

When an owner asks for help with their data:

1. The operator requests access to one team with a reason and a duration (at most 24 hours). This writes a `SUPPORT#<grantId>` item in the team's partition, status `requested`, and emails the team's owners.
2. **An owner approves it in the app** (members screen). No approval, no access. A break-glass path without approval isn't planned; if it's ever added, it notifies every owner at once and pages us.
3. While the grant is live, the ops function assumes a **separate `SupportReadRole`**, tagged with the team, with **read-only** actions (`GetItem`, `Query`) on that team's partitions. Its STS session ends at the earlier of one hour and the grant's end. Operators never write team data.
4. Every read is audited like any other operator action. The team sees a banner ("Support access is open until …") and can revoke the grant at any time.

### 5. Audit

- **Every operator request that changes something writes an audit item in the same transaction as the change**, and every read of a single team's record writes one too. An item holds: the operator's `sub` (not their email), the time, the action (`ops.comp.set`, `ops.campaign.pause`, …), the target, the reason, the request's idempotency key, and `before` and `after` values of the fields that changed.
- Team actions go to `OPAUDIT#<teamId>`; platform actions (campaigns) go to `OPAUDIT#PLATFORM`. Items carry `GSI3PK = OPS#AUDIT#<yyyy-mm>` so operators can list everything by month. Retention is 2 years (TTL).
- **Owners read their own team's operator audit** next to the team audit trail: `DataAccessRole` gains read-only `Query` on `OPAUDIT#<its team tag>`. Operator audit items name the actor as "Supply Checkout support", not the operator's identity.
- The function also logs each action as a structured line (action, target, operator `sub`, result; no emails or tokens) for CloudWatch.

### 6. UI: a CLI first, then a separate operator page

- **For the pilot (`supply-checkout-p0e`): a CLI**, `npm run ops -- <command>`, that signs in to the ops pool with PKCE on a localhost callback and calls the `/ops` routes. Commands: `teams`, `team <id>`, `comp <id> --plan --seats --until --reason`, `uncomp <id>`, `audit`. It is "the operator script" p0e asks for, and it goes through the same routes, MFA and audit as everything later, so there's no second path to maintain or review.
- **For campaigns (`supply-checkout-8jc.8`): a minimal operator page at `ops.<env domain>`**, built from the same repo (`src/ops/`) but served as its own site. A separate origin means an XSS bug in the customer app can't reach operator tokens, and the customer bundle ships no operator code. The page lists teams, shows one team, and manages comps and campaigns.
- **No operator screen inside the customer app, shown when the token has the group.** With a separate pool the customer token never has the group, and even with one pool, hiding a screen protects nothing: the API is the control. The bead's "operator screen in the web app" becomes the separate page.

### 7. Threats and mitigations

| Threat | Mitigations |
| --- | --- |
| **Stolen operator token** | 15-minute access tokens; `GetUser` on every request, so `admin-user-global-sign-out` cuts off a stolen token immediately; the ops page is on its own origin; the role can't read team data or write anything but comps, campaigns and audit; every action is audited. A runbook covers the response: sign out, disable the user, review `OPAUDIT`. |
| **Privilege escalation by adding oneself to the group** | Groups are changed only with `cognito-idp:AdminAddUserToGroup`, an IAM action no Lambda role has. Neither app client can: `AdminAddUserToGroup` needs IAM credentials, and the web client's `aws.cognito.signin.user.admin` scope only allows self-service calls on the user's own attributes and MFA. Groups aren't attributes, so `writeAttributes` can't expose them. The main pool has no `operators` group, and ops routes don't accept its tokens anyway. An EventBridge rule on CloudTrail sends an alert for `AdminCreateUser`, `AdminAddUserToGroup` and `AdminRemoveUserFromGroup` on the ops pool, even when CloudFormation makes them, and another alerts when either operator rule is deleted, disabled or loses its target (`supply-checkout-6uw.7`). The implementing PR adds a test that the web client can't do any of this. |
| **Phishing** | Password plus TOTP on a separate sign-in host. TOTP can still be phished in real time, so the operator keeps the TOTP secret on a device, not in the same password manager, and the ops pool is small enough to watch. Passkeys are phishing-resistant. The ops pool can let them count as MFA on their own (`MULTI_FACTOR_WITH_USER_VERIFICATION`), but password plus TOTP always stays available, so offering passkeys doesn't remove the phishable path. That's why the MVP uses TOTP alone. Revisit if Cognito can turn password sign-in off. |
| **Confused deputy** | The ops function acts only with its own session-tagged role, never the data or account roles. Team IDs in `/ops` paths pick a GSI3 partition or tag the comp session; they can't reach sheets or products. Stripe calls use the ops restricted key, and campaign IDs are looked up in `CAMPAIGN#` items, not taken from Stripe input. The team routes never read the group. |
| **Log tampering** | The role can put audit items but never update or delete them, and the audit write is in the same transaction as the change. Audit items are in the table's PITR and AWS Backup copies in a separate account (`supply-checkout-8x1`). CloudTrail records every Cognito admin call. Only the `supply-prod` administrator can delete items, and that is itself in CloudTrail. Any change or deletion of an `OPAUDIT#` item other than its TTL expiry alarms P1, from the table's stream (`supply-checkout-6uw.5`). |

## Alternatives considered

| Option | Why not |
| --- | --- |
| **An `operators` group in the main pool, with the enrolled-TOTP check the billing routes plan** | Cognito does stop a user with TOTP from using an email code or a passkey, but the API still can't see how a session signed in: tokens refreshed from an earlier sign-in without TOTP, or from Apple or Google, pass the check. Closing that gap would need our own record of when TOTP was set up, compared with `auth_time`. The main pool can't require MFA without dropping email-code sign-in, and this option would put operator tokens in the customer app's origin. |
| **Main pool, check `amr`** | Cognito user pool tokens don't carry `amr` for native sign-in. |
| **No API at all: operators use the AWS CLI on DynamoDB and the Stripe dashboard** | Fastest, but no audit the team can see, no validation, and 8jc.8 rules out the Stripe dashboard. Hand-edited items also break ADR 0009's rule that only billing code writes `plan` and `status`. |
| **A local script with SSO credentials writing comps directly** | Tempting for p0e, but it's a second write path with its own audit and validation, and it runs with far broader rights than the ops role. The CLI above is barely more work. |
| **An IAM-authorized ops API (SigV4 with SSO credentials) instead of Cognito** | Strong, and MFA comes from IAM Identity Center. But the ops page would need browser SigV4 and short-lived credentials, and the bead and owner chose a Cognito group. Worth reconsidering if the ops pool proves awkward. |
| **Base-table reads of `TEAM#` partitions for the team list** | IAM can't limit sort keys, so any such grant can read sheets and products. |

## Consequences

- Two sign-ins for the owner: the customer app and the ops pool. Separation is the point.
- A second user pool (free at this size), a second JWT authorizer, a new function and two new roles (`OperatorAccessRole` now, `SupportReadRole` later), a sparse GSI3, and a `comp*` rule in the entitlement check. Each needs cdk-nag and template snapshots, and the security review CLAUDE.md requires.
- ADR 0009's "only the billing Lambda changes a team's plan or status" stays true; its access rules gain "a live comp wins". ADR 0005's table gains `OPAUDIT#`, `CAMPAIGN#`, `SUPPORT#` and GSI3. ADR 0007 gains the ops pool.
- Team data stays unreadable to operators until support access is built and an owner approves it.

## What this changes in other beads

- **`supply-checkout-6uw.1`** (this bead): acceptance criteria gain tests that a main-pool token is refused on `/ops`, an ops token is refused on team routes, and a signed-out or removed operator is refused on the next request. "A minimal operator screen in the web app" becomes the CLI now and the `ops.` page with 8jc.8. Support access becomes its own bead.
- **`supply-checkout-8jc.8`** (promo campaigns): builds on the ops routes, the `CAMPAIGN#` items, the ops Stripe key and the `ops.` page. "Admin access is operator-only" means the `operators` group in the ops pool. Campaign actions audit to `OPAUDIT#PLATFORM`.
- **`supply-checkout-p0e`** (pilot-ready): "free access by operator script" is `npm run ops -- comp`. It needs only the ops pool, the `/ops/teams` routes, comps and the audit, not campaigns or the page.
- **`supply-checkout-3ww`** (pilot): comp pilot teams with an expiry after the pilot's planned end (for example 90 days) and a reason naming the pilot. Owners get notice before a comp ends, then a trial or checkout, the same as any team. Extend with `comp` if the pilot runs long.

## References

- Cognito, MFA and passwordless sign-in (the table of MFA settings and sign-in factors): https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html
- Cognito, authentication flows (one-time passwords, passkeys and MFA): https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html
- Cognito, the access token's claims (`cognito:groups`, `auth_time`, no `amr`), token lifetimes and the Managed Login cookie: https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-access-token.html
- Cognito, the ID token's claims (no `amr`): https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html
- DynamoDB, IAM conditions for fine-grained access control (`dynamodb:LeadingKeys`, `dynamodb:Attributes`, `dynamodb:ReturnValues`, `dynamodb:Select`): https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/specifying-conditions.html
