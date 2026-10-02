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

import type { PostConfirmationTriggerEvent } from "aws-lambda";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { isFederatedOnly } from "./email-verified-handler.js";
import { SUB } from "./cognito-accounts.js";
import type { NoticeAddressOutcome, RememberNoticeAddress } from "./notice-address.js";
import type { SendWelcome } from "./welcome-invoke.js";

export interface PostConfirmationDeps {
  readonly rememberNoticeAddress: RememberNoticeAddress;
  readonly obs: Observability;
  /** Hands a new account's welcome email to its function (welcome-invoke.ts). Without it, no welcome is sent. */
  readonly sendWelcome?: SendWelcome;
  /** For tests. */
  readonly now?: () => number;
}

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
    let outcome: NoticeAddressOutcome | "failed";
    try {
      outcome = await deps.rememberNoticeAddress(event.userName, event.request?.userAttributes ?? {});
    } catch (error) {
      outcome = "failed";
      deps.obs.logger.error("Notice address not recorded", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
      deps.obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind: "emailChanged", reason: "record_address", via: "sign-up" });
    }
    const welcomed = deps.sendWelcome ? await welcome(deps.sendWelcome, event, started) : undefined;
    deps.obs.logger.info("Notice address", { triggerSource: String(event.triggerSource), outcome, ...(welcomed ? { welcome: welcomed } : {}) });
    return event;
  };
}
