# Lapsed teams: the hourly job that warns and closes them

When: **Lapsed-team job failing**, **Lapsed-team job not running**, **Lapsed-team job out of time**, **Lapsed-team closures held** or **Lapsed-team closures high** (all P2) fired, an owner asks why their team was or wasn't deleted, or you need to save a lapsing team. Bead `supply-checkout-qdx`. Background: the access rules in [infrastructure](../infrastructure.md#billing) ("Billing access rules"), [journeys](../journeys.md) (J7, J8, J10), and Terms sections 4, 5.6 and 6.

## What the job does

`supply-checkout-<env>-team-lapse` runs every hour in the primary region (`backend/src/ops/team-lapse-handler.ts`). It lists open teams from the operators' index (GSI3 `OPS#TEAMS`) whose billing may have lapsed: `past_due`, `unpaid`, `canceled` or `incomplete_expired`, or `trialing` with the trial ending within 3 days or over. Teams with a live comp aren't listed. It reads each one again from its `META` item and applies `billingAccess`:

| Team | Emails (each owner, once) | Closed for deletion |
| --- | --- | --- |
| App trial (no Stripe subscription) ending within 3 days | Trial ending | No |
| App trial ended (`trial_ended`) | Read-only, with the deletion date | Yes, see below |
| `past_due` past its 7-day grace (`payment_overdue`) | Read-only, pay to edit again | Never |
| `unpaid` | None here (the billing worker sent one) | Never |
| `canceled` or `incomplete_expired` (`subscription_ended`), with `subscriptionEndedAt` | None here (the billing worker sent the read-only email) | Yes, see below |
| `canceled` without `subscriptionEndedAt` | None | Not until the nightly entitlement check records the date (counted in `LapseFailures` meanwhile) |

**Closing.** A team's deletion time (`readOnlyDeletesAt` on `/me`, `deleteAfter` in the logs) is 30 days after its trial or subscription ended, or after its comp ran out if that's later, rounded up to 12:00 UTC the day after that date's UTC date: the moment that date has ended in every time zone (UTC−12). Owners are told that date, the last day the team is kept ("deleted after October 31"; `readOnlyLastDay` on `/me`). From 8 days before the deletion time (a day early, so the first hourly run in the window still gives 7 days' notice and states the same date), the job emails each owner a deletion warning. It records the warning (`LAPSE#<teamId>` / `WARNED#<deleteAfter>`, with `sentAt`) only once at least one owner was sent it, and tries again each UTC day until then. The team is closed at the deletion time, or, if the warning went out less than 7 days before it, 7 days after the warning rounded up the same way (the warning states that later date). So a team found already past its date (comped until recently, or from before the job existed) still gets 7 days.

Before closing, the job asks Stripe again:
- The team's recorded subscription must exist, be the customer's, and be `canceled` or `incomplete_expired`.
- None of the customer's subscriptions may be anything else.
- The customer may have no open Checkout Session (say, one made in the Stripe Dashboard). One means an owner is subscribing right now: the team is left for the next run, logged (`Lapsed team not closed: an owner has Checkout open`) but not counted as a failure, since the session completes (the team becomes active) or expires within 24 hours.

At most 10 teams are closed a run (`LAPSE_MAX_CLOSURES_PER_RUN`); the rest due are held for the next run and counted (`LapseClosuresHeld`). Then it sets `closedAt` to now, `purgeAfter` 24 hours later (`LAPSE_PURGE_DELAY_HOURS`) and `closedBy` to `system:lapsed`, and adds the team to the closed-teams index. The write only succeeds if the team's `version` is the one it read, and no owner started Checkout in the last 25 hours (`stripeCheckoutAt`, `LAPSE_CHECKOUT_GUARD_HOURS`: longer than a Checkout Session lasts). Every change to the team's billing moves the version: a Stripe event, a comp, a reopen, and every Checkout an owner starts, which links the team's Stripe customer again (`linkStripeCustomer`, before the session is made) and records `stripeCheckoutAt`. So the app never makes a Checkout Session for a team the job has closed (the link is refused once the team is closed, and the owner gets 403 `team_closed`), and the job never closes a team under a Checkout Session the app made. Once `purgeAfter` passes, the hourly closed-team purge writes the deletion record, deletes or queues the Stripe customer, and deletes the data, exactly as for a team an owner closed. Until then the team can be reopened, as a closed team can: by an operator (`npm run ops -- reopen <teamId> --reason …`, until 5 minutes before) or by an owner in the app (until an hour before). Reopened, it's lapsed again, so the job closes it again on its next run unless it's subscribed or comped first (see Saving a lapsing team).

