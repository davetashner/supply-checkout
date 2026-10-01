# 0014. Count in eaches, keep cost apart from client price, and round money to cents

- Status: Accepted (2026-09-26)
- Date: 2026-09-26
- Amended by: [ADR 0017](0017-company-equipment-and-ad-hoc-checkout.md) (proposed), which adds company equipment: it has no client price and isn't "used" when it doesn't come back, so sections 1 and 2 hold for supplies only

## Context

The data model has one money field and one unit, and no written rules for either:

- **Products** (`products/{key}`) have `code`, `name`, `price` and an optional integer `stock`. `price` is labeled "Price each" and is what a client is charged.
- **Sheet lines** (`sheets/{id}.items[key]`) snapshot `code`, `name` and `price` when the item is first checked out. Later checkouts of the same item add to `out` but keep the first snapshot, and editing the item's inventory price doesn't touch existing sheets ("Sheets keep the price they were checked out at"). The only way to change a line's price is to edit that line. Charge is `used × price`.
- **Receipts** (J5) read a per-unit price for each line. Client lines go onto sheets at the receipt price, and saving writes the receipt price back to the product's `price`. So when a receipt is involved, `price` means **what the business paid**. When someone types an item into inventory, it means **what the client is charged**. A team that marks supplies up has nowhere to keep both numbers, and the next receipt overwrites its markup.
- **Units.** Stock and checkout quantities are whole numbers of whatever the team decided an item is: a bottle, a box of 45 bags, a single filter. There is no conversion from a case to eaches. A crew that buys a case of 12 and takes 3 to a job has to enter the case as 12 items and divide the receipt price by hand.
- **Rounding.** `round2` (`src/format.js`) rounds receipt prices and prices saved from receipts. Sheet totals (`src/sheet-math.js`) add up unrounded floating-point products and rely on `money()` and `toFixed(2)` to hide the drift. Receipt tax is shown as "Tax on receipt (not added)" and never reaches a sheet.
- **The backend** (PR #37, `backend/src/data/`) mirrors this: `Product` has `price` only, and the `SheetLine` validator keeps `name`, `price`, `out` and `returned`. It drops the `code` that the app stores on every line and that the sheet CSV exports as "Barcode".

The customers are small crews that carry supplies to client jobs and bill clients for them (business plan, section 2). The pilot is meant to find out whether they use sheets mainly to **recover charges from clients** or to **cost jobs** (`supply-checkout-u0z.1`). Either way, the first job of the data model is to put the right charge on the client's sheet. The atomic checkout commands (`supply-checkout-1dg.1`) and the CSV import (`supply-checkout-1dg.4`) both need these rules settled before they fix a schema.

## Decision

### 1. Units: stock and checkouts count eaches; a pack size converts purchases

- **Every quantity that's stored is a whole number of eaches**: `stock`, a line's `out` and `returned`, and the `delta` in stock adjustments and movement records. "Each" is the smallest unit the team takes to a job (a bottle, a roll, a box of bags if they never split the box). The team picks it per item, as they do today. No fractions.
- **Products get an optional `packSize`**: a whole number, at least 1, meaning "one purchase unit (case, pack) holds this many eaches". Missing means 1. It is used only where supplies come **in**:
  - **Receipts.** When a receipt line matches a product with `packSize` n > 1, the review shows "1 case = n each" and treats the receipt's quantity and price as per case. Saving adds `qty × n` eaches to stock (or to the client's sheet) at a unit cost of `receipt price ÷ n`, rounded to cents (section 3). The reviewer can switch a line to "priced per each" if the store sold singles. The receipt prompt doesn't change: it already reads the price of one unit as printed.
  - **CSV import.** A `pack_size` column sets it. `stock` in the file is always eaches.
  - **Inventory edit** gets one optional field, "Comes in packs of".
- **Checkout, return and the sheet never see packs.** A crew member checks out 3, not "a quarter case". There is no second unit to choose at checkout, no unit label, and no conversion in the commands.

This covers the case-of-12, take-3 example with one integer field and one division in the receipt review. Buying and checking out in two units, unit labels ("bottle", "gallon"), and fractional quantities (decanted chemicals, feet of wire) wait for the pilot to show they're needed.

### 2. Cost and client price are separate fields; no markup setting yet

