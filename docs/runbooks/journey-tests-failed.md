# Journey tests failed after a deploy

When: a deploy's `journeys` job failed, the GitHub Release for a version turned into a **pre-release** with "Journey tests failed in prod" in its notes, or a journeys run you started by hand failed. Bead `supply-checkout-o60.11`. Background: [Releases](../releases.md#when-the-journey-tests-fail) (what the deploy does with a failure), [the plan](../journey-tests-plan.md) (what the suite covers), [Journey tests against prod](../testing.md#journey-tests-against-prod) (the harness) and [journeys](../journeys.md) (which steps it walks; the **In prod** column).

The suite runs **after** the release is live for everyone, so a failure never held anything back. Nothing is rolled back for you yet (`supply-checkout-9lj`). Your first job is to decide whether customers are affected; the rest can wait for that answer.

The worked example below is the v1.15.0 deploy (deploy run `38106625874`, journeys run `38107209551`).

## 1. Read the verdict

**On the Release** (Releases page, or `gh release view vX.Y.Z`). The notes end with one of:
- "Journey tests passed in prod", with the run's link: nothing to do.
- "**Journey tests failed in prod** for vX.Y.Z: J2.1 (iphone-safari), …", the run's link, and "Marked as a pre-release". A pre-release is the mark: the deploy refuses to deploy it again without **allow-bad-release**. "**Critical journeys failed**" in the line means a step of J0, J1, J4, J7, J8, J13 or J14 failed on both tries: treat it as a P1.
- Nothing about journeys: the suite didn't run or didn't finish (switched off, a set-up step failed, cancelled, the run not found). The release is left as it was. Open the deploy run's `journeys` job to see why, then run the suite by hand ([step 5](#5-run-it-again)).

