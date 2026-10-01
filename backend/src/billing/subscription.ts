// A Stripe subscription as the billing worker reads it, and our view of it:
// what applySubscription writes to the team (ADR 0009). Shared by the event
// path (worker.ts) and the nightly entitlement check (entitlements.ts).

import type { SubscriptionState } from "../data/index.js";
import { planForLookupKey } from "./catalog.js";

/** The fields of a Stripe subscription the worker reads. */
export interface SubscriptionLike {
  readonly id: string;
  readonly customer: string | { readonly id: string };
  readonly status: string;
  /** When it was created (epoch seconds). */
  readonly created?: number;
  readonly cancel_at_period_end: boolean;
  /** When it's set to cancel, if it is: set with `cancel_at_period_end`, or alone (a cancellation Stripe schedules by date). */
  readonly cancel_at?: number | null;
  /** When it was last set to cancel (epoch seconds): for `cancel_at_period_end`, Stripe's time of the latest request that set it (closing.ts, resumeAction). */
  readonly canceled_at?: number | null;
  /** Its metadata: a closure stamps CLOSED_AT_METADATA when it sets it to cancel (closing.ts). */
  readonly metadata?: Readonly<Record<string, string>> | null;
  readonly trial_end: number | null;
  readonly default_payment_method: string | { readonly id: string } | null;
  readonly items: {
    readonly data: readonly {
      readonly quantity?: number;
      /** When the period began: the purge warns of one that began after the team closed (a renewal to refund). */
      readonly current_period_start?: number;
      readonly current_period_end: number;
      readonly price: { readonly lookup_key: string | null; readonly recurring: { readonly interval: string } | null };
    }[];
  };
}

/** Epoch seconds as an ISO date, or undefined for anything else. */
export const iso = (seconds: number | null | undefined) => (typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined);

/** Our view of a subscription: what applySubscription writes. */
export function subscriptionState(sub: SubscriptionLike, customerId: string, replaces?: string): SubscriptionState {
  const items = sub.items.data;
  const first = items[0];
  const known = planForLookupKey(first?.price.lookup_key);
  const end = first ? iso(first.current_period_end) : undefined;
  return {
    customerId,
    subscriptionId: sub.id,
    ...(replaces !== undefined ? { replaces } : {}),
    ...(known ? { plan: known.plan, interval: known.interval } : {}),
    seats: items.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
    status: sub.status,
    ...(end !== undefined ? { currentPeriodEnd: end } : {}),
    // Canceled in the Customer Portal (at the period's end), or set to cancel on a date: either way it won't renew
    cancelAtPeriodEnd: sub.cancel_at_period_end || typeof sub.cancel_at === "number",
  };
}