**Never touched:**
- teams with a live comp;
- closed teams, including ones set aside or held by the purge;
- teams being purged;
- `unpaid` and overdue teams.

Records under `LAPSE#<teamId>` hold IDs and times only, and expire after 120 days (TTL).

```bash
aws sso login --profile supply-prod
export AWS_PROFILE=supply-prod AWS_REGION=us-east-1 ENV=prod
FN=supply-checkout-$ENV-team-lapse
LOGS=$(aws lambda get-function-configuration --function-name $FN --query LoggingConfig.LogGroup --output text)
```

## Lapsed-team job failing

Find the lines from the last two hours (CloudWatch Logs Insights on `$LOGS`):

```
fields @timestamp, message, teamId, why, step, error, subscriptionId, customerId, stripeStatus
| filter level in ["WARN", "ERROR"]
| sort @timestamp desc
```

- **`Lapsed team not closed: Stripe disagrees`, `why: SubscriptionLive`.** Stripe has a live subscription (`subscriptionId`, `stripeStatus`) that our record doesn't show: a resubscription whose webhook was lost, or an `unpaid` or `paused` one.
  - Replay the billing events ([billing DLQ replay](billing-dlq-replay.md)), or wait for the nightly entitlement check, which applies Stripe's state. The team then stops lapsing or gets the right status.
  - If it's an `unpaid` or `paused` subscription nobody will pay, cancel it in the Stripe Dashboard. The webhook then records `canceled`, and the 30 days start from Stripe's `ended_at`.
