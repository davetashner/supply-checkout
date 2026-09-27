// Formatting and small value helpers with no app state.
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd = new Intl.NumberFormat("en-US", {style:"currency", currency:"USD"});
export const money = n => usd.format(Number(n) || 0);
export const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
export const fmtDate = iso => { if (!iso) return ""; const [y,m,d] = iso.split("-").map(Number); return new Date(y, m-1, d).toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"}); };
// A barcode's product key: also its line's key in a sheet's items. "__proto__" gets an "x"
// like a dots-only key, because as a field name it would be the items map's prototype
// (the API refuses it). Other built-in names, like "constructor", are ordinary keys, so
// code that reads a line or product by key uses own() or a null-prototype map.
export const keyOf = code => { let k = String(code).trim().replace(/[^A-Za-z0-9_\-.~:@+]/g, "_").slice(0, 150); if (/^\.+$/.test(k) || k === "__proto__") k = "x" + k; return k; };
// obj[k] when it's obj's own property, not something inherited like Object.prototype.constructor
export const own = (obj, k) => Object.hasOwn(obj, k) ? obj[k] : undefined;
export const int = v => Math.max(0, Math.floor(Number(v) || 0));
export const codeText = c => c ? "Barcode " + c : "No barcode";
export const hasStock = p => p && typeof p.stock === "number";
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
