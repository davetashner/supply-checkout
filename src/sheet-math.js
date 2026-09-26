import { int, round2 } from "./format.js";

// Money in whole cents (ADR 0014). toPrecision first, as in round2, so 100.49999… is 100.5
const cents = n => Math.round(Number((n * 100).toPrecision(12)));

/* ---------- math ---------- */
export function lines(sheet) {
  return Object.entries(sheet.items || {}).map(([key, it]) => ({ key, ...it }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
// A line's counts as the sheet shows them (returned never above taken), and its price each in cents
export function lineCounts(l) {
  const o = int(l.out), r = Math.min(int(l.returned), o);
  return { o, r, u: o - r, p: round2(l.price) };
}
// What the client is charged for a line: used × price each, in whole cents
export const lineCharge = l => { const { u, p } = lineCounts(l); return cents(u * p) / 100; };
// Totals add the rounded row charges, so the total always equals the sum of the rows
export function totals(sheet) {
  let out = 0, ret = 0, used = 0, charge = 0, value = 0;
  for (const l of lines(sheet)) {
    const { o, r, u, p } = lineCounts(l);
    out += o; ret += r; used += u; charge += cents(u * p); value += cents(o * p);
  }
  return { out, ret, used, charge: charge / 100, value: value / 100, count: Object.keys(sheet.items || {}).length };
}
