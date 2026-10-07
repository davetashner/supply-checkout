// Low-stock alerts (supply-checkout-005.8): which items are running low, which of them the team
// has acknowledged, and the reorder list. backend/src/data/reorder.ts has the server's side of
// the same rules; keep the two the same.
//
// - `reorderAt`: a whole number of single items (eaches, ADR 0014). An item is low when it's
//   counted (has a `stock`) and its stock is at or below it.
// - `reorderQty`: how many the team usually orders. Only shown.
// - `ackedAtStock`: someone acknowledged the alert when stock was this. It's the team's, kept
//   on the item. The alert stays quiet while stock is at or above it, and comes back when stock
//   falls below it. A restock above `reorderAt` ends it: the server removes it then (a return,
//   a receipt, a count or an import), and so does saving a new reorder level (productModal).
//   One at or above `reorderAt` is out of date, and doesn't quiet anything.
import { hasStock, brandOf } from "./format.js";
import { toCsv } from "./export.js";

const whole = v => Number.isInteger(v) && v >= 0;
/** The item's reorder level, or null when it has none. */
export const reorderLevel = p => (p && whole(p.reorderAt) ? p.reorderAt : null);
/** Counted, and at or below its reorder level. */
export const isLow = p => !!hasStock(p) && reorderLevel(p) !== null && p.stock <= p.reorderAt;
/** Low, and the team acknowledged it at a stock it hasn't fallen below since. */
export const isAcked = p => isLow(p) && whole(p.ackedAtStock) && p.ackedAtStock <= p.reorderAt && p.stock >= p.ackedAtStock;
/** Low, and nobody has acknowledged it yet: what the alert counts. */
export const needsReorder = p => isLow(p) && !isAcked(p);

const nameOf = p => p.name || "Unnamed item";
/** The low items of a list of products (each with its `key`): the unacknowledged first, then by name. */
export const lowItems = list => list.filter(isLow)
  .sort((a, b) => Number(isAcked(a)) - Number(isAcked(b)) || String(nameOf(a)).localeCompare(String(nameOf(b))));

/** The reorder list as a spreadsheet: a Brand column only when an item has one. */
export function reorderCsv(list) {
  const brands = list.some(brandOf);
  return toCsv([
    ["Item", ...(brands ? ["Brand"] : []), "Barcode", "In storage", "Reorder at", "Usual order", "Acknowledged"],
    ...list.map(p => [nameOf(p), ...(brands ? [brandOf(p)] : []), p.code || "", p.stock, p.reorderAt, whole(p.reorderQty) ? p.reorderQty : "", isAcked(p) ? "Yes" : "No"]),
  ]);
}

/** The reorder list as text to paste in a message: one line per item. */
export function reorderText(list) {
  return list.map(p => {
    const brand = brandOf(p), order = whole(p.reorderQty) ? `, order ${p.reorderQty}` : "";
    return `${nameOf(p)}${brand ? ` (${brand})` : ""}: ${p.stock} left, reorder at ${p.reorderAt}${order}`;
  }).join("\n");
}
