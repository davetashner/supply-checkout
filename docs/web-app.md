# The web app

## Web hosting and releases

The web app and the demo are static builds served by one CloudFront distribution from one S3 bucket (`supply-checkout-qk1`).

- **Bucket.** `supply-checkout-<env>-web-<region>-<account>`, in the primary region's `data` stack (stateful, retained, versioned, private, SSE-S3, access logs to `supply-checkout-<env>-logs-<region>-<account>`). Only CloudFront distributions in the account can read it, through origin access control. A release is a folder, `releases/<version>/`, uploaded once and never changed. The second region's bucket, replication and the origin group are phase 2 (`supply-checkout-d79`).
- **Distribution** (`web` stack, `lib/stacks/web-stack.ts`), for the apex, `www.` and `app.`, with the `web` certificate from the domain stack, TLS 1.2+, HTTP/2 and HTTP/3, and standard logs to the logs bucket.
- **Routing and live version.** A CloudFront Function (`lib/web/router.js`, viewer request) routes by host and path:

  | Request | Response |
  |---|---|
  | `app.<domain>/…` | the `app` channel |
  | `<domain>/` | 302 to `https://app.<domain>/`, `Cache-Control: no-store` (until the landing page, `supply-checkout-21q`) |
  | `<domain>/demo` | 301 to `/demo/` |
  | `<domain>/demo/…` | the `demo` channel, with `/demo` taken off the path |
  | any other `<domain>` path | 302 to `https://app.<domain>/`, `no-store` |
  | `www.<domain>/demo…` | 301 to `https://<domain>/demo/` |
  | any other `www.<domain>` path | 301 to `https://<domain>/` |

  Any other host (the distribution's `cloudfront.net` name, or `app.<domain>` with a trailing dot or a port) is treated like the apex. Every `Location` is a fixed URL from the configured host names; nothing from the request (host, path or query string) is copied into one, so there's no open redirect, and query strings are dropped (the app's invite links point at `app.` directly). The 301s say `max-age=86400`. Responses the function makes (the redirects and the 503) never reach the CloudFront cache, and they set HSTS and `nosniff` themselves, because AWS documents the response headers policy for cached and origin responses only.

  To serve a channel, the function reads its live version from a CloudFront KeyValueStore and rewrites the path to `releases/<version>/…`, adding `index.html` to paths that end in `/`. The cache key is the rewritten path, so switching versions needs no invalidation, and the KeyValueStore write reaches every edge within seconds. Until something is published, a channel answers 503. The demo build's URLs are relative (`./assets/…`, including the favicons and the ZXing chunk), so the same release works under `/demo/`; `tests/content-security-policy.spec.js` serves it there.
- **Headers** on every response: `Content-Security-Policy` (`lib/web/content-security-policy.ts`), HSTS (two years, subdomains), `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` and `Cross-Origin-Opener-Policy`. The CSP allows only the app's own scripts (ZXing is bundled, in its own chunk), Google Fonts, inline `style` attributes, and `data:`/`blob:` images, plus the environment's `api.`, `realtime.` and `auth.` for connections. Infra tests check it against `src/index.html`, and `tests/content-security-policy.spec.js` runs the web app and the demo under it in every browser, failing on any violation. If you add a script, font or image host to the app, add it there too.
- **WAF** (CloudFront scope): a rate limit of 2,000 requests per IP per 5 minutes, then the AWS managed IP reputation, common and known-bad-inputs rule groups.
- **Caching.** `scripts/publish-web.mjs` uploads `assets/` with `Cache-Control: public, max-age=31536000, immutable`, and everything else (`index.html`) with `max-age=0, must-revalidate` for browsers and `s-maxage` for the edge, which is safe because a release never changes. Source maps aren't uploaded.

**Publishing.** `scripts/publish-web.mjs` reads the bucket and the KeyValueStore from the SSM parameters under `/supply-checkout/<env>/web/`, so it needs the web stack deployed and an AWS CLI v2 login:

```bash
npm run publish:demo                                            # build:demo, upload as demo-<time>-<commit>, make it live at /demo/
npm run publish:web -- publish --channel app --dir dist/web     # after npm run build:web: the same for app.
npm run publish:web -- publish --channel app --dir dist/web --version 1.3.0 --no-activate   # upload only
npm run publish:web -- activate --channel app --version 1.3.0  # switch, or roll back to any uploaded version
npm run publish:web -- status                                   # live versions and every uploaded release
```

Options: `--env` (default `prod`), `--profile` (default `$AWS_PROFILE`, else `supply-prod`), `--dry-run` (print the writes instead of running them). Publishing a version that already exists fails. Publishing to the `app` channel first writes `config.json` into the folder from the api, identity and realtime stacks' SSM outputs, so those must be deployed; `npm run publish:web -- config` prints it. That `config.json` also marks a release's channel: publishing the demo refuses a folder that has one, and `activate` refuses a release from the other channel, so the app build is never served at `/demo/` or the demo at `app.`.

**First deploy, and the demo live at supplycheckout.com/demo/:**

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
curl -sI https://supplycheckout.com/demo/ | head -20                       # 200, with the security headers
curl -sI https://supplycheckout.com/ | grep -i '^location\|^cache-control'  # 302 to https://app.supplycheckout.com/, no-store
```

Then check https://securityheaders.com/?q=supplycheckout.com/demo/ (it should grade A; `'unsafe-inline'` for style attributes stops it at A rather than A+) and that `https://www.supplycheckout.com/` redirects to the apex and `/demo` to `/demo/`. `https://app.supplycheckout.com/` answers 503 until the real app is published to the `app` channel.

## The web app on AWS

The web build (`npm run build:web`, served at `app.<env domain>`) is the same app as the artifact. `src/aws/main.js` runs first and provides `window.claude.use()` on the backend ([ADR 0004](adr/0004-runtime-adapter.md), `supply-checkout-a2b`); the artifact never includes it, and the tests and the demo bring their own runtime, which it leaves alone.

- **Config.** `config.json`, next to `index.html`: `apiUrl`, `authUrl`, `clientId`, `realtimeUrl` and `realtimeHost`. The publish step writes it from SSM (above), so one build works in every environment and no IDs are committed. Without it the app says shared storage isn't available.
- **Sign-in.** Managed Login with the code flow and PKCE ([Sign-in](infrastructure.md#sign-in)). The API's `/auth/session` redeems the code and keeps the refresh token in an HttpOnly cookie; the access token is only in memory. It's refreshed five minutes before it expires (a scheduled refresh the API doesn't answer is tried again a minute later), and after any 401 (then the request is tried once more). If refreshing fails, the sign-in screen comes back. API requests give up after 15 seconds. Sign out revokes the refresh token (no refresh runs while it does), forgets the chosen team and every team's receipt draft, then signs out of Managed Login; if the API can't be reached, the user stays signed in and is told.
- **Saved on the device.** `localStorage` keeps the last team used and a receipt draft per team (`supplyCheckout.receiptDraft.<teamId>`; the artifact keeps one, without a team), marked with the user ID from `GET /me` (`supplyCheckout.owner`). A session can end without Sign out (it expires, or a sign-out times out here but goes through), so at every sign-in, a different user (or data from before the mark) makes the app forget the saved team and drafts before reading them; the same user keeps them. Storage that can't be read or written is skipped (`src/aws/session.js`).
- **Teams.** After sign-in, `GET /me` decides ([docs/api/onboarding.md](api/onboarding.md)): "Name your team" for a new user (`POST /teams`, one `Idempotency-Key` per name), the invite from an `?invite=<id>&token=<token>` link (kept across sign-in), or the last team used (in `localStorage`). A bar under the header shows the team, a switcher when there are several (switching reloads the page), Members and Import CSV for owners, and Sign out. Viewers get the app's view-only notice: the API refuses a viewer's write with 403 `permission_denied`, `reason: "view_only"`, which `src/aws/db.js` hands to the app as `invalid_argument` (the artifact runtime's view-only code); any other `permission_denied` on a write means the user was removed from the team.
- **Verifying the email address** (`src/aws/verify-email.js`, `supply-checkout-ocjk`). Only a verified address lists and accepts invites. While `GET /me` says `emailVerified: false`, "Name your team" and the invite screen say so with **Verify email**, as does the team bar (a join refused with 403 `permission_denied` shows the prompt too). It opens a dialog: **Send code** (`POST /me/email/code`, Cognito emails a 6-digit code; another can be asked for once a minute), then the code (`POST /me/email/verify`). A wrong or expired code, too many tries (Cognito's limits, 429) and an address another account has each get their own message. Once the code is accepted the app refreshes its tokens, so the pre token generation trigger records a linked user's new address, and loads `/me` again; only when that says verified does the dialog say so, and the screens behind it start again with the new `/me` (its invites). Otherwise it offers Try again. The API makes the Cognito calls with the user's access token rather than the browser, so the app still talks only to the API ([Sign-in](infrastructure.md#sign-in)).
- **Members** (`src/aws/members.js`, owners only). Members opens a dialog listing the team's members with their roles (`GET /teams/{teamId}/members`). An owner changes a role from its menu (`PATCH`) or removes someone with Remove, tapped twice (`DELETE`). While there's only one owner, their role and Leave are off, and the dialog says a team needs an owner; the server enforces the same thing atomically. An owner who changes their own role or leaves sees "Your access changed" and starts again. Invites (pending and failed, and inviting someone) will go below the list.
- **Importing inventory** (`src/aws/import.js`, owners only, for assisted onboarding). Import CSV opens a dialog with a downloadable template (`src/aws/import-template.csv`: the six columns and two made-up example rows, which pass the preview as they are) and a short guide to each column (eaches, cost vs price, pack size, per [ADR 0014](adr/0014-units-cost-and-rounding.md)). The chosen file goes to `POST /teams/{teamId}/imports` as a dry run, and the dialog shows the server's preview (what each row creates or changes) or every problem in the file. Import sends it again with one `importId` per file; if the import doesn't finish, Try again sends the same request, which finishes it without adding anything twice ([backend.md](backend.md)). The imported items arrive through live updates like any other change. The artifact build has no import (it has no server to make it all or nothing).
- **Data.** The `db` calls map onto the data routes as [openapi.yaml](api/openapi.yaml) describes, with the API's error codes passed through. Sheets are listed by ID and sorted in the browser, because the date-ordered route reads an index that can lag a write.
- **Export.** `user.isOwner()` is true for the team's owners, which shows the app's **Export data**; downloads are saved as `.csv` or `.json` files.
- **Live updates.** One subscription to the user's own channel, `/users/<sub>` ([docs/api/realtime.md](api/realtime.md)). Events for other teams are ignored; each of the team's events is fetched through the API; both collections are re-listed after every subscribe, when the tab is shown again and every 10 minutes; the socket reconnects with backoff and with each new token; after three failed connects it polls every 15 seconds (60 while hidden) and retries the socket every 2 minutes. A 403 shows that the user was removed from the team.
- **Not yet.** Receipt reading waits for its endpoint (`supply-checkout-kx8`): `use("sample")` is null behind `RECEIPT_READING` in `src/aws/main.js`, so "Scan receipt" is hidden. Checkout and return are the app's document writes (`src/moves.js`) until the atomic commands exist (`supply-checkout-1dg.1`). Other members' names aren't in the API yet, so their sheets say "Someone".

**Trying it** once the identity, api and realtime stacks are deployed: `npm run build:web && npm run publish:web -- publish --channel app --dir dist/web --env <env>`, open `https://app.<env domain>/`, sign up, name a team, and check a sheet in two browsers at once. Outside prod, `http://localhost:5173` is also an allowed origin: `node scripts/publish-web.mjs config --env <env> > dist/web/config.json`, then `npx vite preview --mode web --port 5173`. There the refresh cookie (`SameSite=Strict`, on the API's site) isn't sent, so each reload signs in again.
