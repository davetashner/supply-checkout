# Supply Checkout SaaS: architecture

This is the target design for running Supply Checkout as a paid, multi-tenant product on AWS at $3 per user per month. Each choice is explained in an [architecture decision record](../adr/README.md); the diagrams below show how the pieces fit together.

## 1. System context

Who and what the product talks to.

```mermaid
flowchart LR
  owner([Team owner])
  crew([Crew member: contributor or viewer])
  subgraph SC[Supply Checkout]
    web[Web app<br/>desktop and mobile browsers]
    apps[iOS and Android apps<br/>Capacitor]
    backend[AWS backend<br/>us-east-1 + us-west-2]
  end
  stripe[(Stripe<br/>web billing, invoices, tax)]
  stores[(App Store + Google Play<br/>in-app subscriptions)]
  rc[(RevenueCat<br/>store receipts + webhooks)]
  bedrock[(Amazon Bedrock<br/>Claude)]
  mail[(Amazon SES<br/>email)]
  support[(Support inbox)]
  artifact[claude.ai artifact<br/>original family version]

  owner --> web
  crew --> web
  crew --> apps
  web --> backend
  apps --> backend
  backend --> bedrock
  backend <--> stripe
  apps -->|owner buys plan| stores
  stores --> rc
  rc -->|webhook| backend
  owner -->|Checkout, Customer Portal| stripe
  backend --> mail
  owner -.-> support
  crew -.-> support
  artifact -. same UI code, ADR 0004 .- web
```

## 2. AWS deployment (active-active)

Both regions serve traffic. Each team has a home region for writes ([ADR 0010](../adr/0010-multi-region-active-active.md)).

```mermaid
flowchart TB
  user([Browser or mobile app])
  r53{{Route 53<br/>latency routing + health checks}}
  cf[CloudFront<br/>+ AWS WAF]

  user -->|app.domain| cf
  user -->|api.domain, realtime.domain| r53

  subgraph E[us-east-1]
    s3e[(S3 web bundle)]
    apie[HTTP API<br/>JWT authorizer]
    lame[Lambda: data, teams,<br/>billing, receipts]
    evte[AppSync Events<br/>channel per team]
    streame[DynamoDB Streams<br/>→ publisher Lambda]
    ddbe[(DynamoDB<br/>global table replica)]
    cog[Cognito user pool<br/>us-east-1 only]
    bre[Bedrock]
    sqse[SQS: Stripe events]
  end

  subgraph W[us-west-2]
    s3w[(S3 web bundle)]
    apiw[HTTP API<br/>JWT authorizer]
    lamw[Lambda: data, teams,<br/>billing, receipts]
    evtw[AppSync Events<br/>channel per team]
    streamw[DynamoDB Streams<br/>→ publisher Lambda]
    ddbw[(DynamoDB<br/>global table replica)]
    brw[Bedrock]
    sqsw[SQS: Stripe events]
  end

  cf -->|primary| s3e
  cf -. origin failover .-> s3w
  s3e -. replication .- s3w

  r53 --> apie
  r53 --> apiw
  r53 --> evte
  r53 --> evtw

  apie --> lame --> ddbe
  apiw --> lamw --> ddbw
  lame --> bre
  lamw --> brw
  lame --> sqse
  lamw --> sqsw
  ddbe <-->|global table replication| ddbw
  ddbe --> streame --> evte
  ddbw --> streamw --> evtw
  lamw -. writes for teams homed in us-east-1 .-> apie

  apie -. JWKS, cached .- cog
  apiw -. JWKS, cached .- cog
  user -->|sign in| cog
```

Shared in both regions and not drawn: KMS keys, Secrets Manager replica secrets (Stripe keys), SES, CloudWatch alarms and dashboards, AWS Backup.

## 3. Reading a receipt

The flow from [ADR 0008](../adr/0008-receipt-reading-bedrock.md). Nothing is saved until the user confirms, just like today.

