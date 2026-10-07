// Low-stock alerts (supply-checkout-005.8, 005.14): a product's reorder level,
// and the team's shared marks on its alert: an acknowledgment, or an order.
// src/reorder.js has the app's side of the same rules; keep the two the same.
//
// - `reorderAt`: whole eaches (ADR 0014). The item is low when it tracks stock
//   (a numeric `stock`) and `stock <= reorderAt`.
// - `reorderQty`: how many the team usually orders, in eaches. Only shown.
// - `ackedAtStock`: someone acknowledged the alert when stock was this. The
//   alert stays quiet while stock is at or above it, and comes back when stock
//   falls below it.
// - `orderedQty` and `orderedOn` (always together): someone marked the item
//   ordered, this many (eaches) on this date (YYYY-MM-DD). The alert stays
//   quiet however far stock falls, until the order is cancelled (a write
//   without them) or the restock below ends it. The app removes the
//   acknowledgment when it marks an item ordered; the server doesn't need
//   them to be exclusive, since an order quiets the alert either way.
// - The marks are shared by the team and kept on the product (MARK_FIELDS).
// - A restock ends every mark: any stock change that takes stock above
//   `reorderAt` removes them all (marksEnd), so the next fall to the reorder
//   level alerts again. That's done by the stock commands that raise stock (a
//   return, a receipt, a count) and the CSV import. Stopping the count (an
//   uncount) removes them too, since an uncounted item is never low.
//   Checkouts only lower stock, so they never end one, and their updates are
//   as they were before low-stock alerts.
// - The decision is made on what the command read, so the update is
//   conditional on it still holding when it commits (marksOnRaise,
//   marksOnCount): no marks still when none were read, and the reorder level
//   and the side of it the new stock falls on when some were. A command that
//   loses a race is cancelled, reads again and retries, as for any other
//   conflict. Changes that don't move the decision (busy checkouts that leave
//   a return on the same side of the level) don't make it conflict.
//
// The document routes take any value that passes checkReorderFields, and
// never compare it with the stock: a mark that's out of date can't make a
// write fail. A write made against an older version of the item still
// conflicts, as every document write does (ADR 0006). A write that changes
// the reorder level and carries the old acknowledgment over unchanged drops it
// (a new level starts afresh, as the app's editor does); an order stays, since
// it's still on its way whatever the level.

import { InvalidInputError } from "./errors.js";
import { date } from "./keys.js";
import { MAX_QUANTITY } from "./money.js";

/** The whole-number fields this module owns, with the smallest value each takes. */
export const REORDER_FIELDS = { reorderAt: 0, reorderQty: 1, ackedAtStock: 0, orderedQty: 1 } as const;
export type ReorderField = keyof typeof REORDER_FIELDS;
/** The team's marks on an item's alert, which a restock (or an uncount) removes together. */
export const MARK_FIELDS = ["ackedAtStock", "orderedQty", "orderedOn"] as const;

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const unchanged = (data: Record<string, unknown>, stored: Record<string, unknown> | undefined, field: string) =>
  !!stored && Object.hasOwn(stored, field) && sameValue(stored[field], data[field]);

/**
 * Throws unless each reorder field the write sets is valid: whole numbers in
 * range (0 to MAX_QUANTITY; `reorderQty` and `orderedQty` from 1), `orderedOn`
 * a YYYY-MM-DD date, and an order's two fields together. A value the stored
 * item already had, carried over unchanged, is let through whatever it is, so
 * a stray value can't block the item's other edits.
 */
export function checkReorderFields(data: Record<string, unknown>, stored?: Record<string, unknown>): void {
  for (const [field, min] of Object.entries(REORDER_FIELDS)) {
    if (!Object.hasOwn(data, field) || unchanged(data, stored, field)) continue;
    const value = data[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > MAX_QUANTITY) {
      throw new InvalidInputError(`${field} must be a whole number from ${min} to ${MAX_QUANTITY}`);
    }
  }
  if (Object.hasOwn(data, "orderedOn") && !unchanged(data, stored, "orderedOn")) {
    try {
      date(data.orderedOn);
    } catch {
      throw new InvalidInputError("orderedOn must be a date, YYYY-MM-DD");
    }
  }
  // An order is a quantity and a date: one without the other is refused, unless that's how it was stored
  const order = ["orderedQty", "orderedOn"].filter((f) => Object.hasOwn(data, f));
  const [only] = order;
  const other = only === "orderedQty" ? "orderedOn" : "orderedQty";
  if (only !== undefined && order.length === 1 && !(unchanged(data, stored, only) && !Object.hasOwn(stored ?? {}, other))) {
    throw new InvalidInputError("orderedQty and orderedOn go together");
  }
  // A changed (or removed) level starts afresh: an acknowledgment carried over unchanged was of the old one
  if (stored && !sameValue(data.reorderAt, stored.reorderAt) && Object.hasOwn(data, "ackedAtStock") && sameValue(data.ackedAtStock, stored.ackedAtStock)) {
    delete data.ackedAtStock;
  }
}

