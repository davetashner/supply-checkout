# ADR review brief (0002–0013)

This brief helps the owner accept, change or reject ADRs 0002–0013 (bead `supply-checkout-y94`) in about 15 minutes. It changes no ADR status. That is the owner's call.

Sources: the ADRs, [`docs/architecture/README.md`](../architecture/README.md), [`docs/journeys.md`](../journeys.md), the open beads, and what already exists in AWS. Prices are rough US list prices as of this writing. Check them before relying on them.

## Summary

| ADR | Decision | Recommendation | Main reason |
| --- | --- | --- | --- |
| [0002](0002-serverless-aws-with-cdk.md) | Serverless AWS, CDK in TypeScript | Accept with changes | Context is out of date. The Route 53 zone was made by hand. Consider Node.js 24. |
| [0003](0003-aws-account-structure.md) | Separate accounts under AWS Organizations | Accept with changes | Written for a new organization. The organization already exists and holds other accounts. |
| [0004](0004-runtime-adapter.md) | One web app behind a runtime adapter | Accept | Sound. Keeps the artifact and the tests. |
| [0005](0005-multi-tenant-dynamodb.md) | One DynamoDB table, partitioned by team | Accept with changes | Sheet key includes an editable date. `LeadingKeys` needs per-request credentials. |
| [0006](0006-api-and-realtime-sync.md) | HTTP API plus AppSync Events | Accept | Sound. One item to verify for phase 2. |
| [0007](0007-identity-cognito.md) | Cognito; roles in DynamoDB | Accept with changes | Sign in with Apple needs the Apple developer account. Owner-only MFA needs custom code. |
| [0008](0008-receipt-reading-bedrock.md) | Receipts via Claude on Bedrock | Accept with changes | HTTP APIs time out at 30 seconds, not 60. Prompt may be too short to cache on Haiku. |
| [0009](0009-billing-stripe.md) | Stripe Billing | Accept with changes | Fees are understated. Move one-time and scheduled payments out of MVP. |
| [0010](0010-multi-region-active-active.md) | Active-active in two US regions | Accept with changes | MVP beads already build most of the second region. Cut MVP back to "region-ready". |
| [0011](0011-mobile-apps-capacitor.md) | Capacitor mobile apps | Accept | Phase 2. Low risk to accept now. |
| [0012](0012-cicd-releases-rollbacks.md) | GitHub Actions, canaries, auto rollback | Accept with changes | Canary hours (8am–8pm) leave night releases unchecked. Previews and staging cost more than stated. |
| [0013](0013-web-billing-only.md) | Web billing only | Accept | Already treated as decided. Fix the fee figure and add the missing store-rules spike bead. |

Suggested order: 0003 and 0010 first. They change the most beads. Then 0009 and 0012. The rest are quick.

## Cost at small scale

The architecture doc puts fixed production cost at about $17–25 a month. With what the MVP beads and `docs/journeys.md` now ask for, it is higher.

| Item (fixed, before customers) | Rough monthly cost |
| --- | --- |
| Synthetics: core canary every 5 min, 8am–8pm, two regions (about 8,600 runs at $0.0012), plus sign-up canary every 15 min (about 2,900 runs) | $14 |
| WAF: one web ACL plus about four managed rule groups | $9 |
| GuardDuty, Security Hub and Config, per account and region (low activity, about $1–3 each) | $10–25 |
| CloudWatch alarms from `docs/journeys.md` in two regions, logs, X-Ray, RUM | $6–12 |
| KMS keys, Secrets Manager replicas, Route 53 zone and health checks | $6–9 |
| Staging in both regions (a copy of prod, if it runs WAF and canaries) | $15–25 |
| Dev, preview stacks, log-archive and security accounts | $5–15 |
| **Total** | **about $60–100** |

A $3 seat nets about $2.50–2.75 after Stripe (about 7%, see 0009) and receipt reading. So $60–100 a month needs about 25–40 paid seats, or 8–13 Starter teams, to break even. A single-region MVP with staging in one region comes to about $35–50, or 13–19 seats. Pay-per-use items (Lambda, API Gateway, DynamoDB, AppSync Events, Cognito under 10,000 users, SES) stay in cents until well past launch.

---

