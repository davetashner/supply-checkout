# 0017. Company equipment and the ad hoc checkout

- Status: Proposed
- Date: 2026-09-30
- Amends: [ADR 0014](0014-units-cost-and-rounding.md), sections 1 and 2 (every line has a client price; whatever isn't returned was used)

## Context

Everything a crew takes from storage is treated the same way today, and it always goes onto a client's sheet:

- **Products** (`products/{key}`) have `code`, `name`, `price` (the client price each), an optional `cost` and `packSize` ([ADR 0014](0014-units-cost-and-rounding.md)), and an optional integer `stock`, the count in storage. There is no notion of what kind of item it is.
- **Sheets** (`sheets/{id}`) have `client`, `date`, `status` (`open`, or `closed` once someone taps **Finished Return**), `createdBy` and `items`, one line per product. A line snapshots `code`, `name`, `price` and `cost` at its first checkout and counts `out` and `returned`.
- **Unreturned means used.** `src/sheet-math.js` works out used as `out − returned` and charges `used × price`. The return screen says so: "Whatever isn't returned counts as used." The sheet CSV (`src/export.js`) lists every line with its charge, and that file is what goes to the client (J6).
- **Finished Return** (`closeSheet` in `src/main.js`) sets `status: "closed"` and `closedAt` without looking at the lines. A closed sheet takes no checkouts or returns, on the server too ([docs/api/commands.md](../api/commands.md)).
- **Returns happen on one sheet.** The person opens the sheet, switches to **Return** and scans. An item that isn't on that sheet gets "Not on this sheet … there's nothing to return", whose only way on is "Check it out instead".
- **Stock moves through commands** in the web build: checkout, return and stock adjustment are each one DynamoDB transaction with an operation ID and a movement record (`reason`: `checkout`, `return`, `receipt`, `count`, `import` or `delete`; `backend/src/data/commands.ts`). The claude.ai artifact build has no transactions or conditional writes, so it writes the line and then the stock, with a mark per action so a retry doesn't count twice ([ADR 0004](0004-runtime-adapter.md), `src/moves.js`).

Two things crews do every week don't fit:

1. **Company equipment.** Ladders, cutting mats, extension cords and vacuums go to a job and come back. The client isn't charged for using them. (Sometimes a team buys one for a client and bills it; that's a purchase, not a loan.) Checked out on a sheet today, an unreturned ladder is "used" and charged at its price, so crews either leave equipment off the sheets (and lose track of it) or give it a price of $0 (and then it's "used" when it doesn't come back, which hides that it's missing).
2. **Taking supplies without a job sheet.** A crew member grabs a box of gloves for the van, or for several small jobs, or before they know which job it's for. There's no sheet to put it on, so they create a fake client ("Van", "Misc"), or take it without recording it and the storage count drifts. Bringing it back means finding whichever sheet it went on, and the return screen dead-ends on any other sheet.

The owner decided how both should work on 2026-09-30 (bead `supply-checkout-2jra`). This record turns those decisions into a data model, commands and server rules for both builds, so the feature beads (`supply-checkout-h9to`, `supply-checkout-mdae`) start from one design.

## Decision

### 1. An item is a supply or company equipment

- **Products get an optional `kind`: `"supply"` or `"equipment"`.** Missing means `"supply"`, today's behavior: used up, and charged to the client at `price`.
- **Equipment is reused, and taking it to a job isn't charged.** It has no client price: the inventory form hides **Price each** for equipment, and saves the product without `price`. It keeps a **value**, what the business paid for one, in the existing **`cost`** field, labeled **Value each** for equipment. Using `cost` rather than a new field means a receipt that buys a ladder records its value the way it records any cost ([ADR 0014](0014-units-cost-and-rounding.md), section 2), and the Inventory screen's storage value (stock × cost) already works.
- **The inventory form** gets a choice at the top, **Supply (used up, charged)** or **Company equipment (reused, not charged)**. Changing an item's kind doesn't change any sheet: lines keep the kind they were checked out as (below), like their price.
- **Receipts.** A receipt line that matches equipment can go to **General inventory** or to a client's sheet, as any line can. In General inventory it adds to stock and sets the item's value (`cost`), as for a supply, and is never charged. On a client's sheet it's **bought for the client** and charged (section 2a).
- **Inventory** gets a **Supplies / Equipment** filter (both shown by default, as today). With **Equipment** picked, a second toggle switches between:
  - **In**: equipment in storage, with its count and value, as the list shows it today.
  - **Out**: every open sheet with that equipment still out, one row each: the item, how many, the sheet (the client, or "Ad hoc"), who took it and when. "Who" and "when" come from the line (`takenBy`, `takenAt`, below), so the view needs nothing but the sheets the app already holds.

### 2. On a sheet, equipment is a separate section that isn't charged

- **Lines get a `kind`**, snapshotted from the product at the line's first checkout, like `price` and `cost`: `"equipment"` for equipment, and missing for supplies. Later checkouts and edits to the product never change it.
- **Equipment lines also record who took them**: `takenBy` (the user ID, as `createdBy` on a sheet; in the artifact without one, the name typed on the sheet) and `takenAt`, set on every checkout of that line, so they name the latest person to take more. The full history is in the movements (web build).
- **The sheet shows equipment in its own section, "Equipment (not charged)"**, below the supplies, with **Taken**, **Returned** and **Still out** (and **Lost or broken** when there is any). No price or charge column.
- **Equipment on loan is left out of the sheet's totals and the sheet CSV.** `totals()` and `lineCharge()` skip lines with `kind: "equipment"` (equipment bought for the client is a charged line without a `kind`, section 2a); the Taken / Returned / Used / Charge tiles count supplies only; the sheet list's value (`out × price` for an open sheet) skips equipment. `sheetCsv()`, the file that goes to the client, has no equipment rows. The owner's **Export data** keeps everything: the all-sheets CSV gets a **Kind** column at the end, and the JSON is the documents as stored.
- **Unreturned equipment is missing, not used.** For equipment, `out − returned − lost` is **still out**, never used.

### 2a. Equipment bought on a receipt for a client is billed to that client

> Equipment bought on a receipt for a client is billed to that client. In the receipt review, a line that matches a company equipment item can be assigned to a client's sheet, like any other line. It goes on the sheet as a charged line marked "bought for this client", at the receipt price (or the price the reviewer picks), with the supplies, in the sheet total and in the client's CSV. It belongs to the client: it never goes into storage, isn't expected back, can't be returned, and isn't asked about at Finished Return. A line put in General inventory adds the equipment to storage, as before, and is never charged.

- **A separate line, marked `purchased: true`.** The line has no `kind` (it's charged like a supply line: `out` is how many were bought, `returned` stays 0, so all of it is used) and snapshots `code`, `name`, `price` and `cost` from the receipt, as any receipt line does ([ADR 0014](0014-units-cost-and-rounding.md), section 2). It's keyed **`<productKey>:bought`**, not by the product key, so it never merges with an equipment line for the same item that's on loan on that sheet: a crew can take the company's ladder to the job and also buy the client a new one. A second receipt buying the same item for that sheet adds to the `:bought` line's `out`, as for any receipt line.
- **The price.** Equipment has no client price to keep, so the review's two-way choice ("Charge the receipt price" or "Keep the client price") isn't shown: the line is charged the receipt price each, which the reviewer can change on the line. Nothing is written back to the product's `price` (equipment has none). As for every receipt, the receipt's cost each is written to the product's `cost`, so the item's value follows what was last paid.
- **The receipt review** shows, on a line that matches equipment and is assigned to a client: "Company equipment · bought for this client: charged on their sheet, not kept in storage". Assigned to General inventory: "Company equipment · added to storage, not charged". The destination list is the same as for any line: General inventory, a new sheet, or an open job sheet (never the ad hoc sheet, section 4).
- **On the sheet** the line is with the supplies, named "<name> (bought for this client)", with its price, taken, returned (0), used and charge, and counts in the totals. It's not in **Equipment (not charged)**, not in **Inventory → Equipment → Out**, and not in any return list: returns from anywhere and the return pick list skip it, and Finished Return doesn't ask about it.
- **The sheet CSV** has the same row, "<name> (bought for this client)", like any charged line.
- **Stock doesn't move.** The item never passed through storage, as for any receipt line put on a client's sheet today (`addLines` in `src/moves.js`). A line edit can still correct its counts or price.

### 3. Finished Return asks about each piece of equipment still out

When someone taps **Finished Return** on a sheet with equipment still out, the sheet doesn't close yet. A **Before you finish** screen lists each equipment line with something still out, and asks, per line and for how many:

| Choice | What happens |
| --- | --- |
| **It's back** | A return of that many, as if scanned: stock goes up, `returned` goes up |
| **Still at the job** | Nothing changes. The sheet stays **open** (supplies on it still count as used and charged as usual), and shows "1 ladder still at the job" on its card |
| **Lost or broken** | Recorded as lost: the line's `lost` goes up, and a movement with `reason: "lost"` goes into the item's stock history. Stock doesn't change (it went down when the item was checked out; the item has simply left the business). The person may also enter **an amount to charge the client** for it |

- **The sheet closes** only when every equipment line has nothing still out. If any line was left as **Still at the job**, the screen saves the other choices and the sheet stays open; the next **Finished Return** asks again.
- **A charge for lost or broken equipment** is an amount in dollars for that line (not each), following the money rule ([ADR 0014](0014-units-cost-and-rounding.md), section 3). It's stored on the line as `lostCharge` (several lost records on one line add up), and it **is charged**: it appears in the supplies table as its own row, "Ladder (lost or broken)", with the number lost in **Used** and the amount in **Charge**; it's added to the sheet total; and the sheet CSV has the same row. The item's value is shown next to the field as a guide; the field starts empty. An ad hoc sheet (section 4) has no client, so it offers no charge.
- **Lost equipment that turns up later** is counted back into storage with the inventory form's count, which records a `count` movement, as for any recount.

### 4. Quick take: the team's one ad hoc sheet

- **The sheet list gets a Quick take button** (owners and contributors). It opens the scanner, and the same checkout form as a sheet (scan, type, or pick an item without a barcode, then how many), without choosing or opening a sheet. The toast says "Took 2 × Nitrile gloves (ad hoc)".
- **What's taken goes on the team's ad hoc sheet**: an ordinary sheet with **`kind: "adhoc"`**, no client, the date of its first take, and the usual lines (each line snapshots `code`, `name`, `price`, `cost` and `kind`, so it can move to a job sheet later at the price it was taken at). Job sheets have no `kind`; missing means `"job"`.
- **There is at most one open ad hoc sheet per team.** The first quick take creates it; every quick take after that adds to it until it's finished. Its ID is **`adhoc-<n>`**, where n counts the team's ad hoc sheets from 1, so both builds name it the same way and two people's first takes aim at the same sheet:
  - **Web build**: the quick take is a command (section 7). The server keeps the number and the open sheet's ID on a small team item, `ADHOC`. The command reads it, and in the same transaction as the checkout either adds to the open sheet or creates `adhoc-<n+1>` and points `ADHOC` at it, on the condition that `ADHOC` hasn't changed since the read. When two people's first takes race, one transaction creates the sheet; the other is cancelled, reads again, finds the sheet open and adds its line to it. Both takes end up on one sheet, and neither is lost.
  - **Artifact build**: see section 6.
- **The ad hoc sheet is shown apart from job sheets**: while it's open, as a card above the job sheets, "Ad hoc · since Sep 30 · 6 items out"; once finished, in **Returned** with an "Ad hoc" label instead of a client. Opening it shows the usual sheet screen without **Edit details** (no client to edit) and without a scan bar for checkouts (taking is the Quick take button), but with **Return**.
- **Supplies on an ad hoc sheet aren't charged to anyone.** The sheet shows Taken, Returned and Used, and no price or charge columns. Its equipment section works as on a job sheet. A receipt's lines can't be assigned to it: the receipt review lists job sheets only.
- **Finishing it** is **Finished Return**, as on a job sheet: equipment still out gets the same questions (no charge option), and unreturned supplies count as used. Once it's closed, the next quick take starts `adhoc-<n+1>`. A finished ad hoc sheet can be reopened only while no other ad hoc sheet is open.
- **Deleting** the open ad hoc sheet is allowed, as for any sheet (stock doesn't change, as today); the next quick take starts a new one.

### 5. Returns from anywhere, and moving an ad hoc line to a job sheet

- **The sheet list gets a Return button** next to Quick take. Scanning (or picking) an item finds every open sheet, job or ad hoc, where that item still has something out (`out − returned`, less `lost` for equipment):
  - **One sheet**: the return form for that sheet opens, naming it ("Return to Smith, Sep 30").
  - **More than one**: a list to pick from, each with the client (or "Ad hoc"), the date and how many are out, the ad hoc sheet first.
  - **None**: "Nothing of this is checked out right now."
  The app already holds every sheet, so this needs no new server route; the return itself is the existing return command on the chosen sheet.
- **A job sheet's "Not on this sheet" screen** offers the way out: when the scanned item is still out on another open sheet, it shows **Return it to <that sheet>** (or a pick list when there are several) next to **Check it out instead**.
- **A line on the ad hoc sheet can move to a job sheet.** Its row opens the line editor, which on an ad hoc sheet gets **Move to a job sheet** and a list of open job sheets. Moving takes the **whole line with its counts** (`out`, `returned`, `lost`) off the ad hoc sheet and adds them to the job sheet:
  - If the job sheet has no line for that item, the line moves as it is, with its snapshot (the price it was taken at). If it has one, the counts are added to it and the job sheet's snapshot is kept.
  - **Stock doesn't change**: the items left storage once, at the quick take. The job sheet now charges for what was used, and nothing is counted twice.
  - In the web build it's **one server transaction with an operation ID** (section 7): both sheets change together, or neither does.
  - Only from the open ad hoc sheet to an open job sheet. A job sheet's line doesn't move, and nothing moves back to the ad hoc sheet; a mistake is corrected with line edits, as today.

### 6. The claude.ai artifact build

The artifact build gets the same screens and the same documents, because it's the same app. claude.ai's db has no transactions or conditional writes ([ADR 0004](0004-runtime-adapter.md)), so each new write follows the pattern in `src/moves.js`: read, write the change with the action's mark, and let a retry find its mark and write nothing.

| Action | Artifact build |
| --- | --- |
| Equipment checkout and return | As for supplies (`checkOut`, `recordReturn`). The line patch carries `kind`, `takenBy` and `takenAt` |
| Lost or broken | `update` of the line's `lost` and `lostCharge`, added to the line as saved now, with the action's mark. No stock write |
| Finished Return with equipment out | The app checks the lines it holds before writing `status: "closed"`. Nothing stops another page closing a sheet that this page doesn't know has equipment out; the next look at the sheet shows it |
| Quick take | Works out `adhoc-<n>` from the sheets it holds: the open ad hoc sheet if there is one, otherwise one more than the highest number. Reads it; if it doesn't exist, `set`s the sheet with no lines; then adds the line with `update`, as a checkout does, and re-reads to check its mark is there, writing the line again if it isn't. If it finds the sheet closed (someone finished it meanwhile), it moves on to `adhoc-<n+1>` |
| Two people's first takes at once | Both aim at the same `adhoc-<n>`, so both lines land on one sheet. Because `set` can't be conditional, a `set` from a page that read before the other's line landed can still wipe that line; the check after the write puts it back in almost every case. Stock is right either way |
| Returns from anywhere | The same screens; the return is `recordReturn` on the chosen sheet |
| Equipment bought for a client on a receipt | `addLines` as today, with the line keyed `<productKey>:bought` and carrying `purchased: true`. No stock write |
| Move to a job sheet | Two writes, in this order: add the counts to the job sheet's line with the move's mark (as `addLines` does), then replace the ad hoc line with a hidden "moved" marker carrying the same mark (shown nowhere, left out of exports, as removed lines are). A retry that finds the mark on the job sheet skips the first write; one that finds it on both writes nothing. A crash between them leaves the line on both sheets until the retry. A return on the ad hoc line between the two writes isn't carried over; correct the job sheet's line |

The family business has a handful of people on one artifact, so these windows are small, and none of them lets stock drift: stock only moves through `addStock`, as today.

### 7. Server rules and API changes

**Document validation** (`backend/src/data/documents.ts`, `products.ts`, `sheets.ts`):

- Product `kind`: `"supply"` or `"equipment"`, or missing. A new product's key may not end in `:bought`, which is kept for purchased lines. `price` becomes optional on the typed `Product` (equipment has none); when present it follows the money rule as today.
- Sheet `kind`: `"adhoc"` or missing. A document write may not create a sheet with `kind: "adhoc"`, add `kind` to a sheet, or change or remove it: only the quick-take command makes ad hoc sheets, so the one-open rule holds.
- Line fields: `kind` (`"equipment"` or missing), `purchased` (`true` or missing; only on a line with no `kind`, and a line keyed `<productKey>:bought` must have it), `lost` (whole eaches, missing means 0), `lostCharge` (money, missing means 0), `takenBy` (text, up to 200), `takenAt` (an ISO time). On every line, `returned + lost ≤ out`. A line's `kind` can't change once it's set. `lost` and `lostCharge` are allowed only on equipment lines, and `lostCharge` only on job sheets.
- **Closing a sheet** (`status: "closed"` by `PATCH` or `PUT`) is refused with `409 aborted` and "Equipment is still out on this sheet" while any equipment line has `out − returned − lost > 0`. Closing the open ad hoc sheet also clears `ADHOC`'s pointer, in the same transaction. Reopening an ad hoc sheet is refused with `409` while another ad hoc sheet is open, and otherwise points `ADHOC` at it. Deleting the open ad hoc sheet clears the pointer.

**Commands** (`backend/src/data/commands.ts`, [docs/api/commands.md](../api/commands.md)): each is one transaction with an operation record, like the existing ones.

| Command | Route | What it does |
| --- | --- | --- |
| Checkout (changed) | `POST /teams/{teamId}/sheets/{sheetId}/checkout` | A new line also snapshots `kind`; an equipment line gets `takenBy` (the caller, from the token) and `takenAt`. Refused on an ad hoc sheet: taking onto it is the quick take |
| Return (changed) | `.../sheets/{sheetId}/return` | Allows up to `out − returned − lost`. Refused with `400` on a `purchased` line: it was bought for the client and doesn't come back |
| Add a receipt's lines (changed) | `.../sheets/{sheetId}/lines` | Refused on an ad hoc sheet. A line whose `productKey` is an equipment product (read inside the transaction) is stored under `<productKey>:bought` with `purchased: true` and no `kind`, whatever the request says; stock doesn't move, as for every line here. A supply's line is unchanged |
| **Quick take** | `POST /teams/{teamId}/adhoc/checkout` | Same body and response as a checkout, without `sheetId`. Adds to the open ad hoc sheet, or creates the next one and points `ADHOC` at it (section 4). `result.sheetId` says which, and a retry returns the same one |
| **Lost** | `POST /teams/{teamId}/sheets/{sheetId}/lost` | `{ operationId, productKey, quantity, charge? }`. Equipment lines only, `quantity` at most what's still out, `charge` only on a job sheet. Adds to `lost` and `lostCharge`, and records a movement `reason: "lost"` with `delta: 0`. The sheet must be open |
| **Move** | `POST /teams/{teamId}/sheets/{sheetId}/move` | `{ operationId, productKey, toSheetId }`. `sheetId` must be the open ad hoc sheet, `toSheetId` an open job sheet, and the line must exist. Removes the line from the ad hoc sheet on the condition it's unchanged since the read, adds its counts to the job sheet's line (or creates it with the moved snapshot), gives both sheets a new version, and records a movement `reason: "move"` with `delta: 0`, `fromSheetId` and the counts moved. Lines of different kinds (the item's kind changed between the two checkouts) are refused with `400`. The response has `sheet` and `toSheet`, and `product: null` |

- **Movement reasons** gain `lost` and `move`, both with `delta: 0`, so the nightly stock-drift check adds up as before. The sheet-line reconciliation in [docs/api/commands.md](../api/commands.md) counts `move` movements in and out of each sheet, and `lost` against `lost`.
- **Roles**: the new commands need the contributor or owner role, like the existing ones. Every ID in a request is looked up in the caller's team partition only.
- **Sizes**: a move that would take the job sheet past the document limit is refused with `413`, as a checkout is.

**The web build's adapter** (`src/aws/db.js`) gains `quickTake`, `markLost` and `moveLine`, each with an `action` object per confirmed form, as `command` has, so a retry sends the same operation ID.

### 8. Migration: existing items are supplies, and nothing is rewritten

No document is rewritten. Existing documents load as they are:

| Missing field | Read as |
| --- | --- |
| Product `kind` | `"supply"`: charged at `price`, as today |
| Product `price` (equipment) | No client price. Never shown for equipment; a supply without one shows $0.00, as today |
| Sheet `kind` | `"job"`: a client's sheet, as today |
| Line `kind` | A supply line: unreturned means used, charged at the line's price |
| Line `purchased` | Not bought for the client: a supply line, or an equipment line on loan |
| Line `lost`, `lostCharge` | 0 |
| Line `takenBy`, `takenAt` | Unknown. The Out view shows "—" |
| Team `ADHOC` item | No open ad hoc sheet, and none made yet. The first quick take makes `adhoc-1` |

- **A team that wants equipment** edits each equipment item and picks **Company equipment**. Sheets from before keep charging those lines as supplies (their snapshot), as a price change wouldn't reach them either; a line edit can correct one.
- **Writes that replace a whole product must carry `kind`**, as they carry `cost` and `packSize` ([ADR 0014](0014-units-cost-and-rounding.md), section 4), or an edit would turn equipment back into a supply.
- **Importing artifact data into a team** (`supply-checkout-ig9`) copies the documents as they are, and sets `ADHOC` from the highest `adhoc-<n>` it copies, pointing at it if it's open.
- **The CSV import** (`supply-checkout-1dg.4`) gains an optional `kind` column (`supply` or `equipment`; blank means supply). For equipment, `price` may be blank and `cost` is its value.

### 9. Journeys to add

These go in [docs/journeys.md](../journeys.md) and `journeys/registry.json` with the feature beads, as **planned** steps until they're built:

- **J4 changes**: J4.3's **Finished Return** stops on equipment still out (`supply-checkout-h9to`).
- **J5 changes**: a receipt line that matches equipment can go to a client's sheet, where it's a charged "bought for this client" line and stock doesn't move, or to General inventory, where it adds to stock. Tests: the review's wording and missing price choice for equipment; the line's key, `purchased` flag, price and charge; no stock change; a loaned and a bought ladder on one sheet staying separate; the return command refusing a purchased line (backend); and the same in the artifact build (`supply-checkout-h9to`).
- **J6 changes**: the sheet CSV has no rows for equipment on loan, and does have a row for each charge for lost or broken equipment and for each piece of equipment bought for the client (`supply-checkout-h9to`).
- **J13. Take company equipment to a job and bring it back** (crew member; critical, since it's part of the morning checkout): check equipment out on a sheet; see it under **Equipment (not charged)** and not in the total; return it, or at Finished Return mark it still at the job or lost or broken, with an optional charge; see what's out in **Inventory → Equipment → Out** (`supply-checkout-h9to`).
- **J14. Take supplies without a job sheet** (crew member; critical): **Quick take** from the sheet list; **Return** from the sheet list, picking the sheet when an item is out on more than one; move an ad hoc line to a job sheet; finish the ad hoc sheet (`supply-checkout-mdae`). Tests include two people's first quick takes at once ending on one sheet, and a retried move counting once, in both builds.

The **Checkouts stopped** alarm counts quick takes as checkouts. The stock-drift check covers `lost` and `move` movements.

## Alternatives considered

| Option | Why not |
| --- | --- |
| **A separate equipment-loan system** (its own loans collection, check-out to a person rather than a sheet) | Two ways to take things from storage, two return flows and two histories, when crews already carry equipment to the same jobs as the supplies. A sheet section reuses checkout, return, live updates, the commands and the stock history, and the Out view gives the "who has the ladder" answer a loan system would. |
| **Equipment as supplies priced at $0** (what some crews do now) | Needs no change, but an unreturned ladder counts as "used", nothing asks about it at Finished Return, and there's nowhere to record a damage charge. It hides exactly what the owner wants to see. |
| **A separate `value` field for equipment** | Clearer in the data, but it would duplicate `cost` (what the business paid each), need its own receipt and import handling, and leave storage value with two cases. The label changes; the field doesn't. |
| **Per-person ad hoc sheets** | Simpler concurrency (each person writes only their own sheet), but the van's gloves aren't one person's, returns would need to search more sheets, and an owner would have one more sheet per crew member to finish. One team sheet matches how crews share storage. |
| **No ad hoc sheet: take supplies with a stock adjustment** (a `count` or a new "used internally" reason) | Fast, but nothing can come back or move to a job later, and the storage count would say the gloves were used when they're sitting in the van. |
| **A new ad hoc sheet per quick take, or per day** | Many tiny sheets to finish, and a return would rarely find the right one. One open sheet that's finished when the van is restocked keeps it to one place to look. |
| **Moving an ad hoc line as a return plus a checkout** | Uses existing commands, but it's two transactions (a crash between them moves stock out and back), it records a return that never happened, and the second checkout would take a new price snapshot. |
| **Leaving closing unchecked and only warning about equipment** | The owner's rule is that unreturned equipment is missing, not used. A warning that's tapped past leaves a ladder out on a closed sheet that takes no more returns. |

## Consequences

- Crews can take equipment to jobs on the same sheet and the client isn't charged for it, unless the owner decides to charge for something lost or broken, which then shows on the client's sheet and CSV. Equipment bought on a receipt for a client is billed like any supply bought for them.
- The owner can see where every piece of equipment is, and Finished Return can't close a sheet with equipment unaccounted for. A sheet can now stay open because of a ladder left at a site.
- Supplies taken without a job are recorded, come back with one scan, and can be billed later by moving the line, without counting stock twice.
- **ADR 0014 is amended**: section 1's quantities gain `lost` (whole eaches, like `out` and `returned`), and section 2's "`price` is the client price per each" and "unreturned means used" hold for supplies and purchased lines only. Equipment has no client price, keeps its value in `cost`, and its unreturned items on loan are still out or lost. Section 2's receipt price choice isn't offered for equipment bought for a client.
- The sheet math, the sheet CSV, the sheet screen, the return flow, the Inventory list and three existing commands change. Three commands and two movement reasons are added. Every new field is optional, so old data and the artifact's documents keep working.
- In the artifact build, two first quick takes at the same moment can briefly lose a line from the sheet (never from stock), and a move can leave a line on both sheets until it's retried. The web build has neither problem.
- Because the app holds every sheet, finding where an item is out is instant. A team with thousands of open sheets would need a server query instead; that's far beyond the target customers.

## Decisions on the open questions

The owner answered the open questions on 2026-10-01:

1. **Equipment still out on the ad hoc sheet** keeps the ad hoc sheet open, so later quick takes keep landing on it. Nothing carries over to the next ad hoc sheet.
2. **Equipment's value is the `cost` field**, labeled "Value each", so a receipt that buys equipment updates its value.
3. **The charge for lost or broken equipment** is one amount per line, starting empty, with the item's value shown as a guide.
4. **Changed:** teams do buy equipment on a receipt for a client and bill it. A receipt line that matches equipment can go onto a client's sheet as a charged "bought for this client" line (section 2a).
5. **The ad hoc sheet shows no money**: no prices, charges or cost of used supplies.
6. **Only a whole ad hoc line moves** to a job sheet; there's no splitting.
7. **Lost equipment that turns up** is put back with a recount. There's no "Found it" action.
8. **Changing an item's kind** leaves lines already on sheets as they are, open sheets included.
