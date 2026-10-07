// Characters a one-line label can carry without anyone seeing them
// (supply-checkout-1dg.12, 1dg.13). An item's name and brand, a project's
// client, and a team's name are typed by one person and read by others, in
// lists, in the receipt match dropdown ("Name · Brand · barcode"), in emails
// and in the receipt-reading prompt. These characters let that text read
// differently from what it is, or carry text nobody sees:
//
// - control characters (C0, DEL and C1): line breaks, tabs, terminal escapes;
// - line and paragraph separators (U+2028, U+2029), and the interlinear
//   annotation characters (U+FFF9–U+FFFB);
// - bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069),
//   which can make "Gloves · 12345" read backwards;
// - every other default-ignorable code point: zero-width characters
//   (U+200B–U+200D, U+2060–U+2064, U+FEFF), the soft hyphen, Hangul fillers,
//   Mongolian selectors, variation selectors (U+FE00–U+FE0F and
//   U+E0100–U+E01EF), musical format characters and tag characters
//   (U+E0000–U+E007F), invisible copies of ASCII that a language model still
//   reads. Variation selectors can hide data the same way;
// - and halves of a surrogate pair on their own (text that isn't
//   well-formed UTF-16).
//
// Some of them are part of ordinary text, so they're allowed there, as whole
// sequences of fixed, short length:
//
// - a zero-width joiner (U+200D) between two emoji, which builds one emoji
//   from several (woman, U+200D, wrench is a mechanic). Each side is an emoji
//   shown as one by default (Emoji_Presentation), or a pictographic emoji from
//   U+2190 up (heart, medical symbol, white flag), which leaves out digits,
//   # and *, and the letterlike symbols © ® ™ ‼ ⁉ ℹ. A skin tone or U+FE0F may
//   follow the first;
// - one variation selector, U+FE0E or U+FE0F, straight after an emoji or a
//   symbol that has an emoji form (a red heart, a keycap 1);
// - one ideographic variation selector (U+E0100–U+E01EF) after a Han
//   character (Japanese names), and one Mongolian free variation selector
//   (U+180B–U+180D, U+180F) after a Mongolian letter;
// - a zero-width joiner or non-joiner (U+200C) after a letter of a script
//   whose spelling uses them (Persian, Hindi, Bengali, Sinhala and others),
//   with up to four marks between and before a letter or mark of the same
//   script (marks that aren't themselves default-ignorable, so no variation
//   selector or other hidden mark rides inside) (Bengali's ra-phala puts the joiner before a virama). In
//   Malayalam, a joiner after a letter and virama also ends a word (the
//   old-style chillu);
// - the three subdivision flags in Unicode's recommended set: England,
//   Scotland and Wales (a black flag followed by their tags and U+E007F).
//
// Anywhere else they're refused. Every alternative below matches a bounded
// number of characters at each position, so a scan takes time linear in the
// text: no backtracking on long runs of marks, joiners or tags. Callers still
// check a field's length before scanning it.
//
// visibleText in src/format.js is the same rule for the app; a test keeps the
// two patterns' sources identical (HIDDEN_TEXT_SOURCE).

/** Scripts whose spelling uses the zero-width joiner and non-joiner. */
const JOINING_SCRIPTS = ["Arabic", "Syriac", "Nko", "Mongolian", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala"];
/** One emoji on either side of a ZWJ: shown as an emoji by default, or pictographic from U+2190 up. */
const EMOJI = "(?:\\p{Emoji_Presentation}|(?=\\p{Extended_Pictographic})(?=\\p{Emoji})[\\u2190-\\u{10FFFF}])";
/** The tags of England's, Scotland's and Wales's flags (gbeng, gbsct, gbwls). */
const FLAG_TAGS = ["gbeng", "gbsct", "gbwls"].map((t) => [...t].map((c) => `\\u{E00${c.charCodeAt(0).toString(16)}}`).join("")).join("|");

/** The sequences in which a hidden character is part of the text, kept as group 1. */
const ALLOWED = [
  `${EMOJI}\\p{Emoji_Modifier}?\\uFE0F?\\u200D(?=${EMOJI})`,
  "\\p{Emoji}[\\uFE0E\\uFE0F]",
  "\\p{sc=Han}[\\u{E0100}-\\u{E01EF}]",
  "(?=\\p{L})\\p{sc=Mongolian}[\\u180B-\\u180D\\u180F]",
  "(?=\\p{L})\\p{sc=Malayalam}\\u0D4D\\u200D",
  ...JOINING_SCRIPTS.map((s) => `(?=\\p{L})\\p{sc=${s}}(?:(?!\\p{Default_Ignorable_Code_Point})\\p{M}){0,4}[\\u200C\\u200D](?=(?!\\p{Default_Ignorable_Code_Point})(?=[\\p{L}\\p{M}])\\p{sc=${s}})`),
  `\\u{1F3F4}(?:${FLAG_TAGS})\\u{E007F}`,
].join("|");

/** One hidden character (see above), a lone surrogate included. */
const HIDDEN = "[\\p{Cc}\\p{Default_Ignorable_Code_Point}\\p{Bidi_Control}\\u2028\\u2029\\uFFF9-\\uFFFB\\uD800-\\uDFFF]";

/** The pattern's source: an allowed sequence (group 1, kept) or a hidden character (no group: refused, or removed). */
export const HIDDEN_TEXT_SOURCE = `(${ALLOWED})|${HIDDEN}`;
/** Its flags. Global, so it's kept private: matchAll and replace never share its lastIndex. */
export const HIDDEN_TEXT_FLAGS = "gu";
const HIDDEN_TEXT = new RegExp(HIDDEN_TEXT_SOURCE, HIDDEN_TEXT_FLAGS);

/** Hidden characters that separate words, and become a space when removed. */
const SEPARATOR = /^[\p{Cc}\u2028\u2029]$/u;

/**
 * True if `value` has a hidden character in it outside the sequences that
 * allow one, or isn't well-formed UTF-16.
 */
export function hasHiddenCharacter(value: string): boolean {
  if (!value.isWellFormed()) return true;
  for (const match of value.matchAll(HIDDEN_TEXT)) if (match[1] === undefined) return true;
  return false;
}

/**
 * `value` without its hidden characters: control characters and line
 * separators become a space (they separate words), and the rest, which have
 * no width, are removed, so the text reads as it looked. The sequences that
 * allow one are kept.
 */
export function withoutHiddenCharacters(value: string): string {
  return value.replace(HIDDEN_TEXT, (match: string, kept: string | undefined) => kept ?? (SEPARATOR.test(match) ? " " : ""));
}

/**
 * Why `value` can't be the text of `field` (an item's "name", a project's
 * "client"), or undefined if it can. The message names the field, never the
 * value.
 */
export function hiddenCharacterProblem(field: string, value: string): string | undefined {
  return hasHiddenCharacter(value) ? `${field} has an invisible or control character in it` : undefined;
}
