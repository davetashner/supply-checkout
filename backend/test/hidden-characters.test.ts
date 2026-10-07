// The characters an item's name and brand can't have (supply-checkout-1dg.12),
// and the ordinary text that uses some of them and must still pass.

import { describe, expect, it } from "vitest";
import { hasHiddenCharacter, hiddenCharacterProblem, withoutHiddenCharacters } from "../src/text/hidden-characters.js";

/** Each class, as [what it is, the character, what removing it leaves of "a<c>b"]. */
const HIDDEN: [string, string, string][] = [
  ...["\u0000", "\u0009", "\u000a", "\u000d", "\u001b", "\u001f", "\u007f"].map((c): [string, string, string] => [`C0 or DEL U+${c.charCodeAt(0).toString(16)}`, c, "a b"]),
  ...["\u0080", "\u0085", "\u009b", "\u009f"].map((c): [string, string, string] => [`C1 U+${c.charCodeAt(0).toString(16)}`, c, "a b"]),
  ["line separator", "\u2028", "a b"],
  ["paragraph separator", "\u2029", "a b"],
  ...["؜", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"].map((c): [string, string, string] => [`bidi control U+${c.charCodeAt(0).toString(16)}`, c, "ab"]),
  ...["\u200b", "\u200c", "\u200d", "\u2060", "\u2061", "\u2064", "\ufeff"].map((c): [string, string, string] => [`zero-width U+${c.charCodeAt(0).toString(16)}`, c, "ab"]),
  ["tag character", "\u{e0041}", "ab"],
  ["cancel tag", "\u{e007f}", "ab"],
  ["lone high surrogate", "\ud83d", "ab"],
  ["lone low surrogate", "\udc69", "ab"],
];

/** Text people write, some of it with joiners or tags in the sequences that allow them. */
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
  "🧤 Gloves",
  "👩\u200d🔧 Mechanic kit",
  "👩🏽\u200d🔧",
  "🏳️\u200d🌈",
  "👨\u200d👩\u200d👧\u200d👦",
  "❤️\u200d🔥",
  "🧑\u200d🤝\u200d🧑",
  "1️⃣",
  "🇺🇸",
  // Scotland's flag: tag characters ending in a cancel tag
  "🏴\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}",
  // Persian with a zero-width non-joiner, Hindi and Sinhala with a joiner
  "می\u200cخواهم",
  "क्\u200dष",
  "ශ්\u200dරී",
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

  it("refuses a joiner outside an emoji sequence or a joining script", () => {
    for (const text of [
      "Glo\u200dves", // between Latin letters
      "Glo\u200cves",
      "\u200d🔧", // with no emoji before it
      "👩\u200d", // with no emoji after it
      "👩\u200d Gloves",
      "👩 \u200d🔧", // a space before it
      "👩\u200d\u200d🔧", // two
      "👩\u200d\u202e🔧", // followed by another hidden character
      "\u200cمی", // a non-joiner with no letter before it
      "می\u200c", // or after it
      "a\u200cم", // after a Latin letter
      "🏴\u{e0067}\u{e0062}", // a flag's tags with no cancel tag
      "\u{e0067}\u{e0062}\u{e007f}", // tags with no black flag
    ]) {
      expect(hasHiddenCharacter(text), JSON.stringify(text)).toBe(true);
    }
    expect(withoutHiddenCharacters("Glo\u200dves 👩\u200d🔧\u200d")).toBe("Gloves 👩\u200d🔧");
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

  it("is the rule the app cleans pasted text by (visibleText in src/format.js), so what it saves isn't refused", async () => {
    const app = (await import(new URL("../../src/format.js", import.meta.url).href)) as { visibleText: (t: string) => string };
    const texts = [...HIDDEN.flatMap(([, c]) => [c, `a${c}b`, `${c}${c}ab`]), ...ORDINARY, "Glo\u200dves \u{1f469}\u200d\u{1f527}\u200d", "\u{1f3f4}\u{e0067}\u{e0062}", "\u0645\u06cc\u200c"];
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
