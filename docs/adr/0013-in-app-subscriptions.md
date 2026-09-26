# 0013. In-app subscriptions on iOS and Android

- Status: Proposed
- Date: 2026-09-25

## Context

People should be able to choose and buy a subscription inside the iOS and Android apps, not only on the website. The two stores set the rules:

- **Apple** requires In-App Purchase (StoreKit) for digital subscriptions bought inside an app (App Store guideline 3.1.1). On the US storefront, apps may also link out to a web checkout without Apple's commission, following the 2025 court ruling. Check the current rules before relying on it.
- **Google Play** requires Play Billing for in-app digital subscriptions. Its alternative-billing and external-offer programs vary by country and carry their own fees.
- Store commission on subscriptions is **15%**: Apple's Small Business Program (under $1M a year) and Google Play subscriptions. That compares with Stripe's roughly 2.9% + $0.30.
- Store subscriptions have **no seat quantity**. A subscription is one product at one price, bought by one Apple or Google account. And an Apple ID can hold only **one active subscription per subscription group**.

Web billing through Stripe ([ADR 0009](0009-billing-stripe.md)) stays the main path, and the only path that supports any number of seats and our own invoices.

## Decision

- **Sell subscriptions in both apps with native store billing**, through **RevenueCat** (`@revenuecat/purchases-capacitor`). RevenueCat wraps StoreKit 2 and Play Billing, checks receipts on its servers, and sends one webhook format for both stores. That saves us from building App Store Server Notifications and Google real-time notifications twice.
- **Store products are seat bundles.** One subscription group ("Team plan") with levels such as Crew 3, Crew 10 and Crew 25, each monthly and annual. Upgrades and downgrades between levels are handled by the store. Exact bundles and prices come from the subscription tiers bead. Store prices may be set a little higher than the web to cover the 15%.
- **The team is the customer.** The RevenueCat app user ID is the team ID, so the subscription belongs to the team, not the phone. Only a team **owner** sees the purchase screen. Contributors and viewers see "Ask your team owner to upgrade".
- **One entitlement model, three billing sources.** The team record gets `billingSource` (`stripe`, `app_store`, `play`) along with `plan`, `seatLimit`, `status` and `periodEnd`. A RevenueCat webhook Lambda (signature checked, idempotent, queued on SQS like Stripe events) updates the same fields that Stripe events update. The access rules in ADR 0009 (trial, grace, read-only) apply whatever the billing source.
- **No double billing.**
  - A team can have only one active source. The app and the web both check `billingSource` before showing a purchase flow.
  - A team paying through a store that wants to switch to web billing (to get more seats or invoices) is walked through cancelling in the store first. Web billing starts when the store period ends.
  - Because of Apple's one-subscription-per-group rule, an owner of two teams can buy only one of them with the same Apple ID. The second team gets a "subscribe on the web" path.
- **Web link-out where allowed.** On the US App Store storefront, the purchase screen also offers "Subscribe on the web" to Stripe Checkout, for teams that want per-seat pricing or invoices. Outside the US, and on Google Play until its US rules settle, the apps show store billing only.
- **Store requirements**:
  - Restore Purchases button.
  - Link to manage the subscription in iOS Settings or the Play Store.
  - Price, period, trial terms, and links to the terms and privacy policy on the purchase screen (guideline 3.1.2).
  - Family Sharing turned off.
  - Refunds and chargebacks from the stores revoke access through the webhook.
- **Invoices**: store buyers get Apple or Google receipts, not our Stripe invoices. The billing screen says so, and points businesses that need proper invoices to web billing.

## Alternatives considered

| Option | Why not |
| --- | --- |
| **No in-app purchase; sign-in only** (the earlier draft of ADR 0011) | Doesn't meet the requirement: people must be able to subscribe from the app. |
| **Link out to web checkout only** | Allowed on the US App Store storefront, but not in other countries, and Google Play's rules differ. Store review risk stays high. |
| **Build StoreKit and Play Billing directly** | Saves RevenueCat's fee (see Cost below), but means two server integrations, receipt checking, and a lot of edge cases (grace periods, billing retry, refunds, upgrades between levels). Revisit if volume makes the fee significant. |
| **Consumable "seat packs"** | Doesn't fit an ongoing subscription, and Apple reviews it poorly for this use. |

## Cost

RevenueCat's Pro plan (checked 2026-09-25 at revenuecat.com/pricing) is free up to $2,500 a month of tracked revenue, then 1% of tracked revenue, with no monthly fee and every feature included. Only store purchases go through RevenueCat, so Stripe web revenue adds nothing. Confirm whether the 1% applies to all tracked revenue or only the amount above $2,500.

| Monthly store revenue | RevenueCat | Store fee (15%) | Total fees |
| --- | --- | --- | --- |
| $1,000 | $0 | $150 | 15% |
| $10,000 | about $100 | $1,500 | about 16% |

For comparison, Stripe on a $9 web charge takes about $0.56 (6%), and on a $30 charge about $1.17 (4%).

## Consequences

- Store-billed teams bring in about 12 points less margin than web-billed teams. The business plan's cost model has to show both.
- Seat counts for store teams are capped by bundle, not billed per seat. Adding a member beyond the bundle asks the owner to move up a level.
- Another processor (RevenueCat), plus Apple and Google, go into the privacy policy and subprocessor list.
- Journey tests add store purchase flows, using StoreKit configuration files and Play license testers in CI and on real devices before each mobile release.
- The mobile apps are still `phase-2` in the backlog. In-app subscriptions ship with them.
