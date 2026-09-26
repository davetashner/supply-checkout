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
// - The provider is authoritative for the address, not just someone who once
//   checked it. A Google or Apple account can carry an address its owner
//   verified years ago and no longer controls (a former employee's
//   purchasing address at a customer's domain); the provider still says "verified", but
//   linking on that would hand the current owner's account to them. So
//   (authoritative()):
//   - Google: @gmail.com or @googlemail.com, or a Google Workspace account
//     whose `hd` claim (mapped into `custom:idp_hd`, fresh here for the same
//     reason as the flag) equals the email's domain: the domain's own Google
//     tenant owns that mailbox.
//   - Apple: an Apple private relay address (@privaterelay.appleid.com, unique
//     to one Apple ID and this app), or @icloud.com, @me.com or @mac.com.
//   Anyone else gets a separate account; linking those is the settings-based
//   flow (supply-checkout-b4g), where the person is already signed in.
// - The event's username is `<Google|SignInWithApple>_<provider user ID>`,
//   which is how Cognito names a provider sign-up; the ID is what gets linked.
// - The email is a plausible ASCII address with no quotation mark or
//   backslash (it goes into a ListUsers filter). Emails and domains are
//   compared after lowering ASCII letters only, so no Unicode case folding
//   (the Kelvin sign to "k", say) can make two addresses match.
// - Exactly one native user (not federated-only, see isFederatedOnly()) has
//   that email. Several native users sharing it, or more than one page of
//   users, is refused rather than guessed at.
// - That user is CONFIRMED, enabled, and its email_verified is "true": its
//   address was proven with Cognito's own code. An unconfirmed or unverified
//   native user is never a target, so signing up natively with someone
//   else's address can't capture their later Google or Apple sign-in.
// - That user has no identity from the same provider linked already (Cognito
//   links one identity per provider to a user).
// - If that user already has a Google or Apple identity linked, its email is
//   still the one recorded when that identity was linked
//   (`custom:linked_email`). Cognito rewrites a linked user's `email` from the
//   provider at every provider sign-in and leaves email_verified "true", so an
//   account whose linked provider email changed to someone else's address
//   mustn't capture that person's first sign-in. The rest of keeping a linked
//   user's email_verified right is supply-checkout-kgw.
//
// Linking records the email in `custom:linked_email` (which no IdP maps and no
// client can write) first, then calls AdminLinkProviderForUser. If recording
// works and linking doesn't, the recorded email matches the user's email and
// no identity is linked, so nothing changes; if a link ever exists without a
// matching record, the user stops being a target (safe).
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
// When a Cognito call fails, the sign-up fails too (FAILED_ERROR): going ahead
// would make a separate account for good, since pre sign-up doesn't run again
// for that identity.
//
// Linked users afterwards: the username is still the native one, and Cognito
// keeps the user CONFIRMED, so the pre authentication guard lets them sign in
// natively too (email code, password, passkey), and the email_verified trigger
// leaves their email_verified alone (it was verified by Cognito).
//
// Logs carry the provider and the outcome, never the email, a username or the
// provider's user ID.

import type { PreSignUpTriggerEvent } from "aws-lambda";
import type { Observability } from "../observability/index.js";
import type { LinkProviderForUser, ListUsersByEmail, PoolUser, UpdateUserAttributes } from "./cognito-admin.js";
import { providerSaysVerified } from "./email-verified-handler.js";
import {
  FEDERATED_PROVIDERS,
  type FederatedProvider,
  LINKED_EMAIL_ATTRIBUTE,
  PROVIDER_EMAIL_VERIFIED_ATTRIBUTE,
  PROVIDER_HOSTED_DOMAIN_ATTRIBUTE,
} from "./names.js";
import { isFederatedOnly } from "./sign-in-guard-handler.js";

export interface AccountLinkDeps {
  readonly listUsersByEmail: ListUsersByEmail;
  readonly updateUserAttributes: UpdateUserAttributes;
  readonly linkProviderForUser: LinkProviderForUser;
  readonly obs: Observability;
}

/** The marker the web app looks for in `error_description` to sign in again with the provider. */
export const LINKED_MARKER = "ACCOUNT_LINKED";
/** Thrown after linking: Cognito shows it as "PreSignUp failed with error ACCOUNT_LINKED:<provider>." */
export const linkedError = (provider: FederatedProvider) => `${LINKED_MARKER}:${provider}`;
/** Thrown when Cognito couldn't be asked or couldn't link: the sign-in fails and can be tried again. */
export const FAILED_ERROR = "Sign-in couldn't finish. Try again.";

/** Domains whose mailboxes the provider itself runs. */
const AUTHORITATIVE_DOMAINS: Readonly<Record<FederatedProvider, readonly string[]>> = {
  Google: ["gmail.com", "googlemail.com"],
  SignInWithApple: ["privaterelay.appleid.com", "icloud.com", "me.com", "mac.com"],
};
// Printable ASCII only, with none of the characters a ListUsers filter would
// need escaped (space, ", \), one @ and a dotted domain
const ADDRESS_CHAR = "[\\x21\\x23-\\x3f\\x41-\\x5b\\x5d-\\x7e]";
const EMAIL = new RegExp(`^${ADDRESS_CHAR}+@${ADDRESS_CHAR}+\\.${ADDRESS_CHAR}+$`);
const PROVIDER_USER_ID = /^[A-Za-z0-9._-]{1,255}$/;

