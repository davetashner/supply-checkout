# Plan: journey tests against prod

This is the plan for `supply-checkout-o60`: automated end-to-end tests of every [customer journey](journeys.md) against a deployed environment. It's a plan only. The beads at the end build it, and the owner decisions at the end need answers before the first of them starts.

## What changed since the bead was written

The bead asks for tests against "a preview or staging stack, with real Cognito test users, Stripe test mode and test clocks, a stub Bedrock mode … and one real-model smoke test", which "block promotion". At the ADR review (PR #214, [ADR 0012](adr/0012-cicd-releases-rollbacks.md)) the owner decided there is **no staging** for the MVP: one account, and the journey tests run **against prod, with dedicated test teams, after each release**. That changes four things:

- **There's nothing to promote.** By the time the suite runs, the release is already live for the pilot (House Finch) and everyone else. "Blocks promotion" becomes "marks the release bad and tells us", and, for a critical journey, starts the rollback path ([When the suite fails](#when-the-suite-fails)).
- **Every test is real traffic in the real account.** Test users, teams and emails share Cognito, the table, SES, Stripe and the alarms with customers. They must be fenced off from metrics, billing, the pilot's data and the core canary, and must leave nothing behind.
- **Stripe test mode exists only until go-live.** Prod runs on the Stripe sandbox today (`stripeMode` is `test`, [Billing](infrastructure.md#billing)); once `supply-checkout-dri` switches it to live, prod has no test mode and no test clocks.
- **The runner holds prod credentials.** Test users' passwords and a two-step secret live in GitHub, and the suite needs a little AWS access. That's an auth and prod change, and gets the security review in [Credentials and secrets](#credentials-and-secrets).

The bead's acceptance criteria should be rewritten to match (owner decision 1).

## What runs where today

- **Local and PR CI** (`tests/`): Playwright against the web build with fakes: `tests/mock-claude.js` (the runtime) for the app's screens, `tests/fake-aws.js` (route interception for the API, a fake Managed Login, a fake AppSync socket) for the `aws-*.spec.js` suites, a stand-in camera (`tests/camera.js`). Steps are tagged `@J4.2`, `journeys/registry.json` lists backend tests per step, and `npm run journeys:trace` fails when a built step has no test.
- **Each release** (`release.yml`): the journey evidence pack, recorded from those fakes, never prod.
- **Each deploy** (`deploy.yml`, `apply` job): `check-router`, `check-web` and `scripts/smoke-checks.mjs`, read-only, anonymous, no sign-in. A failed smoke check fails the deploy but rolls nothing back ([Post-deploy checks](releases.md#deploying-a-release)).
- **Planned:** the core journey canary (`supply-checkout-pkt`, after the pilot, 8am to 8pm Eastern, plus once on demand after each deploy), automatic rollback (`supply-checkout-9lj`).

Nothing yet signs in to prod as a user and walks a journey. That's this plan.

## The shape of it

A separate Playwright suite, `tests/prod/`, with its own config (`playwright.prod.config.mjs`), runs from a new reusable workflow (`journeys.yml`) that `deploy.yml` calls after `apply` succeeds, and that the owner can also run by hand on `main`. It drives the real app at `app.supplycheckout.com` through real Managed Login, as real users who belong only to **test teams**. It shares UI actions with the local suites, not specs. Its results are reported by journey step in the job summary, and its traces go to a private bucket, never to public Actions artifacts.

### Test accounts and test teams

**One marker for everything: the test mail subdomain.** Every test account's email address is at a subdomain we own and only we can read, say `e2e.supplycheckout.com` (owner decision 2), whose MX points at SES inbound in us-east-1. No one else can receive a code at that domain, so no one else can verify an address there; nobody can run a Google Workspace for it without our DNS either.

- **A test account** is one whose **verified** email (`email_verified` from Cognito, never the request) is at the test subdomain, matched exactly on the whole domain part of the address (not a suffix: a domain like `e2e.supplycheckout.com.example` isn't one).
- **A test team** is a team created by a test account. `POST /teams` writes `test: true` on the team's `META` item at creation, and nothing ever changes it: no route sets it, clears it or reads it from a body. Long-lived and throwaway teams are marked the same way.
- **What the mark does, and only this:** the handlers skip the business metrics (`SignUps`, `Checkouts`, `Returns`, `ReceiptReads` and the rest of `backend/src/observability/names.ts`) for a test account or team, logging `test: true` on the line instead, so the dashboard, the weekly review and alarms like **Checkouts stopped** and **No sign-ups** see customers only; and the operator page and `npm run ops -- teams` show a **Test** badge. AWS metrics (Lambda errors, API 5xx, DynamoDB) are left alone on purpose: a 5xx a test causes is a real 5xx.
- **What the mark never does:** grant access, extend a trial, raise a limit, skip a check, or change billing. A test team is billed, limited and refused exactly like a customer's. The security review checks this (below).

**Long-lived test accounts**, created once by the owner and kept:

| Account | Role | Team | Used for |
| --- | --- | --- | --- |
| `owner` | owner, password and two-step (TOTP) | both journey teams | J2, J6, J13.1, J15, settings, cleanup, J7 checks after go-live |
| `crew` | contributor, password | both | J0, J4, J13, J14, J15 |
| `viewer` | viewer, password | both | J9 |

Two long-lived teams, **Journeys desktop** and **Journeys phone**, one per browser project, so the two projects can run in parallel without one's stock counts moving under the other's assertions. Each is comped for 12 months by an operator (`npm run ops -- comp <team> --months 12`, audited), so it never turns read-only; the suite warns in its summary when a comp has less than 30 days left (owner decision 7).

**Throwaway accounts**, made by the run: a new owner who signs up (J1), and the crew member they invite (J3). Each is `run-<runId>-<role>@` the test subdomain, signs up with an email code read from the test mailbox, and deletes itself at the end through the app (J11), which is the journey's own test and the cleanup at once.

The pilot's data is safe by construction: the test accounts are members of test teams only, every API call is scoped to the caller's own teams by the server, and the runner has no table access. As a guard against a misconfigured secret (a real person's password, say), the harness reads `/me` right after each sign-in and stops the run unless every team listed is a test team it expects.

### The test mailbox

SES receives mail for the test subdomain only (a receipt rule set with one rule, recipient the subdomain), and writes each message to a private S3 bucket, `supply-checkout-prod-journey-mail-<region>-<account>` (block public access, SSE, a 1-day lifecycle rule). The subdomain is also verified as an SES identity, so that while SES is in the sandbox (`supply-checkout-3sv.18`) Cognito's codes, invites and welcome emails can reach it; after production access that's harmless.

The harness's mailbox reader lists the bucket under the run's prefix, waits up to 60 seconds for a message to an address, and accepts it only when SES's receipt verdicts say SPF and DKIM passed and the sender is the app's no-reply address. Anyone can send mail to the subdomain; only our own lands as a code. It extracts the code or link, `::add-mask::`s it, and never logs the body.

This is also how the email journeys are proved for real: J1's welcome email, J3's invite, and the sign-in code itself.

### Journey by journey

What the prod suite does, and what it leaves to the local suites. "Desktop" and "phone" are the two browser projects.

| Journey | In prod | How | Not in prod, and why |
| --- | --- | --- | --- |
| **J0** Sign in | Yes, both | J0.2 by password through Managed Login (`crew`); by email code for the throwaway owner (J1); J0.3 by switching between the two teams `owner` belongs to. Expect projects within 3 seconds. | Google and Apple (their sign-in pages fight automation; covered by `backend/test/account-link.test.ts` and a manual check, owner decision 10). Passkeys: possible later with Chromium's virtual authenticator, not in the first cut. |
| **J1** Sign up and start a trial | J1.3 now; J1.1 and J1.2 once `supply-checkout-21q` builds them | The throwaway owner signs up with an email code, names a team, sees the 14-day trial and the **Get your team started** checklist; the welcome email arrives in the mailbox within a minute. | Nothing beyond the planned steps. |
| **J2** Set up the inventory | Yes, both | `owner` adds a run-prefixed item, edits it, imports a 3-line CSV, sets the equipment markup. | — |
| **J3** Invite the crew | Yes, desktop | The throwaway owner invites `run-<runId>-crew@…` as a contributor; a second browser context reads the invite email, signs up and accepts; the member list shows them. | The 7-day expiry and resend limits (backend and fake tests). |
| **J4** Check out and back in | Yes, both | `crew` creates a run-prefixed project, checks out by typed barcode and by the stand-in camera (`tests/camera.js` works on the live page), returns part, **Finished Return**; storage counts follow. A second context as `owner` sees the live update within 2 seconds. | Slow and flaky connections (`save-states`, `aws-save-states`), concurrency races. |
| **J5** Read a receipt | Yes, desktop, **one real read** | Photograph a committed synthetic receipt image (`tests/prod/fixtures/receipt.jpg`, no real store or person); expect lines within 60 seconds, then **Stop** before **Save** so nothing is written. Loose assertions: at least 3 lines, each with a name and a price; no exact text. | Exact parsing, limits, timeouts, refusals: the local and backend suites. No stub mode in prod (below). |
| **J6** Export a project | Yes, both | Download the run's project CSV; check its name, columns and total row. | — |
| **J7** Subscribe, seats, invoices | Before go-live: yes, desktop, Stripe sandbox. After go-live: read-only checks only | [Billing in prod](#billing-in-prod) | See there. |
| **J8** A payment fails and is fixed | Before go-live only | [Billing in prod](#billing-in-prod) | After go-live: nothing in prod. |
| **J9** A viewer can see but not change | Yes, both | `viewer` opens projects and inventory; no scan, edit or delete controls. One API write with the viewer's token answers 403. | — |
| **J10** Cancel and take the data | J10.1 and J10.2 before go-live | Cancel in the sandbox Customer Portal; the team bar shows the end date; export works. | J10.3 (closed 30 days later, deleted): can't wait 30 days; covered by `backend/test/` and the lapsed-team alarms. |
| **J11** Delete an account | Yes, desktop | The throwaway crew member deletes their account; the throwaway owner closes their team (J11.2) and deletes theirs. `/me` then answers 401 for both. | The 30-day purge itself (backend tests, **Deletion overdue**). |
| **J12** Mobile plan | No | Phase 2. | — |
| **J13** Company equipment | Yes, both | `owner` marks a run item as equipment; `crew` checks it out, returns part, answers **Finished Return**'s question; **Out on jobs** lists it meanwhile. | — |
| **J14** Without a job | Yes, both | `crew` quick-takes, returns from the project list, moves a line to the run's project, **Finished Return** on General Use (no job), so the next run starts with none open. | — |
| **J15** Reorder | Yes, both | Set **Reorder at** on a run item, take it below, see **Low**, acknowledge, mark ordered, cancel the order. | — |
| Operators (ops page) | No | Owner decision 6. | A standing operator credential in CI would read every team's record and write comps. `tests/ops.spec.js` covers the page; the owner checks it by hand per release. |

**Bedrock: one real read, no stub.** The bead asked for a stub Bedrock mode for determinism plus one real smoke read. A stub mode in prod means a code path in the receipts function that returns canned lines when something in the request or the team says so: a switch an attacker could look for, and code that only tests use. The determinism is already in the local suites (`aws-receipts.spec.js`, `receipts.spec.js`) and `backend/test/receipts-api.test.ts`. In prod the suite makes one real read per run, on desktop only, and asserts structure rather than text, so a model's wording change doesn't fail a release. At Haiku 4.5's list price that's about $0.005 to $0.007 a read ([ADR 0008](adr/0008-receipt-reading-bedrock.md#cost)); at a few deploys a week, well under a dollar a year. It counts against the throwaway team's 25 trial reads and the throwaway owner's own rate limit, like a customer's.

**Destructive journeys only touch what the run made.** Account deletion and team closure (J11) run only as a throwaway account the run signed up, on a team the run created. The harness refuses to call `DELETE /me` or `POST /teams/{teamId}/close` unless the account's address is `run-<this runId>-…` at the test subdomain and the team is one this run created. A closed throwaway team is purged by the hourly purge 30 days later, like any closed team; it's small and marked test, so that's acceptable (owner decision 8).

### Billing in prod

**Now, while prod is on the Stripe sandbox:** run the billing journeys for real on the throwaway owner's team, desktop only:

1. **Two-step first.** Billing routes need TOTP for a native owner (`supply-checkout-8jc.12`), so the throwaway owner sets a password and turns two-step on in **Account** (the harness computes codes from the secret the app shows, with a TOTP library), is signed out everywhere, and signs in again with password and code. That proves the two-step flow on prod too.
2. **J7.2** Subscribe from the team bar, pay on Stripe's hosted Checkout with the test card `4242 4242 4242 4242`; within a minute `/me` shows the plan.
3. **J7.3** Accept the invited crew member as a contributor; within a minute the subscription's quantity follows (read through **Billing → invoices** and `/me`, not the Stripe API). Open the invoice list.
4. **J8.1 and J8.3** Make the next payment fail: the harness, with a restricted sandbox key (Subscriptions write, Customers read, nothing else), swaps the customer's default payment method for Stripe's always-declining test card and asks for an invoice now; the `invoice.payment_failed` webhook arrives and the team bar says so (J8.2's banner when `supply-checkout-qdx` builds it). Then the owner updates the card in the Customer Portal; within a minute full access is back.
5. **J10.1 and J10.2** Cancel in the Customer Portal, see the end date, export.
6. Then J11 closes the team, and the closed-team purge ends its sandbox subscription.

Test clocks aren't needed for any of that: the app creates the Stripe customer at Checkout, so a clock can't be attached anyway, and the failure is triggered directly.

**After go-live** (`stripeMode=live`), prod has no test mode. The options (owner decision 3):

| Option | What's tested in prod | What's lost | Cost and risk |
| --- | --- | --- | --- |
| **A. Read-only live checks (recommended)** | On a long-lived journey team: **Subscribe** reaches Stripe's hosted live Checkout page (not paid), **Billing** opens the live Customer Portal, the invoice list loads. Proves keys, prices, the portal configuration and the routes after each deploy. | Paying, the webhook to `active`, seat proration, a failed payment and its fix, cancellation: these are then proved only by the backend tests, the fake-API suites and the billing alarms, until phase-2 per-PR preview stacks with the sandbox exist. | None: no charge, no live subscription. The first Checkout makes the long-lived team a live Stripe customer, once. |
| B. Per-team Stripe mode | Everything, in the sandbox, from prod | Nothing | The billing function, webhook and worker would read both modes' keys and pick one per team. A bug or a forged mark would put a real team on the sandbox, which is free service, or mix modes in one team's records. A large security surface for a test convenience. Not recommended. |
| C. Real payments, refunded | Everything but failures | J8 (a live card can't be made to fail on demand) | Real charges and fees on a real card, refunds by hand, $0 revenue noise in Stripe's reports. Not recommended. |
| D. Skip billing in prod | Nothing | All of J7, J8, J10.1 | None. |

The suite reads the mode from `config.json` or `/me` (whichever exposes it by then; the billing bead adds it if neither does) and runs the sandbox flow or option A, so the switch at go-live needs no change to the workflow. The restricted sandbox key is deleted from the environment at go-live.

### Data isolation and cleanup

- **Run IDs.** Every run has an ID (`<GitHub run id>-<attempt>`). Everything it creates in a long-lived team is named with it: projects `E2E <runId> …`, items `E2E <runId> …` with barcodes `e2e<runId>…`, the CSV import's lines likewise.
- **Cleanup after each run, pass or fail.** A separate step with `if: always()` runs `node scripts/journeys/cleanup.mjs --run <runId>`, which signs in as `owner` (API only, `USER_AUTH` with the password and TOTP) and deletes every project and item named for the run in both long-lived teams, finishing any General Use (no job) left open first. Then it deletes any throwaway account the run made that still exists: it signs in as each by email code (read from the mailbox) and calls `DELETE /me`, closing the account's team first if needed. It's idempotent and keeps going past a failure, then fails the step if anything is left, listing what (masked).
- **Leftovers from a crashed run.** The cleanup also removes anything in the long-lived teams named `E2E …` more than 24 hours old, so a run that died before cleanup is swept by the next. Throwaway addresses are recorded under `runs/<runId>/accounts` in the mail bucket as they're made (a 30-day lifecycle on that prefix, not 1 day), so the next run's cleanup can find and delete a crashed run's accounts too.
- **What stays.** The inventory movement log keeps entries for deleted run items; the long-lived teams grow by a few hundred small items a year. Once a year, when the comps are renewed, the owner can close both teams and make new ones instead (the purge deletes the old ones).
- **Metrics, alarms, billing, the canary.** Business metrics: skipped for test teams (above). RUM: the prod config aborts requests to the RUM data plane, so test sessions don't add billed events. Alarms: the suite is real traffic and must not cause alarms: it runs no rate-limit, surge or failure-injection tests; one run's few sign-ins, invites, emails and receipt reads are far under every threshold. Billing: test teams are comped or throwaway trials; before go-live, sandbox only. The core canary (`supply-checkout-pkt`) has its own test team and user, separate from the journey teams, so neither run moves the other's data; and the deploy's concurrency group means only one suite runs at a time.

### Credentials and secrets

**A GitHub environment of its own, `production-journeys`.** Deployment branches `main` only, administrators can't bypass. No required reviewer (owner decision 5): the owner already approved `apply`, and this job deploys nothing. `scripts/check-environments.mjs` checks it like the other two (exists, `main` only, no bypass), but without the reviewer rule. Its secrets, readable only by a job that names the environment, in a run on `main`:

| Secret | What | Rotation |
| --- | --- | --- |
| `JOURNEYS_OWNER_PASSWORD`, `JOURNEYS_CREW_PASSWORD`, `JOURNEYS_VIEWER_PASSWORD` | The long-lived accounts' passwords, 32 random characters each, made by the owner when creating the accounts and stored nowhere else | Every 90 days, and at once if a log might have shown one: the owner changes it in the app's Account screen and updates the secret |
| `JOURNEYS_OWNER_TOTP` | The `owner` account's two-step secret (base32) | With the password, by turning two-step off and on |
| `JOURNEYS_AWS_ROLE_ARN` | The journeys role (below) | When the role is replaced |
| `JOURNEYS_OWNER_EMAIL`, `JOURNEYS_CREW_EMAIL`, `JOURNEYS_VIEWER_EMAIL`, `JOURNEYS_DESKTOP_TEAM_ID`, `JOURNEYS_PHONE_TEAM_ID`, `JOURNEYS_MAIL_BUCKET`, `JOURNEYS_RESULTS_BUCKET` | Not secret on their own, but secrets so they're masked in the public log: the long-lived accounts' addresses, the two journey teams the `/me` guard allows, and the two buckets (the role can't read SSM; their names hold the account ID). Added with the harness (`supply-checkout-o60.5`, [docs/testing.md](testing.md#journey-tests-against-prod)) | When an account, team or bucket is replaced |
| `JOURNEYS_STRIPE_SANDBOX_KEY` | A restricted **sandbox** key: Subscriptions write, Customers read, Payment methods write; nothing else, never a live key | Every 90 days; deleted at go-live |

Who can read them: the owner (repository admin), and any job on `main` that names the environment. Since `main` takes only reviewed, squash-merged PRs, a change to a workflow that names `production-journeys` goes through review, and the security review of that PR is where a leaked secret would be stopped. No pull request event can name it (`deploy.yml` and `journeys.yml` have no `pull_request` trigger), and the job checks out only the `main` commit that the deploy's `release` job approved.

**The journeys role**, `supply-checkout-prod-journeys`, in a stack of its own (`infra/lib/stacks/journeys-stack.ts`, with the mail bucket, the results bucket and the SES receipt rule). Its trust: GitHub's OIDC provider, `sub` exactly `repo:<owner>@<owner ID>/<repo>@<repository ID>:environment:production-journeys` (GitHub's immutable subject, as for the deploy role), audience `sts.amazonaws.com`, a one-hour session. Its permissions, and nothing else:

- `s3:ListBucket` on the mail bucket (prefixes `inbox/` and `runs/`), `s3:GetObject` under `inbox/`, `s3:GetObject` and `s3:PutObject` under `runs/`, and `s3:DeleteObject` under `inbox/` (to delete a message once read);
- `s3:PutObject` under `runs/` in the results bucket (`supply-checkout-prod-journey-results-<region>-<account>`: private, SSE, block public access, a 30-day lifecycle; `supply-checkout-s3c.9` links the last good recording from here);
- no Cognito, no DynamoDB, no Secrets Manager, no SES send, no CloudWatch, no `iam:PassRole`, no `sts:AssumeRole`. Everything the suite does to the app, it does through the public API and UI as a user.

The deploy role and the publisher role don't trust it, and it doesn't trust them. `apply`'s credentials never reach the journeys job (a different job, a different runner).

**What never leaves the runner.** The repository is public, so its Actions logs, job summaries and artifacts are public:

- No Playwright traces, videos, screenshots or HTML report as Actions artifacts: traces hold request headers (bearer tokens, the refresh cookie) and the pages hold test data. They go to the results bucket only.
- The harness `::add-mask::`s every password (already masked as secrets), every code and link read from the mailbox, every throwaway address, every team and user ID, and every access token, before anything can print them.
- The job summary lists each step's result by journey step ID, browser and duration, and each failure's assertion message with the masking applied; nothing else.
- The Playwright `list` reporter only; no `html` or `github` reporter (which would print source context and errors to annotations).

**What the security review must check** (a separate reviewer agent, per `CLAUDE.md`), in addition to its usual list:

1. The test-account rule reads only the verified email from Cognito's token or `GetUser`, requires `email_verified`, and matches the whole domain exactly; nothing in a request body, header or path can set or clear `test`.
2. The `test` mark grants nothing: grep every reader of it; it may only skip a metric, add a log field, or show a badge.
3. The journeys role's trust pins the environment subject and audience; its policy has no `*` action or resource, and cdk-nag suppressions are justified; the buckets refuse public access and non-TLS requests.
4. The SES receipt rule accepts only the test subdomain, and the reader checks SPF and DKIM verdicts and the sender before trusting a code.
5. The harness refuses any base URL but the prod app (or `localhost` for its own unit tests), stops when `/me` lists a team that isn't an expected test team, and refuses destructive calls outside the run's own accounts and teams.
6. Nothing secret reaches a log, summary, annotation or artifact: run the suite once with a deliberately failing assertion and read the public log.
7. `check-environments.mjs` covers `production-journeys`, and no workflow with a `pull_request` or `pull_request_target` trigger names it.
8. No IAM or Cognito admin power is added anywhere for tests: no `AdminCreateUser`, `AdminSetUserPassword` or `AdminDeleteUser` for the runner (it would let CI take over any customer's account).

### Reusing the local tests

The local specs can't simply be pointed at prod with a `BASE_URL` switch. They load the app through `openApp` (route interception of the whole origin), run against `mock-claude.js` or `fake-aws.js`, seed state in `window.__mock.docs`, assert on the requests the fakes saw, and sign in through a fake Managed Login that answers 204. Against prod none of that exists. So:

- **Share UI actions, not specs.** First, move the screen-level helpers that only click and read the UI (`createProject`, `enterBarcode`, the checkout, return and **Finished Return** dialogs, receipts review, inventory forms, the team switcher) from `tests/helpers.js` and the specs into `tests/ui/`, with no change in behavior, and have the local specs use them. Then `tests/prod/` uses the same actions, so a UI change that breaks them breaks the local suite first, in PR CI, before it reaches prod.
- **Separate prod specs**, `tests/prod/J<n>-<slug>.prod.js` (not `.spec.js`, so the default config never picks them up), tagged with the same step IDs (`@J4.2`) and `@prod`, with `test.step("J4.2 …")` blocks named by step, so `journeys:trace` and `supply-checkout-s3c.9` can match them to the registry.
- **The config**, `playwright.prod.config.mjs`: `baseURL` `https://app.supplycheckout.com` (refusing anything else), two projects, `desktop-chrome` and `iphone-safari` (WebKit with the iPhone 13 profile; the other ten browsers stay in local CI, owner decision 11), 2 workers (one per project), `retries: 1`, a 90-second test timeout, traces `retain-on-failure` to the results bucket, the `list` and a JSON reporter. The fixture that fails a test on a console error or page error stays, with one more allowed pattern: the aborted RUM requests.
- **Keeping prod specs from rotting.** PR CI type-checks and lints them and lists them (`playwright test --config playwright.prod.config.mjs --list`), so a broken import or a tag naming a missing step fails the PR. They first run for real on `main`: after merging a change to `tests/prod/`, the lead runs `journeys.yml` by hand (it needs no deploy), and the next release depends on it passing.

### Flake policy

- `retries: 1`. A test that passes on its retry passes the run but is listed as **flaky** in the summary, and the lead files a bead for it the same day. A flaky prod test is a bug in the test or the app, never noise.
- Two failures of the same test (the try and the retry) fail the run. There's no quarantine list: a test that can't be trusted is fixed or removed in a PR, with the step given a `prodSkip` reason in the registry (below) until it's back.
- Waits are on what the user sees (`expect(...).toBeVisible()`), never fixed sleeps; email waits poll the mailbox for up to 60 seconds; webhook-driven states poll `/me` for up to 90 seconds.

### Run time and cost

| | Desktop | Phone |
| --- | --- | --- |
| J0, J2, J4, J6, J9, J13, J14, J15 on the long-lived team | about 5 minutes | about 6 minutes |
| J1, J3, J5, J11 (throwaway accounts, three emails, one receipt) | about 4 minutes | — |
| J7, J8, J10 (sandbox, before go-live) | about 4 minutes | — |

About 13 minutes wall time with the two projects in parallel, plus a minute each for setup and cleanup: roughly 15 minutes after `apply`, inside its existing 60-minute budget. Cost per run: GitHub-hosted runner minutes (free for a public repository); Lambda, API Gateway, DynamoDB and S3 in fractions of a cent; one Bedrock read (under a cent); about six SES messages (well under the sandbox's 200 a day); two Cognito users a run, within the Essentials tier's free monthly active users. Under a dollar a month at a few deploys a week.

### Where it runs in the deploy

```
release → trust → build → plan (approval 1) → apply-stateful (approval 2) → apply (approval 3)
                                                                              │ stacks, publish, check-router, check-web, smoke checks
                                                                              ▼
                                                                          journeys   (production-journeys, no approval)
                                                                              │
                                                                              ▼
                                                                          verdict    (contents: write, no AWS)
```

- **After `apply`, after the smoke checks**, as its own job, `journeys`, calling `journeys.yml` with the release tag. It runs only when `apply` succeeded (smoke checks included): if the API doesn't answer 401 there's no point signing in. The core canary's on-demand run (`supply-checkout-pkt`) stays in `apply` where its hook is; the journeys suite is the broader check after it.
- **Also on demand:** `workflow_dispatch` on `journeys.yml` from `main`, to check prod after a spec change, an incident, or a Stripe or AWS change outside a deploy. It joins the `deploy-production` concurrency group, so it never runs during a deploy.
- **Not nightly** (owner decision 9): the canary covers the day, and nothing changes in prod between deploys but data and dependencies.

### When the suite fails

There's no staging to hold a release in, so failing means:

1. **The deploy run fails**, and its **Deploy summary** says which journey steps failed, in which browser, and what to do next. GitHub emails the owner about the failed run (as for any failed deploy).
2. **The release is marked.** A small `verdict` job (no AWS, `contents: write` only) edits the GitHub Release: on a pass it adds "Journey tests passed in prod" with the run link; on a failure it marks the release as a pre-release and adds "Journey tests failed in prod: J4.2, J13.4 (desktop)" with the run link. The next deploy's `release` check refuses to deploy a pre-release unless the dispatch says `allow-bad-release` (for redeploying a fix of the suite itself). That's what "blocks promotion" becomes: a bad release can't be deployed again by accident, and the releases page shows which releases were good.
3. **A critical journey failing is a P1.** If a step of a critical journey (J0, J1, J4, J7, J8, J13, J14) failed on both tries, the owner follows the runbook (`docs/runbooks/journey-tests-failed.md`, bead below): check the trace in the results bucket, and if customers are affected, deploy the previous release again (Actions, Deploy, **Run workflow** with the previous tag), which puts back its stacks and its web app. A non-critical journey failing is a P2: fix forward the same business day.
4. **Automatic rollback comes with `supply-checkout-9lj`** (owner decision 4). The suite's result is a signal 9lj can use: once 9lj's web rollback exists, a critical-journey failure rolls the web app back to the previous version on its own, as a failed canary does; the stacks keep CodeDeploy's alarm-driven rollback. Rolling back automatically from a 15-minute browser suite before 9lj's rollback path is proven would be riskier than the page.

### Results by journey

- Each prod test carries its step tags; the JSON reporter's output is turned by `scripts/journeys/prod-summary.mjs` into the job summary: one row per step (`J4.2 Scan each item's barcode …`) with the result in each browser, the test's duration, and for a failure the masked assertion. Steps with no prod test are listed with their `prodSkip` reason, so the summary shows the whole registry, not only what ran.
- **The registry gains a prod column.** Each built step either has a test tagged with it in `tests/prod/`, or a `prodSkip` reason in `journeys/registry.json` ("can't wait 30 days; backend tests", "phase 2", "Google sign-in, manual"). `npm run journeys:trace` lists both and fails a built, non-phase-2 step with neither; `docs/journeys.md` gets a generated **In prod** column. That makes the bead's "every journey in docs/journeys.md has a passing test" checkable: every built step has a passing prod test or an owner-approved reason it can't.
- Traces and a video of each failed test go to `s3://supply-checkout-prod-journey-results-<region>-<account>/runs/<runId>/`; the summary names the object keys, not presigned links (a presigned link in a public log is a public link). `supply-checkout-s3c.9` adds "the last good recording" from the same bucket.

## The beads

Split so each PR is small, and so the backend and IAM changes are separate PRs with their own security reviews. The lead creates them under `supply-checkout-o60` (as children, or with o60 depending on them) and may adjust. Targets outside the graph are existing beads.

```json
{
  "nodes": [
    {
      "key": "ui",
      "title": "Move the tests' UI actions into tests/ui/ for the local and prod suites",
      "type": "task",
      "priority": 1,
      "labels": ["mvp", "qa"],
      "description": "Move the screen-level helpers that only click and read the UI (createProject, enterBarcode, checkout, return and Finished Return dialogs, receipt review, inventory forms, the team switcher) from tests/helpers.js and the specs into tests/ui/, with no change in behavior. The local specs use them. A test: PR, no app change. See docs/journey-tests-plan.md, Reusing the local tests.",
      "acceptance_criteria": "tests/ui/ holds the shared actions with no fake or mock imports; local specs use them; CI green in every browser; coverage unchanged",
      "deps": []
    },
    {
      "key": "flag",
      "title": "Mark test accounts and teams by the test mail subdomain and keep them out of business metrics",
      "type": "feature",
      "priority": 1,
      "labels": ["mvp", "qa"],
      "description": "A test account is one whose verified email (from Cognito, never the request) is at the test mail subdomain, matched exactly. POST /teams writes test: true on META for a team a test account creates; nothing else sets or clears it. Handlers skip the business metrics in backend/src/observability/names.ts for test accounts and teams and log test: true instead; the ops CLI and page show a Test badge. The mark grants nothing. Needs the security review (CLAUDE.md). See docs/journey-tests-plan.md, Test accounts and test teams.",
      "acceptance_criteria": "Backend tests: verified test-domain user's new team is marked, unverified or look-alike domains aren't, no route can set or clear it; metrics skipped for test teams and sent for others; every reader of the mark only skips metrics, logs or shows a badge; security review approves",
      "deps": []
    },
    {
      "key": "mail",
      "title": "Add the journeys stack: test mail subdomain, SES inbound to a private bucket, results bucket and the journeys role",
      "type": "feature",
      "priority": 1,
      "labels": ["mvp", "qa"],
      "description": "infra/lib/stacks/journeys-stack.ts in the primary region: MX for the test subdomain to SES inbound, a receipt rule set accepting only that subdomain, writing to a private mail bucket (1-day lifecycle on inbox/, 30 days on runs/); the subdomain verified as an SES identity for the sandbox; a private results bucket (30-day lifecycle); the supply-checkout-prod-journeys OIDC role trusted only by environment production-journeys, with exactly the S3 permissions in the plan. Docs: infrastructure.md. Needs the security review (IAM). See docs/journey-tests-plan.md, The test mailbox and Credentials and secrets.",
      "acceptance_criteria": "cdk-nag clean with justified suppressions; template tests pin the role's trust subject and audience and every statement; buckets block public access and non-TLS; a message to the subdomain lands in the bucket in a deployed check; security review approves",
      "deps": []
    },
    {
      "key": "env",
      "title": "Set up the production-journeys environment and check it in check-environments",
      "type": "task",
      "priority": 1,
      "labels": ["mvp", "qa"],
      "description": "scripts/check-environments.mjs also checks production-journeys (exists, main only, no admin bypass; no reviewer required). The owner creates it and its secrets (three passwords, the owner's TOTP secret, the role ARN, the sandbox restricted key), creates the long-lived accounts at the test subdomain and the two journey teams, and comps them for 12 months. The setup steps go in docs/releases.md. See docs/journey-tests-plan.md, Credentials and secrets.",
      "acceptance_criteria": "check-environments tests cover the new environment; the owner's setup steps are documented and done; the accounts sign in and /me lists only the two journey teams",
      "deps": [{ "target": "mail", "type": "blocks" }, { "target": "flag", "type": "blocks" }]
    },
    {
      "key": "harness",
      "title": "Build the prod journey harness: config, guards, sign-in, mailbox reader, cleanup and summary",
      "type": "task",
      "priority": 1,
      "labels": ["mvp", "qa"],
      "description": "playwright.prod.config.mjs (prod base URL only, desktop-chrome and iphone-safari, retries 1, RUM aborted, list and JSON reporters, traces to the results bucket); fixtures to sign in through Managed Login by password and TOTP; the /me test-team guard; run IDs and naming; the mailbox reader (SPF/DKIM verdicts, sender, masking); scripts/journeys/cleanup.mjs (run-scoped and 24-hour sweep, throwaway accounts by email code and DELETE /me); scripts/journeys/prod-summary.mjs. Unit tests with node:test for the guards, reader, cleanup and summary. PR CI lists the prod specs. See docs/journey-tests-plan.md.",
      "acceptance_criteria": "Unit tests for every guard (base URL, team allowlist, destructive-call scope), the reader's verdict checks and the masking; PR CI lists tests/prod; a first smoke spec (J0.2 as crew) passes against prod from a manual run; nothing secret in the public log of a deliberately failing run",
      "deps": [{ "target": "ui", "type": "blocks" }, { "target": "env", "type": "blocks" }]
    },
    {
      "key": "workflow",
      "title": "Run the journey suite after each prod deploy and mark the release",
      "type": "task",
      "priority": 1,
      "labels": ["mvp", "qa"],
      "description": "journeys.yml (workflow_call and workflow_dispatch on main, concurrency deploy-production, environment production-journeys) runs the suite, then cleanup with if: always(), then writes the job summary. deploy.yml calls it after apply succeeds. A verdict job (contents: write, no AWS) notes the result on the GitHub Release and marks a failed release as a pre-release; the release check refuses a pre-release unless allow-bad-release. Docs: releases.md. See docs/journey-tests-plan.md, Where it runs and When the suite fails.",
      "acceptance_criteria": "A deploy runs the suite after apply and the summary lists every registry step; a failing run marks the release and fails the deploy; a dispatch on main runs it alone; no artifact holds a trace; workflow lint and check-environments pass",
      "deps": [{ "target": "harness", "type": "blocks" }]
    },
    {
      "key": "core",
      "title": "Prod journey tests for J0, J2, J4, J6, J9, J13, J14 and J15 on the long-lived teams",
      "type": "task",
      "priority": 1,
      "labels": ["mvp", "qa"],
      "description": "tests/prod/ specs on Journeys desktop and Journeys phone, tagged by step, as the plan's table describes, including the live update to a second context in J4 and the stand-in camera. Everything they create is run-named and cleaned up. See docs/journey-tests-plan.md, Journey by journey.",
      "acceptance_criteria": "Each built step of these journeys has a passing prod test in both projects or a prodSkip reason; two runs in a row leave both teams as they were; no business metric moves during a run",
      "deps": [{ "target": "harness", "type": "blocks" }]
    },
    {
      "key": "onboard",
      "title": "Prod journey tests for J1, J3, J5 and J11 with throwaway accounts",
      "type": "task",
      "priority": 1,
      "labels": ["mvp", "qa"],
      "description": "A throwaway owner signs up by email code, names a team (J1.3, welcome email), invites a throwaway crew member who signs up and accepts (J3), reads one real receipt from a committed synthetic image and stops before saving (J5), then the crew member deletes their account and the owner closes the team and deletes theirs (J11). Destructive calls only on the run's own accounts and team. See docs/journey-tests-plan.md.",
      "acceptance_criteria": "J1.3, J3.1, J3.2, J5.1, J5.2, J11.1 and J11.2 have passing prod tests; the welcome and invite emails are read from the mailbox; no throwaway account outlives the run, including after a run killed mid-way (next run's cleanup)",
      "deps": [{ "target": "harness", "type": "blocks" }]
    },
    {
      "key": "billing",
      "title": "Prod billing journeys J7, J8 and J10 in the Stripe sandbox, and read-only checks after go-live",
      "type": "task",
      "priority": 1,
      "labels": ["mvp", "qa"],
      "description": "While prod is on the sandbox: the throwaway owner turns two-step on, subscribes with the test card, gets a seat added by the invite, has a payment fail via the restricted sandbox key and fixes the card in the Customer Portal, cancels and exports. In live mode (read from config or /me): option A from the plan, read-only checks on a long-lived team. See docs/journey-tests-plan.md, Billing in prod.",
      "acceptance_criteria": "J7.2, J7.3, J8.1, J8.3, J10.1 and J10.2 pass in prod in sandbox mode; in live mode the suite runs only the read-only checks and says so in the summary; no live subscription or charge is ever made",
      "deps": [{ "target": "onboard", "type": "blocks" }]
    },
    {
      "key": "registry",
      "title": "Trace prod coverage: prod tests and prodSkip reasons in the registry and journeys:trace",
      "type": "task",
      "priority": 2,
      "labels": ["mvp", "qa"],
      "description": "journeys/registry.json gains prodSkip reasons; npm run journeys:trace lists tests/prod tests per step and fails a built, non-phase-2 step with neither a prod test nor a prodSkip reason; docs/journeys.md gets a generated In prod column and its intro points at the suite. See docs/journey-tests-plan.md, Results by journey.",
      "acceptance_criteria": "journeys:trace fails on a step with no prod test and no reason, and on a prodSkip for a step that has a prod test; the In prod column matches the registry; scripts tests cover both",
      "deps": [{ "target": "core", "type": "blocks" }, { "target": "onboard", "type": "blocks" }]
    },
    {
      "key": "runbook",
      "title": "Write the runbook for journey tests failing after a deploy",
      "type": "task",
      "priority": 2,
      "labels": ["mvp", "qa"],
      "description": "docs/runbooks/journey-tests-failed.md: reading the summary, finding the trace in the results bucket, P1 for a critical journey (redeploy the previous release), P2 otherwise, a flaky test, cleanup that failed, renewing the comps, rotating the secrets. See docs/journey-tests-plan.md, When the suite fails.",
      "acceptance_criteria": "Runbook merged and linked from releases.md and journeys.md; the owner has walked it once on a deliberately failing dispatch",
      "deps": [{ "target": "workflow", "type": "blocks" }]
    }
  ]
}
```

After these, `supply-checkout-o60`'s acceptance is met when the registry and workflow beads are done: every built step has a passing prod test or an approved reason, the suite runs on every prod deploy and marks a failing release, and cleanup runs after every run. `supply-checkout-9lj` then uses the verdict for the automatic web rollback, and `supply-checkout-s3c.9` the step names and the results bucket.

## Owner decisions

1. **Rewrite o60's acceptance for prod.** Recommendation: "Every built step in docs/journeys.md has a passing prod test or an approved `prodSkip` reason; the suite runs after every prod deploy and a failure fails the deploy, marks the release and pages for a critical journey; test data is cleaned up after each run, pass or fail."
2. **The test marker and mailbox.** A subdomain we own (`e2e.supplycheckout.com` or another name) as the only marker of test accounts, with SES inbound to a private bucket. The alternative is a mailbox vendor (Mailosaur or similar: no infrastructure, but a monthly fee and a third party reading sign-in codes). Recommendation: the subdomain with SES inbound.
3. **Billing after go-live.** Recommendation: full billing journeys in the sandbox until go-live; after it, option A (read-only live checks), accepting that paying, proration, failed payments and cancellation are proved in prod only by alarms and the non-prod suites until phase-2 preview stacks. Not a per-team Stripe mode.
4. **What a failure does.** Recommendation: fail the deploy, mark the release a pre-release, P1 runbook for a critical journey (redeploy the previous release by hand); automatic web rollback only once `supply-checkout-9lj` exists and has been proven.
5. **An approval for the journeys job?** Recommendation: none. `production-journeys` is `main`-only without a reviewer; the approval that matters was `apply`'s.
6. **Operator journeys in prod.** Recommendation: not automated. A standing operator credential in CI would be the most powerful secret in the repo; keep `tests/ops.spec.js` against fakes and a short manual ops check per release.
7. **Long-lived journey teams.** Recommendation: two (desktop and phone), each comped 12 months by an operator, renewed yearly; the suite warns 30 days ahead.
8. **Destructive journeys.** Recommendation: only on throwaway accounts and teams the run created; J10.3 and the 30-day purge stay with the backend tests and alarms; closed throwaway teams are purged on the normal schedule.
9. **Cadence.** Recommendation: after each deploy and on demand; no nightly run.
10. **Google, Apple and passkey sign-in.** Recommendation: not in the prod suite; a manual check of each quarterly and after any identity change; passkeys by virtual authenticator as a later bead if wanted.
11. **Browsers in prod.** Recommendation: desktop Chrome and iPhone Safari (WebKit), the same two as PR CI; the other ten stay in the local matrix.
12. **A Stripe sandbox key on the runner** (for J8's failed payment). Recommendation: yes, restricted, sandbox only, deleted at go-live.
13. **Where prod traces live.** Recommendation: the private results bucket, 30 days; never Actions artifacts, which are public here.
