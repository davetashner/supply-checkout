// Lambda entry point for the user pool's pre token generation trigger (see email-verified-handler.ts).

import { createDb, provenEmailHash } from "../data/index.js";
import { createObservability, withObservability } from "../observability/index.js";
import { cognitoAdmin } from "./cognito-admin.js";
import { WELCOME_FUNCTION_ENV } from "../email/names.js";
import { CALL_TIMEOUT_MS, createEmailVerifiedHandler, logCorrelation, NOTICE_CALL_TIMEOUT_MS, WELCOME_CALL_TIMEOUT_MS } from "./email-verified-handler.js";
import { LOG_CORRELATION_KEY_ENV } from "./names.js";
import { noticeAddressRecorder } from "./notice-address.js";
import { welcomeInvoker } from "./welcome-invoke.js";

const obs = createObservability({ service: "sign-in" });
const updateUserAttributes = cognitoAdmin({ region: obs.region, timeoutMs: CALL_TIMEOUT_MS });
// The app table (TABLE_NAME), with the trigger's own role: GetItem of a user's
// VERIFIED_EMAIL item, its hash only, and of their NOTICE_ADDRESS item, when it
// was recorded only; and recording that address (identity stack)
const db = createDb();
const key = process.env[LOG_CORRELATION_KEY_ENV];
// The welcome email function, which the role may invoke and nothing else of Lambda's (identity stack)
const welcomeFunction = process.env[WELCOME_FUNCTION_ENV];
export const handler = withObservability(
  obs,
  createEmailVerifiedHandler({
    updateUserAttributes,
    provenEmailHash: (sub) => provenEmailHash(db, sub, { timeoutMs: CALL_TIMEOUT_MS }),
    rememberNoticeAddress: noticeAddressRecorder(db, { timeoutMs: NOTICE_CALL_TIMEOUT_MS }),
    obs,
    ...(key ? { correlate: logCorrelation(key) } : {}),
    ...(welcomeFunction ? { sendWelcome: welcomeInvoker({ region: obs.region, functionName: welcomeFunction, timeoutMs: WELCOME_CALL_TIMEOUT_MS }) } : {}),
  }),
);
