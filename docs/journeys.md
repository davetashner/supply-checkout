# Customer journeys

These are the journeys Supply Checkout must never break. Each one lists who does it, the steps, what should happen, the tests that prove it works, and whether it is **critical**: blocked for even a few minutes, it stops crews working or stops us getting paid. The second half of this page lists the alarms that tell us when a journey is blocked in production.

Each step has an ID (J4.2 is the second step of J4). The journeys, their steps and their alarms live in [`journeys/registry.json`](../journeys/registry.json), and the journeys table and step lists below are generated from it. See [Keeping this page current](#keeping-this-page-current).

End-to-end tests of every journey against a deployed environment are `supply-checkout-o60`. Until then, "tests" below means the Playwright suites that run against the mock runtime and the fake API (`tests/`), and the backend's tests (`backend/test/`).

## Keeping this page current

When you add or change a feature, update the journey, its tests and its alarms in the same pull request:

1. Change the journey's steps, a step's status (`built` or `planned`) or its alarms in [`journeys/registry.json`](../journeys/registry.json), then run `npm run journeys:docs` to regenerate the journeys table and step lists here. The Status column is computed from the steps; don't edit it by hand.
2. Tag the Playwright tests that prove a step with the step's ID, `test("…", { tag: ["@J4.2"] }, …)`, or tag a whole `test.describe`. A test that belongs to a journey without proving one step gets the journey's tag, `@J4`. In a test that walks through several steps, name its `test.step` blocks by step: `test.step("J4.2 Scan an item and choose how many", …)`. Backend tests go in the step's `tests` list in the registry, by path.
3. Add a new alarm to the registry with the journeys it watches, and to this page's alarm tables; once it's built, give it its `infra` ID and add it to [Which alarms exist](#which-alarms-exist).
4. Run `npm run journeys:trace`. It prints each step with its tests and alarms, and fails when a built step has no test, a critical journey has no alarm of its own, a tag names a step that doesn't exist, or this page doesn't match the registry. A built step that really has no automated test yet gets an `untested` reason in the registry instead of a fake tag. CI's lint job runs it.

To run one journey's tests: `npx playwright test --grep "@J4\b" --project=desktop-chrome` (the `\b` keeps `@J1` from matching `@J10`), or one step's: `--grep "@J4.2\b"`. To watch them, `npm run journeys:video -- --only J4` records a video of J4 from the tests tagged with its steps, with each step's result ([Journey videos](testing.md#journey-videos)).

## People

| Persona | Who they are | Role in the app |
| --- | --- | --- |
| **Owner** | Runs a small cleaning, maintenance or contracting business. Sets things up on a laptop, pays the bill. | Owner: everything, including billing and members |
| **Crew member** | Takes supplies from storage to client jobs, usually on a phone, often early in the morning. | Contributor: scan, check out, return, read receipts, edit projects and inventory |
| **Bookkeeper** | Checks what was used and what to charge clients. | Viewer: sees everything, changes nothing |

## Journeys

<!-- journeys:table -->
**Status** (computed from the registry by `npm run journeys:docs`)
- **Tested**: every step is built and has automated tests. "Still to come" names what's planned beyond the steps.
- **Built, not all tested**: every step is built; some have no automated test yet, for the reasons in the registry.
- **Partly built**: some steps are built and tested; the steps marked *Planned* aren't built yet.
- **Planned**: no step is built yet. The beads listed build it.

| # | Journey | Persona | Critical | Status |
| --- | --- | --- | --- | --- |
| [J0](#j0-sign-in) | Sign in | Everyone | Yes | Tested |
| [J1](#j1-sign-up-and-start-a-trial) | Sign up and start a trial | Owner | Yes | Partly built |
| [J2](#j2-set-up-the-inventory) | Set up the inventory | Owner | No | Tested |
| [J3](#j3-invite-the-crew) | Invite the crew | Owner, crew member | No | Tested; still to come: opening the mobile app from the invite link (phase 2) |
| [J4](#j4-check-supplies-out-and-back-in) | Check supplies out and back in | Crew member | Yes | Tested |
| [J5](#j5-read-a-receipt) | Read a receipt | Crew member, owner | No | Tested; still to come: a subscribe link in the trial's receipt limit message, once the in-app plan picker exists |
| [J6](#j6-export-a-project-to-bill-a-client) | Export a project to bill a client | Owner, bookkeeper | No | Tested |
| [J7](#j7-subscribe-add-seats-and-see-invoices) | Subscribe, add seats and see invoices | Owner | Yes | Partly built |
| [J8](#j8-a-payment-fails-and-is-fixed) | A payment fails and is fixed | Owner | Yes | Partly built |
| [J9](#j9-a-viewer-can-see-but-not-change) | A viewer can see but not change | Bookkeeper | No | Tested |
| [J10](#j10-cancel-and-take-the-data) | Cancel and take the data | Owner | No | Tested |
| [J11](#j11-delete-an-account) | Delete an account | Anyone | No | Tested |
| [J12](#j12-choose-a-plan-in-the-mobile-app) | Choose a plan in the mobile app | Owner | No | Planned (phase 2) |
| [J13](#j13-take-company-equipment-to-a-job-and-bring-it-back) | Take company equipment to a job and bring it back | Crew member | Yes | Tested |
| [J14](#j14-take-supplies-without-a-job) | Take supplies without a job | Crew member | Yes | Tested |
| [J15](#j15-reorder-before-running-out) | Reorder before running out | Owner, crew member | No | Tested |
<!-- /journeys:table -->

---

### J0. Sign in

**Persona:** everyone. **Critical:** every other journey starts here.

<!-- journeys:steps J0 -->
- **J0.1** Open the app on a phone or laptop.
- **J0.2** Sign in with an email code, a passkey, Apple or Google.
- **J0.3** If the person belongs to more than one team, pick the team.
<!-- /journeys:steps J0 -->

**Expected:** the team's projects appear within 3 seconds. Staying signed in lasts 30 days on the same device. Signing in with Apple or Google using the verified email of an existing account, at an address that provider runs (Gmail or the account's own Workspace domain; iCloud or an Apple relay address), opens that same account and its teams (`supply-checkout-0b1`: `backend/test/account-link.test.ts`, and the retry in `tests/aws-account.spec.js`). A person removed from a team no longer sees it on their next request.

**Status:** tested (`supply-checkout-zsm`: Cognito and Managed Login; `supply-checkout-l5y`: the team switcher). The tests use a fake Managed Login: `tests/aws-account.spec.js`, `aws-session-tabs.spec.js` and `aws-two-step.spec.js`, and `backend/test/auth-api.test.ts`.

### J1. Sign up and start a trial

**Persona:** owner. **Critical:** no sign-ups, no new customers.

<!-- journeys:steps J1 -->
- **J1.1** Visit supplycheckout.com, read the pricing page, tap **Start free trial**. *Planned: `supply-checkout-21q`.*
- **J1.2** Sign up and accept the terms. *Planned: `supply-checkout-21q`.*
- **J1.3** Name the team.
<!-- /journeys:steps J1 -->

**Expected:** an empty team ready to use in under a minute, with a 14-day trial and no card needed. The terms acceptance time is stored. Every new account, however it signed up (an email code, Google or Apple), gets one welcome email within a minute: greeting them by name if the account has one, linking to the app, with the next step (create a team, with its 14-day trial and no card needed; or, for someone invited, accept the invite) and the support address. A password reset or a later sign-in never sends another, and a failed send never holds up sign-up (`supply-checkout-6uw.25`: `backend/test/welcome.test.ts`). In the web app, the new team opens with a short **Get your team started** checklist above the projects and inventory: add supplies (by hand, or import a CSV using the import's template), invite the crew from Members, and create a first project. Each step ticks itself off from what's saved, and the checklist shows to the team's owners on that device until every step is done or they dismiss it (`supply-checkout-dhc`: `tests/aws-first-run.spec.js`, including accessibility in light and dark mode and a phone-width layout).

**Status:** partly built. Sign-in (`supply-checkout-zsm`), team creation (`supply-checkout-l5y`: `GET /me` and `POST /teams`, see [docs/api/onboarding.md](api/onboarding.md)), the trial (`supply-checkout-x0l`) and the checklist (`supply-checkout-dhc`) are built. The landing and pricing pages, and accepting the terms at sign-up, are `supply-checkout-21q`.

### J2. Set up the inventory

**Persona:** owner.

<!-- journeys:steps J2 -->
- **J2.1** Open **Inventory**, tap **+ Add item**.
- **J2.2** Type or scan a barcode (or leave it blank), then enter the name, price and how many are in storage.
- **J2.3** Edit or delete items later by tapping their row.
- **J2.4** Or import an existing inventory: **Import CSV** in **Inventory** checks the file, shows a preview, and imports it.
- **J2.5** In the web app, an owner sets the markup charged on company equipment bought for a client in **Team settings** (0% until set). Only owners see it.
<!-- /journeys:steps J2 -->

**Expected:** items appear in the list with storage counts, value per item and totals. Items without a barcode can be found by name when checking out.

**Status:** tested. Importing a CSV is in the web app, for owners (`aws-import.spec.js`, `backend/test/imports-api.test.ts`); moving a claude.ai artifact's data into a team is an operator script (`supply-checkout-ig9`).

**Tests:** `inventory.spec.js` (all tests), `barcode.spec.js`: "an item's barcode can be scanned when adding it to inventory", and in the web app, `aws-import.spec.js` and `aws-first-run.spec.js` (the new team's checklist leads here).

### J3. Invite the crew

**Persona:** owner, then crew member.

<!-- journeys:steps J3 -->
- **J3.1** The owner opens **Members**, enters a crew member's email and picks **Contributor**.
- **J3.2** The crew member gets an email, taps the link on their phone and signs up or signs in.
<!-- /journeys:steps J3 -->

**Expected:** the email arrives within a minute. The link works once and expires after 7 days. The crew member sees the team's projects right away, and the seat count on the subscription goes up.

**Status:** tested. Inviting, the email, accepting, resending, revoking and failed deliveries are in `tests/aws-invites.spec.js` and `tests/aws-account.spec.js` (the web build) and `backend/test/invites-api.test.ts` (`supply-checkout-5tp`, `supply-checkout-5hx`, `supply-checkout-dj6`). The seat count follows the members (`supply-checkout-l50`, see J7). The link opens the web app; opening the mobile app from it (universal links) comes with the phase 2 apps.

### J4. Check supplies out and back in

**Persona:** crew member. **Critical:** this is the job the app does every morning.

<!-- journeys:steps J4 -->
- **J4.1** Create a project for the client and date, or open today's project.
- **J4.2** Scan each item's barcode with the phone camera (or type the number, or pick an item that has no barcode) and choose how many.
- **J4.3** Back from the job, switch to **Return**, scan what came back unused, and tap **Finished Return** (which first asks where any company equipment still out is, J13.4).
<!-- /journeys:steps J4 -->

**Expected:** each checkout takes storage counts down and each return puts them back. The project shows taken, returned, used and the charge. Other people's phones show the changes within 2 seconds. Nothing is lost if two people work on the same project. On a slow or flaky connection, a checkout or return never shows as saved before the server confirms it, a double tap or a retry never counts twice, and one that didn't save keeps what was entered and says so, with Try again.

**Status:** tested.

**Tests:**
- `app.spec.js`: "creates a project recording client, date and who prepared it"; "checks out a new barcode, returns part of it, and finishes the return"; "storage counts go down on checkout and back up on return"; "adds an item that has no barcode"; "returning the same item again adds to what's already been returned"
- `barcode.spec.js`: reading barcode photos, including when the photo can't be read
- `projects.spec.js`: editing projects and lines, picking and returning items without barcodes, reopening and deleting
- `concurrent.spec.js`: another person changing the same project at the same time
- `failures.spec.js`: failed saves leave the screen as it was
- `save-states.spec.js` and `aws-save-states.spec.js`: saving on a slow connection, double taps, timeouts, lost answers, and going offline and back

**Live updates deferred: what to do.** A budget stop isn't a failure: the consumer always sends the batch's first chunk (up to 5 changes, to every member of that team) and reports the first record it didn't finish, and Lambda invokes it again from there. Sustained deferral means changes are arriving late. In the consumer's logs (the log group of `supply-checkout-<env>-live-updates`, the realtime stack's `PublisherLogs`; see [Finding a function's log group](#finding-a-functions-log-group)), the `Publish budget used up` warnings and the `Batch` lines' `publishes`, `deferred` and `lagMs` say how far behind it is. Many publishes per batch means big, busy teams; few publishes with deferrals means AppSync is slow (check its metrics and the AWS Health Dashboard). Each stop may use one of the event source mapping's retry attempts (`STREAM_RETRY_ATTEMPTS`, 25, at least the batch size, so stops alone always drain a batch); a batch that still runs out goes to the dead-letter queue, and Live updates dropped fires.

### J5. Read a receipt

**Persona:** crew member or owner, after buying supplies.

<!-- journeys:steps J5 -->
- **J5.1** Tap **Scan receipt** and photograph the receipt.
- **J5.2** Check each line: name, quantity, price, and the suggested inventory match.
- **J5.3** Assign each line to a client (a new or existing project) or to **General inventory**, then tap **Save**. Company equipment bought for a client is charged on their project (the receipt price plus the team's markup, or a price typed instead); in General inventory it adds to storage and isn't charged.
<!-- /journeys:steps J5 -->

**Expected:** lines appear within 60 seconds. Nothing is saved until **Save**. A line that matches company equipment, assigned to a client, says "Company equipment · bought for this client" and goes on their project as its own charged line, "<item> (bought for this client)", never returned or asked about at Finished Return; in the web app the server charges the receipt price plus the team's markup (only owners see the percentage), and in the claude.ai app the receipt price; the reviewer can type a price instead, and the project says who typed it ([ADR 0017](adr/0017-company-equipment-and-ad-hoc-checkout.md), section 2a). In General inventory it adds to storage and isn't charged. An item that comes in packs of n shows "1 case = n each" and adds eaches (cases × n) at a cost of the case price ÷ n, rounded to cents, unless the line is switched to **Priced per each**. Where the price differs from the item's, the line offers **Charge the receipt price** or **Keep the client price**, and keeps the client price by default when the item's cost is below its price (ADR 0014). Client items go on the projects at the chosen price, with the receipt's cost; storage items raise storage counts; and the receipt's cost each is saved to the item. If reading fails, the person can enter the items by hand.

**Status:** tested in both builds. The claude.ai artifact reads receipts with claude.ai's `sample`; the web app sends the photo to `POST /teams/{teamId}/receipts/read`, which reads it with Claude on Bedrock with a 25-second deadline (`supply-checkout-kx8`). Each read counts against the person's own rate limit (10 a minute, 60 an hour, 200 a day, from all their teams) and the team's allowance, provisional until pricing is decided: 200 a month while it pays or has a comp, 25 in all for a trial, and at most 30 trial reads a day per person across their trial teams (`supply-checkout-wxx`). A read the model service refused with a throttle or a 503 is given back to the team. A team that subscribes mid-month has that month's trial reads counted against its 200. In the web app, **Stop** before the photo is sent sends nothing; once the read has been sent, Stop or the app's 40-second timeout only stops waiting for it: the server still reads the receipt, and it counts against the team's allowance.

**Tests:** `app.spec.js`: "receipt review merges duplicates and splits items between a client and storage"; `receipts.spec.js` (all tests, including the default price choice and pack conversion); `aws-data.spec.js`: "a receipt's cases are stock commands in eaches at the cost of one each"; `aws-receipts.spec.js` (the web build on the receipt endpoint: the photo sent, product keys as matches, the model's text shown as text, the monthly and trial limits, the scans left under the bar and in Team settings, the per-person rate limit's messages, a model timeout, an unusable reply and the other failures); `backend/test/receipts-api.test.ts` (the endpoint); `resilience.spec.js`: failed reads, empty photos and resuming an unsaved review.

### J6. Export a project to bill a client

**Persona:** owner or bookkeeper.

<!-- journeys:steps J6 -->
- **J6.1** Open a finished project.
- **J6.2** Tap **Download CSV**.
<!-- /journeys:steps J6 -->

**Expected:** a CSV named after the client and date, with each item's price, taken, returned, used and charge, and a total row. Company equipment on loan isn't in it: it isn't charged (J13).

The project list has a search box that matches a project's client ("General Use" for the General Use project), who prepared it, or an item on it, in any filter, and says when nothing matches. On **Returned** and **All**, finished projects are grouped by month under year headings, newest first, each with its count of projects and, for owners, its total charge (the General Use project is counted but never charged). This year (or the newest year) is open; older years open and close with the keyboard, and stay as they were left for the session. A year filter beside the chips narrows the list to one year, and the owner's **Export data** button then says the year ("Export 2026") and its projects CSV has only that year's projects; the inventory CSV and the JSON stay whole. Out now and the open ad hoc card work as before.

**Status:** tested. Owners can also export all of a team's data: on the project list, **Export data** offers every project (one CSV row per item), the inventory (CSV), or everything (JSON, each document as stored plus each project's totals). It's built in the browser from the collections the app has already loaded, so it matches the screens and needs no server route; 1,000 projects take well under a second once listed. It shows for owners only (`user.isOwner()`), whether or not they can write, so it keeps working while a team is read-only.

**Tests:** `app.spec.js`: "exports a project as CSV"; `startup.spec.js`: "CSV export quotes commas and quotes, and names untitled projects", "a declined download is silent", "a failed download explains"; `export.spec.js` (all tests); `find-projects.spec.js` (search, year and month groups, the year filter and the export it scopes); `aws-data.spec.js`: "an owner exports 1,000 projects, listed page by page, as a JSON download", "members who aren't owners get no Export data".

### J7. Subscribe, add seats and see invoices

**Persona:** owner. **Critical:** this is how we get paid.

<!-- journeys:steps J7 -->
- **J7.1** Before or at the end of the trial, open **Billing** and choose a plan. *Planned: `supply-checkout-8jc.5`.*
- **J7.2** Pay on Stripe Checkout (card, Apple Pay or Google Pay).
- **J7.3** Later, invite more people (seats go up) and open past invoices.
<!-- /journeys:steps J7 -->

**Expected:** the team shows as active within a minute of paying. Adding or removing an owner or editor, or changing someone between viewer and a billed role, updates the seat count with proration; viewers are free. Invoices are emailed and listed in the app with the company name.

**Status:** partly built: everything but choosing a plan in the app (J7.1) is built, in the Stripe sandbox. Checkout (`supply-checkout-x0l`) and the webhook, queue and worker (`supply-checkout-2kl`) are built: a finished checkout sets the team's plan, seats and status within a minute, a team whose trial ends without a card turns read-only with a banner (and owners are emailed), and an owner of a read-only team can subscribe again from the team bar. Owners of a team with a Stripe customer open the Customer Portal (`supply-checkout-121`) from **Billing** in the team bar, to add or change a card, switch between monthly and annual, see and download invoices, and cancel at the end of the period; a cancellation shows in the team bar within a minute. Seat sync (`supply-checkout-l50`) is built: Checkout starts the subscription at the team's owners and editors (viewers are free; the owner doesn't pick a seat count, `supply-checkout-8jc.20`), the quantity follows them within a minute of a membership change, and right after Checkout, with proration, and a nightly reconciliation fixes and alarms on any drift ([infrastructure](infrastructure.md#billing), Seats). The same nightly run checks each team's subscription, status, plan and seats against Stripe and fixes and alarms on any drift (`supply-checkout-8jc.9`), so a lost or stuck webhook is put right within a day ([runbook](runbooks/billing-dlq-replay.md)). Invoices are listed in the app (`supply-checkout-eja`): **Invoices** in the team bar shows owners the latest ones from Stripe, with Stripe's hosted page and PDF, which carry the billing name, address and tax ID Checkout collected; Stripe emails them (a Dashboard setting, [infrastructure](infrastructure.md#billing), Invoice and receipt emails). Still to come: the in-app plan picker (`supply-checkout-8jc.5`). Tests: `backend/test/billing-api.test.ts` (with the invoice list), `billing-webhook.test.ts`, `billing-worker.test.ts` ("canceling in the Customer Portal"), `billing-seats.test.ts` (seat sync and the entitlement check), `members-api.test.ts`, `invites-api.test.ts` and `account-deletion-api.test.ts` ("seats"), `ops-checks.test.ts` (the reconciliation), `billing-ddb.test.ts`, `stripe-catalog.test.ts` (the portal configuration), and `tests/aws-billing.spec.js`.

### J8. A payment fails and is fixed

**Persona:** owner. **Critical:** if this breaks, paying customers lose access, or we give access away.

<!-- journeys:steps J8 -->
- **J8.1** A renewal payment fails.
- **J8.2** The owner sees a banner and gets an email. The team keeps full access for 7 days. *Planned: `supply-checkout-qdx`.*
- **J8.3** The owner updates their card in the Customer Portal.
<!-- /journeys:steps J8 -->

**Expected:** after 7 days without payment the team becomes read-only. Nothing is deleted. As soon as payment succeeds, full access returns within a minute.

**Status:** partly built. J8.1 and J8.3 are built: the payment-failed email and the webhooks (`supply-checkout-2kl`), and owners fix the card in the Customer Portal from **Billing** in the team bar (`supply-checkout-121`); a paid invoice reaches the team within a minute. The 7-day grace period is built (`supply-checkout-qdx`, `billingAccess`): a `past_due` team keeps full access for 7 days from when the worker first applied `past_due`, then is read-only (403 `subscription_ended`, `readOnlyReason: payment_overdue` on `/me`) until it's paid; `/me` has the grace's end (`paymentGraceEndsAt`). Still to come in J8.2: the banner during the grace and the read-only email at its end (`supply-checkout-qdx`), and `supply-checkout-5hx` (email).

### J9. A viewer can see but not change

**Persona:** bookkeeper.

<!-- journeys:steps J9 -->
- **J9.1** Sign in and open projects and inventory.
<!-- /journeys:steps J9 -->

**Expected:** everything is visible. No scan, edit, delete or receipt controls appear, and the server refuses any write that is attempted anyway.

**Status:** tested, in the UI and on the server (`supply-checkout-dj6`: `backend/test/roles.test.ts`, and in the web app, `aws-data.spec.js`: "a checkout by someone made a viewer meanwhile is refused").

**Tests:** `app.spec.js`: "view-only users can't make changes"; `projects.spec.js`: "view-only users can open a project but not change it"; `inventory.spec.js`: "view-only users see inventory but can't change it"; `resilience.spec.js`: "a permission failure switches the page to view-only".

### J10. Cancel and take the data

**Persona:** owner.

<!-- journeys:steps J10 -->
- **J10.1** Open the Customer Portal from **Billing** and cancel.
- **J10.2** Export all projects and inventory.
- **J10.3** After 30 days read-only, and at least 7 days after a warning email, the team is closed and its data deleted.
<!-- /journeys:steps J10 -->

**Expected:** access continues to the end of the paid period, then the team is read-only for 30 days with export available. After that the data is deleted, as the privacy policy says.

**Status:** tested. Cancelling in the Customer Portal is built (`supply-checkout-121`): the subscription runs to the end of the period, the team bar says when it ends, and then the team is read-only with export available. Deleting it is built (`supply-checkout-qdx`): the hourly lapsed-team job warns each owner by email at least 7 days ahead, asks Stripe again that nothing is live, then closes the team 30 days after it ended (or 7 days after the warning, if later), and the hourly purge deletes it as it deletes a team an owner closed. A trial that ends without a plan goes the same way. Export is built (`supply-checkout-zuv`, see J6); it only reads, through the list routes, so read-only mode must keep those open to owners.

### J11. Delete an account

**Persona:** anyone. (Required by the App Store and promised in the privacy policy.)

<!-- journeys:steps J11 -->
- **J11.1** Open **Account → Delete account** in the team bar (or **Delete account** on the first screen) and type DELETE.
- **J11.2** An owner of a team others are in either makes another member an owner or closes the team (**Members → Close the team**, typing its name) first; the app shows the server's message naming those teams.
<!-- /journeys:steps J11 -->

**Expected:** done without contacting support. The user is out of every team, a team they were alone in is closed, invites to their address and their sign-in are gone, and a closed team's data is deleted 30 days after it closed. Closing a subscribed team sets its Stripe subscription to cancel at the period's end within seconds (the billing worker, `supply-checkout-8jc.30`), or within about an hour if that fails (the hourly purge, `supply-checkout-t0en`), and the purge deletes its Stripe customer with its data. The data is deleted on schedule even when Stripe is down: the customer's deletion is then queued and retried every hour until Stripe takes it (`supply-checkout-8jc.42`). Reopening it resumes that subscription within seconds (the billing worker, `supply-checkout-85qp`), or, if it has already ended, leaves the team read-only with Subscribe for its owners.

**Status:** tested (`supply-checkout-b1h`). The 30-day deadline is watched: the hourly purge sends `ClosedTeamsOverdue`, the closed teams still there more than 24 hours after their deletion date, and **Deletion overdue** alarms on any, including a team the purge holds because its subscription is set aside for a person (`supply-checkout-8jc.37`: it waits until someone ends the subscription and clears it, or until 14 days past its deletion date, when the purge deletes it anyway and **Held team purged with its subscription unresolved** alarms, `supply-checkout-8jc.40`); if the purge stops sending the gauge for 3 hours (its schedule disabled or deleted, or every run failing before it reads the index), **Deletion job not running** alarms ([J9, J10, J11](#j9-j10-j11-roles-cancellation-and-deletion)). The deadline doesn't wait on Stripe (`supply-checkout-8jc.42`, the owner's decision): a team whose Stripe customer can't be deleted when it's due is purged anyway, its customer's deletion queued and retried hourly, and **Stripe customer deletion retrying** (a day) and **Stripe customer deletion stuck** (a week) alarm if Stripe still hasn't taken it. **Tests:** `backend/test/account-deletion-api.test.ts` (closing, deleting, the purge and its overdue gauge, isolation of each session), `backend/test/closing.test.ts` (the same against DynamoDB Local, including that the data is gone after 30 days and not before), `backend/test/stripe-deletions.test.ts` (a purge while Stripe is down, and the queued customer deletion retried, against DynamoDB Local), `tests/aws-account-deletion.spec.js` (the web app: leaving, closing, a closed team, reopening it, deleting). An owner who is still in a closed team can reopen it until an hour before the purge (`supply-checkout-d9su`), and never once the purge has marked it `purging`. Support can reopen it until 5 minutes before the purge, and never once it's marked `purging`, for a disputed closure (`npm run ops -- reopen`, `supply-checkout-6uw.6`; tests in `backend/test/ops-api.test.ts`, `ops-reopen.test.ts` and `ops-ddb.test.ts`).

### J12. Choose a plan in the mobile app

**Persona:** owner, in the iOS or Android app.

<!-- journeys:steps J12 -->
- **J12.1** Open **Plans** in the app and choose a plan and seats. *Planned: `supply-checkout-8jc.5`.*
- **J12.2** Pay on Stripe Checkout in the in-app browser with Apple Pay or Google Pay. *Planned: `supply-checkout-8jc.5`.*
- **J12.3** Return to the app. *Planned: `supply-checkout-8jc.5`.*
<!-- /journeys:steps J12 -->

**Expected:** the app shows the plan as active without reopening it. Where store rules don't allow the link, the app shows "Manage your plan on our website" and no prices ([ADR 0013](adr/0013-web-billing-only.md)).

**Status:** planned for phase 2. `supply-checkout-8jc.5`.

### J13. Take company equipment to a job and bring it back

**Persona:** crew member. **Critical:** it's part of the morning checkout, and the owner relies on it to know where the company's ladders and vacuums are.

<!-- journeys:steps J13 -->
- **J13.1** In **Inventory**, mark items that go to jobs and come back (ladders, vacuums, cords) as **Company equipment**, with what each is worth.
- **J13.2** Check equipment out on a project like any item. It's listed under **Equipment (not charged)**, apart from the supplies, and isn't in the project's total or the client's CSV.
- **J13.3** Back from the job, switch to **Return** and scan what came back.
- **J13.4** Tap **Finished Return**: for each piece still out, say it's back, still at the job, or lost or broken (with an optional charge to the client).
- **J13.5** See what's out, on which project, who took it and when, in **Inventory → Equipment → Out on jobs**.
<!-- /journeys:steps J13 -->

**Expected:** equipment checked out on a project takes storage counts down and its return puts them back, as for supplies, but the client isn't charged for it: it's listed apart, under **Equipment (not charged)**, isn't in the project's taken, used or charge totals, and isn't in the project's CSV ([ADR 0017](adr/0017-company-equipment-and-ad-hoc-checkout.md)). Unreturned equipment is still out, not used. **Inventory → Equipment → Out on jobs** lists every piece still out on an open project, with who took it last and when. The owner's **Export data** keeps equipment rows, with a **Kind** column.

**Status:** tested (`supply-checkout-h9to`). **Finished Return** on a project with equipment still out asks first, for each piece, how many are back (a return), how many were lost or broken (the `lost` command, with an optional charge for the lot, which goes on the project as "<item> (lost or broken)", in its total and the client's CSV), and leaves the rest still at the job: the project stays open until nothing is out, and the server refuses to close it otherwise (409 `equipment_out`).

**Tests:** `equipment.spec.js` (all tests), and the server's in `backend/test/equipment-api.test.ts` and `backend/test/equipment.test.ts`.

### J14. Take supplies without a job

**Persona:** crew member. **Critical:** a box of gloves for the van, or supplies for several small jobs, is taken every week, and without it storage counts drift.

<!-- journeys:steps J14 -->
- **J14.1** On the project list, tap **Quick take** and scan (or pick) what you're taking, and how many. It goes on **General Use (no job)**, shown above the other projects.
- **J14.2** Bringing something back, tap **Return** on the project list and scan it: it goes back to the project it's out on, or you pick the project when it's out on more than one.
- **J14.3** To bill a client for something taken ad hoc, open **General Use (no job)**, tap the line and **Move to a project**.
- **J14.4** When the van is restocked, tap **Finished Return** on **General Use (no job)**. The next quick take starts a new one.
<!-- /journeys:steps J14 -->

**Expected:** a quick take checks items out as a checkout does, storage counts going down, onto the team's one open General Use project ([ADR 0017](adr/0017-company-equipment-and-ad-hoc-checkout.md), sections 4 to 6). The first starts it (`adhoc-<n>`), and two people's first takes at once end on the same project. The General Use project is a card of its own above the client projects ("Ad hoc · Since Sep 30 · 6 items out"), and shows no money: nothing on it is charged to anyone. It takes returns but no checkouts, edits of its details or receipt lines. **Return** on the project list finds every open project the item is still out on, and a client project's "Not on this project" offers to return it where it's out. Moving a line takes the whole line with its counts to the client project, which keeps its own price if it already has the item, without moving stock, and a retried move counts once. **Finished Return** asks about equipment as on a client project, with no charge, and a finished General Use project can be reopened only while no other one is open.

**Status:** tested (`supply-checkout-mdae`). The web build sends the quick take and the move as commands (`POST /teams/{teamId}/adhoc/checkout`, `POST /teams/{teamId}/projects/{projectId}/move`, [docs/api/commands.md](api/commands.md)); the claude.ai artifact build writes them as ADR 0017's section 6 describes.

**Tests:** `adhoc.spec.js` (all tests), and the server's in `backend/test/adhoc-api.test.ts` and `backend/test/adhoc.test.ts`.

### J15. Reorder before running out

**Persona:** owner, crew member.

<!-- journeys:steps J15 -->
- **J15.1** In **Inventory**, tap an item and set **Reorder at** (the count that means it's running low) and, if you like, **Usual order**.
- **J15.2** Items at or below their reorder level show **Low** in Inventory, and the **Inventory** tab and **Running low** say how many nobody has acknowledged yet.
- **J15.3** Open **Running low** to copy or download the reorder list, and tap **Acknowledge** once an item is ordered. It's flagged again if stock falls further, or once it's restocked above the level and runs low again.
- **J15.4** Or tap **Mark ordered**, with how many and when (the usual order and today to start). It shows **On order** and isn't flagged until it's restocked above the level and runs low again, or you tap **Cancel order**.
<!-- /journeys:steps J15 -->

**Expected:** an item is **Low** when it's counted and its storage count is at or below its reorder level (whole single items, [ADR 0014](adr/0014-units-cost-and-rounding.md)). Owners and contributors set the level and acknowledge; viewers see what's low and the list but can't acknowledge. An acknowledgment is the team's, kept on the item (`ackedAtStock`, the count when it was acknowledged): the alert stays quiet while the count is at or above that, comes back when it falls below it, and ends when a return, a receipt, a count or an import takes the count above the reorder level, so the next fall to the level alerts again. Saving a new reorder level also starts afresh. **Mark ordered** (supply-checkout-005.14) records how many were ordered and when (`orderedQty`, `orderedOn`), shared by the team on the item like an acknowledgment, and replaces any acknowledgment. While it's on order the item isn't flagged however far stock falls; the reorder list shows "On order: 24 since Oct 1, 2026". The same restocks that end an acknowledgment end the order, as does no longer counting the item; **Cancel order** brings the alert back. A new reorder level keeps the order. The reorder list (copy as text, or download as CSV) has the item's name, its brand if it has one, barcode, count, reorder level, usual order and whether it's acknowledged. Alerts are in the app only for now; an email digest is a later bead.

**Status:** tested (`supply-checkout-005.8`).

**Tests:** `reorder.spec.js` (all tests, including accessibility in light and dark mode and a phone-width layout), `aws-data.spec.js` ("low-stock alerts", the web build's PATCH and the server ending an acknowledgment on a restock), and the server's in `backend/test/reorder.test.ts` and `backend/test/commands.test.ts` (DynamoDB Local).

---

## Alarms for blocked journeys

These alarms tell us when a customer can't finish a journey in production. They are built by `supply-checkout-3sv.1`, on top of the dashboards and logs in `supply-checkout-7pe` and the synthetic canaries in `supply-checkout-pkt`. Each alarm links its runbook (`supply-checkout-tk4`).

Thresholds are starting points. Tune them after a few weeks of real traffic, and write down every change in the alarm's description.

The MVP runs in us-east-1 only ([ADR 0010](adr/0010-multi-region-active-active.md)), so the alarms and canaries below are in us-east-1. When us-west-2 is added in phase 2, the per-region alarms are copied to it, and the alarms in [Phase 2: second region](#phase-2-second-region) are added.

### Finding a function's log group

Every function writes to a log group of its own, which the stack creates and CloudFormation names from the stack and the resource's ID (`<stack name>-PostConfirmationLogs<hash>-<suffix>`, say). It isn't the `/aws/lambda/` group named for the function that Lambda makes by default, which doesn't exist here. For a function with a fixed name, Lambda prints its group: `aws lambda get-function-configuration --function-name supply-checkout-<env>-post-confirmation --query LoggingConfig.LogGroup --output text --profile supply-prod --region us-east-1`. For any function, the Lambda console's Monitor tab → View CloudWatch logs opens it, and in CloudWatch Logs Insights you can search the log group picker for the resource's ID (`PostConfirmationLogs`).

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
| RUM events surge, RUM events flood | Every journey | P2, P1 | The RUM app monitor's ingested events (`AWS/RUM` `RumEventPayloadSize`, `SampleCount`) above 100,000 and 1,000,000 in an hour, in us-east-1 only, where the app monitor is (`supply-checkout-3sv.7`). Not a blocked journey: anyone can send the app monitor billed events. Runbook: [When RUM events surge](observability.md#when-rum-events-surge). |
| Sign-out not revoking, Security notices failing, Security notices dropped | J0 | P2 | As below |
| Sign-in trigger failing | J0 | P1 | As below. In the primary region only, where the user pool is. |
| Sign-up trigger failing | J1 | P1 | As below. In the primary region only, where the user pool is. |
| Welcome emails failing, Welcome emails refused, Welcome email function failing, Welcome emails dropped | J1 | P2 | As below. In the primary region only, where the user pool and the welcome email function are. |
| Imports stuck | J2 | P2 | As below, from the stuck-import check. In the primary region only, where the check runs. |
| Email verification not saved, Email codes failing, Near the sending limit | J3 | P2 | As below. Near the sending limit reads the SES quota check's gauge, and is in the primary region only, where the check runs. |
| Invite surge | J3 | P2 | As below: `InvitesSent` summed over every team |
| Email bouncing, Email complaints | J3 | P1 | SES reputation metrics, as below |
| Email events dropped | J3 | P2 | As below |
| Writes rejected | J4 | P2 | `ConditionalWriteConflicts` ÷ `Writes`, at least 20 writes |
| Live updates failing | J4 | P2 | `LiveUpdateFailures` ÷ `LiveUpdates` from the stream consumer (`supply-checkout-dpc`), at least 20 events, over 10 minutes. The canary's live-update check comes with the canary. |
| Live updates delayed, Live updates dropped, Live updates deferred | J4 | P2 | As below. Live updates deferred needs 3 breaching 5-minute periods in a row. |
| Receipt reading failing, Receipt volume high, Receipt trials near their limit | J5 | P2 | As below (the last two: `supply-checkout-wxx`) |
| Checkout broken, Webhook signature failures, Billing events stuck | J7 | P1 | As below. Billing events stuck watches the billing events dead-letter queue. |
| Billing portal broken | J7, J8 | P1 | As below |
| Billing events late | J7, J8 | P2 | The billing events queue's `ApproximateAgeOfOldestMessage` above 5 minutes |
| Seat syncs stuck, Seat counts drifting, Seat reconciliation not running | J7 | P2 | As below (`supply-checkout-l50`). Seat syncs stuck watches the seat syncs dead-letter queue. The other two read the nightly seat reconciliation's metrics, and are in the primary region only, where it runs. |
| Entitlements drifting | J7, J8 | P2 | As below (`supply-checkout-8jc.9`). Reads the nightly entitlement check's metric, in the primary region only. |
| Lapsed-team job failing, Lapsed-team job not running, Lapsed-team job out of time | J7, J8, J10 | P2 | As below (`supply-checkout-qdx`). Read the hourly lapsed-team job's metrics, in the primary region only, where it runs. |
| Lapsed-team closures held, Lapsed-team closures high | J10 | P2 | As below (`supply-checkout-qdx`). The hourly lapsed-team job's closures, in the primary region only. |
| Reopened team's subscription ended | J7, J11 | P2 | As below (`supply-checkout-8jc.16`). Counted by the billing worker and the closed-team purge, in every region. |
| Reopened team's billing not resynced | J7, J11 | P2 | As below (`supply-checkout-85qp`). Counted by the billing worker for the nightly reconciliation's messages, so in the primary region only. |
| Reopened team's subscription left to cancel | J7, J11 | P2 | As below (`supply-checkout-85qp`). Counted by the billing worker, in every region. |
| Closed team charged | J7, J11 | P2 | As below (`supply-checkout-8jc.18`). Reads the closed-team purge's metric, in the primary region only. |
| Closed-team subscription not found in Stripe, Closed-team subscription set aside | J7, J11 | P2 | As below (`supply-checkout-8jc.17`, `supply-checkout-8jc.36`). Read the closed-team purge's metrics, in the primary region only. |
| Many closed-team subscriptions set aside | J7, J11 | P1 | As below (`supply-checkout-8jc.37`): the same gauge as Closed-team subscription set aside, at 5 or more. In the primary region only. |
| Stripe customer already deleted | J7, J11 | P2 | As below (`supply-checkout-8jc.37`), from the closed-team purge, in the primary region only. |
| Held team purged with its subscription unresolved | J7, J11 | P2 | As below (`supply-checkout-8jc.40`), from the closed-team purge, in the primary region only. |
| Stripe customer deletion retrying, Stripe customer deletion stuck | J7, J11 | P2, P1 | As below (`supply-checkout-8jc.42`). Read the closed-team purge's gauge, in the primary region only. |
| Deletion overdue, Deletion job not running, Team closure emails failing, Team reopened emails failing | J11 | P2 | As below. Deletion overdue and Deletion job not running read the closed-team purge's gauge, and are in the primary region only, with the purge. |

Every other alarm on this page waits for the resource or code it watches, and is added by the bead that builds it (the alarm goes in that region's `observability` stack, with `topics.notify(alarm, severity)`): the canaries (`supply-checkout-pkt`); Firewall blocking customers (WAF, `supply-checkout-qk1`); API unhealthy (it needs a `/health` route and a Route 53 health check, which the API doesn't have yet); Cognito alarms (`supply-checkout-zsm`); Bedrock alarms and Receipt cost spike (the receipt function); and Checkouts stopped, which compares with the same hour last week, and so needs something other than one CloudWatch alarm. The remaining P3 trends (No sign-ups, Invites not accepted, Failed payments rising, App checkouts abandoned) are read from the dashboard at the weekly review.

### Every journey

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Core journey canary failing** | CloudWatch Synthetics canary in us-east-1, every 5 minutes from 8am to 8pm Eastern: sign in as a test crew member, open the test project, check out and return one item, confirm the live update arrives | 2 failed runs out of 3 | P1 |
| **Site down** | CloudFront `5xxErrorRate` on the web distribution | above 1% for 5 minutes (at least 50 requests) | P1 |
| **Web router failing** | CloudFront `FunctionExecutionErrors`, `FunctionValidationErrors` and `FunctionThrottles` of the router function | 5 or more in 5 minutes | P1 |
| **RUM events surge** | CloudWatch RUM `RumEventPayloadSize` `SampleCount` on the app monitor: events ingested, each billed. Not a blocked journey but a cost: anyone can send events with the public identity pool ([runbook](observability.md#when-rum-events-surge)) | above 100,000 in an hour | P2 |
| **RUM events flood** | The same | above 1,000,000 in an hour | P1 |
| **API errors** | API Gateway `5xx` per route | above 2% of requests for 5 minutes (at least 20 requests) | P1 |
| **API slow** | API Gateway `Latency` p95 | above 2 seconds for 10 minutes | P2 |
| **API unhealthy** | Route 53 health check on `/health` in us-east-1 | unhealthy for 2 minutes | P1 |
| **Functions failing** | Lambda `Errors` per function | above 1% for 5 minutes | P1 |
| **Functions throttled** | Lambda `Throttles` per function | any, for 5 minutes | P2 |
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
| **Security notices failing** | `SecurityNoticeFailures`: security notices (a password set, two-step sign-in turned on) that weren't emailed to the account's own verified address (SES refused, took more than 3 seconds, or no verified address). The change stands anyway | any, over 15 minutes | P2 |
| **Security notices dropped** | Messages in the security notices dead-letter queue (`supply-checkout-<env>-security-notices-dlq`, primary region): CloudTrail records of a password, two-step or email change made directly against Cognito that the security notices function failed on after its retries, or EventBridge couldn't deliver (`supply-checkout-8jc.28`). The account may not have been told. | any | P2 |
| **Sign-in trigger failing** | Lambda `Errors` + `Throttles` of the app pool's pre token generation trigger (`supply-checkout-<env>-email-verified`, `supply-checkout-3sv.16`), which exists only while Google or Apple sign-in is on and runs at every token Cognito issues, refreshes included, for every user. A failed call fails that sign-in or refresh. It fails on purpose only when it can't unverify a linked user's changed email (Email verification not saved fires too); otherwise it's a crash, a timeout or a throttle | any, over 5 minutes | P1 |

**Sign-in trigger failing: what to do.** Read the log group of `supply-checkout-<env>-email-verified` (the identity stack's `EmailVerifiedLogs`; see [Finding a function's log group](#finding-a-functions-log-group)) for the error or `Task timed out`; its `Federated email` lines carry the trigger source and outcome only, and `Couldn't mark a linked user's changed email unverified` is the deliberate failure, with a correlation handle (see Email verification not saved). A timeout usually means Cognito's `AdminUpdateUserAttributes`, DynamoDB or the table's KMS key was slow or refused: check Database errors and throttled and Cognito's health. Throttles mean the account's Lambda concurrency is used up (Functions throttled). People who saw the error can try again; nothing is half done. If it's a bad deploy, roll the identity stack back. Don't rename the function to fix it: a new name replaces the live trigger (see Sign-in in [infrastructure.md](infrastructure.md#sign-in)).

**Sign-out not revoking: what to do.** Check Cognito's health in the AWS Health Dashboard and the auth function's logs (`Refresh token not revoked`, with Cognito's HTTP status; 0 means it wasn't reached). The tokens that weren't revoked are only on the devices that signed out, and those devices dropped their cookie, so there's nothing to hand to anyone. If a person asks to be signed out everywhere, run `aws cognito-idp admin-user-global-sign-out` for their user.

**Security notices failing: what to do.** The account function logs `Security notice not sent` with the user ID, the kind (`passwordSet` or `twoStepOn`) and the error's name (never the address). `Timeout` or an SES error such as `MessageRejected`: check SES's account dashboard, the suppression list and SES's health (Email bouncing or Near the sending limit firing too says why). `NoAddress`: the account has no verified email. The change was made either way, so the owner may not know their password or two-step sign-in changed: look the user up by ID and tell them what changed and when. If they didn't make the change, sign them out everywhere (`aws cognito-idp admin-user-global-sign-out`) and help them reset their password.

**Security notices dropped: what to do.** Each message is the CloudTrail event (the user's `sub`, the call's name and time, its IP and user agent; no address or token), kept 14 days. "Security notices failing" fired with it says why: the function's log has `Security notice not sent` with the user ID, kind and code, `lookup_failed` for Cognito, `pending` for an email change notice another attempt claimed and didn't finish (Lambda timed out, say), `error` for anything else (an `AccessDeniedException` means the role's DynamoDB conditions refuse a call: fix the policy first). Once the cause is fixed, replay each message by invoking the function with its body, then delete it: `aws sqs receive-message --queue-url <dlq url> --max-number-of-messages 10`, then for each `aws lambda invoke --function-name <the email stack's SecurityNoticesFunction> --invocation-type Event --cli-binary-format raw-in-base64-out --payload '<Body>' /dev/null` and `aws sqs delete-message --queue-url <dlq url> --receipt-handle <ReceiptHandle>`. Replaying is safe: the notices are claimed, so one already sent isn't sent again. A `totp_record` failure, or a dropped `VerifySoftwareToken`, `SetUserMFAPreference` or `AdminSetUserMFAPreference` event, also never recorded when two-step sign-in was turned on (`supply-checkout-8jc.14`; the billing routes record one themselves when there's none, but an older record would stand), so replay those first; the record only ever moves later, so a replay can't weaken it. A later password, two-step or email event for the same user also catches an email change that was never told.

### J1. Sign up and start a trial

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Sign-up canary failing** | Synthetics canary every 15 minutes: load the landing and pricing pages, open sign-up, start a trial with a `+canary` test address in a canary team that's cleaned up afterwards | 2 failures in a row | P1 |
| **No sign-ups** | `SignUps` business metric | zero for 24 hours when the 7-day average is above 1 a day | P3 |
| **Sign-up trigger failing** | Lambda `Errors` + `Throttles` of the app pool's post confirmation trigger (`supply-checkout-<env>-post-confirmation`, `supply-checkout-8jc.31`). It never fails on purpose, so any is a crash, a timeout or a throttle, and Cognito shows the person confirming their sign-up an error (they're confirmed; signing in works) | any, over 5 minutes | P1 |
| **Welcome emails failing** | `WelcomeEmailFailures`: a new account's welcome email wasn't handed to the welcome email function (`invoke`: a trigger's invoke failed; `deferred`: a trigger had no time left in its budget), or the function didn't send it for a reason other than SES refusing it (`no_address`: no verified address; `lookup_failed`: Cognito; `error`: DynamoDB or anything else thrown; `invalid`: a request that isn't the triggers'). Sign-up went ahead either way, and a failed hand-over isn't tried again (`supply-checkout-6uw.25`). Primary region only | any, over an hour | P2 |
| **Welcome emails refused** | `WelcomeEmailsRefused`: SES refused a welcome email (sending paused, a suppressed address, or, until SES production access, `supply-checkout-3sv.18`, its sandbox refusing an unverified address). Counted apart from the failures above so the sandbox can't hide them. A rate, not any, so the sandbox's occasional refusal doesn't keep it on: lower `WELCOME_REFUSALS_ALARM_PER_HOUR` (`infra/lib/observability/journey-alarms.ts`) to 1 once production access is granted. Primary region only | 3 or more in an hour | P2 |
| **Welcome email function failing** | Lambda `Errors` of `supply-checkout-<env>-welcome-email`: a try that threw (also in Welcome emails failing) or died (a timeout or a crash), which counts nothing else. One that died after claiming the account's welcome sent nothing, and Lambda's retry finds it claimed (it logs `Welcome email already claimed`). Primary region only | any, over 15 minutes | P2 |
| **Welcome emails dropped** | Messages in the welcome email dead-letter queue (`supply-checkout-<env>-welcome-email-dlq`, primary region): requests (a sub and how the account signed up; no address) the function failed on after Lambda's retries, so those accounts haven't had their welcome | any | P2 |

**Sign-up trigger failing: what to do.** Read the log group of `supply-checkout-<env>-post-confirmation` (the identity stack's `PostConfirmationLogs`; see [Finding a function's log group](#finding-a-functions-log-group)) for the error or `Task timed out`; its lines carry the outcome and the error's name only. A timeout usually means DynamoDB or the table's KMS key was slow or refused: check Database errors and throttled. Throttles mean the account's Lambda concurrency is used up (Functions throttled). People who saw the error are confirmed and can sign in; their notice address is recorded at their first sign-in to the app (GET /me). If it's a bad deploy, roll the identity stack back.

**Welcome emails failing: what to do.** The welcome email function (`supply-checkout-<env>-welcome-email`, the email stack's `WelcomeLogs`) logs `Welcome email not sent` with the user's sub, how they signed up, the reason and the error's name; the triggers log `Welcome email not queued` with the error's name (`NoTimeLeft` for `deferred`). `invoke` with `ResourceNotFoundException` means the `email` stack (which has the function) isn't deployed yet, or the function was renamed; `AccessDeniedException` means the trigger's `QueueWelcomeEmail` policy doesn't match its name. `lookup_failed` or `error` are retried by Lambda, then dropped (below). Nobody's sign-up was affected. Nothing retries a failed hand-over (`invoke`, `deferred`) by itself: a Google or Apple user's later sign-ins are `unchanged`, and a native user confirms once. To send one an account missed (a refusal, `invoke`, `deferred`), once the cause is fixed: `aws lambda invoke --function-name supply-checkout-<env>-welcome-email --invocation-type Event --cli-binary-format raw-in-base64-out --payload '{"userId":"<sub>","via":"email"}' /dev/null`. It's safe: an account that already had one isn't sent another.

**Welcome emails refused: what to do.** The function logs `Welcome email not sent` with `reason` `refused` and SES's error name. Before SES production access (`supply-checkout-3sv.18`), `MessageRejected` for unverified addresses is expected; several at once, or after production access, means check SES's account dashboard (sending paused?), the suppression list, and Email bouncing or Near the sending limit. The claim was given up, so once SES takes mail again, replay the accounts that missed it as above.

**Welcome email function failing: what to do.** Read the function's log for the error or `Task timed out`. A thrown try is in Welcome emails failing too, and Lambda retries it. A try that timed out after claiming left the account's `USER#<sub>` / `WELCOME` item claimed with no email sent, and its retry logs `Welcome email already claimed` with the user's sub. If that account got no email, remove the claim (`aws dynamodb update-item --key '{"PK":{"S":"USER#<sub>"},"SK":{"S":"WELCOME"}}' --update-expression 'REMOVE welcomeSentAt'`) and replay it as above. A timeout usually means Cognito, DynamoDB or SES was slow (the SES client gives up within about 15 seconds; the function has 30).

**Welcome emails dropped: what to do.** Each message is a request the function failed on three times (a sub and how the account signed up), kept 14 days. Welcome emails failing fired with it, and its log says why. Once the cause is fixed, replay each message by invoking the function with its body, then delete it: `aws sqs receive-message --queue-url <dlq url> --max-number-of-messages 10`, then for each `aws lambda invoke --function-name supply-checkout-<env>-welcome-email --invocation-type Event --cli-binary-format raw-in-base64-out --payload '<Body>' /dev/null` and `aws sqs delete-message --queue-url <dlq url> --receipt-handle <ReceiptHandle>`. Replaying is safe: the welcome is claimed, so one already sent isn't sent again.

### J2. Set up the inventory

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Imports stuck** | `StuckImports`: CSV imports still committing an hour after they started, and so half applied. A scheduled check (`backend/src/ops/stuck-imports-handler.ts`, primary region, every 10 minutes) counts the jobs in GSI1's `IMPORTS#COMMITTING` partition, which a job is in until its last batch commits. | any (maximum over 15 minutes) | P2 |

**Imports stuck: what to do.** An import stops part-way when its Lambda times out or items keep changing under it, and the owner didn't press **Try again**. Nothing is lost: every row already committed is complete, and the plan for the rest is staged. Imports that no retry could finish (a row too large to save, or a planned key another item took) leave the check on their own when they stop: the owner was told which line and to choose the file again. So everything this alarm lists is something a retry would finish.

1. List the stuck imports with the operator CLI ([Operators](infrastructure.md#operators)): `npm run ops -- stuck-imports` gives each one's team ID, import ID, start time and `committed` of `total` rows. They're IDs only; `npm run ops -- team <teamId>` shows the team's owners (and is audited). The check's own logs have the same: in Logs Insights on the log group of `supply-checkout-<env>-stuck-imports`, `filter message = "Import stuck"`.
2. Tell an owner of the team that their import stopped part-way, and ask them to import the same file again. If the app still shows **Try again**, that carries on from the first row not committed. Otherwise, choosing the file again starts a new import that re-plans against the inventory as it is now, leaves the rows already imported unchanged and finishes the rest. We can't finish it for them: the job keeps the plan, not the file, and a retry must send the same file.
3. If the owner finished it as a new import (or doesn't want it), take the old job out of the check so the alarm recovers. This leaves the job itself alone, so a retry of it still works until it expires. It's audited (`ops.import.clear`), and the team's owners see it under support actions:

   ```bash
   npm run ops -- clear-import '<teamId>' '<importId>' --reason "Owner re-imported the file"
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
| **Receipt volume high** | `ReceiptReads`, summed over every team: model calls the receipts function made. Each user (10 a minute, 60 an hour, 200 a day) and each team (200 a month while it pays, 25 in all for a trial) is already limited; this watches the total, the account's model spend. | above 300 in an hour (`RECEIPT_READS_ALARM_PER_HOUR`) | P2 |
| **Receipt trials near their limit** | `ReceiptTrialsNearLimit`: a trial team's read reached 80% of its trial's allowance, counted once per trial. Paying teams near their month's limit (`ReceiptPaidTeamsNearLimit`) are on the dashboard only. | 5 or more in an hour (`RECEIPT_TRIALS_NEAR_LIMIT_ALARM_PER_HOUR`, provisional) | P2 |

Receipt reading is not critical: people can still enter items by hand.

**Receipt volume high, or trials near their limit: what to do.** Each count goes out as an embedded-metric log line in the receipts function's log group, with the team ID as metadata: in CloudWatch Logs Insights, filter on `ReceiptReads` (or `ReceiptTrialsNearLimit`) and count by `teamId`. Many new trial teams near their trial's limit at once, or most reads from trial teams, is a farm of sign-ups using the trial to reach the model: look at the sign-ups behind them (their owners, in `npm run ops -- team`) and, for abuse, close the teams. One account is already held to 30 trial reads a day across its trial teams (`RECEIPT_TRIAL_READS_PER_USER_PER_DAY`); a farm of many accounts isn't, until the account-wide trial circuit breaker and Bedrock spend budget follow-ups. A paying team near its month's limit (`ReceiptPaidTeamsNearLimit`, on the dashboard) is a sales conversation, and evidence for the plan limits (`supply-checkout-akz`). One team or user far above the rest with many `ReceiptRateLimited` is a client retrying in a loop. The function's `Request` log line also has `refused` (`rate_limited` or `receipt_limit`) and `allowance`. If it's real growth, raise `RECEIPT_READS_ALARM_PER_HOUR` in `infra/lib/observability/journey-alarms.ts`.

### J7. Subscribe, add seats and see invoices

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Checkout broken** | `CheckoutSessionErrors` (our API failing to create a Stripe Checkout session) | any, for 5 minutes | P1 |
| **Billing portal broken** | `BillingPortalErrors` (our API failing to open the Stripe Customer Portal: owners can't add or fix a card, change plans or cancel) | any, for 5 minutes | P1 |
| **Webhook signature failures** | `WebhookSignatureFailures`. Usually a rotated or wrong signing secret. | any | P1 |
| **Billing events stuck** | Billing worker dead-letter queue `ApproximateNumberOfMessagesVisible` | any message | P1 |
| **Billing events late** | Age of the oldest message in the billing queue | above 5 minutes | P2 |
| **Seat syncs stuck** | Seat syncs dead-letter queue `ApproximateNumberOfMessagesVisible`: a sync after a membership change that the billing worker couldn't apply after 5 tries (Stripe or DynamoDB failing). The nightly reconciliation fixes the team's seats anyway. | any message | P2 |
| **Seat counts drifting** | `SeatQuantityDrift`: the nightly seat reconciliation found a subscription whose quantity isn't the team's billed members (owners and editors), or a seat sync found more billed members than a team can have and changed nothing. Primary region only | any, over an hour | P2 |
| **Lapsed-team job failing** | `LapseFailures`: the hourly lapsed-team job (`supply-checkout-<env>-team-lapse`) couldn't handle a team whose trial or subscription lapsed (a read, write or Stripe call failed), couldn't deliver a deletion warning to any of a team's owners or found no owner to send it to (it won't close a team until one got it), or wouldn't close a lapsed team because Stripe disagrees with our record (a live subscription, or the team's subscription or customer missing; an owner in Checkout isn't counted). Primary region only | any, over 2 hours | P2 |
| **Lapsed-team job out of time** | `LapseTeamsUnstarted`, a gauge the job sends every run: lapsing teams it had no time to start (it starts no team after 4 minutes, and starts each run at a random place in the list). Primary region only | above 0 in every hour for 3 hours (`LAPSE_UNSTARTED_ALARM_HOURS`) | P2 |
| **Lapsed-team job not running** | `LapseTeamsChecked` samples: none means the job didn't run (its schedule is disabled or deleted) or every run failed before it listed the teams. Missing data breaches. Primary region only (`infra/lib/observability/ops-checks.ts`) | fewer than 1 sample in 3 hours | P2 |
| **Seat reconciliation not running** | `SeatReconcileTeams` samples: none means the nightly reconciliation didn't run (its schedule is disabled or deleted) or every run failed before it listed the teams. Missing data breaches. Primary region only (`infra/lib/observability/ops-checks.ts`) | fewer than 1 sample a day for 2 days (`SEAT_RECONCILE_SILENT_ALARM_DAYS`) | P2 |
| **Entitlements drifting** | `EntitlementDrift`: the nightly entitlement check (run with the seat reconciliation) found a team whose subscription, status, plan, seats or cancellation at the period's end weren't what Stripe has, such as a team that paid still read-only, or one whose subscription ended still active. Primary region only | any, over an hour | P2 |
| **Reopened team's subscription ended** | `ReopenedTeamSubscriptionsEnded`: an owner reopened a closed team while the billing worker or the closed-team purge was asking Stripe to end its subscription, and it couldn't be resumed at once: it was cancelled (not just set to cancel), or Stripe refused the resume, so an open team's subscription is set to cancel (or was cancelled). Also counted when the worker or the purge set a closed team's subscription to end and then couldn't read (or record) the team again, so couldn't tell whether it had been reopened meanwhile (`supply-checkout-8jc.30`). Every region (the worker runs in each) | any, over 15 minutes | P2 |
| **Reopened team's subscription left to cancel** | `ReopenedTeamSubscriptionsUndecided`: the billing worker resynced a reopened team whose subscription is set to cancel, possibly by the closure (from before the closure stamp existed) or possibly by an owner, with no Stripe `canceled_at` (or no reopen time) to tell by, and left it set to cancel. Every region | any, over an hour | P2 |
| **Reopened team's billing not resynced** | `ReopenResyncsLate`: the nightly seat reconciliation found a reopened team whose Stripe subscription still hadn't been resynced (`stripeResyncFor` on its `META` item), because the reopen's seat sync wasn't queued or failed. The worker resyncs it with that message. Primary region only | any, over an hour | P2 |
| **Closed team charged** | `ClosedTeamRenewalsCharged`: the hourly closed-team purge found a closed team's subscription charged for a period that began after the team closed (a renewal or trial conversion before it was set to end: the billing worker does that within seconds of the closure, so this means its `closed` message wasn't queued or Stripe failed it, and the purge's hourly run set it to end instead). Primary region only | any, over an hour | P2 |
| **Closed-team subscription not found in Stripe** | `ClosedTeamSubscriptionsNotFound`: the hourly closed-team purge asked Stripe for a closed team's subscription, was told it doesn't exist, and set the team aside (reason `NotFound`) rather than record it as done. A Stripe key or mode mismatch looks the same for every closed team, with none cancelled. Primary region only | any, over an hour | P2 |
| **Closed-team subscription set aside** | `ClosedTeamsSetAside`, a gauge the hourly closed-team purge sends every run: the closed teams set aside for a person for their current closure (`stripeSetAsideFor` equal to `closedAt`), which it no longer retries so they can't crowd newer closures out of its listing. `stripeSetAsideReason` says why: `CustomerMismatch` (the recorded subscription belongs to another Stripe customer, left untouched), `NotFound` (Stripe doesn't have it) or `PermanentError` (Stripe refused to end it with an error retrying won't change). It stays on until each team is dealt with (`stripeSetAsideFor` removed): a team set aside isn't purged until 14 days past its deletion date (`HELD_PURGE_GRACE_DAYS`), and Deletion overdue fires for it too from a day past (`supply-checkout-8jc.37`); then it's purged anyway, with its subscription unresolved (`supply-checkout-8jc.40`). Primary region only | above 0 (maximum over 2 hours, so every period holds a run) | P2 |
| **Many closed-team subscriptions set aside** | The same `ClosedTeamsSetAside` gauge, at 5 or more (`SET_ASIDE_INCIDENT_AT` in `infra/lib/observability/journey-alarms.ts`): that many at once is most likely a Stripe key or mode mismatch, or set-asides left uncleared; under a mismatch no closed team's subscription ends and none of those teams is purged until 14 days past its deletion date (`supply-checkout-8jc.37`, `supply-checkout-8jc.40`). Primary region only | 5 or more (maximum over 2 hours) | P1 |
| **Stripe customer already deleted** | `StripeCustomersAlreadyDeleted`: the hourly closed-team purge asked Stripe to delete a purged team's customer, was told it doesn't exist, took it as deleted and purged the team. A run that stopped after deleting the customer does that, but so does a Stripe key or mode mismatch, under which the real customer keeps its details and any subscription keeps billing (`supply-checkout-8jc.37`). Primary region only | any, over an hour | P2 |
| **Held team purged with its subscription unresolved** | `HeldTeamsPurged`: the hourly closed-team purge deleted a closed team held because its subscription was set aside (`CustomerMismatch`, `NotFound` or `PermanentError`), 14 days after its deletion date (`HELD_PURGE_GRACE_DAYS` in `backend/src/ops/names.ts`), nobody having dealt with it: the owner's decision, so its data isn't kept indefinitely past the date its owners were told. Its subscription may still be live and billing (`supply-checkout-8jc.40`). Primary region only | any, over an hour | P2 |
| **Stripe customer deletion retrying** | `StripeCustomerDeletionOldestHours`, a gauge the hourly closed-team purge sends every run that can read its queue: how long the oldest queued Stripe customer deletion has waited. The purge deletes a closed team's data on schedule even when Stripe can't delete its customer (an outage, a timeout, a rate limit, a key it can't read), queues the customer's deletion and retries it every run (`supply-checkout-8jc.42`). Primary region only | above 24 hours (`STRIPE_DELETION_RETRY_ALARM_HOURS`), maximum over 2 hours | P2 |
| **Stripe customer deletion stuck** | The same gauge: a queued deletion a week old (`STRIPE_DELETION_STUCK_DAYS`) isn't an outage. The customer's details stay in Stripe and any subscription on it may still bill. Primary region only | above 168 hours, maximum over 2 hours | P1 |

**Lapsed-team job failing, not running or out of time: what to do.** See [the lapsed-teams runbook](runbooks/lapsed-teams.md). A lapsed team that isn't closed stays read-only, with its owners told it would be deleted, so it's kept past that date until this is resolved; nothing is deleted early.

**Seat counts drifting: what to do.** The billing worker has already set the quantity right, so the customer is billed correctly from now on; the question is why the sync after the membership change missed it. Find `Seat quantity drift` in the billing worker's log (team and subscription IDs, the Stripe quantity and the billed members), then look for the team's missed sync: `Seat sync not queued` in the account or ops function's log (`SeatSyncQueueFailures`), a message in the seat syncs dead-letter queue (Seat syncs stuck), or a membership change made outside the account and ops APIs (a restore, until the reconciliation is run by hand as its runbook says). `Seat sync skipped: more billed members than a team can have` in the worker's log means the count is over `MEMBERS_PER_TEAM` and the quantity wasn't changed: find how the team got past the member cap before setting its seats by hand. If the drift overbilled the team, credit the difference in the Stripe Dashboard. A mismatch found moments after a membership change, whose own sync was still queued behind the reconciliation's, fixes itself and can be ignored.

**Entitlements drifting: what to do.** A Stripe event was lost or is stuck, and the billing worker has already applied Stripe's state, so the team has the access it paid for from now on. Find `Entitlement drift` in the billing worker's log (the team and subscription IDs, the fields that differed, and our values and Stripe's), then follow [the billing DLQ replay runbook](runbooks/billing-dlq-replay.md): look for the team's events in the billing events dead-letter queue (Billing events stuck) and in the Stripe Dashboard's failed deliveries, and replay them, which also sends any owner email the lost event should have sent (the check sends none). `Entitlement drift: subscription missing in Stripe` (or `customer missing`) means the team records a subscription (or customer) Stripe doesn't have: nothing was changed. Check the customer for a live subscription and, if there is one, attach it by replaying one of its events (the runbook says how). A drift found for a team whose event was in flight at 07:00 UTC fixes itself and can be ignored.

**Reopened team's subscription ended: what to do.** Find `Team reopened while its subscription was being ended` in the billing worker's or the closed-team purge's log: it has the team and subscription IDs and the action (`cancel_at_period_end` or `cancel_now`). A set-to-cancel that was resumed at once (`...: resumed`, a warning) needs nothing; this alarm is for one that wasn't (`Reopened team's subscription not resumed` says why, when Stripe refused). First check whether the team's recorded subscription (`stripeSubscriptionId`) is a different one that's still live: if so, the logged subscription was a second one, and the worker's retry cancels it at once as a duplicate, so leave it ended. Otherwise, for `cancel_at_period_end`, turn off the pending cancellation on the subscription in the Stripe Dashboard (or ask an owner to renew it in the billing portal) before the period ends. For `cancel_now`, the subscription has ended (it was unpaid, paused or incomplete) and the team is read-only: an owner subscribes again from the app. If the team is closed again by the time you look (the worker also alarms for a team reopened and closed again), do nothing: the new closure wants the subscription ended, and the purge would end it again anyway. The worker's event is retried and then applies as usual to the open team, so nothing else needs replaying. The worker's `closed` message (sent as a team closes, `supply-checkout-8jc.30`) logs `messageId` instead of `eventId`, and isn't retried.

If the log line is `Closed team's subscription set to end, but the team wasn't read again` instead (the worker's re-read, or the purge's recording, failed right after Stripe took the change; `error` names the DynamoDB error), the team may or may not have been reopened in that moment. Look at the team's `META` item: if it's still closed with the same `closedAt` as the subscription's `supply_checkout_closed_at` metadata, nothing needs doing (the closure wants it ended, and the purge records it). If it's open, it was reopened in that window, and the reopen's resync may have left the cancellation, taking it for the owner's: for `cancel_at_period_end`, turn the pending cancellation off in the Stripe Dashboard (or ask an owner to renew it in the billing portal) before the period ends, unless the subscription's events show an owner cancelled it in the Customer Portal after the reopen.

**Reopened team's billing not resynced: what to do.** Find `Reopened team's subscription not yet resynced` in the billing worker's log (the team ID, the closure it was reopened from and its subscription ID). The same message then resynced it, unless the worker logged why not: `Reopened team's subscription not resynced: not found in Stripe` or `...: another customer's subscription` (look the subscription up in the Stripe Dashboard, as for Entitlement drift: subscription missing), or a Stripe or DynamoDB error, after which the message goes to the seat syncs dead-letter queue (Seat syncs stuck) and the next night tries again. Then find why the reopen's own sync didn't do it: `Seat sync not queued` in the account or ops function's log, or the seat syncs dead-letter queue. If the subscription was set to cancel by the closure and is still waiting, the owner can renew it from Billing meanwhile. Once a person has dealt with a team that can't be resynced, remove `stripeResyncFor` from its `META` item (an `UpdateItem` with `REMOVE stripeResyncFor`, as an administrator), or the alarm fires every night.

**Reopened team's subscription left to cancel: what to do.** Find `Reopened team's subscription left set to cancel` in the billing worker's log (the team and subscription IDs and the closure). Don't resume it by default: contact the team's owners first. Open the subscription in the Stripe Dashboard and look at its events to tell them what happened: whether the cancellation was requested while the team was closed (between `closedAt` and the reopen, by the API key, not the Customer Portal), so the closure's, or by an owner (in the Portal, or before the closure). Then ask the owners whether they want it to carry on, telling them that resuming a `trialing` subscription converts it to paid at its trial end, and a `past_due` one has Stripe retry its card: both charge them. Turn the pending cancellation off only when an owner says to (or they can renew it themselves from Billing). Without an answer, leave it set to cancel. Nothing else needs doing: the resync has finished.

**Closed team charged: what to do.** Find `Closed team's subscription renewed after it closed` in the closed-team purge's log: it has the team and subscription IDs and when the team closed. Before refunding:
1. Check that the team is still closed. If it was reopened, the owner is keeping the subscription: don't refund. See "Reopened team's subscription ended" in case its subscription was set to end as it reopened.
2. Refund only an invoice for the period that began after that time that was paid and isn't zero. A $0 invoice, or a period a comp covered, also sets this off, and there's nothing to refund.
3. Refund once per subscription and period. If the purge couldn't record the team after the warning, its next hourly run counts the same renewal again, so check the invoice hasn't already been refunded.

The purge has already set the subscription to cancel, so no new period will be charged.

A `past_due` subscription is the exception to "nothing more is charged": setting it to cancel at the period's end (at close, or by the purge) doesn't void its open invoice, so Stripe keeps retrying the card for the period that began **before** the closure, and a retry can succeed after the team closed. That's existing behavior, not a renewal after closing, and it doesn't set this alarm off (the period didn't start after the closure). If an owner asks, it's a payment for time the team had before it closed; refund it by hand only if the owners and support agree to.

**Closed-team subscription not found in Stripe: what to do.** Find `Closed team's subscription not found in Stripe` in the closed-team purge's log (the log group of `supply-checkout-<env>-team-purge`): it has the team and subscription IDs. Look the subscription up in the Stripe Dashboard, in the mode the purge runs in (`STRIPE_MODE` in its environment). The team was set aside (reason `NotFound`), not recorded as done, so "Closed-team subscription set aside" fires too, and stays on until each such team is dealt with:
1. If Stripe has it in the other mode, or many teams were logged at once, the purge is reading the wrong Stripe secret key: fix the key in Secrets Manager or the deploy's Stripe mode. Then remove `stripeSetAsideFor` from each logged team's `META` item (below): the next hourly run lists them again and ends their subscriptions itself.
2. If Stripe has it in the right mode (live and charging), something else is wrong with the purge's Stripe access: find out what before removing `stripeSetAsideFor` the same way.
3. If Stripe really doesn't have it in either mode, check the team's own customer (`stripeCustomerId` on its `META` item) in the Stripe Dashboard first: if the customer has any live subscription (the team may have recorded the wrong one), end it by hand (cancel at the period's end). Only then record the team as done, so the alarm clears, with `SET stripeCancelledFor = closedAt REMOVE stripeSetAsideFor` (below). The team is purged at the next run if it's past its deletion date; if its customer is gone from Stripe too, that run also sets off "Stripe customer already deleted" for it, which you can then acknowledge.

To remove the attribute, on the condition the team is still that closure (the table is `supply-checkout-<env>-app`, in the primary region). Run it as an administrator only (the `supply-prod` SSO administrator role): the condition reads `closedAt`, which the purge's role may not name in an update on purpose (it can't close or reopen a team), and its role isn't to be widened for this:

```bash
aws dynamodb update-item --table-name 'supply-checkout-<env>-app' \
  --key '{"PK":{"S":"TEAM#<teamId>"},"SK":{"S":"META"}}' \
  --update-expression "REMOVE stripeSetAsideFor" \
  --condition-expression "stripeSetAsideFor = closedAt"
```

**Closed-team subscription set aside: what to do.** The alarm reads a gauge the purge sends every hour, so it stays on while any closed team is set aside, however long ago (`supply-checkout-8jc.36`). Every run logs `Closed team's subscription still set aside` (a warning) with each team's ID and reason, up to 25 a run (`MAX_LOGGED_SET_ASIDE`), and `Closed teams' subscriptions set aside` with how many there are in all. When it was set aside, the purge also logged the team's subscription ID: `Closed team's subscription set aside` (with the Stripe error's type, code, status and request ID for `PermanentError`), or `Closed team's subscription not found in Stripe`. By reason:
- `CustomerMismatch`: the team's recorded subscription belongs to another customer, and the purge didn't touch it. In the Stripe Dashboard, find the team's own customer (`stripeCustomerId` on the team's `META` item) and end any live subscription it has (cancel at the period's end); leave the other customer's subscription alone unless it's clearly this team's. No path in the app can record another customer's subscription ([infrastructure.md](infrastructure.md#billing), "Which customer a team's subscription belongs to"), so this means a hand edit of the team's `META` item or corrupted data: check the table's recent hand edits, compare the item with a backup ([backups.md](backups.md)), and file a bug with what you find.
- `NotFound`: see "Closed-team subscription not found in Stripe" above.
- `PermanentError`: Stripe refused to end the subscription with an invalid-request error about the subscription itself, in a run where Stripe took the same request (`request` in the log: `retrieve`, `cancel_at_period_end` or `cancel_now`) for another team, so the key and that request are fine. Look the subscription up in the Stripe Dashboard (the request ID shows the request and Stripe's message), end it by hand if it's still live, and file a bug if our request was wrong for it.
- `Unknown` (no reason recorded): a team set aside before reasons were; treat it as `CustomerMismatch`.

Once a team is dealt with, clear it so the alarm can recover: remove `stripeSetAsideFor` (the command above) to have the next run try it again, or, when its subscription is already ended by hand, record it as done with `--update-expression "SET stripeCancelledFor = closedAt REMOVE stripeSetAsideFor"` and the same condition. Either way the next run's gauge drops. Both are administrator-only, like the command above. `stripeSetAsideReason` can stay: it only counts with `stripeSetAsideFor`. Left alone, a team stays set aside, and the alarm on, until 14 days past its deletion date (`HELD_PURGE_GRACE_DAYS`): until then the purge doesn't delete a team set aside for its current closure, whatever the reason (`supply-checkout-8jc.37`). Deleting it would delete its customer, which ends any subscription on that customer, but under a Stripe key or mode mismatch that delete also gets "not found", so nothing in Stripe would end and the team's Stripe IDs would be gone from the table; and another customer's subscription (`CustomerMismatch`) is never touched. So the privacy deadline waits on you: a held team more than 24 hours past its deletion date is counted in Deletion overdue like any other (its data is kept past the date its owners were told), each run logs `Closed teams held past their deletion date` with how many, and the purge logs `Closed team not purged: its subscription is set aside` for one set aside after it was listed. At 14 days past its deletion date the purge deletes it anyway, with its subscription unresolved, and "Held team purged with its subscription unresolved" fires (`supply-checkout-8jc.40`): the subscription then has to be ended by hand from the team's deletion record. Deal with each team before its deletion date (`purgeAfter` on its `META` item).

**Many closed-team subscriptions set aside: what to do.** P1: five or more closed teams set aside at once. Treat it as a Stripe key or mode mismatch until shown otherwise: in the purge's log, count the reasons in `Closed team's subscription still set aside`. Many `NotFound` (or a burst of `Closed team's subscription not found in Stripe` in one run) means the purge's Stripe key is for the wrong account or mode: check `STRIPE_SECRET_ID` and `STRIPE_MODE` in its environment and the secret's value, and look a few of the logged subscriptions up in the Stripe Dashboard in both modes. Fix the key or the deploy's mode, then clear each team as "Closed-team subscription not found in Stripe" says (remove `stripeSetAsideFor`), so the next run ends their subscriptions. Many `CustomerMismatch` or `PermanentError` means a bug in how teams record subscriptions or in the purge's request: file it, and handle each team as above. None of these teams is purged until 14 days past its deletion date, so nothing is lost by taking a little time to find the cause, but their deletion dates still pass, and a team still set aside 14 days after its date is purged with its subscription unresolved ("Held team purged with its subscription unresolved"): fix the key before then.

**Stripe customer already deleted: what to do.** Find `Stripe customer already deleted` in the closed-team purge's log: it has the team and customer IDs. The team is already deleted from the table; its deletion record (`teams/<teamId>.json` in the deletion records bucket, [backups.md](backups.md)) keeps its `stripeCustomerId` and `stripeSubscriptionId`. Look the customer up in the Stripe Dashboard, in both modes:
1. If Stripe has it (in either mode), the purge's Stripe key is wrong (see "Many closed-team subscriptions set aside"): delete the customer by hand in the Stripe Dashboard, which ends any subscription on it, and check every other team purged since the key changed.
2. If an earlier run logged `Stripe customer deleted` with `result: deleted` for the same team (a run that stopped after deleting it), or a person deleted the customer by hand, there's nothing to do. The same goes for one logged with `source: "retry"` whose deletion was queued after a timeout (`Stripe customer deletion queued` with a connection or timeout error, `supply-checkout-8jc.42`): that first try may have reached Stripe.
3. If neither, find out who deleted the customer (Stripe's logs for it) before acknowledging.

**Held team purged with its subscription unresolved: what to do.** P2 (`supply-checkout-8jc.40`). A closed team set aside for a person (its subscription another customer's, not found in Stripe, or refused with an error retrying won't change) was still set aside 14 days after its deletion date (`HELD_PURGE_GRACE_DAYS`), so the purge deleted it anyway: its data is gone from the table, and its subscription may still be live and billing. Find `Held team purged with its subscription unresolved` in the closed-team purge's log (an error): it has the `teamId`, `customerId`, `subscriptionId` and the set-aside `reason`. The team's deletion record (`teams/<teamId>.json` in the deletion records bucket, [backups.md](backups.md)) keeps the same `stripeCustomerId` and `stripeSubscriptionId`, if the log has aged out. Then end the subscription by hand in the Stripe Dashboard:
1. Look the subscription up by its ID, in both modes. If it's live (`trialing`, `active`, `past_due`), cancel it; nothing more should be charged for a team that's gone. If it was charged after the team's deletion date, refund that invoice.
2. Look the team's customer up too: the purge tried to delete it, and `Stripe customer deleted` (with `result`) for the same team says how that went. If the customer is still there (in either mode), delete it, which ends any other subscription on it. `Stripe customer already deleted` for the same team, with the customer still in Stripe in the other mode, means the purge's Stripe key is wrong: see "Many closed-team subscriptions set aside".
3. For `CustomerMismatch`, the recorded subscription belongs to another customer: end it only if it's clearly this team's (the same as "Closed-team subscription set aside"), and file a bug about how the team recorded it.

The alarm recovers by itself after an hour: each team is counted once, when it's purged. Nothing in the table is left to clear.

**Stripe customer deletion retrying: what to do.** P2 (`supply-checkout-8jc.42`). A closed team's data was deleted on schedule, but Stripe couldn't delete its customer then, and the hourly retries haven't managed it for a day. Nothing is lost: the queue entry (partition `PURGE#STRIPE_DELETIONS` in the table, sort key the team ID, with `stripeCustomerId` and `queuedAt`) stays until Stripe deletes the customer, and the team's deletion record (`teams/<teamId>.json`, [backups.md](backups.md)) keeps the Stripe customer and subscription IDs for 400 days. In the closed-team purge's log, `Stripe customer deletion queued` (when it was queued) and `Queued Stripe customer deletion failed` (each retry) have the team and customer IDs and Stripe's error type, status and request ID; `error: "NotTried"` means the run had already seen 3 failures in a row and stopped asking Stripe (`STRIPE_FAILURES_BEFORE_QUEUEING`).
1. Check [Stripe's status page](https://status.stripe.com). During an outage there's nothing to do: the retries carry on every hour, and the alarm clears once the queue's oldest entry is gone.
2. Otherwise read the error: an authentication or permission error means the purge's Stripe key (Secrets Manager, `supply-checkout/<env>/stripe/<mode>-secret-key`) is wrong, revoked or unreadable, which also fails the purge's subscription ending (Deletion job failing); fix the key. A `resource_missing` never gets here: the retry takes a customer Stripe says is gone as deleted (and counts it for "Stripe customer already deleted").
3. Any subscription on the customer keeps billing until the customer is deleted: if the wait is long, look the customer up and cancel its subscription by hand, and refund anything charged after the team's deletion date.

A queue entry whose team is still in the table and not being purged is never sent to Stripe: the run logs `Queued Stripe customer deletion refused: the team isn't purged` (an error) and fails. Nothing the app does writes one, so find out what did before removing it (the command below). Entries whose customer ID isn't `cus_` and letters and digits are refused the same way (`Queued Stripe customer deletions not readable`).

**After the first deploy of the queue (post-deploy check).** The purge's role has only `kms:Decrypt` and `kms:DescribeKey` on the table key: DynamoDB encrypts writes with its cached table key, so its `PutItem` of a queue entry should need nothing more, as its `UpdateItem` marks don't. Confirm it once in prod: after the first `Stripe customer deletion queued` in the purge's log (or a forced queue write, by an administrator, with Stripe's key briefly unreadable to the purge in a quiet hour), look in CloudTrail for a KMS `AccessDenied` (event source `kms.amazonaws.com`, the purge's role as the user identity) around that time, and for `Team purge failed` with `AccessDeniedException` in the purge's log. If either appears, add `kms:Encrypt` and `kms:GenerateDataKey` to the purge's `TableKeyThroughDynamoDb` statement (`infra/lib/observability/ops-checks.ts`) with the same `kms:ViaService` condition, and deploy. Until then a queue write that fails leaves the team for the next run (Deletion overdue after a day), so no data is lost.

**Stripe customer deletion stuck: what to do.** P1: a queued Stripe customer deletion has failed every hour for a week, so it isn't an outage. Work through "Stripe customer deletion retrying" first. If Stripe refuses that one customer, delete it by hand in the Stripe Dashboard (which ends any subscription on it), then remove its queue entry so the alarm can recover. Run it as an administrator only (the `supply-prod` SSO administrator role), in the primary region:

```bash
aws dynamodb delete-item --table-name 'supply-checkout-<env>-app' --key '{"PK":{"S":"PURGE#STRIPE_DELETIONS"},"SK":{"S":"<teamId>"}}' --profile supply-prod
```

Leaving the entry would be harmless once the customer is gone (the next run finds it already deleted and clears it, counted for "Stripe customer already deleted"), but delete it to keep that alarm quiet.

The purge lists at most 100 closed teams' subscriptions a run (`CLOSED_TEAMS_TO_END_PER_RUN`), soonest due first, and teams set aside aren't listed. `Closed teams' subscriptions listed at the limit` in its log (a warning) means more may be waiting: a burst of closures the hourly runs work through, or a run of failures (`Closed team's subscription not ended`) that keep teams listed. A team Stripe refuses with an error retrying won't change is set aside only in a run where Stripe took the same request (the fetch, the update that sets it to cancel at the period's end, or the cancel) for another team; while none does (a bad key, the wrong mode or a bug in that request refuses them all), they stay listed and fail every run. `Closed team's subscription not set aside: the team was reopened meanwhile` (info) means a team was reopened, or closed again, between the purge's read and its record: nothing was set aside, and nothing needs doing.

**Seat syncs stuck: what to do.** The billing worker's log has `Billing event failed` with the error's name for each try. Once the cause is fixed (usually Stripe unreachable, or a subscription Stripe won't update), redrive the dead-letter queue to `supply-checkout-<env>-seat-syncs.fifo` (the SQS console's DLQ redrive). Replaying is safe: each sync recomputes the quantity from the members as they are then. Deleting the messages instead is also safe: the nightly reconciliation fixes those teams' seats, and counts them as drift.

**Seat reconciliation not running: what to do.** Check the `supply-checkout-<env>-seat-reconcile` EventBridge rule is there and enabled (a deploy restores it), and that the function has an invocation each night. If it runs but fails, its log group has the error: an `AccessDeniedException` on the query means its IAM policy no longer matches `SEAT_RECONCILE_ATTRIBUTES`, and one on sending means it can't reach the seat sync queue. Invoke it by hand to recover the alarm.

### J8. A payment fails and is fixed

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Mass lockout** | Teams switched to read-only in the last hour | more than 3, or more than 5% of active teams. Protects against a billing bug locking out paying customers. | P1 |
| **Billing events stuck** | See J7 | | P1 |
| **Billing portal broken** | See J7 | | P1 |
| **Billing events late** | See J7 | | P2 |
| **Entitlements drifting** | See J7 | | P2 |
| **Lapsed-team job failing** | See J7 | | P2 |
| **Lapsed-team job not running** | See J7 | | P2 |
| **Lapsed-team job out of time** | See J7 | | P2 |
| **Failed payments rising** | `invoice.payment_failed` events | more than 2× the 30-day average in a day | P3 |

### J9, J10, J11: roles, cancellation and deletion

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Cross-team access attempts** | Authorizer denials where the signed-in user asked for a team they don't belong to | any, over 15 minutes. Could be a client bug or someone probing. | P2 |
| **Lapsed-team job failing** | See J7 | | P2 |
| **Lapsed-team job not running** | See J7 | | P2 |
| **Lapsed-team job out of time** | See J7 | | P2 |
| **Lapsed-team closures held** | `LapseClosuresHeld`: lapsed teams due to close that a run held because it had already closed 10 (`LAPSE_MAX_CLOSURES_PER_RUN`), so a bug or bad data can't delete teams en masse. Primary region only | any, over 2 hours | P2 |
| **Lapsed-team closures high** | `LapsedTeamsClosed`: lapsed teams closed for deletion, even under the per-run cap. Primary region only | more than 20 in 6 hours (`LAPSE_CLOSURES_ALARM_COUNT`, `LAPSE_CLOSURES_ALARM_HOURS`) | P2 |
| **Export failing** | Export runs in the browser from the data API's list routes, so there's no export function: the API errors alarm covers it | as API errors | P2 |
| **Deletion job failing** | The hourly closed-team purge (`supply-checkout-<env>-team-purge`) throws when any team fails, any closed team's Stripe subscription couldn't be ended, or its queue of Stripe customer deletions couldn't be read or cleared (`Queued Stripe customer deletions not listed`, `not readable` or `not cleared`, `supply-checkout-8jc.42`), which the Functions failing alarm counts. A Stripe customer Stripe can't delete doesn't fail it: the team is purged and the deletion queued | as Functions failing | P2. The privacy policy promises a deadline, and a closed team shouldn't be charged again. In Logs Insights, `message = "Closed team's subscription not ended"` names the team and the error; `"Team reopened while its subscription was being ended"` needs the subscription resumed in Stripe by hand; `"Closed team's subscription renewed after it closed"` (a warning, not a failure) needs a refund. |
| **Deletion overdue** | `ClosedTeamsOverdue`: closed teams still there more than 24 hours (`PURGE_OVERDUE_AFTER_HOURS`) after their deletion date, counted on the closed-teams index however many there are (not capped at the 100 a run lists), including index entries the app didn't write and teams held because they're set aside (`supply-checkout-8jc.37`), until the purge deletes a held team anyway 14 days past its deletion date (`supply-checkout-8jc.40`). The purge (`backend/src/ops/team-purge-handler.ts`, primary region) sends it every run that can read the index, zero included, even a run where teams fail | above 0 (maximum over 2 hours, so every period holds a run) | P2 |
| **Deletion job not running** | `ClosedTeamsOverdue` samples: none means the purge didn't run (its schedule is disabled or deleted) or every run failed before it could read the index. Missing data breaches. Primary region only (`infra/lib/observability/ops-checks.ts`) | fewer than 1 sample in 3 hours (`PURGE_SILENT_ALARM_HOURS`) | P2 |
| **Team closure emails failing** | `TeamClosedNoticeFailures`: owners of a team that just closed who weren't emailed the day it will be deleted (SES refused, no address on file, or the owners couldn't be listed). The team closes anyway | any, over 15 minutes | P2 |
| **Team reopened emails failing** | `TeamReopenedNoticeFailures`: owners of a team that was just reopened who weren't told it will no longer be deleted (SES refused, no address on file, or the owners couldn't be listed). The team reopens anyway | any, over 15 minutes | P2 |
| **Reopened team's subscription ended** | See J7 | | P2 |
| **Reopened team's billing not resynced** | See J7 | | P2 |
| **Reopened team's subscription left to cancel** | See J7 | | P2 |
| **Closed team charged** | See J7 | | P2 |
| **Closed-team subscription not found in Stripe** | See J7 | | P2 |
| **Closed-team subscription set aside** | See J7 | | P2 |
| **Many closed-team subscriptions set aside** | See J7 | | P1 |
| **Stripe customer already deleted** | See J7 | | P2 |
| **Held team purged with its subscription unresolved** | See J7 | | P2 |
| **Stripe customer deletion retrying** | See J7 | | P2 |
| **Stripe customer deletion stuck** | See J7 | | P1 |

**Deletion overdue: what to do.** First check for teams held because they're set aside: `Closed teams held past their deletion date` in the purge's log, with "Closed-team subscription set aside" on too. The purge doesn't delete those until 14 days past their deletion date (`HELD_PURGE_GRACE_DAYS`), so for each one (`Closed team's subscription still set aside` names it and its reason), follow "Closed-team subscription set aside: what to do" in J7: end its subscription by hand, then record it as done (`SET stripeCancelledFor = closedAt REMOVE stripeSetAsideFor`), and the next hourly run purges it. Left alone, Deletion overdue stays on until the purge deletes it anyway, 14 days past its deletion date; then "Held team purged with its subscription unresolved" fires, and its subscription is ended by hand from the team's deletion record (`stripeCustomerId` and `stripeSubscriptionId`), as that runbook says (`supply-checkout-8jc.40`). Otherwise, in Logs Insights on the log group of `supply-checkout-<env>-team-purge`, `filter message = "Team purge failed"` gives each failing team's `teamId` and the error's name; `message = "Purged closed teams"` shows each run's `due`, `purged`, `failed` and `overdue`. A Stripe error name (`StripeConnectionError`, with the Stripe error's `type`, `code`, `status` and `requestId`) means the team's Stripe customer couldn't be deleted, and the team waits for it: check Stripe's status and that the purge can read the Stripe secret key. An `AccessDeniedException` means the purge's IAM policy no longer matches what it deletes (`TEAM_PURGE_ATTRIBUTES`); throttling or a timeout clears as later runs carry on. If a run stops at its time budget every hour, a team is bigger than one run can delete: the next runs carry on from where it stopped, so watch that `overdue` falls. Fix the cause and the next hourly run deletes the team; the alarm recovers when the gauge reads 0. If the gauge stays above 0 and no team fails, look in GSI1's `TEAMS#CLOSED` partition for entries that aren't a team's META item: the purge doesn't list them but the gauge counts them, and a person should remove them.

**Deletion job not running: what to do.** Check the `supply-checkout-<env>-team-purge` EventBridge rule is there and enabled (a deploy restores it), and that the function has recent invocations. If it runs but fails, its log group has the error: an `AccessDeniedException` on the count query or the listing means its IAM policy no longer matches (`TEAM_PURGE_ATTRIBUTES`). The alarm recovers with the first run that sends the gauge.

**Team closure emails failing: what to do.** The account function logs `Team closure emails not sent` with the team ID, counts and SES's error names (never addresses). For `MessageRejected` or a suppressed address, check SES's account dashboard and the suppression list; for `NoAddress`, the owner has no email on file. The team is closed either way; if an owner may not know, look them up from the team ID and tell them the deletion date.

**Team reopened emails failing: what to do.** The same, for the log message `Team reopened emails not sent`. The team is open either way; if an owner may still expect it to be deleted, tell them it was reopened.

### J12. Choose a plan in the mobile app

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **App checkouts abandoned** | Stripe Checkout sessions started from the apps against completed ones | completion below half the web rate over 7 days | P3 |

### J13. Take company equipment to a job and bring it back

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Checkouts stopped** | `Checkouts` business metric across all teams: equipment is checked out with the same command as supplies, so it counts | as for J4 | P1 |

### J14. Take supplies without a job

| Alarm | Signal | Starting threshold | Severity |
| --- | --- | --- | --- |
| **Checkouts stopped** | `Checkouts` business metric across all teams: the quick take counts as a checkout | as for J4 | P1 |

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

`Checkouts`, `Returns`, `LiveUpdates` and `LiveUpdateFailures` (the stream consumer's publishes, for "Live updates failing"), `ReceiptReads` (every model call), `ReceiptReadFailures` (any model call that failed, a photo Bedrock refused included), `ReceiptReadLatency` (a gauge, each model call in milliseconds, on the dashboard at p95), `ReceiptRateLimited` and `ReceiptLimitReached` (receipt reads refused by the per-user rate limit or the team's allowance), `ReceiptTrialsNearLimit` (trial teams reaching 80% of their trial's receipts, for "Receipt trials near their limit") and `ReceiptPaidTeamsNearLimit` (paying teams reaching 80% of their month's, dashboard only), `ReceiptLines` (units a receipt adds to existing projects, apart from `Checkouts` since they never were in storage), `SignUps`, `InvitesSent`, `InvitesAccepted`, `CheckoutSessionErrors`, `BillingPortalErrors`, `InvoiceListErrors` (the invoice list failing, dashboard only), `WebhookSignatureFailures`, `ConditionalWriteConflicts`, `Writes` (the denominator for "Writes rejected"), `LegacySheetsRouteCalls` (calls to the old `/teams/{teamId}/sheets...` routes during the projects rename, `supply-checkout-005.6`, dashboard only: flat zero for a day means the old routes can go), `ReceiptTokens` (receipt token usage, with the team ID as metadata rather than a dimension), `SignOutRevokeFailures`, `EmailVerifyFailures`, `EmailUnverifyFailures`, `EmailCodeSendFailures` and `EmailCodeVerifyFailures` (for "Email codes failing"), `LiveUpdatesDeferred` (for "Live updates deferred"), `TeamClosedNoticeFailures` (for "Team closure emails failing"), `TeamReopenedNoticeFailures` (for "Team reopened emails failing"), `WelcomeEmails`, `WelcomeEmailFailures` and `WelcomeEmailsRefused` (a new account's welcome email sent once, by sign-up method; ones not handed over or not sent, for "Welcome emails failing"; and ones SES refused, for "Welcome emails refused"), `SecurityNotices` and `SecurityNoticeFailures` (security notices to an account's own verified address when a password is set or two-step sign-in is turned on, whether through the API or directly against Cognito, and to its previous address when its email changes, and ones not sent; those from CloudTrail carry `via: cloudtrail`; for "Security notices failing"), `OperatorAuditChanged` (the operator audit watch, primary region only, for "Operator audit changed", [Operators](infrastructure.md#operators)), `OperatorAuditWatchHeartbeat` (the watch's heartbeats, for "Operator audit watch silent"), `OperatorGroupChanged`, `OperatorGroupBaselineReset` and `OperatorGroupMembers` (the operator group watch, primary region only, for "Operator group changed" and "Operator group watch silent"), `DeletionRecordRewrites` (the deletion records watch, primary region only, for "Deletion record rewritten", [backups.md](backups.md#when-a-deletion-record-is-rewritten)), for seats (`supply-checkout-l50`) `SeatQuantityUpdates`, `SeatQuantityDrift` (for "Seat counts drifting") and `SeatSyncQueueFailures`, and `EntitlementDrift` (the nightly entitlement check, `supply-checkout-8jc.9`, for "Entitlements drifting"). Five are gauges, levels a scheduled function measures and sends with `gauge()`, read at their maximum: `StuckImports`, `EmailQuotaUsedPercent`, `ClosedTeamsOverdue` (for "Deletion overdue"), `ClosedTeamsSetAside` (for "Closed-team subscription set aside") and `SeatReconcileTeams` (for "Seat reconciliation not running"). Each has a `Region` dimension, even while there is only us-east-1, so they split cleanly when us-west-2 is added.

The names are in `backend/src/observability/names.ts`, which both the Lambda code and the dashboard and alarms import. Send them with `count()` from `backend/src/observability`, in namespace `SupplyCheckout`. The dashboard already has a graph for each; until the handlers exist, the graphs are empty and the alarms stay OK.
