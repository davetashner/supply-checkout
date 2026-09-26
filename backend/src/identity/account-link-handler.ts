// The pre sign-up trigger that links a first Google or Apple sign-in to an
// existing account with the same email (supply-checkout-0b1).
//
// Without it, a Google or Apple sign-in whose email already has an account
// (email code, password or passkey) makes a second, federated-only user with
// no team. With it, the provider identity is linked to the existing native
// user with AdminLinkProviderForUser, so that sign-in and every later one land
// in the same user (same `sub`), and so the same teams.
//
// Cognito runs pre sign-up for a provider identity (PreSignUp_ExternalProvider)
// only the first time that identity signs in, before it creates a user. Every
// other trigger source (native sign-up, AdminCreateUser) passes through
// unchanged: this trigger never confirms or verifies anyone.
//
// When it links. All of these, otherwise the sign-up goes ahead as before and
// makes a separate federated-only user:
//
// - The provider says the email is verified. The claim arrives mapped into
//   `custom:idp_email_verified` (see names.ts). Users can write that attribute,
//   but here the user doesn't exist yet: the value is the provider's, fresh
//   from this sign-in. providerSaysVerified() is the email_verified trigger's
//   own test.
// - The event's username is `<Google|SignInWithApple>_<provider user ID>`,
//   which is how Cognito names a provider sign-up; the ID is what gets linked.
// - The email is a plausible address with no quotation mark or backslash (it
//   goes into a ListUsers filter). An Apple private relay address
//   (@privaterelay.appleid.com) links only for Sign in with Apple: the relay is
//   Apple's, a relay address is unique to one Apple ID and this app, and only
//   Apple can vouch for it. A person who hides their email from Apple gets a
//   relay address that won't match their existing account, so they get a
//   separate account (see the PR for the follow-up).
// - Exactly one native user (not federated-only, see isFederatedOnly()) has
//   that email, compared case-insensitively. Several native users sharing it,
//   or more than one page of users, is refused rather than guessed at.
// - That user is CONFIRMED, enabled, and its email_verified is "true": its
//   address was proven with Cognito's own code. An unconfirmed or unverified
//   native user is never a target, so signing up natively with someone
//   else's address can't capture their later Google or Apple sign-in.
// - That user has no identity from the same provider linked already (Cognito
//   links one identity per provider to a user).
//
// After linking, the trigger fails the sign-up on purpose with linkedError(),
// which names only the provider. Cognito would otherwise try to create the
// federated user it was signing up and fail with "Already found an entry for
// username"; failing first is deterministic, and no duplicate user is made.
// Cognito sends the person back to the app with the error in
// `error_description`, and the web app (src/aws/session.js) starts the
// provider sign-in again once, straight to that provider
// (`identity_provider`). The second sign-in finds the linked identity and
// lands in the existing user, without a pre sign-up.
//
// When ListUsers or AdminLinkProviderForUser fails, the sign-up fails too
// (FAILED_ERROR): going ahead would make a separate account for good, since
// pre sign-up doesn't run again for that identity.
//
// Linked users afterwards: the username is still the native one, and Cognito
// keeps the user CONFIRMED, so the pre authentication guard lets them sign in
// natively too (email code, password, passkey), and the email_verified trigger
// leaves their email_verified alone (it was verified by Cognito). Cognito does
// apply the provider's attribute mapping to the linked user at each provider
// sign-in, so a changed provider email would overwrite `email`; keeping
// email_verified right then is supply-checkout-kgw.
//
// Logs carry the provider and the outcome, never the email, a username or the
// provider's user ID.

import type { PreSignUpTriggerEvent } from "aws-lambda";
import type { Observability } from "../observability/index.js";
import type { LinkProviderForUser, ListUsersByEmail, PoolUser } from "./cognito-admin.js";
import { providerSaysVerified } from "./email-verified-handler.js";
import { FEDERATED_PROVIDERS, type FederatedProvider, PROVIDER_EMAIL_VERIFIED_ATTRIBUTE } from "./names.js";
import { isFederatedOnly } from "./sign-in-guard-handler.js";

export interface AccountLinkDeps {
  readonly listUsersByEmail: ListUsersByEmail;
  readonly linkProviderForUser: LinkProviderForUser;
  readonly obs: Observability;
}

/** The marker the web app looks for in `error_description` to sign in again with the provider. */
export const LINKED_MARKER = "ACCOUNT_LINKED";
/** Thrown after linking: Cognito shows it as "PreSignUp failed with error ACCOUNT_LINKED:<provider>." */
export const linkedError = (provider: FederatedProvider) => `${LINKED_MARKER}:${provider}`;
/** Thrown when Cognito couldn't be asked or couldn't link: the sign-in fails and can be tried again. */
export const FAILED_ERROR = "Sign-in couldn't finish. Try again.";

