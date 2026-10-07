import { int, round2 } from "./format.js";

// Money in whole cents (ADR 0014). toPrecision first, as in round2, so 100.49999… is 100.5
const cents = n => Math.round(Number((n * 100).toPrecision(12)));

/* ---------- math ---------- */
export function lines(project) {
  return Object.entries(project.items || {}).map(([key, it]) => ({ key, ...it }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
// Company equipment on loan (ADR 0017): its line says so, from the item when it was first taken.
// It's reused, so it isn't charged and unreturned isn't "used": it's still out, or lost.
export const isEquipmentLine = l => !!l && l.kind === "equipment";
// A line's name as the project and its CSV show it: equipment bought for the client says so
// (ADR 0017, section 2a). It's charged like a supply, with them.
export const lineLabel = l => `${l.name || "Unnamed item"}${l.purchased === true ? " (bought for this client)" : ""}`;
// A line's counts as the project shows them (returned never above taken), and its price each in cents
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
// Equipment lost or broken that the client is charged for (ADR 0017, section 3): a row of its
// own with the supplies, "<name> (lost or broken)", with how many in Used and the amount (for the
// lot, not each) in Charge, in the project's total and its CSV. Lost without a charge isn't one.
export const lostCharge = l => isEquipmentLine(l) ? cents(Math.max(0, Number(l.lostCharge) || 0)) / 100 : 0;
export function lostRows(project) {
  return lines(project).filter(l => lostCharge(l) > 0)
    .map(l => ({ key: l.key, name: `${l.name || "Unnamed item"} (lost or broken)`, code: l.code, used: equipmentCounts(l).lost, charge: lostCharge(l) }));
}
// Totals add the rounded row charges, so the total always equals the sum of the rows. They count
// supplies (and lines bought for the client) and charges for equipment lost or broken; equipment
// on loan is apart, as `equipmentOut`.
export function totals(project) {
  let out = 0, ret = 0, used = 0, charge = 0, value = 0, count = 0, equipmentOut = 0;
  for (const l of lines(project)) {
    if (isEquipmentLine(l)) {
      const c = equipmentCounts(l), lc = lostCharge(l);
      equipmentOut += c.still;
      if (lc > 0) { used += c.lost; charge += cents(lc); }
      continue;
    }
    const { o, r, u, p } = lineCounts(l);
    out += o; ret += r; used += u; charge += cents(u * p); value += cents(o * p); count++;
  }
  return { out, ret, used, charge: charge / 100, value: value / 100, count, equipmentOut };
}

// The team's General Use project (ADR 0017, section 4): what's taken for no job, with Quick take. It has
// no client, so it's shown as "General Use (no job)", and nothing on it is charged to anyone.
export const isAdhoc = s => !!s && s.kind === "adhoc";
export const projectTitle = s => isAdhoc(s) ? "General Use (no job)" : s.client || "Untitled";
// What's still out on a line: supplies not back, equipment neither back nor lost. A line bought
// for the client isn't coming back, so it's never out.
export const leftOut = l => l.purchased === true ? 0 : isEquipmentLine(l) ? equipmentCounts(l).still : lineCounts(l).u;
