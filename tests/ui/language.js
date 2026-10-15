// Finding the app's own English on a screen, for the language suites (tests/i18n.spec.js, tests/es-journeys.spec.js).

// Words of the app's own text. Any of them in a screen's text outside the pseudo-language's ⟦ ⟧ marks is
// text that is still in a template. None is a word in the seeded projects and items.
export const UI_WORDS = /\b(Save|Cancel|Close|Return|Returned|Taken|Used|Charge|Price|Total|Loading|Search|Edit|Delete|Remove|Scan|Add|New|Check|Inventory|Projects|Item|Items|Barcode|Client|Date|Done|Try|Reopen|Finished)\b/;

// The same check for a Spanish screen: "Total" is also a Spanish word, and a few more of the app's English
// words are added, among the ones Spanish doesn't share.
export const ENGLISH_WORDS = new RegExp(
  UI_WORDS.source.replace("|Total|", "|").replace(/\)\\b$/, "|Your|Account|Language|Create|Order|Reorder|Preview|Import|Prepared|Checked out|Out now|Name|Length|Width|Height|Unit|Quick|Back|Help|Sign out)\\b"),
);

/** The screen's text, without what the pseudo-language marks with ⟦ ⟧. */
export const unmarked = (page) => page.evaluate(() => document.body.innerText.replace(/⟦[^⟧]*⟧/g, " "));
