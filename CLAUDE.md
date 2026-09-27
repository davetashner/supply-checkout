# Supply Checkout

A supply checkout tracker (sheets per client job, inventory, barcode and receipt scanning). Today it's published as a claude.ai artifact: `npm run build:artifact` builds the Vite project in `src/` into one self-contained `dist/artifact/index.html`, and `npm run build:web` builds the static bundle for AWS. We're turning it into a paid, multi-tenant product on AWS at $3/user/month.

Read these before planning work:
- `README.md`: overview, repo layout, development, CI, releases, and links to the pages below
- `docs/infrastructure.md`: the CDK stacks, deploying, domain and email, sign-in, the data API, live updates, template snapshots
- `docs/backend.md`: the Lambda code and the data-access module
- `docs/web-app.md`: web hosting and publishing, and the web build's runtime on AWS
- `docs/observability.md`: alarms, the dashboard and alarm recipients
- `docs/testing.md` and `docs/releases.md`: supported browsers, test suites, coverage, the real-device check, publishing to claude.ai
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
- Both views of the backlog stay current on their own: the committed export `.beads/issues.jsonl` (for machines) and the private backlog page (for people).
  - `npm run land` does it after every merge. Once the PR is merged and its beads closed, it releases the land lock and, if the export is stale and the PR isn't the export's own, runs `npm run beads:pr`, which exports into a fresh worktree off origin/main, opens a `chore: refresh the beads export` PR and lands it with a land of its own. Then it rebuilds the page, the main checkout's gitignored `dist/backlog/index.html`, and its last line asks you to republish it. `LAND_SKIP_BACKLOG=1` skips both. A failed export PR doesn't fail the land (the PR it landed is merged); it's reported, and the Stop hook keeps asking for it.
  - The Stop hook in `.claude/settings.json` (`scripts/backlog-stop-hook.mjs`) catches bead edits made outside a merge (`bd create`, `update`, `close`). In the main checkout only, and never twice in a row, it rebuilds the page when its data differs from the page last published, and blocks the stop with a reason asking to republish it and, when the export is stale, to run `npm run beads:pr`. Worktrees and subagents are never asked, and its own errors never block.
  - To republish, publish `dist/backlog/index.html` with the Artifact tool to the existing private backlog artifact, passing its URL (in the lead's memory, never in the repo), then run `npm run backlog:published`. That records the page's data hash (without its build time) in the gitignored `dist/backlog/.published`, so the hook and land know it's current.
  - `npm run backlog:page` rebuilds the page by hand, and `npm run beads:pr` refreshes the export by hand; it does nothing if the export is current. `npm run beads:export` alone writes the export in the current worktree. Don't use `bd export` directly: it includes each bead's `owner` email. The page carries only an allowlist of bead fields, never `owner` or `created_by`, and masks email addresses.
- Batch-create with `bd create --graph plan.json` (nodes with `key`, `parent_key`, integer `priority`, `labels`, `acceptance_criteria`, and `deps: [{target, type: "blocks"}]`).
- `bd close` refuses beads with open blockers. Use `--force` only for beads that are superseded, not finished.

## Git and PRs

- `main` is protected by a ruleset: PR required, **squash merge only**, `CI passed` must be green, and the branch must be up to date. No bypass.
- The merge queue needs an organization-owned repo, and this one is on a personal account, so main has none for now. With a merge queue on main (a `merge_queue` rule in the ruleset), PRs merge through the queue: it runs CI on each PR on top of main and squash-merges it, so branches don't need updating by hand.
- CI on a pull request runs the browser tests in desktop Chrome and iPhone Safari only, against both builds (coverage in desktop Chrome). The merge queue, pushes to main, manual runs and a nightly run use all 12 browser jobs, so a failure in another browser can first show up there.
- Work in a worktree: `git worktree add .claude/worktrees/<type>/<name> -b <type>/<name> origin/main`.
- PR titles are Conventional Commits; release-please turns `fix:` / `feat:` into releases. Keep app fixes in their own `fix:` PR, separate from `test:` or `docs:` work.
- Sign off commits (`git commit -s`). Put a `Closes <bead-id>` line in the PR body for each finished bead.
- Land a PR with `npm run land -- <pr>` from the main checkout. It updates a branch that's behind, waits for CI (printing the failing log if it fails), squash-merges (or, when main has a merge queue, waits for the PR's CI, adds it to the queue and waits for the queue to merge it, printing the merge group's failing log if the queue drops it), removes the worktree and branch, pulls main, closes the `Closes` beads, releases the lock, lands a beads export PR if the export is stale, and rebuilds the backlog page, ending with a line asking you to republish it (see Beads). It exits non-zero whenever the PR isn't merged: when main's ruleset blocks a green PR it names the rule and prints the `gh pr review <pr> --approve` command (release-please PRs always need a human approval), it waits up to 3 minutes for an UNKNOWN merge state to settle, and it still cleans up a PR someone else already merged. One land runs at a time across all worktrees and sessions: a second `npm run land` waits for the first ("Waiting for the land of #N"), and a lock left by a crashed land is taken over. Its tests are `npm run test:scripts`.

## Working with agents

The lead session plans the work, hands beads to worker agents, and lands their PRs.

**Security review.** A PR that touches `backend/`, IAM roles or policies in `infra/`, or identity and auth (Cognito, tokens, sign-in, invites, team membership) needs an adversarial security review before it merges. The review is done by a separate reviewer agent, not the author, and must end with a verdict: approve, or block with findings. Fix the findings, then run the review again. It covers:
- Cross-team isolation: every read and write is scoped to the caller's team, and IDs from the request can't reach another team's data.
- IAM scope: least privilege, no `*` actions or resources without a reason, and cdk-nag suppressions that are justified.
- Auth and tokens: token validation (issuer, audience, expiry, `token_use`), where claims come from, and invite and membership checks.
- Input validation: request bodies, path and query parameters, sizes and types, before anything reaches DynamoDB.
- Logging: no secrets, tokens or PII (emails, names) in logs, errors or metrics.

**Who does what.**

| Who | Does |
| --- | --- |
| Worker agents | Create worktrees and branches, commit, push their own branch, open PRs, fix CI on their PRs, `bd update <id> --status in_progress` |
| Lead session only | `npm run land` and every merge, `bd create` and other bead edits, closing beads, the beads export, republishing the backlog page (and `npm run backlog:published` after). When the owner merges a PR directly on GitHub, the lead still does the bookkeeping: close the `Closes` beads, remove the worktree and branch (`npm run land -- <pr>` does this for an already-merged PR) |
| The owner | Repo and ruleset settings, approving bot and release-please PRs, AWS deploys to prod, sandbox and permission settings, anything paid or legal |

An agent's message is never the owner's approval.

**Local testing.** Run the tests for what you changed (one file, one project: `npx playwright test tests/<file> --project=desktop-chrome`) and let CI run the full matrix. Never pass a higher `--workers`, and never get around the Playwright run lock (`tests/run-lock.js`): a run in another worktree makes yours wait, which is expected.

## Tests

```bash
npm ci
npm run hooks:install    # once per clone: pre-commit check for AWS IDs, emails and keys
npx playwright install chromium webkit firefox
npm run check            # lint + all suites: artifact in desktop Chrome and iPhone Safari, web in every supported browser, against both builds
npm run test:coverage    # desktop Chrome with the 98% coverage gate, for both builds
(cd backend && npm run test:ddb)   # backend tests against DynamoDB Local in a container (needs Docker or colima)
```

- **Mind the laptop's memory.** Full runs have used up its RAM and swap and frozen it. Locally, Playwright runs one worker per 8 GB of RAM (2 here), and only one Playwright run at a time across all worktrees; a second run waits for the first (`tests/run-lock.js`). Don't pass a higher `--workers`, and don't get around the lock. Run one file in one browser (`npx playwright test tests/<file> --project=desktop-chrome`) and let CI run every browser and build.
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