## 0002. Serverless on AWS with the CDK

**Summary.** Use only managed, pay-per-use services: CloudFront, S3, HTTP API, Lambda (Node.js 22, arm64), DynamoDB, Cognito, AppSync Events, Bedrock, SES, EventBridge and SQS. Define everything with CDK v2 in TypeScript, in `infra/`. Run `cdk-nag` on every synth. Nothing is made by hand except the account bootstrap.

**Risks and costs.** Cold starts of 200–500 ms. The team must learn the CDK. Fixed cost is not "close to $0" once canaries, WAF and security services are on (see the cost table). It is still far below containers or Aurora.

**Open questions and inconsistencies.**

- The context says "We have one AWS account available". That is no longer true (see 0003).
- The Route 53 hosted zone for the domain already exists in `supply-checkout-prod`, made outside the CDK. Either import it into the CDK or list it as an allowed exception next to the bootstrap.
- Node.js 22 reaches upstream end of life in April 2027. Lambda supports Node.js 24. Starting on 24 avoids an early runtime upgrade.

**Recommendation: Accept with changes.**

1. Update the context to the real account setup.
2. Name the hand-made Route 53 zone as an exception, or add a task to import it.
3. Use Node.js 24.

**Beads that change if rejected.** Almost all infrastructure work: `3x3` epic, `qk1`, `d8b`, `dpc`, `yj8`, `zsm`, `kx8`, `2kl`, `5hx`, `7pe`, `9lj`, `qq7`, `3sv.1`, `pkt`, `b94`.

## 0003. AWS account structure

**Summary.** Turn the existing account into an organization's management account that holds only billing. Create `log-archive`, `security`, `dev`, `staging` and `prod` accounts. People sign in through IAM Identity Center with MFA. GitHub deploys through OIDC roles. SCPs deny leaving the organization, turning off logging, and regions other than us-east-1 and us-west-2. Budgets in every account.

**How reality differs.**

| ADR 0003 says | What exists |
| --- | --- |
| Turn the current account into the management account | An AWS Organization already exists, with its own management account. It also holds accounts that have nothing to do with Supply Checkout. |
| Confirm Identity Center is an organization instance | It is the organization's existing instance, shared with other work. It can grant access to new member accounts. |
| Accounts named `dev`, `staging`, `prod`, `log-archive`, `security` | Only `supply-checkout-prod` exists. No dev, staging, log-archive or security account yet. |
| CLI profiles `supply-dev`, `supply-staging`, `supply-prod`, made with `aws configure sso` | Profiles `supply-mgmt` and `supply-prod` exist, written by hand. `aws configure sso` fails without a real terminal. |
| Humans get read-only prod access (0012) | The owner's user has `AdministratorAccess` on prod today. Fine for setup; change it before launch. |

**Risks and costs.**

- SCPs attached at the organization root would hit the unrelated accounts. Attach them to a Supply Checkout OU.
- GuardDuty and Security Hub allow **one delegated administrator per organization**. If the organization already has one, a new `security` account can't take that role. If it becomes the admin, it sees the unrelated accounts too.
- An organization CloudTrail logs every account in the organization, not just these.
- Five accounts, each with GuardDuty, Security Hub and Config in two regions, cost about $10–25 a month, not "pennies".

**Open questions.**

- Does the organization already have log-archive and security accounts? If yes, reuse them, or keep Supply Checkout's own and skip organization-wide delegation.
- Are separate `log-archive` and `security` accounts worth it at this size? One `supply-checkout-audit` account could hold logs and backups for now.

**Recommendation: Accept with changes.** Rewrite the decision to:

1. Create a `Supply Checkout` OU in the existing organization. Put `supply-checkout-dev`, `supply-checkout-staging` and the existing `supply-checkout-prod` in it.
2. Attach the SCPs to that OU only.
3. Decide on log-archive and security: reuse the organization's, or one audit account for Supply Checkout.
4. Use the existing Identity Center instance. Add permission sets (Admin, Developer, ReadOnly) and a break-glass role.
5. Record the real profile names and the "write profiles by hand" step.

