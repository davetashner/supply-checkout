// The pre token generation trigger that sets email_verified for Google and
// Apple users from the provider's own claim (supply-checkout-6v9).
//
// Why a trigger: Cognito requires every attribute an IdP maps to be writable
// by the app client, and the web client must never be able to write
// email_verified (the API trusts a verified email for invites). So the
// providers map their `email_verified` claim to `custom:idp_email_verified`
// instead, and this trigger copies it to email_verified with
// AdminUpdateUserAttributes.
//
// When it trusts the custom attribute: the user can write it too (it's
// mapped, so it's client-writable), so the trigger reads it only when Cognito
// has just overwritten it with the provider's claim:
//
// - The trigger source is TokenGeneration_HostedAuth: a sign-in through
//   Managed Login, which is the only way into a federated user. Refreshes
//   (TokenGeneration_RefreshTokens) and API sign-ins are ignored, because the
//   attribute then holds whatever was last written, possibly by the user.
// - The user is a federated-only user: its username is
//   `<providerName>_<provider user ID>` for a Google or SignInWithApple entry
//   in `identities`, which Cognito maintains and no client can write, and
//   Cognito marks it EXTERNAL_PROVIDER (`cognito:user_status`).
// - Such a user can't sign in natively: the pre authentication trigger
//   (sign-in-guard-handler.ts) refuses every password, email-code and passkey
//   sign-in by one. So a Managed Login token for them always comes from a
//   provider sign-in, and Cognito applies the attribute mapping (email and
//   the claim) before this trigger runs. Managed Login's own sign-ins are
//   also TokenGeneration_HostedAuth, which is why the guard is needed.
//
// Accepted risk: if a provider sign-in left the claim out, Cognito would keep
// the attribute's last value, which the user may have written. Google and
// Apple always send email_verified with the email scope, so this doesn't
// happen with them; a missing attribute (never mapped) counts as unverified.
//
// A native user linked to a provider (account-link-handler.ts,
// supply-checkout-0b1) doesn't meet the second condition and is left alone:
// its email was verified with Cognito's own code, and a Managed Login sign-in
// for it may not have gone through the provider. The linking trigger reuses
// providerSaysVerified(), since Cognito puts the mapped attributes in the pre
// sign-up event too.
//
// What it does: email_verified becomes "true" when the provider says the email
// is verified (Google sends a boolean, Apple a boolean or the string
// "true"/"false"; mapped into a string attribute, both arrive as text), and
// "false" when the provider says it isn't. Nothing is written when it
// already matches. A failed update is logged and the sign-in goes ahead; the
// next sign-in tries again. A failed promotion leaves the user unverified
// (safe); a failed downgrade leaves them verified until the next sign-in, and
// is logged as its own outcome, "downgrade-failed", at error level.
//
// Logs carry the provider and the outcome, never the email or the username
// (which contains the provider's user ID).

import type { PreTokenGenerationTriggerEvent } from "aws-lambda";
import type { Observability } from "../observability/index.js";
import type { UpdateUserAttributes } from "./cognito-admin.js";
import { FEDERATED_PROVIDERS, type FederatedProvider, PROVIDER_EMAIL_VERIFIED_ATTRIBUTE } from "./names.js";

export interface EmailVerifiedDeps {
  readonly updateUserAttributes: UpdateUserAttributes;
  readonly obs: Observability;
}

/** True only for the provider's claim saying yes: boolean true or the text "true" (any case, trimmed). */
export function providerSaysVerified(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

interface Identity {
  readonly providerName?: unknown;
  readonly providerType?: unknown;
  readonly userId?: unknown;
}

/**
 * The provider a federated-only user signs in with: the Google or Apple entry
 * in `identities` (Cognito's JSON list) whose `<providerName>_<userId>` is the
 * username. Undefined for anyone else, including a native user with a linked
 * provider. Usernames compare case-insensitively, as the pool does.
 */
export function federatedProvider(userName: unknown, identities: unknown): FederatedProvider | undefined {
  if (typeof userName !== "string" || typeof identities !== "string") return undefined;
  let list: unknown;
  try {
    list = JSON.parse(identities);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const name = userName.toLowerCase();
  for (const entry of list as Identity[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const provider = FEDERATED_PROVIDERS.find((p) => p === entry.providerName && p === entry.providerType);
    if (provider && typeof entry.userId === "string" && entry.userId !== "" && `${provider}_${entry.userId}`.toLowerCase() === name) return provider;
  }
  return undefined;
}

export type Outcome =
  | "not-provider-sign-in"
  | "not-federated"
  | "no-email"
  | "unchanged"
  | "verified"
  | "unverified"
  /** Couldn't mark verified: the user stays unverified. */
  | "failed"
  /** Couldn't mark unverified: the user stays verified until a later sign-in succeeds. */
  | "downgrade-failed";

export function createEmailVerifiedHandler(deps: EmailVerifiedDeps) {
  const handle = async (event: PreTokenGenerationTriggerEvent): Promise<{ outcome: Outcome; provider?: FederatedProvider }> => {
    if (event.triggerSource !== "TokenGeneration_HostedAuth") return { outcome: "not-provider-sign-in" };
    const attributes = event.request?.userAttributes ?? {};
    const provider = federatedProvider(event.userName, attributes.identities);
    if (!provider || attributes["cognito:user_status"] !== "EXTERNAL_PROVIDER") return { outcome: "not-federated" };
    if (!attributes.email) return { outcome: "no-email", provider };

    const verified = providerSaysVerified(attributes[PROVIDER_EMAIL_VERIFIED_ATTRIBUTE]);
    if (verified === (attributes.email_verified === "true")) return { outcome: "unchanged", provider };
    try {
      await deps.updateUserAttributes(event.userPoolId, event.userName, { email_verified: verified ? "true" : "false" });
    } catch (error) {
      const outcome = verified ? "failed" : "downgrade-failed";
      deps.obs.logger.error(verified ? "Couldn't mark email verified" : "Couldn't mark email unverified; it stays verified", {
        provider,
        outcome,
        error: (error as Error).message,
      });
      return { outcome, provider };
    }
    return { outcome: verified ? "verified" : "unverified", provider };
  };

  return async (event: PreTokenGenerationTriggerEvent): Promise<PreTokenGenerationTriggerEvent> => {
    const { outcome, provider } = await handle(event);
    deps.obs.logger.info("Federated email", { triggerSource: String(event.triggerSource), outcome, ...(provider ? { provider } : {}) });
    // The tokens are unchanged: the API reads email_verified from Cognito (GetUser), not from a token
    return event;
  };
}
