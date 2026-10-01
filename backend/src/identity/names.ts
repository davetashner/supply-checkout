// Names shared by the federated-email trigger and the identity stack
// (infra/lib/stacks/identity-stack.ts). No dependencies: infra imports this
// file directly.

/**
 * The custom attribute Google and Apple map their `email_verified` claim to,
 * without the `custom:` prefix. Cognito requires every IdP-mapped attribute to
 * be writable by the app client, so a user could write this one themselves;
 * the trigger reads it only at a provider sign-in, right after Cognito has
 * overwritten it with the provider's claim (see email-verified-handler.ts).
 */
export const PROVIDER_EMAIL_VERIFIED = "idp_email_verified";

/** The user attribute name, as Cognito puts it in trigger events. */
export const PROVIDER_EMAIL_VERIFIED_ATTRIBUTE = `custom:${PROVIDER_EMAIL_VERIFIED}`;

/** Cognito's provider names for Google and Sign in with Apple (also the identity providers' names in the pool). */
export const FEDERATED_PROVIDERS = ["Google", "SignInWithApple"] as const;
export type FederatedProvider = (typeof FEDERATED_PROVIDERS)[number];

/**
 * The custom attribute Google maps its `hd` claim (the Google Workspace domain)
 * to, without the `custom:` prefix. Like the verified flag it's client-writable
 * because it's mapped, so the linking trigger reads it only at
 * PreSignUp_ExternalProvider, when the user doesn't exist yet and the value is
 * the provider's (see account-link-handler.ts).
 */
export const PROVIDER_HOSTED_DOMAIN = "idp_hd";
export const PROVIDER_HOSTED_DOMAIN_ATTRIBUTE = `custom:${PROVIDER_HOSTED_DOMAIN}`;

/**
 * The email a native user had when the linking trigger linked a Google or Apple
 * identity to it, without the `custom:` prefix. No IdP maps it and the web
 * client can't write it, so only triggers set it (AdminUpdateUserAttributes):
 * the linking trigger, and the email_verified trigger after the person proved a
 * new address with a code through the account API (supply-checkout-ytr2). Cognito rewrites a linked user's `email` from the
 * provider at every provider sign-in; while it differs from this, the user
 * isn't a link target and the email_verified trigger unverifies it
 * (supply-checkout-kgw).
 */
export const LINKED_EMAIL = "linked_email";
export const LINKED_EMAIL_ATTRIBUTE = `custom:${LINKED_EMAIL}`;

/**
 * The group in the operator user pool whose members may call the /ops routes
 * (ADR 0015). It's granted only with `aws cognito-idp admin-add-user-to-group`
 * and an SSO role; no app client or Lambda role can change groups. Being in
 * the pool isn't enough: the ops function checks this group on every request.
 */
export const OPERATORS_GROUP = "operators";

/**
 * Set ("1") on a linked user by the email_verified trigger before it
 * downgrades a changed email at a Managed Login token, and cleared (written
 * empty) in the same AdminUpdateUserAttributes call that sets email_verified
 * to "false", so it's cleared only by a successful downgrade. While it's set,
 * the trigger records no address in `custom:linked_email`, the account API
 * treats the email as unverified, and the linking trigger doesn't link to the
 * user (supply-checkout-0qr8). Like `custom:linked_email`, no IdP maps it and
 * the web client can't write it: only the trigger (or an administrator) sets it.
 */
export const DOWNGRADE_PENDING = "downgrade_pending";
export const DOWNGRADE_PENDING_ATTRIBUTE = `custom:${DOWNGRADE_PENDING}`;

/**
 * The Lambda environment variable holding the key the email_verified trigger
 * uses to turn a user's `sub` into a log correlation handle (an HMAC), so a
 * failure log names no user yet an operator can find them.
 */
export const LOG_CORRELATION_KEY_ENV = "LOG_CORRELATION_KEY";

/**
 * The Cognito calls, recorded by CloudTrail, that the security notices
 * function tells the account about (supply-checkout-8jc.28, 8jc.29), and the
 * notice each sends. A user's own access token can make each of them directly
 * (the web client has the aws.cognito.signin.user.admin scope), not only
 * through the account API, except AdminSetUserMFAPreference, an
 * administrator's call with IAM credentials. The identity rule in the email stack matches these
 * names on the app pool.
 */
export const SECURITY_NOTICE_EVENTS = {
  ChangePassword: "passwordSet",
  VerifySoftwareToken: "twoStepOn",
  SetUserMFAPreference: "twoStepOn",
  // An administrator's (supply-checkout-8jc.14): turning TOTP on or off records or clears when it was turned on
  AdminSetUserMFAPreference: "twoStepOn",
  UpdateUserAttributes: "emailChanged",
  VerifyUserAttribute: "emailChanged",
} as const;

/** The security notices function's environment: the app pool it looks users up in. */
export const SECURITY_NOTICES_ENV = { userPoolId: "USER_POOL_ID" } as const;