The line lists step IDs, one per step per browser. A test covers several steps (J2's one test covers J2.1 to J2.5), so a test that fails lists them all. The step names are in [journeys](../journeys.md); `npm run journeys:trace` shows which test covers which step.

**On the journeys run** (Actions, Journeys; the run is titled `Journeys after deploying <tag> (deploy run <id>-<attempt>)`, and the deploy's `journeys` job links it).
1. Which job failed? `Check the journey tests are set up` failing means nothing ran (an input, the environment or another run in the way); read its log. `Journey tests against prod` is the suite. `Results for the deploy` only hands the failed steps to the deploy.
2. In `Journey tests against prod`, **Run the journey tests** is the suite. The step **Summary** has a row for every registry step with its result in each browser, a one-line masked message for each failure, and the line "**Failed:** …" or "All prod journey tests passed, N only on a retry (flaky: file a bead today)". A step with no prod test shows its `prodSkip` reason; those aren't failures.
3. The log of **Run the journey tests** has Playwright's output: each failed try (`✘`), its `retry #1`, the assertion with its code frame, and the end totals ("1 failed, 1 flaky, 17 passed"). Local paths there (`.../test-results/...`) are on the runner, which is gone; the files are in the results bucket ([step 2](#2-find-the-trace)).

**Worked example (v1.15.0).** The Release said "J2.1 … J2.5 (iphone-safari)" and was a pre-release. The summary showed J2 failing in iPhone Safari only; desktop Chrome passed it. The log showed the J2 test failing its try and its retry with `Error: page errors` at the page-error check (not an assertion about the inventory), listing "…/products due to access control checks". That is WebKit's message for a fetch that navigation cut off (see [step 3](#3-flake-or-real-regression)). The totals also said "1 flaky": the J1 test on desktop failed its first try and passed its retry.

## 2. Find the trace

Traces, videos, screenshots and the JSON report of every run go to the private results bucket under `runs/<journeys run id>-<attempt>/` (here `runs/38107209551-1/`; kept 30 days). They are never Actions artifacts, and the summary names no links. Before upload, the JSON report and text files are redacted and every `trace.zip` is scrubbed of passwords, tokens and sign-in bodies; the upload refuses a run if it still finds one. Only the owner's `supply-prod` profile reads the bucket (the name is in SSM: `/supply-checkout/prod/journeys/results-bucket-name`).

```bash
aws sso login --profile supply-prod
export AWS_PROFILE=supply-prod AWS_REGION=us-east-1
BUCKET=$(aws ssm get-parameter --name /supply-checkout/prod/journeys/results-bucket-name --query Parameter.Value --output text)
RUN=38107209551-1                      # the journeys run's id, then -<attempt>
aws s3 ls "s3://$BUCKET/runs/$RUN/" --recursive | grep -E "trace.zip|video.webm|png"
mkdir -p ~/journeys-$RUN && aws s3 sync "s3://$BUCKET/runs/$RUN/" ~/journeys-$RUN
npx playwright show-trace ~/journeys-$RUN/test-results/<test folder>/trace.zip
```

The folder name is the spec, the test's title and the project (`J2-inventory.prod.js-the-o-…-iphone-safari`); a retry's has `-retry1` on the end. A failed test keeps a trace (started only after sign-in, so a sign-in failure has none), a video, a screenshot and `error-context.md` (the page as text). Put the files in a folder under your home directory, not the repo, and don't paste them into an issue or a chat: they show the test teams' data.

## 3. Flake or real regression

The suite tries a failed test twice. So:
- **Passed on its retry** ("flaky" in the summary): the run passes and the release is not marked. Flaky is a bug in a test or the app, never noise: file a bead the same day, with the test, the project and the first try's error from the log (as the plan's flake policy says). Don't re-run to make it go away.
- **Failed both tries**: the release is marked. Decide which of these it is:

| What you see | Likely | Do |
| --- | --- | --- |
| The same step fails in the **other** browser too, or the assertion is about the app (a missing button, a wrong total, a 4xx or 5xx from `api.`) | A real regression | Step 4 |
| Only `page errors` or `console` lines fail the test, the steps themselves finished, and the message is a browser's report of a cancelled fetch ("due to access control checks" in WebKit, "Load failed", "Failed to fetch" when the page navigated) | The test or app racing a navigation: a bug, not a customer outage. This was run 38107209551 | File or find the bead (`supply-checkout-o60.22` for J2 on iPhone), fix forward |
| Sign-in fails ("Too many requests", a code that never came) | Managed Login throttling or SES inbound, not the app. The saved sessions in `lib/sessions.mjs` are there to avoid it | Check the mail and throttle limits in the log; run again after 15 minutes |
| `/me` lists a team that isn't expected, or a comp warning, or a secret is missing | Set-up, not a regression. The run stops before testing anything | Steps 6 and 7 |
| Everything fails at once, including J0 | prod is down or the deploy broke sign-in | Step 4, now |

When unsure, check the product the way a customer does: open `app.` in a phone and a laptop, sign in, open a project. Also check the alarms for the same window ([observability](../observability.md)): the canary and the per-journey alarms are the real customer signal, and a red journeys run with quiet alarms is usually a test problem. The failing journey's alarms are listed in [journeys](../journeys.md#alarms-for-blocked-journeys).

## 4. When to roll back

Roll back only when customers are affected: a critical journey (J0, J1, J4, J7, J8, J13, J14) is really broken, or the alarms agree. A non-critical journey failing, or a test-only problem, is a P2: fix forward the same business day and leave the release alone.

Pick the narrowest tool that undoes the change:
1. **The web app only** (the failure is in what people see and the API is fine): point `app.` back at the previous version, a switch that takes effect at once and touches no data. The previous version is still uploaded (`npm run publish:web -- status` lists them):
   ```bash
   npm run publish:web -- status
   npm run publish:web -- activate --channel app --version <previous version>   # for example 1.14.0
   npm run publish:web -- check-router
   ```
   [When the web app is down](../observability.md#when-the-web-app-is-down) has the rest. Rolling the web app back leaves the stacks on the new release, so check the old app still works with the new API (the expand/contract rule in [Releases](../releases.md) says it does).
2. **The stacks and the web app together:** run Actions, Deploy, **Run workflow** with the **previous release's tag** (it must be a published release that isn't a pre-release, and it must have passed CI). It puts back that release's stacks and web app and needs the owner's approvals like any deploy. This is the P1 path. Do not tick **allow-bad-release** here. Today's specs run against the old release afterwards, so a step added since may fail on it: read the summary before calling that a regression.
3. **A stack alone:** CloudFormation rolls a failed stack update back on its own, and the stateful stacks (DynamoDB, KMS, Cognito, S3) are separate with `RETAIN`, so a code rollback never touches data. Don't roll back a stack by hand in the console; deploy the previous release (2) so the stacks and the web app stay consistent. A stack stuck in `UPDATE_ROLLBACK_FAILED` is an infrastructure incident, not a journeys one: see [infrastructure](../infrastructure.md).
4. If a rollback needs a **data** change, stop: the release broke expand/contract. Fix forward.

After a rollback the previous release is live and the failed release stays a pre-release. Open a bead for the regression, fix it on `main`, and let the next release's journeys run be the proof.

## 5. Run it again

- **Re-run the deploy's `journeys` job** (the failed deploy run, Re-run failed jobs): it dispatches a new journeys run for the same tag and, on a pass, adds "Journey tests passed" to the Release. Use this after a flake or a fix to the suite on `main`. A re-run of the journeys run alone marks no release.
- **Run the suite by hand:** Actions, Journeys, **Run workflow** from `main`, with **tag** and **deploy-run** empty. It marks nothing, so use it to check a fix or to see whether a failure repeats. After merging a change to `tests/prod/`, always run it once before the next release.
- **The overlap guard.** Two runs against prod at once would break each other (each signs the test accounts out everywhere when it ends). A run by hand goes in the `journeys-manual` concurrency group, and its `check` job refuses, naming why, while a deploy is queued, waiting or running, or while a deploy's journeys run hasn't completed. A deploy's own run waits up to 30 minutes for any other journeys run, then fails. If the guard says a run is still going and none is, look for a stuck run under Actions, Journeys, and cancel it; don't skip the check.
- The result of any run is the Summary step and the Release (deploy-started runs only), as in step 1.

## 6. The release is a pre-release

A pre-release can't be deployed again by accident, and shows on the Releases page as not good. To get it right again:
- **The tests were wrong, or the failure was a flake and you've confirmed prod is fine:** fix the suite on `main` if needed (the deploy runs `main`'s journeys workflow and specs), then run Deploy again for that tag with **allow-bad-release** ticked. That redeploys the same release (a no-op for most stacks), runs the journeys, and on a pass notes "Journey tests passed". It still leaves the pre-release mark.
- **To clear the mark** once you're satisfied the release is good (a re-run passed, or you checked by hand):
  ```bash
  gh release edit vX.Y.Z --prerelease=false
  gh release edit vX.Y.Z --latest        # only if it's the newest release
  ```
  For v1.15.0, clearing it is right once J2 on iPhone is fixed and a run passes, or you've decided the page-error race is test-only.
