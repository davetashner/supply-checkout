# Replaying the billing dead-letter queue

When: the **Billing events stuck** alarm (P1) fired, or **Entitlements drifting** (P2) found a team whose billing didn't match Stripe. Bead `supply-checkout-8jc.9`. Background: [infrastructure](../infrastructure.md#billing) ("Webhook, queue and worker", "Seats") and [journeys](../journeys.md) (J7, J8).

Stripe events reach a team like this: Stripe → `POST /billing/webhook` (signature checked) → `supply-checkout-<env>-billing-events.fifo` → the `billing-worker` function → the team's `META` item. An event the worker couldn't apply after 5 tries goes to `supply-checkout-<env>-billing-events-dlq.fifo`, which keeps it for 14 days. Seat syncs have their own pair, `supply-checkout-<env>-seat-syncs.fifo` and `-seat-syncs-dlq.fifo` (Seat syncs stuck, [journeys](../journeys.md)).

**Replaying is safe.** The worker skips an event it already applied (`WEBHOOK#<eventId>`), applies the subscription's *latest* state from Stripe rather than the event's, so order doesn't matter, and emails each owner at most once per event. Replaying the same message twice changes nothing. The nightly entitlement check fixes a team's status, plan and seats within a day even if nothing is replayed; replaying is still worth doing, because it's the only way owners get the email the event should have sent (a trial ending, a failed payment, read-only).

**What's in a message.** IDs (`eventId`, `customer`, `subscription`), the event's type and time, and statuses and dates. No name, email or address. Still, quote IDs in tickets and chat, not whole messages.

Everything here is in the primary region, us-east-1 (ADR 0010), with the `supply-prod` profile:

```bash
aws sso login --profile supply-prod
export AWS_PROFILE=supply-prod AWS_REGION=us-east-1 ENV=prod
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
DLQ_URL=$(aws sqs get-queue-url --queue-name supply-checkout-$ENV-billing-events-dlq.fifo --query QueueUrl --output text)
DLQ_ARN=arn:aws:sqs:$AWS_REGION:$ACCOUNT:supply-checkout-$ENV-billing-events-dlq.fifo
QUEUE_ARN=arn:aws:sqs:$AWS_REGION:$ACCOUNT:supply-checkout-$ENV-billing-events.fifo
```

## 1. Find out why it failed

Don't replay until the cause is fixed, or the events come straight back.

1. The billing worker's log group (the api stack's `BillingWorkerFunction`) has `Billing event failed` with the SQS message ID and the error's name for each try; the lines before it, with the same request ID, name the event. Usual causes: Stripe unreachable or rate limiting (`StripeConnectionError`, `StripeRateLimitError`), the Stripe secret missing or of the wrong mode, a DynamoDB `AccessDeniedException` (the `BillingWorkerRole` policy no longer matches the code), or a `ConflictError` that kept losing a race.
2. Look at the messages without taking them off the queue for long (a received message is hidden for the visibility timeout, then returns):

   ```bash
   aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names ApproximateNumberOfMessages
   aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 10 --visibility-timeout 30 \
     --attribute-names All --query 'Messages[].Body' --output text
   ```

3. Fix the cause (a deploy, a secret, waiting out a Stripe incident) before going on.

## 2. Replay the queue

Move every message back to the billing events queue. SQS moves FIFO messages too, and keeps each one's group (the Stripe customer):

```bash
TASK=$(aws sqs start-message-move-task --source-arn "$DLQ_ARN" --destination-arn "$QUEUE_ARN" --query TaskHandle --output text)
aws sqs list-message-move-tasks --source-arn "$DLQ_ARN"   # Status COMPLETED, ApproximateNumberOfMessagesMoved
```

The SQS console's **Start DLQ redrive** on the dead-letter queue does the same. Then check:

