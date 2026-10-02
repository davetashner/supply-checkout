# Releases

How releases are cut is in the [README](../README.md#releases).

## Deploying a release

A release deploys to prod through `.github/workflows/deploy.yml` ([ADR 0012](adr/0012-cicd-releases-rollbacks.md), bead `supply-checkout-pbp.26`), after the owner approves it. From merge to prod:

1. **The release pull request.** release-please keeps `chore(main): release x.y.z` open. GitHub Actions opened it, so CI doesn't start on its own: the release workflow's `release-pr-checks` job starts CI on its branch after each update. It needs the owner's approval to merge, like every bot-opened pull request (`npm run land` prints the `gh pr review <pr> --approve` command).
2. **The release.** Merging it makes release-please tag `vX.Y.Z` and publish the GitHub Release. The release workflow re-runs the full CI suite on it (`checks`).
3. **The deploy starts.** Once `checks` passes, the release workflow's `deploy` job runs `gh workflow run deploy.yml --ref main -f tag=vX.Y.Z`. A release or tag that `GITHUB_TOKEN` creates triggers no workflows, but a dispatch does. That job has no AWS access.
4. **`release`** (no credentials) checks the run is on `main` (every job refuses any other ref: a run dispatched on a tag would use that tag's own copy of the workflow, which could leave these checks out) and checks the tag: it looks like `vX.Y.Z`, has a published GitHub Release, its commit is on `main`, and that commit has a successful `CI passed` check from GitHub Actions. Every commit on `main` gets its own CI run that nothing cancels ([CI](../README.md#ci)), so the release commit has one. Anything else stops the run before it asks for approval.
5. **`trust`** (no environment) asks AWS for the deploy role with this job's OIDC token, whose subject has no `production` environment, and passes only if AWS refuses with `Not authorized to perform sts:AssumeRoleWithWebIdentity`. It never prints the call's output if it succeeds; it fails the run instead, because the role's trust is too wide. It needs the repository secret `AWS_DEPLOY_ROLE_ARN` (below); without it, it warns and skips (a dry run fails instead).
6. **`deploy`** (in the `production` environment) **waits for the owner's approval**: Actions, the run, **Review deployments**, `production`, **Approve and deploy**. Then it checks out the commit `release` checked (not the tag name, so a moved tag can't swap it), installs dependencies before any credentials exist and without install scripts (`npm ci --ignore-scripts`; the real control is that only a reviewed, released commit on `main` gets this far), runs only the locked local `cdk` and `tsx`, never anything `npx` could fetch, signs in with the deploy role (`aws-actions/configure-aws-credentials`, with the role ARN a secret and the account ID masked in the log), checks it's the deploy role, reads whether the backup copy vault exists through CDK's read-only lookup role (`-c backupCopy=false` until it does, like `scripts/deploy.sh`), synthesizes once, posts `cdk diff` to the log and the job summary with every account ID taken out, and deploys the stateless stacks from that one synth: `cdk deploy --app cdk.out --exclusively --require-approval never` on `supply-checkout-prod-*-api`, `-realtime` and `-observability` (`scripts/deploy-stacks.mjs`, shared with `npm run deploy -- api`).

Approving the job is the approval for everything in it, IAM and security group changes included: CDK doesn't ask. To read the diff before deploying, reject the waiting run, run the workflow by hand with **dry run** checked and approve that (it signs in, synthesizes and shows the diff, and deploys nothing), then run it again without dry run.

**The diff is public.** The repository is public, so its Actions logs and job summaries are too, and the diff shows resource names, policy documents and other settings of the stacks. That's accepted: the same templates come from the public source with `npx cdk synth`. Account IDs aren't in it: this account's is masked, and the workflow replaces any account ID in an ARN or a quoted principal with `<account>`.

**By hand.** Actions, Deploy, **Run workflow**, from `main`, with the tag: to deploy a release again, to roll the stacks back to an older release (its commit must still be on `main`), or for a dry run. Only one deploy runs at a time (concurrency group `deploy-production`, never cancelled once started); a run started while another is going waits, and a newer waiting run replaces an older waiting one. Dry runs deploy nothing and have their own group (`deploy-production-dry-run`), so a dry run never replaces a release deploy that's waiting for approval, and can run while one waits.

**What it doesn't deploy yet.** The web stack, the web app and the demo (`supply-checkout-pbp.28`), the stateful stacks (`supply-checkout-pbp.27`), and the post-deploy smoke checks (`supply-checkout-pbp.30`). Use `npm run deploy` for those ([Deploying](infrastructure.md#deploying)); it stays the break-glass path once they're in.

**Settings it needs (the owner, once).** In Settings, Environments, `production`: deployment branches `main` only (no tags), the owner as required reviewer, no admin bypass, and the environment **secret** `AWS_DEPLOY_ROLE_ARN` (the deploy role stack's `DeployRoleArn` output). In Settings, Secrets and variables, Actions, **Secrets**: the repository secret `AWS_DEPLOY_ROLE_ARN` with the same value, for the `trust` job. They're secrets, not variables, so the ARN and the account ID in it are masked in the public run logs. And a tag ruleset on `refs/tags/v*` that lets only the owner and GitHub Actions (release-please) create, update or delete release tags ([What it enables](infrastructure.md#github-actions-deploy-role)).

**What runs with AWS credentials.** Only the `deploy` job, only after the owner's approval, only in the `production` environment (which accepts `main` only), only in a run on `main`, and only code from a release commit on `main` that passed CI. No dependency cache is restored in it, no pull request event starts the workflow, and every third-party action is pinned by commit SHA.

## Real-device check

Playwright can't open a phone's camera, so before publishing a release, check scanning on a real iPhone and a real Android phone: your own phones, or a real-device cloud such as BrowserStack Live. Check the web build and the artifact on claude.ai. Scanning takes a photo through the file input (`capture="environment"`), then decodes it with the browser's `BarcodeDetector` where there is one (Chrome and Samsung Internet on Android) or ZXing otherwise (Safari on iPhone and iPad, Firefox).

1. **iPhone, Safari** (current iOS): open a sheet, tap **Scan to check out**, and photograph a real barcode with the rear camera. The checkout dialog opens with the right item. Then, on the sheet list, tap **Scan receipt**, photograph a paper receipt, and check the review screen lists its lines.
2. **Android phone, Chrome** (current Android): repeat step 1.
3. **Android phone, Samsung Internet** and **Firefox for Android**: open a sheet and scan one barcode in each.
4. On both phones, photograph something that isn't a barcode: the app says no barcode was found and suggests typing the number.
5. On both phones, turn to landscape and back on the sheet and receipt screens: nothing scrolls sideways and no button is cut off.

Note the devices and OS versions in the release PR before merging it.

## Journey evidence pack

Each GitHub Release also gets a journey evidence pack, built by the `evidence` and `evidence-upload` jobs in `.github/workflows/release.yml` after the full check suite passes:

- `journey-evidence.html`: for every journey, each step with its result, the tests that prove it and their results, the time in the video where each shows the step, a screenshot at the step's end, and the alarms that watch the journey.
- `J<n>-<name>.webm`: one video per journey, J0 to J11 (phase 2 journeys have nothing built to show), recorded on desktop Chromium.
- `journey-traces.zip`: each test's Playwright trace.

It's recorded from the release tag against the test suite's fakes and demo data, never production or a real account: the job has no secrets or cloud credentials and only a read-only token, and a separate job with `contents: write` uploads the files. Release assets are public. A test that fails while recording doesn't stop the upload: the report shows it failed, and the workflow run has a warning. How it works: [Journey videos](testing.md#journey-videos).

To check it, open the release on GitHub and look for those assets. Download the report, the videos and `journey-traces.zip` into one folder and unzip the traces there; then the report plays each video in the page, its timestamps seek to the step, and its trace links open the files (`npx playwright show-trace <file>`, or drop one on trace.playwright.dev).

## Publishing to claude.ai

Publishing the artifact is a manual step, because claude.ai artifacts are published from a Claude session rather than from CI. After a release, download `index.html` from the GitHub Release (or run `npm run build:artifact` on the release tag), and ask Claude to republish that file to the existing [artifact URL](https://claude.ai/artifact/LcSb29dTE99AK4N6iuVFrj). Publish `dist/artifact/index.html`, never `src/index.html`: the source page loads its script and styles as separate files, which an artifact can't serve. Publishing to the same URL keeps all saved sheets and inventory.
