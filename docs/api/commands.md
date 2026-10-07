# Checkout, return and stock commands

How the web app (the AWS adapter, `supply-checkout-a2b`) checks items out,
takes returns and changes stock safely. The routes are in
[openapi.yaml](openapi.yaml) under the `commands` tag; the handler is
`backend/src/api/data-handler.ts` and the transactions are in
`backend/src/data/commands.ts`. [Architecture, section 4](../architecture/README.md#4-checking-out-and-returning)
has the sequence diagram.

## Projects, formerly sheets

Sheets are being renamed projects (bead `supply-checkout-005.6`,
[the plan](../projects-rename-plan.md)). Through the rename's window, about a
week, the server answers both names, so a tab still running the old app keeps
working:

- Every command on a project is at `/teams/{teamId}/projects/{projectId}/<command>`,
  and also, deprecated, at its old path `/teams/{teamId}/sheets/{sheetId}/<command>`.
  Both run the same code with the same role and body checks; calls to the old
  paths are counted in the `LegacySheetsRouteCalls` metric, and the old paths
  are removed once it stays at zero.
- A move's destination is `toProjectId`, or its old name `toSheetId`. Send
  one; both are accepted only with the same value.
- Every answer carries both names of each renamed field, with the same value:
  `result.projectId` and `result.sheetId`, `result.toProjectId` and
  `result.toSheetId`, `result.projectCreated` and `result.sheetCreated`, and
  the documents `project` and `sheet`, `toProject` and `toSheet`. A product's
  movements carry `projectId` and `sheetId`, `fromProjectId` and `fromSheetId`.
- The idempotency check compares requests with the old names mapped to the
  new ones, so a retry sent to `/projects` matches an operation first run on
  `/sheets` (or by the server before the rename), and the other way round.

## Why

The artifact saves a checkout as two writes: the project line (`PATCH` with the
line's new absolute `out`), then the stock (`addStock` in `src/moves.js`, a
read-then-write). Marks on the line and the item keep a retry from counting twice
there, but two people
checking out the same line at once can lose a count, and nothing records why
stock changed.

Each command here is **one DynamoDB transaction**: the line, the stock and a
movement record change together or not at all. Counts are added on the server,
so concurrent checkouts can't lose one. Every command carries an **operation
ID**, so a retry returns the first result instead of applying it again.

The claude.ai artifact build keeps its two-write path ([ADR 0004](../adr/0004-runtime-adapter.md)).

## What the adapter switches

`src/moves.js` sends every checkout and return: through the commands when the
db has `command` (the web build's adapter, `src/aws/db.js`), otherwise as the
artifact's two writes. It saves an item whose stock changes outside a project
(`saveItem`) through the adapter's `saveItem` when there is one, otherwise as
the artifact's document write.

| App action (src/main.js) | Artifact build | Web build (AWS adapter) |
| --- | --- | --- |
| Check out (`checkoutModal`) | `PATCH sheets/<id>` with the whole line, then `addStock(key, -qty)` | `POST /teams/{teamId}/projects/{projectId}/checkout`. No `addStock`. |
| Lost or broken (`finishModal`, Finished Return) | `PATCH sheets/<id>` with the line's new `lost` (and `lostCharge` plus the charge), added to the line as saved now, with the action's mark; no stock write | `POST /teams/{teamId}/projects/{projectId}/lost`. No stock moves |
| Quick take (project list, ADR 0017 §4) | Works out `adhoc-<n>` from the projects it holds, `set`s the project if it doesn't exist, or moves on to the next number if it's been finished, then adds the line as a checkout does, with the action's mark, and reads it again to write the line once more if its mark isn't there (ADR 0017 §6) | `POST /teams/{teamId}/adhoc/checkout`. No `addStock` |
| Move a General Use line to a client project (line editor, ADR 0017 §5) | Two writes with the move's mark: the counts onto the client project's line, then the General Use line replaced by a hidden "moved" marker (ADR 0017 §6) | `POST /teams/{teamId}/projects/{projectId}/move`. No stock moves |
| Return (`returnModal`) | `PATCH sheets/<id>` with `returned`, then `addStock(key, back - before)` | `POST /teams/{teamId}/projects/{projectId}/return`. No `addStock`. |
| Inventory form, "Single items in storage now" (`productModal`) | Reads the item, then `PUT products/<key>`: with the new `stock` if the person changed the count field, otherwise with the stock read now. A changed count over stock that moved since the form opened is refused, and the item is saved with the stock as it is | `PUT products/<key>` without `stock`, if any other field changed, then, only if the person changed the count field, `POST /teams/{teamId}/products/{key}/stock` with `reason: "count"` and `expectedStock` (the count the form opened with). A count field emptied on a counted item stops counting it: `reason: "uncount"`, with `expectedStock`. A count field left as it opened sends no command. |
| Receipt save, General inventory lines (`saveReceipt`) | `PUT products/<key>` with `stock` plus the lines' quantities | `PUT products/<key>` without `stock` (price and name updates), if they changed, then one `POST .../products/{key}/stock` with `reason: "receipt"` per line: its quantity in eaches and its receipt price as `unitCost` |
| Receipt save, a client's lines on an existing project (`saveReceipt`) | Reads the project, then `PATCH sheets/<id>` with the lines added to it and a mark for this receipt in `savedReceipts`; an attempt that finds its mark writes nothing | `POST /teams/{teamId}/projects/{projectId}/lines`, up to 40 lines each, no stock moved |
| Receipt save, company equipment bought for a client (`saveReceipt`, ADR 0017 §2a) | As above, on the line `<key>:bought` with `purchased: true`, at the receipt price, or the typed price with `priceSet: "manual"`, `priceSetBy` and `priceSetAt` (no markup). A new project is set first, then its bought lines are added | The same command, sending the receipt price as `cost` and no `price`, or a typed price with `priceSet: "manual"`; the server adds the markup. A new project is `PUT` first, then its bought lines are added |
| Item history (new) | none | `GET /teams/{teamId}/products/{key}/movements` (not used by the app yet) |

Everything else stays on the document routes: creating, editing and deleting
projects and products, closing and reopening projects, and **correcting a line's
counts or price** (the line edit, a `PATCH` that doesn't move stock). A new
item scanned at checkout is still saved to inventory with `PUT products/<key>`
first, as today; the checkout then copies it.

No document write changes `stock` (`keepStock` in
`backend/src/data/documents.ts`). A product `PUT` or `PATCH` keeps the stored
stock: a body that leaves `stock` out keeps it, one that repeats the stored
value is fine, and any other `stock` is `400 bad_request`. That includes any
`stock` on a new product or on one that doesn't track stock: an item is
created without stock and starts counting with a `count` adjustment, so every
stock level the server holds is backed by a movement. The CSV import
(`backend/src/data/imports.ts`) writes products itself and sets stock, with a
movement (`reason: "import"`) for each change, so it stays consistent with
this. The claude.ai artifact build writes stock in documents, but to claude.ai's
storage, not to this API.

The web build's `PUT` never carries `stock`. The item is saved first (a new
item has to exist before the stock command), then the stock command runs. Each
count is one operation per form, and each receipt line is its own operation, so
saving again after a failure sends the same IDs and nothing is added twice.
The `PUT` is skipped when the item's own fields (all but `stock` and
`updatedAt`) are already what the page holds: a count on its own, or saving
again after a stock command's answer was lost. In that second case the page
holds the version from before the command, so a `PUT` would get `409` and show
"someone else changed this"; skipping it, the same save sends the command
again with the same ID and the server replays it. The
receipt's pack conversion ([ADR 0014](../adr/0014-units-cost-and-rounding.md))
comes later, in the line's quantity and `unitCost` (`stockIn` in
`src/main.js`); the item's price and cost updates stay a document write.

