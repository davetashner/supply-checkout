// Lambda entry point for the welcome email function (see welcome-handler.ts).

import { createDb, TEST_MAIL_DOMAIN_ENV, testMailDomain } from "../data/index.js";
import { cognitoAccounts } from "../identity/cognito-accounts.js";
import { createObservability, withObservability } from "../observability/index.js";
import { mailerFromEnv } from "./mailer.js";
import { WELCOME_ENV } from "./names.js";
import { createWelcomeHandler } from "./welcome-handler.js";

const obs = createObservability({ service: "welcome-email" });
const need = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const userPoolId = need(WELCOME_ENV.userPoolId);
export const handler = withObservability(
  obs,
  createWelcomeHandler({
    // The pool is in the function's own region (the primary region)
    findAccount: cognitoAccounts({ region: obs.region, userPoolId, timeoutMs: 5_000 }),
    db: createDb(),
    mailer: mailerFromEnv(),
    obs,
    supportAddress: need(WELCOME_ENV.supportAddress),
    testMailDomain: testMailDomain(process.env[TEST_MAIL_DOMAIN_ENV]),
  }),
);
