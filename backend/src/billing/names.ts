// Names the billing code and the CDK app share (infra/lib/config.ts and
// infra/lib/stacks/api-stack.ts import this file), so the secret a function
// reads and the one its IAM policy allows can't drift apart. No imports.

export type StripeMode = "test" | "live";
export const STRIPE_MODES: readonly StripeMode[] = ["test", "live"];

/** Environment variables the billing functions read (set by the api stack). */
export const STRIPE_ENV = {
  /** The Secrets Manager secret with the Stripe secret key, by name. */
  secretId: "STRIPE_SECRET_ID",
  /** `test` or `live`: the key must be of this mode, or the function refuses to use it. */
  mode: "STRIPE_MODE",
} as const;

/**
 * The Secrets Manager secret holding the Stripe secret key for an environment
 * and mode (supply-checkout-dri): the owner stores it; nothing in the repo
 * does. A plain string, or a JSON object with one field that holds the key.
 */
export const stripeSecretName = (envName: string, mode: StripeMode) => `supply-checkout/${envName}/stripe/${mode}-secret-key`;
