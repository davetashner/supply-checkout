# Checkout, return and stock commands

How the web app (the AWS adapter, `supply-checkout-a2b`) checks items out,
takes returns and changes stock safely. The routes are in
[openapi.yaml](openapi.yaml) under the `commands` tag; the handler is
`backend/src/api/data-handler.ts` and the transactions are in
`backend/src/data/commands.ts`. [Architecture, section 4](../architecture/README.md#4-checking-out-and-returning)
has the sequence diagram.

## Why

The artifact saves a checkout as two writes: the sheet line (`PATCH` with the
line's new absolute `out`), then the stock (`bumpStock` in `src/main.js`, a
read-then-write). A retry or a double tap can take stock down twice, two people
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
artifact's two writes. It saves an item whose stock changes outside a sheet
(`saveItem`) through the adapter's `saveItem` when there is one, otherwise as
the artifact's document write.

| App action (src/main.js) | Artifact build | Web build (AWS adapter) |
| --- | --- | --- |
| Check out (`checkoutModal`) | `PATCH sheets/<id>` with the whole line, then `bumpStock(key, -qty)` | `POST /teams/{teamId}/sheets/{sheetId}/checkout`. No `bumpStock`. |
| Return (`returnModal`) | `PATCH sheets/<id>` with `returned`, then `bumpStock(key, back - before)` | `POST /teams/{teamId}/sheets/{sheetId}/return`. No `bumpStock`. |
| Inventory form, "In storage now" (`productModal`) | `PUT products/<key>` with the new `stock` | `PUT products/<key>` without `stock`, if any other field changed, then, if the count differs, `POST /teams/{teamId}/products/{key}/stock` with `reason: "count"`. A blank count leaves stock as it is. |
| Receipt save, General inventory lines (`saveReceipt`) | `PUT products/<key>` with `stock` plus the lines' quantities | `PUT products/<key>` without `stock` (price and name updates), if they changed, then one `POST .../products/{key}/stock` with `reason: "receipt"` per line: its quantity in eaches and its receipt price as `unitCost` |
| Receipt save, a client's lines on an existing sheet (`saveReceipt`) | Reads the sheet, then `PATCH sheets/<id>` with the lines added to it and a mark for this receipt in `savedReceipts`; an attempt that finds its mark writes nothing | `POST /teams/{teamId}/sheets/{sheetId}/lines`, up to 40 lines each, no stock moved |
| Item history (new) | none | `GET /teams/{teamId}/products/{key}/movements` (not used by the app yet) |

Everything else stays on the document routes: creating, editing and deleting
sheets and products, closing and reopening sheets, and **correcting a line's
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

**Checkout**: `POST /teams/{teamId}/sheets/{sheetId}/checkout`

```json
{ "operationId": "3b241101-e2bb-4255-8caf-4136c566a962", "productKey": "0123", "quantity": 3 }
```

- `productKey` is the line's key: the product key, as the app's `keyOf(code)`
  or `newKey()` makes it. Any key the documents accept works, including
  built-in names like `constructor`, except `__proto__` (400).
- A sheet that a new line would take past the 350,000-byte document limit
  refuses it with 413 `quota_exceeded`, as does any checkout or return that
  DynamoDB refuses for its 400 KB item limit. Start another sheet.
- A new line copies `code`, `name`, `price` and `cost` from the product, read
  inside the transaction. The client doesn't send them.
- For an item that isn't in inventory (the "Save to inventory" box unticked),
  also send `name` and `price`, and optionally `code` and `cost`. They're
  ignored when the item is in inventory.
- An existing line's `code`, `name`, `price` and `cost` never change on a
  checkout; only `out` goes up.

**Add a receipt's lines**: `POST /teams/{teamId}/sheets/{sheetId}/lines`

```json
{ "operationId": "…", "lines": [{ "productKey": "0123", "quantity": 4, "name": "Nitrile gloves", "price": 12.5, "code": "0123", "cost": 9.99 }] }
```

- Items bought on a receipt for a client, added to a sheet that already
  exists: every line changes in one transaction, or none does, and **stock
  doesn't move** (they were never in storage). A new line takes the request's
  `code`, `name`, `price` and `cost` (the receipt's choices); a line already
  on the sheet keeps its copy and adds to `out`.
- 1 to 40 lines, each product at most once. The app sends a longer receipt
  as one request per 40, each its own operation. The sheet must be open.
- The response has `result` (each line, with `lineCreated`) and the `sheet`
  as it is now; there's no `product`.
- The app keeps each request's operation ID with the receipt draft, so
  saving again after a lost answer, even after a reload, adds nothing twice.
  A new sheet from a receipt keeps its ID with the draft too, and a retry
  looks for it before saving it.

**Return**: `POST /teams/{teamId}/sheets/{sheetId}/return`

```json
{ "operationId": "…", "productKey": "0123", "quantity": 2 }
```

The line must be on the sheet, and `returned + quantity` can't be more than
`out`. The app's stepper already stops at what's left; the server enforces it
too, inside the transaction.

**Stock adjustment**: `POST /teams/{teamId}/products/{key}/stock`

```json
{ "operationId": "…", "reason": "receipt", "quantity": 24, "unitCost": 0.42 }
{ "operationId": "…", "reason": "count", "count": 17 }
```

The item must exist. A receipt adds to stock (an item that wasn't counted
starts at `quantity`) and records `unitCost`; it doesn't change the item's
`price` or `cost`. A count sets stock to `count` and records the difference.

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
    "sheetId": "s1",
    "quantity": 3,
    "stockDelta": -3,
    "lineCreated": true,
    "snapshot": { "code": "0123", "name": "Nitrile gloves", "price": 12.5, "cost": 9.99 },
    "userId": "<sub>",
    "at": "2026-09-26T12:00:00.000Z"
  },
  "sheet": { "id": "s1", "version": 8, "data": { "…": "the whole sheet" } },
  "product": { "id": "0123", "version": 3, "data": { "…": "the whole product" } }
}
```

- `result` is what the command did, fixed when it first ran. A retry returns
  the same `result` with `replayed: true`.
- `sheet` and `product` are the documents **as they are now**, read after the
  command, in the same shape as `GET` returns. Put them in the local cache so
  the screen updates before the live update arrives. `product` is `null` for an
  item that isn't in inventory; `sheet` is `null` if the sheet was deleted
  since. Stock adjustments have no `sheet`.
- `stockDelta` is 0 when the item doesn't track stock (it has no numeric
  `stock`), and for a one-off item.
- The sheet's `version` goes up by one with each checkout or return, so an
  edit screen that sends `expectedVersion` sees the change. So does the
  product's with every change to its `stock` (not for an item that doesn't
  track stock), so an inventory edit made against the version before a
  command gets `409` rather than being saved over a copy it hasn't seen.
- Live updates: the sheet and product each produce a change event, as a
  document write does.

The toast text the app shows today still works: "Checked out 3 × <name>" from
`quantity` and the line's name in `sheet.data.items[productKey]`, and
"`n` returned · `back` of `out` back" from the returned line.

## Operation IDs

- Make one with `crypto.randomUUID()` **when the person confirms** the action
  (taps "Add to sheet" or "Save return"), and keep it with that pending action
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
- Reusing an ID for a **different request** (another quantity, item, sheet,
  command or user) is `400 bad_request`. It never applies either request.

## Errors and retrying

Nothing is ever half-saved: on any error, none of the line, the stock, the
movement or the operation record changed.

| Response | Meaning | What the app does |
| --- | --- | --- |
| `200`, `replayed: false` | Done now | Update the cache from `sheet` and `product` |
| `200`, `replayed: true` | An earlier attempt did it | The same |
| `400 bad_request` | Refused: malformed, a non-whole or zero quantity, money with more than two decimals, more returned than is out, an item not on the sheet, an item not in inventory without `name` and `price`, an item whose stored version isn't a number, or a reused ID | Show the message; don't retry unchanged. The web build fetches the sheet and item, closes the form and shows the message |
| `403 permission_denied`, `reason: "view_only"` | The caller is a viewer | Switch to view-only, as for document writes |
| `403 permission_denied`, `reason: "not_member"` | Not a member of the team | As for document writes |
| `404 not_found` | No such sheet, or (stock adjustment) no such item | Show the message (the web build handles it as for `400`) |
| `409 aborted` | The sheet is closed ("Reopen it to …"), or the line or item changed on every retry | Show the message. Safe to retry with the same ID |
| `429`, `5xx`, timeout, network error | Unknown whether it ran | Retry with the same ID, with backoff |

The server already retries a busy line or item several times on a fresh read
before answering `409`, so `409` from contention is rare.

## Rules the server enforces

- **Open sheets only.** Checkout and return need the sheet's `status` to be
  anything but `closed`, checked inside the transaction. A closed sheet takes
  no checkouts and **no returns**: to record a late return, reopen the sheet,
  return, and finish the return again, or correct the line's counts with a
  line edit (which doesn't move stock). This matches the app, which hides the
  scan bar on a closed sheet ([section 4a](../architecture/README.md#4a-sheet-states)).
- **Returned never exceeds out**, checked inside the transaction.
- **Stock can go below zero.** A checkout takes the full quantity off, even
  when that's more than the count, where `bumpStock` stops at 0. A negative
  count says the storage count was wrong, and a `count` adjustment fixes it;
  clamping would hide that and break reconciliation.
- **Untracked items stay untracked.** Checkouts and returns of an item with no
  `stock` don't change it (a movement with `delta: 0` is still recorded).
  `bumpStock` would start counting such an item at the returned quantity; the
  commands don't. A receipt or a count starts tracking it.

## Stock history

`GET /teams/{teamId}/products/{key}/movements?limit=50&cursor=…` returns the
item's movements, newest first, a page at a time (up to 100). Any member can
read it. Each movement has who (`userId`), when (`at`), why (`reason`:
`checkout`, `return`, `receipt` or `count`), the `sheetId` for checkouts and
returns, the `quantity` or `count`, the change to stock (`delta`), whether the
item tracked stock (`tracked`), the `unitCost` for receipts, and the
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
- Sheet lines can be reconciled the same way: the checkout and return
  movements for a sheet and item add up to its `out` and `returned`, unless the
  line was corrected with a line edit.
