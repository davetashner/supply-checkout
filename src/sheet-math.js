import { int, round2 } from "./format.js";

// Money in whole cents (ADR 0014). toPrecision first, as in round2, so 100.49999… is 100.5
const cents = n => Math.round(Number((n * 100).toPrecision(12)));

/* ---------- math ---------- */
export function lines(sheet) {
  return Object.entries(sheet.items || {}).map(([key, it]) => ({ key, ...it }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
// Company equipment on loan (ADR 0017): its line says so, from the item when it was first taken.
// It's reused, so it isn't charged and unreturned isn't "used": it's still out, or lost.
export const isEquipmentLine = l => !!l && l.kind === "equipment";
// A line's counts as the sheet shows them (returned never above taken), and its price each in cents
export function lineCounts(l) {
  const o = int(l.out), r = Math.min(int(l.returned), o);
  return { o, r, u: o - r, p: round2(l.price) };
}
// An equipment line's counts: taken, returned, lost or broken, and still out
export function equipmentCounts(l) {
  const o = int(l.out), r = Math.min(int(l.returned), o), lost = Math.min(int(l.lost), o - r);
  return { o, r, lost, still: o - r - lost };
}
// What the client is charged for a supply's line: used × price each, in whole cents. Equipment
// on loan isn't charged, so it's never asked for one (totals and the CSVs leave it out).
export const lineCharge = l => { const { u, p } = lineCounts(l); return cents(u * p) / 100; };
// Totals add the rounded row charges, so the total always equals the sum of the rows. They count
// supplies only (and lines bought for the client); equipment on loan is apart, as `equipmentOut`.
export function totals(sheet) {
  let out = 0, ret = 0, used = 0, charge = 0, value = 0, count = 0, equipmentOut = 0;
  for (const l of lines(sheet)) {
    if (isEquipmentLine(l)) { equipmentOut += equipmentCounts(l).still; continue; }
    const { o, r, u, p } = lineCounts(l);
    out += o; ret += r; used += u; charge += cents(u * p); value += cents(o * p); count++;
  }
  return { out, ret, used, charge: charge / 100, value: value / 100, count, equipmentOut };
}