- **`price` stays the client price per each**, the number that's billed. Nothing about how it's entered, shown or exported changes.
- **Products get an optional `cost`**: what the business last paid per each, before tax. Missing means unknown.
- **No markup percentage in the MVP.** A team-wide markup needs a settings document that the artifact build doesn't have, and a price derived from a percentage would change whenever the percentage or the cost changed, which is the opposite of the snapshot rule. The owner types a price; the Inventory screen shows cost next to it. Whether a markup setting (applied once, to suggest a price) is worth adding is a pilot question.
- **Receipts set cost, and set price only when the reviewer says so.**
  - Saving a receipt always writes the receipt's unit cost to the matched or new product's `cost`.
  - A **new** product gets `price` equal to its cost (as today), which the reviewer can change on the line.
  - For an **existing** product whose price differs from the receipt, the review keeps today's two-way choice, relabeled "Charge the receipt price" and "Keep the client price". The default:
    - **Keep the client price** when the product already has a `cost` and its `price` is above it. The team has set a markup, and a store receipt shouldn't erase it.
    - **Charge the receipt price** otherwise. This is today's behavior, so a team that bills at cost sees no change.
  - The chosen price goes on client sheet lines and back to the product's `price`, as today.
- **Sheet lines snapshot `cost` too.** At a line's first checkout (or when a receipt creates the line), the line copies `code`, `name`, `price` and `cost` from the product, or from the receipt line. Later checkouts, returns, and edits to the product don't change the snapshot. Editing a line changes its `price` as today; the line's `cost` isn't editable in the MVP. A line with no `cost` is simply unknown.
- **Where each number appears:**

  | Place | Client price and charge | Cost |
  | --- | --- | --- |
  | Sheet screen, sheet CSV (J6) | Yes, unchanged columns | **No.** The sheet CSV is what goes to the client |
  | Inventory screen | "Price each" | New "Cost each" column. Storage value uses cost where it's known, price otherwise |
  | Full data export (`supply-checkout-zuv`) | Yes | Yes, on products and lines |
  | Receipt review | The price to charge | The receipt price, labeled as cost |

  Everyone who can see Inventory sees cost in the MVP. Hiding it from some roles is a pilot question.

### 3. Money: dollars with at most two decimals, rounded per line

- **Keep money as JSON numbers in dollars**, not integer cents. Every stored document in the artifact already uses dollars, the claude.ai build ([ADR 0004](0004-runtime-adapter.md)) reads the same documents, and DynamoDB stores numbers as exact decimals, so `11.97` is stored exactly. Moving to cents would need a second representation in the app, a conversion in the adapter, and a migration of the artifact's data, and would buy nothing that the rules below don't.
- **Every stored money value has at most two decimals and is at least 0.** Clients round with a cent-safe helper before writing (`round2` today; it should become `Math.round(Number((n * 100).toPrecision(12))) / 100` or equivalent, so `1.005` rounds to `1.01`, with a test). The server rejects values with more than two decimals or above $1,000,000 rather than rounding them itself, so it never stores a number the person didn't see.
- **Round once, at the unit price**: when a price is typed, read from a receipt, divided by a pack size, or imported. Halves round up. Because quantities are whole numbers, `used × price` is then an exact number of cents.
- **Totals add line charges in whole cents** (`sheet-math.js` sums `Math.round(used × price × 100)` and divides by 100 once). The sheet total always equals the sum of the rows a client sees on the CSV.
- **Currency is US dollars**, as `money()` already assumes. Other currencies are out of scope for the MVP.
- **Tax.** Prices, costs and charges are all **before sales tax**. The app doesn't add tax to client charges; the team's invoicing tool does. Receipt tax stays "not added": it isn't spread into item costs and isn't put on sheets. The review keeps comparing the items total with the receipt subtotal, not the total.

### 4. Migration: new fields are optional, and missing means today's behavior

No data is rewritten. Existing documents load as they are:

