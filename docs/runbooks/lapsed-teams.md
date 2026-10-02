# Lapsed teams: the hourly job that warns and closes them

When: **Lapsed-team job failing** or **Lapsed-team job not running** (both P2) fired, an owner asks why their team was or wasn't deleted, or you need to save a lapsing team. Bead `supply-checkout-qdx`. Background: the access rules in [infrastructure](../infrastructure.md#billing) ("Billing access rules"), [journeys](../journeys.md) (J7, J8, J10), and Terms sections 4, 5.6 and 6.

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

**Closing.** A team's deletion date (`readOnlyDeletesAt` on `/me`, `deleteAfter` in the logs) is 30 days after its trial or subscription ended, or after its comp ran out if that's later. From 7 days before it, the job emails each owner a deletion warning. It records the warning (`LAPSE#<teamId>` / `WARNED#<deleteAfter>`, with `sentAt`) only once at least one owner was sent it, and tries again each UTC day until then. The team is closed no earlier than the later of the deletion date and 7 days after the warning. So a team found already past its date (comped until recently, or from before the job existed) still gets 7 days.

Before closing, the job asks Stripe again:
- The team's recorded subscription must exist, be the customer's, and be `canceled` or `incomplete_expired`.
- None of the customer's subscriptions may be anything else.

Then it sets `closedAt` and `purgeAfter` to now and `closedBy` to `system:lapsed`, and adds the team to the closed-teams index. The write only succeeds if the team's `version` is the one it read. Within the hour the closed-team purge writes the deletion record, deletes or queues the Stripe customer, and deletes the data, exactly as for a team an owner closed. A team closed this way can't be reopened: its `purgeAfter` has already passed.

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
- **`TooManySubscriptions`.** The customer has more than 10 subscriptions, so a live one could be past the first page. List them all in the Dashboard and cancel or record what's live; the next run closes the team once nothing is.
- **`Lapsed team has no date its subscription ended`** (`step: undated`). A `canceled` or `incomplete_expired` team without `subscriptionEndedAt`, applied before the date was kept. The nightly entitlement check records it (drift field `accessDates`); if it doesn't, check the team has a Stripe customer the reconciliation lists, or replay its last event. Until then it's never deleted.
- **`Lapsed team has no version`** (`step: noVersion`). A META item this app didn't write as usual. Look at it by hand; nothing closes it.
- **`Lapsed team's deletion warning not delivered`.** No owner could be emailed: SES refused (`Lapse emails not sent` has SES's error names), or no owner has an address. Check SES's account dashboard and suppression list. The job tries again each day. The team isn't closed until an owner gets the warning.
- **`Lapsed team check failed`** (an error, with `error` and Stripe's `type` and `status`). The usual causes:
  - Stripe was unreachable or rate limiting. The next run retries.
  - An `AccessDeniedException`: the role in `infra/lib/observability/ops-checks.ts` no longer matches the code's attribute lists (`LAPSE_*` in `backend/src/data/schema.ts`).
  - A KMS `AccessDenied`: add `kms:Encrypt` and `kms:GenerateDataKey` with the same `kms:ViaService` condition, as the purge's note says.

## Lapsed-team job not running

1. Check that the `TeamLapseSchedule` EventBridge rule in the observability stack is there and enabled. A deploy restores it.
2. Check that the function has invocations in the last hours.
3. If it runs but fails before listing, its log group has the error, usually an `AccessDeniedException` on the GSI3 query, or the Stripe secret or email settings missing at start-up (`... is not set`).
4. Run it once by hand to check:

   ```bash
   aws lambda invoke --function-name $FN /dev/stdout
   ```

   It answers `{"checked":…,"closed":…,"failed":…}`. Running it twice is safe: every email and closure is claimed or conditioned.

## Saving a lapsing team

An owner who subscribes before the date (Checkout, from the team bar) keeps the team: the subscription goes `active`, and the team is no longer read-only. A team that should be kept without paying (a pilot, a dispute) gets a comp from support (ADR 0015, the `ops` skill). With a live comp the job leaves it alone, and when the comp ends its clocks start from then. A team the job already closed can't be reopened, and the purge deletes it within the hour.

## Checking it after a deploy

- **The job's role:** in CloudTrail, no `AccessDenied` for the `TeamLapseRole` after the first runs.
- **Its gauge:** `LapseTeamsChecked` arrives hourly, on the dashboard row "teams the lapsed-team job checked".
- **Teams that will turn read-only at once:** before the first deploy of the access rules, list the app trials the rule will make read-only and comp the pilot teams first. In Logs Insights after the first run, `filter message = "Lapsed team warned of deletion"` lists every team warned. Each one will be deleted 7 days later unless it subscribes or is comped.
