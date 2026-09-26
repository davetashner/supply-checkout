# Supply Checkout

A shared supply tracker for taking supplies from storage to client jobs and bringing back what wasn't used.

- **Sheets** – one per client and date, recording who prepared it. Scan a barcode (or pick an item without one) to check supplies out, scan again on return to record what came back unused, then tap **Finished Return**. Each sheet totals what was used and what to charge, and downloads as CSV.
- **Inventory** – items, prices and how many are in storage. Checkouts subtract from storage; returns add back.
- **Receipts** – photograph a store receipt and Claude reads the line items and prices, suggests matches against existing inventory, and lets you assign each item to a client's sheet or to general inventory before anything is saved.

The app runs as a [Claude artifact](https://claude.ai/artifact/LcSb29dTE99AK4N6iuVFrj). claude.ai provides the shared database, sign-in, file downloads and receipt reading through `window.claude`; there is no server to run.

## Repository layout

| Path | What it is |
| --- | --- |
| `index.html` | The whole app. This file is what gets published to claude.ai. |
| `scripts/page.mjs` | Wraps `index.html` in the same document skeleton claude.ai adds at publish time. |
| `scripts/validate-html.mjs` | HTML validation (html-validate). |
| `tests/` | Playwright end-to-end tests, run against an in-memory mock of the claude.ai runtime (`tests/mock-claude.js`). |
| `docs/adr/` | Architecture decision records for the AWS subscription product. |
| `docs/architecture/` | Architecture overview and diagrams (Mermaid). |
| `docs/journeys.md` | The customer journeys the product must never break, the tests that cover them, and the production alarms for when one is blocked. |
| `.beads/` | The [beads](https://github.com/steveyegge/beads) backlog. `issues.jsonl` is an export; run `bd ready` to see what's next. |

## Development

Requires Node 22 or newer.

```bash
npm ci
npx playwright install chromium webkit
npm run check
```

`npm run lint` runs ESLint on the app's inline script and the tests, then validates the HTML. `npm run check` also runs the public-safety check below and every test suite.

Run `npm run hooks:install` once per clone. It installs a pre-commit hook (`scripts/git-hooks/pre-commit`) that blocks commits containing AWS account or SSO identifiers, personal email addresses, or credentials, because this repository is public.

## Tests

`npm test` runs these Playwright suites in desktop Chrome and an iPhone-sized Safari (WebKit), against an in-memory mock of the claude.ai runtime (`tests/mock-claude.js`):

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

`npm run test:coverage` runs the suites in desktop Chrome with code coverage on. The run fails if lines, statements, functions or branches of the app's script fall below **98%** (`THRESHOLD` in `tests/coverage.js`). CI runs this on every pull request.

When coverage is too low, `coverage/uncovered.txt` lists each gap by its line in `index.html`: lines that never ran, lines that only partly ran, and branches that never ran. `coverage/index.html` is the full report; CI uploads the `coverage/` folder as the `coverage-report` artifact.

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
| Lint and validate HTML | ESLint on the app script and tests, html-validate on the markup |
| Lint GitHub workflows | actionlint |
| Secret scan | gitleaks on every commit in the history, and `scripts/check-public-safety.mjs` on every file (AWS account and SSO identifiers, email addresses, AWS and Stripe keys, private keys) |
| Dependency audit | `npm audit` fails on high-severity advisories; dependency review fails a PR that adds a moderate-or-worse vulnerable package |
| Tests (desktop-chrome), Tests (iphone-safari) | All test suites, in parallel. Desktop Chrome also fails below 98% code coverage and posts a coverage table to the job summary. A test that only passes on its retry fails the run. A failure uploads the Playwright report and traces as a workflow artifact |

## Releases

`.github/workflows/release.yml` uses [release-please](https://github.com/googleapis/release-please). It keeps a release pull request open with the next version number and changelog, and starts CI on it (pull requests opened by GitHub Actions don't start CI on their own). Merging that PR tags the version, re-runs the full CI suite, and attaches `index.html` to the GitHub Release.

Dependabot opens weekly update PRs for npm packages and GitHub Actions.

## Publishing to claude.ai

Publishing the artifact is a manual step, because claude.ai artifacts are published from a Claude session rather than from CI. After a release, ask Claude to republish `index.html` from this repo to the existing artifact URL above. Publishing to the same URL keeps all saved sheets and inventory.
