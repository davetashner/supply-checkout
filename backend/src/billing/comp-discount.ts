// A comp's Stripe discount (supply-checkout-6e4b, ADR 0015 amendment,
// docs/infrastructure.md "Operators").
//
// A comp (data/operator.ts, setComp) only changes access in the app: a team
// paying through Stripe would keep being charged while comped. A comp made
// with `months` (`npm run ops -- comp <teamId> --months N`) also records
// `compMonths`, and while it's live, the team's subscription gets a 100%-off
// coupon, duration `repeating`, `duration_in_months` N, so its next N months
// of invoices are $0 and billing resumes by itself after them, with the same
// subscription and card. Ending the comp (or replacing it with one made with
// `until`) removes the discount.
//
// Who calls Stripe, and why here (least privilege). The ops function holds
// only a restricted key with Subscriptions: Read and Invoices: Read, and its
// role can only write comp attributes. So it doesn't call Stripe for this:
// after every comp change it queues a message with reason `comp` on the seat
// sync queue (to which it could already send) for the team's Stripe customer,
// from the team's index entry. The billing worker, which already holds the
// Stripe secret key and already updates subscriptions, takes it and makes the
// subscription match the team's comp (reconcileCompDiscount). The message
// names only the customer; the worker finds the team from our own link and
// reads its comp from the team's own item, so neither an operator nor a
// forged message can choose what discount a subscription gets: only the
// comp on the customer's own team decides, and a reconcile only ever moves
// the subscription to it. The nightly reconciliation runs the same reconcile
// for every open team with a Stripe customer, so a message that couldn't be
// queued or failed for good is put right within a day.
//
// What "match" means:
// - Wanted: a live comp with `compMonths`, on a subscription that's live (not
//   ended, not incomplete) and billed monthly. A coupon applies to every
//   invoice in its months, so on a yearly price a renewal in that window
//   would be a whole year free: a yearly subscription never gets one (and
//   loses ours if it was switched to yearly), and the outcome says so.
// - Then the subscription carries exactly one discount from our comp coupons,
//   compCouponId(N), with the comp's end stamped in its metadata
//   (COMP_UNTIL_METADATA): so a comp changed or extended later (a new end)
//   replaces the discount, starting its N months again from now.
// - Otherwise: no discount from our comp coupons, and no stamp.
// Discounts that aren't ours (a promotion code, later) are always kept.
//
// The coupons. One per length, compCouponId(1..12), with a fixed ID: created
// by the worker the first time it needs one (with an idempotency key, and an
// existing one is used), and checked before use (100% off, repeating, the
// right months, still valid), so one edited or replaced by hand is refused,
// not applied. Coupons are shared, so nothing is left behind per team:
// removing a discount, or Stripe ending it after its months, or the purge
// deleting the team's customer, leaves only the 12 coupons.
//
// Idempotency. Each subscription update carries a Stripe idempotency key
// hashed from the team, the subscription, what it does, the comp's end and
// the discounts it found, so a retry of the same message (or a second
// message for the same comp) sends Stripe the same request; and once Stripe
// has it, the reconcile finds the subscription in step and sends nothing. So
// a retried comp request applies one coupon.
//
// Failures. A Stripe or DynamoDB failure throws: the message is retried
// (BILLING_MAX_RECEIVES times), then goes to the seat sync dead-letter queue,
// whose "Seat syncs stuck" alarm brings a person; the next night's reconcile
// tries again anyway.
//
// Every outcome of a `comp` message is in the operator audit
// (`ops.comp.discount`, data/billing.ts recordCompDiscount), and so is every
// change the nightly reconcile makes.
//
// Webhooks: changing a subscription's discounts sends
// `customer.subscription.updated`, which the worker applies like any other:
// status, plan, seats and interval don't change, so neither do the team's
// entitlements; `invoice.paid` for a $0 invoice is a paid invoice. The
// `customer.discount.*` events aren't subscribed to: nothing in the team's
// record depends on a discount. The nightly entitlement check compares status,
// plan, seats and cancellation only, so a discounted subscription is never
// drift.
//
// Logged: team, subscription and message IDs, outcomes and coupon IDs. Never
// a name, an email or the Stripe key.

import { createHash } from "node:crypto";
import type { BillingTeam } from "../data/index.js";
import { hasEnded } from "../data/index.js";

/** The prefix of our comp coupons' IDs: only discounts from these are ever removed or replaced. */
export const COMP_COUPON_PREFIX = "supply-checkout-comp-";
/** The subscription metadata key that holds the end of the comp its discount is for. */
export const COMP_UNTIL_METADATA = "supply_checkout_comp_until";
/** The most months a comp's discount lasts: a comp's own limit (MAX_COMP_MONTHS in data/operator.ts). */
export const MAX_COMP_DISCOUNT_MONTHS = 12;

