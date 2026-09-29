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
| [J3](#j3-invite-the-crew) | Invite the crew | Owner, crew member | No | Tested; seats planned |
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

**Expected:** the team's sheets appear within 3 seconds. Staying signed in lasts 30 days on the same device. Signing in with Apple or Google using the verified email of an existing account, at an address that provider runs (Gmail or the account's own Workspace domain; iCloud or an Apple relay address), opens that same account and its teams (`supply-checkout-0b1`: `backend/test/account-link.test.ts`, and the retry in `tests/aws-account.spec.js`). A person removed from a team no longer sees it on their next request.

**Status:** planned. `supply-checkout-zsm` (Cognito), `supply-checkout-l5y` (team switcher).

### J1. Sign up and start a trial

**Persona:** owner. **Critical:** no sign-ups, no new customers.

1. Visit supplycheckout.com, read the pricing page, tap **Start free trial**.
2. Sign up and accept the terms.
3. Name the team.

**Expected:** an empty team ready to use in under a minute, with a 14-day trial and no card needed. The terms acceptance time is stored. In the web app, the new team opens with a short **Get your team started** checklist above the sheets and inventory: add supplies (by hand, or import a CSV using the import's template), invite the crew from Members, and create a first sheet. Each step ticks itself off from what's saved, and the checklist shows to the team's owners on that device until every step is done or they dismiss it (`supply-checkout-dhc`: `tests/aws-first-run.spec.js`, including accessibility in light and dark mode and a phone-width layout).

**Status:** planned. `supply-checkout-21q` (landing and sign-up), `supply-checkout-zsm` (sign-in), `supply-checkout-l5y` (team creation: `GET /me` and `POST /teams`, see [docs/api/onboarding.md](api/onboarding.md)), `supply-checkout-x0l` (trial).

### J2. Set up the inventory

**Persona:** owner.

1. Open **Inventory**, tap **+ Add item**.
2. Type or scan a barcode (or leave it blank), then enter the name, price and how many are in storage.
3. Edit or delete items later by tapping their row.

**Expected:** items appear in the list with storage counts, value per item and totals. Items without a barcode can be found by name when checking out.

**Status:** partly tested. Adding items works today. Creating the team first is planned (`supply-checkout-l5y`), as is importing an existing inventory (`supply-checkout-ig9`).

**Tests:** `inventory.spec.js` (all tests), `barcode.spec.js`: "an item's barcode can be scanned when adding it to inventory", and in the web app, `aws-first-run.spec.js` (the new team's checklist leads here).

### J3. Invite the crew

**Persona:** owner, then crew member.

1. The owner opens **Members**, enters a crew member's email and picks **Contributor**.
2. The crew member gets an email, taps the link on their phone and signs up or signs in.

**Expected:** the email arrives within a minute. The link works once and expires after 7 days. The crew member sees the team's sheets right away, and the seat count on the subscription goes up.

**Status:** tested, except the seat count. Inviting, the email, accepting, resending, revoking and failed deliveries are in `tests/aws-invites.spec.js` and `tests/aws-account.spec.js` (the web build) and `backend/test/invites-api.test.ts` (`supply-checkout-5tp`, `supply-checkout-5hx`, `supply-checkout-dj6`). Seats are `supply-checkout-l50`. The link opens the web app; opening the mobile app from it (universal links) comes with the phase 2 apps.

### J4. Check supplies out and back in

**Persona:** crew member. **Critical:** this is the job the app does every morning.

1. Create a sheet for the client and date, or open today's sheet.
2. Scan each item's barcode with the phone camera (or type the number, or pick an item that has no barcode) and choose how many.
3. Back from the job, switch to **Return**, scan what came back unused, and tap **Finished Return**.

**Expected:** each checkout takes storage counts down and each return puts them back. The sheet shows taken, returned, used and the charge. Other people's phones show the changes within 2 seconds. Nothing is lost if two people work on the same sheet. On a slow or flaky connection, a checkout or return never shows as saved before the server confirms it, a double tap or a retry never counts twice, and one that didn't save keeps what was entered and says so, with Try again.

**Status:** tested.

**Tests:**
- `app.spec.js`: "creates a sheet recording client, date and who prepared it"; "checks out a new barcode, returns part of it, and finishes the return"; "storage counts go down on checkout and back up on return"; "adds an item that has no barcode"; "returning the same item again adds to what's already been returned"
- `barcode.spec.js`: reading barcode photos, including when the photo can't be read
- `sheets.spec.js`: editing sheets and lines, picking and returning items without barcodes, reopening and deleting
- `concurrent.spec.js`: another person changing the same sheet at the same time
- `failures.spec.js`: failed saves leave the screen as it was
- `save-states.spec.js` and `aws-save-states.spec.js`: saving on a slow connection, double taps, timeouts, lost answers, and going offline and back

**Live updates deferred: what to do.** A budget stop isn't a failure: the consumer always sends the batch's first chunk (up to 5 changes, to every member of that team) and reports the first record it didn't finish, and Lambda invokes it again from there. Sustained deferral means changes are arriving late. In the consumer's logs (`/aws/lambda/supply-checkout-<env>-live-updates`), the `Publish budget used up` warnings and the `Batch` lines' `publishes`, `deferred` and `lagMs` say how far behind it is. Many publishes per batch means big, busy teams; few publishes with deferrals means AppSync is slow (check its metrics and the AWS Health Dashboard). Each stop may use one of the event source mapping's retry attempts (`STREAM_RETRY_ATTEMPTS`, 25, at least the batch size, so stops alone always drain a batch); a batch that still runs out goes to the dead-letter queue, and Live updates dropped fires.

### J5. Read a receipt

**Persona:** crew member or owner, after buying supplies.

1. Tap **Scan receipt** and photograph the receipt.
2. Check each line: name, quantity, price, and the suggested inventory match.
3. Assign each line to a client (a new or existing sheet) or to **General inventory**, then tap **Save**.

**Expected:** lines appear within 60 seconds. Nothing is saved until **Save**. An item that comes in packs of n shows "1 case = n each" and adds eaches (cases × n) at a cost of the case price ÷ n, rounded to cents, unless the line is switched to **Priced per each**. Where the price differs from the item's, the line offers **Charge the receipt price** or **Keep the client price**, and keeps the client price by default when the item's cost is below its price (ADR 0014). Client items go on the sheets at the chosen price, with the receipt's cost; storage items raise storage counts; and the receipt's cost each is saved to the item. If reading fails, the person can enter the items by hand.

**Status:** tested with claude.ai receipt reading. The Bedrock version is planned: `supply-checkout-kx8` (receipt Lambda), `supply-checkout-wxx` (limits).

**Tests:** `app.spec.js`: "receipt review merges duplicates and splits items between a client and storage"; `receipts.spec.js` (all tests, including the default price choice and pack conversion); `aws-data.spec.js`: "a receipt's cases are stock commands in eaches at the cost of one each"; `resilience.spec.js`: failed reads, empty photos and resuming an unsaved review.

### J6. Export a sheet to bill a client

**Persona:** owner or bookkeeper.

1. Open a finished sheet.
2. Tap **Download CSV**.

**Expected:** a CSV named after the client and date, with each item's price, taken, returned, used and charge, and a total row.

**Status:** tested. Owners can also export all of a team's data: on the sheet list, **Export data** offers every sheet (one CSV row per item), the inventory (CSV), or everything (JSON, each document as stored plus each sheet's totals). It's built in the browser from the collections the app has already loaded, so it matches the screens and needs no server route; 1,000 sheets take well under a second once listed. It shows for owners only (`user.isOwner()`), whether or not they can write, so it keeps working while a team is read-only.

**Tests:** `app.spec.js`: "exports a sheet as CSV"; `startup.spec.js`: "CSV export quotes commas and quotes, and names untitled sheets", "a declined download is silent", "a failed download explains"; `export.spec.js` (all tests); `aws-data.spec.js`: "an owner exports 1,000 sheets, listed page by page, as a JSON download", "members who aren't owners get no Export data".

### J7. Subscribe, add seats and see invoices

**Persona:** owner. **Critical:** this is how we get paid.

1. Before or at the end of the trial, open **Billing** and choose a plan and number of seats.
2. Pay on Stripe Checkout (card, Apple Pay or Google Pay).
3. Later, invite more people (seats go up) and open past invoices.

**Expected:** the team shows as active within a minute of paying. Adding or removing an owner or editor, or changing someone between viewer and a billed role, updates the seat count with proration; viewers are free. Invoices are emailed and listed in the app with the company name.

**Status:** partly built, in the Stripe sandbox. Checkout (`supply-checkout-x0l`) and the webhook, queue and worker (`supply-checkout-2kl`) are built: a finished checkout sets the team's plan, seats and status within a minute, a team whose trial ends without a card turns read-only with a banner (and owners are emailed), and an owner of a read-only team can subscribe again from the team bar. Owners of a team with a Stripe customer open the Customer Portal (`supply-checkout-121`) from **Billing** in the team bar, to add or change a card, switch between monthly and annual, see and download invoices, and cancel at the end of the period; a cancellation shows in the team bar within a minute. Seat sync (`supply-checkout-l50`) is built: the subscription's quantity follows the team's owners and editors (viewers are free) within a minute of a membership change, and right after Checkout, with proration, and a nightly reconciliation fixes and alarms on any drift ([infrastructure](infrastructure.md#billing), Seats). Still to come: the in-app plan picker (`supply-checkout-8jc.5`) and invoices listed in the app (`supply-checkout-eja`). Tests: `backend/test/billing-api.test.ts`, `billing-webhook.test.ts`, `billing-worker.test.ts` ("canceling in the Customer Portal"), `billing-seats.test.ts` (seat sync), `members-api.test.ts`, `invites-api.test.ts` and `account-deletion-api.test.ts` ("seats"), `ops-checks.test.ts` (the reconciliation), `billing-ddb.test.ts`, `stripe-catalog.test.ts` (the portal configuration), and `tests/aws-billing.spec.js`.

### J8. A payment fails and is fixed

**Persona:** owner. **Critical:** if this breaks, paying customers lose access, or we give access away.

1. A renewal payment fails.
2. The owner sees a banner and gets an email. The team keeps full access for 7 days.
3. The owner updates their card in the Customer Portal.

**Expected:** after 7 days without payment the team becomes read-only. Nothing is deleted. As soon as payment succeeds, full access returns within a minute.

**Status:** partly built. The payment-failed email and the webhooks are built (`supply-checkout-2kl`), and owners fix the card in the Customer Portal from **Billing** in the team bar (`supply-checkout-121`); a paid invoice reaches the team within a minute. The 7-day grace period is still to come: `supply-checkout-qdx` (access rules), `supply-checkout-5hx` (email).

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

**Status:** partly built. Cancelling in the Customer Portal is built (`supply-checkout-121`): the subscription runs to the end of the period, the team bar says when it ends, and then the team is read-only with export available. Deleting canceled teams is `supply-checkout-qdx`. Export is built (`supply-checkout-zuv`, see J6); it only reads, through the list routes, so read-only mode must keep those open to owners.

### J11. Delete an account

**Persona:** anyone. (Required by the App Store and promised in the privacy policy.)

1. Open **Account → Delete account** in the team bar (or **Delete account** on the first screen) and type DELETE.
2. An owner of a team others are in either makes another member an owner or closes the team (**Members → Close the team**, typing its name) first; the app shows the server's message naming those teams.

**Expected:** done without contacting support. The user is out of every team, a team they were alone in is closed, invites to their address and their sign-in are gone, and a closed team's data is deleted 30 days after it closed. Closing a subscribed team sets its Stripe subscription to cancel at the period's end within about an hour (the hourly purge, `supply-checkout-t0en`), and the purge deletes its Stripe customer with its data.

**Status:** built (`supply-checkout-b1h`). The 30-day deadline is watched: the hourly purge sends `ClosedTeamsOverdue`, the closed teams still there more than 24 hours after their deletion date, and **Deletion overdue** alarms on any; if the purge stops sending the gauge for 3 hours (its schedule disabled or deleted, or every run failing before it reads the index), **Deletion job not running** alarms ([J9, J10, J11](#j9-j10-j11-roles-cancellation-and-deletion)). **Tests:** `backend/test/account-deletion-api.test.ts` (closing, deleting, the purge and its overdue gauge, isolation of each session), `backend/test/closing.test.ts` (the same against DynamoDB Local, including that the data is gone after 30 days and not before), `tests/aws-account-deletion.spec.js` (the web app: leaving, closing, a closed team, reopening it, deleting). An owner who is still in a closed team can reopen it until an hour before the purge (`supply-checkout-d9su`), and never once the purge has marked it `purging`. Support can reopen it until 5 minutes before the purge, and never once it's marked `purging`, for a disputed closure (`npm run ops -- reopen`, `supply-checkout-6uw.6`; tests in `backend/test/ops-api.test.ts`, `ops-reopen.test.ts` and `ops-ddb.test.ts`).

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
| Site down, Web router failing | Every journey | P1 | CloudFront's `5xxErrorRate` on the web distribution (at least 50 requests), and the router function's execution and validation errors and throttles (5 or more in 5 minutes), in us-east-1 only, where CloudFront's metrics are (`supply-checkout-3sv.2`). Runbook: [When the web app is down](observability.md#when-the-web-app-is-down). |
| Sign-out not revoking | J0 | P2 | As below |
| Imports stuck | J2 | P2 | As below, from the stuck-import check. In the primary region only, where the check runs. |
| Email verification not saved, Email codes failing, Near the sending limit | J3 | P2 | As below. Near the sending limit reads the SES quota check's gauge, and is in the primary region only, where the check runs. |
| Email bouncing, Email complaints | J3 | P1 | SES reputation metrics, as below |
| Email events dropped | J3 | P2 | As below |
| Writes rejected | J4 | P2 | `ConditionalWriteConflicts` ÷ `Writes`, at least 20 writes |
| Live updates failing | J4 | P2 | `LiveUpdateFailures` ÷ `LiveUpdates` from the stream consumer (`supply-checkout-dpc`), at least 20 events, over 10 minutes. The canary's live-update check comes with the canary. |
| Live updates delayed, Live updates dropped, Live updates deferred | J4 | P2 | As below. Live updates deferred needs 3 breaching 5-minute periods in a row. |
| Receipt reading failing | J5 | P2 | As below |
| Checkout broken, Webhook signature failures, Billing events stuck | J7 | P1 | As below. Billing events stuck watches the billing events dead-letter queue. |
| Billing portal broken | J7, J8 | P1 | As below |
| Billing events late | J7, J8 | P2 | The billing events queue's `ApproximateAgeOfOldestMessage` above 5 minutes |
| Seat syncs stuck, Seat counts drifting, Seat reconciliation not running | J7 | P2 | As below (`supply-checkout-l50`). Seat syncs stuck watches the seat syncs dead-letter queue. The other two read the nightly seat reconciliation's metrics, and are in the primary region only, where it runs. |
| Deletion overdue, Deletion job not running, Team closure emails failing, Team reopened emails failing | J11 | P2 | As below. Deletion overdue and Deletion job not running read the closed-team purge's gauge, and are in the primary region only, with the purge. |

Every other alarm on this page waits for the resource or code it watches, and is added by the bead that builds it (the alarm goes in that region's `observability` stack, with `topics.notify(alarm, severity)`): the canaries (`supply-checkout-pkt`); Firewall blocking customers (WAF, `supply-checkout-qk1`); API unhealthy (it needs a `/health` route and a Route 53 health check, which the API doesn't have yet); Cognito alarms (`supply-checkout-zsm`); Bedrock alarms and Receipt cost spike (the receipt function); the entitlement reconciliation alarm (Paid but not active, `supply-checkout-8jc.9`); and Checkouts stopped, which compares with the same hour last week, and so needs something other than one CloudWatch alarm. The remaining P3 trends (No sign-ups, Invites not accepted, Failed payments rising, App checkouts abandoned) are read from the dashboard at the weekly review.

### Every journey

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Core journey canary failing** | CloudWatch Synthetics canary in us-east-1, every 5 minutes from 8am to 8pm Eastern: sign in as a test crew member, open the test sheet, check out and return one item, confirm the live update arrives | 2 failed runs out of 3 | P1 |
| **Site down** | CloudFront `5xxErrorRate` on the web distribution | above 1% for 5 minutes (at least 50 requests) | P1 |
| **Web router failing** | CloudFront `FunctionExecutionErrors`, `FunctionValidationErrors` and `FunctionThrottles` of the router function | 5 or more in 5 minutes | P1 |
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
| **Sign-out not revoking** | `SignOutRevokeFailures`: sign-outs whose refresh token Cognito didn't revoke (`backend/src/api/auth-handler.ts`). Sign-out still clears the cookie and answers 204, but the token stays valid at Cognito until it expires (30 days). | 3 or more in 15 minutes | P2 |

**Sign-out not revoking: what to do.** Check Cognito's health in the AWS Health Dashboard and the auth function's logs (`Refresh token not revoked`, with Cognito's HTTP status; 0 means it wasn't reached). The tokens that weren't revoked are only on the devices that signed out, and those devices dropped their cookie, so there's nothing to hand to anyone. If a person asks to be signed out everywhere, run `aws cognito-idp admin-user-global-sign-out` for their user.

### J1. Sign up and start a trial

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Sign-up canary failing** | Synthetics canary every 15 minutes: load the landing and pricing pages, open sign-up, start a trial with a `+canary` test address in a canary team that's cleaned up afterwards | 2 failures in a row | P1 |
| **No sign-ups** | `SignUps` business metric | zero for 24 hours when the 7-day average is above 1 a day | P3 |

### J2. Set up the inventory

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Imports stuck** | `StuckImports`: CSV imports still committing an hour after they started, and so half applied. A scheduled check (`backend/src/ops/stuck-imports-handler.ts`, primary region, every 10 minutes) counts the jobs in GSI1's `IMPORTS#COMMITTING` partition, which a job is in until its last batch commits. | any (maximum over 15 minutes) | P2 |

**Imports stuck: what to do.** An import stops part-way when its Lambda times out or items keep changing under it, and the owner didn't press **Try again**. Nothing is lost: every row already committed is complete, and the plan for the rest is staged. Imports that no retry could finish (a row too large to save, or a planned key another item took) leave the check on their own when they stop: the owner was told which line and to choose the file again. So everything this alarm lists is something a retry would finish.

1. List the stuck imports with the operator CLI ([Operators](infrastructure.md#operators)): `npm run ops -- stuck-imports` gives each one's team ID, import ID, start time and `committed` of `total` rows. They're IDs only; `npm run ops -- team <teamId>` shows the team's owners (and is audited). The check's own logs have the same: in Logs Insights on `/aws/lambda/supply-checkout-<env>-stuck-imports`, `filter message = "Import stuck"`.
2. Tell an owner of the team that their import stopped part-way, and ask them to import the same file again. If the app still shows **Try again**, that carries on from the first row not committed. Otherwise, choosing the file again starts a new import that re-plans against the inventory as it is now, leaves the rows already imported unchanged and finishes the rest. We can't finish it for them: the job keeps the plan, not the file, and a retry must send the same file.
3. If the owner finished it as a new import (or doesn't want it), take the old job out of the check so the alarm recovers. This leaves the job itself alone, so a retry of it still works until it expires. It's audited (`ops.import.clear`), and the team's owners see it under support actions:

   ```bash
   npm run ops -- clear-import <teamId> <importId> --reason "Owner re-imported the file"
   ```

   It refuses an import that isn't stuck: one that finished, was cleared already, or started less than an hour ago.
   Job records expire after 7 days anyway, which also clears the alarm.

   A cleared job is out of the check for good: if the owner then presses **Try again** on it and it stalls again, this alarm won't see it (a retry doesn't put it back in the committing-imports index). So clear a job only once the owner has finished the import another way, and if they retry the old job instead, ask them to tell you whether it finished; otherwise check `committed` against `total` in the job with a direct read under an SSO role.
4. If imports keep getting stuck, look at the data function's logs for the import route (`POST /teams/{teamId}/imports`): timeouts mean the batches need to be smaller or the function's timeout longer.

### J3. Invite the crew

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Email bouncing** | SES `Reputation.BounceRate` | above 4%. AWS reviews accounts at 5% and can pause sending at 10%. | P1 |
| **Email complaints** | SES `Reputation.ComplaintRate` | above 0.08%. AWS reviews at 0.1%. | P1 |
| **Email events dropped** | Messages in the email-events dead-letter queue (`supply-checkout-<env>-email-events-dlq`): a bounce or complaint the handler couldn't record, so a bounced invite may still look pending. SES has still suppressed the address. | any | P2 |
| **Near the sending limit** | `EmailQuotaUsedPercent`: SES's sends in the last 24 hours as a share of its 24-hour quota. SES has no metric for the quota, and its window is rolling, so a scheduled check (`backend/src/ops/email-quota-handler.ts`, primary region, every 10 minutes) asks SES (`GetAccount`) and sends the share. | above 80% (maximum over 15 minutes) | P2 |
| **Invite surge** | `InvitesSent` business metric, summed over every team: invite emails the account function sent. Each team (50 a day), each address (15 a day, and 3 from one team or one inviting account) and each account's team creation (5 a day) is already limited; this watches the total, so a bug resending invites or many free trial teams sending mail shows before SES's quota or reputation does. There's deliberately no account-wide cap in code: one abuser reaching it would stop every team's invites. | above 300 in an hour | P2 |
| **Email verification not saved** | `EmailVerifyFailures` + `EmailUnverifyFailures`: the pre token generation trigger couldn't copy a Google or Apple user's `email_verified` (`backend/src/identity/email-verified-handler.ts`, outcomes `failed` and `downgrade-failed`), or couldn't unverify or record a linked user's changed email, read the address they proved, or clear a pending downgrade (`linked-downgrade-failed`, `linked-record-failed`, `linked-lookup-failed`, `linked-clear-failed`). It logs the error and lets the sign-in go ahead, so the Lambda errors alarm doesn't see it. A failed promotion leaves the user unverified, so they can't accept invites; a failed downgrade leaves them verified. The next sign-in retries. A linked user's failed downgrade (after one retry) fails that sign-in instead, and leaves `custom:downgrade_pending` set when that write went through. Either way no refresh records the address, since only an address proven with a code in the app is recorded (the API already treats the changed email as unverified); a failed read or recording leaves a newly proven address unverified in the API until the next token. | any, over 15 minutes | P2 |
| **Email codes failing** | `EmailCodeSendFailures` + `EmailCodeVerifyFailures`: `POST /me/email/code` or `POST /me/email/verify` answered 5xx (`backend/src/api/account-handler.ts`), so the person got no code, or their right code didn't verify the address, and they can't accept invites until it does. Refusals (a wrong or expired code, too many attempts, an address that changed) are 4xx and aren't counted. These routes are too quiet for the API errors alarm's 2% to notice. | 3 or more in 15 minutes | P2 |
| **Invites not accepted** | `InvitesAccepted` ÷ `InvitesSent` business metrics | below 30% over 7 days | P3 |

**Near the sending limit: what to do.** Check the SES console's sending statistics for a burst (a bug resending invites, or abuse of invites), and fix that first. If it's real growth, request a higher sending quota in the SES console (Service Quotas, "Sending quota"), which usually takes a day.

**Invite surge: what to do.** Each `InvitesSent` count goes out as an embedded-metric log line in the account function's log group, with the team ID as metadata: in CloudWatch Logs Insights, filter on `InvitesSent` and count by `teamId`. One or a few teams sending most of them is abuse or a bug (a client resending in a loop): look at those teams and, for abuse, close them. Spread over many new trial teams, look at the sign-ups behind them. If it's real growth, raise the threshold (`INVITE_SURGE_PER_HOUR` in `infra/lib/observability/journey-alarms.ts`). Complaints and bounces from a burst show in Email complaints and Email bouncing: SES's reputation metrics are account-wide, so they include every send through the app's configuration set (which also has its own reputation metrics turned on).

**Email codes failing: what to do.** The account function's logs have each failure: `Request failed` with the error (Cognito's action, HTTP status and error name, never the code, token or address), then the `Request` line with the route and status. `CodeDeliveryFailureException` means Cognito couldn't send the email: check the user pool's email configuration and SES. A 5xx from `GetUser` or `VerifyUserAttribute` is Cognito erroring or unreachable (check the AWS Health Dashboard); DynamoDB errors show in the Database errors alarm too. Nothing needs undoing: the person asks for a new code once it's fixed.

**Email verification not saved: what to do.** The pre token generation function's logs (the identity stack's email-verified trigger; filter on `outcome` `failed` or `downgrade-failed`) have Cognito's error. Throttling (`TooManyRequestsException`) clears on its own at the next sign-in; an access error means the trigger's IAM policy or the pool changed. A user left unverified can sign out and in again once it's fixed.

For `linked-downgrade-failed`, there's usually nothing to do: no refresh records the rewritten address unless the person proves it with a code in the app (`supply-checkout-ytr2`), and the API doesn't trust it meanwhile. With `flagged: true` the user's `custom:downgrade_pending` is set and their next Managed Login sign-in (or a code-proven address at a refresh) clears it. With `flagged: false`, neither write went through; Cognito still shows the rewritten address as verified until the next Managed Login sign-in. To take that away sooner, for the user the log's `user` handle names:

1. Read the key: `aws secretsmanager get-secret-value --secret-id <LogCorrelationKey secret from the identity stack's resources> --query SecretString --output text`.
2. Find the user: list the pool's users and match the handle, the first 16 hex digits of HMAC-SHA256(key, sub). For example, `aws cognito-idp list-users --user-pool-id <pool> --output json | KEY=<key> HANDLE=<handle> node -e 'const c=require("node:crypto");const u=JSON.parse(require("node:fs").readFileSync(0,"utf8")).Users;for(const x of u){const sub=x.Attributes.find(a=>a.Name==="sub").Value;if(c.createHmac("sha256",process.env.KEY).update(sub).digest("hex").slice(0,16)===process.env.HANDLE)console.log(x.Username)}'`.
3. Take the trust away: `aws cognito-idp admin-update-user-attributes --user-pool-id <pool> --username <username> --user-attributes Name=email_verified,Value=false`, then `aws cognito-idp admin-delete-user-attributes --user-pool-id <pool> --username <username> --user-attribute-names custom:linked_email custom:downgrade_pending`. The user then proves their current address with a code in the app, and their next refresh records it. (If the flag is left set, their next token clears it, since `email_verified` is now `"false"`.)
4. If the user belongs to a team, check its members and invites for anything accepted with the rewritten address since the failure, and remove it.

Keep the key, the pool's user list and the username out of tickets and chat; the handle is safe to share.

### J4. Check supplies out and back in

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Core journey canary failing** | See "Every journey" | | P1 |
| **Checkouts stopped** | `Checkouts` business metric across all teams | zero for 30 minutes between 6am and 11am Eastern on weekdays, when the same hour last week had more than 10 | P1 |
| **Writes rejected** | `ConditionalWriteConflicts` (409 responses) | above 5% of writes for 15 minutes. Normal conflicts are rare; a spike means a sync bug. | P2 |
| **Live updates failing** | The stream consumer's publishes to AppSync Events (`LiveUpdateFailures` ÷ `LiveUpdates`), and the canary's live-update check | publish failures above 1% for 10 minutes (at least 20 events), or the canary's update takes more than 5 seconds twice in a row | P2 |
| **Live updates delayed** | The stream consumer's Lambda `IteratorAge` (maximum) | above 30 seconds for 5 minutes (the goal is 2 seconds end to end) | P2 |
| **Live updates dropped** | Messages in the consumer's dead-letter queue (`supply-checkout-<env>-live-updates-dlq`): a batch it gave up on after retries | any | P2 |
| **Live updates deferred** | `LiveUpdatesDeferred`: change events the consumer's per-invocation publish budget stopped short of, which the next invocation sends. Not failures, but late | any in each of 3 consecutive 5-minute periods | P2 |
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
| **Billing portal broken** | `BillingPortalErrors` (our API failing to open the Stripe Customer Portal: owners can't add or fix a card, change plans or cancel) | any, for 5 minutes | P1 |
| **Webhook signature failures** | `WebhookSignatureFailures`. Usually a rotated or wrong signing secret. | any | P1 |
| **Billing events stuck** | Billing worker dead-letter queue `ApproximateNumberOfMessagesVisible` | any message | P1 |
| **Billing events late** | Age of the oldest message in the billing queue | above 5 minutes | P2 |
| **Seat syncs stuck** | Seat syncs dead-letter queue `ApproximateNumberOfMessagesVisible`: a sync after a membership change that the billing worker couldn't apply after 5 tries (Stripe or DynamoDB failing). The nightly reconciliation fixes the team's seats anyway. | any message | P2 |
| **Seat counts drifting** | `SeatQuantityDrift`: the nightly seat reconciliation found a subscription whose quantity isn't the team's billed members (owners and editors). Primary region only | any, over an hour | P2 |
| **Seat reconciliation not running** | `SeatReconcileTeams` samples: none means the nightly reconciliation didn't run (its schedule is disabled or deleted) or every run failed before it listed the teams. Missing data breaches. Primary region only (`infra/lib/observability/ops-checks.ts`) | fewer than 1 sample a day for 2 days (`SEAT_RECONCILE_SILENT_ALARM_DAYS`) | P2 |
| **Paid but not active** | Teams with a paid Stripe subscription still marked trial or read-only, from a reconciliation job every 15 minutes | any | P1 |

**Seat counts drifting: what to do.** The billing worker has already set the quantity right, so the customer is billed correctly from now on; the question is why the sync after the membership change missed it. Find `Seat quantity drift` in the billing worker's log (team and subscription IDs, the Stripe quantity and the billed members), then look for the team's missed sync: `Seat sync not queued` in the account function's log (`SeatSyncQueueFailures`), a message in the seat syncs dead-letter queue (Seat syncs stuck), or a membership change made outside the account API (a restore, an operator reopening a team). If the drift overbilled the team, credit the difference in the Stripe Dashboard. A mismatch found moments after a membership change, whose own sync was still queued behind the reconciliation's, fixes itself and can be ignored.

**Seat syncs stuck: what to do.** The billing worker's log has `Billing event failed` with the error's name for each try. Once the cause is fixed (usually Stripe unreachable, or a subscription Stripe won't update), redrive the dead-letter queue to `supply-checkout-<env>-seat-syncs.fifo` (the SQS console's DLQ redrive). Replaying is safe: each sync recomputes the quantity from the members as they are then. Deleting the messages instead is also safe: the nightly reconciliation fixes those teams' seats, and counts them as drift.

**Seat reconciliation not running: what to do.** Check the `supply-checkout-<env>-seat-reconcile` EventBridge rule is there and enabled (a deploy restores it), and that the function has an invocation each night. If it runs but fails, its log group has the error: an `AccessDeniedException` on the query means its IAM policy no longer matches `SEAT_RECONCILE_ATTRIBUTES`, and one on sending means it can't reach the seat sync queue. Invoke it by hand to recover the alarm.

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
| **Export failing** | Export runs in the browser from the data API's list routes, so there's no export function: the API errors alarm covers it | as API errors | P2 |
| **Deletion job failing** | The hourly closed-team purge (`supply-checkout-<env>-team-purge`) throws when any team fails, or any closed team's Stripe subscription couldn't be ended, which the Functions failing alarm counts | as Functions failing | P2. The privacy policy promises a deadline, and a closed team shouldn't be charged again. In Logs Insights, `message = "Closed team's subscription not ended"` names the team and the error; `"Team reopened while its subscription was being ended"` needs the subscription resumed in Stripe by hand; `"Closed team's subscription renewed after it closed"` (a warning, not a failure) needs a refund. |
| **Deletion overdue** | `ClosedTeamsOverdue`: closed teams still there more than 24 hours (`PURGE_OVERDUE_AFTER_HOURS`) after their deletion date, counted on the closed-teams index however many there are (not capped at the 100 a run lists), including index entries the app didn't write. The purge (`backend/src/ops/team-purge-handler.ts`, primary region) sends it every run that can read the index, zero included, even a run where teams fail | above 0 (maximum over 2 hours, so every period holds a run) | P2 |
| **Deletion job not running** | `ClosedTeamsOverdue` samples: none means the purge didn't run (its schedule is disabled or deleted) or every run failed before it could read the index. Missing data breaches. Primary region only (`infra/lib/observability/ops-checks.ts`) | fewer than 1 sample in 3 hours (`PURGE_SILENT_ALARM_HOURS`) | P2 |
| **Team closure emails failing** | `TeamClosedNoticeFailures`: owners of a team that just closed who weren't emailed the day it will be deleted (SES refused, no address on file, or the owners couldn't be listed). The team closes anyway | any, over 15 minutes | P2 |
| **Team reopened emails failing** | `TeamReopenedNoticeFailures`: owners of a team that was just reopened who weren't told it will no longer be deleted (SES refused, no address on file, or the owners couldn't be listed). The team reopens anyway | any, over 15 minutes | P2 |

**Deletion overdue: what to do.** In Logs Insights on `/aws/lambda/supply-checkout-<env>-team-purge`, `filter message = "Team purge failed"` gives each failing team's `teamId` and the error's name; `message = "Purged closed teams"` shows each run's `due`, `purged`, `failed` and `overdue`. A Stripe error name (`StripeConnectionError`, with the Stripe error's `type`, `code`, `status` and `requestId`) means the team's Stripe customer couldn't be deleted, and the team waits for it: check Stripe's status and that the purge can read the Stripe secret key. An `AccessDeniedException` means the purge's IAM policy no longer matches what it deletes (`TEAM_PURGE_ATTRIBUTES`); throttling or a timeout clears as later runs carry on. If a run stops at its time budget every hour, a team is bigger than one run can delete: the next runs carry on from where it stopped, so watch that `overdue` falls. Fix the cause and the next hourly run deletes the team; the alarm recovers when the gauge reads 0. If the gauge stays above 0 and no team fails, look in GSI1's `TEAMS#CLOSED` partition for entries that aren't a team's META item: the purge doesn't list them but the gauge counts them, and a person should remove them.

**Deletion job not running: what to do.** Check the `supply-checkout-<env>-team-purge` EventBridge rule is there and enabled (a deploy restores it), and that the function has recent invocations. If it runs but fails, its log group has the error: an `AccessDeniedException` on the count query or the listing means its IAM policy no longer matches (`TEAM_PURGE_ATTRIBUTES`). The alarm recovers with the first run that sends the gauge.

**Team closure emails failing: what to do.** The account function logs `Team closure emails not sent` with the team ID, counts and SES's error names (never addresses). For `MessageRejected` or a suppressed address, check SES's account dashboard and the suppression list; for `NoAddress`, the owner has no email on file. The team is closed either way; if an owner may not know, look them up from the team ID and tell them the deletion date.

**Team reopened emails failing: what to do.** The same, for the log message `Team reopened emails not sent`. The team is open either way; if an owner may still expect it to be deleted, tell them it was reopened.

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

`Checkouts`, `Returns`, `LiveUpdates` and `LiveUpdateFailures` (the stream consumer's publishes, for "Live updates failing"), `ReceiptReads`, `ReceiptReadFailures`, `ReceiptLines` (units a receipt adds to existing sheets, apart from `Checkouts` since they never were in storage), `SignUps`, `InvitesSent`, `InvitesAccepted`, `CheckoutSessionErrors`, `BillingPortalErrors`, `WebhookSignatureFailures`, `ConditionalWriteConflicts`, `Writes` (the denominator for "Writes rejected"), `ReceiptTokens` (receipt token usage, with the team ID as metadata rather than a dimension), `SignOutRevokeFailures`, `EmailVerifyFailures`, `EmailUnverifyFailures`, `EmailCodeSendFailures` and `EmailCodeVerifyFailures` (for "Email codes failing"), `LiveUpdatesDeferred` (for "Live updates deferred"), `TeamClosedNoticeFailures` (for "Team closure emails failing"), `TeamReopenedNoticeFailures` (for "Team reopened emails failing"), `OperatorAuditChanged` (the operator audit watch, primary region only, for "Operator audit changed", [Operators](infrastructure.md#operators)), `OperatorAuditWatchHeartbeat` (the watch's heartbeats, for "Operator audit watch silent"), `OperatorGroupChanged`, `OperatorGroupBaselineReset` and `OperatorGroupMembers` (the operator group watch, primary region only, for "Operator group changed" and "Operator group watch silent"), `DeletionRecordRewrites` (the deletion records watch, primary region only, for "Deletion record rewritten", [backups.md](backups.md#when-a-deletion-record-is-rewritten)), and for seats (`supply-checkout-l50`) `SeatQuantityUpdates`, `SeatQuantityDrift` (for "Seat counts drifting") and `SeatSyncQueueFailures`. Four are gauges, levels a scheduled function measures and sends with `gauge()`, read at their maximum: `StuckImports`, `EmailQuotaUsedPercent`, `ClosedTeamsOverdue` (for "Deletion overdue") and `SeatReconcileTeams` (for "Seat reconciliation not running"). Each has a `Region` dimension, even while there is only us-east-1, so they split cleanly when us-west-2 is added.

The names are in `backend/src/observability/names.ts`, which both the Lambda code and the dashboard and alarms import. Send them with `count()` from `backend/src/observability`, in namespace `SupplyCheckout`. The dashboard already has a graph for each; until the handlers exist, the graphs are empty and the alarms stay OK.
