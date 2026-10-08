// The post confirmation trigger that records the address an email change is
// told to (NOTICE_ADDRESS, supply-checkout-8jc.31), the moment a native user
// confirms their sign-up with Cognito's email code (or a forgotten password):
// before they have a token, so before anyone could change the email with one.
// Until this, an account got its address only at its first GET /me, so an
// email change made before then (by someone holding its token, straight
// against Cognito) was recorded and nobody was told.
//
// The rule is GET /me's (notice-address.ts): only an address the account API
// would trust, never over one already recorded, never for an account being
// deleted. A Google or Apple user's email isn't verified yet at this point
// (the pre token generation trigger verifies it), so they get theirs there.
//
// Cognito reports a failed post confirmation trigger to the client after the
// user is confirmed, so this never throws: a failure is logged with the
// error's name only and counted (SecurityNoticeFailures, reason
// `record_address`), and the account's first GET /me or token records it.
// Logs carry the outcome only, never the email, username or sub.
//
// The welcome email (supply-checkout-6uw.25): when a native user confirms
// their sign-up (PostConfirmation_ConfirmSignUp, never a forgotten password's
// PostConfirmation_ConfirmForgotPassword), the trigger hands the welcome email
// to its own function
// (welcome-invoke.ts: an asynchronous invoke, so no send happens inside
// Cognito's 5 seconds), with the user's sub only. That function looks the
// user up and sends only to an address the account API trusts (so it doesn't
// matter whether this event already says the email is verified), and claims a
// once-only record before it sends, so a retried trigger sends nothing more. A Google or Apple user's
// email isn't verified here, so theirs is handed over by the pre token
// generation trigger, at the sign-in that verifies it. The invoke starts only
// while it fits the trigger's budget (WELCOME_BUDGET_MS, after the notice
// address's calls), with a short timeout (WELCOME_INVOKE_TIMEOUT_MS), so a slow
// DynamoDB or a cold start can't push the trigger past Cognito's 5 seconds. A
// failed hand-over, or no time left for it, is logged with the error's name
// only and counted (WelcomeEmailFailures, reason `invoke` or `deferred`); the
// confirmation never fails for it, and nothing tries it again: that account
// gets no welcome unless an operator invokes the function for it.
//
// A confirmed password reset (supply-checkout-6uw.32): Cognito's
// ConfirmForgotPassword doesn't revoke the account's refresh tokens, so
// sessions from before the reset (an attacker's among them) would keep
// working, and nobody would be told. Both ways to reset end in that call, the
// app's (POST /auth/password-reset/confirm) and Managed Login's, and Cognito
// runs this trigger after it (PostConfirmation_ConfirmForgotPassword), naming
// the user in its own event. So the trigger, first of all:
// - signs the account out everywhere (AdminUserGlobalSignOut, on the app pool
//   only: the role may call nothing else of Cognito's), before Cognito answers
//   the reset, so the new password's first sign-in isn't signed out with
//   them. Bounded (SIGN_OUT_TIMEOUT_MS); a failure is logged with the error's
//   name only and counted (SecurityNoticeFailures, kind `passwordReset`,
//   reason `sign_out`), which alarms, and never fails the reset;
// - then hands the security notices function (security-notices-handler.ts) the
//   user's sub, the time and whether the sign-out worked, with an
//   asynchronous invoke, while it fits the budget (WELCOME_BUDGET_MS), as the
//   welcome email does. That function emails the account's verified address
//   (`passwordReset`). A failed hand-over is counted the same way (reason
//   `invoke` or `deferred`).
// CloudTrail isn't used for this: an unauthenticated call's record isn't
// documented to name the user, and Managed Login's reset is recorded as its
// own page events (forgotPassword_POST), not ConfirmForgotPassword.

import type { PostConfirmationTriggerEvent } from "aws-lambda";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { isFederatedOnly } from "./email-verified-handler.js";
import { SUB } from "./cognito-accounts.js";
import type { PasswordResetNoticeRequest } from "./names.js";
import type { NoticeAddressOutcome, RememberNoticeAddress } from "./notice-address.js";
import type { SendWelcome } from "./welcome-invoke.js";

export interface PostConfirmationDeps {
  readonly rememberNoticeAddress: RememberNoticeAddress;
  readonly obs: Observability;
  /** Hands a new account's welcome email to its function (welcome-invoke.ts). Without it, no welcome is sent. */
  readonly sendWelcome?: SendWelcome;
  /** Signs a user out everywhere (AdminUserGlobalSignOut) after a confirmed password reset. Without it, nobody is signed out. */
  readonly signOutEverywhere?: SignOutEverywhere;
  /** Hands a confirmed password reset's notice to the security notices function. Without it, no notice is sent. */
  readonly sendResetNotice?: SendResetNotice;
  /** For tests. */
  readonly now?: () => number;
}

/** AdminUserGlobalSignOut of one user. Throws (naming only the action, status and error type) unless Cognito answered 200. */
export type SignOutEverywhere = (userPoolId: string, username: string) => Promise<void>;

/** Queues one password reset notice with the security notices function. */
export type SendResetNotice = (request: PasswordResetNoticeRequest) => Promise<void>;

/** The sign-out's timeout (post-confirmation.ts passes it to the Cognito client): it comes first, inside WELCOME_BUDGET_MS. */
export const SIGN_OUT_TIMEOUT_MS = 1_000;

