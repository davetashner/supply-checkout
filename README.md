# Supply Checkout

A shared supply tracker for taking supplies from storage to client jobs and bringing back what wasn't used.

- **Sheets** – one per client and date, recording who prepared it. Scan a barcode (or pick an item without one) to check supplies out, scan again on return to record what came back unused, then tap **Finished Return**. Each sheet totals what was used and what to charge, and downloads as CSV. Owners can export every sheet and the inventory at once, as CSV or JSON (**Export data**). A team moving from the artifact to the web app sends us the JSON file ([Moving to the web app](docs/moving-to-the-web-app.md)).
- **Inventory** – items, prices and how many are in storage. Checkouts subtract from storage; returns add back.
- **Receipts** – photograph a store receipt and Claude reads the line items and prices, suggests matches against existing inventory, and lets you assign each item to a client's sheet or to general inventory before anything is saved.

The app is a static web page on AWS, with sign-in, a shared database, file downloads and receipt reading behind a small runtime interface (`window.claude`, [ADR 0004](docs/adr/0004-runtime-adapter.md)). It started as a claude.ai artifact; that build and its publishing are retired.

The source is a small [Vite](https://vite.dev) project with no UI framework. One build of it is a static bundle for the AWS version ([ADR 0004](docs/adr/0004-runtime-adapter.md)); another is a labeled demo of that bundle for supplycheckout.com, which runs entirely in the browser until sign-in and the API exist.

## Repository layout

| Path | What it is |
| --- | --- |
| `src/index.html` | The page: head (fonts) and markup. |
| `src/styles.css` | All of the app's styles. |
| `src/icons/` | The barcode favicon: `favicon.svg` (the source, drawn on a 16 px grid so it stays crisp at 16 and 32 px, with dark-mode colors), and its PNG fallbacks `favicon-32.png` and `apple-touch-icon.png` (180 px), which `npm run icons` renders from the SVG. The web build and demo serve all three from `assets/`; the artifact inlines only the SVG, as a `data:` URI. |
| `src/main.js` | App state, screens, modals, receipt review, and startup. |
| `src/runtime.js` | `use()`, the one place the app reaches its runtime (`window.claude`). |
| `src/aws/` | The web build's runtime ([ADR 0004](docs/adr/0004-runtime-adapter.md)): `window.claude` on the AWS backend. `main.js` loads `config.json` and installs it; `session.js` is sign-in (Managed Login, PKCE, tokens in memory); `account.js` is first sign-in, invites, the team bar and the `user` and `downloads` capabilities; `db.js` maps the app's `db` calls onto the data API; `live.js` is live updates over AppSync Events, with the polling fallback. See [The web app on AWS](docs/web-app.md#the-web-app-on-aws). |
| `src/moves.js` | Checkout and return writes, in one place so the web build can switch to atomic commands (`supply-checkout-1dg.1`). |
| `src/format.js`, `src/sheet-math.js` | Formatting helpers and sheet totals, with no app state. |
| `src/dom.js` | `$`, toast, modals, two-tap confirm buttons and number steppers. |
| `src/barcode.js` | Reading barcodes from photos (the browser's detector, or ZXing, loaded the first time it's needed). |
| `src/zxing.js` | The parts of ZXing (`@zxing/library`, from npm) the barcode reader uses. |
| `src/receipt-prompt.js` | The receipt-reading prompt and its error messages. |
| `vite.config.js` | The builds: `web`, `demo`, `ops` and `site` (below). |
| `demo/` | The demo build's entry (`main.js`: the in-memory runtime and the banner's styles) and the demo data (`data.js`), which `npm run dev` also uses. |
| `site/` | The marketing home page for the apex (`npm run build:site`, [the web app](docs/web-app.md#the-web-app)): its clips (`site/clips/`, recorded by `npm run journeys:video -- --marketing`), styles and one small script. |
| `ops/` | The operator page for `ops.<env domain>` (`npm run build:ops`, ADR 0015 §9): sign-in through the operator pool, teams, comps and the operator audit, with no customer app code. Unit tests: `ops/test/` (`npm run test:ops`, 100% coverage of `ops/lib/`); browser tests: `tests/ops.spec.js`. See [The operator page](docs/infrastructure.md#the-operator-page) and the [runbook](docs/runbooks/operator-page.md). |
| `dist/` | Build output (not committed). |
| `scripts/builds.mjs` | Builds and serves the builds for the tests. |
| `scripts/validate-html.mjs` | HTML validation (html-validate). |
| `scripts/check-links.mjs` | Checks that every relative link in `README.md`, `CLAUDE.md` and `docs/` reaches an existing file and heading (`npm run lint`). |
| `scripts/dev-server.mjs` | Local dev server with the mock runtime (`npm run dev`). |
| `scripts/render-icons.mjs` | Renders the favicon's PNG fallbacks from `src/icons/favicon.svg` with Playwright's Chromium (`npm run icons`). Run it after changing the SVG, and commit the PNGs. |
| `scripts/land-pr.sh` | Waits for CI, squash-merges a PR (or adds it to the merge queue and waits for the queue to merge it), cleans up its worktree and branch, closes its beads, lands a beads export PR if the export is stale, and rebuilds the backlog page (`npm run land -- <pr>`; `LAND_SKIP_BACKLOG=1` skips the last two). Exits non-zero if the PR isn't merged, and explains a PR that main's ruleset blocks. One land runs at a time across every worktree and session: a second one waits for the first. |
| `scripts/deploy.sh` | Deploys from an up-to-date, clean main: `npm run deploy -- api` (the api, realtime and observability stacks; the kinds come from `scripts/deploy-stacks.mjs`, which the deploy workflow shares), `web` (the web stack, then checks the live router), `app` (builds and publishes the web app to `app.`), or `all` (web, api, app). Signs in to AWS SSO if needed, installs dependencies, and shows each diff and asks before deploying it. Tests: `scripts/deploy.test.sh`. See [Deploying](docs/infrastructure.md#deploying). |
| `scripts/land-pr.test.sh` | Tests for `land-pr.sh` against a fake `gh` in a throwaway repo (`npm run test:scripts`, which also runs shellcheck). |
| `scripts/ops.mjs` | The operator CLI (`npm run ops`, ADR 0015): list and search teams, comp a team, read the operator audit, signed in to the operator pool with TOTP. Tests: `scripts/ops.test.mjs` (`npm run test:scripts`). See [Operators](docs/infrastructure.md#operators). |
| `scripts/operators.mjs` | The operator admin CLI (`npm run operators`): add, list, disable, enable, remove and reset operators in the operator pool with the AWS CLI, under an SSO administrator role. Passwords go to the AWS CLI in an owner-only request file removed right after the call (or, with `--send-email`, Cognito makes and emails them) and are printed once, to a terminal only; `--dry-run` prints the calls. The `operators` skill (`.claude/skills/operators/SKILL.md`) hands the owner the command. Tests: `scripts/operators.test.mjs` (`npm run test:scripts`). See [Operators](docs/infrastructure.md#operators). |
| `scripts/restore-drill.mjs` | The prod restore drill (`npm run restore-drill`, bead `supply-checkout-8x1`): restores the live table from point-in-time recovery into a new `-restore-` table with the same KMS key, times it, compares counts and spot-checks keys, then deletes it after asking. It only ever reads the live table, and it's a dry run without `--apply`. Tests: `scripts/restore-drill.test.mjs` (`npm run test:scripts`). See [Restore drill](docs/backups.md#the-prod-drill-script-the-owner-before-the-pilot). |
| `scripts/check-public-safety.mjs` | Blocks AWS identifiers, email addresses and credentials from this public repo (pre-commit hook and CI). |
| `scripts/check-stray-files.mjs` | Blocks merge and patch leftovers (`*.orig`, `*.rej`) from being committed (pre-commit hook and CI). Tests: `scripts/check-stray-files.test.mjs` (`npm run test:scripts`). |
| `scripts/check-region-strings.mjs` | Blocks AWS region names in `infra/`, `backend/` and `src/` outside `infra/lib/config.ts` (ADR 0010; pre-commit hook and CI). |
| `scripts/export-beads.mjs` | Writes the beads backlog export without owner emails (`npm run beads:export`). |
| `scripts/backlog-page.mjs` | Builds the backlog page (Upcoming and Completed tabs) from the beads database into the main checkout's `dist/backlog/index.html`, from the template `scripts/backlog-page.html`, with only an allowlist of bead fields and no emails (`npm run backlog:page`), with a hash of its data in `dist/backlog/.hash`. It's for people, opened locally from `dist/backlog/index.html`; it isn't published anywhere. Tests: `scripts/backlog-page.test.mjs` (`npm run test:scripts`). |
| `scripts/backlog-stop-hook.mjs` | The Claude Code Stop hook in `.claude/settings.json`: in the main checkout, silently rebuilds the backlog page when the beads changed since it was last built, and asks Claude to run `npm run beads:pr` when the export is stale. Tests: `scripts/backlog-stop-hook.test.mjs`. |
| `scripts/beads-pr.sh` | Refreshes the committed beads export through a `chore:` PR and lands it (`npm run beads:pr`); does nothing if the export is current, and lands an export PR that is already open instead of opening a second. `npm run land` runs it after a merge when the export is stale. |
| `tests/` | Playwright end-to-end tests, run against an in-memory mock of the runtime (`tests/mock-claude.js`), and the web build's runtime against a fake AWS backend (`tests/fake-aws.js`). |
| `infra/` | The AWS CDK app (TypeScript) for the SaaS version. Its own npm package; see [Infrastructure](docs/infrastructure.md). |
| `backend/` | Lambda code for the SaaS version (TypeScript). `backend/src/data` is the data-access module, the only code that talks to DynamoDB. `backend/src/api` is the HTTP API's handlers (data and sign-in sessions). `backend/src/observability` is logging and business metrics. Its own npm package; see [Backend](docs/backend.md). |
| `docs/api/openapi.yaml` | The HTTP API's OpenAPI description, including how the app's `db` calls map onto it. |
| `docs/adr/` | Architecture decision records for the AWS subscription product. |
| `docs/architecture/` | Architecture overview and diagrams (Mermaid). |
| `docs/*.md` | The pages linked under [Documentation](#documentation): infrastructure, backend, the web app, observability, testing and releases. |
| `docs/journeys.md` | The customer journeys the product must never break, the tests that cover them, and the production alarms for when one is blocked. |
| `journeys/registry.json` | The journeys' steps (J4.2 …), their status and their alarms, which `docs/journeys.md`'s table and step lists are generated from. `scripts/journeys.mjs` (`npm run journeys:trace`) ties them to the tagged tests; see [Journey tags](docs/testing.md#journey-tags-and-the-traceability-check). |
| `.beads/` | The [beads](https://github.com/steveyegge/beads) backlog. `issues.jsonl` is an export; run `bd ready` to see what's next. |

## Development

Requires Node 22 or newer.

```bash
npm ci
npx playwright install chromium webkit firefox
npm run check
```

Microsoft Edge is a system install rather than one of Playwright's own browsers. `npx playwright install msedge` installs it (it asks for admin rights). The Edge tests run whenever Edge is installed, and always in CI.

`npm run dev` serves `src/` with Vite's dev server at http://localhost:5173, against the same in-memory runtime the tests use, with demo sheets, inventory and a receipt, so it can be tried in a browser without signing in. Add `?seed=empty`, `?viewer`, `?nouser`, or `?mock={...}` with any `tests/mock-claude.js` option. Data resets on reload, and the page reloads when a file in `src/` changes.

### Builds

| Command | Output | For |
| --- | --- | --- |
| `npm run build:web` | `dist/web/` | CloudFront, at `app.`. `index.html` plus minified, content-hashed files in `assets/`, which can be cached forever. It runs the same app on the AWS backend through `src/aws/`, which reads `config.json` (written when publishing) to find the environment. |
| `npm run build:demo` | `dist/demo/` | supplycheckout.com/demo/. The web build with `demo/main.js` running first: the in-memory runtime from the tests with the `npm run dev` demo data, receipt reading that returns a canned receipt after a pause, and CSV downloads saved in the browser. A banner says it's a demo, that nothing is saved and that data resets on reload. It makes no requests except to its own files and Google Fonts. Asset URLs are relative (`./assets/…`), so the folder works from any path. |

`npm run build` runs them all. Each writes hidden source maps (`dist/web/assets/*.js.map`, `dist/demo/assets/*.js.map`) with no `sourceMappingURL` comment in the code; the coverage run uses them.

The demo's own code lives in `demo/`, outside `src/`, so the web build doesn't include it and it isn't counted in `src/`'s coverage. `npm run publish:demo` builds it and publishes it to supplycheckout.com ([Web hosting and releases](docs/web-app.md#web-hosting-and-releases)).

`npm run lint` runs ESLint on `src/`, `demo/`, the scripts and the tests, checks the Markdown links, then builds all three and validates their HTML. `npm run check` also runs the public-safety check below and every test suite against both builds.

Run `npm run hooks:install` once per clone. It installs a pre-commit hook (`scripts/git-hooks/pre-commit`) that blocks commits containing AWS account or SSO identifiers, personal email addresses, or credentials, because this repository is public, commits that add merge or patch leftovers (`*.orig`, `*.rej`), and commits that name an AWS region outside `infra/lib/config.ts`.

## AWS

The subscription product's AWS side is two npm packages, each with its own lockfile: `infra/` (the CDK app) and `backend/` (the Lambda code).

```bash
(cd infra && npm ci && npm run lint && npm test)       # type-check, ESLint, config, snapshot and cdk-nag tests
(cd backend && npm ci && npm run lint && npm test)     # the access-pattern tests need DynamoDB Local: npm run test:ddb
(cd infra && npm run test:update)                      # accept template snapshot changes after reviewing them
```

The stacks, deploying, the domain and email, sign-in, the data API and live updates are in [docs/infrastructure.md](docs/infrastructure.md); alarms and the dashboard in [docs/observability.md](docs/observability.md); the Lambda code and the data-access module in [docs/backend.md](docs/backend.md); web hosting, publishing and the web build's runtime in [docs/web-app.md](docs/web-app.md).

## Tests

`npm test` runs these Playwright suites against an in-memory mock of the runtime (`tests/mock-claude.js`) against the web build, in every browser and device project ([Supported browsers](docs/testing.md#supported-browsers)). `npm run test:web` is the same as `npm test` (the run also builds and tests the demo); `npx playwright test …` does the same for a single file or test, and `--project=desktop-firefox` picks one browser. Each run builds the app first (`tests/global-setup.js`), so it always tests the current source.

The suites, running them on a laptop without running out of memory, coverage, and the supported browsers and their test projects are in [docs/testing.md](docs/testing.md).

## Contributing to main

`main` is protected. Every change goes through a pull request that is **squash-merged**, and the PR title becomes the commit message. Merging requires the **CI passed** check, and the branch must be up to date with `main`. Force pushes and branch deletion are blocked, and history stays linear.

Without a merge queue, `npm run land -- <pr>` updates a branch that's behind, waits for CI and squash-merges it, one land at a time across every worktree and session: a lock in the shared `.git` directory makes a second land wait (printing `Waiting for the land of #N (pid P, started T)`), and a lock left by a land that's no longer running is taken over. Otherwise two lands at once keep pushing each other's PRs behind `main`.

GitHub's merge queue needs a repository owned by an organization; this one is on a personal account, so it has none yet. When the ruleset has a merge queue, pull requests merge through it: `npm run land -- <pr>` (or `gh pr merge <pr> --squash`) adds a PR whose CI passed to the queue, and the queue runs the full CI on the PR on top of `main`, and on top of any PRs ahead of it, before squash-merging it. A PR whose merge group fails CI leaves the queue unmerged. The queue keeps branches current, so they don't need updating by hand.

Write PR titles in [Conventional Commits](https://www.conventionalcommits.org/) style. CI rejects titles that don't match.

- `fix: …` → patch release
- `feat: …` → minor release
- `feat!: …` → major release
- `docs:`, `test:`, `ci:`, `chore:`, `refactor:` → no release on their own

## CI

`.github/workflows/ci.yml` runs on every pull request, on each merge queue group, on pushes to `main`, nightly, and on release-please's pull request. The **CI passed** job succeeds only if every job below passes (or is skipped because it doesn't apply). Pull requests run a smaller browser matrix; everything else runs all of it:

| Job | Gate |
| --- | --- |
| PR title | Conventional Commits format (pull requests only) |
| Lint and validate HTML | ESLint on `src/`, `demo/`, `ops/`, `site/`, scripts and tests; builds all five and runs html-validate on each; the operator page's unit tests with their coverage gate (`npm run test:ops`); then `npm run journeys:trace`, which fails if a built journey step has no test, a critical journey has no alarm, or `docs/journeys.md` doesn't match `journeys/registry.json` |
| Lint GitHub workflows | actionlint |
| No region names outside the config module | `scripts/check-region-strings.mjs`: fails on any AWS region name in `infra/`, `backend/` or `src/` outside `infra/lib/config.ts` (ADR 0010) |
| Shell scripts | shellcheck on `scripts/*.sh`, the `land-pr.sh` and `beads-pr.sh` tests against a fake `gh`, and the Node tests for `publish-web.mjs`, `ops.mjs`, `operators.mjs`, `restore-drill.mjs`, `check-stray-files.mjs`, `backlog-page.mjs`, `backlog-stop-hook.mjs` and `journeys.mjs` (`npm run test:scripts`) |
| Secret scan | gitleaks on commits: on a pull request, only the PR's own commits (base..head), so a flagged string on another branch doesn't fail every PR; on the merge queue, pushes to `main`, the nightly run and manual runs, every commit on every branch. Also `scripts/check-public-safety.mjs` on every file (AWS account and SSO identifiers, email addresses, AWS and Stripe keys, private keys), and `scripts/check-stray-files.mjs`, which fails on any tracked `*.orig` or `*.rej` file |
| Dependency audit | `npm audit` fails on high-severity advisories; dependency review fails a PR that adds a moderate-or-worse vulnerable package |
| CodeQL (javascript-typescript), CodeQL (actions) | CodeQL `security-extended` queries on the app, scripts, tests and workflows (`.github/workflows/codeql.yml`, which also runs weekly). Results go to the repository's code scanning alerts |
| Backend | Only when `backend/`, `docs/api/` or the CI workflow changes in the pull request or merge queue group (always on `main`, nightly and manual runs): `npm audit`, type-check and ESLint (with the DynamoDB ban), the handler and OpenAPI tests, and the data-access tests against DynamoDB Local, which runs as a service container |
| Infra | Only when `infra/`, `backend/`, `scripts/npm-audit*` or the CI workflow changes in the pull request or merge queue group (always on `main`, nightly and manual runs): `npm audit` through `scripts/npm-audit.mjs`, which fails on high or critical advisories except the narrow, expiring exceptions in `scripts/npm-audit-exceptions.json`, then type-check and ESLint, the CDK unit and snapshot tests (which skip Lambda bundling), and a synth with cdk-nag (which bundles the handlers with esbuild from `backend/`) for the deployed region and for both regions; the tests also synth every stack, identity and web included, in each region on its own |
| Tests (browser) | All test suites. On a pull request, two parallel jobs: desktop Chrome and iPhone Safari. On the merge queue, `main`, the nightly run (07:23 UTC) and manual runs, ten: those two plus desktop Firefox, Safari and Edge, Android Chrome (Pixel portrait and landscape, Galaxy) and iPad Safari (portrait and landscape) (all against the web build). The `Detect changed areas` job picks the matrix. The web jobs also test the demo build and the CloudFront Content-Security-Policy. Desktop Chrome also fails below 98% code coverage and posts a coverage table to the job summary. A test that only passes on its retry fails the run. A failure uploads the Playwright report and traces as a workflow artifact |

**Beads export only.** When a pull request, merge queue group or push to `main` changes `.beads/issues.jsonl` and nothing else (like the `chore: refresh the beads export` PRs from `npm run beads:pr`), only the PR title check, the secret scan, CodeQL and `Detect changed areas` run; every other job is skipped, and **CI passed** still succeeds. The export is public bead text, so gitleaks and `scripts/check-public-safety.mjs` still check it; nothing else reads it. CodeQL runs anyway because `main`'s ruleset has a code scanning rule: a pull request can't merge until it has CodeQL results for each language `main` has (`javascript-typescript` and `actions`), even when **CI passed** is green. The `Detect changed areas` job decides this (its `beads_only` output) by comparing with the pull request's base, the merge group's base on `main`, or the push's parent commit. A change that touches any other file, including this rule's own workflow, runs the usual jobs, and the nightly, manual and release runs always run everything.

**Every commit on `main` gets its own full run.** A new push to a pull request cancels that pull request's older run, but no other run is ever cancelled or replaced: each push to `main`, merge queue group, nightly, manual and release run has a concurrency group of its own. (GitHub keeps only one waiting run per group, so while `main` shared one, the beads export that `npm run land` pushes right after a feature commit replaced the feature commit's waiting run, and the feature commit never ran the full browser matrix.) To see how a landed commit did on every browser: `gh run list --workflow ci.yml --branch main --event push`.

## Releases

`.github/workflows/release.yml` uses [release-please](https://github.com/googleapis/release-please). It keeps a release pull request open with the next version number and changelog, and starts CI on it (pull requests opened by GitHub Actions don't start CI on their own). Merging that PR tags the version, re-runs the full CI suite, then attaches an SPDX JSON SBOM (`supply-checkout-<tag>.spdx.json`) and the [journey evidence pack](docs/releases.md#journey-evidence-pack): a report of each customer journey's steps and their tests, with one video per journey and the tests' traces, recorded against the test suite's fakes. Then it starts `.github/workflows/deploy.yml` for the tag, which plans (the diffs, after the owner's approval), then deploys the stateful stacks and the stateless stacks to prod, each behind an approval of its own ([Deploying a release](docs/releases.md#deploying-a-release)).

Before publishing a release, check scanning on real phones ([Real-device check](docs/releases.md#real-device-check)).

Dependabot opens weekly update PRs for npm packages and GitHub Actions.

## Documentation

| Page | What it covers |
| --- | --- |
| [docs/infrastructure.md](docs/infrastructure.md) | The CDK app: stacks, regions, parameters, the `app` table, cdk-nag, deploying, template snapshots, domain and email, sign-in, the data API and live updates |
| [docs/backups.md](docs/backups.md) | PITR, AWS Backup and the copy to a separate backup account, vault locks, S3 versioning, failed-backup alarms, the restore drill, deletion records and putting a restored table back into service |
| [docs/observability.md](docs/observability.md) | Alarm topics, the dashboard, log retention and alarm recipients |
| [docs/backend.md](docs/backend.md) | The Lambda code: logging and metrics, the data-access module, inventory commands, keys and its tests |
| [docs/web-app.md](docs/web-app.md) | Web hosting and releases on CloudFront, publishing, and the web build's runtime on AWS |
| [docs/testing.md](docs/testing.md) | Supported browsers, test suites, local runs and coverage |
| [docs/releases.md](docs/releases.md) | Deploying a release, and the real-device check |
| [docs/journeys.md](docs/journeys.md) | Customer journeys that must never break, their tests and alarms |
| [docs/moving-to-the-web-app.md](docs/moving-to-the-web-app.md) | For customers: moving from the old claude.ai artifact to the web app (export, what carries over, what happens to the artifact) |
| [docs/architecture/README.md](docs/architecture/README.md) | The AWS design and diagrams |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [docs/api/](docs/api/) | The HTTP API: OpenAPI description, inventory commands, onboarding and live updates |