## Requests

All three are `POST` with a JSON body, need the contributor or owner role, and
take the team from the path. Quantities are whole eaches from 1 to 1,000,000.
Money is dollars, 0 to 1,000,000, with at most two decimals: round with the
cent-safe helper before sending, because the server refuses more decimals
rather than rounding ([ADR 0014](../adr/0014-units-cost-and-rounding.md)).

**Checkout**: `POST /teams/{teamId}/projects/{projectId}/checkout` (deprecated: `/sheets/{sheetId}/checkout`)

```json
{ "operationId": "3b241101-e2bb-4255-8caf-4136c566a962", "productKey": "0123", "quantity": 3 }
```

- `productKey` is the line's key: the product key, as the app's `keyOf(code)`
  or `newKey()` makes it. Any key the documents accept works, including
  built-in names like `constructor`, except `__proto__` (400).
- A project that a new line would take past the 350,000-byte document limit
  refuses it with 413 `quota_exceeded`, as does any checkout or return that
  DynamoDB refuses for its 400 KB item limit. Start another project.
- A new line copies `code`, `name`, `price` and `cost` from the product, read
  inside the transaction. The client doesn't send them.
- For an item that isn't in inventory (the "Save to inventory" box unticked),
  also send `name` and `price`, and optionally `code` and `cost`. They're
  ignored when the item is in inventory.
