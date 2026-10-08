// Refusing a session that began before the account's password was reset
// (supply-checkout-6uw.33), on every route the app's access tokens reach: the
// data, account, billing and receipts functions.
//
// After a confirmed reset the post confirmation trigger signs the account out
// everywhere and records the reset's time in the user's own partition
// (data/password-reset-time.ts). Signing out revokes refresh tokens only, so
// an access token from before still passes API Gateway's JWT authorizer for up
// to an hour, and a Managed Login session cookie from before (up to an hour
// old) can get new tokens, a new refresh token among them, without the
// password. Every token of a session carries that session's `auth_time`, when
// it signed in, however it was refreshed. So a token whose `auth_time` is
// earlier than the reset is answered 401 `unauthenticated` with the reason
// `password_reset`, and the app signs out here and of Managed Login and asks
// for the new password (src/aws/session.js).
//
// - Why every route, not only billing, account and members: a session from
//   the cookie can hold a new 30-day refresh token, and the data routes are
//   the team's data (an export is a list of them). Live updates
//   (AppSync) aren't checked: their events name a document and carry none of
//   its data, which the app then fetches through the data API.
// - The read: GetItem of `passwordResetAt` only, in `USER#<sub>` (the
//   verified token's), with the function's own role, which may name only the
//   keys and `passwordResetAt` there (infra api-stack, grantPasswordResetRead).
//   It gives up after RESET_READ_TIMEOUT_MS, and concurrent requests for a
//   user that isn't cached share one read. The data and receipts functions run
//   it alongside the membership check (alongside), so it adds no wait there.
//   It's strongly consistent and kept per container for RESET_CACHE_MS,
//   at most RESET_CACHE_USERS users, so a busy user costs about one read
//   every 10 seconds per container, not one per request. A reset is seen
//   within that time by every container.
// - No record (most users): nothing more is checked. With one, a token
//   without a whole-number `auth_time` is refused.
// - Clock skew: `auth_time` is whole seconds (rounded down), from Cognito's
//   clock; the record is the trigger's clock when it ran, after the password
//   changed. A session refused is one that began more than RESET_SKEW_MS
//   before the reset, so a sign-in with the new password right after the reset
//   is never refused for a second's rounding or a small clock difference. A
//   session begun with the old password in those few seconds before the reset
//   passes: accepted, as it's then signed out everywhere with the rest.
// - A failed read refuses the request (500, logged by the handler), never
//   lets it through.

import { createDb, passwordResetAt } from "../data/index.js";
import type { DataEvent } from "./data-handler.js";
import { ApiError } from "./http.js";

/** Refuses the request (ApiError) if the caller's session began before their password was last reset. */
export type SessionCheck = (event: DataEvent, userId: string) => Promise<void>;

/** When the user's password was last reset, in milliseconds, or undefined (data/password-reset-time.ts passwordResetAt). */
export type ResetLookup = (userId: string) => Promise<number | undefined>;

/** How much earlier than the recorded reset a session must have begun to be refused. */
export const RESET_SKEW_MS = 5_000;
/** How long the read may take before the request fails (it's refused, never let through). */
export const RESET_READ_TIMEOUT_MS = 2_000;
/** How long a container keeps a user's reset time before reading it again. */
export const RESET_CACHE_MS = 10_000;
/** How many users' reset times a container keeps. */
export const RESET_CACHE_USERS = 1_000;

/** The answer to a session from before the reset: sign in again, with the new password. */
export function passwordReset(): ApiError {
  return new ApiError(401, "unauthenticated", "Your password was reset after this session began. Sign in again with the new password.", "password_reset");
}

/**
 * Whether a session that signed in at `authTime` (whole seconds, as the
 * token says) began before a reset recorded at `resetAt` (milliseconds):
 * more than RESET_SKEW_MS before it. A missing or malformed `auth_time` counts
 * as before.
 */
export function beganBeforeReset(authTime: unknown, resetAt: number): boolean {
  const seconds = typeof authTime === "number" ? authTime : typeof authTime === "string" && /^[0-9]{1,12}$/.test(authTime) ? Number(authTime) : Number.NaN;
  if (!Number.isInteger(seconds)) return true;
  return seconds * 1000 < resetAt - RESET_SKEW_MS;
}

export function createSessionCheck(options: { lookup: ResetLookup; now?: () => number; cacheMs?: number; maxUsers?: number }): SessionCheck {
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? RESET_CACHE_MS;
  const maxUsers = options.maxUsers ?? RESET_CACHE_USERS;
  // Least recently used first; a failed read isn't kept
  const cache = new Map<string, { readonly resetAt: number | undefined; readonly until: number }>();
  // Reads in flight, so concurrent requests for one user share one
  const reading = new Map<string, Promise<number | undefined>>();

  async function resetAt(userId: string): Promise<number | undefined> {
    const hit = cache.get(userId);
    if (hit && hit.until > now()) {
      // Most recently used goes last
      cache.delete(userId);
      cache.set(userId, hit);
      return hit.resetAt;
    }
    const pending = reading.get(userId);
    if (pending) return pending;
    const read = options
      .lookup(userId)
      .then((found) => {
        cache.delete(userId);
        cache.set(userId, { resetAt: found, until: now() + cacheMs });
        if (cache.size > maxUsers) cache.delete(cache.keys().next().value as string);
        return found;
      })
      .finally(() => reading.delete(userId));
    reading.set(userId, read);
    return read;
  }

  return async (event, userId) => {
    const at = await resetAt(userId);
    if (at === undefined) return;
    if (beganBeforeReset(event.requestContext.authorizer?.jwt?.claims?.auth_time, at)) throw passwordReset();
  };
}

/**
 * The check as the Lambda entries build it, once per container: reads with the
 * function's own role (TABLE_NAME), which may read only `passwordResetAt` in
 * `USER#` partitions.
 */
export function sessionCheckFromEnv(env: NodeJS.ProcessEnv = process.env): SessionCheck {
  const db = createDb({ env });
  return createSessionCheck({ lookup: (userId) => passwordResetAt(db, userId, { timeoutMs: RESET_READ_TIMEOUT_MS }) });
}

/**
 * Runs the session check (if any) and `work` (the membership check) side by
 * side, and answers as if the check came first: its refusal or failure wins
 * over anything `work` threw, and `work`'s result is used only once the check
 * has passed. `work` must only read.
 */
export async function alongside<T>(check: Promise<void> | undefined, work: () => Promise<T>): Promise<T> {
  const [checked, done] = await Promise.allSettled([check, (async () => work())()]);
  if (checked.status === "rejected") throw checked.reason;
  if (done.status === "rejected") throw done.reason;
  return done.value;
}