/** Our comp coupon for `months` months. */
export function compCouponId(months: number): string {
  if (!Number.isInteger(months) || months < 1 || months > MAX_COMP_DISCOUNT_MONTHS) throw new Error("A comp discount lasts 1 to 12 months");
  return `${COMP_COUPON_PREFIX}${months}m`;
}

/** The fields of a Stripe coupon the reconcile checks. */
export interface CouponLike {
  readonly id: string;
  readonly percent_off: number | null;
  readonly amount_off?: number | null;
  readonly duration: string;
  readonly duration_in_months: number | null;
  readonly valid: boolean;
  readonly applies_to?: unknown;
}

/** A discount on a subscription, expanded (`expand: ["discounts"]`). */
export interface DiscountLike {
  readonly id: string;
  readonly source?: { readonly coupon?: string | { readonly id: string } | null } | null;
  /** When it ends (epoch seconds), for a repeating coupon. */
  readonly end?: number | null;
}

/** The fields of a Stripe subscription the reconcile reads. */
export interface CompSubscriptionLike {
  readonly id: string;
  readonly customer: string | { readonly id: string };
  readonly status: string;
  readonly metadata?: Readonly<Record<string, string>> | null;
  readonly discounts?: readonly (string | DiscountLike)[] | null;
  readonly items: { readonly data: readonly { readonly price: { readonly recurring: { readonly interval: string } | null } }[] };
}

/** What the reconcile needs from the Stripe client. */
export interface CompDiscountStripe {
  readonly subscriptions: {
    retrieve(id: string, params: { expand: string[] }): PromiseLike<CompSubscriptionLike>;
    update(
      id: string,
      params: { discounts: { coupon?: string; discount?: string }[] | ""; metadata: Record<string, string> },
      options: { idempotencyKey: string },
    ): PromiseLike<unknown>;
  };
  readonly coupons: {
    retrieve(id: string): PromiseLike<CouponLike>;
    create(
      params: { id: string; percent_off: number; duration: "repeating"; duration_in_months: number; name: string; metadata: Record<string, string> },
      options: { idempotencyKey: string },
    ): PromiseLike<CouponLike>;
  };
}

/** What a reconcile did. */
export type CompDiscountOutcome =
  /** Our discount was put on (or replaced, for a changed comp). */
  | "applied"
  /** Our discount was taken off: no live comp with months, or (for a comp with months) a subscription that isn't monthly. */
  | "removed"
  /** It already matched the comp: nothing sent. */
  | "in_sync"
  /** No discount wanted and none there. */
  | "none"
  /** A comp with months, but the subscription is billed yearly (or not monthly): no discount (see the top). */
  | "not_monthly"
  /** The team has no subscription, or it has ended or not started: nothing to discount. */
  | "no_subscription"
  /** The subscription isn't the customer's. */
  | "not_ours";

const idOf = (value: string | { readonly id: string }) => (typeof value === "string" ? value : value.id);
const couponOf = (discount: DiscountLike): string | undefined => {
  const coupon = discount.source?.coupon;
  return coupon ? idOf(coupon) : undefined;
};
const isOurs = (discount: DiscountLike) => couponOf(discount)?.startsWith(COMP_COUPON_PREFIX) === true;

/** The comp discount a team wants: our coupon and the comp's end, for a live comp made with months; otherwise none. */
export function wantedCompDiscount(team: Pick<BillingTeam, "compLive" | "compMonths" | "compUntil">): { readonly coupon: string; readonly until: string } | undefined {
  const months = team.compMonths;
  if (!team.compLive || !team.compUntil || typeof months !== "number" || !Number.isInteger(months) || months < 1 || months > MAX_COMP_DISCOUNT_MONTHS) return undefined;
  return { coupon: compCouponId(months), until: team.compUntil };
}

/** Whether every item on the subscription is billed monthly. */
const monthly = (sub: CompSubscriptionLike) => sub.items.data.length > 0 && sub.items.data.every((item) => item.price.recurring?.interval === "month");

/** The Stripe idempotency key for one subscription update. */
export function compDiscountKey(teamId: string, subscriptionId: string, action: "apply" | "remove", until: string | null, found: readonly string[]): string {
  return `comp-${action}-${createHash("sha256").update(JSON.stringify([teamId, subscriptionId, until, [...found].sort()])).digest("hex")}`;
}

/**
 * Our coupon for `months`, created if Stripe doesn't have it yet, and checked:
 * 100% off, repeating for those months, valid, for every product. Throws for
 * one that isn't (edited or replaced by hand), so it's never applied.
 */
