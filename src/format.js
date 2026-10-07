// Formatting and small value helpers with no app state.
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd = new Intl.NumberFormat("en-US", {style:"currency", currency:"USD"});
export const money = n => usd.format(Number(n) || 0);
export const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
export const fmtDate = iso => { if (!iso) return ""; const [y,m,d] = iso.split("-").map(Number); return new Date(y, m-1, d).toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"}); };
// A barcode's product key: also its line's key in a project's items. "__proto__" gets an "x"
// like a dots-only key, because as a field name it would be the items map's prototype
// (the API refuses it). Other built-in names, like "constructor", are ordinary keys, so
// code that reads a line or product by key uses own() or a null-prototype map. Never a key
// ending in ":bought", which the API keeps for lines bought for a client (ADR 0017).
export const keyOf = code => { let k = String(code).trim().replace(/[^A-Za-z0-9_\-.~:@+]/g, "_").slice(0, 150).replace(/:bought$/, "_bought"); if (/^\.+$/.test(k) || k === "__proto__") k = "x" + k; return k; };
// obj[k] when it's obj's own property, not something inherited like Object.prototype.constructor
export const own = (obj, k) => Object.hasOwn(obj, k) ? obj[k] : undefined;
export const int = v => Math.max(0, Math.floor(Number(v) || 0));
export const codeText = c => c ? "Barcode " + c : "No barcode";
export const hasStock = p => p && typeof p.stock === "number";
// Company equipment (ADR 0017): reused, not charged, no client price; its value is its cost.
// Any other item (no kind, or "supply") is a supply, used up and charged at its price.
export const isEquipment = p => !!p && p.kind === "equipment";
// A product's cost each (ADR 0014): missing means unknown
export const hasCost = p => typeof p.cost === "number" && Number.isFinite(p.cost);
// What one each in storage is worth: its cost where known, its price otherwise
export const unitValue = p => hasCost(p) ? p.cost : Number(p.price) || 0;
export const newKey = () => "nb-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const uid = () => Math.random().toString(36).slice(2, 9);
// The largest price or cost the API takes, in dollars (ADR 0014; MAX_MONEY in backend/src/data/money.ts)
export const MAX_MONEY = 1000000;
// Rounds to cents, halves up (ADR 0014). toPrecision first, so 1.005 (really 1.00499…) is 1.01
export const round2 = n => Math.round(Number(((Number(n) || 0) * 100).toPrecision(12))) / 100;
export const numOrNull = n => (n === null || n === undefined || n === "" || isNaN(Number(n))) ? null : round2(n);
// A product's optional brand (supply-checkout-005.9), or "" for none. The longest the API
// takes is MAX_BRAND (MAX_BRAND_LENGTH in backend/src/data/brand.ts).
export const MAX_BRAND = 100;
export const brandOf = p => String(p.brand ?? "").trim();
// Text without the control and invisible characters the API refuses in an item's name and brand
// (supply-checkout-1dg.12): bidi controls, zero-width and tag characters, lone surrogates. Control
// characters and line separators become a space; the rest have no width and are removed. Kept: a
// joiner between two emoji (👩‍🔧), joiners in scripts that use them, a subdivision flag's tags.
// The rule and its reasons are backend/src/text/hidden-characters.ts, whose tests keep this in step.
const JOINING = ["Arabic", "Syriac", "Nko", "Mongolian", "Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala"].map(s => `\\p{sc=${s}}`).join("");
const HIDDEN = new RegExp(`(\\p{Extended_Pictographic}[\\p{Emoji_Modifier}\\uFE0F]?\\u200D(?=\\p{Extended_Pictographic})|[${JOINING}]\\p{M}*[\\u200C\\u200D](?=[${JOINING}])|\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F})|[\\p{Cc}\\u2028\\u2029\\p{Bidi_Control}\\u200B-\\u200D\\u2060-\\u2064\\uFEFF\\u{E0000}-\\u{E007F}\\uD800-\\uDFFF]`, "gu");
export const visibleText = t => String(t).replace(HIDDEN, (c, kept) => kept ?? (/^[\p{Cc}\u2028\u2029]$/u.test(c) ? " " : ""));
// Where an item's name has one line: its brand after it, "Trash bags · Glad"
export const nameWithBrand = p => [p.name, brandOf(p)].filter(Boolean).join(" · ");
// Where it has a line of its own under the name, in lists
export const brandHTML = p => { const b = brandOf(p); return b ? `<span class="item-brand">${esc(b)}</span>` : ""; };
