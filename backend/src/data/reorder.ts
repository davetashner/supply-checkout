// Low-stock alerts (supply-checkout-005.8): a product's reorder level and the
// team's shared acknowledgment of its alert. src/reorder.js has the app's side
// of the same rules; keep the two the same.
//
// - `reorderAt`: whole eaches (ADR 0014). The item is low when it tracks stock
//   (a numeric `stock`) and `stock <= reorderAt`.
// - `reorderQty`: how many the team usually orders, in eaches. Only shown.
// - `ackedAtStock`: someone acknowledged the alert when stock was this. It's
//   shared by the team and kept on the product. The alert stays quiet while
//   stock is at or above it, and comes back when stock falls below it.
// - A restock ends the acknowledgment: any stock change that takes stock above
//   `reorderAt` removes `ackedAtStock` (ackEnds), so the next fall to the
//   reorder level alerts again. That's done by the stock commands that raise
//   stock (a return, a receipt, a count) and the CSV import. Stopping the
//   count (an uncount) removes it too, since an uncounted item is never low.
//   Checkouts only lower stock, so they never end one, and their updates are
//   as they were before low-stock alerts.
// - The decision is made on what the command read, so the update is
//   conditional on it still holding when it commits (ackOnRaise, ackOnCount):
//   the acknowledgment's absence when none was read, and the reorder level and
//   the side of it the new stock falls on when one was. A command that loses a
//   race is cancelled, reads again and retries, as for any other conflict.
//   Changes that don't move the decision (busy checkouts that leave a return
//   on the same side of the level) don't make it conflict.
//
// The document routes take any value that passes checkReorderFields, and
// never compare it with the stock: an acknowledgment that's out of date can't
// make a write fail. A write made against an older version of the item still
// conflicts, as every document write does (ADR 0006). A write that changes
// the reorder level and carries the old acknowledgment over unchanged drops it
// (a new level starts afresh, as the app's editor does).

import { InvalidInputError } from "./errors.js";
import { MAX_QUANTITY } from "./money.js";

/** The product fields this module owns, with the smallest value each takes. */
export const REORDER_FIELDS = { reorderAt: 0, reorderQty: 1, ackedAtStock: 0 } as const;
export type ReorderField = keyof typeof REORDER_FIELDS;

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * Throws unless each reorder field the write sets is a whole number in its
 * range (0 to MAX_QUANTITY; `reorderQty` from 1). A value the stored item
 * already had, carried over unchanged, is let through whatever it is, so a
 * stray value can't block the item's other edits.
 */
export function checkReorderFields(data: Record<string, unknown>, stored?: Record<string, unknown>): void {
  for (const [field, min] of Object.entries(REORDER_FIELDS)) {
    if (!Object.hasOwn(data, field)) continue;
    const value = data[field];
    if (stored && Object.hasOwn(stored, field) && sameValue(stored[field], value)) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > MAX_QUANTITY) {
      throw new InvalidInputError(`${field} must be a whole number from ${min} to ${MAX_QUANTITY}`);
    }
  }
  // A changed (or removed) level starts afresh: an acknowledgment carried over unchanged was of the old one
  if (stored && !sameValue(data.reorderAt, stored.reorderAt) && Object.hasOwn(data, "ackedAtStock") && sameValue(data.ackedAtStock, stored.ackedAtStock)) {
    delete data.ackedAtStock;
  }
}

/**
 * True when stock going to `stock` ends the item's acknowledgment: it has one,
 * and the new stock is above its reorder level (or it has no level, so
 * nothing is left to acknowledge).
 */
export function ackEnds(product: Record<string, unknown> | undefined, stock: number): boolean {
  if (!product || !Object.hasOwn(product, "ackedAtStock")) return false;
  const level = product.reorderAt;
  return typeof level !== "number" || stock > level;
}

/** What a stock command adds to its product update for the acknowledgment. */
export interface AckUpdate {
  /** End the update with `REMOVE #ackedAtStock`. */
  readonly remove: boolean;
  readonly names: Record<string, string>;
  readonly values: Record<string, unknown>;
  /** Conditions the update must also meet: what the decision was made on. */
  readonly clauses: string[];
}

/** No acknowledgment was read: there's still none when the update commits, or it reads again. */
const NONE_READ: AckUpdate = { remove: false, names: { "#ackedAtStock": "ackedAtStock" }, values: {}, clauses: ["attribute_not_exists(#ackedAtStock)"] };

/** The reorder level as read: the same value, or still none. */
function levelAsRead(product: Record<string, unknown>): Pick<AckUpdate, "names" | "values" | "clauses"> {
  const has = Object.hasOwn(product, "reorderAt");
  return {
    names: { "#reorderAt": "reorderAt" },
    values: has ? { ":readLevel": product.reorderAt } : {},
    clauses: [has ? "#reorderAt = :readLevel" : "attribute_not_exists(#reorderAt)"],
  };
}

const withRemoval = (remove: boolean, level: Pick<AckUpdate, "names" | "values" | "clauses">, more: Pick<AckUpdate, "values" | "clauses"> = { values: {}, clauses: [] }): AckUpdate => ({
  remove,
  names: { ...level.names, ...(remove ? { "#ackedAtStock": "ackedAtStock" } : {}) },
  values: { ...level.values, ...more.values },
  clauses: [...level.clauses, ...more.clauses],
});

/**
 * For a stock command that adds `delta` to a product's stock (a return or a
 * receipt): what it adds to its update so a restock ends the acknowledgment.
 * Nothing for a change that doesn't raise stock (a checkout). Otherwise:
 *
 * - No acknowledgment read: the update requires there still to be none.
 * - One read: the update requires the reorder level as read and, for a
 *   level, the new stock on the side of it the decision was made on
 *   (`#stock > :threshold` to remove, `<=` to keep, `threshold = level -
 *   delta`), or no stock still for an item that wasn't counted (a receipt
 *   starts it at `delta`). With no level (or one that isn't a number), it's
 *   always removed.
 *
 * The caller refuses a stock that isn't a number before it gets here.
 */
export function ackOnRaise(product: Record<string, unknown> | undefined, delta: number): AckUpdate | undefined {
  if (!product || delta <= 0) return undefined;
  if (!Object.hasOwn(product, "ackedAtStock")) return NONE_READ;
  const level = product.reorderAt;
  if (typeof level !== "number") return withRemoval(true, levelAsRead(product));
  if (typeof product.stock !== "number") return withRemoval(delta > level, levelAsRead(product), { values: {}, clauses: ["attribute_not_exists(#stock)"] });
  const remove = product.stock + delta > level;
  return withRemoval(remove, levelAsRead(product), { values: { ":threshold": level - delta }, clauses: [remove ? "#stock > :threshold" : "#stock <= :threshold"] });
}

/**
 * For a count that sets stock to `counted` (its update is already conditional
 * on the stock it read): no acknowledgment still, or the reorder level as read.
 */
export function ackOnCount(product: Record<string, unknown>, counted: number): AckUpdate {
  if (!Object.hasOwn(product, "ackedAtStock")) return NONE_READ;
  return withRemoval(ackEnds(product, counted), levelAsRead(product));
}

/** The `REMOVE` clause to append to an update expression, or "". */
export const ackRemoval = (ack: { remove: boolean } | undefined): string => (ack?.remove ? " REMOVE #ackedAtStock" : "");
