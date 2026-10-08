// Security notices for changes made directly against Cognito
// (supply-checkout-8jc.28, supply-checkout-8jc.29).
//
// The account API emails the account when it sets a password or turns
// two-step sign-in on (account-handler.ts, "Security notices"). But the web
// client has the aws.cognito.signin.user.admin scope, so anyone holding a
// session can make the same changes with the access token alone, straight to
// Cognito (ChangePassword, VerifySoftwareToken, SetUserMFAPreference), and
// change the account's email (UpdateUserAttributes, then VerifyUserAttribute
// with a code sent to the new address). The email can't simply be made
// read-only: Google and Apple map it, and Cognito requires every mapped
// attribute to be client-writable.
//
// So every such call reaches this function, however it was made: CloudTrail
// records it as a management event, and an EventBridge rule on the app pool
// (the email stack) sends the successful ones here.
//
// Who: CloudTrail records these calls with the user's `sub` in
// `additionalEventData.sub`, never the username or the token (AWS: "Amazon
// Cognito records UserSub but not UserName in CloudTrail logs for requests
// that are specific to a user"). The function finds the user by that sub in
// the app pool (ListUsers, then AdminGetUser: cognitoAccounts). The sub is
// Cognito's own record of whose token made the call; nothing the caller sends
// chooses it, and EventBridge refuses `aws.*` sources from PutEvents, so no
// one can hand this function an event of their own. An event with no sub is
// counted (SecurityNoticeFailures, `no_user`) so a change in CloudTrail's
// shape shows up.
//
// What:
// - ChangePassword: `passwordSet`, to the account's verified address.
// - VerifySoftwareToken, SetUserMFAPreference, AdminSetUserMFAPreference (an
//   administrator's call on the app pool): `twoStepOn`, to the verified
//   address, when AdminGetUser shows an authenticator app among the user's
//   MFA methods (so turning it off, or a code checked without turning it on,
//   sends nothing).
// - The same three, first of all: when TOTP was
//   turned on (supply-checkout-8jc.14, data/two-step.ts), which the billing
//   routes compare with a session's auth_time. With an authenticator among
//   the user's MFA methods, the event's time is recorded unless a later one
//   is; without one (turned off), a record older than the event is removed,
//   so if it's turned on again directly, billing finds none until that
//   event arrives, and refuses. A failed write is logged ("Two-step sign-in
//   time not recorded") and counted (`totp_record`), the notices are still
//   sent, and then it's thrown, so Lambda tries again.
// - Every event, and UpdateUserAttributes and VerifyUserAttribute only for
//   this: `emailChanged`, to the address the account had before, when the
//   address Cognito has verified (where it now sends codes and resets) is
//   another one (noticeEmailChange). Checked on every event, so a later one
//   catches a change whose own events were missed. The old address is the one recorded in NOTICE_ADDRESS
//   (data/security-notices.ts), written where the account's verified address
//   first appeared (the user pool's triggers, notice-address.ts; /me; this
//   function; or the owner's backfill, supply-checkout-8jc.31). The pool keeps the old address until the
//   new one is verified (keepOriginal), but the event can arrive after that,
//   so Cognito alone can't say what it was. The recorded address moves to the
//   new one in the same conditional write that decides to tell the old one,
//   so one change is told once. An account with no recorded address has it
//   recorded now, and nobody is told.
//
// Not twice: a change the account API made was emailed already, and the API
// marked its kind sent (markNoticeSent). This function sends a password or
// two-step notice only if it can claim the kind (claimNotice: none sent in the
// last NOTICE_DEDUPE_MS), which also keeps the two events of one TOTP setup to
// one email.
//
// Best effort, like the API's notices: a failed send is logged with the user
// ID, the kind and the error's name only, and counted in
// SecurityNoticeFailures (reason `not_sent`, `no_address`, `no_user`,
// `lookup_failed`, `pending` for an email change notice another attempt has
// claimed but not sent, or `error` for anything else thrown, such as DynamoDB
// refusing a call). A failed Cognito or DynamoDB call, or an email change
// notice SES refused, is thrown after it's counted, so Lambda tries the event
// again, then puts it on the dead-letter queue ("Security notices dropped").
// No address, name or token is ever logged or put in a metric.
//
// A confirmed password reset (supply-checkout-6uw.32) arrives another way:
// the user pool's post confirmation trigger, which has signed the account out
// everywhere, invokes this function asynchronously with a
// PasswordResetNoticeRequest (the user's sub from Cognito's own event, the
// time, and whether the sign-out worked). Only the trigger's role may invoke
// it so (the identity stack). It's handled as an event is, with `via: reset`
// in logs and metrics: the email change check, then `passwordReset` to the
// verified address, once per NOTICE_DEDUPE_MS. A failed lookup is retried by
// Lambda, then the dead-letter queue.

