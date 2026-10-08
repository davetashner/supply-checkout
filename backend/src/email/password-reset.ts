// Lambda entry point for the password reset function (see password-reset-handler.ts).

import { createDb } from "../data/index.js";
import { cognitoResetLookup } from "../identity/reset-lookup.js";
import { createObservability, withObservability } from "../observability/index.js";
import { mailerFromEnv } from "./mailer.js";
import { PASSWORD_RESET_ENV, WELCOME_ENV } from "./names.js";
import { createPasswordResetHandler } from "./password-reset-handler.js";

const obs = createObservability({ service: "password-reset" });
const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
export const handler = withObservability(
  obs,
  createPasswordResetHandler({
    // The pool is in the function's own region (the primary region)
    lookup: cognitoResetLookup({ region: obs.region, userPoolId: need(PASSWORD_RESET_ENV.userPoolId), clientId: need(PASSWORD_RESET_ENV.clientId) }),
    db: createDb(),
    mailer: mailerFromEnv(),
    obs,
    supportAddress: need(WELCOME_ENV.supportAddress),
  }),
);