- **`CustomerMismatch`, `SubscriptionNotFound` or `CustomerNotFound`.** Our IDs don't match Stripe. Check first that the job reads the right mode's key (`STRIPE_SECRET_ID` and `STRIPE_MODE` on the function), since a key or mode mismatch looks like this for every team. If the key is right, look the team's customer up in the Dashboard (both modes) and correct the record with the owner's agreement, or decide, and note on the bead, that the team may be deleted anyway. Nothing closes it until Stripe agrees.
- **`Lapsed team's deletion time isn't a date`** (`step: badDate`). The team's `WARNED#` record has a `sentAt` that doesn't parse (the job never writes one). Look at the `LAPSE#<teamId>` items; nothing closes the team until it's fixed.
- **`TooManySubscriptions`.** The customer has more than 10 subscriptions, so a live one could be past the first page. List them all in the Dashboard and cancel or record what's live; the next run closes the team once nothing is.
- **`Lapsed team has no date its subscription ended`** (`step: undated`). A `canceled` or `incomplete_expired` team without `subscriptionEndedAt`, applied before the date was kept. The nightly entitlement check records it (drift field `accessDates`); if it doesn't, check the team has a Stripe customer the reconciliation lists, or replay its last event. Until then it's never deleted.
- **`Lapsed team has no version`** (`step: noVersion`). A META item this app didn't write as usual. Look at it by hand; nothing closes it.
- **`Lapsed team has no owners to warn`** (`step: noOwners`). The operators' index has no owner for the team (GSI3 `OPS#OWNERS#<teamId>`), so nobody can be warned and the team is never closed. Check the team's `MEMBER#` items: an owner whose item lacks the index keys needs them restored (the backfill script), and a team with no owner at all needs a person to decide, with a note on the bead, whether it may be deleted.
- **`Lapsed team's deletion warning not delivered`.** No owner could be emailed: SES refused (`Lapse emails not sent` has SES's error names), or no owner has an address. Check SES's account dashboard and suppression list. The job tries again each day. The team isn't closed until an owner gets the warning.
- **`Lapsed team check failed`** (an error, with `error` and Stripe's `type` and `status`). The usual causes:
  - Stripe was unreachable or rate limiting. The next run retries.
  - An `AccessDeniedException`: the role in `infra/lib/observability/ops-checks.ts` no longer matches the code's attribute lists (`LAPSE_*` in `backend/src/data/schema.ts`).
  - A KMS `AccessDenied`: add `kms:Encrypt` and `kms:GenerateDataKey` with the same `kms:ViaService` condition, as the purge's note says.

## Lapsed-team closures held, or closures high

The job closed its cap of 10 teams in one run and held the rest (`Lapsed-team job held teams at its closure cap`), or closed more than 20 in 6 hours. That's expected only for a real batch: many trials that ended in the same week, or the first runs after the job ships. A bug or bad data (dates read wrong, a status mapped wrong) would look the same, and every closed team is deleted by the purge 24 hours after it closed.

1. Stop it first if you aren't sure. Disable the schedule, so no run closes more while you look (a deploy turns it back on):

   ```bash
   RULE=$(aws events list-rules --query "Rules[?contains(Name, 'TeamLapseSchedule')].Name" --output text)
   aws events disable-rule --name "$RULE"
   ```

2. List what it closed (Logs Insights on `$LOGS`): `filter message = "Lapsed team closed for deletion" | fields @timestamp, teamId, reason, deleteAfter, warnedAt, subscriptionId`. Check a few in the Stripe Dashboard and with `npm run ops -- team <teamId>`: each should have ended 30 days or more ago, with no live subscription.
3. If they're wrong, save the teams the job closed by mistake: each stays closed for 24 hours before the purge deletes it, so with the job's schedule disabled, reopen each as an operator (`npm run ops -- reopen <teamId> --reason "Closed by mistake: <bead>"`) and comp it if it needs to stay open while the cause is fixed. Fix the cause before turning the schedule back on.
4. If they're right and more are due, turn the schedule back on (`aws events enable-rule --name "$RULE"`); the job works through them at 10 an hour. To clear a known backlog faster, raise `LAPSE_MAX_CLOSURES_PER_RUN` in `backend/src/ops/names.ts` (and `LAPSE_CLOSURES_ALARM_COUNT` if the volume alarm should stay quiet), with a note on why, and deploy; lower it again afterwards.

## Lapsed-team job out of time

Every run for 3 hours ran out of its 4 minutes before it started every lapsing team (`Lapsed-team job ran out of time`, with `unstarted`). Each run starts at a random place in the list, so no team is always skipped, but emails and closures run late. Check how many teams it lists (`Lapsed-team job ran` has `listed`) and what's slow: Stripe calls (`Lapsed team check failed` with timeouts) or SES. If the list has simply grown, the job needs batching or a shorter interval (`LAPSE_EVERY_HOURS`); open a bead.

## Lapsed-team job not running

1. Check that the `TeamLapseSchedule` EventBridge rule in the observability stack is there and enabled. A deploy restores it.
2. Check that the function has invocations in the last hours.
3. If it runs but fails before listing, its log group has the error, usually an `AccessDeniedException` on the GSI3 query, or the Stripe secret or email settings missing at start-up (`... is not set`).
4. Run it once by hand to check:

   ```bash
   aws lambda invoke --function-name $FN /dev/stdout
   ```

   It answers `{"checked":…,"closed":…,"failed":…,"held":…}`. Running it twice is safe: every email and closure is claimed or conditioned, and one run goes at a time. An invocation while another run holds the lease (`LAPSE#RUN` / `LEASE`) answers `"skipped":true` and logs `Lapsed-team job skipped: another run holds the lease`; a run that died frees it within 6 minutes (`LAPSE_LEASE_MS`). The function has no retries, from the schedule or Lambda.

## Saving a lapsing team

An owner who subscribes before the date (Checkout, from the team bar) keeps the team: the subscription goes `active`, and the team is no longer read-only. A team that should be kept without paying (a pilot, a dispute) gets a comp from support (ADR 0015, the `ops` skill). With a live comp the job leaves it alone, and when the comp ends its clocks start from then. A team the job already closed is deleted 24 hours later; until then an operator can reopen it (`npm run ops -- reopen`) and comp it straight away, before the job's next run closes it again, or an owner can reopen it and subscribe within the hour.

## Checking it after a deploy

- **The job's role:** in CloudTrail, no `AccessDenied` for the `TeamLapseRole` after the first runs.
- **Its gauge:** `LapseTeamsChecked` arrives hourly, on the dashboard row "teams the lapsed-team job checked".
- **Teams that will turn read-only at once:** before the first deploy of the access rules, list the app trials the rule will make read-only and comp the pilot teams first. In Logs Insights after the first run, `filter message = "Lapsed team warned of deletion"` lists every team warned. Each one will be deleted 7 days later unless it subscribes or is comped.