```mermaid
sequenceDiagram
  autonumber
  actor U as Crew member
  participant App as App (browser or phone)
  participant API as HTTP API + JWT authorizer
  participant L as receipts Lambda
  participant DB as DynamoDB
  participant B as Bedrock (Claude)

  U->>App: Take photo of receipt
  App->>App: Resize to 1568px JPEG
  App->>API: POST /teams/{id}/receipts:read (photo)
  API->>L: Verified user ID
  L->>DB: Membership = contributor/owner?<br/>Subscription active?<br/>ADD usage counter (limit check)
  alt Not allowed or over limit
    L-->>App: 403 / 402 / 429 with a clear message
  else Allowed
    L->>DB: Load team inventory (up to 500 items)
    L->>B: Messages API: cached instructions + inventory + image,<br/>structured output schema
    B-->>L: JSON: store, date, items[], totals
    L->>L: Map inventory ids, log token usage
    L-->>App: Parsed receipt
    App->>U: Review screen (edit, match, assign to sheets)
    U->>App: Confirm
    App->>API: Write products and sheet lines (conditional updates)
    API->>DB: Save
    DB-->>App: Live update to other crew devices (AppSync Events)
  end
```

## 4. Billing and access

How Stripe events turn into access rules ([ADR 0009](../adr/0009-billing-stripe.md)).

```mermaid
sequenceDiagram
  autonumber
  actor O as Team owner
  participant App
  participant API as billing Lambda
  participant S as Stripe
  participant Q as SQS
  participant W as billing worker
  participant DB as DynamoDB

  O->>App: Choose plan and seats
  App->>API: POST /teams/{id}/billing/checkout
  API->>S: Create Checkout Session (customer, price, quantity = seats)
  S-->>O: Hosted checkout page
  O->>S: Pay
  S->>API: Webhook: checkout.session.completed,<br/>customer.subscription.updated
  API->>API: Verify signature
  API->>DB: Record event ID (skip if already seen)
  API->>Q: Queue event
  API-->>S: 200
  Q->>W: Event
  W->>S: Fetch latest subscription
  W->>DB: Update team: plan, seats, status, period end
  DB-->>App: Live update: billing banner clears
  Note over S,W: invoice.payment_failed → status past_due →<br/>7-day grace, then read-only
```

## 4a. Subscribing in the mobile app

Owners can buy a seat-bundle plan in the iOS or Android app ([ADR 0013](../adr/0013-in-app-subscriptions.md)). Store and web purchases end up in the same team fields.

```mermaid
sequenceDiagram
  autonumber
  actor O as Team owner
  participant App as iOS / Android app
  participant API as HTTP API
  participant Store as App Store / Google Play
  participant RC as RevenueCat
  participant W as billing worker
  participant DB as DynamoDB

  O->>App: Open Plans
  App->>API: GET /teams/{id}/billing
  API-->>App: billingSource, plan, status
  alt Team already billed through Stripe or another store
    App-->>O: Show current plan and where to manage it
  else No active subscription
    App->>RC: Fetch offerings (seat bundles, monthly and annual)
    O->>App: Choose "Crew 10, monthly"
    App->>Store: Purchase (RevenueCat app user ID = teamId)
    Store-->>App: Transaction
    App->>RC: Sync purchase
    RC->>RC: Validate with the store
    RC->>API: Webhook INITIAL_PURCHASE (signed)
    API->>DB: Record event ID (skip if already seen)
    API->>W: Queue event (SQS)
    W->>DB: Team: billingSource=app_store, plan, seatLimit, status, periodEnd
    DB-->>App: Live update: plan active
  end
  Note over Store,W: Renewals, billing retry, refunds and cancellations<br/>arrive as RevenueCat webhooks and use the same path
```

## 5. Sign-in and team access

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant App
  participant C as Cognito Managed Login
  participant API as HTTP API
  participant L as Lambda
  participant DB as DynamoDB

  U->>App: Open app
  App->>C: Sign in (email code, passkey, Apple, Google)
  C-->>App: Access + ID token, refresh token
  App->>API: GET /me (Bearer access token)
  API->>API: Verify JWT signature and expiry locally
  API->>L: userId (sub)
  L->>DB: Query USER#userId → teams and roles
  L-->>App: Teams, roles, plan status
  App->>App: Pick team, show or hide edit controls by role
  Note over App,DB: Every later request names the team.<br/>The Lambda re-checks membership. The client never supplies the role.
