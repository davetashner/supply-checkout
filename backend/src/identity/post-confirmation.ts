// Lambda entry point for the user pool's post confirmation trigger (see post-confirmation-handler.ts).

import { createDb } from "../data/index.js";
import { createObservability, withObservability } from "../observability/index.js";
import { noticeAddressRecorder } from "./notice-address.js";
import { WELCOME_FUNCTION_ENV } from "../email/names.js";
import { createPostConfirmationHandler, WELCOME_INVOKE_TIMEOUT_MS } from "./post-confirmation-handler.js";
import { welcomeInvoker } from "./welcome-invoke.js";

/** Each DynamoDB call's timeout: two calls take at most 2 seconds of the 5 Cognito gives a trigger, leaving room for a cold start (the welcome email's invoke has its own budget). */
const CALL_TIMEOUT_MS = 1_000;

const obs = createObservability({ service: "sign-in" });
// The app table (TABLE_NAME), with the trigger's own role: GetItem of a user's
// NOTICE_ADDRESS item, when it was recorded only, and recording it (identity stack)
const db = createDb();
// The welcome email function, which the role may invoke and nothing else of Lambda's (identity stack)
const welcomeFunction = process.env[WELCOME_FUNCTION_ENV];
export const handler = withObservability(
  obs,
  createPostConfirmationHandler({
    rememberNoticeAddress: noticeAddressRecorder(db, { timeoutMs: CALL_TIMEOUT_MS }),
    obs,
    ...(welcomeFunction ? { sendWelcome: welcomeInvoker({ region: obs.region, functionName: welcomeFunction, timeoutMs: WELCOME_INVOKE_TIMEOUT_MS }) } : {}),
  }),
);
