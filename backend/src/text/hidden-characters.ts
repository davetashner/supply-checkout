// Characters a one-line label can carry without anyone seeing them
// (supply-checkout-1dg.12). An item's name and brand are typed by one team
// member and read by the others, in lists, in the receipt match dropdown
// ("Name · Brand · barcode") and in the receipt-reading prompt. These
// characters let that text read differently from what it is:
//
// - control characters (C0, DEL and C1): line breaks, tabs, terminal escapes;
// - line and paragraph separators (U+2028, U+2029), which break a line too;
// - bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069),
//   which can make "Gloves · 12345" read backwards;
// - zero-width characters (U+200B–U+200D, U+2060–U+2064, U+FEFF), which make
//   two different names look the same;
// - tag characters (U+E0000–U+E007F), invisible copies of ASCII that a
//   language model still reads;
// - and halves of a surrogate pair on their own (text that isn't
//   well-formed UTF-16).
//
// Some of them are also part of ordinary text, so they're allowed there:
//
// - a zero-width joiner (U+200D) between two emoji, which builds one emoji
//   from several (👩‍🔧 is 👩, U+200D, 🔧), with a skin tone or the emoji
//   variation selector (U+FE0F) allowed after the first;
// - a zero-width joiner or non-joiner (U+200C) between two letters of a
//   script whose spelling uses them (Persian, Hindi, Sinhala and others);
// - tag characters in a subdivision flag (🏴 followed by tags, ending in
//   U+E007F), such as Scotland's.
//
// Anywhere else they're refused: a joiner at the start or end, next to a
// space, between Latin letters or after another hidden character.

/** Scripts whose spelling uses the zero-width joiner and non-joiner. */
const JOINING_SCRIPTS = ["Arabic", "Syriac", "Nko", "Mongolian", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala"]
  .map((s) => `\\p{sc=${s}}`)
  .join("");

/** The sequences in which a hidden character is part of the text. */
const ALLOWED = [
  // An emoji ZWJ sequence: the emoji before the joiner (kept as matched) and a lookahead for the one after
  "\\p{Extended_Pictographic}[\\p{Emoji_Modifier}\\uFE0F]?\\u200D(?=\\p{Extended_Pictographic})",
  // A joiner or non-joiner between two letters (with any marks after the first) of a joining script
  `[${JOINING_SCRIPTS}]\\p{M}*[\\u200C\\u200D](?=[${JOINING_SCRIPTS}])`,
  // A subdivision flag
  "\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F}",
].join("|");

/** One hidden character (see above), a lone surrogate included. */
const HIDDEN = "[\\p{Cc}\\u2028\\u2029\\p{Bidi_Control}\\u200B-\\u200D\\u2060-\\u2064\\uFEFF\\u{E0000}-\\u{E007F}\\uD800-\\uDFFF]";

/** An allowed sequence (group 1, kept) or a hidden character (no group, refused or removed). */
const scan = () => new RegExp(`(${ALLOWED})|${HIDDEN}`, "gu");

/**
 * True if `value` has a hidden character in it outside the sequences that
 * allow one, or isn't well-formed UTF-16.
 */
export function hasHiddenCharacter(value: string): boolean {
  if (!value.isWellFormed()) return true;
  for (const match of value.matchAll(scan())) if (match[1] === undefined) return true;
  return false;
}

/**
 * `value` without its hidden characters: control characters and line
 * separators become a space (they separate words), and the rest, which have
 * no width, are removed, so the text reads as it looked. The sequences that
 * allow one are kept.
 */
export function withoutHiddenCharacters(value: string): string {
  return value.replace(scan(), (match: string, kept: string | undefined) => kept ?? (/^[\p{Cc}\u2028\u2029]$/u.test(match) ? " " : ""));
}

/**
 * Why `value` can't be the text of `field` (an item's "name" or "brand"), or
 * undefined if it can. The message names the field, never the value.
 */
export function hiddenCharacterProblem(field: string, value: string): string | undefined {
  return hasHiddenCharacter(value) ? `${field} has an invisible or control character in it` : undefined;
}
