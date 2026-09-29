// Lambda entry point for the billing worker (worker.ts, worker-handler.ts).
// The Stripe client (read from Secrets Manager on first use), the SES mailer
// and the per-event DynamoDB handles are kept per container.

import { mailerFromEnv } from "../email/mailer.js";
import { createObservability, withObservability } from "../observability/index.js";
import { BILLING_ENV, STRIPE_ENV } from "./names.js";
import { cachedStripe, createStripe, secretsManagerReader, stripeModeFrom } from "./stripe.js";
import { createBillingWorker } from "./worker.js";
import { workerScopedDbs } from "./worker-db.js";
import { createWorkerHandler } from "./worker-handler.js";

function required(name: string): string {
  const value = process.env[name];
  // Fail closed: without the scoped role there is no IAM layer of isolation
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const obs = createObservability({ service: "billing-worker" });
const worker = createBillingWorker({
  dbFor: workerScopedDbs({ roleArn: required(BILLING_ENV.workerRoleArn) }),
  stripe: cachedStripe({ secretId: required(STRIPE_ENV.secretId), mode: stripeModeFrom(process.env[STRIPE_ENV.mode]), read: secretsManagerReader(process.env.AWS_REGION), create: createStripe }),
  mailer: mailerFromEnv(),
  obs,
});
export const handler = withObservability(obs, createWorkerHandler(worker, obs, required(BILLING_ENV.seatQueueArn)));