/** Lowers A–Z only: no Unicode case folding, so only ASCII-identical addresses match. */
export const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

export type Outcome =
  | "not-provider-sign-up"
  | "unknown-provider"
  | "unverified-email"
  | "unusable-email"
  | "not-authoritative"
  | "no-account"
  | "ambiguous"
  | "not-eligible"
  | "already-linked"
  | "email-changed"
  | "linked"
  | "lookup-failed"
  | "record-failed"
  | "link-failed";

/** The provider and its user ID from a provider sign-up's username, `<providerName>_<userId>` (any case). */
export function providerIdentity(userName: unknown): { provider: FederatedProvider; userId: string } | undefined {
  if (typeof userName !== "string") return undefined;
  const at = userName.indexOf("_");
  if (at < 0) return undefined;
  const prefix = asciiLower(userName.slice(0, at));
  const provider = FEDERATED_PROVIDERS.find((p) => asciiLower(p) === prefix);
  const userId = userName.slice(at + 1);
  return provider && PROVIDER_USER_ID.test(userId) ? { provider, userId } : undefined;
}

/**
 * Whether `provider` runs the mailbox of `email` (already lowered, and valid):
 * Gmail, or a Workspace account whose `hd` is the email's domain, for Google;
 * a private relay or iCloud address for Apple.
 */
export function authoritative(provider: FederatedProvider, email: string, hostedDomain: string | undefined): boolean {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (AUTHORITATIVE_DOMAINS[provider].includes(domain)) return true;
  return provider === "Google" && hostedDomain !== undefined && asciiLower(hostedDomain.trim()) === domain;
}

/** The Google and Apple providers in `identities` (Cognito's JSON list); undefined when it can't be read. */
function linkedProviders(identities: string | undefined): string[] | undefined {
  try {
    const list: unknown = JSON.parse(identities ?? "[]");
    if (!Array.isArray(list)) return undefined;
    return list
      .map((e: { providerName?: unknown } | null) => e?.providerName)
      .filter((p): p is string => typeof p === "string" && (FEDERATED_PROVIDERS as readonly string[]).includes(p));
  } catch {
    return undefined;
  }
}

/** Why `user` can't have `provider` linked to it, if it can't. */
function refusal(user: PoolUser, provider: FederatedProvider, email: string): Outcome | undefined {
  if (user.status !== "CONFIRMED" || !user.enabled || user.attributes.email_verified !== "true") return "not-eligible";
  const linked = linkedProviders(user.attributes.identities);
  // Unreadable: don't guess that linking would succeed
  if (!linked || linked.includes(provider)) return "already-linked";
  if (linked.length && asciiLower(user.attributes[LINKED_EMAIL_ATTRIBUTE] ?? "") !== email) return "email-changed";
  return undefined;
}

export function createAccountLinkHandler(deps: AccountLinkDeps) {
  const fail = (message: string, provider: FederatedProvider, outcome: Outcome, error: unknown): never => {
    deps.obs.logger.error(message, { provider, outcome, error: (error as Error).message });
    throw new Error(FAILED_ERROR, { cause: error });
  };

  const handle = async (event: PreSignUpTriggerEvent): Promise<{ outcome: Outcome; provider?: FederatedProvider }> => {
    if (event.triggerSource !== "PreSignUp_ExternalProvider") return { outcome: "not-provider-sign-up" };
    const identity = providerIdentity(event.userName);
    if (!identity) return { outcome: "unknown-provider" };
    const { provider, userId } = identity;
    const attributes: Record<string, string | undefined> = event.request?.userAttributes ?? {};
    if (!providerSaysVerified(attributes[PROVIDER_EMAIL_VERIFIED_ATTRIBUTE])) return { outcome: "unverified-email", provider };
    const given = attributes.email?.trim() ?? "";
    if (given.length > 254 || !EMAIL.test(given)) return { outcome: "unusable-email", provider };
    const email = asciiLower(given);
    if (!authoritative(provider, email, attributes[PROVIDER_HOSTED_DOMAIN_ATTRIBUTE])) return { outcome: "not-authoritative", provider };

    let found: Awaited<ReturnType<ListUsersByEmail>> = { users: [], more: false };
    try {
      found = await deps.listUsersByEmail(event.userPoolId, given);
    } catch (error) {
      fail("Couldn't look for an account to link", provider, "lookup-failed", error);
    }
    const native = found.users.filter((u) => asciiLower(u.attributes.email ?? "") === email && !isFederatedOnly(u.username, { ...u.attributes, "cognito:user_status": u.status }));
    if (found.more || native.length > 1) return { outcome: "ambiguous", provider };
    const [target] = native;
    if (!target) return { outcome: "no-account", provider };
    const refused = refusal(target, provider, email);
    if (refused) return { outcome: refused, provider };

    try {
      await deps.updateUserAttributes(event.userPoolId, target.username, { [LINKED_EMAIL_ATTRIBUTE]: email });
    } catch (error) {
      fail("Couldn't record the email being linked", provider, "record-failed", error);
    }
    try {
      await deps.linkProviderForUser(event.userPoolId, target.username, provider, userId);
    } catch (error) {
      fail("Couldn't link the sign-in to the existing account", provider, "link-failed", error);
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