import {
  claimEmailChangeNotice,
  claimNotice,
  clearTotpOn,
  type Db,
  emailChangeClaimedAt,
  emailSeenHash,
  moveNoticeAddress,
  normalizeEmail,
  noticeAddress,
  recordNoticeAddress,
  recordTotpOn,
  releaseEmailChangeNotice,
} from "../data/index.js";
import { EmailNotSentError, type Mailer } from "../email/mailer.js";
import type { SecurityNotice } from "../email/templates.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { type FindAccount, type PoolAccount, SUB } from "./cognito-accounts.js";
import { type PasswordResetNoticeRequest, SECURITY_NOTICE_EVENTS } from "./names.js";

export interface SecurityNoticesDeps {
  /** The app pool: events that name another pool are ignored. */
  readonly userPoolId: string;
  readonly findAccount: FindAccount;
  /** The app table, as the function's role reaches it (GetItem and UpdateItem of SECURITY_NOTICE_ATTRIBUTES, totpOnAt among them, in USER# partitions). */
  readonly db: Db;
  readonly mailer: Mailer;
  readonly obs: Observability;
  /** How long an email change notice may wait on SES (SEND_TIMEOUT_MS); for tests. */
  readonly sendTimeoutMs?: number;
  readonly now?: () => number;
}

/** How long an email change notice waits on SES before its claim is given up and the event retried. */
const SEND_TIMEOUT_MS = 10_000;

/** How old a held email change claim must be to count as `pending`: past one attempt's SEND_TIMEOUT_MS, so likely a dead one. */
export const PENDING_COUNT_AFTER_MS = 15_000;

/** The parts of a CloudTrail record this reads (EventBridge's `detail`). */
interface CloudTrailDetail {
  readonly eventSource?: unknown;
  readonly eventName?: unknown;
  readonly eventTime?: unknown;
  readonly errorCode?: unknown;
  readonly requestParameters?: { readonly userPoolId?: unknown } | null;
  readonly additionalEventData?: { readonly userPoolId?: unknown; readonly sub?: unknown } | null;
}

type Kind = SecurityNotice["kind"];

/** How the change reached the function, for logs and metrics: CloudTrail's event, or the post confirmation trigger's reset. */
type Via = "cloudtrail" | "reset";

/** A notice to the account's verified address (noticeAccount): every kind but an email change. */
type AccountNotice = Exclude<SecurityNotice, { kind: "emailChanged" }>;

/** The post confirmation trigger's request, if `event` is one (PasswordResetNoticeRequest); EventBridge's events never have a `type`. */
const resetRequest = (event: unknown): Partial<Record<keyof PasswordResetNoticeRequest, unknown>> | undefined =>
  typeof event === "object" && event !== null && (event as { type?: unknown }).type === "passwordReset" ? (event as Partial<Record<keyof PasswordResetNoticeRequest, unknown>>) : undefined;

/** What an attempt got to, for counting an error thrown along the way. */
interface Seen {
  sub?: string;
  kind?: Kind;
  via?: Via;
}

/** cognitoRequest's error message: `<Action> failed: <status> <type>`. */
const LOOKUP_ERROR = /^(ListUsers|AdminGetUser) failed: \d{3}( [A-Za-z]+)?$/;

/** An error's code for a log line: SES's, or only the error's name, never its message. */
const errorCode = (error: unknown) => (error instanceof EmailNotSentError ? error.code : ((error as { name?: string } | null)?.name ?? "Unknown"));