```

## 6. Data model

One DynamoDB table ([ADR 0005](../adr/0005-multi-tenant-dynamodb.md)). Everything a team owns shares the `TEAM#<teamId>` partition key.

```mermaid
erDiagram
  TEAM ||--o{ MEMBER : has
  USER ||--o{ MEMBER : "belongs via"
  TEAM ||--o{ INVITE : sends
  TEAM ||--o{ PRODUCT : stocks
  TEAM ||--o{ SHEET : records
  SHEET ||--o{ SHEET_LINE : "items map"
  PRODUCT ||--o{ SHEET_LINE : "checked out as"
  TEAM ||--o{ USAGE : "counts receipts"
  TEAM ||--o{ AUDIT : logs
  TEAM ||--o| STRIPE_CUSTOMER : "billed on web as"

  TEAM {
    string teamId PK
    string name
    string plan
    int seatLimit
    string status
    string billingSource
    string homeRegion
  }
  MEMBER {
    string teamId PK
    string userId "sort key"
    string role
  }
  USER {
    string userId PK
    string email
  }
  INVITE {
    string inviteId
    string email
    string role
    int expiresAt
  }
  PRODUCT {
    string key
    string code
    string name
    number price
    int stock
    int version
  }
  SHEET {
    string id
    string client
    string date
    string preparedBy
    string status
    int version
  }
  SHEET_LINE {
    string productKey
    int out
    int returned
    number price
    string name
  }
  USAGE {
    string month
    int receipts
  }
  AUDIT {
    string ts
    string userId
    string action
  }
  STRIPE_CUSTOMER {
    string customerId
    string subscriptionId
  }
```

## 7. Delivery pipeline

From pull request to production, with automatic rollback ([ADR 0012](../adr/0012-cicd-releases-rollbacks.md)).

```mermaid
flowchart LR
  pr[Pull request] --> gates[Lint, HTML validate, actionlint,<br/>unit + Playwright tests,<br/>cdk-nag, CodeQL, audit]
  gates --> preview[Preview stack in dev<br/>journey tests]
  preview --> merge[Squash-merge to main]
  merge --> build[Build once:<br/>web bundle, Lambda zips,<br/>CDK assembly]
  build --> stg[Deploy staging<br/>both regions]
  stg --> stgtest[Journey + smoke tests<br/>against staging]
  stgtest --> rp[release-please PR]
  rp -->|merge = tag vX.Y.Z| prodw[Prod us-west-2<br/>Lambda canary 10% / 5 min]
  prodw --> canw{Alarms + synthetics OK?}
  canw -->|yes| prode[Prod us-east-1<br/>canary]
  canw -->|no| rbw[Auto rollback:<br/>alias + web version]
  prode --> cane{Alarms + synthetics OK?}
  cane -->|no| rbe[Auto rollback]
  cane -->|yes| mobile[fastlane:<br/>TestFlight + Play internal]
  mobile --> art[Attach index.html<br/>for claude.ai artifact]
```

## Costs at a glance

Rough monthly AWS cost for production **before** customers, both regions: Route 53 hosted zone and health checks (about $3), KMS keys (about $2–4), Secrets Manager (about $1–2), CloudWatch Synthetics canaries (about $5–10, the biggest fixed item), and WAF (about $6+). Everything else (Lambda, API Gateway, DynamoDB, AppSync Events, CloudFront, S3, Cognito, SES) is pay-per-use and costs pennies at low volume. Receipt reading is about half a cent to one and a half cents per receipt ([ADR 0008](../adr/0008-receipt-reading-bedrock.md)). Staging and dev add a similar but smaller fixed amount. The business plan bead turns this into a full cost model.
