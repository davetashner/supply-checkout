// A product's pack (ADR 0014): `packSize`, how many single items a pack holds, and `packCost`, what
// the business paid for a whole pack, exactly as entered. The pack cost is what has tax and
// accounting weight, so it's kept as it is; `cost`, the cost of one, is worked out from it and
// rounded to cents (packCost ÷ packSize). Every writer of products checks them here, the same way:
// the document routes (documents.ts).
//
// A null removes `packCost`. A product with a pack cost has a pack of more than one and the cost
// of one that goes with it, so the three can't disagree.

import { InvalidInputError } from "./errors.js";
import { money, roundCents, storedMoney } from "./money.js";

/** The largest pack size (ADR 0014). */
export const MAX_PACK_SIZE = 10_000;

/** The cost of one from a pack's cost: rounded to cents, halves up (ADR 0014). */
export function costEach(packCost: number, packSize: number): number {
  return roundCents(packCost / packSize);
}

const same = (a: unknown, b: unknown) => a === b;

/**
 * Checks and normalizes a product's pack fields in `data`, in place. `stored` is the product as it
 * is, for values a write carries over unchanged: a pack size written before it was checked doesn't
 * block a write that leaves it alone, as for legacy money (documents.ts writtenMoney).
 *
 * - `packSize`, where the write changes it: a whole number from 1 to MAX_PACK_SIZE.
 * - `packCost`: money (or the stored amount, rounded to cents), only on a supply, only with a
 *   `packSize` above 1, and with `cost` equal to costEach(packCost, packSize).
 */
export function checkPackFields(data: Record<string, unknown>, stored?: Record<string, unknown>): void {
  if (Object.hasOwn(data, "packSize") && !same(data.packSize, stored?.packSize)) {
    const size = data.packSize;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > MAX_PACK_SIZE) {
      throw new InvalidInputError(`packSize must be a whole number from 1 to ${MAX_PACK_SIZE}`);
    }
  }
  if (!Object.hasOwn(data, "packCost")) return;
  if (data.packCost === null) {
    delete data.packCost;
    return;
  }
  const packCost = same(data.packCost, stored?.packCost) ? (storedMoney(data.packCost) ?? money(data.packCost, "packCost")) : money(data.packCost, "packCost");
  data.packCost = packCost;
  // Company equipment is reused, not bought in packs: its cost is what one is worth (ADR 0017)
  if (data.kind === "equipment") throw new InvalidInputError("Company equipment has no packCost");
  const size = data.packSize;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 2 || size > MAX_PACK_SIZE) {
    throw new InvalidInputError("packCost needs a packSize of 2 or more");
  }
  if (data.cost !== costEach(packCost, size)) {
    throw new InvalidInputError(`cost must be packCost ÷ packSize, rounded to cents: ${costEach(packCost, size)}`);
  }
}
