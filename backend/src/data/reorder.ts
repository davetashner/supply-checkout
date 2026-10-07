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
//   stock (a return, a receipt, a count) and the CSV import. Checkouts only
//   lower stock, so they never end one.
//
// The document routes take any value that passes checkReorderFields, and
// never compare it with the stock: an acknowledgment that's out of date can't
// make a write fail. A write made against an older version of the item still
// conflicts, as every document write does (ADR 0006).

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

/**
 * For a stock command that adds `delta` to a product's stock: what it adds to
 * its update so a restock ends the acknowledgment. Nothing unless the product
 * has one and the change raises stock. Then the update is conditional on the
 * stock it read (`#stock = :seenStock`), so the decision is made on the stock
 * the change applies to: a change that lost a race is cancelled and the
 * command reads again and retries, as it does for any other conflict. With
 * `remove`, the update ends with `REMOVE #ackedAtStock`.
 */
export function ackOnRaise(
  product: Record<string, unknown> | undefined,
  delta: number,
): { remove: boolean; names: Record<string, string>; values: Record<string, unknown>; clause: string } | undefined {
  if (!product || !Object.hasOwn(product, "ackedAtStock") || delta <= 0) return undefined;
  const seen = typeof product.stock === "number" ? product.stock : undefined;
  const remove = ackEnds(product, (seen ?? 0) + delta);
  return {
    remove,
    names: { "#stock": "stock", ...(remove ? { "#ackedAtStock": "ackedAtStock" } : {}) },
    values: seen === undefined ? {} : { ":seenStock": seen },
    clause: seen === undefined ? "attribute_not_exists(#stock)" : "#stock = :seenStock",
  };
}

/** The `REMOVE` clause to append to an update expression, or "". */
export const ackRemoval = (ack: { remove: boolean } | undefined): string => (ack?.remove ? " REMOVE #ackedAtStock" : "");
