// Money and quantity rules from ADR 0014.
//
// - Money is dollars as a JSON number: finite, 0 to MAX_MONEY, with at most
//   two decimals. The server rejects anything else rather than rounding it,
//   so it never stores a number the person didn't see.
// - Quantities are whole eaches.

import { InvalidInputError } from "./errors.js";

/** The largest price or cost the server accepts, in dollars. */
export const MAX_MONEY = 1_000_000;

/** The largest quantity one command moves: a guard against a typo like 10000000. */
export const MAX_QUANTITY = 1_000_000;

/** Cent-safe rounding (ADR 0014): 1.005 rounds to 1.01. */
export function roundCents(n: number): number {
  return Math.round(Number((n * 100).toPrecision(12))) / 100;
}

/** True if `n` has at most two decimals. */
function wholeCents(n: number): boolean {
  return Number.isInteger(Number((n * 100).toPrecision(12)));
}

/** A price or cost a client sent: finite, 0 to MAX_MONEY, at most two decimals. */
export function money(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MONEY || !wholeCents(value)) {
    throw new InvalidInputError(`${what} must be an amount from 0 to ${MAX_MONEY} with at most two decimals`);
  }
  // Within 1e-12 of whole cents (0.1 + 0.2, say): store the cents the person saw
  return roundCents(value);
}

/**
 * A stored price or cost copied onto a new sheet line. Stored values should
 * already follow the money rule, but ones typed before it existed may not, so
 * a snapshot rounds to cents (ADR 0014: "rounded when next saved"). Returns
 * undefined for a value that isn't a usable amount.
 */
export function storedMoney(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MONEY) return undefined;
  return roundCents(value);
}

/** A number of eaches a command moves: a whole number from 1 to MAX_QUANTITY. */
export function quantity(value: unknown, what = "quantity"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_QUANTITY) {
    throw new InvalidInputError(`${what} must be a whole number from 1 to ${MAX_QUANTITY}`);
  }
  return value;
}

/** A counted stock level: a whole number from 0 to MAX_QUANTITY. */
export function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_QUANTITY) {
    throw new InvalidInputError(`count must be a whole number from 0 to ${MAX_QUANTITY}`);
  }
  return value;
}