| Missing field | Read as |
| --- | --- |
| Product `cost` | Unknown. The Inventory cost cell shows "—", storage value uses price, and the receipt default is "Charge the receipt price" (today's behavior) |
| Product `packSize` | 1 |
| Line `cost` | Unknown |
| Line `code` | "" (as today) |

- **The claude.ai artifact build** gets the same fields and screens, because it's the same app. Its documents gain `cost` and `packSize` as people use it, and nothing breaks if they don't. The family business can keep billing at cost without doing anything.
- **Writes that replace a whole product must carry the new fields.** The inventory edit form writes the product with `set` and a fresh body, so it must include `cost` and `packSize` or an edit would wipe them. The receipt save already spreads the existing product.
- **Existing money values** with more than two decimals (possible if one was typed before rounding existed) are rounded when read for display and when next saved. The server accepts them on read and rejects them only on write.
- Importing artifact data into a team (`supply-checkout-ig9`) copies documents as they are, with the same defaults.

## Alternatives considered

| Option | Why not (for now) |
| --- | --- |
| **No units until after the pilot** | Simplest, but the case-of-12 receipt is the everyday case for bags, gloves and filters, and dividing by hand is where charges go wrong. One optional integer is cheap to add now and saves 1dg.1 and 1dg.4 a schema change later. |
| **Full units of measure** (a unit per item, purchase and issue units, conversion factors, fractions) | Inventory-system territory. Adds a unit choice to every checkout, which slows the J4 morning flow, before we know anyone needs it. |
| **Markup percentage instead of a cost field** | A derived price moves whenever the cost or percentage changes, so it needs its own snapshot rules, and it can't express items billed at a flat price. It also needs a team settings document the artifact doesn't have. |
| **Both cost and a team markup in the MVP** | Reasonable, and still possible later without a migration. Deferred until the pilot shows teams use one flat percentage. |
| **Integer cents** | Exact by construction, but every existing artifact document is in dollars. It would mean a migration, two representations in one app, and a conversion in both adapters, for a precision problem that "round the unit price, sum in cents" already solves. |
| **Keep receipt prices as client prices** (no cost field) | Today's behavior. Correct only for teams that bill at cost, and a receipt silently overwrites any markup a team has set. |

## Consequences

- A team that bills at cost sees no change. A team that marks up can keep its prices through receipt runs.
- Sheets stay what the client sees: price and charge only. Cost is recorded on every new line, so a job-costing view can be added later from data that's already there.
- One more field in the inventory form and one more column in the Inventory list. Checkout and return screens don't change.
- The server has one money rule and one quantity rule to enforce, and sheet totals always match the sum of their rows.
- Lines checked out before this change have no cost, so any future costing view has to show "cost unknown" for old sheets.

## What this changes in other work

**Adapter contract and backend model** (`backend/src/data`, the AWS runtime adapter `supply-checkout-a2b`, and its contract tests):

- `Product` gains `cost?: number` and `packSize?: number` (integer, 1 to 10,000). `ProductFields` and its validator accept both.
- `SheetLine` gains `cost?: number` and `code?: string`. The validator must stop dropping `code`, which the app already writes on every line.
- One money validator for `price` and `cost` everywhere: finite, 0 to 1,000,000, at most two decimals.
- Quantities (`stock`, `out`, `returned`, stock deltas) are whole eaches, as they already are.

**`supply-checkout-1dg.1` (atomic checkout, return and stock-adjust commands):**

- The checkout command takes a quantity in eaches. When it creates a line, it snapshots `code`, `name`, `price` and `cost` from the product **on the server**, inside the same transaction, so the snapshot can't come from a stale client copy. A client-supplied `name` and `price` are used only for an item that isn't in inventory (a one-off line). An existing line's snapshot is never changed by a checkout.
- Return and stock-adjust take whole eaches and never touch prices.
- Movement records store the change in eaches. A stock adjustment from a receipt records `reason: "receipt"` and the unit `cost`, so the history shows what was paid.
- Validation adds the money rule above to any price the command accepts.

**`supply-checkout-1dg.4` (CSV import):**

- Columns: `name` (required), `barcode`, `price` (required, client price per each), `cost` (per each), `stock` (whole eaches), `pack_size` (whole number, default 1). Headers are matched without regard to case or spacing.
- Money cells may include `$` and thousands separators. Values with more than two decimals are rounded to cents and shown rounded in the preview, so the person sees what will be saved. Negative values, fractional stock or pack sizes below 1 are row errors.
- The existing "re-importing doesn't duplicate" rule matches on barcode, then on name when there's no barcode. A re-import updates price, cost and pack size and **sets** stock to the file's count; it never adds to it.

**App (`src/`), in the bead that implements this:** the Inventory cost column and pack-size field, the relabeled receipt price choice and its default, pack conversion in receipt save, the cost snapshot on new lines, whole-cent totals, and the cent-safe rounding helper. Journeys J4, J5 and J6 keep their current tests; J5 gains tests for the default price choice and pack conversion.

## Open questions for the pilot

> **Open:** these are for the owner and the pilot teams (`supply-checkout-u0z.1`, `supply-checkout-3ww`). The decisions above are sized so any answer is an addition, not a migration.

1. **Do teams mark supplies up, and how?** A flat percentage, a percentage per category, a fixed handling fee per job, or cost pass-through? If most use one flat percentage, add a team markup that *suggests* a price when a receipt or import sets a cost.
2. **Billing recovery or job costing?** If owners want to see cost against charge per sheet (margin per job), add a costing view built on the line `cost` snapshot. The data will already be there.
3. **Should crew members and viewers see cost?** If owners don't want crews seeing margins, hide cost from contributors and viewers. Viewers may include clients.
4. **Does the receipt default price rule match how teams bill?** Watch how often reviewers switch it.
5. **Which items are split from packs?** If crews regularly split cases and also check out whole cases, consider checking out in either unit, with a unit label.
6. **Are fractional quantities needed?** For example gallons of chemical decanted into bottles, or feet of cable. Today they'd have to pick a whole-number each (a quart, a foot).
7. **Sales tax.** Do teams charge clients tax on supplies, and should tax paid on receipts count as part of an item's cost?
