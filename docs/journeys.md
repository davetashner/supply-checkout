# Customer journeys

These are the journeys Supply Checkout must never break. Each one lists who does it, the steps, what should happen, the tests that prove it works, and whether it is **critical**: blocked for even a few minutes, it stops crews working or stops us getting paid. The second half of this page lists the alarms that tell us when a journey is blocked in production.

When you add or change a feature, update the journey here, its tests, and its alarms in the same pull request.

**Status**
- **Tested**: works in today's app (the claude.ai artifact) and has automated tests.
- **Partly tested**: some steps exist and are tested; the rest are planned.
- **Planned**: needs the AWS version. The beads listed build it.

End-to-end tests of every journey against a deployed environment are `supply-checkout-o60`. Until then, "tests" below means the Playwright suites that run against the mock runtime (`tests/`).

## People

| Persona | Who they are | Role in the app |
| --- | --- | --- |
| **Owner** | Runs a small cleaning, maintenance or contracting business. Sets things up on a laptop, pays the bill. | Owner: everything, including billing and members |
| **Crew member** | Takes supplies from storage to client jobs, usually on a phone, often early in the morning. | Contributor: scan, check out, return, read receipts, edit sheets and inventory |
| **Bookkeeper** | Checks what was used and what to charge clients. | Viewer: sees everything, changes nothing |

## Journeys

