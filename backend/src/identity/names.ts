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
