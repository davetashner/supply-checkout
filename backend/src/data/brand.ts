// A product's optional brand (supply-checkout-005.9): free text a person
// types, shown next to the item's name, searched, exported and quoted in the
// receipt-reading prompt. Every writer of products checks it here, the same
// way: the document routes (documents.ts), the CSV import (imports.ts) and
// the artifact import (artifact-import.ts).
//
// Its rules follow the item name's (MAX_NAME_LENGTH in imports.ts): text,
// trimmed, with no control characters, and shorter, since a brand is a word
// or two. Blank or null means no brand, and the field is left out.

import { InvalidInputError } from "./errors.js";

/** The longest brand, after trimming. */
export const MAX_BRAND_LENGTH = 100;

// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Why `value` can't be a brand, or undefined if it can. `value` is the text
 * as trimmed (brandOf trims it first).
 */
export function brandProblem(value: string): string | undefined {
  if (value.length > MAX_BRAND_LENGTH) return `brand is longer than ${MAX_BRAND_LENGTH} characters`;
  if (CONTROL.test(value)) return "brand has a control character in it";
  return undefined;
}

/**
 * A brand as it's stored: the text trimmed, or undefined for none (null,
 * or blank). Anything else that isn't text, or text that's too long or has a
 * control character in it, is an InvalidInputError.
 */
export function brandOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidInputError("brand must be text");
  const brand = value.trim();
  const problem = brandProblem(brand);
  if (problem) throw new InvalidInputError(problem);
  return brand || undefined;
}
