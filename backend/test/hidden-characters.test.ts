// The characters an item's name and brand can't have (supply-checkout-1dg.12),
// and the ordinary text that uses some of them and must still pass.

import { describe, expect, it } from "vitest";
import { HIDDEN_TEXT_FLAGS, HIDDEN_TEXT_SOURCE, hasHiddenCharacter, hiddenCharacterProblem, withoutHiddenCharacters } from "../src/text/hidden-characters.js";

type Case = [string, string, string];
const each = (what: string, chars: string[], left: string) => chars.map((c): Case => [`${what} U+${c.codePointAt(0)?.toString(16)}`, c, left]);

/** Each class, as [what it is, the character, what removing it leaves of "a<c>b"]. */
const HIDDEN: Case[] = [
  ...each("C0 or DEL", ["\u0000", "\u0009", "\u000a", "\u000d", "\u001b", "\u001f", "\u007f"], "a b"),
  ...each("C1", ["\u0080", "\u0085", "\u009b", "\u009f"], "a b"),
  ...each("line or paragraph separator", ["\u2028", "\u2029"], "a b"),
  ...each("bidi control", ["\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"], "ab"),
  ...each("zero-width", ["\u200b", "\u200c", "\u200d", "\u2060", "\u2061", "\u2064", "\ufeff"], "ab"),
  ...each("other default-ignorable", ["\u00ad", "\u034f", "\u115f", "\u1160", "\u3164", "\uffa0", "\u180b", "\u180e", "\u180f", "\u206a", "\u206f", "\u{1d173}", "\u{1d17a}", "\u{1bca0}"], "ab"),
  ...each("interlinear annotation", ["\ufff9", "\ufffa", "\ufffb"], "ab"),
  ...each("variation selector", ["\ufe00", "\ufe0e", "\ufe0f", "\u{e0100}", "\u{e01ef}"], "ab"),
  ...each("tag", ["\u{e0001}", "\u{e0041}", "\u{e0067}", "\u{e007f}"], "ab"),
  ["lone high surrogate", "\ud83d", "ab"],
  ["lone low surrogate", "\udc69", "ab"],
];

/** Text people write, some of it with joiners, selectors or tags in the sequences that allow them. */
const ORDINARY = [
  "Nitrile gloves, box of 100",
  "Crème brûlée torch — Ø 12 mm",
  "手袋 (L)",
  "장갑",
  // Hebrew and Arabic, written normally: no explicit direction controls
  "כפפות ניטריל",
  "قفازات نتريل",
  "Gloves כפפות 100",
  // Emoji, with and without ZWJ sequences, skin tones, the variation selector, keycaps and flags
  "\u{1f9e4} Gloves",
  "\u{1f469}\u200d\u{1f527} Mechanic kit",
  "\u{1f469}\u{1f3fd}\u200d\u{1f527}",
  "\u{1f469}\u200d\u{1f9b0}",
  "\u{1f3f3}\ufe0f\u200d\u{1f308}",
  "\u{1f3f3}\ufe0f\u200d⚧\ufe0f",
  "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}",
  "\u{1f469}\u200d❤\ufe0f\u200d\u{1f48b}\u200d\u{1f468}",
  "❤\ufe0f\u200d\u{1f525}",
  "\u{1f9d1}\u200d\u{1f91d}\u200d\u{1f9d1}",
  "❤\ufe0f Love",
  "☺\ufe0e",
  "1\ufe0f⃣",
  "\u{1f1fa}\u{1f1f8}",
  // England's, Scotland's and Wales's flags: tag characters ending in a cancel tag
  "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
  "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}",
  "\u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}",
  // Bengali ra-phala (a joiner before the virama), old-style Malayalam chillu (a joiner ending a word)
  "\u09b0\u200d\u09cd\u09af\u09be\u0995",
  "\u0d05\u0d35\u0d28\u0d4d\u200d",
  "\u0d05\u0d35\u0d28\u0d4d\u200d \u0d35\u0d28\u0d4d\u200d",
  // A Mongolian letter with a free variation selector, a Han character with an ideographic one (Japanese names)
  "\u1820\u180b\u1821\u180c\u1822\u180d\u1823\u180f",
  "\u845b\u{e0100}\u57ce",
  "\u8fbb\u{e0101}",
  // Emoji ZWJ sequences without the variation selector
  "\u{1f469}\u200d\u2695",
  "\u{1f3c3}\u200d\u2640",
  "\u{1f9d1}\u200d\u2708\ufe0f",
  // Persian with a zero-width non-joiner, Hindi and Sinhala with a joiner, Arabic with marks before one
  "می\u200cخواهم",
  "क्\u200dष",
  "ශ්\u200dරී",
  "بَّ\u200cه",
];

