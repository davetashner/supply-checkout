// Lambda entry point for the billing API (see billing-handler.ts). The STS
// client, the per-team DynamoDB handles, the logger and the Stripe client
// (read from Secrets Manager on first use, billing/stripe.ts) are kept per
// container, outside the handler.

import { priceResolver } from "../billing/prices.js";
import { cachedStripe, createStripe, secretsManagerReader, STRIPE_ENV, stripeModeFrom } from "../billing/stripe.js";
import { createObservability, withObservability } from "../observability/index.js";
import { billingScopedDbs } from "./billing-db.js";
import { createBillingHandler } from "./billing-handler.js";
import { API_ENV } from "./routes.js";

function required(name: string): string {
  const value = process.env[name];
  // Fail closed: without the scoped role there is no IAM layer of isolation
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const stripe = cachedStripe({
  secretId: required(STRIPE_ENV.secretId),
  mode: stripeModeFrom(process.env[STRIPE_ENV.mode]),
  read: secretsManagerReader(process.env.AWS_REGION),
  create: createStripe,
});
const obs = createObservability({ service: "billing-api" });
export const handler = withObservability(
  obs,
  createBillingHandler({
    dbFor: billingScopedDbs({ roleArn: required(API_ENV.billingRoleArn) }),
    stripe,
    priceFor: priceResolver(stripe),
    issuerUrl: required(API_ENV.issuerUrl),
    appUrl: required(API_ENV.appUrl),
    obs,
  }),
);