**Beads that change.** Even if accepted, rewrite `qbc` (its description still says to turn the current account into the management account). Also touch `5ik` (OIDC per account), `edn` (organization trail, delegated admin, SCP target), `8x1` (backup target account), `jxq` (budgets per account), `m64` (delegated dev and staging subdomains), `qq7` (dev and staging accounts), `4p1` (infosec policy). If rejected (one account), all of these shrink and `4p1` must explain the weaker separation.

## 0004. Runtime adapter

**Summary.** Keep one copy of the app. A `runtime/` layer provides `window.claude` in two builds: `claude` (the artifact, unchanged) and `aws` (our API, Cognito, receipt endpoint). Move to a small Vite project with no UI framework. Replace read-then-write `bumpStock` with an `increment` in the AWS build.

**Risks and costs.** No AWS cost. The adapter's live-update behavior (reconnects, conflicts, offline) is the riskiest new code; 0004 already calls for contract tests (`9t6`). The coverage gate reports gaps by `index.html` line. After the Vite split, that tooling has to map to source modules.

**Open questions.** None blocking. The artifact build keeps the old non-atomic stock update. That is acceptable only while the family business stays on the artifact.

**Recommendation: Accept.**

**Beads that change if rejected.** `al8`, `a2b`, `3q9`, `9t6`, `ig9`, `y31`, `nj8`. A fork or rewrite would add a new epic and drop the reuse of the Playwright suites.

## 0005. Multi-tenant DynamoDB

**Summary.** One on-demand table, PITR, deletion protection, customer-managed KMS key, global table. Everything a team owns shares `TEAM#<teamId>`. The server sets `teamId` from verified membership. Only a `TeamContext` built by the authorizer can read or write. IAM `dynamodb:LeadingKeys` is a second guard. One item per sheet.

**Risks and costs.** Close to $0 at small scale. Replicated writes cost about double. The KMS key is $1 a month per region.

**Open questions and inconsistencies.**

- **Sheet sort key.** `SHEET#<date>#<id>` puts the date in the key. The app lets users edit a sheet's date (the `fDate` field), and it reads sheets by ID (`collection("sheets").doc(id)`). A date change means delete and re-insert in a transaction, and a read by ID needs the date. Use `SHEET#<id>` and sort by date with a local secondary index, or keep a lookup item.
- **`LeadingKeys`.** A Lambda's execution role is fixed, so it can't be limited to one caller's team. The guard needs per-request credentials: `AssumeRole` with a session tag for the team, cached per team. That adds latency and code. Decide if it's worth it for MVP or a later hardening step.
- `USER#`, `STRIPE#` and `WEBHOOK#` items are outside any team partition. The teams and billing functions need their own narrower policies.
- The nightly S3 export for Athena reports has no bead. Fine to defer.

**Recommendation: Accept with changes.**

1. Change the sheet key to `SHEET#<id>`, with an index for date order.
2. Spell out how `LeadingKeys` works (session tags), or mark it post-MVP.

**Beads that change if rejected.** `yj8`, `d8b`, `3q9`, `wxx`, `2kl`, `5tp`, `l5y`, `dj6`, `b1h`, `zuv`, `8x1`, `b94`, `srp`. Aurora would add about $45+ a month per region.

## 0006. API and live updates

**Summary.** An HTTP API with a Cognito JWT authorizer and a few Lambdas (`data`, `teams`, `billing`, `receipts`). Live updates go through AppSync Events, one channel per team, with a Lambda authorizer checking membership. A DynamoDB Streams consumer in each region publishes change events, so writes from either region (and from Stripe webhooks) reach every client. Writes carry a `version`. A conflict returns 409. Polling is the fallback.

**Risks and costs.** Pay per request and per message. Pennies at small scale. Reconnect and resync logic lives in the adapter.

**Open questions.**

- Phase 2: check that one AppSync custom domain (`realtime.<domain>`) can sit behind Route 53 latency routing in two regions. AppSync custom domains have their own certificate and region rules. If not, clients may need two regional endpoints and their own failover.
- An HTTP API has a 30-second timeout. That matters for receipts (see 0008), not for data routes.

**Recommendation: Accept.**

**Beads that change if rejected.** `d8b`, `dpc`, `3q9`, `9t6`, `w2t`, `d79`.

## 0007. Identity with Cognito