- An existing line's `code`, `name`, `price` and `cost` never change on a
  checkout; only `out` goes up.
- **Company equipment** ([ADR 0017](../adr/0017-company-equipment-and-ad-hoc-checkout.md)):
  a product with `kind: "equipment"` has no client price, so its new line
  copies `code`, `name` and `cost` (its value each) and `kind: "equipment"`,
  without a `price`. An equipment line also records `takenBy` (the caller's
  user ID, from the token) and `takenAt`, set again by every checkout of the
  line, so they name the latest person to take more. Later changes to the
  product's kind never change a line.
- A key ending in `:bought` is refused (400): those lines are bought for a
  client and never come from storage.

- **Not on the General Use project**: a checkout onto a project with `kind: "adhoc"`
  is `400`. Taking for no job is the quick take, below.

**Quick take** ([ADR 0017](../adr/0017-company-equipment-and-ad-hoc-checkout.md),
section 4): `POST /teams/{teamId}/adhoc/checkout`

```json
{ "operationId": "…", "productKey": "0123", "quantity": 2, "date": "2026-10-01" }
```

- A checkout without choosing a project. The body is a checkout's without
  `projectId`, plus an optional `date` (`YYYY-MM-DD`, the person's local
  date; default today in UTC), used only when this take starts a project.
- It goes on the team's open General Use project. When there's none, it starts the
  next one, `adhoc-<n>`: `kind: "adhoc"`, `client: ""`, the `date`,
  `status: "open"`, `createdBy` (the caller) and `createdAt`. A team has at
  most one open General Use project.
