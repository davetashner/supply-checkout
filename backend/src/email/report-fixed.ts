// Lambda entry point for the scheduled "your report is fixed" email (see report-fixed-handler.ts).

import { createDb, TEST_MAIL_DOMAIN_ENV, testMailDomain } from "../data/index.js";
import { cognitoAccounts } from "../identity/cognito-accounts.js";
import { createObservability, withObservability } from "../observability/index.js";
import { mailerFromEnv } from "./mailer.js";
import { REPORT_FIXED_ENV } from "./names.js";
import { createReportFixedHandler } from "./report-fixed-handler.js";

const obs = createObservability({ service: "report-fixed-email" });
const userPoolId = process.env[REPORT_FIXED_ENV.userPoolId];
if (!userPoolId) throw new Error(`${REPORT_FIXED_ENV.userPoolId} is not set`);
export const handler = withObservability(
  obs,
  createReportFixedHandler({
    // The pool is in the function's own region (the primary region)
    findAccount: cognitoAccounts({ region: obs.region, userPoolId, timeoutMs: 5_000 }),
    db: createDb(),
    mailer: mailerFromEnv(),
    obs,
    testMailDomain: testMailDomain(process.env[TEST_MAIL_DOMAIN_ENV]),
  }),
);