- The worker's log has `Billing event` for each `eventId` with outcome `applied` (or `duplicate`, if it had been applied before the failure).
- The dead-letter queue is empty, and **Billing events stuck** returns to OK within 10 minutes.
- For the teams concerned, `GET /me` (or the operators' console) shows the plan and status Stripe has.

To replay just one event instead (say the rest are for a customer you're still looking into), send its body back yourself. The webhook deduplicates by event ID for 5 minutes, which has long passed:

```bash
QUEUE_URL=$(aws sqs get-queue-url --queue-name supply-checkout-$ENV-billing-events.fifo --query QueueUrl --output text)
aws sqs send-message --queue-url "$QUEUE_URL" --message-body "$BODY" --message-group-id "$CUSTOMER" --message-deduplication-id "$EVENT_ID-replay"
```

then delete that message from the dead-letter queue (`aws sqs delete-message` with its receipt handle).

## 3. Events that never reached the queue

The dead-letter queue only has events the webhook accepted. An event Stripe couldn't deliver (the endpoint down, a wrong signing secret: Webhook signature failures) is retried by Stripe for 3 days, then dropped. After an outage longer than that, or when Entitlements drifting names a team with nothing in the dead-letter queue:

1. In the Stripe Dashboard, open the event destination (`supply-checkout-<env>-billing`) and its failed deliveries, or search the customer's events.
2. Resend each one to the destination (the Dashboard's **Resend**, or `stripe events resend <evt_id> --webhook-endpoint <we_id>` with the Stripe CLI). Stripe only allows this for a limited time after the event; older ones can't be resent, and the nightly entitlement check has already fixed the team's state, so only the owner email is lost.

## 4. After an Entitlements drifting alarm

The billing worker's log has `Entitlement drift` for each team, with the fields that differed (`subscription`, `status`, `plan`, `seats`) and both sides' values. The team already has Stripe's state. For each:

- Look for its events in the dead-letter queue (step 2) or in Stripe's failed deliveries (step 3), and replay them so the owner gets any email that was missed.
- `subscription` in the fields means a checkout or resubscription we never recorded. If the team also had another live subscription, check in Stripe that the customer isn't paying twice.
- `Entitlement drift: subscription missing in Stripe` means the team records a subscription Stripe doesn't have (deleted by hand, or a test-mode object in live mode). Nothing was changed. Open the team's customer in the Dashboard and check for a live subscription. If there is one, attach it to the team by replaying one of its events (a `customer.subscription.updated` or `.created`, step 3's Resend): the worker applies it in place of the missing one. If there's none, the customer isn't paying, and the team stays as it is until someone decides what it should have.
- `Entitlement drift: customer missing in Stripe` means the team's Stripe customer is gone (deleted by hand, or the wrong mode's). Nothing was changed. The team can subscribe again only once that's sorted out: check in the Dashboard which customer, if any, is the team's now.
- A drift for a team whose own event was in flight at 07:00 UTC fixes itself: ignore it if that event shows up in the log minutes later.
- `cancelAtPeriodEnd` in the fields means a cancellation at the period's end (or a renewal) we never recorded, such as one made while the team was closed, whose events the worker skips. The first night after this field was added to the check (`supply-checkout-85qp`) may show a one-time wave of these, for teams set to cancel whose cancellation was never recorded: expected, and already fixed.
- Before turning off a pending cancellation by hand (for a reopened team, say), remember that resuming a `trialing` subscription converts it to paid at its trial end, and resuming a `past_due` one has Stripe retry its card: both charge the customer.
- The fix is conditioned on the team's status, plan, seats, subscription and cancellation being as the check read them, compared by value. A change and back between the read and the write, or a change only to the period end, isn't seen, so the check's older state can win for a while. The next event for the subscription, or the next night, corrects it.

## Dry runs in test mode

**Only where Stripe is in test mode.** Run them in an environment whose Stripe is the sandbox: prod until go-live, then staging (or another non-live environment), never prod after it switches to live mode. Never disable a live-mode event destination: live customers' events would be lost. Run both after the first deploy of this change, and again after any change to the billing queue, the worker or its role. Use a test team you own, never a customer's. Record each run in the log below.

**First, confirm the mode.** The worker must be on the test key, and the Dashboard in test mode (the sandbox's banner):

```bash
# The api stack's BillingWorkerFunction (CloudFormation names it; check there if this finds none or two)
WORKER=$(aws lambda list-functions --query "Functions[?contains(FunctionName, 'BillingWorker')].FunctionName" --output text)
aws lambda get-function-configuration --function-name "$WORKER" --query 'Environment.Variables.[STRIPE_MODE,STRIPE_SECRET_ID]' --output text
# Expect: test   supply-checkout/<env>/stripe/test-secret-key. Anything with "live" in it: stop here.
```

**Dry run 1: replay a message from the dead-letter queue.** Put a message for the test team straight onto the dead-letter queue, as if the worker had given up on it, then replay it:

```bash
CUSTOMER=cus_...   # the test team's Stripe customer (Dashboard, or the team's stripeCustomerId)
SUB=sub_...        # its subscription
BODY=$(printf '{"eventId":"evt_dryrun_%s","type":"customer.subscription.updated","created":%s,"customer":"%s","subscription":"%s"}' "$(date +%Y%m%d%H%M)" "$(date +%s)" "$CUSTOMER" "$SUB")
aws sqs send-message --queue-url "$DLQ_URL" --message-body "$BODY" --message-group-id "$CUSTOMER" --message-deduplication-id "dryrun-$(date +%s)"
```

This fires a **real P1**: Billing events stuck goes to the P1 topic within 10 minutes, paging whoever's on call, so tell them first. Then follow step 2. Expect `Billing event` with this `eventId` and outcome `applied` in the worker's log, an empty dead-letter queue, and the alarm back to OK. Replaying the same body again (step 2's single-message way) gives `duplicate`.

**Dry run 2: a lost event caught by the nightly check (a forced mismatch).**

1. In the Stripe Dashboard, in **test mode** (checked above), disable the test-mode event destination `supply-checkout-<env>-billing`. Never the live one.
2. On the test team's subscription, make a change the team should see: cancel it immediately (status `canceled`), or switch its price between monthly and annual.
3. Enable the destination again. The event for step 2 was never delivered.
4. Run the check now rather than waiting for 07:00 UTC: `aws lambda invoke --function-name supply-checkout-$ENV-seat-reconcile /dev/null`.
5. Expect, in the billing worker's log, `Entitlement drift` for the test team with fields `status` (or `seats`, `plan` as changed) and our values and Stripe's; the team showing Stripe's state (read-only, for a cancellation); and **Entitlements drifting** (P2) firing within the hour. Invoking the reconciliation again gives `Entitlement check` with outcome `in_sync`.
6. Replay the lost event (step 3's Resend): the worker applies it (outcome `applied`) and, for a cancellation, emails the owners once.

### Dry-run log

| Date | Who | Stripe mode | Dry run | Result |
| --- | --- | --- | --- | --- |
| | | test | 1: DLQ replay | |
| | | test | 2: forced mismatch | |
