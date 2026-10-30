// The "New" callout (supply-checkout-ihhe): a bordered box with a small "New" legend around a newly
// shipped feature, shown for the first NEW_DAYS local days a person opens the app after it ships, then
// plainly, and never more than CUTOFF_DAYS after it shipped (so someone back from a long break doesn't
// see an old "New"). Days are counted, not sign-ins: the app keeps people signed in. A day counts once
// however many times they open the app that day, and the count follows them to every device in /me's
// user.preferences.newFeatures ({ <feature ID>: { days, last } }, backend/src/data/preferences.ts), so
// another device the same day doesn't use up another day. Turning What's New off in Account turns these
// off too (they're the same kind of "look what's new" prompt).
//
// To mark a feature: add it to NEW_FEATURES, and draw its section with callout(id, html). The decision is
// made once, as the team opens (startNewFeatures), so nothing moves after the page has drawn, and the
// callout is plain static text: no live region, so a screen reader reads it where it is and never
// announces it again. Web build only, like the rest of src/aws/.
import { msg } from "../i18n.js";
import { localDay } from "./whats-new.js";

export const NEW_DAYS = 3;
export const CUTOFF_DAYS = 30;

// { id: lowercase words joined by hyphens, shipped: YYYY-MM-DD (the release's date), label: optional
// message key naming the feature in the legend ("New: <label>") }. Empty until a feature is marked.
export const NEW_FEATURES = [];

// Test seam: a test sets globalThis.__newFeatureSeam = { features: [...] } before the page loads to add
// features, and gets back `callout` and `shown` to draw one and see what was recorded.
const seam = () => globalThis.__newFeatureSeam;
const features = () => [...NEW_FEATURES, ...(seam()?.features ?? [])];

const shiftDay = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

// Which features are new today, given the stored state: the ids shown, the state to store (only
// the listed features', so retired ones drop out) and whether a new day was counted
export function decide(list, stored, today) {
  const shown = new Set();
  const next = {};
  let counted = false;
  for (const f of list) {
    const was = stored[f.id] ?? { days: 0, last: null };
    if (stored[f.id]) next[f.id] = was;
    if (today < f.shipped || today > shiftDay(f.shipped, CUTOFF_DAYS)) continue;
    if (was.last === today) shown.add(f.id);
    else if (was.days < NEW_DAYS) {
      next[f.id] = { days: was.days + 1, last: today };
      counted = true;
      shown.add(f.id);
    }
  }
  return { shown, next, counted };
}

let current = new Set();

// Decides which features are new today and records the day for each that is. `prefs` is /me's
// user.preferences (none from an API from before them, or with What's New off: nothing is new).
export function startNewFeatures(api, prefs) {
  current = new Set();
  const list = features();
  if (!prefs || !prefs.whatsNew || !prefs.newFeatures || !list.length) return;
  const { shown, next, counted } = decide(list, prefs.newFeatures, localDay());
  current = shown;
  prefs.newFeatures = next;
  if (counted) api("PATCH", "/me/preferences", { newFeatures: next }).catch(() => {});
}

// Stops marking anything new (Account turned What's New off): sections drawn from now on are plain
export const stopNewFeatures = () => { current = new Set(); };

export const isNew = (id) => current.has(id);

// `html` wrapped in the callout if the feature is new today, else as it is
export function callout(id, html) {
  if (!isNew(id)) return html;
  const f = features().find((x) => x.id === id);
  const label = f.label ? `: ${msg(f.label)}` : "";
  return `<div class="new-callout" data-new-feature="${id}"><span class="new-callout-tag">${msg("newFeature.tag")}${label}</span>${html}</div>`;
}

if (seam()) Object.assign(seam(), { callout, isNew });