const RELAY_DOMAIN = "privaterelay.appleid.com";
// A local part, an @ and a dotted domain, with none of the characters a ListUsers filter would need escaped
const EMAIL = /^[^\s"\\@]+@[^\s"\\@]+\.[^\s"\\@]+$/;
const PROVIDER_USER_ID = /^[A-Za-z0-9._-]{1,255}$/;

export type Outcome =
  | "not-provider-sign-up"
  | "unknown-provider"
  | "unverified-email"
  | "unusable-email"
  | "relay-email"
  | "no-account"
  | "ambiguous"
  | "not-eligible"
  | "already-linked"
  | "linked"
  | "lookup-failed"
  | "link-failed";

/** The provider and its user ID from a provider sign-up's username, `<providerName>_<userId>` (any case). */
export function providerIdentity(userName: unknown): { provider: FederatedProvider; userId: string } | undefined {
  if (typeof userName !== "string") return undefined;
  const at = userName.indexOf("_");
  if (at < 0) return undefined;
  const prefix = userName.slice(0, at).toLowerCase();
  const provider = FEDERATED_PROVIDERS.find((p) => p.toLowerCase() === prefix);
  const userId = userName.slice(at + 1);
  return provider && PROVIDER_USER_ID.test(userId) ? { provider, userId } : undefined;
}

/** True when `identities` (Cognito's JSON list) already has an identity from `provider`. */
function hasProvider(identities: string | undefined, provider: FederatedProvider): boolean {
  try {
    const list: unknown = JSON.parse(identities ?? "[]");
    return Array.isArray(list) && list.some((e: { providerName?: unknown } | null) => e?.providerName === provider);
  } catch {
    // Unreadable: don't guess that linking would succeed
    return true;
  }
}

/** Whether `user` can have a provider identity linked to it for `email`. */
function eligible(user: PoolUser, provider: FederatedProvider): Outcome | undefined {
  if (user.status !== "CONFIRMED" || !user.enabled || user.attributes.email_verified !== "true") return "not-eligible";
  if (hasProvider(user.attributes.identities, provider)) return "already-linked";
  return undefined;
}

export function createAccountLinkHandler(deps: AccountLinkDeps) {
  const handle = async (event: PreSignUpTriggerEvent): Promise<{ outcome: Outcome; provider?: FederatedProvider }> => {
    if (event.triggerSource !== "PreSignUp_ExternalProvider") return { outcome: "not-provider-sign-up" };
    const identity = providerIdentity(event.userName);
    if (!identity) return { outcome: "unknown-provider" };
    const { provider, userId } = identity;
    const attributes: Record<string, string | undefined> = event.request?.userAttributes ?? {};
    if (!providerSaysVerified(attributes[PROVIDER_EMAIL_VERIFIED_ATTRIBUTE])) return { outcome: "unverified-email", provider };
    const email = attributes.email?.trim() ?? "";
    if (email.length > 254 || !EMAIL.test(email)) return { outcome: "unusable-email", provider };
    if (email.toLowerCase().endsWith(`@${RELAY_DOMAIN}`) && provider !== "SignInWithApple") return { outcome: "relay-email", provider };

    let found: Awaited<ReturnType<ListUsersByEmail>>;
    try {
      found = await deps.listUsersByEmail(event.userPoolId, email);
    } catch (error) {
      deps.obs.logger.error("Couldn't look for an account to link", { provider, outcome: "lookup-failed", error: (error as Error).message });
      throw new Error(FAILED_ERROR, { cause: error });
    }
    const wanted = email.toLowerCase();
    const native = found.users.filter((u) => u.attributes.email?.toLowerCase() === wanted && !isFederatedOnly(u.username, { ...u.attributes, "cognito:user_status": u.status }));
    if (found.more || native.length > 1) return { outcome: "ambiguous", provider };
    const [target] = native;
    if (!target) return { outcome: "no-account", provider };
    const refused = eligible(target, provider);
    if (refused) return { outcome: refused, provider };

    try {
      await deps.linkProviderForUser(event.userPoolId, target.username, provider, userId);
    } catch (error) {
      deps.obs.logger.error("Couldn't link the sign-in to the existing account", { provider, outcome: "link-failed", error: (error as Error).message });
      throw new Error(FAILED_ERROR, { cause: error });
    }
    return { outcome: "linked", provider };
  };

  return async (event: PreSignUpTriggerEvent): Promise<LinkResult> => {
    const { outcome, provider } = await handle(event);
    deps.obs.logger.info("Account link", { triggerSource: String(event.triggerSource), outcome, ...(provider ? { provider } : {}) });
    return outcome === "linked" && provider ? { linked: provider } : { event };
  };
}

/** What the handler decided: go ahead with the sign-up unchanged, or stop it because the identity is now linked. */
export type LinkResult = { readonly event: PreSignUpTriggerEvent } | { readonly linked: FederatedProvider };

/**
 * The answer for Cognito. After a link it throws linkedError(), so Cognito
 * doesn't try to create the user it was signing up; the retry lands in the
 * linked user. Otherwise the event goes back unchanged: nothing is confirmed
 * or verified here. Kept outside withObservability, which would log the
 * deliberate failure as an unhandled error.
 */
export function answerCognito(result: LinkResult): PreSignUpTriggerEvent {
  if ("linked" in result) throw new Error(linkedError(result.linked));
  return result.event;
}
