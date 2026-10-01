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

/**
 * The Secrets Manager secret holding the ops function's own Stripe restricted
 * key (`rk_<mode>_…`, ADR 0015 §2, supply-checkout-6uw.4): Subscriptions:
 * Read and Invoices: Read, nothing else. Promo campaigns
 * (supply-checkout-8jc.8) add Coupons and Promotion Codes: Write when they
 * ship. Separate from stripeSecretName so the ops function never holds the
 * billing functions' full key, and only the ops function may read it. The
 * owner creates the key in the Stripe Dashboard and stores it here
 * (docs/infrastructure.md, "Operators"); nothing in the repo does.
 */
export const stripeOpsKeySecretName = (envName: string, mode: StripeMode) => `supply-checkout/${envName}/stripe/${mode}-ops-restricted-key`;

/** Environment variables the ops function reads for Stripe (with STRIPE_ENV.mode; set by the api stack). */
export const OPS_STRIPE_ENV = {
  /** The ops restricted key's secret, by name (stripeOpsKeySecretName). */
  secretId: "STRIPE_OPS_KEY_SECRET_ID",
} as const;

/** Environment variables the webhook and the billing worker read (set by the api stack). */
export const BILLING_ENV = {
  /** The webhook's signing secret, by name (stripeWebhookSecretName). */
  webhookSecretId: "STRIPE_WEBHOOK_SECRET_ID",
  /** The billing events queue's URL, where the webhook puts verified events. */
  queueUrl: "BILLING_QUEUE_URL",
  /** The role the billing worker assumes, tagged with the event, the customer and the team. */
  workerRoleArn: "BILLING_WORKER_ROLE_ARN",
  /** The seat sync queue's URL, where the account function and the nightly reconciliation send seat syncs (billing/seats.ts). */
  seatQueueUrl: "SEAT_QUEUE_URL",
  /** The seat sync queue's ARN: the billing worker takes only seat syncs from it, and only Stripe events from the billing queue. */
  seatQueueArn: "SEAT_QUEUE_ARN",
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
  /**
   * Seat syncs (supply-checkout-l50, billing/seats.ts), from the account
   * function after a membership change and from the nightly reconciliation:
   * FIFO, grouped by Stripe customer. Apart from the billing queue, so only
   * the webhook can put a Stripe event in front of the worker.
   */
  seatQueue: `supply-checkout-${envName}-seat-syncs.fifo`,
  /** Seat syncs the worker couldn't apply after BILLING_MAX_RECEIVES tries. */
  seatDeadLetterQueue: `supply-checkout-${envName}-seat-syncs-dlq.fifo`,
});

/** Tries the worker gets at an event before it goes to the dead-letter queue. */
export const BILLING_MAX_RECEIVES = 5;

/**
 * The most billing worker instances the seat sync queue runs at once (its
 * event source mapping's maximumConcurrency; Lambda's minimum is 2). The
 * nightly reconciliation queues a sync for every subscribed team at once, and
 * each sync makes one or two Stripe calls in a few hundred milliseconds, so 5
 * keeps the fan-out near 20 requests a second: under Stripe's rate limit
 * (100 a second live, 25 in test mode) with room for the billing queue's
 * events, which the mapping doesn't limit.
 */
export const SEAT_SYNC_MAX_CONCURRENCY = 5;

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
