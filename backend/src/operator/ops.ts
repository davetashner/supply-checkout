// Lambda entry point for the ops API (see ops-handler.ts). The STS client,
// the operator-access sessions and the logger are built once per container.

import { API_ENV } from "../api/routes.js";
import { BILLING_ENV, OPS_STRIPE_ENV, STRIPE_ENV } from "../billing/names.js";
import { sqsSeatSyncQueue } from "../billing/seat-queue.js";
import { createStripe, secretsManagerReader, stripeModeFrom } from "../billing/stripe.js";
import { createObservability, withObservability } from "../observability/index.js";
import { operatorDirectory } from "./cognito.js";
import { createOpsHandler } from "./ops-handler.js";
import { opsScopedDbs } from "./ops-db.js";
import { lambdaReopener } from "./reopen-client.js";
import { opsStripeClient } from "./stripe-detail.js";

function required(name: string): string {
  const value = process.env[name];
  // Fail closed: without these there is no operator check or no scoped role
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const issuerUrl = required(API_ENV.opsIssuerUrl);
const obs = createObservability({ service: "ops-api" });
export const handler = withObservability(
  obs,
  createOpsHandler({
    dbFor: opsScopedDbs({ roleArn: required(API_ENV.opsRoleArn) }),
    directory: operatorDirectory({ issuerUrl, userPoolId: required(API_ENV.opsUserPoolId) }),
    reopen: lambdaReopener({ functionName: required(API_ENV.opsReopenFunction), region: required("AWS_REGION") }),
    seats: sqsSeatSyncQueue(required(BILLING_ENV.seatQueueUrl)),
    // The ops restricted key, never the billing functions' (stripe-detail.ts): read on first use, so a
    // missing secret only makes a team's Stripe detail unavailable
    stripe: opsStripeClient({ secretId: required(OPS_STRIPE_ENV.secretId), mode: stripeModeFrom(process.env[STRIPE_ENV.mode]), read: secretsManagerReader(process.env.AWS_REGION), create: createStripe }),
    issuerUrl,
    clientId: required(API_ENV.opsClientId),
    obs,
  }),
);
