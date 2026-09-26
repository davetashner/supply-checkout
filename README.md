# Supply Checkout

A shared supply tracker for taking supplies from storage to client jobs and bringing back what wasn't used.

- **Sheets** – one per client and date, recording who prepared it. Scan a barcode (or pick an item without one) to check supplies out, scan again on return to record what came back unused, then tap **Finished Return**. Each sheet totals what was used and what to charge, and downloads as CSV.
- **Inventory** – items, prices and how many are in storage. Checkouts subtract from storage; returns add back.
- **Receipts** – photograph a store receipt and Claude reads the line items and prices, suggests matches against existing inventory, and lets you assign each item to a client's sheet or to general inventory before anything is saved.

The app runs as a [Claude artifact](https://claude.ai/artifact/LcSb29dTE99AK4N6iuVFrj). claude.ai provides the shared database, sign-in, file downloads and receipt reading through `window.claude`; there is no server to run.

The source is a small [Vite](https://vite.dev) project with no UI framework. One build of it is the single `index.html` published to claude.ai; another is a static bundle for the AWS version ([ADR 0004](docs/adr/0004-runtime-adapter.md)); a third is a labeled demo of that bundle for supplycheckout.com, which runs entirely in the browser until sign-in and the API exist.

## Repository layout

| Path | What it is |
| --- | --- |
| `src/index.html` | The page: head (fonts, ZXing from a CDN) and markup. |
| `src/styles.css` | All of the app's styles. |
| `src/icons/` | The barcode favicon: `favicon.svg` (the source, drawn on a 16 px grid so it stays crisp at 16 and 32 px, with dark-mode colors), and its PNG fallbacks `favicon-32.png` and `apple-touch-icon.png` (180 px), which `npm run icons` renders from the SVG. The web build and demo serve all three from `assets/`; the artifact inlines only the SVG, as a `data:` URI. |
| `src/main.js` | App state, screens, modals, receipt review, and startup. |
| `src/runtime.js` | `use()`, the one place the app reaches the claude.ai runtime (`window.claude`). |
| `src/format.js`, `src/sheet-math.js` | Formatting helpers and sheet totals, with no app state. |
| `src/dom.js` | `$`, toast, modals, two-tap confirm buttons and number steppers. |
| `src/barcode.js` | Reading barcodes from photos (the browser's detector, or ZXing). |
| `src/receipt-prompt.js` | The receipt-reading prompt and its error messages. |
| `vite.config.js` | The builds: `artifact`, `web` and `demo` (below). |
| `demo/` | The demo build's entry (`main.js`: the in-memory runtime and the banner's styles) and the demo data (`data.js`), which `npm run dev` also uses. |
| `dist/` | Build output (not committed). |
| `scripts/builds.mjs` | Builds and serves the builds for the tests. |
| `scripts/page.mjs` | Wraps the artifact in the same document skeleton claude.ai adds at publish time. |
| `scripts/validate-html.mjs` | HTML validation (html-validate). |
| `scripts/dev-server.mjs` | Local dev server with the mock runtime (`npm run dev`). |
| `scripts/render-icons.mjs` | Renders the favicon's PNG fallbacks from `src/icons/favicon.svg` with Playwright's Chromium (`npm run icons`). Run it after changing the SVG, and commit the PNGs. |
| `scripts/land-pr.sh` | Waits for CI, squash-merges a PR, cleans up its worktree and branch, and closes its beads (`npm run land -- <pr>`). Exits non-zero if the PR isn't merged, and explains a PR that main's ruleset blocks. |
| `scripts/land-pr.test.sh` | Tests for `land-pr.sh` against a fake `gh` in a throwaway repo (`npm run test:scripts`, which also runs shellcheck). |
| `scripts/check-public-safety.mjs` | Blocks AWS identifiers, email addresses and credentials from this public repo (pre-commit hook and CI). |
| `scripts/check-region-strings.mjs` | Blocks AWS region names in `infra/`, `backend/` and `src/` outside `infra/lib/config.ts` (ADR 0010; pre-commit hook and CI). |
| `scripts/export-beads.mjs` | Writes the beads backlog export without owner emails (`npm run beads:export`). |
| `tests/` | Playwright end-to-end tests, run against an in-memory mock of the claude.ai runtime (`tests/mock-claude.js`). |
| `infra/` | The AWS CDK app (TypeScript) for the SaaS version. Its own npm package; see [Infrastructure](#infrastructure). |
| `backend/` | Lambda code for the SaaS version (TypeScript). `backend/src/data` is the data-access module, the only code that talks to DynamoDB. `backend/src/api` is the HTTP API's handlers (data and sign-in sessions). `backend/src/observability` is logging and business metrics. Its own npm package; see [Backend](#backend). |
| `docs/api/openapi.yaml` | The HTTP API's OpenAPI description, including how the app's `db` calls map onto it. |
| `docs/adr/` | Architecture decision records for the AWS subscription product. |
| `docs/architecture/` | Architecture overview and diagrams (Mermaid). |
| `docs/journeys.md` | The customer journeys the product must never break, the tests that cover them, and the production alarms for when one is blocked. |
| `.beads/` | The [beads](https://github.com/steveyegge/beads) backlog. `issues.jsonl` is an export; run `bd ready` to see what's next. |

## Development

Requires Node 22 or newer.

```bash
npm ci
npx playwright install chromium webkit firefox
npm run check
```

Microsoft Edge is a system install rather than one of Playwright's own browsers. `npx playwright install msedge` installs it (it asks for admin rights). The Edge tests run whenever Edge is installed, and always in CI.

`npm run dev` serves `src/` with Vite's dev server at http://localhost:5173, against the same in-memory runtime the tests use, with demo sheets, inventory and a receipt, so it can be tried in a browser without publishing to claude.ai. Add `?seed=empty`, `?viewer`, `?nouser`, or `?mock={...}` with any `tests/mock-claude.js` option. Data resets on reload, and the page reloads when a file in `src/` changes.

### Builds

| Command | Output | For |
| --- | --- | --- |
| `npm run build:artifact` | `dist/artifact/index.html` | claude.ai. One self-contained file with the script and styles inlined. Like the hand-written `index.html` it replaces, it's a page fragment (claude.ai adds the doctype, `<head>` and `<body>`), and it only loads fonts from Google Fonts and ZXing from cdn.jsdelivr.net. It isn't minified, so it can be read before publishing. |
| `npm run build:web` | `dist/web/` | CloudFront. `index.html` plus minified, content-hashed files in `assets/`, which can be cached forever. |
| `npm run build:demo` | `dist/demo/` | supplycheckout.com, until sign-in and the API exist. The web build with `demo/main.js` running first: the in-memory runtime from the tests with the `npm run dev` demo data, receipt reading that returns a canned receipt after a pause, and CSV downloads saved in the browser. A banner says it's a demo, that nothing is saved and that data resets on reload. It makes no requests except to its own files, Google Fonts and cdn.jsdelivr.net. Asset URLs are relative (`./assets/…`), so the folder works from any path. |

`npm run build` runs all three. Each writes hidden source maps (`dist/artifact/app.js.map`, `dist/web/assets/*.js.map`, `dist/demo/assets/*.js.map`) with no `sourceMappingURL` comment in the code; the coverage run uses them.

The demo's own code lives in `demo/`, outside `src/`, so the artifact and web builds don't include it and it isn't counted in `src/`'s coverage. `npm run publish:demo` builds it and publishes it to supplycheckout.com ([Web hosting and releases](#web-hosting-and-releases)).

`npm run lint` runs ESLint on `src/`, `demo/`, the scripts and the tests, then builds all three and validates their HTML. `npm run check` also runs the public-safety check below and every test suite against both builds.

Run `npm run hooks:install` once per clone. It installs a pre-commit hook (`scripts/git-hooks/pre-commit`) that blocks commits containing AWS account or SSO identifiers, personal email addresses, or credentials, because this repository is public, and commits that name an AWS region outside `infra/lib/config.ts`.

## Infrastructure

`infra/` is the AWS CDK v2 app for the subscription product ([ADR 0002](docs/adr/0002-serverless-aws-with-cdk.md)). It is a separate npm package with its own lockfile, so run its commands from `infra/` (or with `npm --prefix infra run …`).

```bash
cd infra
npm ci
npm run lint        # tsc type-check and ESLint
npm test            # vitest: config, stack layout, template snapshots, cdk-nag (every stack in each region)
npm run synth       # cdk synth; cdk-nag AwsSolutions fails it on any finding
npm run synth:all-regions  # the same for every approved region (-c regions=all)
npm run test:update # accept template snapshot changes after reviewing them
```

**Stacks.** Every stack is named `supply-checkout-<env>-<region>-<component>`. Each region in the environment gets `domain` (certificates, DNS records and the SES domain; see [Domain and email](#domain-and-email)), `data` (stateful: table, keys, buckets), `api` and `realtime` (stateless), and `observability`. The primary region also gets `identity` (stateful: Cognito). `GLOBAL_SERVICES_REGION` gets `web` (CloudFront and WAF, which AWS requires there; see [Web hosting and releases](#web-hosting-and-releases)), and always has a `domain` stack, because CloudFront, Cognito and AppSync only accept certificates from there. Stateful stacks have termination protection. Every stack writes `/supply-checkout/<env>/<component>/stack` to SSM Parameter Store, and later stacks publish their outputs beside it. All resources are tagged `app=supply-checkout`.

**Regions.** The MVP runs in **us-east-1 only**. Every stack takes its region as a parameter, and the tests and CI also synthesize us-west-2 (`synth:all-regions`), so turning on the second region from [ADR 0010](docs/adr/0010-multi-region-active-active.md) is a config change: add it to `DEFAULT_REGIONS` in `lib/config.ts`. CDK is already bootstrapped in us-west-2. `lib/config.ts` is the only file in `infra/`, `backend/` or `src/` that may name a region: it holds `APPROVED_REGIONS`, `DEFAULT_REGIONS` and `GLOBAL_SERVICES_REGION` (where AWS requires CloudFront's certificate and WAF, and where Cognito lives). Stacks get their region as a parameter, Lambdas read `AWS_REGION`, and tests import the constants. `npm run check:regions` (in CI and the pre-commit hook) enforces this.

**Parameters.** The environment and regions are CDK context (`cdk.json` sets `envName=prod`; `regions` defaults to `DEFAULT_REGIONS` and `primaryRegion` to the first of them); override them with `-c envName=staging -c regions=all` (or a comma-separated list, with `-c primaryRegion=...`). Only the regions in `APPROVED_REGIONS` (`lib/config.ts`) are allowed. The account ID is never committed: it comes from the AWS profile at synth time, and a synth without credentials (CI, tests) is account-agnostic.

**The `app` table.** The primary region's `data` stack holds the single DynamoDB table from [ADR 0005](docs/adr/0005-multi-tenant-dynamodb.md), `supply-checkout-<env>-app`. It's a `TableV2` (`AWS::DynamoDB::GlobalTable`) with one replica, in its own region: on-demand, encrypted with a customer-managed KMS key that rotates yearly, point-in-time recovery, deletion protection, a stream with new and old images, TTL on `expiresAt`, and one index, `GSI1`. Adding the us-west-2 replica in phase 2 is another entry in `replicas` with that region's key, not a new table. The data stack publishes `table-name`, `table-arn`, `table-stream-arn` and `table-key-arn` to SSM under `/supply-checkout/<env>/data/`. The key and index names come from `backend/src/data/schema.ts`, so the table and the code that reads it can't drift apart.

**Observability** (`lib/observability/`). Each region's `observability` stack has two SNS topics, `supply-checkout-<env>-alarms-p1` (email and SMS) and `-p2` (email), encrypted with a rotating KMS key, and the alarms from [docs/journeys.md](docs/journeys.md) whose metrics exist ("Which alarms exist"). The primary region's stack also has the `supply-checkout-<env>` CloudWatch dashboard: traffic, errors, latency and every business metric, one line per region. An aspect (`lib/observability/defaults.ts`) gives every Lambda function X-Ray active tracing, JSON logs and the metrics namespace, and every log group a **one-year retention** unless it sets its own. One year is a placeholder until the information security policy (`supply-checkout-4p1`) sets it. Metric names come from `backend/src/observability/names.ts`, so the dashboard, the alarms and the code that sends the metrics can't drift apart.

**cdk-nag.** `AwsSolutionsChecks` is registered as a CDK validation plugin, so every synth and deploy fails on an unacknowledged finding. When a finding is intended, acknowledge it on the narrowest construct with a written reason:

```ts
Validations.of(bucket).acknowledge({ id: "AwsSolutions-S1", reason: "…why this is safe…" });
```

**Deploying** (until the pipeline in [ADR 0012](docs/adr/0012-cicd-releases-rollbacks.md) takes over). Before the first deploy, create the SSM parameters the stacks read: the hosted zone and DMARC report address ([Domain and email](#domain-and-email)) and the alarm recipients (below).

```bash
aws sso login --profile supply-prod
cd infra
npx cdk bootstrap --profile supply-prod        # once per account and region; bootstraps every region in the app
npx cdk diff --profile supply-prod
npx cdk deploy --all --profile supply-prod
```

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

### Domain and email

`lib/domain.ts` names every host, and each region's `domain` stack (`lib/stacks/domain-stack.ts`) holds the certificates and records for them (`supply-checkout-m64`). Prod serves `supplycheckout.com` itself; any other environment serves `<env>.supplycheckout.com` from a zone in its own account.

| Name | What serves it | Certificate |
| --- | --- | --- |
| apex, `www.` | the demo, until the real app launches (CloudFront) | `web`, in `GLOBAL_SERVICES_REGION` |
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

**Staging and dev.** Only the prod account exists today, so nothing is delegated yet. When one of those accounts exists (`staging` here):

1. In the staging account, create the zone `staging.supplycheckout.com` (`aws route53 create-hosted-zone --name staging.supplycheckout.com --caller-reference staging-$(date +%s)`) and put its ID in that account's `/supply-checkout/staging/dns/hosted-zone-id`.
2. In the prod account, put the new zone's four name servers in a `StringList` parameter: `aws ssm put-parameter --type StringList --name /supply-checkout/prod/dns/delegation/staging --value 'ns-1.awsdns-01.org,ns-2.awsdns-02.co.uk,…'`.
3. Add `"delegatedEnvs": ["staging"]` to `cdk.json` (it holds names only) and redeploy prod's `domain` stack, which adds the NS record. Keep it in `cdk.json` rather than passing `-c`: a prod deploy without it removes the delegation.
4. Deploy staging with `-c envName=staging` and that account's profile.

### Web hosting and releases

The web app and the demo are static builds served by one CloudFront distribution from one S3 bucket (`supply-checkout-qk1`).

- **Bucket.** `supply-checkout-<env>-web-<region>-<account>`, in the primary region's `data` stack (stateful, retained, versioned, private, SSE-S3, access logs to `supply-checkout-<env>-logs-<region>-<account>`). Only CloudFront distributions in the account can read it, through origin access control. A release is a folder, `releases/<version>/`, uploaded once and never changed. The second region's bucket, replication and the origin group are phase 2 (`supply-checkout-d79`).
- **Distribution** (`web` stack, `lib/stacks/web-stack.ts`), for the apex, `www.` and `app.`, with the `web` certificate from the domain stack, TLS 1.2+, HTTP/2 and HTTP/3, and standard logs to the logs bucket.
- **Live version.** A CloudFront Function (`lib/web/router.js`, viewer request) picks a **channel** from the host (`app.` serves `app`; the apex serves `demo`; `www.` redirects to the apex). It reads the channel's live version from a CloudFront KeyValueStore and rewrites the path to `releases/<version>/…`, adding `index.html` to paths that end in `/`. The cache key is the rewritten path, so switching versions needs no invalidation, and the KeyValueStore write reaches every edge within seconds. Until something is published, a channel answers 503.
- **Headers** on every response: `Content-Security-Policy` (`lib/web/content-security-policy.ts`), HSTS (two years, subdomains), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and `Cross-Origin-Opener-Policy`. The CSP allows only what `src/index.html` loads (Google Fonts, ZXing from cdn.jsdelivr.net), inline `style` attributes, and `data:`/`blob:` images, plus the environment's `api.`, `realtime.` and `auth.` for connections. Infra tests check it against `src/index.html`, and `tests/content-security-policy.spec.js` runs the web app and the demo under it in every browser, failing on any violation. If you add a script, font or image host to the app, add it there too.
- **WAF** (CloudFront scope): a rate limit of 2,000 requests per IP per 5 minutes, then the AWS managed IP reputation, common and known-bad-inputs rule groups.
- **Caching.** `scripts/publish-web.mjs` uploads `assets/` with `Cache-Control: public, max-age=31536000, immutable`, and everything else (`index.html`) with `max-age=0, must-revalidate` for browsers and `s-maxage` for the edge, which is safe because a release never changes. Source maps aren't uploaded.

**Publishing.** `scripts/publish-web.mjs` reads the bucket and the KeyValueStore from the SSM parameters under `/supply-checkout/<env>/web/`, so it needs the web stack deployed and an AWS CLI v2 login:

```bash
npm run publish:demo                                            # build:demo, upload as demo-<time>-<commit>, make it live at the apex
npm run publish:web -- publish --channel app --dir dist/web     # after npm run build:web: the same for app.
npm run publish:web -- publish --channel app --dir dist/web --version 1.3.0 --no-activate   # upload only
npm run publish:web -- activate --channel app --version 1.3.0  # switch, or roll back to any uploaded version
npm run publish:web -- status                                   # live versions and every uploaded release
```

Options: `--env` (default `prod`), `--profile` (default `$AWS_PROFILE`, else `supply-prod`), `--dry-run` (print the writes instead of running them). Publishing a version that already exists fails.

**First deploy, and the demo live at supplycheckout.com:**

```bash
aws sso login --profile supply-prod
# Once: the SSM parameters from "Domain and email" (hosted zone ID, DMARC report address)
ZONE_ID=$(aws ssm get-parameter --profile supply-prod --region us-east-1 \
  --name /supply-checkout/prod/dns/hosted-zone-id --query Parameter.Value --output text)
# The domain stack adds an SPF TXT record at the apex. This must print nothing: an existing
# apex TXT record (a site verification, say) must be removed, or its values merged into
# the ApexSpf record in lib/stacks/domain-stack.ts, before deploying.
aws route53 list-resource-record-sets --profile supply-prod --hosted-zone-id "$ZONE_ID" \
  --query "ResourceRecordSets[?Name=='supplycheckout.com.' && Type=='TXT']" --output text
# The web stack adds A/AAAA aliases at the apex, www. and app.: none may exist yet either.
aws route53 list-resource-record-sets --profile supply-prod --hosted-zone-id "$ZONE_ID" \
  --query "ResourceRecordSets[?(Type=='A' || Type=='AAAA' || Type=='CNAME') && contains(['supplycheckout.com.','www.supplycheckout.com.','app.supplycheckout.com.'], Name)].[Name,Type]" --output text
cd infra && npm ci
npx cdk deploy supply-checkout-prod-us-east-1-web --profile supply-prod   # also deploys the domain and data stacks it needs
cd .. && npm ci
npm run publish:demo
curl -sI https://supplycheckout.com/ | head -20                            # 200, with the security headers
```

Then check https://securityheaders.com/?q=supplycheckout.com (it should grade A; `'unsafe-inline'` for style attributes stops it at A rather than A+) and that `https://www.supplycheckout.com/` redirects to the apex. `https://app.supplycheckout.com/` answers 503 until the real app is published to the `app` channel.
### Sign-in

The `identity` stack (`lib/stacks/identity-stack.ts`, [ADR 0007](docs/adr/0007-identity-cognito.md), `supply-checkout-zsm`) holds the Cognito user pool, in the primary region. It's stateful: termination protection, deletion protection on the pool, and a `RETAIN` removal policy.

- **Essentials tier** with **Managed Login** at `auth.<env domain>`, branded with the app's colors (`managedLoginBranding` in `lib/identity.ts`; light or dark follows the browser).
- Sign-in by email with a **one-time code**, a **password** (12+ characters, mixed), or a **passkey**. Passkeys use `auth.<env domain>` as their relying party ID, which Cognito requires with a custom domain. They are bound to that host, so changing it orphans every passkey.
- **Optional TOTP MFA**, no SMS. Owners must turn it on before changing billing. The billing routes enforce that (they check `UserMFASettingList` with `AdminGetUser` and answer 403 `mfa_required`); the pool doesn't.
- Email codes come from `noreply@<env domain>` through SES, using the domain identity from the `domain` stack.
- One app client, `web`: a public client (no secret) using the authorization code flow with PKCE. Callback and sign-out URLs are `https://app.<env domain>/`, plus `http://localhost:5173/` outside prod (`-c localhostCallbacks=true|false` overrides). Access and ID tokens last 60 minutes; refresh tokens last 30 days and rotate on every use (a 10-second grace period covers two tabs refreshing at once). Refresh with the `/oauth2/token` endpoint or `GetTokensFromRefreshToken`: rotation turns off `REFRESH_TOKEN_AUTH`.
- **Sign in with Apple** and **Google** are off until their credentials exist (below).

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

### Data API

The `api` stack (`lib/stacks/api-stack.ts`, [ADR 0006](docs/adr/0006-api-and-realtime-sync.md), `supply-checkout-d8b`) is the HTTP API at `api.<env domain>`, in every region. [docs/api/openapi.yaml](docs/api/openapi.yaml) describes its routes, errors and the mapping from the app's `window.claude.use("db")` calls; `backend/src/api/routes.ts` is the route table the handlers and the stack share, and a test keeps the two in step.

| Route | Auth | Function |
| --- | --- | --- |
| `GET /teams/{teamId}/products`, `GET /teams/{teamId}/sheets` (`?orderBy=date&direction=desc`, `limit`, `cursor`) | Cognito access token | `data` |
| `GET`, `PUT` (set), `PATCH` (deep-merge update), `DELETE` `/teams/{teamId}/products/{key}` and `/teams/{teamId}/sheets/{sheetId}` | Cognito access token | `data` |
| `GET /me`, `POST /teams`, `POST /invites/{inviteId}/accept` | Cognito access token | `account` |
| `POST /auth/session`, `/auth/refresh`, `/auth/sign-out` | Refresh-token cookie and `Origin` | `auth` |

**Team isolation**, two layers:

1. **Membership, in the handler.** API Gateway's JWT authorizer checks the token; the handler also requires an unexpired access token and takes the user from `sub`. The team comes only from the path: `authorizeTeam` reads the caller's `MEMBER` item on every request (so a role change applies at once) and issues the `TeamContext` every data function needs. A body that names a team, or any server-owned field, is refused. Viewers can read; a viewer's write gets 403 `invalid_argument`, which the app shows as view-only access.
2. **IAM, `dynamodb:LeadingKeys`.** The data function's own role has no DynamoDB access. For each team it assumes the `DataAccessRole` with the session tag `teamId=<path team>` (cached for up to an hour per team), and that role allows `GetItem`, `PutItem`, `DeleteItem` and `Query` only on items whose partition key is `TEAM#${aws:PrincipalTag/teamId}`, or the team's date index partition `TEAM#…#SHEETS`. Every item a team route touches is in one of those two partitions, so a bug that built another team's key would be refused by IAM too.

**First sign-in and teams** (`supply-checkout-l5y`; the app's side is in [docs/api/onboarding.md](docs/api/onboarding.md)). `GET /me` lists the caller's teams (role, plan, trial status) and the live invites for their **verified** email. `POST /teams` creates a team with the caller as owner, `homeRegion` from the serving region and a 14-day trial; it's idempotent per `Idempotency-Key` (the team's ID is derived from the user and the key, and its creation is conditional) and limited to 5 teams per user per UTC day by a counter in the user's partition. `POST /invites/{inviteId}/accept` joins the team that invited the caller's verified email, once and before expiry. The email comes from Cognito's `GetUser`, called with the caller's own access token.

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

### Live updates

The `realtime` stack (`lib/stacks/realtime-stack.ts`, [ADR 0006](docs/adr/0006-api-and-realtime-sync.md), `supply-checkout-dpc`) is an AppSync Events API with one channel per team, `/teams/<teamId>`, at `realtime.<env domain>`. [docs/api/realtime.md](docs/api/realtime.md) is the client contract: how to connect, the event shape, reconnecting and the polling fallback.

- **Subscribing.** Clients connect and subscribe with their Cognito access token. A Lambda authorizer (`backend/src/realtime/authorizer-handler.ts`) verifies the token (signature, issuer, expiry, the web client, `token_use=access`) and allows a subscription only to exactly `/teams/<teamId>`, and only if `authorizeTeam`, the data API's membership check, passes. Nothing is cached. Publishing takes IAM, and only the stream consumer's role may.
- **Publishing.** A consumer (`backend/src/realtime/publisher-handler.ts`) reads the table's stream, filtered to `PRODUCT#` and `SHEET#` items, and publishes `{collection, id, op, version}` for each write, with no document data: clients fetch through the data API, which checks membership on every request, so a member removed while connected gets no more contents. Partial batch failures are retried from the first unsent record; a batch that keeps failing goes to `supply-checkout-<env>-live-updates-dlq`. Alarms: Live updates failing, delayed and dropped ([docs/journeys.md](docs/journeys.md)).
- **Regions.** The custom domain is added where its certificate is (`GLOBAL_SERVICES_REGION`). The consumer runs in the primary region, which has the table's stream; the second region's consumer is phase 2.

**Deploying.** The realtime stack reads, from SSM in its region: the table's stream and key ARNs (data stack), the user pool ID and web client ID (identity stack) and the `realtime.` certificate (the domain stack in `GLOBAL_SERVICES_REGION`). Deploy it after those, and before observability:

```bash
npx cdk diff supply-checkout-staging-us-east-1-realtime --profile <staging profile>
npx cdk deploy supply-checkout-staging-us-east-1-realtime supply-checkout-staging-us-east-1-observability --profile <staging profile>
```

Then measure the 2-second p95 and the reconnect behavior in staging as described in [docs/api/realtime.md](docs/api/realtime.md#measuring-after-a-deploy).

## Backend

`backend/` holds the Lambda code (ADR 0002, 0006). It is a separate npm package with its own lockfile. `backend/src/observability` gives every handler structured JSON logs and business metrics ([Powertools for AWS Lambda](https://docs.powertools.aws.dev/lambda/typescript/)): `createObservability()` returns a `logger` and `count(metric, n, metadata)`, and `withObservability(obs, handler)` adds the request ID to every log line and flushes metrics after each invocation. Metrics go out as CloudWatch embedded metric format in namespace `SupplyCheckout`, with `Region` as their only dimension; per-team detail goes in metadata, never a dimension.

It also has the HTTP API's handlers in `backend/src/api` (see [Data API](#data-api)), and the data-access module, `backend/src/data`:

- **Team-scoped access.** Every read and write of a team's data takes a `TeamContext`. Every function that can issue one lives in `src/data/team-context.ts`, and the issuer itself isn't exported. `authorizeTeam(db, userId, teamId)` checks the MEMBER item; the authorizer calls it with the user ID from the verified token. `createTeam`, `acceptInvite` and `teamContextForStripeCustomer` issue a context for the new owner, the new member and the billing webhook. `acceptInvite` takes the caller's verified email, and its transaction re-checks that the stored invite is for that email, unexpired and unused. Each function checks the role (viewer, contributor, owner, system) before it writes. The `Db` handle from `createDb` is opaque: it exposes no DynamoDB client.
- **At least one owner.** The team item keeps an `owners` count. Every change to an owner membership updates it in the same transaction, and a decrease is conditioned on `owners > 1`. Owner actions on other members also re-check the caller's own MEMBER item at write time.
- **One way in.** Outside `src/data`, ESLint (`backend/eslint.config.js`) bans any `@aws-sdk/*dynamodb*` package or path inside one, and any file under `data/` except `data/index.js`. This covers static imports, re-exports, `import()` and `require`. Tests are exempt, to inspect stored items.
- **Region-ready** ([ADR 0010](docs/adr/0010-multi-region-active-active.md)). Every team gets `homeRegion` when it's created, from `AWS_REGION`. `writeRegionFor` in `src/data/region.ts` is the one function that decides where a team's writes go; in the MVP it always returns the local region.
- **Documents.** `src/data/documents.ts` serves the app's document model (`products/<key>`, `sheets/<id>`: get, set, deep-merge update, delete, list) on the same items the typed functions use. Every write reads the item and puts the new one on the condition that its version (and a product's `stock`) hasn't changed, so each write is one stream record with a new version.
- **Keys.** As in ADR 0005, except sheets: `SHEET#<sheetId>` instead of `SHEET#<date>#<id>`, because the date is editable and a key can't change. Date order comes from `GSI1` (`TEAM#<teamId>#SHEETS`, `<date>#<sheetId>`), which one update can change. `GSI1` also finds invites by the SHA-256 hash of their token, and `GSI2` (`INVITEE#<SHA-256 of the email>`, `INVITE#<inviteId>`) finds them by the invitee's email. `USER#<userId>` / `LIMIT#TEAMS#<date>` counts the teams a user created that day (TTL two days).

```bash
cd backend
npm ci
npm run lint        # tsc type-check and ESLint, including the DynamoDB ban
npm test            # vitest; the access-pattern tests need DynamoDB Local
```

`test/data-api.test.ts` and `test/account-api.test.ts` run the data and account handlers against an in-memory table that refuses calls outside the partitions the request's session tags allow, as the IAM policies do; they have the isolation negative tests. The access-pattern tests (and `test/documents.test.ts`) run every entity in ADR 0005 against [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html), each test file in a fresh table. They're skipped unless `DYNAMODB_ENDPOINT` is set. To run them locally with Docker:

```bash
docker run --rm -d -p 8000:8000 amazon/dynamodb-local:3.0.0
DYNAMODB_ENDPOINT=http://localhost:8000 npm test
```

## Supported browsers

The current and previous major versions of Chrome, Edge, Firefox and Safari on desktop, and on phones and tablets: Safari on iPhone and iPad, Chrome on Android, Samsung Internet and Firefox for Android, at widths from 320 px up, in portrait and landscape. The desktop list is the `browserslist` field in `package.json`, and both builds compile their JavaScript and CSS for it (`build.target` in `vite.config.js`).

| Browser | Test project | Device and viewport | Builds tested |
| --- | --- | --- | --- |
| Chrome (desktop) | `desktop-chrome` | 1280 × 720 | artifact, web |
| Safari (iPhone) | `iphone-safari` | iPhone 13, 390 × 664 | artifact, web |
| Firefox (desktop) | `desktop-firefox` | 1280 × 720 | web |
| Safari (desktop) | `desktop-safari` | 1280 × 720 | web |
| Microsoft Edge (desktop) | `desktop-edge` | 1280 × 720 | web |
| Chrome (Android phone) | `android-chrome` | Pixel 7, 412 × 839 | web |
| Chrome (Android phone, landscape) | `android-chrome-landscape` | Pixel 7, 863 × 360 | web |
| Chrome (Samsung phone) | `galaxy-chrome` | Galaxy S24, 360 × 780 | web |
| Safari (iPad) | `ipad-safari` | iPad Mini, 768 × 1024 | web |
| Safari (iPad, landscape) | `ipad-safari-landscape` | iPad Mini, 1024 × 768 | web |

The artifact build only runs on claude.ai, so it's tested in desktop Chrome and iPhone Safari; the web build is tested in every browser above. The mobile projects emulate each device's screen size, pixel ratio, touch and user agent in Playwright's Chromium and WebKit, not the real phone browser.

`tests/layout.spec.js` checks that no screen scrolls sideways at 320, 360, 390, 430 and 768 px wide, and at each project's own viewport (which covers landscape).

Two mobile browsers can't be automated in Playwright:

- **Samsung Internet** is built on Chromium's Blink engine, so `android-chrome` and `galaxy-chrome` cover its rendering and JavaScript.
- **Firefox for Android** uses Gecko, which `desktop-firefox` covers, while the phone layout is covered by the mobile projects above.

No Playwright project exercises the camera, the phone's photo picker or real touch input, so each release gets a check on real phones: see [Real-device check](#real-device-check) under Releases.

## Tests

`npm test` runs these Playwright suites against an in-memory mock of the claude.ai runtime (`tests/mock-claude.js`), once for each build: the artifact build in desktop Chrome and an iPhone-sized Safari (WebKit), and the web build in every browser and device project (above). `npm run test:artifact` and `npm run test:web` run one build (the web build's run also builds and tests the demo); `BUILD=web npx playwright test …` does the same for a single file or test, and `--project=desktop-firefox` picks one browser. Each run builds the app first (`tests/global-setup.js`), so it always tests the current source.

### Running tests on a laptop

A full run starts a browser in every worker, and WebKit workers can each take over a gigabyte. Several at once, with other apps open, have used up a 16 GB laptop's memory and swap and frozen the screen. Two guards keep local runs in bounds:

- **Fewer workers.** Locally, Playwright uses one worker per 8 GB of RAM, and at most half the CPU cores (`localWorkers` in `playwright.config.js`). That's 2 on a 16 GB laptop. Pass `--workers=N` to change it for one run. CI uses Playwright's default.
- **One run at a time.** Each run takes a lock in the repo's shared `.git` directory (`tests/run-lock.js`), so a run started in another worktree waits and prints which run it's waiting for. A lock left by a run that was killed is taken over automatically. CI skips the lock.

While working on a change, run just the file and browser you're touching, e.g. `npx playwright test tests/sheets.spec.js --project=desktop-chrome`. Save `npm run check` for before you open a PR; CI runs every browser and build anyway.

| Suite | What it checks |
| --- | --- |
| `app.spec.js` | Core flows: sheets, checkout and return, storage counts, items without barcodes, receipt review, CSV export, view-only access |
| `a11y.spec.js` | axe-core WCAG 2.1 A/AA scan of every screen, in light and dark mode |
| `layout.spec.js` | No sideways scrolling at 320px and 390px phone widths |
| `resilience.spec.js` | Missing capabilities, failed receipt reads, full storage, lost write permission, and resuming an unsaved receipt |
| `sheets.spec.js` | Editing, filtering, reopening and deleting sheets; editing and removing lines; picking and returning items without barcodes |
| `inventory.spec.js` | Adding, editing and deleting items; storage counts and totals; view-only and disconnected states |
| `barcode.spec.js` | Reading barcode photos with the browser's detector or ZXing, at several sizes, and when the photo can't be read |
| `receipts.spec.js` | Receipt review: clients, existing sheets, name and price choices, barcodes, splitting, every save check, and partial save failures |
| `startup.spec.js` | Starting without the runtime or with capabilities declined, lost connections, download failures, and saved-draft problems |
| `failures.spec.js` | Every kind of save that can fail leaves the screen as it was |
| `legacy-data.spec.js` | Sheets and items missing fields that older versions didn't save |
| `concurrent.spec.js` | Someone else changing or deleting data while a form is open |
| `demo.spec.js` | The demo build (web runs only): the banner, a checkout, a receipt and a download with no requests outside the page, Google Fonts and cdn.jsdelivr.net; a reload starting over; the banner's accessibility and 320px layout |
| `dev-server.spec.js` | `npm run dev` and its query-string options |

Every test also fails if the page throws an uncaught error or logs a console error.

### Coverage

`npm run test:coverage` runs the suites in desktop Chrome with code coverage on, once for each build. Coverage is mapped back to the files in `src/` through the builds' source maps. A run fails if lines, statements, functions or branches fall below **98%** (`THRESHOLD` in `tests/coverage.js`). CI runs this on every pull request.

When coverage is too low, `coverage/<build>/uncovered.txt` lists each gap by `src/` file and line: lines that never ran, lines that only partly ran, and branches that never ran. `coverage/<build>/index.html` is the full report; CI uploads each as the `coverage-report-artifact` and `coverage-report-web` artifacts. The web build is minified, so its statement count is smaller than the artifact's; lines, functions and branches come out close to the same.

The mock (`tests/mock-claude.js`) has opt-in failure modes, so tests can reach error paths: a missing runtime, declined capabilities, failed or path-specific writes, lost listeners, failed downloads, and a receipt read that waits to be cancelled. `window.__mock.notify()` fires live updates after a test changes `window.__mock.docs`, to act as another user.

## Contributing to main

`main` is protected. Every change goes through a pull request that is **squash-merged**, and the PR title becomes the commit message. Merging requires the **CI passed** check, and the branch must be up to date with `main`. Force pushes and branch deletion are blocked, and history stays linear.

Write PR titles in [Conventional Commits](https://www.conventionalcommits.org/) style. CI rejects titles that don't match.

- `fix: …` → patch release
- `feat: …` → minor release
- `feat!: …` → major release
- `docs:`, `test:`, `ci:`, `chore:`, `refactor:` → no release on their own

## CI

`.github/workflows/ci.yml` runs on every pull request, on pushes to `main`, and on release-please's pull request. The **CI passed** job succeeds only if every job below passes (or is skipped because it doesn't apply):

| Job | Gate |
| --- | --- |
| PR title | Conventional Commits format |
| Lint and validate HTML | ESLint on `src/`, `demo/`, scripts and tests; builds all three and runs html-validate on each |
| Lint GitHub workflows | actionlint |
| No region names outside the config module | `scripts/check-region-strings.mjs`: fails on any AWS region name in `infra/`, `backend/` or `src/` outside `infra/lib/config.ts` (ADR 0010) |
| Shell scripts | shellcheck on `scripts/*.sh`, and the `land-pr.sh` tests against a fake `gh` |
| Secret scan | gitleaks on every commit in the history, and `scripts/check-public-safety.mjs` on every file (AWS account and SSO identifiers, email addresses, AWS and Stripe keys, private keys) |
| Dependency audit | `npm audit` fails on high-severity advisories; dependency review fails a PR that adds a moderate-or-worse vulnerable package |
| CodeQL (javascript-typescript), CodeQL (actions) | CodeQL `security-extended` queries on the app, scripts, tests and workflows (`.github/workflows/codeql.yml`, which also runs weekly). Results go to the repository's code scanning alerts |
| Backend | Only when `backend/`, `docs/api/` or the CI workflow changes (always on `main`): `npm audit`, type-check and ESLint (with the DynamoDB ban), the handler and OpenAPI tests, and the data-access tests against DynamoDB Local, which runs as a service container |
| Infra | Only when `infra/`, `backend/` or the CI workflow changes (always on `main`): `npm audit`, type-check and ESLint, the CDK unit and snapshot tests (which skip Lambda bundling), and a synth with cdk-nag (which bundles the handlers with esbuild from `backend/`) for the deployed region and for both regions; the tests also synth every stack, identity and web included, in each region on its own |
| Tests (browser, artifact or web build) | All test suites, in twelve parallel jobs: desktop Chrome and iPhone Safari against each build, and desktop Firefox, Safari and Edge, Android Chrome (Pixel portrait and landscape, Galaxy) and iPad Safari (portrait and landscape) against the web build. The web jobs also test the demo build. Desktop Chrome also fails below 98% code coverage and posts a coverage table to the job summary. A test that only passes on its retry fails the run. A failure uploads the Playwright report and traces as a workflow artifact |

## Releases

`.github/workflows/release.yml` uses [release-please](https://github.com/googleapis/release-please). It keeps a release pull request open with the next version number and changelog, and starts CI on it (pull requests opened by GitHub Actions don't start CI on their own). Merging that PR tags the version, re-runs the full CI suite, then builds the artifact from the tag and attaches it to the GitHub Release as `index.html`, along with an SPDX JSON SBOM (`supply-checkout-<tag>.spdx.json`).

### Real-device check

Playwright can't open a phone's camera, so before publishing a release, check scanning on a real iPhone and a real Android phone: your own phones, or a real-device cloud such as BrowserStack Live. Check the web build and the artifact on claude.ai. Scanning takes a photo through the file input (`capture="environment"`), then decodes it with the browser's `BarcodeDetector` where there is one (Chrome and Samsung Internet on Android) or ZXing otherwise (Safari on iPhone and iPad, Firefox).

1. **iPhone, Safari** (current iOS): open a sheet, tap **Scan to check out**, and photograph a real barcode with the rear camera. The checkout dialog opens with the right item. Then, on the sheet list, tap **Scan receipt**, photograph a paper receipt, and check the review screen lists its lines.
2. **Android phone, Chrome** (current Android): repeat step 1.
3. **Android phone, Samsung Internet** and **Firefox for Android**: open a sheet and scan one barcode in each.
4. On both phones, photograph something that isn't a barcode: the app says no barcode was found and suggests typing the number.
5. On both phones, turn to landscape and back on the sheet and receipt screens: nothing scrolls sideways and no button is cut off.

Note the devices and OS versions in the release PR before merging it.

Dependabot opens weekly update PRs for npm packages and GitHub Actions.

## Publishing to claude.ai

Publishing the artifact is a manual step, because claude.ai artifacts are published from a Claude session rather than from CI. After a release, download `index.html` from the GitHub Release (or run `npm run build:artifact` on the release tag), and ask Claude to republish that file to the existing artifact URL above. Publish `dist/artifact/index.html`, never `src/index.html`: the source page loads its script and styles as separate files, which an artifact can't serve. Publishing to the same URL keeps all saved sheets and inventory.
