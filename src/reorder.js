// Low-stock alerts (supply-checkout-005.8): which items are running low, which of them the team
// has acknowledged, and the reorder list. backend/src/data/reorder.ts has the server's side of
// the same rules; keep the two the same.
//
// - `reorderAt`: a whole number of single items (eaches, ADR 0014). An item is low when it's
//   counted (has a `stock`) and its stock is at or below it.
// - `reorderQty`: how many the team usually orders. Only shown.
// - `ackedAtStock`: someone acknowledged the alert when stock was this. It's the team's, kept
//   on the item. The alert stays quiet while stock is at or above it, and comes back when stock
//   falls below it. A restock above `reorderAt` ends it (marksEnd): the server removes it then
//   (a return, a receipt, a count or an import, and an uncount, since an uncounted item is never
//   low), the artifact runtime's writes in src/moves.js do the same, and so does saving a new
//   reorder level (productModal). One at or above `reorderAt` is out of date, and doesn't quiet
//   anything.
// - `orderedQty` and `orderedOn` (supply-checkout-005.14): someone marked the item ordered, this
//   many on this date. Also the team's, on the item. While it's on order the alert stays quiet
//   however far stock falls, and the reorder list says "On order: 24 since Oct 7". Marking it
//   ordered removes the acknowledgment (the order says more), and cancelling the order brings
//   the alert back. A restock above the level ends the order as it ends an acknowledgment
//   (marksEnd), as does no longer counting the item. A new reorder level keeps the order.
import { hasStock, brandOf, fmtDate } from "./format.js";
import { toCsv } from "./export.js";

const whole = v => Number.isInteger(v) && v >= 0;
/** The item's reorder level, or null when it has none. */
export const reorderLevel = p => (p && whole(p.reorderAt) ? p.reorderAt : null);
/** Counted, and at or below its reorder level. */
export const isLow = p => !!hasStock(p) && reorderLevel(p) !== null && p.stock <= p.reorderAt;
/** Low, and the team acknowledged it at a stock it hasn't fallen below since. */
export const isAcked = p => isLow(p) && whole(p.ackedAtStock) && p.ackedAtStock <= p.reorderAt && p.stock >= p.ackedAtStock;
/** Marked ordered: a quantity and the date it was ordered. */
export const isOnOrder = p => Number.isInteger(p.orderedQty) && p.orderedQty >= 1 && typeof p.orderedOn === "string";
/** "On order: 24 since Oct 7, 2026" */
export const onOrderText = p => `On order: ${p.orderedQty} since ${fmtDate(p.orderedOn)}`;
/** The team's marks on an item's alert, which a restock removes together (MARK_FIELDS in backend/src/data/reorder.ts). */
const MARKS = ["ackedAtStock", "orderedQty", "orderedOn"];
/**
 * True when stock going to `stock` ends the item's marks (marksEnd in
 * backend/src/data/reorder.ts): it has some, and the new stock is above its reorder level, or it
 * has no level. null for `stock`: no longer counted, which ends them too.
 */
export const marksEnd = (p, stock) => MARKS.some(f => Object.hasOwn(p, f)) && (stock === null || typeof p.reorderAt !== "number" || stock > p.reorderAt);
/** The item without its marks. */
export const withoutMarks = p => Object.fromEntries(Object.entries(p).filter(([k]) => !MARKS.includes(k)));
/** Low, and nobody has acknowledged it or ordered it yet: what the alert counts. */
export const needsReorder = p => isLow(p) && !isAcked(p) && !isOnOrder(p);

const nameOf = p => p.name || "Unnamed item";
// Needs looking at, then on order, then acknowledged
const rank = p => (needsReorder(p) ? 0 : isOnOrder(p) ? 1 : 2);
/** The reorder list from a list of products (each with its `key`): what's low or on order, in rank order, then by name. */
export const lowItems = list => list.filter(p => isLow(p) || isOnOrder(p))
  .sort((a, b) => rank(a) - rank(b) || String(nameOf(a)).localeCompare(String(nameOf(b))));

const status = p => (isOnOrder(p) ? `${p.orderedQty} ordered ${p.orderedOn}` : isAcked(p) ? "Acknowledged" : "Low");

/** The reorder list as a spreadsheet: a Brand column only when an item has one. */
export function reorderCsv(list) {
  const brands = list.some(brandOf);
  return toCsv([
    ["Item", ...(brands ? ["Brand"] : []), "Barcode", "In storage", "Reorder at", "Usual order", "Status"],
    ...list.map(p => [nameOf(p), ...(brands ? [brandOf(p)] : []), p.code || "", hasStock(p) ? p.stock : "", p.reorderAt ?? "", whole(p.reorderQty) ? p.reorderQty : "", status(p)]),
  ]);
}

/**
 * The reorder list as text to paste in a message: one line per item. Plain text, not a
 * spreadsheet, so it isn't guarded against formulas the way the CSV's cells are (src/export.js).
 */
export function reorderText(list) {
  return list.map(p => {
    const brand = brandOf(p), order = whole(p.reorderQty) ? `, order ${p.reorderQty}` : "";
    const placed = isOnOrder(p) ? `, on order: ${p.orderedQty} since ${fmtDate(p.orderedOn)}` : "";
    return `${nameOf(p)}${brand ? ` (${brand})` : ""}: ${hasStock(p) ? p.stock : "not counted"} left, reorder at ${p.reorderAt ?? "none"}${order}${placed}`;
  }).join("\n");
}
