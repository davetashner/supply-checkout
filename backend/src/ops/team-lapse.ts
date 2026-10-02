// Lambda entry point for the scheduled lapsed-team job (see team-lapse-handler.ts).
// The Stripe client is read from Secrets Manager the first time a team needs
// it, and kept per container.

import { STRIPE_ENV } from "../billing/names.js";
import { cachedStripe, createStripe, secretsManagerReader, stripeModeFrom } from "../billing/stripe.js";
import { createDb } from "../data/index.js";
import { mailerFromEnv } from "../email/mailer.js";
import { createObservability, withObservability } from "../observability/index.js";
import { OPS_ENV } from "./names.js";
import { createTeamLapseHandler } from "./team-lapse-handler.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const obs = createObservability({ service: "ops" });
const db = createDb({ tableName: process.env[OPS_ENV.tableName] });
const stripe = cachedStripe({ secretId: required(STRIPE_ENV.secretId), mode: stripeModeFrom(process.env[STRIPE_ENV.mode]), read: secretsManagerReader(process.env.AWS_REGION), create: createStripe });
export const handler = withObservability(obs, createTeamLapseHandler({ db, obs, mailer: mailerFromEnv(), stripe }));
