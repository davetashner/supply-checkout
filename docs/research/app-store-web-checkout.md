# App Store and Google Play rules for linking to web checkout

- Bead: `supply-checkout-8jc.7`
- Researched: 2026-09-25 (all sources below read on that date)
- Question: can the iOS and Android apps let a team owner choose a plan and continue to Stripe Checkout on the web, as [ADR 0013](../adr/0013-web-billing-only.md) proposes? Can they show prices? What does it cost?

This is a reading of the published rules, not legal advice. Both stores' rules are still moving because of the Epic cases, so re-check before the mobile apps ship (bead `supply-checkout-8jc.5`).

## Where this differs from ADR 0013

ADR 0013 mostly holds, but three points need changing when the ADR is next revised:

1. **Google Play, US: the link-out costs a fee.** ADR 0013 allows the Android link only "if Google's current US rules for external links permit it without extra fees". They don't. Linking out needs enrollment in Google's **external content links program**, which charges **10% on auto-renewing subscriptions** bought within 24 hours of the user tapping the link. Fees are payable from October 1, 2026 (the first reporting and payment deadline is December 1, 2026). Under the ADR's own rule, Android falls back to no link. We need to decide between paying 10% on those purchases and using the fallback.
2. **Apple, US: free today, but not settled.** Apple charges no commission on US link-out purchases today. The Ninth Circuit ruled in December 2025 that Apple may charge *some* commission, the amount is back with the district court, and the Supreme Court has agreed to hear Apple's appeal. The ADR's "without Apple's commission" is true now but could change. The feature flag the ADR already plans is the right control.
3. **The fallback wording outside the US is too close to steering.** Outside the US, both stores forbid in-app wording that points users to buying elsewhere. "Manage your plan at \<domain\>" is risky on both stores. Outside the US (and on Android in the US, if we take the fallback), the app should say nothing about plans, prices or where to pay. Owners who sign in to a subscribed team just use it, and non-subscribed owners see a neutral "This team doesn't have an active plan" or nothing.

## Bottom line for this product

| | iOS, US storefront | iOS, other storefronts | Android, US users | Android, elsewhere |
| --- | --- | --- | --- | --- |
| Link or button to Stripe Checkout | **Yes** | No | **Yes, with enrollment and a fee** | No (EEA: only through a separate paid program) |
| Show prices in the app | **Yes** | No | Yes | No |
| Fee on web purchases from the link | **0% today** (may change) | n/a | **10%** of subscriptions bought within 24 h of the link | n/a |
| Must also offer in-app purchase | No (see "Why no IAP" below) | No, under 3.1.3(c) | No | No, if the app sells nothing |
| Signing in to a team paid for on the web | Yes | Yes | Yes | Yes |

Recommended:

- **iOS, US:** ship the Plans screen, prices and **Continue to checkout** as ADR 0013 describes, behind the per-platform, per-country flag.
- **Android, US:** decide before `supply-checkout-8jc.5`. At $3/user/month, 10% of link-driven sign-ups is small, but it adds enrollment, Google's link-out APIs and transaction reporting. The cheap path is the fallback: no link, no prices on Android.
- **Everywhere else:** the silent fallback. No prices, no purchase buttons, no domain for billing.

## Apple App Store

Sources:

- App Review Guidelines, section 3.1: <https://developer.apple.com/app-store/review/guidelines/#payments>
- "Updated guidelines now available", May 1, 2025: <https://developer.apple.com/news/?id=9txfddzf>
- Apple Form 10-Q for the quarter ended June 27, 2026 (Epic proceedings): <https://www.sec.gov/Archives/edgar/data/0000320193/000032019326000020/aapl-20260627.htm>
- Apple developer news index (EU, Japan, Brazil changes): <https://developer.apple.com/news/>
- StoreKit External Purchase docs: <https://developer.apple.com/documentation/storekit/external-purchase>

### United States storefront

On May 1, 2025 Apple changed guidelines 3.1.1, 3.1.1(a), 3.1.3 and 3.1.3(a) to comply with the Epic v. Apple injunction. The current text of 3.1.1(a):

