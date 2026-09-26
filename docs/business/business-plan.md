# Supply Checkout business plan

> **DRAFT — not reviewed by a lawyer / owner; not in effect.**
> Every number here is an estimate. Prices from vendors were not re-checked against their current pricing pages. Check them before making decisions.

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
- Stripe's fixed $0.30 per charge makes a single $3 charge expensive (about 13% in fees), so the starting proposal from [ADR 0009](../adr/0009-billing-stripe.md) is:
  - **Starter**: $9/month includes 3 seats, then $3 per extra seat. 200 receipts per team per month.
  - **Annual**: 2 months free.
  - **Trial**: 14 days, no card.
- Web billing only ([ADR 0013](../adr/0013-web-billing-only.md)), so there are no app store fees.
- Bead `supply-checkout-akz` sets the final tiers, receipt limits, viewer seat price and whether there is a free plan. This section will point to that decision when it's made.

## 6. Unit economics

### 6.1 Assumptions

| Item | Assumption | Source |
| --- | --- | --- |
| Stripe card fee | 2.9% + $0.30 per charge | ADR 0009 |
| Stripe Billing fee | about 0.7% of billed amount | Stripe pricing; check |
| Stripe Tax | about 0.5% per transaction, once turned on | Stripe pricing; check. Not in the tables below. |
| Receipt reading, Haiku 4.5 | about $0.006 per receipt | ADR 0008 |
| Receipt reading, Sonnet 5 | about $0.015 per receipt | ADR 0008 (worst case) |
| Receipts per team per month | 50 (1 seat), 100 (3 seats), 200 (10+ seats, capped) | guess; measure in the pilot |
| Cognito | free for the first 10,000 monthly active users, then about $0.015 each | AWS pricing; check |
| Other AWS per team (Lambda, API Gateway, DynamoDB global table writes, AppSync Events, SES, CloudWatch logs) | about $0.10 for a 1–3 seat team, rising to about $1 for 50 seats | rough; set up billing metrics per team to confirm |
| Fixed AWS, prod (both regions) | $20–30/month | architecture README: Route 53, KMS, Secrets Manager, Synthetics, WAF |
| Fixed AWS, staging and dev | $15–25/month | architecture README |
| Tooling and domain | about $15/month | domain, email, small SaaS tools |
| Business overhead | about $150/month | registered agent, state fees, accounting, insurance; wide range, owner to confirm |

### 6.2 Margin per team (Starter plan, monthly, Haiku)

| Seats per team | Revenue | Stripe (card + Billing) | Receipts | Other AWS | Variable cost | Margin | Margin % | Margin per seat |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | $9.00 | $0.62 | $0.30 | $0.10 | $1.02 | $7.98 | 89% | $7.98 |
| 3 | $9.00 | $0.62 | $0.60 | $0.15 | $1.37 | $7.63 | 85% | $2.54 |
| 10 | $30.00 | $1.38 | $1.20 | $0.30 | $2.88 | $27.12 | 90% | $2.71 |
| 50 | $150.00 | $5.70 | $1.20 | $1.00 | $7.90 | $142.10 | 95% | $2.84 |

Stripe's share is 6.9% at the smallest plan, inside the 10% target in bead `supply-checkout-akz`.

**Worst case**: a 1-seat team that reads all 200 receipts with Sonnet 5 costs about $0.62 + $3.00 + $0.10 = $3.72, leaving $5.28 (59%). The receipt limit is what keeps this bounded.

**A single $3 seat with no minimum** would pay $0.39 to Stripe card fees plus $0.02 to Billing (about 14%). This is why the minimum charge matters.

### 6.3 Break-even

| Fixed costs per month | Amount |
| --- | --- |
| AWS (prod, staging, dev) | $35–55 |
| Tooling and domain | $15 |
| **Running costs** | **$50–70** |
| Business overhead | $150 |
| **All-in** | **$200–220** |

- Running costs only: **about 7–9 paying teams** (about 21–27 paying seats at 3 seats per team).
- All-in: **about 28 paying teams** (about 85–110 paying seats at 3–4 seats per team).
- Neither figure pays for the owner's time.

### 6.4 24-month sketch

Illustrative only. Assumes an average team of 4 seats ($12/month), 12% of revenue to variable costs, and all-in fixed costs of $210/month from launch.

| Month | Paying teams | Monthly revenue | Monthly cost | Monthly profit |
| --- | --- | --- | --- | --- |
| 3 (pilot, free) | 0 | $0 | $210 | −$210 |
| 6 | 15 | $180 | $232 | −$52 |
| 12 | 50 | $600 | $282 | $318 |
| 18 | 120 | $1,440 | $383 | $1,057 |
| 24 | 250 | $3,000 | $570 | $2,430 |

Growth this fast needs a working sales channel (section 7). The pilot's job is to show whether it exists.

A cost-model spreadsheet (bead `supply-checkout-keh` acceptance criteria) is still to be built from these tables.

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