/** An error already logged and counted, thrown on for Lambda to try again. */
class CountedError extends Error {
  constructor(cause: unknown) {
    super("Counted", { cause });
  }
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** The account's address, normalized, if `verified`; otherwise undefined. */
function addressIf(account: PoolAccount, verified: boolean): string | undefined {
  if (!verified || !account.email) return undefined;
  try {
    return normalizeEmail(account.email);
  } catch {
    return undefined;
  }
}

/** The address the account API would send to (emailVerifiedFrom's rule). */
const verifiedAddress = (account: PoolAccount) => addressIf(account, account.emailVerified);

export function createSecurityNoticesHandler(deps: SecurityNoticesDeps) {
  const { db, obs } = deps;
  const now = () => new Date((deps.now ?? Date.now)());

  const failed = (userId: string | undefined, kind: Kind, reason: string, code: string, via: Via) => {
    obs.logger.warn("Security notice not sent", { ...(userId ? { userId } : {}), kind, code, via });
    obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind, reason, via });
  };

  /** Sends one notice. Never throws. */
  async function send(userId: string, to: string, input: SecurityNotice, via: Via): Promise<void> {
    try {
      await deps.mailer.send(to, input);
      obs.count(BusinessMetric.SecurityNotices, 1, { kind: input.kind, via });
      obs.logger.info("Security notice sent", { userId, kind: input.kind, via });
    } catch (error) {
      failed(userId, input.kind, "not_sent", errorCode(error), via);
    }
  }

  /** A password, reset or two-step notice to the verified address, unless one of its kind just went out. */
  async function noticeAccount(userId: string, account: PoolAccount, input: AccountNotice, via: Via): Promise<void> {
    const { kind } = input;
    const to = verifiedAddress(account);
    if (!to) return failed(userId, kind, "no_address", "NoAddress", via);
    if (!(await claimNotice(db, userId, kind, now()))) {
      obs.logger.info("Security notice already sent", { userId, kind, via });
      return;
    }
    await send(userId, to, input, via);
  }

  /**
   * Tells the address the account had before that its email changed, once per
   * change (see "What" at the top). Whether it changed is decided on Cognito's
   * own verified address, only trimmed and lowered (emailSeenHash), not the
   * account API's rules: a linked user's new address isn't one the API counts,
   * one over 254 characters won't normalize, and NFKC could fold a different
   * mailbox into the recorded one, yet Cognito sends codes and resets to each.
   * The address told is always the recorded one, which only ever starts as an
   * address the API trusts, and moves on only to one that normalizes.
   *
   * The notice is claimed for the new address (for just over the function's
   * timeout, EMAIL_CHANGE_CLAIM_MS), sent, and only then is the record moved
   * on. If SES refuses it or takes over SEND_TIMEOUT_MS, the claim is given up
   * and the error thrown, so Lambda tries again (then the dead-letter queue).
   * An attempt that finds the claim held and the record not moved throws too,
   * counting it (`pending`) once the claim is PENDING_COUNT_AFTER_MS old, so an attempt that died holding the claim
   * isn't taken for a sent notice: the retry, after the claim lapses, sends it.
   */
  async function noticeEmailChange(userId: string, account: PoolAccount, at: string, via: Via): Promise<void> {
    // A new address not verified yet (keepOriginal keeps the old one until it is) changes nothing
    if (!account.emailVerifiedInCognito || !account.email?.trim()) return;
    const seen = emailSeenHash(account.email);
    const record = await noticeAddress(db, userId);
    if (!record) {
      const trusted = verifiedAddress(account);
      if (trusted) await recordNoticeAddress(db, userId, trusted, seen, now());
      return;
    }
    if (record.seen === seen) return;
    if (!(await claimEmailChangeNotice(db, userId, seen, now()))) {
      // Sent already if the record has moved on; otherwise another attempt holds the claim, and may
      // have died with it: count it and throw, so the retry (after the claim lapses) or the
      // dead-letter queue sees it through
      if ((await noticeAddress(db, userId))?.seen === seen) return;
      // Counted only once the claim is old enough that its attempt has likely died: a younger one is
      // usually another event's attempt still sending, which the retry finds done
      const claimedAt = await emailChangeClaimedAt(db, userId);
      if (!claimedAt || now().getTime() - claimedAt.getTime() >= PENDING_COUNT_AFTER_MS) failed(userId, "emailChanged", "pending", "ClaimHeld", via);
      else obs.logger.info("Security notice being sent", { userId, kind: "emailChanged", via });
      throw new CountedError(new Error("An email change notice is claimed but not sent yet"));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bounded (the SES client is too, mailer.ts), so a hung send can't hold the claim to the function's timeout
      await Promise.race([
        deps.mailer.send(record.address, { kind: "emailChanged", at }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new EmailNotSentError("Timeout")), deps.sendTimeoutMs ?? SEND_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      await releaseEmailChangeNotice(db, userId, seen).catch(() => undefined);
      failed(userId, "emailChanged", "not_sent", errorCode(error), via);
      throw new CountedError(error);
    } finally {
      clearTimeout(timer);
    }
    obs.count(BusinessMetric.SecurityNotices, 1, { kind: "emailChanged", via });
    obs.logger.info("Security notice sent", { userId, kind: "emailChanged", via });
    // The next change is told to the new address only if it's one the app can use; otherwise still the old one
    await moveNoticeAddress(db, userId, record.seen, seen, addressIf(account, true) ?? record.address, now());
  }

  /** Looks the user up by sub, counting a failed lookup (`lookup_failed`) and throwing it on for Lambda to try again. */
  async function lookUp(sub: string, kind: Kind, via: Via): Promise<PoolAccount | undefined> {
    try {
      return await deps.findAccount(sub);
    } catch (error) {
      // cognitoRequest's message names only the action, status and error type; anything else, only its name. Lambda tries again
      const message = (error as { message?: unknown } | null)?.message;
      failed(sub, kind, "lookup_failed", typeof message === "string" && LOOKUP_ERROR.test(message) ? message : errorCode(error), via);
      throw new CountedError(error);
    }
  }

  /** A confirmed password reset, from the post confirmation trigger (see the top). */
  async function handleReset(request: Partial<Record<keyof PasswordResetNoticeRequest, unknown>>, seen: Seen): Promise<void> {
    seen.kind = "passwordReset";
    seen.via = "reset";
    const sub = text(request.userId);
    if (!sub || !SUB.test(sub)) return failed(undefined, "passwordReset", "no_user", "NoSub", "reset");
    seen.sub = sub;
    const time = Date.parse(String(request.at));
    const at = (Number.isFinite(time) ? new Date(time) : now()).toISOString();
    const account = await lookUp(sub, "passwordReset", "reset");
    // Since deleted
    if (!account) return;
    await noticeEmailChange(sub, account, at, "reset");
    await noticeAccount(sub, account, { kind: "passwordReset", at, signedOut: request.signedOut === true }, "reset");
  }

  async function handle(event: { readonly detail?: unknown }, seen: Seen): Promise<void> {
    const detail = (event.detail ?? {}) as CloudTrailDetail;
    if (detail.eventSource !== "cognito-idp.amazonaws.com") return;
    const name = text(detail.eventName);
    if (!name || !Object.hasOwn(SECURITY_NOTICE_EVENTS, name)) return;
    const kind = SECURITY_NOTICE_EVENTS[name as keyof typeof SECURITY_NOTICE_EVENTS];
    seen.kind = kind;
    // Only calls that succeeded changed anything
    if (text(detail.errorCode)) return;
    const pool = text(detail.requestParameters?.userPoolId) ?? text(detail.additionalEventData?.userPoolId);
    if (pool && pool !== deps.userPoolId) return;
    const sub = text(detail.additionalEventData?.sub);
    if (!sub || !SUB.test(sub)) return failed(undefined, kind, "no_user", "NoSub", "cloudtrail");
    seen.sub = sub;
    const eventTime = Date.parse(String(detail.eventTime));
    // CloudTrail's time is in whole seconds, rounded down: never later than the call
    const when = Number.isFinite(eventTime) ? new Date(eventTime) : now();
    const at = when.toISOString();

    const account = await lookUp(sub, kind, "cloudtrail");
    // Not an app user: another pool's (the event didn't name it), or since deleted
    if (!account) return;
    // When TOTP was turned on, for the billing check, before anything below can fail. A failed
    // write is counted on its own, and the notices still go out (they're the main defence)
    // before it's thrown for Lambda to try again
    const recordFailed = kind === "twoStepOn" ? await recordTwoStep(sub, account, when) : undefined;
    await notices(sub, account, kind, at);
    if (recordFailed) throw new CountedError(recordFailed.error);
  }

  /** Records or clears when TOTP was turned on (see "What" at the top). Never throws: a failure is logged, counted and returned. */
  async function recordTwoStep(userId: string, account: PoolAccount, when: Date): Promise<{ error: unknown } | undefined> {
    try {
      await (account.totpEnabled ? recordTotpOn(db, userId, when) : clearTotpOn(db, userId, when));
      return undefined;
    } catch (error) {
      obs.logger.error("Two-step sign-in time not recorded", { userId, code: errorCode(error), via: "cloudtrail" });
      obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind: "twoStepOn", reason: "totp_record", via: "cloudtrail" });
      return { error };
    }
  }

  async function notices(sub: string, account: PoolAccount, kind: "passwordSet" | "twoStepOn" | "emailChanged", at: string): Promise<void> {
    // On every event, so a later one catches an email change whose own events were missed or dead-lettered
    await noticeEmailChange(sub, account, at, "cloudtrail");
    if (kind === "emailChanged") return;
    if (kind === "twoStepOn" && !account.totpEnabled) return;
    return noticeAccount(sub, account, { kind, at }, "cloudtrail");
  }

  /** EventBridge's event (a CloudTrail record in `detail`), or the post confirmation trigger's PasswordResetNoticeRequest. */
  return async (event: { readonly detail?: unknown } | { readonly type?: unknown }): Promise<void> => {
    const seen: Seen = {};
    try {
      const reset = resetRequest(event);
      await (reset ? handleReset(reset, seen) : handle(event as { readonly detail?: unknown }, seen));
    } catch (error) {
      if (error instanceof CountedError) throw error.cause;
      // Anything else (DynamoDB refusing a call, say) is counted too, before Lambda tries again
      failed(seen.sub, seen.kind ?? "passwordSet", "error", errorCode(error), seen.via ?? "cloudtrail");
      throw error;
    }
  };
}
