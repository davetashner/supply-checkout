# Supply Checkout

A supply checkout tracker (sheets per client job, inventory, barcode and receipt scanning). Today it's published as a claude.ai artifact: `npm run build:artifact` builds the Vite project in `src/` into one self-contained `dist/artifact/index.html`, and `npm run build:web` builds the static bundle for AWS. We're turning it into a paid, multi-tenant product on AWS at $3/user/month.

Read these before planning work:
- `README.md`: repo layout, development, tests, CI, releases
- `docs/adr/`: architecture decisions (0010 is Accepted; the rest of 0002–0013 are still **Proposed** until bead `supply-checkout-y94` is done)
- `docs/architecture/README.md`: the AWS design and diagrams
- `docs/journeys.md`: customer journeys that must never break, their tests, and production alarms

Decisions already made: Stripe web billing only, with no App Store or Play in-app purchase (ADR 0013). The MVP runs in us-east-1 only and is region-ready for us-west-2, which is phase 2 (ADR 0010, accepted). The core journey canary runs 8am–8pm Eastern only.

## Starting a session

```bash
bd prime                 # beads workflow context
bd ready                 # unblocked work, highest priority first
bd list --status in_progress
git status && git worktree list && gh pr list
```

Beads are labeled `mvp` or `phase-2` (native mobile apps, full active-active failover). The `MVP live in AWS` milestone bead depends on every `mvp` bead.

## Beads

- The database is a local Dolt database in the **main checkout's** `.beads/` (gitignored). `bd` finds it from any worktree. `.beads/issues.jsonl` is only an export, not a sync mechanism.
- After changing beads, refresh the export in the same PR (or a `chore:` PR) with `npm run beads:export`. Don't use `bd export` directly: it includes each bead's `owner` email.
- Batch-create with `bd create --graph plan.json` (nodes with `key`, `parent_key`, integer `priority`, `labels`, `acceptance_criteria`, and `deps: [{target, type: "blocks"}]`).
- `bd close` refuses beads with open blockers. Use `--force` only for beads that are superseded, not finished.

## Git and PRs

- `main` is protected by a ruleset: PR required, **squash merge only**, `CI passed` must be green, and the branch must be up to date. No bypass.
- Work in a worktree: `git worktree add .claude/worktrees/<type>/<name> -b <type>/<name> origin/main`.
- PR titles are Conventional Commits; release-please turns `fix:` / `feat:` into releases. Keep app fixes in their own `fix:` PR, separate from `test:` or `docs:` work.
- Sign off commits (`git commit -s`). Put a `Closes <bead-id>` line in the PR body for each finished bead.
- Land a PR with `npm run land -- <pr>` from the main checkout. It updates a branch that's behind, waits for CI (printing the failing log if it fails), squash-merges, removes the worktree and branch, pulls main, closes the `Closes` beads, and says whether the beads export is stale. It exits non-zero whenever the PR isn't merged: when main's ruleset blocks a green PR it names the rule and prints the `gh pr review <pr> --approve` command (release-please PRs always need a human approval), it waits up to 3 minutes for an UNKNOWN merge state to settle, and it still cleans up a PR someone else already merged. Its tests are `npm run test:scripts`.

## Tests

```bash
npm ci
npm run hooks:install    # once per clone: pre-commit check for AWS IDs, emails and keys
npx playwright install chromium webkit firefox
npm run check            # lint + all suites: artifact in desktop Chrome and iPhone Safari, web in every supported browser, against both builds
npm run test:coverage    # desktop Chrome with the 98% coverage gate, for both builds
```

- **Mind the laptop's memory.** Full runs have used up its RAM and swap and frozen it. Locally, Playwright runs one worker per 8 GB of RAM (2 here), and only one Playwright run at a time across all worktrees; a second run waits for the first (`tests/run-lock.js`). Don't pass a higher `--workers`, and don't get around the lock. While iterating, run one file in one browser (`npx playwright test tests/<file> --project=desktop-chrome`). Run `npm run check` once, before opening the PR.
- Playwright builds the app before each run. `BUILD=artifact` (the default) or `BUILD=web` picks which build the tests load.
- `npm run build:demo` builds `dist/demo/`, the labeled demo for supplycheckout.com (entry and data in `demo/`, outside `src/`). `BUILD=web` runs also build it and run `tests/demo.spec.js`.
- CI fails if lines, statements, functions or branches of `src/` drop below 98%, in either build. When it does, `coverage/<build>/uncovered.txt` lists every gap by `src/` file and line. Branch coverage has little headroom, so new code needs tests that take both sides of each condition.
- Tests run against `tests/mock-claude.js`. It has opt-in failure modes (see the options at its top), and `window.__mock.notify()` acts as another user after a test edits `window.__mock.docs`.
- Before interacting, wait until the page has connected: the "Connecting…" notice clears once both collections have loaded, and the page redraws. See `openEcho` in `tests/sheets.spec.js`.
- Load the page once per test. Coverage from before a navigation or reload is lost.
- Every test fails on an uncaught page error or console error.
- To see the app, run `npm run dev` (Vite dev server at http://localhost:5173, demo data, mock runtime). Query options are listed at the top of `scripts/dev-server.mjs`. `tests/dev-server.spec.js` keeps it working.

## AWS

- The account is `supply-checkout-prod`, in the user's existing AWS Organization. Profiles in `~/.aws/config` use sso-session `supply-checkout`: `supply-prod` (workloads, Route 53) and `supply-mgmt` (the organization's management account). Log in with `aws sso login --profile supply-prod`.
- `aws configure sso` needs a real terminal and fails under `!`. Write profiles directly instead.
- `supplycheckout.com` is registered at Namecheap and delegated to a Route 53 hosted zone in `supply-checkout-prod`.
- **This repo is public.** Keep account IDs, SSO URLs and email addresses out of committed files, including bead text (the export is committed). `scripts/check-public-safety.mjs` enforces this in the pre-commit hook and in CI, and gitleaks scans every commit for credentials.