- The team's `ADHOC` item keeps the open project's ID and how many General
  Use projects it has made. The take reads it and, in the same transaction as the
  line, stock and movement, either adds to the open project (checking `ADHOC`
  is unchanged and the project is still an open General Use project) or creates
  `adhoc-<n+1>` and points `ADHOC` at it (checking `ADHOC` is unchanged and
  the project doesn't exist). When two people's first takes race, one
  transaction makes the project and the other is cancelled, reads again, and
  adds its line to that project. Neither is lost.
- The response is a checkout's: `result.projectId` names the General Use project,
  `result.projectCreated` is `true` when this take started it, `result.command`
  is `quickTake`, and `project` is the General Use project as it is now. A retry with
  the same operation ID returns the same project. The movement is a
  `checkout` on the General Use project, and the `Checkouts` metric counts it.

**Move a General Use line to a client project** (ADR 0017, section 5):
`POST /teams/{teamId}/projects/{projectId}/move` (deprecated: `/sheets/{sheetId}/move`)

```json
{ "operationId": "…", "productKey": "0123", "toProjectId": "s1" }
```

- `projectId` is the open General Use project, the one the team's `ADHOC` item names
  (checked in the transaction); `toProjectId` an open client project (no `kind`).
  The whole line moves, with its `out`, `returned` and `lost`. The
  transaction also checks that the client project's line, if it has one, is still
  the kind (supply or equipment) it was read as.
- One transaction: the line comes off the General Use project, on the condition
  that the project's version is still the one read (so the counts moved are
  exactly the ones removed; a return that lands meanwhile makes the command
  read again and move the line as it is then); the counts are added to the
  client project's line for the item, which keeps its own `code`, `name`, `price`
  and `cost`, or, if the client project has none, the line arrives as it is, with
  the price it was taken at; and a movement with `reason: "move"`,
  `delta: 0`, `quantity` (the `out`), `returned`, `lost`, `projectId` (the client
  project) and `fromProjectId` (the General Use project). Both projects get a new
  version. For equipment, the client project's `takenBy` and `takenAt` become
  the moved line's when it was taken later.
- **Stock doesn't move**: the items left storage once, at the quick take.
- Refused: a `projectId` that isn't a General Use project, or a `toProjectId` that
  isn't a client project (`400`); either project closed (`409`); no such client project
  (`404`); the item not on the General Use project, or on the client project as the
  other kind (supply or equipment) (`400`); a client project the line would take
  past the document limit (`413`).
- The response has `result`, `project` (the General Use project), `toProject` (the client
  project) and `product: null`. A retry with the same operation ID changes
  nothing more and returns the first result, even when it races the first
  run.

**Add a receipt's lines**: `POST /teams/{teamId}/projects/{projectId}/lines` (deprecated: `/sheets/{sheetId}/lines`)

```json
{ "operationId": "…", "lines": [{ "productKey": "0123", "quantity": 4, "name": "Nitrile gloves", "price": 12.5, "code": "0123", "cost": 9.99 }] }
```

- Items bought on a receipt for a client, added to a project that already
  exists: every line changes in one transaction, or none does, and **stock
  doesn't move** (they were never in storage). A new line takes the request's
  `code`, `name`, `price` and `cost` (the receipt's choices); a line already
  on the project keeps its copy and adds to `out`.
- 1 to 40 lines, each product at most once. The app sends a longer receipt
  as one request per 40, each its own operation. The project must be open, and
  a client project: the General Use project takes no receipt lines (`400`).
- The response has `result` (each line, with `lineCreated`) and the `project`
  as it is now; there's no `product`.
- **Company equipment bought for the client** ([ADR 0017](../adr/0017-company-equipment-and-ad-hoc-checkout.md),
  section 2a). The server reads each line's product inside the transaction.
  When it's equipment, the line goes on the project under `<productKey>:bought`
  with `purchased: true` and no `kind`, whatever the request says, so it
  never merges with the same item on loan. Its price is either:
  - worked out by the server (`priceSet: "markup"`): the line's `cost` (the
    receipt price each, after any pack conversion; required) plus the team's
    `equipmentMarkup` (team settings, 0% when unset), rounded to the cent with
    halves up. Send no `price`.
  - typed by the reviewer (`priceSet: "manual"`): send `price` and
    `"priceSet": "manual"`. The line also gets `priceSetBy` (the caller) and
    `priceSetAt`, so a typed price can be traced after the operation record
    expires.

  A `price` for equipment without `"manual"`, `priceSet` with any other
  value, and a `productKey` ending in `:bought` are all `400`. The transaction
  checks that each line's product is still the kind it was read as, and that
  the markup is the one the price was worked out from; if either changed, the
  command reads again. An existing `:bought` line keeps its price and adds to
  `out`. Each result line for equipment has `lineKey` and `purchased: true`.
  `priceSet` on a supply's line is ignored: a supply's `price` is required,
  as before.
