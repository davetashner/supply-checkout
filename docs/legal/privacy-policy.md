# Privacy Policy

> **DRAFT — not reviewed by a lawyer / owner; not in effect, except as pilot terms (below).**
> Placeholders in `[BRACKETS]` must be filled in before publishing. See [Open questions](#open-questions-for-the-owner--lawyer) at the end.
>
> **Pilot terms.** During the supervised pilot, this draft applies as one of the pilot terms, as the [Pilot Agreement](pilot-agreement.md) (section 1) describes: in full, with Main Street Logic as "we" and the support mailbox as every contact. Where they disagree, the Pilot Agreement wins. A lawyer reviews this draft before public launch.

- Last updated: [DATE]
- Effective: [DATE]

This policy explains what **[COMPANY LEGAL NAME]**, a [STATE] [ENTITY TYPE] ("we", "us"), collects when you use Supply Checkout, why, who else handles it, how long we keep it, and the choices you have. It covers the website at [DOMAIN], the web app, the iOS and Android apps, and related services (together, "the Service"). It is part of our [Terms of Service](terms-of-service.md).

The Service is for businesses in the United States. We store and process data in the United States.

## The short version

- We collect what we need to run the Service: your account details, what your team puts in, billing details (through Stripe), and technical data such as logs and error reports.
- **We don't sell or share personal information** for advertising, and we don't use ad trackers.
- **We don't use your data to train AI models**, and neither does Amazon Bedrock, which reads receipts for us.
- **Receipt photos aren't stored.** They're sent to be read and then discarded.
- Owners can **export** the team's data at any time and **close** the team, which deletes it 30 days later (up to 44 days in rare billing cases). You can **delete your own account** in the app, and it's deleted straight away.
- Deleted data can stay in our backups for up to **35 days**, and then it's gone.

## 1. Who is responsible for what

- **Your team's data.** Everything a team puts into the Service (inventory, sheets, client names, prices, receipt results) belongs to the team (Terms, section 8). We handle it on the team's behalf and only to provide the Service. If you are a client of one of our customers, or a member of a team, and you have a question about data a team holds about you, please contact that business first. We will help them answer.
- **Account and billing data.** We are responsible for the data we collect to run accounts, bill customers, secure the Service and keep records the law requires.

## 2. What we collect

### You give us

| What | Examples | Where it comes from |
| --- | --- | --- |
| Account details | Email address, first and last name, sign-in method (email code, password, passkey, or Google or Apple sign-in), whether two-step sign-in is on | You, at sign-up and in Account settings. If you sign in with Google or Apple, they send us your email address, whether it is verified, and your name. |
| Team details | Team name, members and their roles, invitations (the invited email address and role) | Owners |
| Your team's data | Inventory items (names, barcodes, prices, costs, stock counts, pack sizes), checkout sheets, client or job names, dates, notes, stock history, CSV files you import | Owners and members |
| Receipts | Receipt photos you scan, and the lines, prices and totals read from them | Members who scan receipts |
| Billing details | Billing contact name, email and address, tax ID, the plan and seats, invoices and payment status | Owners, entered on Stripe's pages. **We never see or store your full card number.** |
| Messages to us | Support emails and what you tell us in them | You |

Please don't put sensitive information in the Service, such as payment card numbers, bank account numbers, government ID numbers, health information or passwords ([Acceptable Use Policy](acceptable-use.md)).

### We collect automatically

| What | Details |
| --- | --- |
| Server logs | When your device talks to our servers we record the time, your IP address, your browser's user agent, the page or API route, the result, and your account's internal ID. Our application logs record IDs and counts, not your email address, name or team data. |
| Error and performance reports | In the web app, JavaScript errors (the error message and where in our code it happened) and page speed measurements, tagged with the app version, through Amazon CloudWatch RUM. Before a report leaves your browser we remove web address query strings and anything that looks like an email address or sign-in token. Reports aren't linked to your account, and RUM records the browser, operating system and device type and may derive a coarse location (such as country) from your IP address. We don't record clicks, keystrokes or screen recordings. |
| Security records | Records of sign-ins, sign-in failures, and administrative actions in our cloud account, used to protect the Service and investigate problems. |
| Usage counts | Totals such as how many receipts a team read this month (for the plan's receipt limit), and how many teams were created or closed. |

Barcodes are read on your device. Barcode photos are not sent to us.

### We don't collect

- Precise location, contacts, or anything from your device beyond what's described here.
- Data from ad networks or data brokers.

## 3. How we use it

- **To provide the Service**: sign you in, keep your team's data, show it to your team's members, sync changes live between devices, read receipts you scan, and send the emails the Service needs (sign-in codes, invitations, trial, billing and account notices).
- **To bill**: create and manage your subscription with Stripe, keep the seat count in line with your team's billed members, and send billing notices.
- **To keep the Service secure and working**: find and fix errors, prevent abuse and fraud, enforce limits, and investigate security incidents.
- **To support you**: answer your questions. See [section 6](#6-support-access) for what our support staff can see.
- **To meet legal obligations**: keep tax and accounting records, and respond to lawful requests.
- **To improve the Service**: using combined, anonymous figures that can't identify you, your team or your clients.

We send transactional email only. We don't send marketing email. [If marketing email is added: say so here, with an unsubscribe link in every message.]

## 4. Receipt reading and AI

- When you scan a receipt, the Service sends the photo, your team's inventory list (item names and prices, up to 500 items) and our instructions to an AI model (Anthropic's Claude) running on **Amazon Bedrock**, through our servers. Your browser never talks to Bedrock directly.
- **Amazon Bedrock doesn't store your prompts or results, and doesn't use them to train any model**, and it doesn't share them with the model's maker. **We don't use your data to train AI models either.**
- **Receipt photos aren't stored.** The photo is shrunk on your device before it's sent, used for that one request, and discarded. We keep only the lines you choose to save after reviewing them.
- An unsaved receipt review is kept on your device (see [section 8](#8-cookies-and-storage-on-your-device)) so you don't lose it if the page reloads.
- We count receipts read per team for the plan's monthly limit, and record how much model processing each request used, to manage cost. These counts don't include the receipt's contents.

## 5. Who we share it with

We don't sell your personal information, and we don't share it for cross-context behavioral advertising. We share it only with:

| Who | What for | What they receive |
| --- | --- | --- |
| **Amazon Web Services** (United States) | Hosting, database, file storage, backups, sign-in (Amazon Cognito), live updates, logs and error reports (Amazon CloudWatch, including CloudWatch RUM), and security | Everything we store, encrypted at rest and in transit |
| **Amazon Bedrock** (part of AWS) | Reading receipt photos | The receipt photo, your team's inventory names and prices, and our instructions, for each scan |
| **Amazon Simple Email Service** (part of AWS) | Sending sign-in codes, invitations and notices | The recipient's email address and the message |
| **Stripe** | Payments, subscriptions, invoices and the billing portal | The team name, the billing contact details owners enter, the plan and seat count, and payment details, which go straight to Stripe. Stripe's [privacy policy](https://stripe.com/privacy) applies to what it collects. |
| **Google** and **Apple**, only if you choose to sign in with them | Signing you in | What their sign-in pages collect under their own privacy policies. They send us your email address, whether it's verified, and your name. |
| **Google Fonts** | Loading the app's typefaces | Your browser asks Google's servers for the font files, which sends Google your IP address and browser details. No cookies are set. |

We may also share information:

- **With your team.** Members of your team can see the team's data and the other members' names, email addresses and roles, depending on their role.
- **When the law requires it**, for example a valid subpoena or court order. Where the law allows, we tell the team's owners first.
- **To protect people and the Service**, when we reasonably believe it's needed to prevent fraud, abuse or harm.
- **In a business transfer**, such as a merger or sale of the business, under this policy's promises. We will tell owners before their data becomes subject to a different privacy policy.

A current list of the service providers that handle customer data is at [SUBPROCESSOR LIST LINK].

## 6. Support access

- Our support staff sign in with a separate, protected account that requires two-step sign-in.
- They can see a team's name, plan, seat count, subscription status and owners' email addresses, so they can help with accounts and billing. **They can't see your team's inventory, sheets, receipts or invitations.**
- Every action support takes on a team is recorded, and the team's owners can see those records under **Members → Support activity**.

## 7. How long we keep it

| Data | How long |
| --- | --- |
| Your account (email, name, sign-in methods) | Until you delete your account. Then it's deleted straight away. |
| Your team's data | While the team is open. When an owner closes the team, it's deleted 30 days later, or up to 44 days later in rare cases where its Stripe subscription can't be ended. Owners can reopen the team until an hour before then. |
| A team whose subscription ended or whose trial ended without a plan | Read-only for 30 days so owners can export, then deleted, as the Terms describe. |
| Invitations | Until accepted or revoked, or 7 days, whichever comes first. They're deleted when the team is closed. |
| The team's activity history (for example, who closed or reopened a team) | 1 year, or until the team is deleted if that's sooner. It names people by internal ID, not email. |
| Records of support actions on a team | 2 years, including after the team is deleted. They name support staff and the team by internal ID. |
| Short-lived records (in-progress imports and stock changes, sign-in code checks, daily limits) | From a few hours to 7 days |
| Deletion records | 400 days. When an account or team is deleted, we keep a record of its internal ID and the time (and for a team, the IDs Stripe gave its customer and subscription), and nothing else, so that restoring a backup can't bring it back and a deleted team's Stripe customer can still be found. |
| **Backups** | **Up to 35 days.** Deleted data stays in backups for up to 35 days after it's deleted, then the backups holding it expire. We use backups only to recover from mistakes and outages, and if we restore one we delete again every account and team deleted since it was taken. |
| Server logs and web access logs (including IP addresses) | 1 year |
| Security records of our cloud account | 400 days |
| Error and performance reports | 30 days |
| Email delivery problems | If a message to an address bounces permanently or is marked as spam, we stop sending to that address until its owner asks us to start again. Details of an undeliverable message are kept for up to 7 days. |
| Billing records at Stripe | When a team's data is deleted, we delete its Stripe customer. Stripe keeps payment and invoice records it must keep by law, under its own privacy policy. [We keep our own tax and accounting records for [7] years.] |
| Support emails | [PERIOD] |

When you delete your account, what you added to a team (items, sheets, receipts) stays with the team, because it belongs to the team. If you were the only member of a team, deleting your account closes that team, and it's deleted 30 days later. If you are the only owner of a team that has other members, make someone else an owner first.

## 8. Cookies and storage on your device

We don't use advertising or tracking cookies, and we don't use third-party analytics.

**Cookies**

| Name | Set by | What for | How long |
| --- | --- | --- | --- |
| `__Secure-sc_refresh` | Our API (`api.[DOMAIN]`) | Keeps you signed in. It's only sent to our sign-in endpoints and can't be read by scripts. | 30 days, renewed as you use the app; removed when you sign out |
| Sign-in session cookies | Amazon Cognito, on our sign-in page (`auth.[DOMAIN]`) | Remembers that you just signed in, so you aren't asked again straight away | [About an hour]; removed when you sign out |

**Storage in your browser** (these stay on your device and aren't sent to us)

| Key | What for | How long |
| --- | --- | --- |
| `supplyCheckout.team` | The team you last used | Until you sign out, or someone else signs in on the device |
| `supplyCheckout.receiptDraft.<team>` | An unsaved receipt review for that team (the lines read, not the photo) | Until you save or discard it, sign out, or someone else signs in |
| `supplyCheckout.owner` | Which account the saved team and receipt drafts belong to, so the next person to sign in can't see them | Until you sign out |
| `supplyCheckout.firstRun.<team>` | Whether you've finished or dismissed the getting-started checklist | Until you clear your browser's data |
| `supplyCheckout.theme` | Light or dark mode, if you chose one | Until you clear your browser's data |
| `supplyCheckout.signIn`, `supplyCheckout.invite` (this tab only) | Finishing a sign-in, and an invitation link you opened, across the trip to the sign-in page | Until the tab is closed or sign-in finishes |
| `cwr_i`, `cwr_c` | Anonymous, short-lived credentials the error reporter uses to send reports. They don't identify you. | Until they expire or you clear your browser's data |

These are all needed for the app to work as you'd expect, so there's no setting to turn them off. You can clear them in your browser at any time. We don't respond to "Do Not Track" signals differently, because we don't track you across sites. We treat a Global Privacy Control signal as a request to opt out of the sale or sharing of personal information, which we don't do anyway.

## 9. Your choices and rights

### In the app

- **See and export.** Owners can export all of the team's data as CSV and JSON files at any time (**Export data**), including while a closed or ended team is read-only.
- **Correct.** Owners and members can edit the team's data. Owners can update billing details in Stripe's billing portal (**Billing**). To correct your name or email address, contact us.
- **Delete your account.** **Account → Delete account**. It's deleted straight away, and you're signed out everywhere.
- **Close the team.** Owners can close the team from **Members**. Its data is deleted 30 days later (up to 44 days in rare billing cases).
- **Leave a team.** Any member can leave. Owners can remove members.

### California residents

The California Consumer Privacy Act (CCPA) gives California residents these rights about their personal information:

- **To know** what personal information we collect, use and disclose, and to get a copy of it.
- **To delete** it, with some exceptions (for example, records we must keep by law).
- **To correct** it if it's inaccurate.
- **To opt out of the sale or sharing** of it. We don't sell or share personal information, and haven't in the last 12 months.
- **To limit the use of sensitive personal information.** We collect sign-in credentials only to sign you in, and use no sensitive personal information for any other purpose.
- **Not to be discriminated against** for using these rights.

In the last 12 months we have collected these categories of personal information, from the sources and for the purposes in sections 2 and 3, and disclosed them for business purposes to the service providers in section 5: identifiers (name, email address, IP address, account ID); customer records (billing contact details); commercial information (plan, subscription and invoices); internet activity (logs and error reports); and professional information (team membership and role). We collect account login credentials, which are sensitive personal information, only to sign you in.

To use these rights, email [PRIVACY EMAIL] or use the in-app tools above. We'll confirm your request within 10 business days and answer within 45 days (we may extend that by another 45 days and will tell you if we do). We verify requests by checking that they come from the email address on the account, and may ask for more if we need it. An authorized agent may make a request for you with your signed permission, and we may ask you to confirm it directly. If your information is in a team's data, we may pass your request to that team, since we hold that data for them.

### Other states

Residents of other states with consumer privacy laws (for example Colorado, Connecticut, Virginia, Oregon and Texas) may have similar rights, including to appeal a decision we make about a request. Email [PRIVACY EMAIL] with "Appeal" in the subject line. [Confirm which state laws apply, given that the Service is business-to-business.]

## 10. Security

- Data is encrypted in transit (HTTPS) and at rest (AWS Key Management Service).
- Each team's data is kept separate: every request is checked against the team's membership, and our cloud permissions only let a request reach the team it's for.
- Sign-in supports passkeys and two-step sign-in. Owners must use two-step sign-in (or sign in with Google or Apple) before changing billing.
- Access to production systems is limited, requires strong sign-in, and is recorded.

No system is perfectly secure. If a breach affects your personal information, we will tell you and the authorities as the law requires. To report a security problem, see the [Acceptable Use Policy](acceptable-use.md#reporting-problems).

## 11. Children

The Service is for businesses, and users must be at least 18. It isn't directed at children, and we don't knowingly collect personal information from anyone under 18. If you think a child has given us personal information, contact us at [PRIVACY EMAIL] and we will delete it.

## 12. Where data is stored

We store and process data in the United States, in AWS's US East (N. Virginia) region. [When the second region launches: and US West (Oregon).] The Service isn't offered outside the United States.

## 13. Changes to this policy

If we change this policy in a way that matters, we will email team owners and show a notice in the app at least 30 days before the change takes effect. The date at the top shows when it last changed. We won't use personal information in a materially different way from what this policy described when we collected it without your consent.

## 14. Contact

[COMPANY LEGAL NAME]
[MAILING ADDRESS]
Privacy questions and requests: [PRIVACY EMAIL]
Support: [SUPPORT EMAIL]

---

## Open questions for the owner / lawyer

1. **Legal entity and contacts.** Name, type and state (bead `supply-checkout-ar0`), mailing address, and whether privacy requests go to [SUPPORT EMAIL] or a separate [PRIVACY EMAIL]. CCPA asks for at least two ways to submit requests (typically an email and a web form or toll-free number); an online-only business with a direct customer relationship may use an email address alone. Confirm.
2. **Does the CCPA apply to us at all?** It applies to for-profit businesses over $26.6M (inflation-adjusted) in revenue, or that buy, sell or share data of 100,000+ consumers, or that make half their revenue from selling or sharing. At launch we meet none of these. The draft includes the CCPA section anyway, as the bead asks, because it's easy to honor and customers expect it. Keep it, or say we honor the rights voluntarily? The same question for other states' laws, most of which exempt data about people acting in a business role.
3. **Service provider role.** Should we sign a data processing addendum with customers so we are clearly their "service provider" for team data (bead `supply-checkout-q3g`, phase 2)? Until then, is section 1 enough?
4. **What's built versus what this draft says.** Where the code and a bead or the Terms disagree, this draft follows the code, except where the Terms already promise something. Differences:
   - **Receipt reading on AWS isn't built yet** (bead `supply-checkout-kx8`). The web app hides "Scan receipt" today. Section 4 describes the design in ADR 0008 (accepted): photos sent through our server to Bedrock and not stored. Check it against the code when it ships, including what's logged per call (the bead asks for token usage only).
   - **Photo storage.** Decided 2026-10-01: dropped from the MVP. Photos are never stored, and ADR 0008 and Terms section 9 say so. A team setting to keep photos may return as a phase-2 feature; this policy and the Terms must change before it ships.
   - **Deleting ended teams.** The Terms (sections 4 and 6) and bead `supply-checkout-qdx` say a team whose trial or subscription ended is read-only for 30 days and then deleted. Today the code makes a team read-only when its Stripe subscription ends, but nothing deletes it: only teams an owner closes are purged (after 30 days). A trial that ends without Checkout isn't made read-only either. Section 7 follows the Terms. Bead `supply-checkout-qdx` must build the deletion before launch, or the Terms and this policy must change.
   - **Support activity records** (ADR 0015) are kept 2 years and aren't deleted with the team. They hold the team's ID, the support person's ID, the action, the reason typed, and before and after values of the fields changed (plan and comp details). Confirm that's acceptable, or have the purge delete them.
   - **Team activity history** (audit events) is kept 1 year (`AUDIT_RETENTION_DAYS`). A deleted user's ID stays in their former teams' history until it expires. It's a random ID nothing links to a person after deletion.
5. **Backups: 35 days.** Matches `LOCAL_RETENTION` and PITR in `infra/lib/backup.ts` and ADR 0003 as accepted (prod account only, no backup account, deployed with `-c backupCopy=false`). If the separate backup account is ever set up, its copies keep 90 days (`COPY_RETENTION`) and this policy and the Terms must change first. AWS removes an expired recovery point shortly after it expires, not to the minute: should the wording allow a few days' margin?
6. **Log retention.** Lambda logs, API access logs (IP address, user agent, account ID) and CloudFront access logs are kept 1 year (`LOG_RETENTION` in `infra/lib/observability/defaults.ts`, the logs bucket's lifecycle in `infra/lib/stacks/data-stack.ts`). That's a placeholder until the information security policy (bead `supply-checkout-4p1`) sets it. CloudTrail keeps 400 days (`TRAIL_LOG_RETENTION_DAYS`). Is a year of IP addresses more than we need? 90 days would be easier to defend.
7. **Stripe and our own financial records.** How long do we keep invoices and tax records ourselves (the draft says [7] years in brackets)? Stripe keeps its own under its policy. Should the draft name Stripe Tax if we turn it on?
8. **Google Fonts.** The app loads its fonts from Google, which sends Google each visitor's IP address. Self-hosting the fonts would remove Google from section 5 (see follow-up below). Keep it or self-host before launch?
9. **Cognito's sign-in cookies.** Amazon Cognito's Managed Login sets its own session cookies on `auth.[DOMAIN]`; the draft says "about an hour" (Cognito's documented session length). Confirm the names and lifetime on the deployed sign-in page before publishing.
10. **CloudWatch RUM metadata.** The draft says RUM may derive a coarse location from IP addresses and records browser, OS and device type. Check the deployed app monitor's events and adjust.
11. **Product analytics.** Bead `supply-checkout-khc` plans "privacy-friendly" analytics. When it's built, update sections 2, 5 and 8, and decide whether it needs a consent choice.
12. **Marketing email.** None today. If the landing page collects addresses or we send newsletters, add an opt-in and unsubscribe.
13. **Mobile apps.** The iOS and Android apps (phase 2) need App Store privacy labels and Google Play data safety answers that match this policy. Check what the apps store on the device (the same keys as the web app, or more) and whether they use any SDK that collects data.
14. **The claude.ai artifact.** The current version of Supply Checkout runs as a claude.ai artifact, where Anthropic hosts the data under its own terms. This policy covers only the AWS service. Do existing artifact users need a notice when they move?
15. **Children.** The Terms require users to be 18, so the draft says we don't knowingly collect data from anyone under 18 (stricter than COPPA's 13). Confirm.
16. **Law enforcement requests.** The draft promises to tell owners first where the law allows. Confirm we want to commit to that.
17. **Correcting name and email.** There's no change-of-email flow in the app yet, so the draft says to contact us. Update when there is one.
