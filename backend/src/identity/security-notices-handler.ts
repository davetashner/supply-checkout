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
// - VerifySoftwareToken, SetUserMFAPreference: `twoStepOn`, to the verified
//   address, when AdminGetUser shows an authenticator app among the user's
//   MFA methods (so turning it off, or a code checked without turning it on,
//   sends nothing).
// - Every event, and UpdateUserAttributes and VerifyUserAttribute only for
//   this: `emailChanged`, to the address the account had before, when the
//   address Cognito has verified (where it now sends codes and resets) is
//   another one (noticeEmailChange). Checked on every event, so a later one
//   catches a change whose own events were missed. The old address is the one recorded in NOTICE_ADDRESS
//   (data/security-notices.ts), written when /me or this function first saw
//   the account's verified address. The pool keeps the old address until the
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

import {
  claimEmailChangeNotice,
  claimNotice,
  type Db,
  emailSeenHash,
  moveNoticeAddress,
  normalizeEmail,
  noticeAddress,
  recordNoticeAddress,
  releaseEmailChangeNotice,
} from "../data/index.js";
import { EmailNotSentError, type Mailer } from "../email/mailer.js";
import type { SecurityNotice } from "../email/templates.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { type FindAccount, type PoolAccount, SUB } from "./cognito-accounts.js";
import { SECURITY_NOTICE_EVENTS } from "./names.js";

export interface SecurityNoticesDeps {
  /** The app pool: events that name another pool are ignored. */
  readonly userPoolId: string;
  readonly findAccount: FindAccount;
  /** The app table, as the function's role reaches it (GetItem and UpdateItem of SECURITY_NOTICE_ATTRIBUTES in USER# partitions). */
  readonly db: Db;
  readonly mailer: Mailer;
  readonly obs: Observability;
  /** How long an email change notice may wait on SES (SEND_TIMEOUT_MS); for tests. */
  readonly sendTimeoutMs?: number;
  readonly now?: () => number;
}

/** How long an email change notice waits on SES before its claim is given up and the event retried. */
const SEND_TIMEOUT_MS = 10_000;

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

  const failed = (userId: string | undefined, kind: Kind, reason: string, code: string) => {
    obs.logger.warn("Security notice not sent", { ...(userId ? { userId } : {}), kind, code, via: "cloudtrail" });
    obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind, reason, via: "cloudtrail" });
  };

  /** Sends one notice. Never throws. */
  async function send(userId: string, to: string, input: SecurityNotice): Promise<void> {
    try {
      await deps.mailer.send(to, input);
      obs.count(BusinessMetric.SecurityNotices, 1, { kind: input.kind, via: "cloudtrail" });
      obs.logger.info("Security notice sent", { userId, kind: input.kind, via: "cloudtrail" });
    } catch (error) {
      failed(userId, input.kind, "not_sent", errorCode(error));
    }
  }

  /** A password or two-step notice to the verified address, unless one of its kind just went out. */
  async function noticeAccount(userId: string, account: PoolAccount, kind: "passwordSet" | "twoStepOn", at: string): Promise<void> {
    const to = verifiedAddress(account);
    if (!to) return failed(userId, kind, "no_address", "NoAddress");
    if (!(await claimNotice(db, userId, kind, now()))) {
      obs.logger.info("Security notice already sent", { userId, kind, via: "cloudtrail" });
      return;
    }
    await send(userId, to, { kind, at });
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
   * An attempt that finds the claim held and the record not moved counts it
   * (`pending`) and throws too, so an attempt that died holding the claim
   * isn't taken for a sent notice: the retry, after the claim lapses, sends it.
   */
  async function noticeEmailChange(userId: string, account: PoolAccount, at: string): Promise<void> {
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
      failed(userId, "emailChanged", "pending", "ClaimHeld");
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
      failed(userId, "emailChanged", "not_sent", errorCode(error));
      throw new CountedError(error);
    } finally {
      clearTimeout(timer);
    }
    obs.count(BusinessMetric.SecurityNotices, 1, { kind: "emailChanged", via: "cloudtrail" });
    obs.logger.info("Security notice sent", { userId, kind: "emailChanged", via: "cloudtrail" });
    // The next change is told to the new address only if it's one the app can use; otherwise still the old one
    await moveNoticeAddress(db, userId, record.seen, seen, addressIf(account, true) ?? record.address, now());
  }

  async function handle(event: { readonly detail?: unknown }, seen: { sub?: string; kind?: Kind }): Promise<void> {
    const detail = (event.detail ?? {}) as CloudTrailDetail;
    if (detail.eventSource !== "cognito-idp.amazonaws.com") return;
    const name = text(detail.eventName);
    if (!name || !Object.hasOwn(SECURITY_NOTICE_EVENTS, name)) return;
    const kind: Kind = SECURITY_NOTICE_EVENTS[name as keyof typeof SECURITY_NOTICE_EVENTS];
    seen.kind = kind;
    // Only calls that succeeded changed anything
    if (text(detail.errorCode)) return;
    const pool = text(detail.requestParameters?.userPoolId) ?? text(detail.additionalEventData?.userPoolId);
    if (pool && pool !== deps.userPoolId) return;
    const sub = text(detail.additionalEventData?.sub);
    if (!sub || !SUB.test(sub)) return failed(undefined, kind, "no_user", "NoSub");
    seen.sub = sub;
    const eventTime = Date.parse(String(detail.eventTime));
    const at = (Number.isFinite(eventTime) ? new Date(eventTime) : now()).toISOString();

    let account: PoolAccount | undefined;
    try {
      account = await deps.findAccount(sub);
    } catch (error) {
      // cognitoRequest's message names only the action, status and error type; anything else, only its name. Lambda tries again
      const message = (error as { message?: unknown } | null)?.message;
      failed(sub, kind, "lookup_failed", typeof message === "string" && LOOKUP_ERROR.test(message) ? message : errorCode(error));
      throw new CountedError(error);
    }
    // Not an app user: another pool's (the event didn't name it), or since deleted
    if (!account) return;
    // On every event, so a later one catches an email change whose own events were missed or dead-lettered
    await noticeEmailChange(sub, account, at);
    if (kind === "emailChanged") return;
    if (kind === "twoStepOn" && !account.totpEnabled) return;
    return noticeAccount(sub, account, kind, at);
  }

  return async (event: { readonly detail?: unknown }): Promise<void> => {
    const seen: { sub?: string; kind?: Kind } = {};
    try {
      await handle(event, seen);
    } catch (error) {
      if (error instanceof CountedError) throw error.cause;
      // Anything else (DynamoDB refusing a call, say) is counted too, before Lambda tries again
      failed(seen.sub, seen.kind ?? "passwordSet", "error", errorCode(error));
      throw error;
    }
  };
}