- The app keeps each request's operation ID with the receipt draft, so
  saving again after a lost answer, even after a reload, adds nothing twice.
  A new project from a receipt keeps its ID with the draft too, and a retry
  looks for it before saving it.

**Return**: `POST /teams/{teamId}/projects/{projectId}/return` (deprecated: `/sheets/{sheetId}/return`)

```json
{ "operationId": "…", "productKey": "0123", "quantity": 2 }
```

The line must be on the project, and `returned + lost + quantity` can't be more
than `out`. The app's stepper already stops at what's left; the server
enforces it too, inside the transaction. A line bought for the client
(`purchased: true`) doesn't come back: `400`.

**Lost or broken** (company equipment, [ADR 0017](../adr/0017-company-equipment-and-ad-hoc-checkout.md)
section 3): `POST /teams/{teamId}/projects/{projectId}/lost` (deprecated: `/sheets/{sheetId}/lost`)

```json
{ "operationId": "…", "productKey": "ladder", "quantity": 1, "charge": 80 }
```

- Equipment lines only (`kind: "equipment"`), on an open project, and
  `quantity` at most what's still out (`out − returned − lost`).
- Adds `quantity` to the line's `lost`. Stock doesn't change: it went down at
  checkout, and the item has left the business. A movement with
  `reason: "lost"`, `delta: 0`, the `quantity` and any `charge` goes into
  the item's history.
- `charge` (optional) is dollars for the lot, not each, following the money
  rule. It's added to the line's `lostCharge`, which the project charges the
  client. Not on a General Use project, which has no client.
- The response is a command's, with `stockDelta: 0`.

**Team settings**: `GET` and `PUT /teams/{teamId}/settings`

```json
{ "equipmentMarkup": 25, "expectedVersion": 0 }
```

Not a command, but next to them: the equipment markup above. `PUT` is owners
only (`403 owners_only` for anyone else, checked from the membership item),
and needs `expectedVersion` (0 before the first save; a stale one is `409`).
The markup is a percentage from 0 to 1,000 with at most two decimals. A change
is written to the team's audit log in the same transaction, with who, when,
and the old and new value. `GET` answers `{ "version": 1, "settings": {
"equipmentMarkup": 25 } }` to owners and `{ "settings": {} }` to
everyone else: no response a contributor or viewer gets carries the
percentage, only the prices worked out from it.

**Stock adjustment**: `POST /teams/{teamId}/products/{key}/stock`

```json
{ "operationId": "…", "reason": "receipt", "quantity": 24, "unitCost": 0.42 }
{ "operationId": "…", "reason": "count", "count": 17 }
{ "operationId": "…", "reason": "uncount" }
{ "operationId": "…", "reason": "count", "count": 17, "expectedStock": 20 }
```

The item must exist. A receipt adds to stock (an item that wasn't counted
starts at `quantity`) and records `unitCost`; it doesn't change the item's
`price` or `cost`. A count sets stock to `count` and records the difference.
An uncount stops counting the item: it takes no other field, removes the
item's `stock`, and records a movement taking it to 0 (`delta` is minus the
stock it had, `tracked: true`), with no `count`. Afterwards the item doesn't
track stock, as before its first count. An uncount of an item that isn't
counted changes nothing, and records a movement with `delta: 0` and
`tracked: false`, as a checkout of it does. Like any command, a retry with the
same operation ID changes nothing more.

A count or uncount can send `expectedStock`: the stock the person saw when they
started (the inventory form sends the count it opened with), or `null` for an
item that wasn't counted then. If the stock is something else now (a checkout
or someone else's count got in while the form was open), the command is
refused with `409 aborted`, reason `stock_changed`, and the message says what
it is now: "The count changed while you were editing: it's now 8". It isn't
refused when the stock already is what the command would leave (a count of 8
when it's 8, an uncount of an item that's no longer counted). The check is
made on the same read the transaction is conditional on, so it holds when the
command commits. `expectedStock` is part of the request an operation ID
stands for, so a retry has to send the same one.

