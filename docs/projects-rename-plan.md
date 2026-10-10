# Plan: rename "sheets" to "projects"

Bead `supply-checkout-005.6`. Owner decision (2026-10-06): pilot users call these Projects, so rename everywhere (UI, code, API paths and fields, stored data keys, tests, docs), once, while the House Finch pilot team holds the only real data in prod. This page is the plan only; no code changes come with it.

**Decisions (2026-10-06, owner, answering section 5):** these override the plan below where they differ.

1. **The claude.ai artifact is retired** (PR #506, bead `supply-checkout-005.10`), so nothing keeps a `sheets` storage mapping for it. The artifact-compatibility steps below are dropped. `import-artifact` still accepts an old export with a `sheets` key (dual-accept on import only).
2. **Exports change fully:** JSON key `sheets` becomes `projects` (and `sheet` becomes `project`), the CSV header "Sheet ID" becomes "Project ID", and the export file names say projects.
3. **Movement records are renamed too:** `sheetId` becomes `projectId` and `fromSheetId` becomes `fromProjectId`.
4. **The dual-accept window is about one week.**
5. **"ad hoc sheet" becomes "General Use (no job)"** in the UI; elsewhere "Project" and "Projects", and "job sheet" becomes "project".

Counts below are case-insensitive substring hits of `sheet` on `origin/main`, from `grep -rIio sheet <dir>` (node_modules and cdk.out excluded). "Third-party" hits are words that contain it but are not our concept and must stay.

## 1. Inventory

| Layer | Files | Hits | Third-party hits | Where |
| --- | --- | --- | --- | --- |
| `src/` | 17 | 543 | 6 | `main.js` (240), `moves.js` (46), `aws/db.js` (41), `export.js` (18), `styles.css` (12), `first-run.js`, `sheet-math.js` (file name), `index.html`, `aws/*` copy |
| `backend/` | 55 | 1,929 | 4 | `src/` about 560, `test/` about 1,350, `scripts/import-artifact.ts` |
| `infra/` | 13 | 182 | 6 | `lib/` 14 comment and IAM lines, the rest are two region template snapshots and tests |
| `tests/` | 37 | 1,219 | 3 | `aws-data` (199), `adhoc` (147), `equipment` (99), `sheets` and `find-sheets` specs (file names), `fake-aws.js`, `mock-claude.js` |
| `docs/` | 27 | 833 | 8 | `api/openapi.yaml` (121), `api/commands.md` (100), ADR 0017 (85), `journeys.md`, `architecture/README.md`, `infrastructure.md`, `backend.md`, `backups.md`, `testing.md`, `api/realtime.md`, legal pages, business plan, `moving-to-the-web-app.md` |
| `demo/` | 1 | 3 | 0 | `data.js` seeds `sheets/demo-open`, `sheets/demo-closed` |
| `scripts/` | 7 | 22 | 5 | `dev-server.mjs` help text, `journeys.test.mjs` and `journey-videos/*` fixtures, `restore-drill.test.mjs` (`SHEET#1`) |
| `journeys/`, `site/`, `ops/` | 4 | 35 | 3 | `registry.json` (step text, 23), `marketing.json` (test title), `site/index.html`, `site/clips/clips.json`, `ops/index.html` |
| Root | 4 | 26 | 0 | `README.md`, `CLAUDE.md`, `package.json` description, `CHANGELOG.md` (generated history) |

### Stored data and wire formats (the part that needs a migration)

| Thing | Today | Where defined |
| --- | --- | --- |
| Item key | `PK=TEAM#<teamId>`, `SK=SHEET#<sheetId>` | `keys.sheet`, `prefixes.sheet` (`backend/src/data/keys.ts`) |
| Date index | `GSI1PK=TEAM#<teamId>#SHEETS`, `GSI1SK=<date>#<sheetId>` | `gsi1.sheetsByDate`, `sheetsPartition`; also built by hand in `documents.ts` (`${teamPartition}#SHEETS`) |
| Stored attributes | `type: "sheet"`; line maps `items.<productKey>`; `savedReceipts`; `source` (the receipt a sheet came from) | `documents.ts` `toItem`, `sheets.ts` |
| Ad hoc counter | `PK=TEAM#<teamId>`, `SK=ADHOC`, attrs `count`, `open` (hold `adhoc-<n>` IDs, which are values, not words, and can stay) | `keys.adhoc` |
| Movement records | `SK=MOV...`, attribute `sheetId` (and `fromSheetId`) | `commands.ts` `movementPut` |
| Operation records | `SK=OP#<id>`, `request` string containing `sheetId`, `result` containing `sheetId`, `sheetCreated`, `toSheetId`, `sheet`; expire after 7 days (`OPERATION_TTL_DAYS`) | `commands.ts` |
| Data-API collection | `sheets` (also `Collection` type and `COLLECTIONS`) | `documents.ts`, `routes.ts`, `changes.ts` |
| HTTP routes | `GET/PUT/PATCH/DELETE /teams/{teamId}/sheets[/{sheetId}]`, `POST .../sheets/{sheetId}/{checkout,return,lost,move,lines}`; `POST /teams/{teamId}/adhoc/checkout` (no `sheet` in the path) | `backend/src/api/routes.ts`, `docs/api/openapi.yaml` |
| Command bodies and answers | `sheetId`, `toSheetId`, `fromSheetId`, `sheetCreated`, response `sheet`, `toSheet` | `commands.ts`, `src/aws/db.js` |
| Realtime | `ChangeEvent.collection` and `CollectionEvent.collection` are `"products" \| "sheets"`; stream filter `DOCUMENT_SK_PREFIXES = ["PRODUCT#", "SHEET#"]`. The channel (`/users/<userId>`) has no `sheet` in it | `backend/src/realtime/channels.ts`; consumed by `infra/lib/stacks/realtime-stack.ts` |
| IAM | `dynamodb:LeadingKeys` allows `TEAM#<tag>` and `TEAM#<tag>#SHEETS` | `infra/lib/stacks/api-stack.ts:266` |
| Client runtime | `db.collection("sheets")`, `db.doc("sheets/<id>")`, `ui.tab = "sheets"`, `#tab-sheets` | `src/main.js`, `src/aws/db.js` |
| Export file | JSON key `sheets`; CSV header `Sheet ID`; file `sheetsCsv`/`sheetCsv`. The artifact's JSON export is the import format for `import-artifact` and `docs/moving-to-the-web-app.md` | `src/export.js`, `backend/src/data/artifact-import.ts` (`MAX_EXPORT_SHEETS`, `ArtifactSheet`, `SHEET_FIELDS`, `sheets.items.*` ignored-field names) |
| Emails | About 13 sentences in `backend/src/email/templates.ts` ("your team's sheets and inventory", role blurbs, closing and lapse notices) | `email/templates.ts` |
| Billing copy | Stripe product description "Supply checkout sheets, inventory..." (`backend/src/billing/catalog.ts:64`); this is a Stripe catalog value, so changing it needs the catalog script run (`backend/scripts/stripe-catalog.ts`) | `catalog.ts` |
| Metrics and logs | `service: "sheets"` in a doc comment; metric descriptions mention "a sheet" (names such as `ItemsCheckedOut` don't contain it); log fields named `sheetId` | `observability/*` |
| CSS and DOM | `.sheet-card`, `.sheet-head`, `.sheet-actions`, ids `#sheetView`, `#sheetHead`, `#sheetBody`, `#sheetSearch`, `#tab-sheets`, `data-sheet`, `data-export="sheets"` | `src/styles.css`, `src/index.html`, `src/main.js` |

### Must not change

- **Third-party and platform words:** `spreadsheet(s)` (CSV import and export copy, `csv.ts`, `imports.ts`, the CSV-injection guard in `export.js`), `stylesheet` (`<link rel="stylesheet">`, CSP comments in `infra/lib/web`, the ops router), `CSSStyleSheet` and `document.adoptedStyleSheets` (`scripts/journey-videos/director.mjs`), and any "Google Sheets" mention (a search found none in `src/` or `docs/` beyond `spreadsheet`, but check again at PR time).
- **No bottom-sheet or modal use of the word:** the app's modal is `modal`/`.modal`. `.sheet-*` classes all mean a job sheet. Nothing to exclude.
- **History:** ADRs (0005, 0014, 0017, 0004, 0006, 0010, 0011, 0015) keep their wording, as decisions made at the time. Add one line to `docs/adr/README.md` ("ADRs written before October 2026 call projects 'sheets'") and, in ADR 0005, a one-line "Superseded in part" note that the item prefix is now `PROJECT#`. `CHANGELOG.md` is generated by release-please and keeps its history. The two docs that describe the old artifact (`docs/moving-to-the-web-app.md`) stay in the artifact's words only where they quote the artifact's own screen; see risk 2.
- **Values that merely look like it:** the `adhoc-<n>` IDs and `kind: "adhoc"` (no `sheet` in them).
- **Product-key and ID rules:** `id()` and `productKey()` stay as they are; only the "sheet ID" error text changes.
- **Journey IDs (`J4.1` and the like):** stay stable; only the step text changes. `journeys/marketing.json` names a test by its title, so it changes in the same PR as the test.

## 2. Data model and migration design

### What changes

A DynamoDB key can't be updated in place, so every sheet item is **copied to a new key and the old one deleted**, in one `TransactWriteItems` per sheet (a Put with `attribute_not_exists(PK)` and a Delete with `attribute_exists` on the old key, so a sheet changed mid-run, or moved by a concurrent run, can't be lost or doubled).

| Item | Old | New |
| --- | --- | --- |
| Sheet document | `SK=SHEET#<id>`, `GSI1PK=TEAM#<t>#SHEETS`, `type: "sheet"` | `SK=PROJECT#<id>`, `GSI1PK=TEAM#<t>#PROJECTS`, `type: "project"` |
| Movement | `sheetId` (and `fromSheetId`) | `projectId` (and `fromProjectId`); optional, see below |
| Operation records | `request` and `result` use `sheetId` | **Not migrated.** They expire in 7 days. Deploy so the new code reads either (see section 3) or wait out the TTL |
| `ADHOC` counter | `count`, `open` | unchanged (`open` holds an `adhoc-<n>` ID, which stays) |
| Realtime events | `collection: "sheets"` | `collection: "projects"` |

Decision on movement attributes: rename `sheetId` to `projectId` on movement items too, in the same pass, so no old name survives in the table. A movement is a plain item in the team partition (no key includes the word), so this is an `UpdateItem` per movement with a condition that `attribute_exists(sheetId)`. If the owner would rather not touch history, leave it and have the reader accept `sheetId` as a legacy alias for one release; the bead's acceptance ("no 'sheet' identifiers remain") favors renaming.

Template snapshots: the only "snapshots" are the CDK template snapshots under `infra/test/__snapshots__` (regenerated with `npm run test:update` after the IAM and stream-filter edits; the diff to review is the `LeadingKeys` and filter lines). There is no stored template or snapshot data in the table that holds the word (the `snapshot` field on a command result is a stock snapshot, not a sheet).

Receipts: a receipt saved to a sheet writes `source` (and `savedReceipts` on the sheet) inside the sheet item, so they move with it. Draft receipts are in the browser only (`src/aws/session.js` `draftKey(teamId)`), keyed by team, not sheet. Receipt-usage counters (`USAGE#...`) don't mention sheets.

Stock counts, product items, members, invites, billing and the operator index don't change.

### Migration script

Add `projects-rename` as a mode of the existing `npm run backfill` (`backend/scripts/backfill.ts`, `backend/src/data/backfill.ts`), which already has the pattern the owner knows: dry run unless `--apply`, prints counts only (never emails, names or user IDs), `--table`, `--region`, `--profile`, `--endpoint` for DynamoDB Local, and a refusal to run against the wrong account or table. It needs write access to the table, so it runs under the owner's SSO profile like the other backfills, not the data function's role.

Design:

1. **Scope.** `--team <teamId>` (required for prod's first run; omit for all teams, which is what a later cleanup run uses). A team is found by `Query` of `PK=TEAM#<id>`, `SK begins_with SHEET#` (no table scan needed for the one-team run). For all teams, use a `Scan` with a filter on `begins_with(SK, "SHEET#")` and a projection of keys only.
2. **Per sheet.** Read it consistently, then one transaction: `Put` the copy (same attributes, `SK`, `GSI1PK`, `type` changed, `version` unchanged) with `attribute_not_exists(PK)`, and `Delete` the old key with `version = :seen`. A conflict (a user edited it meanwhile) is retried with a fresh read, up to 5 times, then reported and skipped.
3. **Idempotent.** Re-running finds nothing under `SHEET#` once done. A sheet whose `PROJECT#` copy already exists but whose old item remains (a crash between steps is impossible inside one transaction, but a manual mix is not) is reported as `conflict`, never overwritten; the script deletes the old item only if the new one is byte-equal on every attribute except the renamed ones.
4. **Movements.** Query `begins_with(SK, "MOV")` pages per team (the exact prefix is `movementPrefix`'s, so use the helper), and rename the attribute where it exists, with the same condition. Counted separately.
5. **Dry run output** (default): for each team, counts of sheets to move, movements to rewrite, items that would conflict, total item bytes (so no document is near the 400 KB limit; a copy adds nothing but the name changes by two bytes), and the check below. Nothing is written.
6. **Bounds.** Sequential, one transaction at a time, with a small pause (about 25 writes a second), so the pilot's use isn't throttled and the stream's consumer isn't flooded. House Finch's volume is small, so this takes seconds to minutes. A `--limit <n>` stops after n sheets.
7. **Stream and realtime.** Each move emits a `REMOVE` for `SHEET#` and an `INSERT` for `PROJECT#`. During the window the stream filter accepts both prefixes; the consumer maps both to `collection: "projects"` with `op: "delete"` and `op: "put"`. More than the coalescing threshold in one batch becomes a single `CollectionEvent` ("re-list"), so connected clients just re-list. Users with the app open see their list reload once; nothing is lost.
8. **Idempotency keys.** An open client that retries an operation across the cutover gets either its original result back (old code) or a 400 "operationId already used for a different request" (new code reading an old record with a differently spelled `request`). Prevent this: deploy the new server so it computes the replay fingerprint from a canonical form that maps `projectId` and `sheetId` to the same key, or accept that a retry in the 7-day window within the minutes of cutover may need a new tap. Recommend the canonical form (small, covered by one test); otherwise schedule the cutover when nobody is using the app and wait out the TTL.

### Backup before

- Take an **on-demand AWS Backup** of the `app` table (the same recovery point flow as `docs/backups.md`, "Prove the copy path now") and a **PITR timestamp** noted before the run. Record the recovery point ARN in the PR or bead (not account IDs in the repo).
- Take a **logical export of the one team** as well: a read-only dry run mode that writes the team's `SHEET#`, `MOV...` items to a local file outside git (it holds client names and prices), for a quick item-level restore without restoring the table. `--export-to <path>` on the same mode, refusing a path inside the repo.

### Verification

After the apply, the script re-queries and checks, then prints "Done" only when all hold:

- no item under `SHEET#` and none in `TEAM#<t>#SHEETS` for the team;
- the number of `PROJECT#` items equals the pre-run `SHEET#` count, and the `GSI1` count for `TEAM#<t>#PROJECTS` equals it (GSI1 is eventually consistent, so retry for up to 60 seconds);
- for every moved item, a stable hash of its attributes with the renamed ones normalized equals the pre-run hash (kept in memory from the read);
- every product's `stock` is unchanged (read before and after), and the per-sheet totals from `sheet-math` (counts and charge in cents) equal the pre-run totals, as `import-artifact` already verifies;
- zero movements still carry `sheetId`.

Then the owner signs in as a House Finch user and looks at the list, opens one finished and one open project, checks one out and returns it, and the production alarms stay clear (`journeys.md`).

### Rollback

- **Before the apply, nothing to roll back.** The dry run changes nothing.
- **During or just after:** run the same mode in reverse (`projects-rename --reverse`, which is the same code with the prefix and attribute names swapped; build and test it in the same PR so it exists before it's needed). It's idempotent for the same reasons. Roll the application code back to the previous release (old API accepts `SHEET#` only). Because the server in the compatible-window release (section 3) reads both prefixes, a partial state is also fine to leave running.
- **Last resort:** PITR to a new table (`supply-checkout-<env>-app-restore-*`) and copy the House Finch partition back, per the restore drill. This loses writes made after the recovery point, so use only if the reverse run can't work.
- A new write between the apply and a rollback to `PROJECT#` is carried back by the reverse run, which is why the reverse run, not a restore, is the first choice.

## 3. Rollout order and compatibility

### The compatibility problem

Two kinds of client were in use at once (the claude.ai artifact, a third, is retired; see Decisions) and don't deploy in lockstep:

1. **The web app** (`app.supplycheckout.com`): a static bundle on CloudFront. A tab that was already open keeps running the old JS until reloaded (hours or days), and its service worker or HTTP cache can serve the old bundle after a deploy. It will keep calling `/sheets` and subscribing for `collection: "sheets"` events.
2. **The data in DynamoDB**, moved in one stroke by the migration.

### Options

- **A. Coordinated deploy (no compatibility window).** Deploy server, migrate and deploy web at the same moment. Simplest code, but any open tab breaks (404 on `/sheets`, no realtime events) until reload, and with a pilot team using the app during the day that means "the app stops working" for people who don't know to reload. The 8am to 8pm canary would also page.
- **B. Server accepts both for a window (dual-accept), then remove.** The server serves `/projects` and `/sheets` (the latter as an alias to the same handler), reads `PROJECT#` and, until the migration has run, `SHEET#`, and accepts `sheetId`/`toSheetId` as input aliases. Old tabs keep working, then new code ships, then the aliases are removed. More code (all in `backend/`, so security-reviewed) but no outage.

### Recommendation: B, with the shortest window that works

Reasons: House Finch is a paying pilot (a broken screen on day 1 of feedback is the wrong moment to teach them to reload), the alias is a few lines in `routes.ts` and `commands.ts` input parsing, and it makes the migration safe to run any time in the window, including mid-day. Keep the window to one release cycle (about a week) and to the web app only.

Sequence:

1. **Server release 1 (dual-accept).** Routes `/projects...` and `/sheets...` both map to collection `projects`; request fields accept `projectId` and `sheetId` (and `toProjectId`/`toSheetId`) and responses carry **both** `project` and `sheet` (and `sheetId` next to `projectId`) so an old client can read them. Reads and writes use `PROJECT#` if present, else `SHEET#` for a given ID (a point read of each key; list queries run on both prefixes and merge, de-duplicating by ID, preferring `PROJECT#`); new documents are written as `PROJECT#`. The stream filter accepts both prefixes; realtime events are published with `collection: "projects"`, **and** for the window also `"sheets"` (a second event, within the 5-per-request limit) because an old client ignores an unknown collection and would stop updating. IAM allows both leading keys (`#SHEETS` and `#PROJECTS`). Deploys with `infra` first (IAM, stream filter), then the Lambdas. Needs security review and the owner's deploy approval.
2. **Migration** (section 2), dry run first, then apply for House Finch. Owner-run.
3. **Web release (client rename).** Everything in `src/`, `tests/`, `demo/`, `docs/` switches to projects: UI text, identifiers, CSS, the `projects` collection and paths. Published to CloudFront by the owner.
4. **Wait out the window** (long enough for stale tabs to have reloaded: check the dashboard's request counts on the `/sheets` aliases reaching zero for a day, which needs a metric or log filter on the alias routes; add `LegacySheetsRouteCalls`).
5. **Server release 2 (remove). Done in PR 6 (`supply-checkout-005.6.5`), deployed only after `LegacySheetsRouteCalls` was flat zero for a day and a `--team`-less dry run found no sheet items.** Delete the aliases, the `SHEET#` reads, `sheetId` inputs, the second realtime event, and the IAM and stream-filter extra entries (`import-artifact` keeps reading an export's `sheets` key: that is an external file's format, not an alias); the migration's `projects-rename` mode stays in the repo for one more release for stragglers (a `--team`-less run is a no-op, which is the final check), then is removed.

### The artifact build

Retired (PR #506), so there's no storage mapping to keep. See Decisions at the top.

## 4. PR split

| # | PR | Touches | Review |
| --- | --- | --- | --- |
| 1 | `docs: plan the sheets-to-projects rename` (this page) | docs | none |
| 2 | `feat: server accepts projects and sheets` — dual routes, dual field aliases, dual-prefix reads, both prefixes in the stream filter and IAM, events for both collection names, canonical idempotency fingerprint, `LegacySheetsRouteCalls` metric, OpenAPI documents `/projects` with `/sheets` marked deprecated | `backend/`, `infra/` (IAM, stream filter, snapshots) | **Security review required** (backend, IAM). Focus: LeadingKeys still scoped to `TEAM#<tag>` and the two index partitions; no way for an ID in either spelling to reach another team's items; the new aliases get the same role checks (`routes.ts` `minRole`) and body validation; logs carry no new fields with names |
| 3 | `feat: projects-rename backfill mode` — `projects-rename` and `--reverse` in `backfill`, DynamoDB Local tests (empty team, many sheets, conflicting item, re-run, concurrent edit, reverse), `docs/infrastructure.md` "Backfills" runbook with backup and verify steps | `backend/scripts`, `backend/src/data/backfill.ts`, docs | **Security review required** (backend; writes the table under owner credentials; counts-only output) |
| 4 | `feat: rename sheets to projects in the app` — `src/`, `demo/`, `tests/`, `scripts/`, `journeys/`, `site/`, `README.md`, `CLAUDE.md`, docs, UI text, CSS, `data-testid`s, `sheet-math.js` to `project-math.js`, `sheets.spec.js` to `projects.spec.js`; export JSON key `projects` (the CSV header "Project ID"); "ad hoc sheet" becomes "General Use (no job)". The client speaks the new API only. Backend copy (emails, Stripe description) and `import-artifact` accepting either key go to PR 5 | `src/`, `tests/`, `scripts/`, `journeys/`, `site/`, user docs | No `backend/` lines, so no security review. Coverage gate must stay at 98%; this is a `feat:` (user-visible) |
| 5 | `refactor: rename sheets to projects in the data layer` — `keys.sheet` to `keys.project`, `sheets.ts` to `projects.ts`, `Sheet` types and every `sheetId` in `backend/`; the dual-accept layer from PR 2 stays | `backend/` (large, mechanical) | **Security review required** (large diff in `backend/`; reviewer confirms it's a pure rename plus the aliases) |
| 6 | `fix: remove the sheets aliases` after the window. **Done** (`supply-checkout-005.6.5`): `/sheets` routes, `sheetId` fields, `SHEET#` reads, the second realtime event, `LegacySheetsRouteCalls`, and the `#SHEETS` and `SHEET#` IAM and stream-filter entries are gone; `projects-rename` and `--reverse` stay | `backend/`, `infra/` | **Security review required** (IAM narrowing) |
| 7 | `docs: note the rename in the ADRs` (README note, ADR 0005 pointer) | docs | none |

PRs 4 and 5 can be one if reviewers prefer; they are split so the mechanical backend rename can be reviewed apart from UI copy. Do PR 4's `backend/` copy edits (emails, catalog) in PR 5 instead if that keeps PR 4 out of security review entirely.

Order: 1, then 2, then 3, then (owner) deploy 2, back up, dry run, apply 3, then 4 and 5 (deploy server release 1 first, then publish the web app), wait out the window, then 6 (deploy), then 7. Bead stays open until the owner confirms the prod migration; per the bead the acceptance criteria are "House Finch data migrated and verified in prod, backup and rollback documented, tests, coverage and security review pass".

### Needs the owner

- Approve **both prod deploys** (server release 1, and 6), and the web publish.
- **Run the backup and the prod migration** (dry run output read first), or say go and run it with the owner's SSO profile.
- Approve the Stripe catalog description change if it should be applied (it's a paid-surface change; the existing product keeps its old description until the catalog script is run).
- Merge nothing without the usual: lead lands PRs; security reviews end with a verdict.

## 5. Risks and open questions

Risks:

1. **The artifact's data.** Resolved: the artifact is retired (PR #506), so nothing reads its storage.
2. **Old tabs and caches.** Mitigated by the dual-accept window and the realtime double publish; without them (option A) the pilot sees stale or empty lists until reload. CloudFront caching of the old `index.html` is the same risk on the other side: after the server drops the aliases, any tab still on the old bundle gets 404. Keep the window until the alias metric is flat zero.
3. **Idempotency across the cutover** (operation records are keyed on a fingerprint that contains `sheetId`; section 2, point 8).
4. **GSI1 lag.** The date index is eventually consistent, so the dual-prefix list that merges base-table and index reads can briefly omit a moved project from a date-ordered list. The web client lists by ID and sorts locally (`src/aws/db.js`), so it isn't affected; the verification step waits for the index to settle.
5. **Mid-run writes.** A user editing a project while it moves gets a version conflict and retries; the script's condition makes it safe. Run outside 8am to 8pm Eastern if possible, to avoid the canary and the pilot's day.
6. **Backups and the restore drill** contain `SHEET#` items: a restore of a point before the migration needs the migration run again afterward. Note it in `docs/backups.md` and keep the mode in the repo through the 35-day PITR window and the 90-day copies' retention, so a restore from either is repairable.
7. **Test and doc churn** is large (about 3,100 hits in `backend/`, `tests/` and `docs/`) and mechanical; a wrong global replace can hit `spreadsheet`, `stylesheet` or `CSSStyleSheet`. Use a word-boundary script with an explicit allowlist, and run `npm run check` and `npm run test:coverage` on both builds.
8. **Journey and marketing metadata** (`journeys/registry.json`, `marketing.json`, `site/clips/clips.json`, `docs/journeys.md`) refer to test titles; `npm run test:scripts` checks they match, so rename tests and metadata together.
9. **Prod Stripe and email copy** are separate deploy surfaces from the code; they change only when the owner deploys.
10. **Public repo hygiene.** The migration runbook uses profile, table and recovery-point placeholders; no account IDs, ARNs or team IDs go in committed text (`scripts/check-public-safety.mjs`).

Open questions for the owner (all answered 2026-10-06; see Decisions at the top):

1. The artifact: keep its stored collection named `sheets` behind a mapping (recommended), freeze it at the last "sheets" release, or retire it? Is anyone besides the owner's own data still in it?
2. Singular and plural in the UI: "Project" and "Projects" for both the tab and the "Create your first project" copy; is "job" still used anywhere ("Take supplies without a job sheet", "Out on jobs", "job sheet" vs "ad hoc sheet" in ADR 0017)? Proposed: "job sheet" becomes "project", "ad hoc sheet" becomes "ad hoc project" (or "Quick take list"; owner's call), and "Out on jobs" stays.
3. Exports: the JSON key and CSV header change to `projects` and "Project ID" in PR 4. Does anyone consume the old export format outside `import-artifact` (the pilot's own spreadsheets)? Dual-accept on import is cheap; the export itself would change.
4. Should movement history attributes be renamed (recommended) or left with a legacy alias?
5. Window length: one release cycle (about a week) is proposed; is the owner fine with a one-week alias, and with the migration run during the window rather than at a quiet hour?
6. Does the owner want the migration run by the owner or by an agent given SSO credentials under the owner's eye? (Section 4 assumes the owner.)