/** True when the item has any of the team's marks on its alert. */
export const hasMarks = (product: Record<string, unknown>): boolean => MARK_FIELDS.some((f) => Object.hasOwn(product, f));

/**
 * True when stock going to `stock` ends the item's marks: it has some, and the
 * new stock is above its reorder level (or it has no level, so nothing is
 * left to mark).
 */
export function marksEnd(product: Record<string, unknown> | undefined, stock: number): boolean {
  if (!product || !hasMarks(product)) return false;
  const level = product.reorderAt;
  return typeof level !== "number" || stock > level;
}

/** Removes the item's marks from a document's data. */
export function dropMarks(data: Record<string, unknown>): void {
  delete data.ackedAtStock;
  delete data.orderedQty;
  delete data.orderedOn;
}

/** What a stock command adds to its product update for the marks. */
export interface MarksUpdate {
  /** End the update with `REMOVE` of every mark. */
  readonly remove: boolean;
  readonly names: Record<string, string>;
  readonly values: Record<string, unknown>;
  /** Conditions the update must also meet: what the decision was made on. */
  readonly clauses: string[];
}

const MARK_NAMES: Record<string, string> = Object.fromEntries(MARK_FIELDS.map((f) => [`#${f}`, f]));
/** The update expression's removal of every mark (with MARK_NAMES). */
export const MARKS_REMOVED = MARK_FIELDS.map((f) => `#${f}`).join(", ");

/** No marks were read: there are still none when the update commits, or it reads again. */
const NONE_READ: MarksUpdate = { remove: false, names: MARK_NAMES, values: {}, clauses: MARK_FIELDS.map((f) => `attribute_not_exists(#${f})`) };

/** The reorder level as read: the same value, or still none. */
function levelAsRead(product: Record<string, unknown>): Pick<MarksUpdate, "names" | "values" | "clauses"> {
  const has = Object.hasOwn(product, "reorderAt");
  return {
    names: { "#reorderAt": "reorderAt" },
    values: has ? { ":readLevel": product.reorderAt } : {},
    clauses: [has ? "#reorderAt = :readLevel" : "attribute_not_exists(#reorderAt)"],
  };
}

const withRemoval = (remove: boolean, level: Pick<MarksUpdate, "names" | "values" | "clauses">, more: Pick<MarksUpdate, "values" | "clauses"> = { values: {}, clauses: [] }): MarksUpdate => ({
  remove,
  names: { ...level.names, ...(remove ? MARK_NAMES : {}) },
  values: { ...level.values, ...more.values },
  clauses: [...level.clauses, ...more.clauses],
});

/**
 * For a stock command that adds `delta` to a product's stock (a return or a
 * receipt): what it adds to its update so a restock ends the marks. Nothing
 * for a change that doesn't raise stock (a checkout). Otherwise:
 *
 * - No marks read: the update requires there still to be none.
 * - Some read: the update requires the reorder level as read and, for a
 *   level, the new stock on the side of it the decision was made on
 *   (`#stock > :threshold` to remove, `<=` to keep, `threshold = level -
 *   delta`), or no stock still for an item that wasn't counted (a receipt
 *   starts it at `delta`). With no level (or one that isn't a number), they're
 *   always removed.
 *
 * The caller refuses a stock that isn't a number before it gets here.
 */
export function marksOnRaise(product: Record<string, unknown> | undefined, delta: number): MarksUpdate | undefined {
  if (!product || delta <= 0) return undefined;
  if (!hasMarks(product)) return NONE_READ;
  const level = product.reorderAt;
  if (typeof level !== "number") return withRemoval(true, levelAsRead(product));
  if (typeof product.stock !== "number") return withRemoval(delta > level, levelAsRead(product), { values: {}, clauses: ["attribute_not_exists(#stock)"] });
  const remove = product.stock + delta > level;
  return withRemoval(remove, levelAsRead(product), { values: { ":threshold": level - delta }, clauses: [remove ? "#stock > :threshold" : "#stock <= :threshold"] });
}

/**
 * For a count that sets stock to `counted` (its update is already conditional
 * on the stock it read): no marks still, or the reorder level as read.
 */
export function marksOnCount(product: Record<string, unknown>, counted: number): MarksUpdate {
  if (!hasMarks(product)) return NONE_READ;
  return withRemoval(marksEnd(product, counted), levelAsRead(product));
}

/** The `REMOVE` clause to append to an update expression, or "". */
export const marksRemoval = (update: { remove: boolean } | undefined): string => (update?.remove ? ` REMOVE ${MARKS_REMOVED}` : "");