## Responses

`200` for a command that ran now or earlier:

```json
{
  "operationId": "3b241101-e2bb-4255-8caf-4136c566a962",
  "replayed": false,
  "result": {
    "operationId": "3b241101-e2bb-4255-8caf-4136c566a962",
    "command": "checkout",
    "reason": "checkout",
    "productKey": "0123",
    "projectId": "s1",
    "sheetId": "s1",
    "quantity": 3,
    "stockDelta": -3,
    "lineCreated": true,
    "snapshot": { "code": "0123", "name": "Nitrile gloves", "price": 12.5, "cost": 9.99 },
    "userId": "<sub>",
    "at": "2026-09-26T12:00:00.000Z"
  },
  "project": { "id": "s1", "version": 8, "data": { "…": "the whole project" } },
  "sheet": { "id": "s1", "version": 8, "data": { "…": "the same document, under its old name" } },
  "product": { "id": "0123", "version": 3, "data": { "…": "the whole product" } }
}
```

- `result` is what the command did, fixed when it first ran. A retry returns
  the same `result` with `replayed: true`.
- `project` and `product` are the documents **as they are now**, read after the
  command, in the same shape as `GET` returns. Put them in the local cache so
  the screen updates before the live update arrives. `product` is `null` for an
  item that isn't in inventory; `project` is `null` if the project was deleted
  since. Stock adjustments have no `project`.
- `stockDelta` is 0 when the item doesn't track stock (it has no numeric
  `stock`), and for a one-off item. For an uncount it's minus the stock the
  item had.
- The project's `version` goes up by one with each checkout or return, so an
  edit screen that sends `expectedVersion` sees the change. So does the
  product's with every change to its `stock` (not for an item that doesn't
  track stock), so an inventory edit made against the version before a
  command gets `409` rather than being saved over a copy it hasn't seen.
- Live updates: the project and product each produce a change event, as a
  document write does.

The toast text the app shows today still works: "Checked out 3 × <name>" from
`quantity` and the line's name in `project.data.items[productKey]`, and
"`n` returned · `back` of `out` back" from the returned line.

## Operation IDs

- Make one with `crypto.randomUUID()` **when the person confirms** the action
  (taps "Add to project" or "Save return"), and keep it with that pending action
  until it settles.
- Send the **same ID on every retry** of that action: after a timeout, a
  dropped connection, a 5xx, a 429, or a 409 from a busy line. It doesn't matter
  whether the first attempt reached the server.
- Make a **new ID** for a new action, including the person tapping the button
  again after a result was shown. Two taps that each produce their own confirmed
  action are two checkouts.
- The web build's adapter does this with an `action` object per confirmed
  form (`src/moves.js`, `src/aws/db.js`): the first attempt makes the ID, and
  every attempt with the same request reuses it, including a second tap while
  the first is still on its way. If the person changes the request after a
  failure (another quantity, say), it's a new operation with a new ID.
  The request is only what the person entered (a return sends the quantity
  they're returning, not a count worked out from the latest copy of the
  line), so a live update that arrives before a retry doesn't change it, and
  a new item saved to inventory on the first attempt isn't saved again.
- The server keeps the result for **7 days**. A retry within that returns the
  first result and changes nothing. After that the ID is forgotten, so don't
  queue retries for longer.
- Reusing an ID for a **different request** (another quantity, item, project,
  command or user) is `400 bad_request`. It never applies either request.

## Errors and retrying

Nothing is ever half-saved: on any error, none of the line, the stock, the
movement or the operation record changed.

