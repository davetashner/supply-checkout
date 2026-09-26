// Formatting and small value helpers with no app state.
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const usd = new Intl.NumberFormat("en-US", {style:"currency", currency:"USD"});
export const money = n => usd.format(Number(n) || 0);
export const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); };
export const fmtDate = iso => { if (!iso) return ""; const [y,m,d] = iso.split("-").map(Number); return new Date(y, m-1, d).toLocaleDateString("en-US", {month:"short", day:"numeric", year:"numeric"}); };
export const keyOf = code => { let k = String(code).trim().replace(/[^A-Za-z0-9_\-.~:@+]/g, "_").slice(0, 150); if (/^\.+$/.test(k)) k = "x" + k; return k; };
export const int = v => Math.max(0, Math.floor(Number(v) || 0));
export const codeText = c => c ? "Barcode " + c : "No barcode";
export const hasStock = p => p && typeof p.stock === "number";
export const newKey = () => "nb-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const uid = () => Math.random().toString(36).slice(2, 9);
export const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
export const numOrNull = n => (n === null || n === undefined || n === "" || isNaN(Number(n))) ? null : round2(n);