> These entitlements are not required for developers to include buttons, external links, or other calls to action in their United States storefront apps.

and, on the ban on steering in other storefronts:

> In all other storefronts, except for the United States storefront, where this prohibition does not apply, apps and their metadata may not include buttons, external links, or other calls to action that direct customers to purchasing mechanisms other than in-app purchase.

3.1.3 (apps allowed to use other purchase methods) has the same carve-out:

> Apps in this section cannot, within the app, encourage users to use a purchasing method other than in-app purchase, except for apps on the United States storefront and as set forth in 3.1.1(a) and 3.1.3(a).

So in the US storefront the app may show plans and prices, and a **Continue to checkout** button that opens Stripe Checkout. No entitlement or StoreKit link API is needed, and there's no required disclosure sheet. The guidelines set no wording rules for US links beyond the general bans on misleading marketing and bait-and-switch (3.1.1(a), 3.1.2(a)). Before asking someone to subscribe, 3.1.2(c) still expects the app to say clearly what they get for the price.

**Commission.** Apple currently charges no commission on US link-out purchases. From Apple's 10-Q:

> On December 11, 2025, the Ninth Circuit Court issued an order upholding the 2025 Injunction in part and modifying certain aspects to allow the Company to require parity in size, form and placement between the Company's in-app purchase and any links for consumers to make purchases outside an app. The Ninth Circuit Court also held that the Company can charge some commission on link-out purchases, and remanded to the California District Court ...

> On June 30, 2026, the Supreme Court granted the Company's petition to review the applicable legal standard for civil contempt.

What that means for us:

- A future Apple commission on US link-out purchases is possible. The Ninth Circuit limited it to costs "genuinely and reasonably necessary" for coordinating external links, well below the 27% Apple wanted, but no number exists yet.
- The "parity" rule only applies when an app offers in-app purchase *and* a link. We don't offer in-app purchase, so it doesn't affect us.

### Why no IAP (and the classification risk)

Guideline 3.1.1 still says subscriptions that unlock features "must use in-app purchase". The US carve-out removes the ban on *links*, but on its own it doesn't clearly remove the IAP requirement for every app. Our basis for not offering IAP at all is **3.1.3(c) Enterprise Services**:

> If your app is only sold directly by you to organizations or groups for their employees or students (for example professional databases and classroom management tools), you may allow enterprise users to access previously-purchased content or subscriptions. Consumer, single user, or family sales must use in-app purchase.

Supply Checkout is sold to businesses for their crews, which fits. The risk is a reviewer treating a one-person team as a "single user" sale. To reduce that risk:

- Present the app and store listing as a business/team tool: teams, crews, owners, invoices.
- Only owners see plans. Members see "Ask your team owner to upgrade" (already in ADR 0013).
- In App Review notes, say that the app is sold only to businesses for their staff under 3.1.3(c).

3.1.3(b) Multiplatform doesn't help, because it requires the items to also be available as in-app purchases. 3.1.3(f) Free stand-alone apps allows no purchase calls to action at all, except where the US carve-out applies.

### Other storefronts