| Response | Meaning | What the app does |
| --- | --- | --- |
| `200`, `replayed: false` | Done now | Update the cache from `project` and `product` |
| `200`, `replayed: true` | An earlier attempt did it | The same |
| `400 bad_request` | Refused: malformed, a non-whole or zero quantity, money with more than two decimals, more returned than is out, an item not on the project, an item not in inventory without `name` and `price`, an item whose stored version isn't a number, or a reused ID | Show the message; don't retry unchanged. The web build fetches the project and item, closes the form and shows the message |
| `403 permission_denied`, `reason: "view_only"` | The caller is a viewer | Switch to view-only, as for document writes |
| `403 permission_denied`, `reason: "not_member"` | Not a member of the team | As for document writes |
| `404 not_found` | No such project, or (stock adjustment) no such item | Show the message (the web build handles it as for `400`) |
| `409 aborted` | The project is closed ("Reopen it to …"), or the line or item changed on every retry | Show the message. Safe to retry with the same ID |
| `409 aborted`, `reason: "equipment_out"` | A document write closing a project (Finished Return) while company equipment is still out on it | Ask about each piece still out (back, still at the job, or lost or broken), then close |
| `409 aborted`, `reason: "adhoc_open"` | A document write reopening a finished General Use project while another General Use project is open | Show the message: finish the open one first |
| `429`, `5xx`, timeout, network error | Unknown whether it ran | Retry with the same ID, with backoff |

The server already retries a busy line or item several times on a fresh read
before answering `409`, so `409` from contention is rare.

## Rules the server enforces

