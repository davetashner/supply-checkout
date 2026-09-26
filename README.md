# Supply Checkout

A shared supply tracker for taking supplies from storage to client jobs and bringing back what wasn't used.

- **Sheets** – one per client and date, recording who prepared it. Scan a barcode (or pick an item without one) to check supplies out, scan again on return to record what came back unused, then tap **Finished Return**. Each sheet totals what was used and what to charge, and downloads as CSV.
- **Inventory** – items, prices and how many are in storage. Checkouts subtract from storage; returns add back.
- **Receipts** – photograph a store receipt and Claude reads the line items and prices, suggests matches against existing inventory, and lets you assign each item to a client's sheet or to general inventory before anything is saved.

The app runs as a [Claude artifact](https://claude.ai/artifact/LcSb29dTE99AK4N6iuVFrj). claude.ai provides the shared database, sign-in, file downloads and receipt reading through `window.claude`; there is no server to run.

The source is a small [Vite](https://vite.dev) project with no UI framework. One build of it is the single `index.html` published to claude.ai; another is a static bundle for the AWS version ([ADR 0004](docs/adr/0004-runtime-adapter.md)).

## Repository layout

| Path | What it is |
| --- | --- |
| `src/index.html` | The page: head (fonts, ZXing from a CDN) and markup. |
| `src/styles.css` | All of the app's styles. |
| `src/main.js` | App state, screens, modals, receipt review, and startup. |
| `src/runtime.js` | `use()`, the one place the app reaches the claude.ai runtime (`window.claude`). |
| `src/format.js`, `src/sheet-math.js` | Formatting helpers and sheet totals, with no app state. |
| `src/dom.js` | `$`, toast, modals, two-tap confirm buttons and number steppers. |
| `src/barcode.js` | Reading barcodes from photos (the browser's detector, or ZXing). |
| `src/receipt-prompt.js` | The receipt-reading prompt and its error messages. |
| `vite.config.js` | The two builds: `artifact` and `web` (below). |
| `dist/` | Build output (not committed). |
| `scripts/builds.mjs` | Builds and serves either build for the tests. |
| `scripts/page.mjs` | Wraps the artifact in the same document skeleton claude.ai adds at publish time. |
| `scripts/validate-html.mjs` | HTML validation (html-validate). |
| `scripts/dev-server.mjs` | Local dev server with the mock runtime (`npm run dev`). |
| `scripts/land-pr.sh` | Waits for CI, squash-merges a PR, cleans up its worktree and branch, and closes its beads (`npm run land -- <pr>`). Exits non-zero if the PR isn't merged, and explains a PR that main's ruleset blocks. |
| `scripts/land-pr.test.sh` | Tests for `land-pr.sh` against a fake `gh` in a throwaway repo (`npm run test:scripts`, which also runs shellcheck). |
| `scripts/check-public-safety.mjs` | Blocks AWS identifiers, email addresses and credentials from this public repo (pre-commit hook and CI). |
| `scripts/check-region-strings.mjs` | Blocks AWS region names in `infra/`, `backend/` and `src/` outside `infra/lib/config.ts` (ADR 0010; pre-commit hook and CI). |
| `scripts/export-beads.mjs` | Writes the beads backlog export without owner emails (`npm run beads:export`). |
| `tests/` | Playwright end-to-end tests, run against an in-memory mock of the claude.ai runtime (`tests/mock-claude.js`). |
| `infra/` | The AWS CDK app (TypeScript) for the SaaS version. Its own npm package; see [Infrastructure](#infrastructure). |
| `backend/` | Lambda code for the SaaS version (TypeScript). `backend/src/data` is the data-access module, the only code that talks to DynamoDB. `backend/src/observability` is logging and business metrics. Its own npm package; see [Backend](#backend). |
| `docs/adr/` | Architecture decision records for the AWS subscription product. |
| `docs/architecture/` | Architecture overview and diagrams (Mermaid). |
| `docs/journeys.md` | The customer journeys the product must never break, the tests that cover them, and the production alarms for when one is blocked. |
| `.beads/` | The [beads](https://github.com/steveyegge/beads) backlog. `issues.jsonl` is an export; run `bd ready` to see what's next. |

## Development

Requires Node 22 or newer.

```bash
npm ci
npx playwright install chromium webkit firefox
npm run check
```

Microsoft Edge is a system install rather than one of Playwright's own browsers. `npx playwright install msedge` installs it (it asks for admin rights). The Edge tests run whenever Edge is installed, and always in CI.

`npm run dev` serves `src/` with Vite's dev server at http://localhost:5173, against the same in-memory runtime the tests use, with demo sheets, inventory and a receipt, so it can be tried in a browser without publishing to claude.ai. Add `?seed=empty`, `?viewer`, `?nouser`, or `?mock={...}` with any `tests/mock-claude.js` option. Data resets on reload, and the page reloads when a file in `src/` changes.

### Builds

| Command | Output | For |
| --- | --- | --- |
| `npm run build:artifact` | `dist/artifact/index.html` | claude.ai. One self-contained file with the script and styles inlined. Like the hand-written `index.html` it replaces, it's a page fragment (claude.ai adds the doctype, `<head>` and `<body>`), and it only loads fonts from Google Fonts and ZXing from cdn.jsdelivr.net. It isn't minified, so it can be read before publishing. |
| `npm run build:web` | `dist/web/` | CloudFront. `index.html` plus minified, content-hashed files in `assets/`, which can be cached forever. |

`npm run build` runs both. Each writes hidden source maps (`dist/artifact/app.js.map`, `dist/web/assets/*.js.map`) with no `sourceMappingURL` comment in the code; the coverage run uses them.

`npm run lint` runs ESLint on `src/`, the scripts and the tests, then builds both and validates their HTML. `npm run check` also runs the public-safety check below and every test suite against both builds.

Run `npm run hooks:install` once per clone. It installs a pre-commit hook (`scripts/git-hooks/pre-commit`) that blocks commits containing AWS account or SSO identifiers, personal email addresses, or credentials, because this repository is public, and commits that name an AWS region outside `infra/lib/config.ts`.

## Infrastructure

`infra/` is the AWS CDK v2 app for the subscription product ([ADR 0002](docs/adr/0002-serverless-aws-with-cdk.md)). It is a separate npm package with its own lockfile, so run its commands from `infra/` (or with `npm --prefix infra run …`).

```bash
cd infra
npm ci
npm run lint        # tsc type-check and ESLint
npm test            # vitest: config, stack layout, template snapshots, cdk-nag (every stack in each region)
npm run synth       # cdk synth; cdk-nag AwsSolutions fails it on any finding
npm run synth:all-regions  # the same for every approved region (-c regions=all)
npm run test:update # accept template snapshot changes after reviewing them
```

**Stacks.** Every stack is named `supply-checkout-<env>-<region>-<component>`. Each region in the environment gets `data` (stateful: table, keys, buckets), `api` and `realtime` (stateless), and `observability`. The primary region also gets `identity` (stateful: Cognito) and `web` (CloudFront and WAF). Stateful stacks have termination protection. Every stack writes `/supply-checkout/<env>/<component>/stack` to SSM Parameter Store, and later stacks publish their outputs beside it. All resources are tagged `app=supply-checkout`.

**Regions.** The MVP runs in **us-east-1 only**. Every stack takes its region as a parameter, and the tests and CI also synthesize us-west-2 (`synth:all-regions`), so turning on the second region from [ADR 0010](docs/adr/0010-multi-region-active-active.md) is a config change: add it to `DEFAULT_REGIONS` in `lib/config.ts`. CDK is already bootstrapped in us-west-2. `lib/config.ts` is the only file in `infra/`, `backend/` or `src/` that may name a region: it holds `APPROVED_REGIONS`, `DEFAULT_REGIONS` and `GLOBAL_SERVICES_REGION` (where AWS requires CloudFront's certificate and WAF, and where Cognito lives). Stacks get their region as a parameter, Lambdas read `AWS_REGION`, and tests import the constants. `npm run check:regions` (in CI and the pre-commit hook) enforces this.

**Parameters.** The environment and regions are CDK context (`cdk.json` sets `envName=prod`; `regions` defaults to `DEFAULT_REGIONS` and `primaryRegion` to the first of them); override them with `-c envName=staging -c regions=all` (or a comma-separated list, with `-c primaryRegion=...`). Only the regions in `APPROVED_REGIONS` (`lib/config.ts`) are allowed. The account ID is never committed: it comes from the AWS profile at synth time, and a synth without credentials (CI, tests) is account-agnostic.

**The `app` table.** The primary region's `data` stack holds the single DynamoDB table from [ADR 0005](docs/adr/0005-multi-tenant-dynamodb.md), `supply-checkout-<env>-app`. It's a `TableV2` (`AWS::DynamoDB::GlobalTable`) with one replica, in its own region: on-demand, encrypted with a customer-managed KMS key that rotates yearly, point-in-time recovery, deletion protection, a stream with new and old images, TTL on `expiresAt`, and one index, `GSI1`. Adding the us-west-2 replica in phase 2 is another entry in `replicas` with that region's key, not a new table. The data stack publishes `table-name`, `table-arn`, `table-stream-arn` and `table-key-arn` to SSM under `/supply-checkout/<env>/data/`. The key and index names come from `backend/src/data/schema.ts`, so the table and the code that reads it can't drift apart.

**Observability** (`lib/observability/`). Each region's `observability` stack has two SNS topics, `supply-checkout-<env>-alarms-p1` (email and SMS) and `-p2` (email), encrypted with a rotating KMS key, and the alarms from [docs/journeys.md](docs/journeys.md) whose metrics exist ("Which alarms exist"). The primary region's stack also has the `supply-checkout-<env>` CloudWatch dashboard: traffic, errors, latency and every business metric, one line per region. An aspect (`lib/observability/defaults.ts`) gives every Lambda function X-Ray active tracing, JSON logs and the metrics namespace, and every log group a **one-year retention** unless it sets its own. One year is a placeholder until the information security policy (`supply-checkout-4p1`) sets it. Metric names come from `backend/src/observability/names.ts`, so the dashboard, the alarms and the code that sends the metrics can't drift apart.

**cdk-nag.** `AwsSolutionsChecks` is registered as a CDK validation plugin, so every synth and deploy fails on an unacknowledged finding. When a finding is intended, acknowledge it on the narrowest construct with a written reason:

```ts
Validations.of(bucket).acknowledge({ id: "AwsSolutions-S1", reason: "…why this is safe…" });
```

**Deploying** (until the pipeline in [ADR 0012](docs/adr/0012-cicd-releases-rollbacks.md) takes over):

```bash
aws sso login --profile supply-prod
cd infra
npx cdk bootstrap --profile supply-prod        # once per account and region; bootstraps every region in the app
npx cdk diff --profile supply-prod
npx cdk deploy --all --profile supply-prod
```

**Alarm recipients.** The addresses and phone numbers aren't in this repository. Each one is an SSM parameter in the account, in every region with an `observability` stack (today, us-east-1), which CloudFormation reads at deploy time: `/supply-checkout/<env>/alarms/email-<n>` and `/supply-checkout/<env>/alarms/sms-<n>`, numbered from 1. Email recipients get P1 and P2 alarms; SMS recipients get P1 only. By default there is one of each; for more, pass `-c alarmContacts='{"email":2,"sms":2}'` (or set `alarmContacts` in `cdk.json`: it holds counts, nothing personal). Create the parameters before the first deploy of the stack, or the deploy fails:

```bash
aws ssm put-parameter --profile supply-prod --region us-east-1 --type String \
  --name /supply-checkout/prod/alarms/email-1 --value 'you@example.com'
aws ssm put-parameter --profile supply-prod --region us-east-1 --type String \
  --name /supply-checkout/prod/alarms/sms-1 --value '+15555550100'   # E.164
```

They must be `String`, not `SecureString`: CloudFormation can't resolve a `SecureString` into a subscription. To change a recipient, overwrite the parameter (`--overwrite`) and redeploy the observability stack.

After deploying, confirm each email subscription from the message AWS sends. SMS needs a new account out of the way first: in the SNS console, **Text messaging (SMS)**, add and verify each number under **Sandbox destination phone numbers**, and check the monthly SMS spending limit. Sending to US numbers can also need an origination identity (a toll-free number registered in AWS End User Messaging SMS, which takes days to approve); if the test text doesn't arrive, that's the likely cause. Then page yourself with any P1 alarm; it goes back to OK (and says so) on its next evaluation:

```bash
aws cloudwatch set-alarm-state --profile supply-prod --region us-east-1 \
  --alarm-name supply-checkout-prod-p1-checkout-broken \
  --state-value ALARM --state-reason "Testing the P1 page"
```

## Backend

`backend/` holds the Lambda code (ADR 0002, 0006). It is a separate npm package with its own lockfile. `backend/src/observability` gives every handler structured JSON logs and business metrics ([Powertools for AWS Lambda](https://docs.powertools.aws.dev/lambda/typescript/)): `createObservability()` returns a `logger` and `count(metric, n, metadata)`, and `withObservability(obs, handler)` adds the request ID to every log line and flushes metrics after each invocation. Metrics go out as CloudWatch embedded metric format in namespace `SupplyCheckout`, with `Region` as their only dimension; per-team detail goes in metadata, never a dimension.

So far it also has the data-access module, `backend/src/data`:

- **Team-scoped access.** Every read and write of a team's data takes a `TeamContext`. Every function that can issue one lives in `src/data/team-context.ts`, and the issuer itself isn't exported. `authorizeTeam(db, userId, teamId)` checks the MEMBER item; the authorizer calls it with the user ID from the verified token. `createTeam`, `acceptInvite` and `teamContextForStripeCustomer` issue a context for the new owner, the new member and the billing webhook. Each function checks the role (viewer, contributor, owner, system) before it writes. The `Db` handle from `createDb` is opaque: it exposes no DynamoDB client.
- **At least one owner.** The team item keeps an `owners` count. Every change to an owner membership updates it in the same transaction, and a decrease is conditioned on `owners > 1`. Owner actions on other members also re-check the caller's own MEMBER item at write time.
- **One way in.** Outside `src/data`, ESLint (`backend/eslint.config.js`) bans any `@aws-sdk/*dynamodb*` package or path inside one, and any file under `data/` except `data/index.js`. This covers static imports, re-exports, `import()` and `require`. Tests are exempt, to inspect stored items.
- **Region-ready** ([ADR 0010](docs/adr/0010-multi-region-active-active.md)). Every team gets `homeRegion` when it's created, from `AWS_REGION`. `writeRegionFor` in `src/data/region.ts` is the one function that decides where a team's writes go; in the MVP it always returns the local region.
- **Keys.** As in ADR 0005, except sheets: `SHEET#<sheetId>` instead of `SHEET#<date>#<id>`, because the date is editable and a key can't change. Date order comes from `GSI1` (`TEAM#<teamId>#SHEETS`, `<date>#<sheetId>`), which one update can change. `GSI1` also finds invites by the SHA-256 hash of their token.

```bash
cd backend
npm ci
npm run lint        # tsc type-check and ESLint, including the DynamoDB ban
npm test            # vitest; the access-pattern tests need DynamoDB Local
```

The access-pattern tests run every entity in ADR 0005 against [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html), each test file in a fresh table. They're skipped unless `DYNAMODB_ENDPOINT` is set. To run them locally with Docker:

```bash
docker run --rm -d -p 8000:8000 amazon/dynamodb-local:3.0.0
DYNAMODB_ENDPOINT=http://localhost:8000 npm test
```

## Supported browsers

The current and previous major versions of Chrome, Edge, Firefox and Safari on desktop. The list is the `browserslist` field in `package.json`, and both builds compile their JavaScript and CSS for it (`build.target` in `vite.config.js`).

| Browser | Test project | Builds tested |
| --- | --- | --- |
| Chrome (desktop) | `desktop-chrome` | artifact, web |
| Safari (iPhone) | `iphone-safari` | artifact, web |
| Firefox (desktop) | `desktop-firefox` | web |
| Safari (desktop) | `desktop-safari` | web |
| Microsoft Edge (desktop) | `desktop-edge` | web |

The artifact build only runs on claude.ai, so it's tested in desktop Chrome and iPhone Safari; the web build is tested in every browser above.

## Tests

`npm test` runs these Playwright suites against an in-memory mock of the claude.ai runtime (`tests/mock-claude.js`), once for each build: the artifact build in desktop Chrome and an iPhone-sized Safari (WebKit), and the web build in every supported browser (above). `npm run test:artifact` and `npm run test:web` run one build; `BUILD=web npx playwright test …` does the same for a single file or test, and `--project=desktop-firefox` picks one browser. Each run builds the app first (`tests/global-setup.js`), so it always tests the current source.

### Running tests on a laptop

A full run starts a browser in every worker, and WebKit workers can each take over a gigabyte. Several at once, with other apps open, have used up a 16 GB laptop's memory and swap and frozen the screen. Two guards keep local runs in bounds:

- **Fewer workers.** Locally, Playwright uses one worker per 8 GB of RAM, and at most half the CPU cores (`localWorkers` in `playwright.config.js`). That's 2 on a 16 GB laptop. Pass `--workers=N` to change it for one run. CI uses Playwright's default.
- **One run at a time.** Each run takes a lock in the repo's shared `.git` directory (`tests/run-lock.js`), so a run started in another worktree waits and prints which run it's waiting for. A lock left by a run that was killed is taken over automatically. CI skips the lock.

While working on a change, run just the file and browser you're touching, e.g. `npx playwright test tests/sheets.spec.js --project=desktop-chrome`. Save `npm run check` for before you open a PR; CI runs every browser and build anyway.

| Suite | What it checks |
| --- | --- |
| `app.spec.js` | Core flows: sheets, checkout and return, storage counts, items without barcodes, receipt review, CSV export, view-only access |
| `a11y.spec.js` | axe-core WCAG 2.1 A/AA scan of every screen, in light and dark mode |
| `layout.spec.js` | No sideways scrolling at 320px and 390px phone widths |
| `resilience.spec.js` | Missing capabilities, failed receipt reads, full storage, lost write permission, and resuming an unsaved receipt |
| `sheets.spec.js` | Editing, filtering, reopening and deleting sheets; editing and removing lines; picking and returning items without barcodes |
| `inventory.spec.js` | Adding, editing and deleting items; storage counts and totals; view-only and disconnected states |
| `barcode.spec.js` | Reading barcode photos with the browser's detector or ZXing, at several sizes, and when the photo can't be read |
| `receipts.spec.js` | Receipt review: clients, existing sheets, name and price choices, barcodes, splitting, every save check, and partial save failures |
| `startup.spec.js` | Starting without the runtime or with capabilities declined, lost connections, download failures, and saved-draft problems |
| `failures.spec.js` | Every kind of save that can fail leaves the screen as it was |
| `legacy-data.spec.js` | Sheets and items missing fields that older versions didn't save |
| `concurrent.spec.js` | Someone else changing or deleting data while a form is open |

Every test also fails if the page throws an uncaught error or logs a console error.

### Coverage

`npm run test:coverage` runs the suites in desktop Chrome with code coverage on, once for each build. Coverage is mapped back to the files in `src/` through the builds' source maps. A run fails if lines, statements, functions or branches fall below **98%** (`THRESHOLD` in `tests/coverage.js`). CI runs this on every pull request.

When coverage is too low, `coverage/<build>/uncovered.txt` lists each gap by `src/` file and line: lines that never ran, lines that only partly ran, and branches that never ran. `coverage/<build>/index.html` is the full report; CI uploads each as the `coverage-report-artifact` and `coverage-report-web` artifacts. The web build is minified, so its statement count is smaller than the artifact's; lines, functions and branches come out close to the same.

The mock (`tests/mock-claude.js`) has opt-in failure modes, so tests can reach error paths: a missing runtime, declined capabilities, failed or path-specific writes, lost listeners, failed downloads, and a receipt read that waits to be cancelled. `window.__mock.notify()` fires live updates after a test changes `window.__mock.docs`, to act as another user.

## Contributing to main

`main` is protected. Every change goes through a pull request that is **squash-merged**, and the PR title becomes the commit message. Merging requires the **CI passed** check, and the branch must be up to date with `main`. Force pushes and branch deletion are blocked, and history stays linear.

Write PR titles in [Conventional Commits](https://www.conventionalcommits.org/) style. CI rejects titles that don't match.

- `fix: …` → patch release
- `feat: …` → minor release
- `feat!: …` → major release
- `docs:`, `test:`, `ci:`, `chore:`, `refactor:` → no release on their own

## CI

`.github/workflows/ci.yml` runs on every pull request, on pushes to `main`, and on release-please's pull request. The **CI passed** job succeeds only if every job below passes (or is skipped because it doesn't apply):

| Job | Gate |
| --- | --- |
| PR title | Conventional Commits format |
| Lint and validate HTML | ESLint on `src/`, scripts and tests; builds both and runs html-validate on each |
| Lint GitHub workflows | actionlint |
| No region names outside the config module | `scripts/check-region-strings.mjs`: fails on any AWS region name in `infra/`, `backend/` or `src/` outside `infra/lib/config.ts` (ADR 0010) |
| Shell scripts | shellcheck on `scripts/*.sh`, and the `land-pr.sh` tests against a fake `gh` |
| Secret scan | gitleaks on every commit in the history, and `scripts/check-public-safety.mjs` on every file (AWS account and SSO identifiers, email addresses, AWS and Stripe keys, private keys) |
| Dependency audit | `npm audit` fails on high-severity advisories; dependency review fails a PR that adds a moderate-or-worse vulnerable package |
| CodeQL (javascript-typescript), CodeQL (actions) | CodeQL `security-extended` queries on the app, scripts, tests and workflows (`.github/workflows/codeql.yml`, which also runs weekly). Results go to the repository's code scanning alerts |
| Backend | Only when `backend/` or the CI workflow changes (always on `main`): `npm audit`, type-check and ESLint (with the DynamoDB ban), and the data-access tests against DynamoDB Local, which runs as a service container |
| Infra | Only when `infra/`, `backend/` or the CI workflow changes (always on `main`): `npm audit`, type-check and ESLint, the CDK unit and snapshot tests, and a synth with cdk-nag for the deployed region and for both regions; the tests also synth every stack, identity and web included, in each region on its own |
| Tests (browser, artifact or web build) | All test suites, in seven parallel jobs: desktop Chrome and iPhone Safari against each build, and desktop Firefox, Safari and Edge against the web build. Desktop Chrome also fails below 98% code coverage and posts a coverage table to the job summary. A test that only passes on its retry fails the run. A failure uploads the Playwright report and traces as a workflow artifact |

## Releases

`.github/workflows/release.yml` uses [release-please](https://github.com/googleapis/release-please). It keeps a release pull request open with the next version number and changelog, and starts CI on it (pull requests opened by GitHub Actions don't start CI on their own). Merging that PR tags the version, re-runs the full CI suite, then builds the artifact from the tag and attaches it to the GitHub Release as `index.html`, along with an SPDX JSON SBOM (`supply-checkout-<tag>.spdx.json`).

Dependabot opens weekly update PRs for npm packages and GitHub Actions.

## Publishing to claude.ai

Publishing the artifact is a manual step, because claude.ai artifacts are published from a Claude session rather than from CI. After a release, download `index.html` from the GitHub Release (or run `npm run build:artifact` on the release tag), and ask Claude to republish that file to the existing artifact URL above. Publish `dist/artifact/index.html`, never `src/index.html`: the source page loads its script and styles as separate files, which an artifact can't serve. Publishing to the same URL keeps all saved sheets and inventory.
