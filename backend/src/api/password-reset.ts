// Lambda entry point for the password reset routes (see password-reset-handler.ts).

import { createDb } from "../data/index.js";
import { eventInvoker } from "../identity/welcome-invoke.js";
import { createObservability, withObservability } from "../observability/index.js";
import { createPasswordResetHandler } from "./password-reset-handler.js";
import { API_ENV } from "./routes.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const obs = createObservability({ service: "password-reset-api" });
const config = {
  clientId: required(API_ENV.clientId),
  issuerUrl: required(API_ENV.issuerUrl),
  allowedOrigins: required(API_ENV.allowedOrigins).split(",").map((s) => s.trim()).filter(Boolean),
};
// The password reset function is in the primary region, beside the user pool and SES
const queue = eventInvoker({ region: required(API_ENV.passwordResetRegion), functionName: required(API_ENV.passwordResetFunction), timeoutMs: 3_000 });
export const handler = withObservability(obs, createPasswordResetHandler({ config, obs, queue, db: createDb() }));
