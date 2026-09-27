// Lambda entry point for the Stripe webhook (see webhook-handler.ts). The
// signing secret is read from Secrets Manager on first use and kept for an
// hour (billing/stripe.ts); this function never has the Stripe API key.

import { createObservability, withObservability } from "../observability/index.js";
import { BILLING_ENV, STRIPE_ENV } from "./names.js";
import { sqsBillingQueue } from "./queue.js";
import { cachedSecret, secretsManagerReader, stripeModeFrom, webhookSecretFrom } from "./stripe.js";
import { createWebhookHandler } from "./webhook-handler.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const obs = createObservability({ service: "billing-webhook" });
export const handler = withObservability(
  obs,
  createWebhookHandler({
    secret: cachedSecret({ secretId: required(BILLING_ENV.webhookSecretId), read: secretsManagerReader(process.env.AWS_REGION), make: webhookSecretFrom }),
    queue: sqsBillingQueue(required(BILLING_ENV.queueUrl)),
    mode: stripeModeFrom(process.env[STRIPE_ENV.mode]),
    obs,
  }),
);