**Summary.** Cognito user pool, Essentials tier, Managed Login. Email code or password, passkeys, Sign in with Apple and Google. MFA optional, but required for owners before billing changes. 60-minute tokens and a 30-day rotating refresh token in an HttpOnly cookie. Roles live in DynamoDB, not Cognito groups. Self-serve account deletion. The pool lives only in us-east-1.

**Risks and costs.** Free up to 10,000 monthly active users on Essentials (verify current terms). The us-east-1-only pool caps multi-region uptime: new sign-ins and refreshes stop when us-east-1 is down. `18w` studies this.

**Open questions.**

- **Sign in with Apple needs a paid Apple Developer account**, even on the web. That account needs the business entity and a D-U-N-S number (`ar0`, which can take weeks). Apple sign-in is only required once the iOS app offers Google sign-in. Consider deferring Apple sign-in to the iOS app (phase 2) so it doesn't block MVP.
- **Owner-only MFA.** Cognito can't require MFA for some users by role. It needs custom code, such as a check that the owner has MFA set up, or a pre-token-generation trigger that adds a claim. Decide whether a passkey counts as MFA.
- **Refresh token in an HttpOnly cookie** means the code-for-token exchange must run on our server (a small token endpoint), not in the browser. No bead names that endpoint. Add it to `zsm` or `a2b`.

**Recommendation: Accept with changes.**

1. Move Sign in with Apple to the iOS app work unless the Apple account is ready first.
2. Describe how owner MFA is enforced.
3. Name the token endpoint in a bead.

**Beads that change if rejected.** `zsm`, `a2b`, `l5y`, `5tp`, `dj6`, `b1h`, `18w`, `a92`, `3zf`. Auth0 or Clerk would cost about $0.02–0.05 per active user and add a data processor.

## 0008. Receipt reading on Bedrock

**Summary.** A `receipts` Lambda behind the API calls Claude on Bedrock with `AnthropicBedrockMantle` from `@anthropic-ai/bedrock-sdk`. Start with Claude Haiku 4.5. Run a 30–50 receipt eval against Claude Sonnet 5 and pick the cheapest model that matches. Structured outputs (`output_config.format`), prompt caching, photos resized on the phone and not stored. Guardrails: membership, active plan, monthly team limit, per-user rate limit, 60-second timeout, token logging.

The client class, the `anthropic.` model ID prefix, structured outputs on Bedrock, and the list prices ($1/$5 Haiku 4.5, $2/$10 Sonnet 5 per million tokens) all check out.

**Risks and costs.**

| Model | Per receipt | At the 200/team limit | Share of a $9 Starter team |
| --- | --- | --- | --- |
| Haiku 4.5 | about $0.005–0.007 | about $1.40 | about 16% |
| Sonnet 5 | about $0.01–0.015 | about $3.00 | about 33% |

If Sonnet wins the eval, 200 receipts a month is too generous for $9. Bedrock sets its own prices. Regional (in-US) inference can cost more than global cross-region inference.

**Open questions and inconsistencies.**

- **Timeout.** An API Gateway HTTP API stops waiting after 30 seconds. The ADR's 60-second timeout can't happen through it. Set the model call to about 25 seconds, or use a Lambda function URL or an async job for slow reads.
- **Caching.** Haiku 4.5 only caches a prefix of 4,096 tokens or more. `RECEIPT_PROMPT` alone is well under that, so "instructions first with a cache breakpoint" won't cache on Haiku. Put the breakpoint after the inventory list, and check `cache_read_input_tokens` in the eval.
- The team setting to keep photos in S3 has no bead. Fine to defer.

**Recommendation: Accept with changes.**

1. Set the timeout under 30 seconds, or pick another integration.
2. Move the cache breakpoint after the inventory.
3. Tie the receipt limit to the chosen model (`akz` already checks this).

**Beads that change if rejected.** `i1d` epic, `fy9`, `kx8`, `4gz`, `4xz`, `wxx`, `3zf` (subprocessors), `akz` (limits), `tk4` (Bedrock outage runbook).

## 0009. Billing with Stripe

**Summary.** Stripe Billing is the source of truth for money; our table is the source of truth for access. Starter is $9 a month with 3 seats, then $3 per seat, 200 receipts, annual with 2 months free, 14-day trial with no card. Checkout and the Customer Portal (PCI SAQ A). Stripe invoices. One-time payments, subscription schedules, pay by invoice, Stripe Tax. Webhooks go through SQS. Grace and read-only rules.

