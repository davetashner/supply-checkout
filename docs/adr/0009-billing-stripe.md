# 0009. Stripe Billing for subscriptions, invoices and payments

- Status: Proposed
- Date: 2026-09-25

## Context

We need per-seat monthly subscriptions (chosen on the web or in the mobile apps, paid on the web; see [ADR 0013](0013-web-billing-only.md)), invoices customers can download, card changes and cancellations without contacting us, one-time charges (such as onboarding help or an extra receipt pack) and scheduled payments (such as annual plans, or a plan change that starts next month). Stripe's fee of about 2.9% + $0.30 per card charge takes about 13% of a single $3 seat, so pricing has to keep charges above a minimum amount.

## Decision

- **Stripe Billing**, with Stripe as the source of truth for money and our database as the source of truth for access.
- **Products and prices** come from the subscription tiers bead. Starting proposal, to be confirmed in the business plan:
  - **Starter**: $9/month includes 3 seats, then $3 per extra seat. 200 receipts a month per team.
  - **Annual**: 2 months free, billed once a year.
  - Seats are a quantity on the subscription. Adding a member updates the quantity with proration.
- **Stripe Checkout** for sign-up and upgrades; the **Customer Portal** for payment methods, invoices, plan changes and cancellation. We don't build card forms and never touch card numbers, which keeps us at PCI SAQ A.
- **Invoices**: Stripe generates and emails them. Owners also see the list in the app (fetched from Stripe) with links to the hosted invoice and PDF.
- **One-time payments**: Checkout in `payment` mode, or invoice items added to the next invoice.
- **Scheduled payments**: **subscription schedules** for future-dated plan changes and annual renewals; send-invoice collection (net 30) for customers who pay by invoice.
- **Tax**: Stripe Tax, turned on once we are registered where we have to collect.
- **Webhooks**: one endpoint (`/billing/webhook`) served in both regions. It checks the Stripe signature, stores the event ID for idempotency ([ADR 0005](0005-multi-tenant-dynamodb.md)), and puts the event on SQS; a worker updates the team's plan, seats and status. Handled events: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`.
- **Access rules**: `active` and `trialing` teams have full access. `past_due` teams keep full access through a 7-day grace period with a banner, then become read-only. `canceled` teams are read-only for 30 days (so they can export), then data is deleted as the privacy policy describes.
- **Trial**: 14 days, no card needed.

## Alternatives considered

- **Paddle / Lemon Squeezy (merchant of record).** They handle sales tax for us, at about 5% + $0.50 a transaction. Worth revisiting if we sell internationally before we can handle tax ourselves.
- **AWS Marketplace.** Wrong audience for small crews.

## Consequences

- Stripe keys live in AWS Secrets Manager, replicated to the second region. The webhook signing secret is rotated with the key.
- The billing Lambda is the only code allowed to change a team's plan or status.
- Stripe is the only billing system. The mobile apps send owners to Stripe Checkout and the Customer Portal rather than using App Store or Google Play in-app purchase ([ADR 0013](0013-web-billing-only.md)).
