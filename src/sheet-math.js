import { int } from "./format.js";

/* ---------- math ---------- */
export function lines(sheet) {
  return Object.entries(sheet.items || {}).map(([key, it]) => ({ key, ...it }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
export function totals(sheet) {
  let out = 0, ret = 0, used = 0, charge = 0, value = 0;
  for (const l of lines(sheet)) {
    const o = int(l.out), r = Math.min(int(l.returned), o), u = o - r, p = Number(l.price) || 0;
    out += o; ret += r; used += u; charge += u * p; value += o * p;
  }
  return { out, ret, used, charge, value, count: Object.keys(sheet.items || {}).length };
}
