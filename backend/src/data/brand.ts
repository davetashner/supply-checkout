// A product's optional brand (supply-checkout-005.9): free text a person
// types, shown next to the item's name, searched, exported and quoted in the
// receipt-reading prompt. Every writer of products checks it here, the same
// way: the document routes (documents.ts), the CSV import (imports.ts) and
// the artifact import (artifact-import.ts).
//
// Its rules follow the item name's (MAX_NAME_LENGTH in imports.ts): text,
// trimmed, with no control or invisible characters (src/text/hidden-characters.ts),
// and shorter, since a brand is a word or two. Blank or null means no brand,
// and the field is left out.

import { InvalidInputError } from "./errors.js";
import { hiddenCharacterProblem } from "../text/hidden-characters.js";

/** The longest brand, after trimming. */
export const MAX_BRAND_LENGTH = 100;

/**
 * Why `value` can't be a brand, or undefined if it can. `value` is the text
 * as trimmed (brandOf trims it first). `stored` is the brand the product
 * already has, if any: a write that keeps it unchanged isn't refused for an
 * invisible character it was stored with before they were refused.
 */
export function brandProblem(value: string, stored?: unknown): string | undefined {
  if (value.length > MAX_BRAND_LENGTH) return `brand is longer than ${MAX_BRAND_LENGTH} characters`;
  return value === stored ? undefined : hiddenCharacterProblem("brand", value);
}

/**
 * A brand as it's stored: the text trimmed, or undefined for none (null,
 * or blank). Anything else that isn't text, or text that's too long or has a
 * control or invisible character in it, is an InvalidInputError. `stored`:
 * as for brandProblem.
 */
export function brandOf(value: unknown, stored?: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new InvalidInputError("brand must be text");
  const brand = value.trim();
  const problem = brandProblem(brand, stored);
  if (problem) throw new InvalidInputError(problem);
  return brand || undefined;
}
