// Lambda entry point for the user pool's post confirmation trigger (see post-confirmation-handler.ts).

import { createDb } from "../data/index.js";
import { createObservability, withObservability } from "../observability/index.js";
import { noticeAddressRecorder } from "./notice-address.js";
import { createPostConfirmationHandler } from "./post-confirmation-handler.js";

/** Each DynamoDB call's timeout: two calls take at most 2 seconds of the 5 Cognito gives a trigger, leaving room for a cold start. */
const CALL_TIMEOUT_MS = 1_000;

const obs = createObservability({ service: "sign-in" });
// The app table (TABLE_NAME), with the trigger's own role: GetItem of a user's
// NOTICE_ADDRESS item, when it was recorded only, and recording it (identity stack)
const db = createDb();
export const handler = withObservability(obs, createPostConfirmationHandler({ rememberNoticeAddress: noticeAddressRecorder(db, { timeoutMs: CALL_TIMEOUT_MS }), obs }));
