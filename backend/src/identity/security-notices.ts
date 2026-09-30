// Lambda entry point for the security notices sent for changes made directly
// against Cognito (see security-notices-handler.ts).

import { createDb } from "../data/index.js";
import { mailerFromEnv } from "../email/mailer.js";
import { createObservability, withObservability } from "../observability/index.js";
import { cognitoAccounts } from "./cognito-accounts.js";
import { SECURITY_NOTICES_ENV } from "./names.js";
import { createSecurityNoticesHandler } from "./security-notices-handler.js";

const obs = createObservability({ service: "security-notices" });
const userPoolId = process.env[SECURITY_NOTICES_ENV.userPoolId];
if (!userPoolId) throw new Error(`${SECURITY_NOTICES_ENV.userPoolId} is not set`);
export const handler = withObservability(
  obs,
  createSecurityNoticesHandler({
    userPoolId,
    // The pool is in the function's own region (the primary region)
    findAccount: cognitoAccounts({ region: obs.region, userPoolId, timeoutMs: 5_000 }),
    db: createDb(),
    mailer: mailerFromEnv(),
    obs,
  }),
);