| # | Journey | Persona | Critical | Status |
| --- | --- | --- | --- | --- |
| [J0](#j0-sign-in) | Sign in | Everyone | Yes | Planned |
| [J1](#j1-sign-up-and-start-a-trial) | Sign up and start a trial | Owner | Yes | Planned |
| [J2](#j2-set-up-the-inventory) | Set up the inventory | Owner | No | Partly tested |
| [J3](#j3-invite-the-crew) | Invite the crew | Owner, crew member | No | Planned |
| [J4](#j4-check-supplies-out-and-back-in) | Check supplies out and back in | Crew member | Yes | Tested |
| [J5](#j5-read-a-receipt) | Read a receipt | Crew member, owner | No | Tested (claude.ai); Bedrock planned |
| [J6](#j6-export-a-sheet-to-bill-a-client) | Export a sheet to bill a client | Owner, bookkeeper | No | Tested |
| [J7](#j7-subscribe-add-seats-and-see-invoices) | Subscribe, add seats and see invoices | Owner | Yes | Planned |
| [J8](#j8-a-payment-fails-and-is-fixed) | A payment fails and is fixed | Owner | Yes | Planned |
| [J9](#j9-a-viewer-can-see-but-not-change) | A viewer can see but not change | Bookkeeper | No | Tested; server-side roles planned |
| [J10](#j10-cancel-and-take-the-data) | Cancel and take the data | Owner | No | Planned |
| [J11](#j11-delete-an-account) | Delete an account | Anyone | No | Planned |
| [J12](#j12-choose-a-plan-in-the-mobile-app) | Choose a plan in the mobile app | Owner | No | Planned (phase 2) |

---

### J0. Sign in

**Persona:** everyone. **Critical:** every other journey starts here.

1. Open the app on a phone or laptop.
2. Sign in with an email code, a passkey, Apple or Google.
3. If the person belongs to more than one team, pick the team.

**Expected:** the team's sheets appear within 3 seconds. Staying signed in lasts 30 days on the same device. A person removed from a team no longer sees it on their next request.

**Status:** planned. `supply-checkout-zsm` (Cognito), `supply-checkout-l5y` (team switcher).

### J1. Sign up and start a trial

**Persona:** owner. **Critical:** no sign-ups, no new customers.

1. Visit supplycheckout.com, read the pricing page, tap **Start free trial**.
2. Sign up and accept the terms.
3. Name the team.

**Expected:** an empty team ready to use in under a minute, with a 14-day trial and no card needed. The terms acceptance time is stored.

**Status:** planned. `supply-checkout-21q` (landing and sign-up), `supply-checkout-zsm` (sign-in), `supply-checkout-l5y` (team creation), `supply-checkout-x0l` (trial).

### J2. Set up the inventory

**Persona:** owner.

1. Open **Inventory**, tap **+ Add item**.
2. Type or scan a barcode (or leave it blank), then enter the name, price and how many are in storage.
3. Edit or delete items later by tapping their row.

**Expected:** items appear in the list with storage counts, value per item and totals. Items without a barcode can be found by name when checking out.

**Status:** partly tested. Adding items works today. Creating the team first is planned (`supply-checkout-l5y`), as is importing an existing inventory (`supply-checkout-ig9`).

**Tests:** `inventory.spec.js` (all tests), `barcode.spec.js`: "an item's barcode can be scanned when adding it to inventory".

### J3. Invite the crew

**Persona:** owner, then crew member.

1. The owner opens **Members**, enters a crew member's email and picks **Contributor**.
2. The crew member gets an email, taps the link on their phone and signs up or signs in.

**Expected:** the email arrives within a minute. The link works once and expires after 7 days. The crew member sees the team's sheets right away, and the seat count on the subscription goes up.

**Status:** planned. `supply-checkout-5tp` (invites), `supply-checkout-5hx` (email), `supply-checkout-dj6` (roles), `supply-checkout-l50` (seats).

### J4. Check supplies out and back in

**Persona:** crew member. **Critical:** this is the job the app does every morning.

1. Create a sheet for the client and date, or open today's sheet.
2. Scan each item's barcode with the phone camera (or type the number, or pick an item that has no barcode) and choose how many.
3. Back from the job, switch to **Return**, scan what came back unused, and tap **Finished Return**.

**Expected:** each checkout takes storage counts down and each return puts them back. The sheet shows taken, returned, used and the charge. Other people's phones show the changes within 2 seconds. Nothing is lost if two people work on the same sheet.

**Status:** tested.

**Tests:**
- `app.spec.js`: "creates a sheet recording client, date and who prepared it"; "checks out a new barcode, returns part of it, and finishes the return"; "storage counts go down on checkout and back up on return"; "adds an item that has no barcode"; "returning the same item again adds to what's already been returned"
- `barcode.spec.js`: reading barcode photos, including when the photo can't be read
- `sheets.spec.js`: editing sheets and lines, picking and returning items without barcodes, reopening and deleting
- `concurrent.spec.js`: another person changing the same sheet at the same time
- `failures.spec.js`: failed saves leave the screen as it was

### J5. Read a receipt

**Persona:** crew member or owner, after buying supplies.

1. Tap **Scan receipt** and photograph the receipt.
2. Check each line: name, quantity, price, and the suggested inventory match.
3. Assign each line to a client (a new or existing sheet) or to **General inventory**, then tap **Save**.

**Expected:** lines appear within 60 seconds. Nothing is saved until **Save**. Client items go on the sheets at the receipt price, and storage items raise storage counts. If reading fails, the person can enter the items by hand.

**Status:** tested with claude.ai receipt reading. The Bedrock version is planned: `supply-checkout-kx8` (receipt Lambda), `supply-checkout-wxx` (limits).

**Tests:** `app.spec.js`: "receipt review merges duplicates and splits items between a client and storage"; `receipts.spec.js` (all tests); `resilience.spec.js`: failed reads, empty photos and resuming an unsaved review.

### J6. Export a sheet to bill a client

**Persona:** owner or bookkeeper.

1. Open a finished sheet.
2. Tap **Download CSV**.

**Expected:** a CSV named after the client and date, with each item's price, taken, returned, used and charge, and a total row.

**Status:** tested. Exporting all of a team's data is planned: `supply-checkout-zuv`.

**Tests:** `app.spec.js`: "exports a sheet as CSV"; `startup.spec.js`: "CSV export quotes commas and quotes, and names untitled sheets", "a declined download is silent", "a failed download explains".

### J7. Subscribe, add seats and see invoices

**Persona:** owner. **Critical:** this is how we get paid.

1. Before or at the end of the trial, open **Billing** and choose a plan and number of seats.
2. Pay on Stripe Checkout (card, Apple Pay or Google Pay).
3. Later, invite more people (seats go up) and open past invoices.

**Expected:** the team shows as active within a minute of paying. Adding a member updates the seat count with proration. Invoices are emailed and listed in the app with the company name.

**Status:** planned. `supply-checkout-x0l` (Checkout), `supply-checkout-2kl` (webhooks), `supply-checkout-121` (Customer Portal), `supply-checkout-eja` (invoices), `supply-checkout-l50` (seats).

### J8. A payment fails and is fixed

**Persona:** owner. **Critical:** if this breaks, paying customers lose access, or we give access away.

1. A renewal payment fails.
2. The owner sees a banner and gets an email. The team keeps full access for 7 days.
3. The owner updates their card in the Customer Portal.

**Expected:** after 7 days without payment the team becomes read-only. Nothing is deleted. As soon as payment succeeds, full access returns within a minute.

**Status:** planned. `supply-checkout-qdx` (access rules), `supply-checkout-2kl` (webhooks), `supply-checkout-5hx` (email).

### J9. A viewer can see but not change

**Persona:** bookkeeper.

1. Sign in and open sheets and inventory.

**Expected:** everything is visible. No scan, edit, delete or receipt controls appear, and the server refuses any write that is attempted anyway.

**Status:** tested in the UI. Server-side enforcement is planned: `supply-checkout-dj6`.

**Tests:** `app.spec.js`: "view-only users can't make changes"; `sheets.spec.js`: "view-only users can open a sheet but not change it"; `inventory.spec.js`: "view-only users see inventory but can't change it"; `resilience.spec.js`: "a permission failure switches the page to view-only".

### J10. Cancel and take the data

**Persona:** owner.

1. Open the Customer Portal from **Billing** and cancel.
2. Export all sheets and inventory.

**Expected:** access continues to the end of the paid period, then the team is read-only for 30 days with export available. After that the data is deleted, as the privacy policy says.

**Status:** planned. `supply-checkout-121`, `supply-checkout-qdx`, `supply-checkout-zuv`.

### J11. Delete an account

**Persona:** anyone. (Required by the App Store and promised in the privacy policy.)

1. Open **Settings → Delete account**.
2. An owner either hands ownership to another member or closes the team.

**Expected:** done without contacting support. Personal data is gone within the stated period. Closing a team cancels its subscription.

**Status:** planned. `supply-checkout-b1h`.

### J12. Choose a plan in the mobile app

**Persona:** owner, in the iOS or Android app.

1. Open **Plans** in the app and choose a plan and seats.
2. Pay on Stripe Checkout in the in-app browser with Apple Pay or Google Pay.
3. Return to the app.

**Expected:** the app shows the plan as active without reopening it. Where store rules don't allow the link, the app shows "Manage your plan on our website" and no prices ([ADR 0013](adr/0013-web-billing-only.md)).

**Status:** planned for phase 2. `supply-checkout-8jc.5`.

---

## Alarms for blocked journeys

These alarms tell us when a customer can't finish a journey in production. They are built by `supply-checkout-3sv.1`, on top of the dashboards and logs in `supply-checkout-7pe` and the synthetic canaries in `supply-checkout-pkt`. Each alarm links its runbook (`supply-checkout-tk4`).

Thresholds are starting points. Tune them after a few weeks of real traffic, and write down every change in the alarm's description.

The MVP runs in us-east-1 only ([ADR 0010](adr/0010-multi-region-active-active.md)), so the alarms and canaries below are in us-east-1. When us-west-2 is added in phase 2, the per-region alarms are copied to it, and the alarms in [Phase 2: second region](#phase-2-second-region) are added.

### Severity and who is told

| Severity | Meaning | Who is told, and how | Response |
| --- | --- | --- | --- |
| **P1** | A critical journey is blocked, or customers are being wrongly locked out | SMS and email to both of us through SNS, at any hour | Start within 15 minutes. Post on the status page (`supply-checkout-iuw`) if it lasts more than 15 minutes. |
| **P2** | A journey is degraded, or will soon be blocked | Email | Same business day |
| **P3** | A trend worth a look | Weekly review | Next weekly review |

Crews start early, so "business hours" means 5am–8pm US Eastern, every day.

**Core canary hours.** The core journey canary runs only from 8am to 8pm Eastern. Canary schedules are UTC cron, which doesn't follow daylight saving time, so EventBridge Scheduler starts and stops the canary on an `America/New_York` schedule. Its alarm treats missing data as not breaching, so the overnight gap doesn't page anyone. Between 8pm and 8am, a blocked journey is caught by the metric alarms below (API errors, site down, API health check). From 6am to 8am, "Checkouts stopped" also covers J4.

Alarms that fire during a deploy also trigger the automatic rollback (`supply-checkout-9lj`). The page should say whether a rollback already ran.

### Which alarms exist

`supply-checkout-7pe` built the alarm topics, the dashboard and the alarms below, in `infra/lib/observability/` (each region's `observability` stack). Alarms are named `supply-checkout-<env>-<p1|p2>-<id>`, notify their severity's SNS topic when they fire and when they recover, and treat missing data as not breaching, because most of their metrics only exist once there is traffic.

| Alarm | Journeys | Severity | Built as |
| --- | --- | --- | --- |
| Functions failing | Every journey | P1 | Lambda `Errors` ÷ `Invocations` across every function in the region, at least 20 invocations. Per-function alarms come with the functions. |
| Functions throttled | Every journey | P2 | Lambda `Throttles` across every function in the region |
| API errors | Every journey | P1 | API Gateway `5xx` ÷ `Count` for the HTTP API (`supply-checkout-d8b`), at least 20 requests. Across all routes, not per route: per-route metrics need detailed metrics, billed per route, and the access logs have the route. |
| API slow | Every journey | P2 | API Gateway `Latency` p95 for the HTTP API over 10 minutes |
| Database errors | Every journey | P1 | DynamoDB `SystemErrors` on the app table, summed over the operations the data module uses |
| Database throttled | Every journey | P2 | DynamoDB `ReadThrottleEvents` + `WriteThrottleEvents` on the app table |
| Email bouncing, Email complaints | J3 | P1 | SES reputation metrics, as below |
| Writes rejected | J4 | P2 | `ConditionalWriteConflicts` ÷ `Writes`, at least 20 writes |
| Receipt reading failing | J5 | P2 | As below |
| Checkout broken, Webhook signature failures | J7 | P1 | As below |

Every other alarm on this page waits for the resource or code it watches, and is added by the bead that builds it (the alarm goes in that region's `observability` stack, with `topics.notify(alarm, severity)`): the canaries (`supply-checkout-pkt`); Site down and Firewall blocking customers (CloudFront and WAF, `supply-checkout-qk1`); API unhealthy (it needs a `/health` route and a Route 53 health check, which the API doesn't have yet); Cognito alarms (`supply-checkout-zsm`); Live updates failing (AppSync Events); Bedrock alarms and Receipt cost spike (the receipt function); Near the sending limit (SES); the billing queue, reconciliation and deletion-job alarms; and Checkouts stopped, which compares with the same hour last week, and so needs something other than one CloudWatch alarm. The remaining P3 trends (No sign-ups, Invites not accepted, Failed payments rising, App checkouts abandoned) are read from the dashboard at the weekly review.

### Every journey

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Core journey canary failing** | CloudWatch Synthetics canary in us-east-1, every 5 minutes from 8am to 8pm Eastern: sign in as a test crew member, open the test sheet, check out and return one item, confirm the live update arrives | 2 failed runs out of 3 | P1 |
| **Site down** | CloudFront `5xxErrorRate` | above 1% for 5 minutes | P1 |
| **API errors** | API Gateway `5xx` per route | above 2% of requests for 5 minutes (at least 20 requests) | P1 |
| **API slow** | API Gateway `Latency` p95 | above 2 seconds for 10 minutes | P2 |
| **API unhealthy** | Route 53 health check on `/health` in us-east-1 | unhealthy for 2 minutes | P1 |
| **Functions failing or throttled** | Lambda `Errors` and `Throttles` per function | errors above 1% for 5 minutes, or any throttles for 5 minutes | P1 errors, P2 throttles |
| **Database errors** | DynamoDB `SystemErrors` | any, for 5 minutes | P1 |
| **Database throttled** | DynamoDB `ThrottledRequests` | any, for 5 minutes | P2 |
| **Firewall blocking customers** | AWS WAF `BlockedRequests` | more than 3× the usual rate (anomaly detection) for 15 minutes | P2 |

### J0. Sign in

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Nobody can sign in** | Cognito `SignInSuccesses` and `TokenRefreshSuccesses` | zero for 15 minutes between 8am and 8pm Eastern while the core canary also fails (composite alarm) | P1 |
| **Sign-in throttled** | Cognito `SignInThrottles` and `TokenRefreshThrottles` | any, for 5 minutes | P1 |
| **Social sign-in failing** | Cognito `FederationSuccesses` against federated sign-in attempts, from our login logs | success rate below 90% over 30 minutes | P2 |

### J1. Sign up and start a trial

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Sign-up canary failing** | Synthetics canary every 15 minutes: load the landing and pricing pages, open sign-up, start a trial with a `+canary` test address in a canary team that's cleaned up afterwards | 2 failures in a row | P1 |
| **No sign-ups** | `SignUps` business metric | zero for 24 hours when the 7-day average is above 1 a day | P3 |

### J3. Invite the crew

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Email bouncing** | SES `Reputation.BounceRate` | above 4%. AWS reviews accounts at 5% and can pause sending at 10%. | P1 |
| **Email complaints** | SES `Reputation.ComplaintRate` | above 0.08%. AWS reviews at 0.1%. | P1 |
| **Near the sending limit** | SES `Send` against the daily quota | above 80% of the quota | P2 |
| **Invites not accepted** | `InvitesAccepted` ÷ `InvitesSent` business metrics | below 30% over 7 days | P3 |

### J4. Check supplies out and back in

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Core journey canary failing** | See "Every journey" | | P1 |
| **Checkouts stopped** | `Checkouts` business metric across all teams | zero for 30 minutes between 6am and 11am Eastern on weekdays, when the same hour last week had more than 10 | P1 |
| **Writes rejected** | `ConditionalWriteConflicts` (409 responses) | above 5% of writes for 15 minutes. Normal conflicts are rare; a spike means a sync bug. | P2 |
| **Live updates failing** | AppSync Events connection and publish server errors, and the canary's live-update check | publish errors above 1% for 10 minutes, or the canary's update takes more than 5 seconds twice in a row | P2 |
| **Stock counts drifting** | Nightly job comparing each item's storage count with its checkout and return history | any team with a mismatch | P3 |

### J5. Read a receipt

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Receipt reading failing** | `ReceiptReadFailures` ÷ `ReceiptReads` (not counting cancels, limit hits and unreadable photos) | above 10% over 15 minutes, at least 5 reads | P2 |
| **Bedrock throttled** | Bedrock `InvocationThrottles` | any, for 10 minutes | P2 |
| **Bedrock errors** | Bedrock `InvocationServerErrors` | above 5% for 10 minutes | P2 |
| **Receipts slow** | Bedrock `InvocationLatency` p95 | above 45 seconds for 15 minutes. The app says reading takes up to 60 seconds. | P2 |
| **Receipt cost spike** | Tokens per team, from the receipt Lambda's usage metrics | a team above 3× its plan's expected monthly cost | P2 |

Receipt reading is not critical: people can still enter items by hand.

### J7. Subscribe, add seats and see invoices

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Checkout broken** | `CheckoutSessionErrors` (our API failing to create a Stripe Checkout session) | any, for 5 minutes | P1 |
| **Webhook signature failures** | `WebhookSignatureFailures`. Usually a rotated or wrong signing secret. | any | P1 |
| **Billing events stuck** | Billing worker dead-letter queue `ApproximateNumberOfMessagesVisible` | any message | P1 |
| **Billing events late** | Age of the oldest message in the billing queue | above 5 minutes | P2 |
| **Seat counts drifting** | Nightly reconciliation of Stripe seat quantity against billable members | any team with a mismatch | P2 |
| **Paid but not active** | Teams with a paid Stripe subscription still marked trial or read-only, from a reconciliation job every 15 minutes | any | P1 |

### J8. A payment fails and is fixed

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Mass lockout** | Teams switched to read-only in the last hour | more than 3, or more than 5% of active teams. Protects against a billing bug locking out paying customers. | P1 |
| **Billing events stuck** | See J7 | | P1 |
| **Failed payments rising** | `invoice.payment_failed` events | more than 2× the 30-day average in a day | P3 |

### J9, J10, J11: roles, cancellation and deletion

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Cross-team access attempts** | Authorizer denials where the signed-in user asked for a team they don't belong to | any, over 15 minutes. Could be a client bug or someone probing. | P2 |
| **Export failing** | Export function `Errors` | any, for 15 minutes | P2 |
| **Deletion job failing** | Scheduled deletion job errors, or accounts past their deletion date | any | P2. The privacy policy promises a deadline. |

### J12. Choose a plan in the mobile app

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **App checkouts abandoned** | Stripe Checkout sessions started from the apps against completed ones | completion below half the web rate over 7 days | P3 |

### Phase 2: second region

Added with us-west-2. Until then, none of these exist.

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Core journey canary failing** | The core canary also runs in us-west-2 | 2 failed runs out of 3 in either region | P1 |
| **Region unhealthy** | Route 53 health check on `/health` in each region (also drives failover) | unhealthy for 2 minutes | P1 |
| **Regions out of sync** | DynamoDB global table `ReplicationLatency` | above 60 seconds for 10 minutes | P2 |
| **Forwarded writes failing** | Errors forwarding a team's writes to its home region | above 1% for 5 minutes | P1 |

### Business metrics the app must publish

Several alarms above rely on metrics our own code sends (CloudWatch embedded metric format from Lambda), not ones AWS provides:

`Checkouts`, `Returns`, `ReceiptReads`, `ReceiptReadFailures`, `SignUps`, `InvitesSent`, `InvitesAccepted`, `CheckoutSessionErrors`, `WebhookSignatureFailures`, `ConditionalWriteConflicts`, `Writes` (the denominator for "Writes rejected"), and `ReceiptTokens` (receipt token usage, with the team ID as metadata rather than a dimension). Each has a `Region` dimension, even while there is only us-east-1, so they split cleanly when us-west-2 is added.

The names are in `backend/src/observability/names.ts`, which both the Lambda code and the dashboard and alarms import. Send them with `count()` from `backend/src/observability`, in namespace `SupplyCheckout`. The dashboard already has a graph for each; until the handlers exist, the graphs are empty and the alarms stay OK.