/** What signing out after a reset came to: `done`, or `failed` (counted). */
export type SignOutOutcome = "done" | "failed";

/**
 * How long the trigger may have run, the welcome email's invoke included:
 * well inside Cognito's 5 seconds, leaving room for a cold start.
 */
export const WELCOME_BUDGET_MS = 4_000;
/** The welcome email's invoke timeout (post-confirmation.ts passes it to the invoker): it starts only while it fits WELCOME_BUDGET_MS. */
export const WELCOME_INVOKE_TIMEOUT_MS = 500;

/** What handing over the welcome email came to: `not-new` (not a sign-up, or a Google or Apple user), `no-sub` (no valid sub in the event), `queued` or `failed`. */
export type WelcomeOutcome = "not-new" | "no-sub" | "queued" | "failed";

export function createPostConfirmationHandler(deps: PostConfirmationDeps) {
  const now = deps.now ?? Date.now;
  const errorName = (error: unknown) => (error as { name?: string } | null)?.name ?? "Unknown";
  const resetFailed = (message: string, code: string, reason: string) => {
    deps.obs.logger.error(message, { code });
    deps.obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind: "passwordReset", reason, via: "reset" });
  };

  const signOut = async (signOutEverywhere: SignOutEverywhere, event: PostConfirmationTriggerEvent): Promise<SignOutOutcome> => {
    // Cognito's own event names the pool and the user; the role may sign out only the app pool's users
    if (typeof event.userPoolId !== "string" || !event.userPoolId || typeof event.userName !== "string" || !event.userName) {
      resetFailed("Not signed out after a password reset", "NoUser", "sign_out");
      return "failed";
    }
    try {
      await signOutEverywhere(event.userPoolId, event.userName);
      return "done";
    } catch (error) {
      // cognitoRequest's error names only the action, status and type; its name is all that's logged
      resetFailed("Not signed out after a password reset", errorName(error), "sign_out");
      return "failed";
    }
  };

  const resetNotice = async (send: SendResetNotice, event: PostConfirmationTriggerEvent, started: number, signedOut: boolean): Promise<WelcomeOutcome> => {
    const userId = event.request?.userAttributes?.sub;
    if (typeof userId !== "string" || !SUB.test(userId)) {
      resetFailed("Password reset notice not queued", "NoSub", "no_user");
      return "no-sub";
    }
    if (now() - started + WELCOME_INVOKE_TIMEOUT_MS > WELCOME_BUDGET_MS) {
      resetFailed("Password reset notice not queued", "NoTimeLeft", "deferred");
      return "failed";
    }
    try {
      await send({ type: "passwordReset", userId, at: new Date(started).toISOString(), signedOut });
      return "queued";
    } catch (error) {
      resetFailed("Password reset notice not queued", errorName(error), "invoke");
      return "failed";
    }
  };
  const welcome = async (send: SendWelcome, event: PostConfirmationTriggerEvent, started: number): Promise<WelcomeOutcome> => {
    const attributes = event.request?.userAttributes ?? {};
    if (event.triggerSource !== "PostConfirmation_ConfirmSignUp" || isFederatedOnly(event.userName, attributes)) return "not-new";
    const userId = attributes.sub;
    if (typeof userId !== "string" || !SUB.test(userId)) return "no-sub";
    if (now() - started + WELCOME_INVOKE_TIMEOUT_MS > WELCOME_BUDGET_MS) {
      deps.obs.logger.error("Welcome email not queued", { code: "NoTimeLeft" });
      deps.obs.count(BusinessMetric.WelcomeEmailFailures, 1, { reason: "deferred", via: "email" });
      return "failed";
    }
    try {
      await send({ userId, via: "email" });
      return "queued";
    } catch (error) {
      deps.obs.logger.error("Welcome email not queued", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
      deps.obs.count(BusinessMetric.WelcomeEmailFailures, 1, { reason: "invoke", via: "email" });
      return "failed";
    }
  };

  return async (event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> => {
    const started = now();
    const reset = event.triggerSource === "PostConfirmation_ConfirmForgotPassword";
    // First, while the trigger's time is freshest: the reset's sign-out
    const signedOut = reset && deps.signOutEverywhere ? await signOut(deps.signOutEverywhere, event) : undefined;
    let outcome: NoticeAddressOutcome | "failed";
    try {
      outcome = await deps.rememberNoticeAddress(event.userName, event.request?.userAttributes ?? {});
    } catch (error) {
      outcome = "failed";
      deps.obs.logger.error("Notice address not recorded", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
      deps.obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind: "emailChanged", reason: "record_address", via: "sign-up" });
    }
    const welcomed = deps.sendWelcome ? await welcome(deps.sendWelcome, event, started) : undefined;
    const noticed = reset && deps.sendResetNotice ? await resetNotice(deps.sendResetNotice, event, started, signedOut === "done") : undefined;
    deps.obs.logger.info("Notice address", {
      triggerSource: String(event.triggerSource),
      outcome,
      ...(welcomed ? { welcome: welcomed } : {}),
      ...(signedOut ? { signOut: signedOut } : {}),
      ...(noticed ? { resetNotice: noticed } : {}),
    });
    return event;
  };
}