export async function ensureCompCoupon(stripe: CompDiscountStripe, months: number): Promise<string> {
  const id = compCouponId(months);
  let coupon: CouponLike;
  try {
    coupon = await stripe.coupons.retrieve(id);
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "resource_missing") throw error;
    coupon = await stripe.coupons.create(
      { id, percent_off: 100, duration: "repeating", duration_in_months: months, name: `Supply Checkout comp, ${months} month${months === 1 ? "" : "s"} free`, metadata: { supply_checkout: "comp" } },
      { idempotencyKey: `comp-coupon-${id}` },
    );
  }
  const ok = coupon.id === id && coupon.percent_off === 100 && !coupon.amount_off && coupon.duration === "repeating" && coupon.duration_in_months === months && coupon.valid && !coupon.applies_to;
  if (!ok) throw Object.assign(new Error(`Stripe coupon ${id} isn't a ${months}-month 100% comp coupon`), { name: "CompCouponMismatch" });
  return id;
}

/** What reconcileCompDiscount found and did, for the audit and the log. */
export interface CompDiscountResult {
  readonly outcome: CompDiscountOutcome;
  readonly subscriptionId: string | null;
  /** Our coupon on the subscription before, if any. */
  readonly before: string | null;
  /** Our coupon on it after, and the comp's end it's for, if any. */
  readonly coupon: string | null;
  readonly until: string | null;
}

/**
 * Makes the team's subscription carry the discount its comp wants (see the
 * top), and nothing else of ours. `team` is the team as the worker read it,
 * from our own link for `customer`; the caller has checked it's open and its
 * customer is `customer`. Throws on a Stripe failure, for the message to be
 * retried.
 */
export async function reconcileCompDiscount(stripe: CompDiscountStripe, team: BillingTeam, customer: string): Promise<CompDiscountResult> {
  const none = (outcome: CompDiscountOutcome): CompDiscountResult => ({ outcome, subscriptionId: team.stripeSubscriptionId ?? null, before: null, coupon: null, until: null });
  if (!team.stripeSubscriptionId) return none("no_subscription");
  const sub = await stripe.subscriptions.retrieve(team.stripeSubscriptionId, { expand: ["discounts"] });
  if (idOf(sub.customer) !== customer) return none("not_ours");
  if (hasEnded(sub.status) || sub.status === "incomplete") return none("no_subscription");
  const discounts = (sub.discounts ?? []).filter((d): d is DiscountLike => typeof d === "object" && d !== null);
  // Unexpanded IDs would mean the expand didn't happen: then we can't tell ours apart, so change nothing
  if (discounts.length !== (sub.discounts ?? []).length) throw Object.assign(new Error("Subscription discounts weren't expanded"), { name: "DiscountsNotExpanded" });
  const ours = discounts.filter(isOurs);
  const others = discounts.filter((d) => !isOurs(d));
  const stamp = sub.metadata?.[COMP_UNTIL_METADATA] || undefined;
  const before = ours.length ? (couponOf(ours[0] as DiscountLike) ?? null) : null;
  const found = discounts.map((d) => d.id);
  const wanted = wantedCompDiscount(team);
  const base = { subscriptionId: sub.id, before };

  if (wanted && monthly(sub)) {
    if (ours.length === 1 && before === wanted.coupon && stamp === wanted.until) return { ...base, outcome: "in_sync", coupon: wanted.coupon, until: wanted.until };
    const coupon = await ensureCompCoupon(stripe, team.compMonths as number);
    await stripe.subscriptions.update(
      sub.id,
      { discounts: [...others.map((d) => ({ discount: d.id })), { coupon }], metadata: { [COMP_UNTIL_METADATA]: wanted.until } },
      { idempotencyKey: compDiscountKey(team.teamId, sub.id, "apply", wanted.until, found) },
    );
    return { ...base, outcome: "applied", coupon, until: wanted.until };
  }
  // A stamp left after Stripe ended our discount by itself (its months were up) is harmless: the next discount replaces it
  if (!ours.length) return { ...base, outcome: wanted ? "not_monthly" : "none", coupon: null, until: null };
  await stripe.subscriptions.update(
    sub.id,
    // An empty string clears the discounts; an empty array would leave them as they are
    { discounts: others.length ? others.map((d) => ({ discount: d.id })) : "", metadata: { [COMP_UNTIL_METADATA]: "" } },
    { idempotencyKey: compDiscountKey(team.teamId, sub.id, "remove", stamp ?? null, found) },
  );
  return { ...base, outcome: "removed", coupon: null, until: null };
}