**Risks and costs.**

- A $9 charge pays 2.9% + $0.30 = $0.56, or 6.2%. Stripe Billing adds about 0.7% of billing volume. Stripe Tax adds about 0.5% where we collect tax. So about 7–7.5% per monthly Starter charge. Annual ($90) is about 4.5%. ADR 0013 says "about 4–6% for Stripe"; that is low for monthly plans.
- "$3 per user per month" is the headline, but a one-person team pays $9. `akz` decides this.

**Open questions and inconsistencies.**

- One-time payments (`zke`) and scheduled payments and pay by invoice (`90v`) are labeled `mvp`. Neither is needed for a first paying team. Move them to phase 2.
- Webhooks are "served in both regions" (and so is `2kl`), but MVP serves only from us-east-1 (0010, `b94`).
- Sales tax on SaaS: many states don't tax it, and most economic-nexus thresholds are about $100,000 in sales. Early on, `3ch` may only mean the home state.

**Recommendation: Accept with changes.**

1. Correct the fee figures (here and in 0013).
2. Move `zke` and `90v` to phase 2.
3. Make webhooks single-region for MVP.

**Beads that change if rejected.** `8jc` epic, `dri`, `x0l`, `121`, `2kl`, `qdx`, `eja`, `l50`, `90v`, `zke`, `3ch`, `akz`, `8jc.5`, `21q`. Paddle or Lemon Squeezy would cost about 5% + $0.50, roughly 10% of a $9 charge.

## 0010. Active-active in two regions

**Summary.** Run everything in us-east-1 and us-west-2. Route 53 latency routing with health checks, CloudFront origin failover, global table, a home region per team that takes its writes, local Bedrock, replica secrets, SES in both regions. RTO under 5 minutes, RPO about a second. Quarterly game day. MVP ships "multi-region-ready"; the second region's API and failover come after launch.

**Risks and costs.**

- Roughly doubles fixed cost (canaries, WAF origins, security services, staging). See the cost table.
- Home-region write forwarding (`9mn`) is the hardest code in the design.
- Cognito lives only in us-east-1, the region most likely to have an outage. While it's down, new sign-ins and refreshes stop anyway. Active-active mostly protects users who are already signed in.

**Inconsistencies.** The phasing says MVP runs from us-east-1. But several `mvp` beads already build the second region:

- `qk1`: S3 in both regions with replication and an origin group
- `2kl`: webhooks served in both regions
- `fy9`: Bedrock enabled in both regions in dev, staging and prod
- `m64`: SES and ACM in both regions
- `dri`: replicated Stripe secrets
- `pkt`, `3sv.1`: canaries and alarms in each region
- `qq7`: staging in both regions; prod us-west-2 then us-east-1
- `docs/architecture/README.md` and `docs/journeys.md` both assume two live regions

**Recommendation: Accept with changes.** Keep active-active as the phase-2 goal. For MVP, keep only what's hard to add later: region-parameterized stacks, the global table with both replicas, and `homeRegion` on every team. Move every other second-region item in the beads above to phase 2 (under `d79`). Revisit the end state after `18w` reports on sign-in.

**Beads that change if rejected (single region for good).** `72d` epic, `b94`, `yj8` (no replica), `d79`, `9mn`, `ntf`, `18w`, plus the two-region parts of `qk1`, `2kl`, `m64`, `fy9`, `dri`, `pkt`, `3sv.1`, `qq7`, `tk4`.

## 0011. Mobile apps with Capacitor

**Summary.** iOS and Android apps wrap the same web bundle with Capacitor. Native plugins for camera, barcode scanning, secure token storage, share sheet, deep links, and a browser for Stripe. fastlane builds on GitHub Actions to TestFlight and Play internal. Billing stays on the web (0013). In-app account deletion and store privacy forms.

**Risks and costs.** Apple Developer $99 a year, Google Play $25 once. macOS CI runners cost about 10 times Linux minutes. All phase 2.

**Open questions.**