- **A release with a real regression stays a pre-release.** Ship the fix as the next release.

## 7. Other things that fail the run

- **Cleanup that failed.** The `Clean up` step deletes everything named for the run in the two long-lived teams, each throwaway account, and signs the accounts out. If it fails, read the step's log for what it couldn't delete. The next run's cleanup sweeps anything left that is a day old, and a throwaway account stays recorded under `runs/` in the mail bucket until it is deleted, so a one-off failure mends itself. If it fails run after run, open a bead; don't delete things by hand in a team that isn't a test team.
- **Comps running out.** The two journey teams are comped for 12 months. The summary warns when one has under 30 days left; renew it with the operator CLI (`npm run ops -- comp <team> --months 12`; the owner runs it, see the [operator page](operator-page.md)). A team that goes read-only fails every write.
- **Secrets.** A run that stops before testing with "missing secret" or a sign-in failure for a long-lived account: a password or TOTP secret changed or expired. Rotation is every 90 days (the Stripe sandbox key too), at once if a log might have shown one; see "Credentials and secrets" in [the plan](../journey-tests-plan.md#credentials-and-secrets) and [Releases](../releases.md#the-production-journeys-environment). If a log did show a secret, treat it as an incident: rotate first.
- **The journeys role or its buckets.** `Sign in to AWS with the journeys role` failing, or the upload refused: see [infrastructure](../infrastructure.md#journey-tests).

## Trial steps

A step whose prod test hasn't passed in prod yet carries `prodTrial` (a reason) in `journeys/registry.json`: today J7.2, J7.3, J10.1 and J10.2, the billing journey on Stripe's sandbox pages, whose selectors were written without a run against them. A failing step on trial is a **warning** in the summary ("those steps are on trial"), shown as "FAIL (on trial)": it doesn't fail the deploy's journeys job, doesn't mark the release a pre-release and doesn't page. The suite step succeeds only if every failed test is in steps that are on trial or carry a `prodSkip` (`prod-summary.mjs --trial-only`); any other failure fails it as usual. Steps J8.1 and J8.3 (they run only with the sandbox key) are treated the same way.

- **When one warns:** read its message in the summary (the failing Stripe page is described, redacted), fix the selector or flow in `tests/prod/billing.mjs` in a normal PR, and let the next deploy's run prove it.
- **After the first green run, remove the trial:** delete the `prodTrial` line from each of those steps in `journeys/registry.json`, run `npm run journeys:docs` and `npm run journeys:trace`, and land it. From then on a failure there is a critical failure (J7 is critical) and follows the rest of this runbook. J8.1 and J8.3 move from `prodSkip` to a prod test (and lose their skip) once the owner has created the sandbox key and they have passed.

