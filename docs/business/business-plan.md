# Supply Checkout business plan

> **DRAFT — not reviewed by a lawyer / owner; not in effect.**
> Every number here is an estimate. Vendor prices were re-checked against their official pricing pages on 2026-09-26 (section 6.1). Usage figures are still guesses until the pilot measures them.

## 1. Summary

Supply Checkout helps small crews track the supplies they take to client jobs and bring back. Each job gets a sheet. Crews scan items out and back in. The sheet shows what was used and what to charge the client. Photographing a store receipt adds the items to inventory or straight to a job.

It started as a tool for one family business, running as a claude.ai artifact. The plan is to sell it as a multi-tenant web and mobile product on AWS, at about $3 per user per month, billed through Stripe.

## 2. Target customer

Small trade and service businesses, 1 to 20 people, that carry supplies to client sites and bill clients for them. For example:

- residential and commercial cleaning crews
- property maintenance and handyman crews
- small contractors (painting, flooring, repairs)
- short-term rental turnover teams

The **buyer** is the owner or office manager. They set up the team on the web and pay. The **users** are crew members, mostly on phones.

## 3. Problem

- Supplies leave storage and don't come back, or come back unrecorded.
- Clients are billed from memory or not at all. Small items (bags, chemicals, filters, fasteners) add up.
- Receipts from store runs sit in trucks. Typing them into a spreadsheet takes time, so it doesn't happen.
- Storage counts drift, so crews run out mid-job.
- Existing tools are too big (full field-service suites) or too generic (inventory apps with no idea of a client job).

## 4. Product

What exists today (in the artifact):

- **Sheets** per client and date: check out, return, totals, CSV export.
- **Inventory** with prices and storage counts that move with checkouts and returns.
- **Barcode scanning**, plus items without barcodes.
- **Receipt reading**: photo in, line items out, matched to inventory, assigned to jobs, reviewed before saving.

What the MVP adds: teams and roles, sign-in, live sync across devices, subscriptions, invoices, data export, and the reliability and security work in [the architecture](../architecture/README.md).

## 5. Pricing hypothesis

- Headline: **about $3 per user per month**.
- Stripe's fixed $0.30 per charge makes a single $3 charge expensive (13.6% in fees, section 6.3), so the starting proposal from [ADR 0009](../adr/0009-billing-stripe.md) is:
  - **Starter**: $9/month includes 3 seats, then $3 per extra seat. 200 receipts per team per month.
  - **Annual**: 2 months free.
  - **Trial**: 14 days, no card.
- Web billing only ([ADR 0013](../adr/0013-web-billing-only.md)), so there are no app store fees.
- Bead `supply-checkout-akz` sets the final tiers, receipt limits, viewer seat price and whether there is a free plan. This section will point to that decision when it's made.

## 6. Unit economics

The numbers in this section come from the cost model spreadsheet, **[cost-model.xlsx](cost-model.xlsx)**. Every input is a named cell on its Assumptions sheet with a link to its source, and every result is a live formula, so changing an input (price, receipts per seat, overhead, team size) updates the tables. The sheets are:

- **Assumptions**: every input, its unit and its source
- **Fixed AWS**: fixed monthly cost per environment
- **Per-seat margin**: margin at 1, 3, 10 and 50 seats per team
- **Break-even**: fixed costs and the paying seats needed to cover them
- **24-month projection**: month-by-month teams, revenue, costs and profit

The model prices seats at a straight **$3 per user per month**. It also has a switch for the $9 Starter minimum from section 5. Stripe's $0.30 fixed fee is charged once per team per month, so the model spreads it over the team's seats.

### 6.1 Assumptions and price check

Prices were checked on **2026-09-26** against the official pricing pages. The spreadsheet has the full list.