- It says "in-app browser" for Stripe; 0013 says "system browser (Safari View Controller / Chrome Custom Tab)". Use the 0013 wording.
- Cognito Managed Login and passkeys inside a Capacitor app need app links and associated domains. Worth a line in `ac2`.

**Recommendation: Accept.** It's phase 2, so accepting now costs nothing and unblocks planning.

**Beads that change if rejected.** `005` epic's native work: `ac2`, `a92`, `jh0`, `oz0`, `ve3`, `8jc.5`, `bbp`, and the store reasons in `b1h` and `1gm`.

## 0012. CI/CD, releases and rollbacks

**Summary.** PRs run the existing gates plus infra tests, `cdk-nag`, `cdk diff`, CodeQL and a preview stack in dev. Merges build once and deploy to staging in both regions, then run the journey tests. Release-please tags promote the same build to prod, us-west-2 first. Lambda canaries (10% for 5 minutes) with alarm rollback. Web rollback by switching a version pointer. Expand/contract data changes. AppConfig flags for mobile.

**Risks and costs.**

- A full preview stack per PR (Cognito, table, AppSync, CloudFront) is slow. A new CloudFront distribution takes minutes to create and longer to delete. Previews for several open PRs add up.
- Staging in both regions doubles staging's fixed cost.

**Inconsistencies.**

- `docs/journeys.md` runs the core canary only 8am–8pm Eastern. Step 4 relies on canaries after each prod deploy. A release after 8pm gets no synthetic check. Low overnight traffic also gives the 5-minute Lambda canary almost no signal. Run the canary once on demand after every deploy, whatever the hour.
- "Prod us-west-2 first" doesn't apply while MVP serves only us-east-1.
- 0012 says humans get read-only prod access; today the owner has admin (see 0003).

**Recommendation: Accept with changes.**

1. Run the core canary on demand after every prod deploy.
2. Previews: share one CloudFront and Cognito in dev, or run backend-only previews.
3. Staging in one region until the second region is live.

**Beads that change if rejected.** `pbp` epic, `qq7`, `9lj`, `y31`, `5ik`, `pkt`, `o60`, `1gm`, `ve3`.

## 0013. Web billing only

**Summary.** Stripe is the only billing system. No App Store or Google Play in-app purchase. Owners choose a plan in the app and pay on Stripe Checkout in the system browser, with Apple Pay and Google Pay. Where store rules don't allow the link, the app shows no prices and says "Manage your plan at `<domain>`". Only owners see plans. The link-out sits behind a feature flag.

**Risks and costs.** One more screen than in-app purchase. Store link-out rules are still changing. It avoids about 16% store and RevenueCat fees, seat bundles, and consumer-only receipts.

**Open questions and inconsistencies.**

- `CLAUDE.md` already lists this as decided, but its status is still Proposed.
- "About 4–6% for Stripe" is low for a $9 monthly charge. It's about 7% with Billing and Tax fees (see 0009). The conclusion still holds.
- The ADR says "a spike bead confirms both stores' current rules". No such bead exists. `8jc.5` only checks approval at the end.
- The flag depends on `1gm` (AppConfig), which is phase 2. Fine, since the apps are phase 2 too.

**Recommendation: Accept.** Fix the fee figure, and add the store-rules spike bead ahead of `8jc.5`, `a92` and `jh0`.

**Beads that change if rejected.** Reopen the closed RevenueCat beads (`8jc.1`–`8jc.4`, `8jc.6`). Rework `8jc.5`, `a92`, `jh0`, `121` and `x0l` to handle more than one billing source.

## Bead follow-ups (if the recommendations are accepted)

These are suggestions for the owner. This brief doesn't change any bead.

- Rewrite `qbc` for the existing organization and a Supply Checkout OU (0003).
- Move `zke` and `90v` to phase 2 (0009).
- Move second-region work in `qk1`, `2kl`, `fy9`, `m64`, `dri`, `pkt`, `3sv.1` and `qq7` to phase 2 (0010).
- Add a store-rules spike before `8jc.5` (0013).
- Add the token endpoint to `zsm` or `a2b`, and decide on Sign in with Apple timing (0007).
- Add an on-demand post-deploy canary run to `9lj` or `pkt` (0012).
- Update the cost estimate in `docs/architecture/README.md`.
