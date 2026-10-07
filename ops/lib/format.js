// What the page shows, as plain strings (supply-checkout-gxlt). main.js puts every one of them
// in the page with textContent, never as HTML. Mirrors scripts/ops.mjs's output.

export const MAX_COMP_MONTHS = 12;
const PLAN = /^[a-z][a-z0-9_-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
// Control characters, which the API refuses in a reason
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MEMBERS_PER_TEAM = 100;

export class InputError extends Error {}

export const date = (iso) => (typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "-");
export const text = (value) => (value === undefined || value === null || value === "" ? "-" : String(value));

/** An amount in a currency's minor units: `27.00 USD`. */
export const money = (amount, currency) => (Number.isFinite(amount) ? `${(amount / 100).toFixed(2)} ${String(currency ?? "").toUpperCase()}` : "-");

/** "N months left" (whole months, rounded down), "less than a month left", or "" for no date. */
export function monthsLeft(until, now) {
  const end = Date.parse(until);
  if (!Number.isFinite(end)) return "";
  const at = new Date(now);
  const endDate = new Date(end);
  let months = (endDate.getUTCFullYear() - at.getUTCFullYear()) * 12 + (endDate.getUTCMonth() - at.getUTCMonth());
  const shifted = new Date(at);
  shifted.setUTCMonth(at.getUTCMonth() + months);
  if (shifted.getTime() > end) months--;
  return months < 1 ? "less than a month left" : `${months} month${months === 1 ? "" : "s"} left`;
}

/** One line for a team's comp, or "No comp". */
export function compLine(comp, now) {
  if (!comp) return "No comp";
  const seats = comp.seats ? ` (${comp.seats} seats)` : "";
  const state = comp.live ? `, ${monthsLeft(comp.until, now)}` : " (ended)";
  return `${comp.plan}${seats} until ${date(comp.until)}${state}`;
}

/** A team as one row of the list. */
export function teamRow(team, now) {
  return {
    id: text(team.id),
    name: text(team.name),
    // A test team (the prod journey tests'): shown as a badge, nothing more
    test: team.test === true,
    plan: `${text(team.plan)} / ${text(team.status)}${team.closedAt ? ` (closed ${date(team.closedAt)})` : ""}`,
    comp: team.comp ? compLine(team.comp, now) : "",
    owners: (Array.isArray(team.owners) ? team.owners : []).map((o) => text(o?.email ?? o?.userId)).join(", "),
    created: date(team.createdAt),
  };
}

/** The team's record as label/value pairs. */
export function teamFacts(team, now) {
  return [
    ["Team ID", text(team.id)],
    ...(team.test === true ? [["Test team", "Yes: made by the prod journey tests, and left out of customer metrics. It's billed and limited like any team."]] : []),
    ["Plan", text(team.plan)],
    ["Status", `${text(team.status)}${team.closedAt ? `, closed ${team.closedAt} (read-only until it's deleted)` : ""}`],
    ["Seats", text(team.seats)],
    ["Owners", text(team.ownerCount)],
    ["Created", text(team.createdAt)],
    ...(team.trialEndsAt ? [["Trial ends", text(team.trialEndsAt)]] : []),
    ["Stripe customer", text(team.stripeCustomerId ?? "none")],
    ["Comp", compLine(team.comp, now)],
    ...(team.comp ? [["Comp reason", text(team.comp.reason)]] : []),
    ["Version", text(team.version)],
  ];
}

/** The Stripe part of a team's detail: a summary, and the comp discount's state. */
export function stripeFacts(stripe) {
  if (!stripe) return { summary: "No Stripe customer", discount: "", invoices: [], notes: [] };
  if (stripe.error) return { summary: `Stripe: ${text(stripe.error)} (the record above is current; try again later)`, discount: "", invoices: [], notes: [] };
  const s = stripe.subscription;
  const summary = s
    ? [
        `Subscription ${text(s.id)}: ${text(s.status)}`,
        s.plan ? `${s.plan}/${text(s.interval)} (${text(s.lookupKey)})` : "unknown price",
        `${text(s.seats)} seats`,
        ...(s.currentPeriodEnd ? [`period ends ${date(s.currentPeriodEnd)}`] : []),
        ...(s.cancelAtPeriodEnd ? ["cancels at period end"] : s.cancelAt ? [`cancels on ${date(s.cancelAt)}`] : []),
        ...(s.trialEnd ? [`trial ends ${date(s.trialEnd)}`] : []),
      ].join(", ")
    : "No subscription";
  const discount = s?.compDiscountUntil
    ? `Comp discount: invoices $0 until about ${date(s.compDiscountUntil)}, then billing resumes`
    : s?.discountCount
      ? `${s.discountCount} discount${s.discountCount === 1 ? "" : "s"} on the subscription (not a comp's)`
      : "No comp discount";
  const invoices = (Array.isArray(stripe.invoices) ? stripe.invoices : []).map((i) => ({
    number: text(i.number ?? i.id),
    status: text(i.status),
    total: money(i.total, i.currency),
    created: date(i.createdAt),
  }));
  const notes = [
    ...(stripe.subscriptionCount > 1 ? [`${stripe.subscriptionCount} subscriptions for this customer: check for a duplicate`] : []),
    ...(stripe.hasMoreInvoices ? ["Older invoices are in Stripe"] : []),
  ];
  return { summary, discount, invoices, notes };
}

/** A dollar estimate: to the cent, or "<$0.01". */
export const usd = (n) => (!Number.isFinite(n) ? "-" : n > 0 && n < 0.005 ? "<$0.01" : `$${n.toFixed(2)}`);

export function receiptLines(receipts) {
  if (receipts === null) return ["Receipts: unavailable (try again later)"];
  if (!receipts) return [];
  return [
    `Receipts in its trial: ${text(receipts.trialReceipts)}`,
    ...(Array.isArray(receipts.months) ? receipts.months : []).map((m) => `Receipts ${text(m.month)}: ${text(m.receipts)}, est. ${usd(m.estimatedCostUsd)}`),
  ];
}

/** What changed, for one audit event. */
export function auditChange(e) {
  const after = e.after && typeof e.after === "object" ? e.after : null;
  if (e.action === "ops.comp.discount" && after) return `Stripe discount: ${text(after.outcome)}${after.coupon ? ` (${after.coupon} until ${date(after.until)})` : ""}`;
  if (e.action === "ops.import.clear" && after) return `import ${text(after.importId)}`;
  if (e.action === "ops.receipts.usage" && after) return `receipts ${text(after.month)}, ${Array.isArray(after.teams) ? after.teams.length : 0} teams`;
  if (e.action === "ops.team.reopen") return `closed ${text(e.before?.closedAt)} -> open`;
  if (after && after.plan) return `-> ${after.plan} until ${date(after.until)}${after.months ? ` (${after.months} months)` : ""}`;
  if (e.action === "ops.comp.end") return "-> none";
  return "";
}

export function auditRow(e) {
  return {
    ts: text(e.ts),
    action: text(e.action),
    teamId: text(e.teamId),
    by: text(e.operatorSub),
    change: auditChange(e),
    reason: e.reason ? String(e.reason) : "",
  };
}

/** A write's reason: 3 to 500 characters on one line, as the API requires. */
export function checkReason(value) {
  const reason = String(value ?? "").trim();
  if (reason.length < 3) throw new InputError("Give a reason (at least 3 characters)");
  if (reason.length > 500 || CONTROL.test(reason)) throw new InputError("The reason must be at most 500 characters, on one line");
  return reason;
}

/**
 * The PUT /ops/teams/{id}/comp body from the form: { mode: "months" | "until", months, until,
 * plan, seats, reason }, for the team as read (its plan by default, and its version).
 */
export function compBody(form, team, now = Date.now()) {
  const reason = checkReason(form.reason);
  const plan = String(form.plan ?? "").trim() || team.plan;
  if (typeof plan !== "string" || !PLAN.test(plan)) throw new InputError("The plan is a plan name: lowercase letters, digits, - or _");
  let seats;
  if (String(form.seats ?? "").trim() !== "") {
    seats = Number(form.seats);
    if (!Number.isInteger(seats) || seats < 1 || seats > MEMBERS_PER_TEAM) throw new InputError(`Seats must be a whole number from 1 to ${MEMBERS_PER_TEAM}`);
  }
  const body = { plan };
  if (form.mode === "months") {
    const months = Number(form.months);
    if (!Number.isInteger(months) || months < 1 || months > MAX_COMP_MONTHS) throw new InputError(`Months must be a whole number from 1 to ${MAX_COMP_MONTHS}`);
    body.months = months;
  } else if (form.mode === "until") {
    const until = String(form.until ?? "");
    if (!DATE.test(until) || !Number.isFinite(Date.parse(`${until}T00:00:00Z`))) throw new InputError("Pick the date the comp ends");
    if (Date.parse(`${until}T00:00:00Z`) <= now) throw new InputError("The end date must be in the future");
    body.until = until;
  } else {
    throw new InputError("Choose months or an end date");
  }
  if (seats !== undefined) body.seats = seats;
  return { ...body, reason, expectedVersion: team.version };
}

/** The DELETE /ops/teams/{id}/comp body. */
export function endCompBody(form, team) {
  return { reason: checkReason(form.reason), expectedVersion: team.version };
}

export const checkMonth = (value) => {
  const month = String(value ?? "").trim();
  if (month && !MONTH.test(month)) throw new InputError("The month is YYYY-MM");
  return month || undefined;
};

/**
 * Idempotency keys for writes. A request that got no answer at all may be sent again with the
 * same key, so it's applied once; any answer, or a different request, gets a new key.
 */
export function idempotencyKeys(randomUUID = () => globalThis.crypto.randomUUID()) {
  let last = null;
  return {
    keyFor(request) {
      const fingerprint = JSON.stringify(request);
      if (last?.fingerprint !== fingerprint) last = { fingerprint, key: randomUUID() };
      return last.key;
    },
    /** After any answer from the API. */
    answered() {
      last = null;
    },
  };
}

/** What to tell the operator about the Stripe side of a comp change. */
export const DISCOUNT_OUTCOMES = {
  queued: "Stripe: the billing worker is making the subscription's discount match (open the team again in a minute).",
  no_stripe_customer: "Stripe: no customer, so nothing to discount.",
  not_queued: "Stripe: the discount couldn't be queued now; the nightly reconciliation will make it match.",
};