| Item | Price used | Source | Change since the first draft |
| --- | --- | --- | --- |
| Stripe card fee | 2.9% + $0.30 per charge (+1.5% for international cards, 0 assumed) | [Stripe pricing](https://stripe.com/pricing) | None |
| Stripe Billing | 0.7% of billing volume | [Stripe pricing](https://stripe.com/pricing) | None (now confirmed) |
| Stripe Tax | 0.5% per transaction, off until the business registers to collect tax | [Stripe pricing](https://stripe.com/pricing) | None (now confirmed) |
| Claude Haiku 4.5 | $1 / $5 per million input/output tokens | [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) | None |
| Claude Sonnet 5 | $2 / $10 per million tokens | same | The launch price is now the standard price. The rise to $3 / $15 planned for 2026-09-01 was cancelled |
| Bedrock regional endpoint | **+10%** over global endpoints for Claude 4.5 and later models | [Claude pricing: cloud platforms](https://platform.claude.com/docs/en/about-claude/pricing) | **New.** Keeping inference in the US uses a regional (or US) endpoint, so the model adds 10% |
| Sonnet 5 tokenizer | about **30% more tokens** for the same text | same | **New.** Applies to Claude 4.7 and later, including Sonnet 5 |
| Cost per receipt | Haiku 4.5 **$0.0067**, Sonnet 5 **$0.0164** (1,600 image + 2,000 prompt + 500 output tokens, no cache discount) | computed | Up from about $0.006 and $0.015 because of the two changes above |
| Receipts | 20 per seat per month, capped at 200 per team | guess; measure in the pilot | Now per seat instead of per team size |
| Cognito Essentials | 10,000 MAU free each month (no expiry), then $0.015 per MAU | [Cognito pricing](https://aws.amazon.com/cognito/pricing/) | None |
| Pay-per-use AWS per seat | about **$0.05 per seat per month**: API Gateway HTTP $1/M, Lambda $0.20/M plus Arm duration, DynamoDB on-demand $0.625/M writes and $0.125/M reads, AppSync Events $1/M operations and $0.08/M connection-minutes, SES $0.10 per 1,000, CloudWatch Logs $0.50/GB, all ×2 for safety | [API Gateway](https://aws.amazon.com/api-gateway/pricing/), [Lambda](https://aws.amazon.com/lambda/pricing/), [DynamoDB](https://aws.amazon.com/dynamodb/pricing/on-demand/), [AppSync](https://aws.amazon.com/appsync/pricing/), [SES](https://aws.amazon.com/ses/pricing/), [CloudWatch](https://aws.amazon.com/cloudwatch/pricing/) | Was a flat guess of $0.10 to $1 per team. Now built from usage estimates |
| Synthetics canaries | $0.0012 per run after 100 free runs. The core canary runs every 5 minutes from 8am to 8pm, and the sign-up canary every 15 minutes, about 7,200 billed runs | [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/) | The official page lists the free runs, but its paid rate didn't load when checked. $0.0012 is the widely reported rate. Confirm it in the AWS Pricing Calculator |
| AWS WAF | $5 per web ACL + $1 per rule or managed group + $0.60 per million requests | [WAF pricing](https://aws.amazon.com/waf/pricing/) | The draft said "about $6+". With 4 rules it's about $9.60 |
| Route 53 | $0.50 per hosted zone. Basic health checks on AWS endpoints are free (first 50); the HTTPS option adds about $1. Queries are $0.40 per million | [Route 53 pricing](https://aws.amazon.com/route53/pricing/) | None |
| KMS / Secrets Manager | $1 per key per month / $0.40 per secret per month | [KMS](https://aws.amazon.com/kms/pricing/), [Secrets Manager](https://aws.amazon.com/secrets-manager/pricing/) | None |
| CloudFront | Pay-as-you-go, pennies at this volume. Flat-rate plans now exist (Free $0, Pro $15 with WAF included) | [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) | **New option.** The Pro plan could replace the separate WAF charge; not assumed |
| App store developer fees | Apple $99 a year and Google Play $25 once, only when the native apps ship (phase 2). No store commission, because billing is web only ([ADR 0013](../adr/0013-web-billing-only.md)) | [Apple](https://developer.apple.com/programs/whats-included/), [Google Play](https://support.google.com/googleplay/android-developer/answer/6112435) | Now itemized |
| Tooling and domain | about $15 a month | estimate | None |
| Business overhead | about $150 a month | estimate; owner to confirm | None |

### 6.2 Fixed AWS cost per environment

For the MVP in us-east-1 only ([ADR 0010](../adr/0010-multi-region-active-active.md)), with no customers:

| Environment | Per month | Largest items |
| --- | --- | --- |
| Prod | **$30.34** | Synthetics canaries ($9.64 with side costs), WAF ($9.60), CloudWatch alarms and metrics ($3.50), KMS ($2) |
| Staging | **$14.80** | WAF ($9.06), KMS ($2), Secrets Manager ($1.20) |
| Dev | **$3.84** | KMS, secrets, hosted zone |
| **All environments** | **$48.98** | |

The draft estimated $20–30 for prod in **both** regions. The MVP now has one region, and prod alone is about $30, mostly because the WAF and canary estimates went up. Phase 2 (us-west-2) roughly doubles fixed AWS to about $98 a month.

### 6.3 Margin per seat

At a straight $3 per seat with Claude Haiku 4.5 (monthly, per team):

| Seats per team | Revenue | Stripe (card + Billing) | Receipts (Bedrock) | AWS pay-per-use | Variable cost | Margin | Margin % | Stripe share | **Margin per seat** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | $3.00 | $0.41 | $0.13 | $0.05 | $0.59 | $2.41 | 80% | 13.6% | **$2.41** |
| 3 | $9.00 | $0.62 | $0.40 | $0.15 | $1.18 | $7.82 | 87% | 6.9% | **$2.61** |
| 10 | $30.00 | $1.38 | $1.34 | $0.51 | $3.23 | $26.77 | 89% | 4.6% | **$2.68** |
| 50 | $150.00 | $5.70 | $1.34 | $2.55 | $9.59 | $140.41 | 94% | 3.8% | **$2.81** |

- **The fixed $0.30 Stripe fee is what hurts a one-seat team.** It's $0.30 per seat at 1 seat, $0.10 at 3, $0.03 at 10 and under a cent at 50. At 1 seat, Stripe takes 13.6% of revenue, above the 10% target in bead `supply-checkout-akz`.
- **With the $9 Starter minimum** (3 seats billed even for 1 user), a one-person team pays $9 and leaves $8.19 margin (91%). Teams of 3 or more are unchanged.
- **Worst case** (Sonnet 5, every team reads its full 200-receipt cap): the receipts cost $3.28 a team, so a one-seat team at straight $3 **loses $0.74 a month**. A 3-seat team keeps $1.65 per seat, a 10-seat team $2.48 and a 50-seat team $2.77. A per-seat receipt limit (for example 20 × seats, at least 20), or the $9 minimum, keeps small teams profitable even on Sonnet.

### 6.4 Break-even

| Fixed costs per month | Amount |
| --- | --- |
| AWS (prod, staging, dev) | $48.98 |
| Tooling and domain | $15.00 |
| App store fees (phase 2 only) | $0.00 |
| **Running costs** | **$63.98** |
| Business overhead | $150.00 |
| **All-in** | **$213.98** |

Each paying seat contributes about $2.63 a month toward fixed costs (straight $3 pricing, Haiku, teams of 4 on average).

> **Break-even: 25 paying seats (7 teams of 4) covers running costs. 82 paying seats (21 teams of 4) covers all-in costs including business overhead.** Neither figure pays for the owner's time.

Team size barely moves this. At 1, 3, 10 or 50 seats per team, break-even is 27, 25, 24 or 23 seats for running costs, and 89, 83, 80 or 77 seats all-in. Phase 2's second region adds about $49 a month, which takes about 19 more seats.

### 6.5 24-month projection

This is illustrative only. The spreadsheet's growth inputs are labeled as **assumptions, not forecasts**:

- a 3-month free pilot with 5 teams, 60% of which convert
- 4 new paying teams in the first paid month, with new sign-ups growing 12% a month
- 3% monthly churn, 4 seats per team, straight $3 pricing, Haiku

| Month | Paying teams | Paying seats | Monthly revenue | Monthly cost | Monthly profit |
| --- | --- | --- | --- | --- | --- |
| 3 (pilot, free) | 0 | 0 | $0 | $218 | −$218 |
| 6 | 16 | 64 | $192 | $238 | −$46 |
| 12 | 57 | 228 | $684 | $298 | $386 |
| 18 | 132 | 528 | $1,584 | $408 | $1,176 |
| 24 | 276 | 1,104 | $3,312 | $620 | $2,692 |

On these assumptions, the first profitable month is month 7, cumulative profit turns positive in month 12, and the 24 months total about $16,800 in profit. Growth this fast needs a working sales channel (section 7). The pilot's job is to show whether it exists and to replace these guesses with measured numbers.

## 7. Go-to-market

1. **Pilot** (bead `supply-checkout-3ww`): the family business plus 3–5 other teams, free during the pilot. Measure receipts per team, seats per team, weekly active users, and whether sheets are used to bill clients.
2. **Referrals from pilot teams**: owners in these trades know each other. Offer a free month for each referred paying team.
3. **Local and trade channels**: cleaning and property-management associations, local business groups, Facebook groups for cleaning business owners, and supply stores where crews shop.
4. **Search**: short pages that answer specific searches, such as "track cleaning supplies per client" and "bill clients for job supplies".
5. **Self-serve only at first.** Sign-up, trial, checkout and cancellation all work without talking to anyone. Support is by email.

## 8. Competitors

Brief research; prices change often.

| Product | What it does | Price (approx.) | How we differ |
| --- | --- | --- | --- |
| **Sortly** | General inventory with barcodes and photos | Free for 1 user and 100 items; paid from about $24–49/month | Not built around client jobs; no receipt reading into jobs |
| **Chronotek** | Janitorial workforce and supply tracking | About $19/month plus $6 per employee, 5-employee minimum | Heavier, and priced at twice our per-user price |
| **Janitorial Manager** | Commercial cleaning operations, supply budgets per site | Custom, reportedly $500+/month | Built for larger contractors |
| **Aspire, ServiceM8, Jobber, Housecall Pro** | Full field-service suites (scheduling, quotes, invoices), some with materials on jobs | Tens to hundreds of dollars a month | We do one job well, cost less, and can sit alongside them |
| **Spreadsheets and paper** | What most small crews use now | Free | The real competitor. We have to be faster than a notebook |

Sources: [Workyard comparison](https://www.workyard.com/compare/cleaning-service-software), [Chronotek](https://www.chronotek.com/janitorial), [Janitorial Manager](https://www.janitorialmanager.com/work-management-system/supply-tracking-software/), [Sortly plans](https://help.sortly.com/hc/en-us/articles/31329803827867-Current-Sortly-Plans), [Aspire](https://www.youraspire.com/industries/cleaning-business-software).

## 9. Risks

| Risk | Effect | What we do |
| --- | --- | --- |
| Crews don't scan consistently | Sheets are wrong, owners stop trusting them | Make checkout faster than writing it down; measure in the pilot |
| Receipt reading gets things wrong | Wrong client charges | Review screen before saving; eval set to choose the model (bead `supply-checkout-4gz`) |
| Receipt costs above plan | Margin shrinks on heavy users | Per-team monthly limit, per-user rate limit, cost per team metric |
| Price too low to cover support time | Owner time is the real cost | Minimum charge per team; self-serve billing; revisit after the pilot |
| Small market or slow growth | Doesn't cover overhead | Low fixed costs; keep the family business running on the artifact regardless |
| Big suites add the same feature | Harder to win their customers | Target businesses too small for those suites |
| Security incident or data loss | Loss of trust, legal exposure | Team isolation, backups, security review and incident plan (beads `supply-checkout-nsn`, `supply-checkout-dgv`, `supply-checkout-8x1`) |
| Auto-renewal and privacy law | Fines, chargebacks | Terms written to strict state rules; online cancellation; privacy policy |
| App store rules on outside payment links | Can't link to checkout from the apps | Feature flag and plain-text fallback ([ADR 0013](../adr/0013-web-billing-only.md)) |
| Single owner and operator | Bus factor of one | Runbooks, automated rollbacks, canaries |

## 10. Milestones

All `mvp` beads roll up to `supply-checkout-jgl` (MVP live in AWS).

| # | Milestone | Beads |
| --- | --- | --- |
| 1 | Business ready to take money | entity `supply-checkout-ar0`, tiers `supply-checkout-akz`, terms `supply-checkout-rnh`, privacy `supply-checkout-3zf`, ADRs accepted `supply-checkout-y94` |
| 2 | AWS foundations | accounts `supply-checkout-qbc`, DNS and certificates `supply-checkout-m64`, DynamoDB `supply-checkout-yj8`, Cognito `supply-checkout-zsm`, budgets `supply-checkout-jxq` |
| 3 | App on AWS | Vite build `supply-checkout-al8`, runtime adapter `supply-checkout-a2b`, data API `supply-checkout-d8b`, live updates `supply-checkout-dpc`, roles `supply-checkout-dj6`, invites `supply-checkout-5tp` |
| 4 | Receipts on Bedrock | Bedrock access `supply-checkout-fy9`, receipt Lambda `supply-checkout-kx8`, limits `supply-checkout-wxx`, eval `supply-checkout-4gz` |
| 5 | Billing | Stripe setup `supply-checkout-dri`, Checkout with trial `supply-checkout-x0l`, webhooks `supply-checkout-2kl`, Customer Portal `supply-checkout-121`, access rules `supply-checkout-qdx` |
| 6 | Safe to run | CI/CD `supply-checkout-qq7`, rollbacks `supply-checkout-9lj`, observability `supply-checkout-7pe`, journey alarms `supply-checkout-3sv.1`, end-to-end tests `supply-checkout-o60`, security review `supply-checkout-nsn` |
| 7 | Launch | landing and pricing pages `supply-checkout-21q`, support email `supply-checkout-6qd`, MVP live `supply-checkout-jgl` |
| 8 | Pilot | `supply-checkout-3ww`: family business plus 3–5 teams |

## 11. Open questions for the owner

1. Is a 3-seat minimum ($9) right, or should single users pay less?
2. Are viewer seats free?
3. How many receipts does a real team read each month? The pilot should measure this before the limit is final.
4. What is the real monthly business overhead (insurance, accounting, state fees)?
5. Is the pilot free, discounted, or paid from day one?
6. Who handles support, and how many hours a week are available?
7. Should the receipt limit scale with seats (for example 20 per seat) instead of a flat 200 per team? With Sonnet 5, a one-seat team at the full cap costs more than it pays (section 6.3).
