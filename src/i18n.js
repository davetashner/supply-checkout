// The app's text (supply-checkout-3ilj): every user-visible string lives in a catalog (src/messages/),
// looked up by key with msg(), so a language is a second catalog and nothing in the templates changes.
//
//   msg("project.count", { count: 3 })   // "3 projects": a plural entry has a form per Intl.PluralRules category
//   msg("legal.notice", { terms, use })  // {name} in the text is replaced by vars.name
//
// msg() returns text, not safe HTML: a value that came from a person goes in through esc() first, as it
// did before, and the catalog's own text is trusted (written here, never typed by a user). A key the
// language lacks falls back to English, and one English lacks comes back as the key itself, so a missing
// string shows as itself in a test rather than blank.
//
// The language is chosen once, as this module loads (top-level await, so nothing that imports it runs
// before the catalog is there): ?lang= in the address (a reviewer's preview, and kept on this device),
// else the device's saved choice, else the browser's language if it's one the app offers to everyone
// (OFFERED), else English. Spanish isn't offered to everyone until a native speaker has signed off the
// catalog (supply-checkout-oopu); until then it's reached with ?lang=es.

import en from "./messages/en.js";

/** Every language with a catalog, and the locale its dates, numbers and money use. */
const LOCALES = { en: "en-US", es: "es-US" };
/** The languages the browser's own language may pick. */
const OFFERED = ["en"];
export const STORAGE_KEY = "supplyCheckout.language";

let language = "en";
let catalog = en;
let plurals = new Intl.PluralRules(LOCALES.en);

/** The language the app speaks now. */
export const currentLanguage = () => language;
/** The locale for dates, numbers and money. */
export const locale = () => LOCALES[language];

/** Every language there is a catalog for. */
export const languages = () => Object.keys(LOCALES);

/** Speaks `lang` from now on. Spanish's catalog is loaded when it's wanted, not with the app. */
export async function setLanguage(lang) {
  catalog = lang === "es" ? (await import("./messages/es.js")).default : en;
  language = lang;
  plurals = new Intl.PluralRules(locale());
  document.documentElement.lang = lang;
}

// Storage can throw (blocked site data, some sandboxed frames)
const read = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
const write = (lang) => { try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* the choice lasts for this page only */ } };

/** The language to start in, from the address, the device's choice and the browser's language. */
export function chooseLanguage(search = location.search, saved = read(), browser = navigator.languages) {
  const asked = new URLSearchParams(search).get("lang");
  if (asked && asked in LOCALES) { write(asked); return asked; }
  if (saved && saved in LOCALES) return saved;
  return (browser || []).map((tag) => String(tag).slice(0, 2).toLowerCase()).find((lang) => OFFERED.includes(lang)) || "en";
}

/** Saves the device's language (Account's switch) and speaks it. */
export async function chooseDeviceLanguage(lang) {
  write(lang);
  await setLanguage(lang);
}

/** The text for `key`, with `{name}` replaced from `vars`; a plural entry picks its form by `vars.count`. */
export function msg(key, vars = {}) {
  const entry = catalog[key] ?? en[key] ?? key;
  const text = typeof entry === "string" ? entry : entry[plurals.select(Number(vars.count))] ?? entry.other;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
}

/**
 * Sets the page's fixed text (src/index.html) from the catalog: an element's `data-i18n="key"` is its
 * text, and `data-i18n-<attribute>="key"` is that attribute (aria-label, title, placeholder).
 */
export function applyStatic(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = msg(el.dataset.i18n);
  for (const el of root.querySelectorAll("*")) {
    for (const { name, value } of [...el.attributes]) if (name.startsWith("data-i18n-")) el.setAttribute(name.slice("data-i18n-".length), msg(value));
  }
}

await setLanguage(chooseLanguage());

// Dates, times and numbers in the language's locale (supply-checkout-3ilj, step 3)
const SHORT = { month: "short", day: "numeric", year: "numeric" };
const LONG = { month: "long", day: "numeric", year: "numeric" };
const TIME = { hour: "numeric", minute: "2-digit" };

/** A date (an ISO string or a Date) as "Oct 7, 2026". `style`: "short" (default) or "long". */
export const dateText = (iso, style = "short") => new Date(iso).toLocaleDateString(locale(), style === "long" ? LONG : SHORT);
/** A calendar date (YYYY-MM-DD) as the same day wherever the reader is. */
export const calendarDateText = (ymd, style = "long") => new Date(`${ymd}T12:00:00Z`).toLocaleDateString(locale(), { ...(style === "long" ? LONG : SHORT), timeZone: "UTC" });
/** A date and time, "Oct 7, 2026, 3:04 PM"; `zone` adds the time zone's name. */
export const dateTimeText = (iso, { style = "short", zone = false, year = true } = {}) =>
  new Date(iso).toLocaleString(locale(), { ...(style === "long" ? LONG : SHORT), ...(year ? {} : { year: undefined }), ...TIME, ...(zone ? { timeZoneName: "short" } : {}) });
/** A whole number with the language's separators, "1,000". */
export const numberText = (n) => Number(n).toLocaleString(locale());
/** A month's name, 0 for January. */
export const monthName = (i) => {
  const name = new Date(2000, i, 1).toLocaleDateString(locale(), { month: "long" });
  return name.charAt(0).toUpperCase() + name.slice(1);
};