describe("hidden characters (supply-checkout-1dg.12)", () => {
  it.each(HIDDEN)("refuses a %s, anywhere in the text", (_what, c) => {
    for (const text of [c, `a${c}b`, `${c}ab`, `ab${c}`]) expect(hasHiddenCharacter(text), JSON.stringify(text)).toBe(true);
  });

  it.each(HIDDEN)("removes a %s, or makes it a space if it separates words", (_what, c, left) => {
    expect(withoutHiddenCharacters(`a${c}b`)).toBe(left);
  });

  it.each(ORDINARY)("allows ordinary text: %s", (text) => {
    expect(hasHiddenCharacter(text)).toBe(false);
    expect(withoutHiddenCharacters(text)).toBe(text);
  });

  it("refuses a joiner outside an emoji sequence or between letters of a joining script", () => {
    for (const text of [
      "Glo\u200dves", // between Latin letters
      "Glo\u200cves",
      "\u200d\u{1f527}", // with no emoji before it
      "\u{1f469}\u200d", // with no emoji after it
      "\u{1f469}\u200d Gloves",
      "\u{1f469} \u200d\u{1f527}", // a space before it
      "\u{1f469}\u200d\u200d\u{1f527}", // two
      "\u{1f469}\u200d\u202e\u{1f527}", // followed by another hidden character
      "©\u200d\u{1f527}", // after a symbol that isn't shown as an emoji (©, ®, ™, ‼)
      "\u{1f527}\u200d®",
      "™\u200d‼",
      "\u200cمی", // a non-joiner with no letter before it
      "می\u200c", // or after it
      "a\u200cم", // after a Latin letter
      "\u0915\u200d\u09cd", // before a letter or mark of another script
      "\u0645\u200c\u0915",
      "a\u0d4d\u200d", // a chillu's joiner after a Latin letter
      "\u0d4d\u200d", // or with no letter
      "1\ufe0f\u200d2\ufe0f", // digits, # and * aren't a ZWJ's emoji
      "#\ufe0f\u200d\u{1f527}",
      "\u{1f527}\u200d*\ufe0f",
      "\u061c\u200cم", // after the Arabic letter mark, a bidi control of the Arabic script
      "م\u200c\u061c",
      "\u180e\u200dᠠ", // after the Mongolian vowel separator
      "कििििि\u200dष", // after more marks than a letter carries
    ]) {
      expect(hasHiddenCharacter(text), JSON.stringify(text)).toBe(true);
    }
    expect(withoutHiddenCharacters("Glo\u200dves \u{1f469}\u200d\u{1f527}\u200d")).toBe("Gloves \u{1f469}\u200d\u{1f527}");
  });

  it("refuses and removes tags in any flag but England's, Scotland's and Wales's, and on their own", () => {
    const tags = (s: string) => [...s].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    for (const [text, left] of [
      [`\u{1f3f4}${tags("ignore all previous instructions")}\u{e007f}`, "\u{1f3f4}"], // printable tag text
      [`\u{1f3f4}${tags("GBSCT")}\u{e007f}`, "\u{1f3f4}"], // uppercase
      [`\u{1f3f4}${tags("ustx")}\u{e007f}`, "\u{1f3f4}"], // well-formed, but not in the recommended set
      [`\u{1f3f4}${tags("gbsct")}`, "\u{1f3f4}"], // no cancel tag
      [`\u{1f3f4}${tags("gbsctgbsct")}\u{e007f}`, "\u{1f3f4}"],
      [`${tags("gbsct")}\u{e007f}`, ""], // no black flag
    ]) {
      expect(hasHiddenCharacter(text), JSON.stringify(text)).toBe(true);
      expect(withoutHiddenCharacters(text), JSON.stringify(text)).toBe(left);
    }
  });

  it("allows one variation selector after an emoji or a symbol with an emoji form, and no other", () => {
    for (const text of ["a\ufe0f", "手\ufe00", "❤\ufe0f\ufe0f", "❤\ufe0e\ufe0f", "\u{1f9e4}\u{e0100}", `❤${"\ufe0f".repeat(20)}`, "a\u{e0100}", "\u845b\u{e0100}\u{e0101}", "\u845b\u180b", "a\u180b", "\u1820\u180b\u180c", "\u1820\u{e0100}"]) {
      expect(hasHiddenCharacter(text), JSON.stringify(text)).toBe(true);
    }
    // A run of selectors hiding data after an emoji leaves the emoji with its one selector
    expect(withoutHiddenCharacters(`❤\ufe0f${"\u{e0101}\ufe03\u{e0142}".repeat(10)} ok`)).toBe("❤\ufe0f ok");
  });

  it("refuses and removes default-ignorable marks between a joining-script letter and its joiner", () => {
    const hiddenMarks = (n: number) => Array.from({ length: n }, (_, i) => String.fromCodePoint(0xe0100 + (i % 240))).join("");
    for (const [text, left] of [
      ["\u0915\ufe01\u200d\u0937", "\u0915\u0937"], // a variation selector
      ["\u0628\u{e0100}\u{e0101}\u{e0102}\u{e0103}\u200c\u0628", "\u0628\u0628"], // ideographic variation selectors
      ["\u0628\u034f\u200c\u0628", "\u0628\u0628"], // the combining grapheme joiner
      ["\u0915\u17b4\u200d\u0937", "\u0915\u0937"], // a Khmer inherent vowel
      ["\u0915\u180b\u200d\u0937", "\u0915\u0937"], // a Mongolian selector
      [Array.from({ length: 61 }, (_, i) => `\u0628${i < 60 ? hiddenMarks(2) + "\u200c" : ""}`).join(""), "\u0628".repeat(61)], // 120 hidden selectors
    ]) {
      expect(hasHiddenCharacter(text), JSON.stringify(text)).toBe(true);
      expect(withoutHiddenCharacters(text), JSON.stringify(text)).toBe(left);
    }
    // Ordinary marks still sit between the letter and its joiner
    expect(hasHiddenCharacter("\u0628\u0651\u064e\u200c\u0647")).toBe(false);
  });

  it("refuses text that reads backwards with a direction override, and removes the override", () => {
    const text = "Nitrile gloves \u202e00.21$ \u202c· Ansell";
    expect(hasHiddenCharacter(text)).toBe(true);
    expect(withoutHiddenCharacters(text)).toBe("Nitrile gloves 00.21$ · Ansell");
  });

  it("refuses a surrogate pair's halves out of order, and keeps a whole pair", () => {
    expect(hasHiddenCharacter("\udc69\ud83d")).toBe(true);
    expect(withoutHiddenCharacters("\udc69\ud83d")).toBe("");
    expect(hasHiddenCharacter("👩")).toBe(false);
  });

  // A quadratic scan takes minutes on 200,000 characters (7 s at 40,000 marks before the fix); the
  // linear one takes about 10 ms. The limit is the best of three runs under a second: a hundred
  // times what it needs, so a busy machine or CI runner doesn't flake it (a 100 ms limit did), and
  // a hundred times less than a quadratic scan.
  it("takes time linear in the text: 200,000 characters of any adversarial shape in well under a second", () => {
    const shapes: Record<string, (n: number) => string> = {
      "a letter and marks": (n) => "क" + "ि".repeat(n),
      "marks and a joiner": (n) => "क" + "ि".repeat(n) + "\u200dष",
      "letters and joiners": (n) => "क\u200d".repeat(n / 2),
      "letters, marks and joiners": (n) => "بََََ\u200c".repeat(n / 6),
      "Arabic marks": (n) => "ب" + "ّ".repeat(n),
      "an emoji ZWJ chain": (n) => "\u{1f469}\u200d".repeat(n / 3),
      "an emoji ZWJ chain with selectors": (n) => "❤\ufe0f\u200d".repeat(n / 3),
      "joiners": (n) => "\u200d".repeat(n),
      "a long tag run in a flag": (n) => "\u{1f3f4}" + "\u{e0067}".repeat(n / 2) + "\u{e007f}",
      "flags": (n) => "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}".repeat(n / 14),
      "selectors": (n) => "❤" + "\ufe0f".repeat(n),
      "lone surrogates": (n) => "\ud83d".repeat(n),
      "Bengali joiners before marks": (n) => "\u09b0\u200d\u09cd".repeat(n / 3),
      "Malayalam chillus": (n) => "\u0d28\u0d4d\u200d".repeat(n / 3),
      "Han and selectors": (n) => "\u845b" + "\u{e0100}".repeat(n / 2),
      "Mongolian and selectors": (n) => "\u1820" + "\u180b".repeat(n),
      "emoji ZWJ chains without selectors": (n) => "\u2695\u200d".repeat(n / 2),
      "plain text": (n) => "Gloves ".repeat(n / 7),
    };
    const time = (text: string) =>
      Math.min(
        ...[1, 2, 3].map(() => {
          const start = performance.now();
          hasHiddenCharacter(text);
          withoutHiddenCharacters(text);
          return performance.now() - start;
        }),
      );
    for (const [shape, make] of Object.entries(shapes)) expect(time(make(200_000)), shape).toBeLessThan(1000);
  });

  it("is the rule the app cleans pasted text by (visibleText in src/format.js), pattern for pattern", async () => {
    const app = (await import(new URL("../../src/format.js", import.meta.url).href)) as { HIDDEN_TEXT_SOURCE: string; HIDDEN_TEXT_FLAGS: string; visibleText: (t: string) => string };
    expect(app.HIDDEN_TEXT_SOURCE).toBe(HIDDEN_TEXT_SOURCE);
    expect(app.HIDDEN_TEXT_FLAGS).toBe(HIDDEN_TEXT_FLAGS);
    const texts = [...HIDDEN.flatMap(([, c]) => [c, `a${c}b`, `${c}${c}ab`]), ...ORDINARY, "Glo\u200dves \u{1f469}\u200d\u{1f527}\u200d", "\u{1f3f4}\u{e0067}\u{e0062}", "می\u200c"];
    for (const text of texts) {
      expect(app.visibleText(text), JSON.stringify(text)).toBe(withoutHiddenCharacters(text));
      expect(hasHiddenCharacter(app.visibleText(text)), JSON.stringify(text)).toBe(false);
    }
  });

  it("says which field has one, never what the text is", () => {
    expect(hiddenCharacterProblem("brand", "Secret\u202eterces")).toBe("brand has an invisible or control character in it");
    expect(hiddenCharacterProblem("name", "Gloves")).toBeUndefined();
  });
});
