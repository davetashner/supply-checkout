// The app's text (supply-checkout-3ilj): every user-visible string lives in a catalog (src/messages/),
// looked up by key with msg(), so a language is a second catalog and nothing in the templates changes.
//
//   msg("project.count", { count: 3 })   // "3 projects": a plural entry is { one, other } (Intl.PluralRules)
//   msg("legal.notice", { terms, use })  // {name} in the text is replaced by vars.name
//
// msg() returns text, not safe HTML: a value that came from a person goes in through esc() first, as it
// did before, and the catalog's own text is trusted (written here, never typed by a user). A key the
// catalog lacks comes back as the key itself, so a missing string shows as itself in a test rather than blank.
// English is the only catalog so far; the language setting and the Spanish one are the next steps of the bead.

import en from "./messages/en.js";

const plurals = new Intl.PluralRules("en");

/** The text for `key`, with `{name}` replaced from `vars`; a plural entry picks its form by `vars.count`. */
export function msg(key, vars = {}) {
  const entry = en[key] ?? key;
  const text = typeof entry === "string" ? entry : entry[plurals.select(Number(vars.count))];
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
}
