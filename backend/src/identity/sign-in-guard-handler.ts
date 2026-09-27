// The pre authentication trigger that keeps Google and Apple users to their
// provider (supply-checkout-6v9).
//
// The invariant: a federated-only user (username `<provider>_<provider user
// ID>`, user status EXTERNAL_PROVIDER) signs in only through Google or Apple.
// Cognito runs pre authentication for native sign-ins (password, email code,
// passkey, in Managed Login or the API) and not for federated ones, so this
// trigger refuses every native sign-in by such a user, even if they somehow
// got a password (forgot-password once verified) or registered a passkey.
//
// The email_verified trigger (email-verified-handler.ts) depends on it: it
// trusts `custom:idp_email_verified`, which users can write, only at a
// Managed Login token for a federated-only user, and this guard makes every
// such token come from a provider sign-in, right after Cognito rewrote the
// attribute from the provider's claim.
//
// Native users, including a native user with a linked Google or Apple
// identity (account-link-handler.ts, supply-checkout-0b1), are let through:
// their username isn't a provider identity's, and Cognito keeps them
// CONFIRMED. If who counts as federated changes, change isFederatedOnly() here,
// in the email_verified trigger and in the linking trigger together.
//
// Needs no AWS permissions. Logs carry the outcome only, never the username
// or email.

import type { PreAuthenticationTriggerEvent } from "aws-lambda";
import type { Observability } from "../observability/index.js";
import { isFederatedOnly } from "./email-verified-handler.js";

export { isFederatedOnly };

export interface SignInGuardDeps {
  readonly obs: Observability;
}

/** What Cognito shows the person; it names no provider and no account detail. */
export const NATIVE_SIGN_IN_REFUSED = "Sign in with the provider you signed up with";

export function createSignInGuardHandler(deps: SignInGuardDeps) {
  return async (event: PreAuthenticationTriggerEvent): Promise<PreAuthenticationTriggerEvent> => {
    const attributes = event.request?.userAttributes ?? {};
    if (event.request?.userNotFound) {
      // With user existence errors prevented, Cognito asks about unknown users too and fails the sign-in itself
      deps.obs.logger.info("Native sign-in", { outcome: "unknown-user" });
      return event;
    }
    if (isFederatedOnly(event.userName, attributes)) {
      deps.obs.logger.warn("Native sign-in", { outcome: "refused-federated" });
      throw new Error(NATIVE_SIGN_IN_REFUSED);
    }
    deps.obs.logger.info("Native sign-in", { outcome: "allowed" });
    return event;
  };
}
