# Infrastructure

`infra/` is the AWS CDK v2 app for the subscription product ([ADR 0002](adr/0002-serverless-aws-with-cdk.md)). It is a separate npm package with its own lockfile, so run its commands from `infra/` (or with `npm --prefix infra run …`).

```bash
cd infra
npm ci
npm run lint        # tsc type-check and ESLint
npm test            # vitest: config, stack layout, template snapshots, cdk-nag (every stack in each region)
npm run synth       # cdk synth; cdk-nag AwsSolutions fails it on any finding
npm run synth:all-regions  # the same for every approved region (-c regions=all)
npm run test:update # accept template snapshot changes after reviewing them
```

**Stacks.** Every stack is named `supply-checkout-<env>-<region>-<component>`. Each region in the environment gets `domain` (certificates, DNS records and the SES domain; see [Domain and email](#domain-and-email)), `data` (stateful: table, keys, buckets), `api` and `realtime` (stateless), and `observability`. The primary region also gets `identity` (stateful: Cognito) and `email` (bounce and complaint handling; see [Transactional email](#transactional-email)). `GLOBAL_SERVICES_REGION` gets `web` (CloudFront and WAF, which AWS requires there; see [Web hosting and releases](web-app.md#web-hosting-and-releases)), and always has a `domain` stack, because CloudFront, Cognito and AppSync only accept certificates from there. Stateful stacks have termination protection. Every stack writes `/supply-checkout/<env>/<component>/stack` to SSM Parameter Store, and later stacks publish their outputs beside it. All resources are tagged `app=supply-checkout`.

**Regions.** The MVP runs in **us-east-1 only**. Every stack takes its region as a parameter, and the tests and CI also synthesize us-west-2 (`synth:all-regions`), so turning on the second region from [ADR 0010](adr/0010-multi-region-active-active.md) is a config change: add it to `DEFAULT_REGIONS` in `lib/config.ts`. CDK is already bootstrapped in us-west-2. `lib/config.ts` is the only file in `infra/`, `backend/` or `src/` that may name a region: it holds `APPROVED_REGIONS`, `DEFAULT_REGIONS` and `GLOBAL_SERVICES_REGION` (where AWS requires CloudFront's certificate and WAF, and where Cognito lives). Stacks get their region as a parameter, Lambdas read `AWS_REGION`, and tests import the constants. `npm run check:regions` (in CI and the pre-commit hook) enforces this.

**Parameters.** The environment and regions are CDK context (`cdk.json` sets `envName=prod`; `regions` defaults to `DEFAULT_REGIONS` and `primaryRegion` to the first of them); override them with `-c envName=staging -c regions=all` (or a comma-separated list, with `-c primaryRegion=...`). Only the regions in `APPROVED_REGIONS` (`lib/config.ts`) are allowed. The account ID is never committed: it comes from the AWS profile at synth time, and a synth without credentials (CI, tests) is account-agnostic.

**The `app` table.** The primary region's `data` stack holds the single DynamoDB table from [ADR 0005](adr/0005-multi-tenant-dynamodb.md), `supply-checkout-<env>-app`. It's a `TableV2` (`AWS::DynamoDB::GlobalTable`) with one replica, in its own region: on-demand, encrypted with a customer-managed KMS key that rotates yearly, point-in-time recovery, deletion protection, a stream with new and old images, TTL on `expiresAt`, and one index, `GSI1`. Adding the us-west-2 replica in phase 2 is another entry in `replicas` with that region's key, not a new table. The data stack publishes `table-name`, `table-arn`, `table-stream-arn` and `table-key-arn` to SSM under `/supply-checkout/<env>/data/`. The key and index names come from `backend/src/data/schema.ts`, so the table and the code that reads it can't drift apart.

**cdk-nag.** `AwsSolutionsChecks` is registered as a CDK validation plugin, so every synth and deploy fails on an unacknowledged finding. When a finding is intended, acknowledge it on the narrowest construct with a written reason:

```ts
Validations.of(bucket).acknowledge({ id: "AwsSolutions-S1", reason: "…why this is safe…" });
```

**Deploying** (until the pipeline in [ADR 0012](adr/0012-cicd-releases-rollbacks.md) takes over). Before the first deploy, create the SSM parameters the stacks read: the hosted zone and DMARC report address ([Domain and email](#domain-and-email)) and the alarm recipients ([Observability](observability.md#alarm-recipients)).

```bash
aws sso login --profile supply-prod
cd infra
npx cdk bootstrap --profile supply-prod        # once per account and region; bootstraps every region in the app
npx cdk diff --profile supply-prod
npx cdk deploy --all --profile supply-prod
```

## Domain and email

`lib/domain.ts` names every host, and each region's `domain` stack (`lib/stacks/domain-stack.ts`) holds the certificates and records for them (`supply-checkout-m64`). Prod serves `supplycheckout.com` itself; any other environment serves `<env>.supplycheckout.com` from a zone in its own account.

| Name | What serves it | Certificate |
| --- | --- | --- |
| apex, `www.` | the demo at `/demo/`; other paths redirect to `app.` until the landing page (CloudFront) | `web`, in `GLOBAL_SERVICES_REGION` |
| `app.` | the web app (CloudFront) | `web`, in `GLOBAL_SERVICES_REGION` |
| `auth.` | Cognito Managed Login | `auth`, in `GLOBAL_SERVICES_REGION` |
| `realtime.` | AppSync Events | `realtime`, in `GLOBAL_SERVICES_REGION` |
| `api.` | the HTTP API, in every region | `api`, in each region |
| `mail.` | SES custom MAIL FROM (MX and SPF) | none |

The certificates are validated by DNS in the zone; CloudFormation adds the validation records and waits a few minutes for issuance. Each ARN is published to SSM as `/supply-checkout/<env>/domain/<name>-certificate-arn`, in the stack's region. The names start to resolve when the stacks that use them add their alias records: `web` (`supply-checkout-qk1`), `identity` (`supply-checkout-zsm`), `api` and `realtime`. Those stacks import the zone with `importZone()` from `lib/domain.ts`.

In the primary region, the stack also creates the SES domain identity with Easy DKIM (three CNAMEs), the `mail.` MAIL FROM domain, SPF on the apex (`v=spf1 include:amazonses.com -all`) and DMARC at `p=none`. SES in the second region is phase 2 (`supply-checkout-3x3.1`).

**The hosted zone is imported, never created.** Prod's zone was created by hand when the domain was delegated from Namecheap. The stack reads its ID from the SSM parameter `/supply-checkout/<env>/dns/hosted-zone-id` at deploy time (a CloudFormation SSM parameter), rather than `HostedZone.fromLookup`, so synth stays account-agnostic in CI and the zone ID never lands in `cdk.context.json`. DMARC aggregate reports go to the address in `/supply-checkout/<env>/dns/dmarc-rua`. Use a DMARC report service's `mailto:` address, not a personal mailbox at another domain: receivers drop reports to another domain unless that domain publishes an authorization record, which personal mail providers don't. Create both parameters before the first deploy, in each region with a `domain` stack (today, us-east-1):

```bash
aws sso login --profile supply-prod
ZONE_ID=$(aws route53 list-hosted-zones-by-name --profile supply-prod --dns-name supplycheckout.com \
  --query "HostedZones[?Name=='supplycheckout.com.'].Id | [0]" --output text | sed 's|/hostedzone/||')
aws ssm put-parameter --profile supply-prod --region us-east-1 --type String \
  --name /supply-checkout/prod/dns/hosted-zone-id --value "$ZONE_ID"
aws ssm put-parameter --profile supply-prod --region us-east-1 --type String \
  --name /supply-checkout/prod/dns/dmarc-rua --value 'mailto:dmarc-reports@example.com'   # your DMARC report service's address
# The stack adds TXT records at the apex and _dmarc, and MX and TXT at mail.
# If any of those already exist in the zone, the deploy fails: remove them, or
# merge their values into lib/stacks/domain-stack.ts first.
aws route53 list-resource-record-sets --profile supply-prod --hosted-zone-id "$ZONE_ID" \
  --query "ResourceRecordSets[?Type!='NS' && Type!='SOA'].[Name,Type]" --output text
cd infra
npx cdk deploy supply-checkout-prod-us-east-1-domain --profile supply-prod
```

**Then, by hand:**

1. Check the identity is verified (DKIM `SUCCESS`, MAIL FROM `SUCCESS`; DNS can take up to an hour):
   ```bash
   aws sesv2 get-email-identity --profile supply-prod --region us-east-1 --email-identity supplycheckout.com \
     --query '{sending:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}'
   ```
2. Request SES production access. New accounts are in the sandbox (200 messages a day, verified recipients only). AWS answers within about a day, and may ask follow-up questions by email:
   ```bash
   aws sesv2 put-account-details --profile supply-prod --region us-east-1 \
     --production-access-enabled --mail-type TRANSACTIONAL --contact-language EN \
     --website-url https://supplycheckout.com \
     --additional-contact-email-addresses you@example.com \
     --use-case-description "Transactional email for Supply Checkout, a subscription app for tracking supplies checked out to client jobs: team invitations, sign-in and account notices, and billing receipts, sent only to users of a team and people a team member invites. No marketing or purchased lists. Bounces and complaints go to an SNS topic; addresses that hard-bounce or complain are suppressed with the SES account-level suppression list, and we alarm on bounce and complaint rates."
   aws sesv2 get-account --profile supply-prod --region us-east-1 \
     --query '{production:ProductionAccessEnabled,review:Details.ReviewDetails}'
   ```
3. Check DMARC. While still in the sandbox, verify your own address (`aws sesv2 create-email-identity --email-identity you@example.com`, then click the link), and send yourself a message from the domain:
   ```bash
   DOMAIN=supplycheckout.com
   aws sesv2 send-email --profile supply-prod --region us-east-1 \
     --from-email-address "noreply@$DOMAIN" --destination ToAddresses=you@example.com \
     --content 'Simple={Subject={Data=DMARC test},Body={Text={Data=Test}}}'
   ```
   In the received message's headers ("Show original" in Gmail), SPF, DKIM and DMARC should all say `PASS`. Aggregate reports arrive at the `dmarc-rua` address daily. Once they show SES mail passing for a couple of weeks, change `p=none` to `p=quarantine` in `lib/stacks/domain-stack.ts`.

### Transactional email

The app sends invites and account notices itself (`supply-checkout-5hx`); Cognito sends its own sign-up and sign-in codes. Both go out from `noreply@<env domain>` through one SES configuration set, `supply-checkout-<env>-transactional`, which the primary region's `domain` stack creates and makes the domain identity's default.

- **Suppression.** The configuration set adds any address that hard-bounces or complains to SES's account-level suppression list, and SES won't send to it again. A later send to it comes back as a bounce (subtype `OnAccountSuppressionList`). Because the configuration set is the identity's default, this covers Cognito's mail too: someone who marks an invite as spam also stops getting sign-up and password-reset codes. See [Removing an address from the suppression list](#removing-an-address-from-the-suppression-list).
- **Bounce and complaint events.** The configuration set publishes them to the SNS topic `supply-checkout-<env>-email-events`, encrypted with its own KMS key, which only SES may publish to, and only for this configuration set. The `email` stack's function (`backend/src/email/events.ts`) subscribes to it. When the message was an invite (its SES tags name the team and invite), a permanent bounce (including a send to a suppressed address) or a complaint marks that invite `inviteStatus: "failed"` with `failureReason` (`bounced` or `complained`), as long as the invite is still there and is for the address that bounced, so the owner can see it and correct the address. Transient bounces (a full mailbox, an out-of-office auto-reply) are counted in `EmailBounces` but don't fail the invite. Nothing is re-sent automatically. The function may read only `homeRegion` from team items and update only an invite's failure fields (`dynamodb:Attributes` in its policy), whose names no other item in a team's partition uses: the policy pins the partition, not the item, so the invite field is `inviteStatus`, not `status` (a team's subscription status). Events it can't record after retries go to `supply-checkout-<env>-email-events-dlq`, which alarms (Email events dropped, [docs/journeys.md](journeys.md)).
- **The dead-letter queue holds email addresses.** Its messages are whole SES events, recipients included, so it's encrypted with its own KMS key and keeps messages for 7 days. Read it only to replay or diagnose an event, and don't copy messages into tickets, chat, commits or logs; quote the invite and team IDs from the message's `mail.tags` instead.
- **Sending.** A function gets permission with `grantSendEmail(fn, config)` (`lib/email.ts`): `ses:SendEmail` on the domain identity and the configuration set only, with the condition `ses:FromAddress = noreply@<env domain>`, and the environment `mailerFromEnv()` reads (`backend/src/email/mailer.ts`). No function has it yet: invite creation (`supply-checkout-5tp`) and billing notices (`supply-checkout-x0l`) add it where they send. Messages are rendered in code (`backend/src/email/templates.ts`), not SES templates, so there's no `SendTemplatedEmail`.
- **Deploying.** Deploy the primary region's `domain` stack first (it adds the configuration set, and changes the identity's default to it), then `data`, then `email`:
  ```bash
  npx cdk deploy supply-checkout-prod-us-east-1-domain supply-checkout-prod-us-east-1-email --profile supply-prod
  ```
  Then send a test message to the SES mailbox simulator and check the event reaches the function's log: `aws sesv2 send-email --profile supply-prod --region us-east-1 --from-email-address noreply@supplycheckout.com --destination ToAddresses=bounce@simulator.amazonses.com --configuration-set-name supply-checkout-prod-transactional --content 'Simple={Subject={Data=Bounce test},Body={Text={Data=Test}}}'`. <!-- public-safety: allow -->
  The function's IAM conditions (`dynamodb:Attributes`, `dynamodb:Select`, `dynamodb:ReturnValues`) aren't enforced by DynamoDB Local, so check them once in the deployed stack: create a test invite for `bounce@simulator.amazonses.com` in a test team, send the same message with `--email-tags Name=kind,Value=invite Name=teamId,Value=<team ID> Name=inviteId,Value=<invite ID>`, and confirm the invite item gets `status: failed` and the function logs no `AccessDeniedException`. Then delete the test team's items. <!-- public-safety: allow -->

### Removing an address from the suppression list

Do this only when the address's owner asks, for example after they fixed a full or misconfigured mailbox, or marked an invite as spam by mistake and now can't get sign-in codes. An address on the list gets no invites, notices or Cognito codes. Check it, then remove it (use the address they gave you; don't paste it anywhere else):

```bash
aws sesv2 get-suppressed-destination --profile supply-prod --region us-east-1 --email-address "$ADDRESS" \
  --query 'SuppressedDestination.{reason:Reason,since:LastUpdateTime}'
aws sesv2 delete-suppressed-destination --profile supply-prod --region us-east-1 --email-address "$ADDRESS"
```

A complaint means the person asked not to get our mail, so remove a `COMPLAINT` entry only on their own request. If an invite to the address had failed, the owner sends a new invite; the failed one isn't retried.

**Staging and dev.** Only the prod account exists today, so nothing is delegated yet. When one of those accounts exists (`staging` here):

1. In the staging account, create the zone `staging.supplycheckout.com` (`aws route53 create-hosted-zone --name staging.supplycheckout.com --caller-reference staging-$(date +%s)`) and put its ID in that account's `/supply-checkout/staging/dns/hosted-zone-id`.
2. In the prod account, put the new zone's four name servers in a `StringList` parameter: `aws ssm put-parameter --type StringList --name /supply-checkout/prod/dns/delegation/staging --value 'ns-1.awsdns-01.org,ns-2.awsdns-02.co.uk,…'`.
3. Add `"delegatedEnvs": ["staging"]` to `cdk.json` (it holds names only) and redeploy prod's `domain` stack, which adds the NS record. Keep it in `cdk.json` rather than passing `-c`: a prod deploy without it removes the delegation.
4. Deploy staging with `-c envName=staging` and that account's profile.

## Sign-in

The `identity` stack (`lib/stacks/identity-stack.ts`, [ADR 0007](adr/0007-identity-cognito.md), `supply-checkout-zsm`) holds the Cognito user pool, in the primary region. It's stateful: termination protection, deletion protection on the pool, and a `RETAIN` removal policy.

- **Essentials tier** with **Managed Login** at `auth.<env domain>`, branded with the app's colors (`managedLoginBranding` in `lib/identity.ts`; light or dark follows the browser).
- Sign-in by email with a **one-time code**, a **password** (12+ characters, mixed), or a **passkey**. Passkeys use `auth.<env domain>` as their relying party ID, which Cognito requires with a custom domain. They are bound to that host, so changing it orphans every passkey.
- **Optional TOTP MFA**, no SMS. Owners must turn it on before changing billing. The billing routes enforce that (they check `UserMFASettingList` with `AdminGetUser` and answer 403 `mfa_required`); the pool doesn't.
- Email codes come from `noreply@<env domain>` through SES, using the domain identity from the `domain` stack.
- One app client, `web`: a public client (no secret) using the authorization code flow with PKCE. Callback and sign-out URLs are `https://app.<env domain>/`, plus `http://localhost:5173/` outside prod (`-c localhostCallbacks=true|false` overrides). Access and ID tokens last 60 minutes; refresh tokens last 30 days and rotate on every use (a 10-second grace period covers two tabs refreshing at once). Refresh with the `/oauth2/token` endpoint or `GetTokensFromRefreshToken`: rotation turns off `REFRESH_TOKEN_AUTH`.
- **Sign in with Apple** and **Google** are off until their credentials exist (below).
- The web client's **write attributes** are pinned to `email`, `given_name` and `family_name`. Users can never set `email_verified` (or `phone_number_verified`) themselves: the API trusts a verified email for invites. Changing `email` keeps the old, verified address until the new one is confirmed with a code. Cognito requires every attribute an IdP maps to be writable, so Google and Apple **don't map `email_verified`**. They map their `email_verified` claim to `custom:idp_email_verified` instead, and Google maps its `hd` claim to `custom:idp_hd`. The web client can write both, but only while a provider is on. It can never write `custom:linked_email`.
- **Verified emails from Google and Apple.** With either provider on, three triggers in `backend/src/identity` (`supply-checkout-6v9`, `supply-checkout-0b1`) handle federated users:
  - **One way in** (pre authentication, `sign-in-guard-handler.ts`). The invariant is that a federated-only user signs in only through Google or Apple. A federated-only user is one whose username is `<provider>_<provider user ID>` for a Google or Apple entry in `identities`, or whom Cognito marks `EXTERNAL_PROVIDER`. Cognito runs this trigger for native sign-ins (password, email code, passkey) and not for federated ones, and it refuses every native sign-in by such a user, even one who somehow got a password or a passkey. Native users, including ones with a linked provider (below), are let through: a linked user keeps its native username and `CONFIRMED` status. If who counts as federated ever changes, change `isFederatedOnly()`, the `email_verified` trigger and the linking trigger together. The guard has no AWS permissions.
  - **`email_verified` from the provider** (pre token generation, `email-verified-handler.ts`). It sets `email_verified` to match the provider's claim with `AdminUpdateUserAttributes`. The value is `"true"` only when the provider says the email is verified (Google sends a boolean, Apple a boolean or `"true"`/`"false"`), and `"false"` otherwise. Users can write `custom:idp_email_verified` themselves, so the trigger reads it only when Cognito has just rewritten it from the provider. That is at a Managed Login token (`TokenGeneration_HostedAuth`, not a refresh) for a federated-only user with status `EXTERNAL_PROVIDER`, and the guard makes every such token a provider sign-in. A failed update is logged and the sign-in goes ahead, and the next sign-in tries again. A failed promotion leaves the user unverified. A failed downgrade leaves them verified until a later sign-in succeeds, and is logged at error level as its own outcome, `downgrade-failed`. Its role can write its own log group and call `cognito-idp:AdminUpdateUserAttributes` on this pool only. The grant is a separate IAM policy attached after the pool exists, because the pool names the function and the function can't name the pool.
  - **Linking to an existing account** (pre sign-up, `account-link-handler.ts`). Cognito runs it the first time a Google or Apple identity signs in (`PreSignUp_ExternalProvider`), before it creates a user. Other sign-ups pass through unchanged, and it never confirms or verifies anyone. It links the identity to an existing native user with `AdminLinkProviderForUser`, so the sign-in lands in the same user (same `sub`) and so the same teams. It links only when all of these hold:
    - The provider says the email is verified. `custom:idp_email_verified` is fresh from the provider here, since the user doesn't exist yet.
    - **The provider is authoritative for the address**, not just someone who once checked it. For Google that's `@gmail.com` or `@googlemail.com`, or a Workspace account whose `hd` claim (mapped to `custom:idp_hd`, read only here) equals the email's domain. For Apple it's a private relay address (`@privaterelay.appleid.com`), `@icloud.com`, `@me.com` or `@mac.com`. A personal Google or Apple account can still carry a work address its owner verified years ago and no longer controls, and linking on that would hand the address's current owner's account to them. Other addresses get a separate account. Linking those is the settings-based flow for a signed-in user (`supply-checkout-b4g`).
    - The email is plain ASCII with no `"` or `\`. Addresses and domains are compared after lowering ASCII letters only, so Unicode case folding can't make two match.
    - ListUsers finds exactly one native (not federated-only) user with that email, on one page. Several matches are refused rather than guessed at.
    - That user is `CONFIRMED`, enabled and has `email_verified` `"true"` (proven with Cognito's own code).
    - It has no identity from the same provider yet.
    - If it already has a Google or Apple identity linked, its `email` still equals `custom:linked_email`, the address recorded when that identity was linked. That attribute is set only by this trigger: no IdP maps it and no client can write it.

    Linking records the email in `custom:linked_email`, then links. Otherwise the sign-up goes ahead and makes a separate federated-only user, as before. After linking, the trigger fails that sign-in on purpose with `ACCOUNT_LINKED:<provider>` (Cognito would otherwise fail it with "Already found an entry for username"). Cognito sends the person back with it in `error_description`, and the web app (`src/aws/session.js`) signs in again once, straight to that provider (`identity_provider`), which lands in the linked user. If a Cognito call fails, the sign-in fails and can be tried again, since going ahead would make a separate account for good. Each call has a 1.5-second timeout, so all three fit in the 5 seconds Cognito gives a trigger.

    Its role can write its own log group and call `cognito-idp:ListUsers`, `cognito-idp:AdminUpdateUserAttributes` and `cognito-idp:AdminLinkProviderForUser` on this pool only. IAM can't limit ListUsers' filter; the code only searches by exact email. Like the `email_verified` trigger's grant, it's a separate policy. A linked user signs in with the provider or natively, and the `email_verified` trigger leaves it alone. Cognito applies the provider's attribute mapping to a linked user at each provider sign-in, so a changed provider email overwrites `email` while `email_verified` stays `"true"`. The recorded-email check above keeps such a user from capturing someone else's first sign-in. Keeping its `email_verified` right is `supply-checkout-kgw`, which must be done before providers are turned on in prod.
  - **Accepted risk.** If a provider sign-in left the claim out, Cognito would keep the attribute's last value, which the user may have written. Google and Apple always send `email_verified` with the `email` scope. A forged verified email would show that address's pending invites (team name and role) in `/me`. Joining still needs the token from the emailed link.

The stack publishes `user-pool-id`, `user-pool-arn`, `web-client-id`, `issuer-url` and `auth-url` under `/supply-checkout/<env>/identity/`. `cognitoJwtAuthorizer()` in `lib/identity.ts` builds the HTTP API's JWT authorizer from them.

**Deploying.** The first time, in this order:

1. The `domain` stack in `GLOBAL_SERVICES_REGION` must be deployed: it publishes the `auth.` certificate's ARN, which this stack reads (`/supply-checkout/<env>/domain/auth-certificate-arn`). If the primary region is ever not `GLOBAL_SERVICES_REGION`, copy that parameter into the primary region first.
2. The SES domain identity must be verified (see [Domain and email](#domain-and-email)). While SES is in the sandbox, codes only reach verified addresses.
3. The apex must resolve: Cognito refuses a custom domain whose parent domain has no A record. The identity stack depends on the `web` stack, whose alias records make it resolve, so `cdk deploy` deploys `web` first. (`dig +short supplycheckout.com A` should answer.)
4. Deploy, then wait for the domain (Cognito provisions a CloudFront distribution; it can take up to an hour):
   ```bash
   cd infra
   npx cdk deploy supply-checkout-prod-us-east-1-identity --profile supply-prod
   aws cognito-idp describe-user-pool-domain --profile supply-prod --region us-east-1 \
     --domain auth.supplycheckout.com --query DomainDescription.Status   # ACTIVE
   ```
5. Try it: open `https://auth.supplycheckout.com/login?client_id=<web-client-id>&response_type=code&scope=openid+email+profile&redirect_uri=https://app.supplycheckout.com/`, with the client ID from `aws ssm get-parameter --name /supply-checkout/prod/identity/web-client-id`. Sign up with an email code, add a passkey, and sign in again with each.

If the first deploy fails after the pool is created, CloudFormation rolls back but keeps the pool (it's retained and deletion-protected). Delete it in the Cognito console (turn off deletion protection first) before deploying again.

**Google sign-in.** In the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project (`Supply Checkout`). Under **Google Auth Platform**, set up **Branding** (app name, support email, logo, home page `https://supplycheckout.com`, privacy policy and terms links, authorized domain `supplycheckout.com`), choose **Audience: External**, and publish the app. The scopes are `openid`, `email` and `profile`, which need no Google review.
2. **Clients → Create client → Web application**. Authorized JavaScript origin `https://auth.supplycheckout.com`; authorized redirect URI `https://auth.supplycheckout.com/oauth2/idpresponse`. Keep the client ID and secret.
3. Store them in Secrets Manager, in the primary region (the prompts keep them out of your shell history):
   ```bash
   read -r -p 'Client ID: ' ID; read -r -s -p 'Client secret: ' SECRET; echo
   aws secretsmanager create-secret --profile supply-prod --region us-east-1 \
     --name supply-checkout/prod/identity/google \
     --secret-string "$(jq -n --arg i "$ID" --arg s "$SECRET" '{clientId:$i,clientSecret:$s}')"
   ```
4. Add `"googleSignIn": true` to `cdk.json` and deploy the identity stack. Keep the flag in `cdk.json`: a deploy without it removes the provider.

**Sign in with Apple.** Needs a paid Apple Developer Program membership. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/):

1. **Identifiers → App IDs**: register the app's ID (for example `com.supplycheckout.app`) with **Sign In with Apple** on, as a primary App ID. The iOS app will use it later.
2. **Identifiers → Services IDs**: register one for the web (for example `com.supplycheckout.signin`). This is the client ID Cognito sends. Turn on **Sign In with Apple**, **Configure**: primary App ID from step 1, domain `auth.supplycheckout.com`, return URL `https://auth.supplycheckout.com/oauth2/idpresponse`.
3. **Keys**: create a key with **Sign In with Apple** on, configured for the primary App ID. Download the `.p8` file (only once) and note its **Key ID**. The **Team ID** is on the Membership page.
4. **Services → Sign in with Apple for Email Communication**: register `supplycheckout.com` and `noreply@supplycheckout.com`, so mail to users' private relay addresses (`@privaterelay.appleid.com`) is delivered. SES's SPF and DKIM already pass for the domain.
5. Store the values in Secrets Manager, in the primary region:
   ```bash
   aws secretsmanager create-secret --profile supply-prod --region us-east-1 \
     --name supply-checkout/prod/identity/apple \
     --secret-string "$(jq -n --arg s com.supplycheckout.signin --arg t TEAM_ID --arg k KEY_ID \
       --rawfile p AuthKey_KEY_ID.p8 '{servicesId:$s,teamId:$t,keyId:$k,privateKey:$p}')"
   rm AuthKey_KEY_ID.p8   # after storing it somewhere safe offline
   ```
6. Add `"appleSignIn": true` to `cdk.json` and deploy the identity stack.

The stack reads each field with a CloudFormation dynamic reference at deploy time, so no ID or secret is ever in a template or this repository. Other environments use `supply-checkout/<env>/identity/{google,apple}` in their own accounts, with `auth.<env>.supplycheckout.com` in the redirect URIs. Apple's App Store rules (guideline 4.8) require Sign in with Apple wherever Google sign-in is offered in the iOS app, so turn both on before the app ships.

## Data API

The `api` stack (`lib/stacks/api-stack.ts`, [ADR 0006](adr/0006-api-and-realtime-sync.md), `supply-checkout-d8b`) is the HTTP API at `api.<env domain>`, in every region. [docs/api/openapi.yaml](api/openapi.yaml) describes its routes, errors and the mapping from the app's `window.claude.use("db")` calls; `backend/src/api/routes.ts` is the route table the handlers and the stack share, and a test keeps the two in step.

| Route | Auth | Function |
| --- | --- | --- |
| `GET /teams/{teamId}/products`, `GET /teams/{teamId}/sheets` (`?orderBy=date&direction=desc`, `limit`, `cursor`) | Cognito access token | `data` |
| `GET`, `PUT` (set), `PATCH` (deep-merge update), `DELETE` `/teams/{teamId}/products/{key}` and `/teams/{teamId}/sheets/{sheetId}` | Cognito access token | `data` |
| `POST /teams/{teamId}/sheets/{sheetId}/checkout`, `.../return`, `POST /teams/{teamId}/products/{key}/stock`, `GET /teams/{teamId}/products/{key}/movements` (the inventory commands and stock history, [docs/api/commands.md](api/commands.md)) | Cognito access token | `data` |
| `POST /teams/{teamId}/imports` (CSV inventory import, owners only, all or nothing; [backend.md](backend.md)) | Cognito access token | `data` |
| `GET /me`, `POST /teams`, `POST /invites/{inviteId}/accept` | Cognito access token | `account` |
| `POST /auth/session`, `/auth/refresh`, `/auth/sign-out` | Refresh-token cookie and `Origin` | `auth` |

**Team isolation**, two layers:

1. **Membership, in the handler.** API Gateway's JWT authorizer checks the token; the handler also requires an unexpired access token and takes the user from `sub`. The team comes only from the path: `authorizeTeam` reads the caller's `MEMBER` item on every request (so a role change applies at once) and issues the `TeamContext` every data function needs. A body that names a team, or any server-owned field, is refused. Viewers can read; a viewer's write gets 403 `invalid_argument`, which the app shows as view-only access.
2. **IAM, `dynamodb:LeadingKeys`.** The data function's own role has no DynamoDB access. For each team it assumes the `DataAccessRole` with the session tag `teamId=<path team>` (cached for up to an hour per team), and that role allows `GetItem`, `PutItem`, `DeleteItem`, `UpdateItem`, `ConditionCheckItem` and `Query` (the last three for the inventory commands' transactions; no `Scan`, no batch writes) only on items whose partition key is `TEAM#${aws:PrincipalTag/teamId}`, or the team's date index partition `TEAM#…#SHEETS`. Every item a team route touches is in one of those two partitions, so a bug that built another team's key would be refused by IAM too.

**First sign-in and teams** (`supply-checkout-l5y`; the app's side is in [docs/api/onboarding.md](api/onboarding.md)). `GET /me` lists the caller's teams (role, plan, trial status) and the live invites for their **verified** email. `POST /teams` creates a team with the caller as owner, `homeRegion` from the serving region and a 14-day trial; it's idempotent per `Idempotency-Key` (the team's ID is derived from the user and the key, and its creation is conditional) and limited to 5 teams per user per UTC day by a counter in the user's partition. `POST /invites/{inviteId}/accept` joins the team that invited the caller's verified email, with `{"token"}` from the emailed link; the transaction checks the token's hash, the address, the expiry and that the invite is unused. Each user can be in at most 20 teams, which also bounds the role sessions one `/me` needs, and the account routes have their own API Gateway throttles (`throttle` in `routes.ts`), as does the CSV import (5 requests a second, burst 10), which can write up to 1,000 items. The email comes from Cognito's `GetUser`, called with the caller's own access token.

These routes write outside any team the caller is in (a new team, or the team they're joining, plus their own `USER#` rows), so the `account` function can't use the `DataAccessRole`. It assumes the **`AccountAccessRole`** with three session tags: `userId` (the token's `sub`), `teamId` and `invitee` (the SHA-256 of the verified email), unused ones set to `.`, which no key matches. That role allows `GetItem`, `PutItem`, `DeleteItem`, `UpdateItem`, `ConditionCheckItem` and `Query` (no `Scan`, no batch writes) only where the partition key is `USER#<userId>`, `TEAM#<teamId>` or, on `GSI2`, `INVITEE#<invitee>`. The handler tags a team only when the request is entitled to it: the ID derived from the caller's own idempotency key, the team of an invite found under their verified email, or a team in their own `USER#` rows after the membership check. The `DataAccessRole` is unchanged.

**Sign-in sessions.** The web app keeps access and ID tokens in memory. `/auth/session` redeems the Managed Login code (with its PKCE verifier) at Cognito's `/oauth2/token` and sets the refresh token as `__Secure-sc_refresh` (`HttpOnly; Secure; SameSite=Strict; Path=/auth`, 30 days). `/auth/refresh` redeems it, and because rotation is on, stores the new refresh token each time. `/auth/sign-out` revokes it and clears the cookie. Each checks that `Origin` is the app's (`https://app.<env domain>`, plus `http://localhost:5173` outside prod), and CORS allows only those origins, with credentials.

**Latency.** Functions run Node.js 24 on arm64, bundled by esbuild (ESM, minified, the AWS SDK v3 clients tree-shaken into the bundle) with their clients created once per container. The data function has 1 GB of memory, for CPU. A warm read is a membership check (one `TransactGetItems`) and one `GetItem` or `Query`; a write adds a `PutItem`.

**Deploying.** The api stack reads, from SSM in its region: the `api.` certificate (the domain stack), the table's KMS key ARN (the data stack) and the issuer, web client ID and auth URL (the identity stack). So deploy those first. The synth bundles the handlers, so install the backend's dependencies too:

```bash
aws sso login --profile supply-prod
(cd backend && npm ci)
cd infra && npm ci
npx cdk diff supply-checkout-prod-us-east-1-api --profile supply-prod
npx cdk deploy supply-checkout-prod-us-east-1-api supply-checkout-prod-us-east-1-observability --profile supply-prod
# No token: API Gateway answers 401 {"message":"Unauthorized"}
curl -si https://api.supplycheckout.com/teams/t/products | head -1
```

The observability stack adds the API errors and API slow alarms, reading the API's ID from `/supply-checkout/<env>/api/api-id`.

**Measuring p95** (the acceptance target is under 300 ms, warm). Create a team for a test user with `POST /teams`, or, before the account routes are deployed, add one by hand (their `sub` is in the Cognito console), then sign in and time requests:

```bash
# The environment being measured (dev): its profile, region and table
P="--profile <dev profile> --region us-east-1"; T=supply-checkout-dev-app; TEAM=perf-team; SUB=<test user's sub>
aws dynamodb put-item $P --table-name $T --item '{"PK":{"S":"TEAM#'$TEAM'"},"SK":{"S":"META"},"type":{"S":"team"},"teamId":{"S":"'$TEAM'"},"name":{"S":"Perf"},"homeRegion":{"S":"us-east-1"},"owners":{"N":"1"},"version":{"N":"1"}}'
aws dynamodb put-item $P --table-name $T --item '{"PK":{"S":"TEAM#'$TEAM'"},"SK":{"S":"MEMBER#'$SUB'"},"type":{"S":"member"},"teamId":{"S":"'$TEAM'"},"userId":{"S":"'$SUB'"},"role":{"S":"owner"}}'
# An access token for the test user (password sign-in through the web client)
TOKEN=$(aws cognito-idp initiate-auth $P --auth-flow USER_AUTH --client-id <web client ID> \
  --auth-parameters USERNAME=<email>,PREFERRED_CHALLENGE=PASSWORD,PASSWORD=<password> \
  --query AuthenticationResult.AccessToken --output text)
API=https://api.dev.supplycheckout.com/teams/$TEAM
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"data":{"client":"Perf","date":"2026-09-26","status":"open","items":{}}}' $API/sheets/perf-1
# 30 seconds to warm up, then 2 minutes at 10 connections, reads and writes
npx autocannon -d 30 -c 10 -H "Authorization=Bearer $TOKEN" "$API/sheets?orderBy=date&direction=desc" > /dev/null
npx autocannon -d 120 -c 10 -H "Authorization=Bearer $TOKEN" "$API/sheets?orderBy=date&direction=desc"
npx autocannon -d 120 -c 10 -m PATCH -H "Authorization=Bearer $TOKEN" -H content-type=application/json \
  -b '{"data":{"items":{"x":{"out":1,"returned":0}}}}' "$API/sheets/perf-1"
```

Read the server-side p95 per route from the access logs (Logs Insights on the api stack's `AccessLogs` group, over the run's window), which leaves out network time to the laptop:

```
filter routeKey like /teams/ | stats count(*), pct(latencyMs, 50), pct(latencyMs, 95), pct(integrationLatencyMs, 95) by routeKey
```

or the whole API's from CloudWatch: `aws cloudwatch get-metric-statistics $P --namespace AWS/ApiGateway --metric-name Latency --dimensions Name=ApiId,Value=<api id> --extended-statistics p95 --period 300 --start-time … --end-time …`. Cold starts show up in the first minute only; X-Ray traces break a slow request down by DynamoDB and STS call. Delete the test items afterwards.

## Live updates

The `realtime` stack (`lib/stacks/realtime-stack.ts`, [ADR 0006](adr/0006-api-and-realtime-sync.md), [ADR 0016](adr/0016-per-member-live-update-channels.md), `supply-checkout-dpc`, `supply-checkout-4zn`) is an AppSync Events API with one channel per user, `/users/<sub>`, at `realtime.<env domain>`. [docs/api/realtime.md](api/realtime.md) is the client contract: how to connect, the event shape, reconnecting and the polling fallback.

- **Subscribing.** Clients connect and subscribe with their Cognito access token. A Lambda authorizer (`backend/src/realtime/authorizer-handler.ts`) verifies the token (signature, issuer, expiry, the web client, `token_use=access`) and allows a subscription only to exactly `/users/<sub>` for the token's own user. It reads no data and has no table or KMS access. Nothing is cached. Publishing takes IAM, and only the stream consumer's role may, on the `users` namespace.
- **Publishing.** A consumer (`backend/src/realtime/publisher-handler.ts`) reads the table's stream, filtered to `PRODUCT#` and `SHEET#` items (the changes) and to `META` and `MEMBER#` items (who gets them), and publishes `{teamId, collection, id, op, version}` for each document write to the channel of each current member of the team, with no document data: clients fetch through the data API, which checks membership on every request.
- **Cutting off removed members and canceled teams.** The consumer reads a team's members and billing status with `liveUpdateRecipients` and caches them for 30 seconds, forgetting them as soon as the stream shows a `META` or `MEMBER#` write for that team. So a removed member, or every member of a team whose status is `canceled`, `unpaid` or `incomplete_expired`, stops getting notices at once in practice and within 30 seconds at worst. Its table permission is `GetItem` and `Query` on `TEAM#*` partitions for the attributes `PK`, `SK`, `userId`, `role` and `status` only (`dynamodb:Attributes`), so it can't read documents or emails through the table. Partial batch failures are retried from the first unsent record; a batch that keeps failing goes to `supply-checkout-<env>-live-updates-dlq`. Alarms: Live updates failing, delayed and dropped ([docs/journeys.md](journeys.md)).
- **Regions.** The custom domain is added where its certificate is (`GLOBAL_SERVICES_REGION`). The consumer runs in the primary region, which has the table's stream; the second region's consumer is phase 2.

**Deploying.** The realtime stack reads, from SSM in its region: the table's stream and key ARNs (data stack), the user pool ID and web client ID (identity stack) and the `realtime.` certificate (the domain stack in `GLOBAL_SERVICES_REGION`). Deploy it after those, and before observability:

```bash
npx cdk diff supply-checkout-staging-us-east-1-realtime --profile <staging profile>
npx cdk deploy supply-checkout-staging-us-east-1-realtime supply-checkout-staging-us-east-1-observability --profile <staging profile>
```

Then measure the 2-second p95 and the reconnect behavior in staging as described in [docs/api/realtime.md](api/realtime.md#measuring-after-a-deploy).

## Template snapshots

`test/stacks.test.ts` snapshots every stack's synthesized template, one file per stack in `test/__snapshots__/<stack name>.json` (for example `supply-checkout-prod-us-east-1-api.json`), so a change to one stack only touches that stack's file. Lambda asset hashes and the function version IDs made from them are masked, because they depend on the checkout's path. When a change to a stack is intended, review the test's diff, then accept it and commit the changed files:

```bash
cd infra
npm run test:update
git diff --stat test/__snapshots__
```