- **Default (most countries):** no buttons, links or calls to action to outside purchasing (3.1.1(a), 3.1.3). Under 3.1.3(c) the app may let users of a subscribed team sign in and use it. Showing prices or pointing to where to pay counts as encouraging another purchase method. The External Link Account Entitlement is only for "reader" apps (3.1.3(a)), and we aren't one.
- **EU, Japan, Brazil, South Korea, Netherlands (dating only), and a few others:** Apple offers link-out or alternative payment entitlements, each with its own commission and addendum. For example, from October 1, 2026 the EU moves to single business terms that include a 5% Core Technology Commission on digital sales outside the App Store (<https://developer.apple.com/news/?id=gmws0jgp>). These need applications, the StoreKit disclosure sheet and reporting. They aren't worth it before the apps launch outside the US.

## Google Play

Sources:

- Payments policy: <https://support.google.com/googleplay/android-developer/answer/9858738>
- "An update regarding Google Play's policies for developers serving users in the US" (updates through September 17, 2026): <https://support.google.com/googleplay/android-developer/answer/15582165>
- "Enrolling in the external content links program for users in the US" (updated July 22, 2026): <https://support.google.com/googleplay/android-developer/answer/16470497>
- "Expanded billing choice and lower fees on Google Play", June 2026: <https://android-developers.googleblog.com/2026/06/play-expanded-billing.html>
- External offers program (EEA): <https://support.google.com/googleplay/android-developer/answer/14372887>

### United States

After the Epic v. Google injunction (in force October 29, 2025), Google states:

> Google will not require the use of Google Play Billing in apps distributed on the Google Play Store, or prohibit the use of in-app payment methods other than Google Play Billing.

> Google will not prohibit a developer from communicating with users about the availability or pricing of an app outside the Google Play Store, and will not prohibit a developer from providing a link to download the app outside the Google Play Store or link to transactions.

But since December 9, 2025 Google has required US apps that link out to do it through one of its programs. For us that's the **external content links program**:

- **Enrollment first.** "Developers must ... successfully complete their enrollment in this program prior to using external content links."
- **Google's APIs and an information screen.** Apps must "integrate with the external content links APIs, which surface an information screen, enable parental controls, and facilitate transaction reporting", and "external content links must inform the user about the destination page and its purpose in the app before linking out".
- **Play Billing is optional.** The wording is "If using Google Play Billing with this program, all users must be able to access Google Play Billing in a consistent and reliable manner." An app with only the link is allowed.
- **Fees.** Charged on transactions a user completes **within 24 hours of following a link**: **10% for auto-renewing subscriptions**, and 10–20% for other digital purchases depending on earnings tier and install date. Web sign-ups that don't come from the in-app link aren't charged.
- **Reporting.** Every transaction must be reported through the API, including $0 free-trial starts. Fees are payable from October 1, 2026, with the first deadline extended to December 1, 2026 (update of September 17, 2026).
- **Still changing.** Google says "On March 4, 2026, we entered a new settlement agreement with Epic and the parties have asked the US District Court to enter a revised Modified Injunction. More details will be provided in the coming months."

Google's June 2026 fee restructuring (a 10% service fee plus a separate 5% billing fee only when Google Play Billing is used) confirms that the 10% service fee applies to subscriptions whichever way they're paid.

Without enrolling, the Payments policy's anti-steering rule (section 4) applies. The app may let subscribed teams sign in, but may not "lead users to a payment method other than Google Play's billing system" through "in-app webviews, buttons, links, messaging, advertisements, or other calls to action", including in account sign-up flows. None of the Payments policy exemptions (physical goods, peer-to-peer, gambling, and so on) covers business SaaS.

### Outside the US

- **EEA (and the UK from June 30, 2026):** link-outs are possible through the external offers / billing choice programs, with their own service fees, information screens and reporting. Not worth it before we launch there.
- **Other countries:** no link-outs. The app can let subscribed teams sign in, but must stay silent about buying elsewhere.

## Suggested changes to ADR 0013

For the ADR's next revision (which this spike's acceptance criteria ask for, done separately):

- **App Store, US:** confirmed. Note that the zero commission is current as of September 2026, the Ninth Circuit allows a future cost-based commission, and the Supreme Court review is pending. Cite 3.1.3(c) as the reason for no IAP.
- **Google Play, US:** say the link needs enrollment in the external content links program, Google's link APIs and information screen, transaction reporting, and a **10%** fee on subscriptions bought within 24 hours of the link. Then either accept the fee or put Android US on the fallback.
- **Fallback:** say nothing about plans, prices or where to pay, instead of "Manage your plan at \<domain\>". Owners manage billing from the website, and we tell them in email or on the website, which both stores allow ("Developers can send communications outside of the app to their user base", guideline 3.1.3).
- **Fallback countries:** every App Store storefront except the US, and every Google Play country except the US (and Android US too, if we don't enroll).
