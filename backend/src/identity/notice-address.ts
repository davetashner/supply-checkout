// Recording the address an email change is told to (NOTICE_ADDRESS,
// data/security-notices.ts) where a verified address first appears
// (supply-checkout-8jc.31), so an account has one before anyone can change its
// email, not only once it has loaded the app (GET /me):
//
// - the post confirmation trigger (notice-address-handler.ts), when a native
//   user confirms their sign-up with Cognito's email code, before they have any
//   token to change the email with;
// - the pre token generation trigger (email-verified-handler.ts, only when
//   Google or Apple sign-in is on), at every token, once it has settled whether
//   the email is verified (a Google or Apple user's is first verified there);
// - and the one-time backfill for accounts made before this
//   (data/backfill.ts, `notice-address`, run by the owner with the pool listed
//   under their own credentials).
//
// The same rule as GET /me's: the address is recorded only when the account
// API would trust it (emailVerifiedFrom: Cognito's email_verified is "true", no
// downgrade pending, and a linked user's email is the one recorded in
// custom:linked_email) and it normalizes, with the hash of Cognito's own
// address as it was (emailSeenHash). Never over an address already recorded,
// and never for an account being deleted (recordNoticeAddress's conditions).
// `cognito:user_status`, which a trigger's event has and GetUser doesn't, is
// left out, so a trigger never trusts an address the API wouldn't.
//
// Nothing here logs or returns an address: callers get an outcome only.

import { emailVerifiedFrom } from "../api/cognito-user.js";
import { type Db, emailSeenHash, hasNoticeAddress, normalizeEmail, recordNoticeAddress } from "../data/index.js";
import { SUB } from "./cognito-accounts.js";

/** What recording came to: `untrusted` (no address the API trusts, or no valid sub), `present` (one is recorded), `recorded`, or `not-recorded` (recorded meanwhile, or the account is being deleted). */
export type NoticeAddressOutcome = "untrusted" | "present" | "recorded" | "not-recorded";

/** The user's Cognito attributes, as a trigger's event or ListUsers gives them. */
export type UserAttributes = Readonly<Record<string, string | undefined>>;

/** The user's sub, the address to record (normalized) and the hash of Cognito's own address, when the account API would trust it; otherwise undefined. */
export function noticeAddressOf(username: unknown, attributes: UserAttributes): { userId: string; address: string; seen: string } | undefined {
  const userId = attributes.sub;
  if (typeof userId !== "string" || !SUB.test(userId)) return undefined;
  const asGetUser = Object.fromEntries(Object.entries(attributes).filter(([name]) => name !== "cognito:user_status"));
  if (!emailVerifiedFrom(username, asGetUser) || !attributes.email) return undefined;
  try {
    return { userId, address: normalizeEmail(attributes.email), seen: emailSeenHash(attributes.email) };
  } catch {
    return undefined;
  }
}

/** Records the user's address if the API would trust it and none is recorded yet. Throws what DynamoDB throws. */
export type RememberNoticeAddress = (username: unknown, attributes: UserAttributes) => Promise<NoticeAddressOutcome>;

/**
 * rememberNoticeAddress for a trigger: reads whether one is recorded first
 * (only when, never the address), so an account that has one costs no write.
 * Each request gives up after `timeoutMs`.
 */
export function noticeAddressRecorder(db: Db, options: { timeoutMs?: number; now?: () => number } = {}): RememberNoticeAddress {
  const now = options.now ?? Date.now;
  return async (username, attributes) => {
    const found = noticeAddressOf(username, attributes);
    if (!found) return "untrusted";
    if (await hasNoticeAddress(db, found.userId, options)) return "present";
    return (await recordNoticeAddress(db, found.userId, found.address, found.seen, new Date(now()), options)) ? "recorded" : "not-recorded";
  };
}
