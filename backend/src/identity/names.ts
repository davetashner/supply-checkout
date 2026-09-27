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
 * the linking trigger, and the email_verified trigger after Cognito verified a new
 * address with a code. Cognito rewrites a linked user's `email` from the
 * provider at every provider sign-in; while it differs from this, the user
 * isn't a link target and the email_verified trigger unverifies it
 * (supply-checkout-kgw).
 */
export const LINKED_EMAIL = "linked_email";
export const LINKED_EMAIL_ATTRIBUTE = `custom:${LINKED_EMAIL}`;
