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

/**
 * The Secrets Manager secret holding the signing secret of the Stripe webhook
 * endpoint for an environment and mode (`whsec_…`). The owner creates the
 * endpoint in Stripe after the api stack is deployed, then stores its signing
 * secret here (docs/infrastructure.md, "Billing").
 */
export const stripeWebhookSecretName = (envName: string, mode: StripeMode) => `supply-checkout/${envName}/stripe/${mode}-webhook-secret`;

/** Environment variables the webhook and the billing worker read (set by the api stack). */
export const BILLING_ENV = {
  /** The webhook's signing secret, by name (stripeWebhookSecretName). */
  webhookSecretId: "STRIPE_WEBHOOK_SECRET_ID",
  /** The billing events queue's URL, where the webhook puts verified events. */
  queueUrl: "BILLING_QUEUE_URL",
  /** The role the billing worker assumes, tagged with the event, the customer and the team. */
  workerRoleArn: "BILLING_WORKER_ROLE_ARN",
} as const;

/** Resources the api stack names for billing, so the alarms and docs can refer to them. */
export const billingResourceNames = (envName: string) => ({
  /**
   * Verified Stripe events, in order per Stripe customer (a FIFO message
   * group per customer: one team, one customer, so its subscription's events
   * are applied one at a time) and deduplicated by event ID.
   */
  queue: `supply-checkout-${envName}-billing-events.fifo`,
  /** Events the worker couldn't apply after BILLING_MAX_RECEIVES tries. */
  deadLetterQueue: `supply-checkout-${envName}-billing-events-dlq.fifo`,
});

/** Tries the worker gets at an event before it goes to the dead-letter queue. */
export const BILLING_MAX_RECEIVES = 5;

/**
 * The Stripe events the webhook takes (ADR 0009). Anything else is answered
 * 200 and dropped, so Stripe doesn't retry it. Subscribe the endpoint to
 * exactly these.
 */
export const BILLING_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
] as const;
export type BillingEventType = (typeof BILLING_EVENTS)[number];
