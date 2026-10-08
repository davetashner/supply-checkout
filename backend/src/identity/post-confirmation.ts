// Lambda entry point for the user pool's post confirmation trigger (see post-confirmation-handler.ts).

import { createDb, recordPasswordReset } from "../data/index.js";
import { createObservability, withObservability } from "../observability/index.js";
import { noticeAddressRecorder } from "./notice-address.js";
import { WELCOME_FUNCTION_ENV } from "../email/names.js";
import { globalSignOut } from "./cognito-admin.js";
import { SECURITY_NOTICES_FUNCTION_ENV } from "./names.js";
import { createPostConfirmationHandler, RECORD_RESET_TIMEOUT_MS, SIGN_OUT_TIMEOUT_MS, WELCOME_INVOKE_TIMEOUT_MS } from "./post-confirmation-handler.js";
import { eventInvoker, welcomeInvoker } from "./welcome-invoke.js";

/** Each DynamoDB call's timeout: two calls take at most 2 seconds of the 5 Cognito gives a trigger, leaving room for a cold start (the welcome email's invoke has its own budget). */
const CALL_TIMEOUT_MS = 1_000;

const obs = createObservability({ service: "sign-in" });
// The app table (TABLE_NAME), with the trigger's own role: GetItem of a user's
// NOTICE_ADDRESS item, when it was recorded only, and recording it; and recording a
// confirmed password reset's time (PASSWORD_RESET, update only) (identity stack)
const db = createDb();
// The welcome email function, which the role may invoke and nothing else of Lambda's (identity stack)
const welcomeFunction = process.env[WELCOME_FUNCTION_ENV];
// The security notices function, which the role may invoke too, for a confirmed password reset's notice (identity stack)
const securityNoticesFunction = process.env[SECURITY_NOTICES_FUNCTION_ENV];
export const handler = withObservability(
  obs,
  createPostConfirmationHandler({
    rememberNoticeAddress: noticeAddressRecorder(db, { timeoutMs: CALL_TIMEOUT_MS }),
    obs,
    ...(welcomeFunction ? { sendWelcome: welcomeInvoker({ region: obs.region, functionName: welcomeFunction, timeoutMs: WELCOME_INVOKE_TIMEOUT_MS }) } : {}),
    // When a password was reset, which the API compares with each session's auth_time (supply-checkout-6uw.33)
    recordReset: (userId, at) => recordPasswordReset(db, userId, at, { timeoutMs: RECORD_RESET_TIMEOUT_MS }),
    // AdminUserGlobalSignOut after a confirmed password reset, on the app pool only (the role's grant); the pool is in the trigger's region
    signOutEverywhere: globalSignOut({ region: obs.region, timeoutMs: SIGN_OUT_TIMEOUT_MS }),
    ...(securityNoticesFunction
      ? { sendResetNotice: eventInvoker({ region: obs.region, functionName: securityNoticesFunction, timeoutMs: WELCOME_INVOKE_TIMEOUT_MS }) }
      : {}),
  }),
);
