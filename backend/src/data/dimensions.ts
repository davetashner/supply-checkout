// A product's optional size (supply-checkout-hqdv): `length`, `width` and `height`, each a
// positive number in the product's `dimUnit`, inches (the default) or centimeters. The app asks
// for them in that order, and a team can leave any of them blank. Every writer of products checks
// them here, the same way: the document routes (documents.ts).
//
// A blank or null removes a field. The unit is kept only while a size is, and a size with no unit
// is in inches.

import { InvalidInputError } from "./errors.js";

/** The size fields, in the order the app asks for them. */
export const DIMENSION_FIELDS = ["length", "width", "height"] as const;
/** The units a size can be in. */
export const DIMENSION_UNITS = ["in", "cm"] as const;
/** The largest single side, in the unit given: 1,000 in is over 25 m. */
export const MAX_DIMENSION = 1000;

/** One of the units. */
export type DimensionUnit = (typeof DIMENSION_UNITS)[number];

const unitOk = (value: unknown): value is DimensionUnit => DIMENSION_UNITS.some((u) => u === value);

/**
 * Checks and normalizes a product's size fields in `data`, in place: a null removes the field;
 * a side must be a number above 0, at most MAX_DIMENSION, with at most two decimals; the unit
 * must be `in` or `cm`. Anything else is an InvalidInputError. With no sides left the unit goes
 * too, and with a side and no unit the unit is `in`.
 */
export function checkDimensionFields(data: Record<string, unknown>): void {
  for (const field of DIMENSION_FIELDS) {
    if (!Object.hasOwn(data, field)) continue;
    const value = data[field];
    if (value === null) {
      Reflect.deleteProperty(data, field);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new InvalidInputError(`${field} must be a number above 0`);
    if (value > MAX_DIMENSION) throw new InvalidInputError(`${field} is more than ${MAX_DIMENSION}`);
    if (Math.round(value * 100) / 100 !== value) throw new InvalidInputError(`${field} has more than two decimals`);
  }
  if (Object.hasOwn(data, "dimUnit")) {
    if (data.dimUnit === null) delete data.dimUnit;
    else if (!unitOk(data.dimUnit)) throw new InvalidInputError(`dimUnit must be one of: ${DIMENSION_UNITS.join(", ")}`);
  }
  if (DIMENSION_FIELDS.some((f) => Object.hasOwn(data, f))) data.dimUnit ??= "in";
  else delete data.dimUnit;
}
