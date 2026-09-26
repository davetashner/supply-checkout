# Observability

**Observability** (`lib/observability/`). Each region's `observability` stack has two SNS topics, `supply-checkout-<env>-alarms-p1` (email and SMS) and `-p2` (email), encrypted with a rotating KMS key, and the alarms from [docs/journeys.md](journeys.md) whose metrics exist ("Which alarms exist"). The primary region's stack also has the `supply-checkout-<env>` CloudWatch dashboard: traffic, errors, latency and every business metric, one line per region. An aspect (`lib/observability/defaults.ts`) gives every Lambda function X-Ray active tracing, JSON logs and the metrics namespace, and every log group a **one-year retention** unless it sets its own. One year is a placeholder until the information security policy (`supply-checkout-4p1`) sets it. Metric names come from `backend/src/observability/names.ts`, so the dashboard, the alarms and the code that sends the metrics can't drift apart.

Logging and business metrics in the Lambda code are in [Backend](backend.md).

## Alarm recipients

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
