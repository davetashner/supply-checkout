// Exports: one sheet as CSV, and all of a team's data as CSV or JSON. Built from the
// documents the app already holds and shows (both collections are loaded in full to draw
// the lists), with the same math and labels as the screens, so an export matches them.
import { hasStock } from "./format.js";
import { lines, lineCounts, lineCharge, totals } from "./sheet-math.js";

// One CSV cell. Text that a spreadsheet would run as a formula (=, +, -, @, tab or return
// first) gets a leading apostrophe, so a name a team member typed can't run in the
// owner's spreadsheet. Numbers are written as they are.
export function cell(v) {
  if (typeof v === "number") return String(v);
  let t = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
export const toCsv = rows => rows.map(r => r.map(cell).join(",")).join("\n");

const statusText = s => s.status === "closed" ? "Returned" : "Checked out";
const fixed = n => (Number(n) || 0).toFixed(2);

// One sheet, as its "Download CSV" button saves it
export function sheetCsv(s, preparedBy) {
  const t = totals(s);
  return toCsv([
    ["Client", s.client], ["Date", s.date], ["Prepared by", preparedBy], ["Status", statusText(s)], [],
    ["Item", "Barcode", "Price each", "Taken", "Returned", "Used", "Charge"],
    ...lines(s).map(l => { const { o, r, u, p } = lineCounts(l); return [l.name, l.code || "", fixed(p), o, r, u, fixed(lineCharge(l))]; }),
    ["Total", "", "", t.out, t.ret, t.used, fixed(t.charge)],
  ]);
}

// Every sheet, one row per item, in the list's order. A sheet with no items gets one row.
export function sheetsCsv(sheets, preparedBy) {
  const rows = [["Client", "Date", "Prepared by", "Status", "Item", "Barcode", "Price each", "Taken", "Returned", "Used", "Charge", "Sheet ID"]];
  for (const s of sheets) {
    const head = [s.client || "Untitled", s.date || "", preparedBy(s), statusText(s)];
    const ls = lines(s);
    if (!ls.length) rows.push([...head, "", "", "", "", "", "", "", s.id]);
    for (const l of ls) { const { o, r, u, p } = lineCounts(l); rows.push([...head, l.name || "Unnamed item", l.code || "", fixed(p), o, r, u, fixed(lineCharge(l)), s.id]); }
  }
  return toCsv(rows);
}

const byName = products => Object.entries(products).map(([key, p]) => ({ key, ...p })).sort((a, b) => String(a.name).localeCompare(String(b.name)));

// The inventory, as the Inventory tab lists it. Items nobody has counted have no count or value.
export function inventoryCsv(products) {
  return toCsv([
    ["Item", "Barcode", "In storage", "Price each", "Value"],
    ...byName(products).map(p => {
      const counted = hasStock(p);
      return [p.name || "Unnamed item", p.code || "", counted ? p.stock : "", fixed(p.price), counted ? fixed(p.stock * (Number(p.price) || 0)) : ""];
    }),
  ]);
}

// A document without the artifact build's marks of recent saves (`ops` on lines and items,
// src/moves.js; `savedReceipts` on sheets from before them), which only guard retries
const unmarked = doc => { const copy = { ...doc }; delete copy.ops; delete copy.savedReceipts; return copy; };
const unmarkedItems = items => Object.fromEntries(Object.entries(items).map(([k, it]) => [k, unmarked(it)]));

// Everything, for a backup or another tool: each document as stored (without those marks),
// plus each sheet's totals and who prepared it, as the app shows them
export function allJson(products, sheets, preparedBy, now = new Date()) {
  return JSON.stringify({
    app: "Supply Checkout",
    exportedAt: now.toISOString(),
    sheets: sheets.map(s => {
      const t = totals(s), doc = unmarked(s);
      if (s.items) doc.items = unmarkedItems(s.items);
      return { ...doc, preparedBy: preparedBy(s), totals: { taken: t.out, returned: t.ret, used: t.used, charge: Number(fixed(t.charge)) } };
    }),
    inventory: byName(products).map(unmarked),
  }, null, 2);
}