- **Open projects only.** Checkout and return need the project's `status` to be
  anything but `closed`, checked inside the transaction. A closed project takes
  no checkouts and **no returns**: to record a late return, reopen the project,
  return, and finish the return again, or correct the line's counts with a
  line edit (which doesn't move stock). This matches the app, which hides the
  scan bar on a closed project ([section 4a](../architecture/README.md#4a-project-states)).
- **Returned never exceeds out**, checked inside the transaction. With
  equipment lost or broken, `returned + lost` never exceeds `out`.
- **No project closes with equipment out.** A `PUT` or `PATCH` that sets
  `status: "closed"` is refused with `409 aborted`, reason `equipment_out`,
  while any equipment line has `out − returned − lost > 0`.
- **The line fields are checked on document writes too** (`documents.ts`):
  a line's `kind` is `"equipment"` or missing and can't change once the line
  exists; `lost` and `lostCharge` are only on equipment lines (a charge only
  on a client project); `takenBy` is text and `takenAt` an ISO time; a changed
  line keeps `returned + lost ≤ out`. A document write can't add a line
  bought for the client or a `:bought` key, or mark or unmark one; it may
  change a bought line's counts or price, and a changed price is stored with
  `priceSet: "manual"`, `priceSetBy` (the writer) and `priceSetAt`. A bought
  line's `returned` stays 0. `takenBy`, `takenAt`, `priceSetBy` and
  `priceSetAt` are the server's: a document write may only repeat what's
  stored. A project's `kind` can't be set, changed or removed by
  a document write, and no document write creates a project whose ID starts
  `adhoc-`: only the quick take makes General Use projects. A product's `kind` is `"supply"` or `"equipment"`, and
  no new product's key ends in `:bought`.
- **One open General Use project.** Closing the open General Use project (`status:
  "closed"`) or deleting it clears the team's `ADHOC` pointer in the same
  transaction, so the next quick take starts `adhoc-<n+1>`. Reopening a
  finished one is refused with `409 aborted`, reason `adhoc_open`, while
  another General Use project is open, and otherwise points `ADHOC` at it. Deleting
  a General Use project doesn't change stock, as for any project.
- **Stock can go below zero.** A checkout takes the full quantity off, even
  when that's more than the count, where `bumpStock` stops at 0. A negative
  count says the storage count was wrong, and a `count` adjustment fixes it;
  clamping would hide that and break reconciliation.
- **Untracked items stay untracked.** Checkouts and returns of an item with no
  `stock` don't change it (a movement with `delta: 0` is still recorded).
  `bumpStock` would start counting such an item at the returned quantity; the
  commands don't. A receipt or a count starts tracking it, and an uncount
  stops tracking it.
- **A restock ends a low-stock acknowledgment** (`backend/src/data/reorder.ts`,
  supply-checkout-005.8). On an item with `ackedAtStock`, a return or receipt
  that takes `stock` above `reorderAt` (or any count that leaves it above)
  removes `ackedAtStock` in the same update, so the next fall to the reorder
  level alerts again. A return or receipt on such an item is also conditional
  on the stock it read, so the decision is made on the stock it adds to: one
  that loses a race is read again and retried like any other conflict.
  Checkouts only take stock down, so they never change it, and items without
  an acknowledgment are updated exactly as before.

## Stock history

`GET /teams/{teamId}/products/{key}/movements?limit=50&cursor=…` returns the
item's movements, newest first, a page at a time (up to 100). Any member can
read it. Each movement has who (`userId`), when (`at`), why (`reason`:
`checkout`, `return`, `receipt`, `count`, `uncount` when someone stopped counting it, `import`, `delete` when the item was deleted, `lost` for equipment lost or broken, or `move` for a line moved from the General Use project to a client project; an uncount and a delete take its stock to 0, and lost and move movements don't change it), the `projectId` for checkouts (quick takes included),
returns, lost equipment and moves (the client project; `fromProjectId` is the General Use project), the `quantity` or `count` (a move's `quantity` is the line's `out`, with its `returned` and `lost`), the change to stock (`delta`), whether the
item tracked stock (`tracked`), the `unitCost` for receipts, any `charge` for lost equipment, and the
`operationId`. Movements are kept as long as the team's data.

## Reconciling stock

The nightly stock-drift check ([journeys.md](../journeys.md), J4, "Stock counts
drifting") is a separate bead. It reconciles each item from the movements:

- For every item with a numeric `stock`, the sum of its movements' `delta`s is
  the change in stock since the item was first counted through a command. A
  `count` movement records the difference from the level it replaced, so the
  sum stays exact across recounts.
- The check keeps, per item, the last reconciled `stock` and the last movement
  it had summed. Each night it reads the item's movements after that one: the
  new `stock` should equal the old one plus their deltas. A mismatch means
  stock changed without a movement: since the document routes can't change
  `stock`, a bug.
- It reads the product, then the movements, and on a mismatch reads both again
  before alarming, so a command that commits between the two reads isn't
  reported as drift.
- The first run for an item takes its current `stock` as the baseline.
- Deleting an item that tracks stock records a `delete` movement taking it to
  0, so an item made again under the same key (which starts untracked) still
  adds up from its whole history when it's next counted.
- Stopping the count (`uncount`) does the same: its movement takes the stock
  to 0, and the item has no `stock` afterwards, so the check skips it while
  it isn't counted. Its baseline can stay: a later count starts from 0, so an
  item reconciled at S, uncounted and counted again at C has movements since
  that add up to C − S, and C still equals S plus their deltas.
- Project lines can be reconciled the same way: the checkout and return
  movements for a project and item add up to its `out` and `returned`, and its
  `lost` movements to its `lost`, unless the line was corrected with a line
  edit. `move` movements count in and out: one whose `projectId` is the project
  adds its `quantity`, `returned` and `lost` to the project's `out`,
  `returned` and `lost`, and one whose `fromProjectId` is the project takes them
  away (the General Use line is gone, so it adds up to 0). A `lost` or `move`
  movement's `delta` is always 0, so it never changes an item's sum, and a
  move never counts stock twice: the quick take's `checkout` took it off
  once. Lines bought for the client (`:bought`) have no movements, as
  no receipt line put on a project does.
