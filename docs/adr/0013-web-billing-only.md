# 0013. Web billing only; the mobile apps link to web checkout

- Status: Accepted
- Date: 2026-09-28 (proposed 2026-09-25)
- Note: The owner accepted this on 2026-09-28. Stripe's fees are about 7% of a monthly $9 charge, not 4–6% (see 0009); the conclusion stands. The store-rules spike is bead `supply-checkout-8jc.7`.

## Context

People should be able to choose a subscription from the iOS and Android apps. Our first draft sold subscriptions through App Store and Google Play in-app purchase (via RevenueCat) alongside Stripe. On review, the costs outweighed the benefits for this product:

- **Who pays.** The buyer is a team owner, a small business that usually finds us and sets up on the web. Crew members use the app but never pay. Store in-app purchase is designed for consumer apps, where the person on the phone is also the buyer.
- **Invoices.** Businesses need real invoices with their company name. Store purchases only produce Apple or Google consumer receipts.
- **Seats.** Store subscriptions have no quantity, so the apps could only sell fixed seat bundles rather than $3 per extra person.
- **Ownership.** A store subscription belongs to one person's Apple or Google account. If that person leaves the company, the team's billing leaves with them. An Apple ID can also hold only one subscription per group, so one owner couldn't pay for two teams.
- **Cost and complexity.**
  - Store commission (15%) plus RevenueCat (1% of tracked revenue above $2,500 a month) comes to about 16% of revenue, against about 4–6% for Stripe at our prices.
  - We'd run three billing sources, with rules to stop a team paying twice.
  - In-app purchases add their own App Store review rules.
- **Convenience.** Stripe Checkout supports Apple Pay and Google Pay, so paying on the web from a phone is one Face ID or fingerprint tap. That's close to in-app purchase.

## Decision

- **Stripe is the only billing system** ([ADR 0009](0009-billing-stripe.md)). No App Store or Google Play in-app purchase.
- **Owners can choose a plan in the app and pay on the web.** The in-app Plans screen shows the plans and lets the owner choose a plan and seat count. Tapping **Continue to checkout** opens Stripe Checkout in the system browser (Safari View Controller / Chrome Custom Tab), prefilled for the team, with Apple Pay and Google Pay on. When payment finishes, a universal/app link returns to the app, which updates live when the Stripe webhook lands ([ADR 0006](0006-api-and-realtime-sync.md)).
- **Where store rules allow the link.**
  - **App Store, US storefront**: apps may include buttons and links to outside purchasing without Apple's commission, following the 2025 court ruling.
  - **Google Play, US**: allowed only if Google's current US rules for external links permit it without extra fees; otherwise follow the fallback below.
  - A spike bead confirms both stores' current rules before the mobile apps are built.
- **Fallback where the link isn't allowed** (other countries, or if a store's rules change): the app shows no prices or purchase buttons. Owners see "Manage your plan at \<domain\>" as plain text, and teams that have already subscribed simply sign in. Apple allows this for apps that businesses provide to their own staff (guideline 3.1.3). The mobile apps launch in the US first.
- **Only owners** see the Plans screen. Other members see "Ask your team owner to upgrade".
- **Managing a plan** (seats, card, invoices, cancel) opens the Stripe Customer Portal the same way.

## Alternatives considered

| Option | Why not |
| --- | --- |
| **In-app purchase through RevenueCat alongside Stripe** (the earlier draft of this ADR) | Seat bundles instead of per-seat pricing, no business invoices, a subscription tied to one person's store account, about 16% fees, and three billing sources to keep in step. Revisit only if data shows owners abandoning web checkout started from the app. |
| **In-app purchase only in the apps, no link-out** | Same costs as above, without the web benefits. |
| **Apps sign-in only, no way to choose a plan** | Simplest, but doesn't meet the requirement to choose a subscription from the app. Kept as the fallback where store rules don't allow a link. |

## Consequences

- One billing system, one entitlement model, and our own invoices for every customer.
- Paying from the app costs one more screen than in-app purchase would.
- Store rules on outside links are still settling. The link-out sits behind a server-controlled feature flag ([ADR 0012](0012-cicd-releases-rollbacks.md)) so it can be turned off per platform or country without an app release.
- If we ever add in-app purchase, it will be a new ADR, and RevenueCat is the starting point.
