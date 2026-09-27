// Lambda entry point for the user pool's pre token generation trigger (see email-verified-handler.ts).

import { createObservability, withObservability } from "../observability/index.js";
import { cognitoAdmin } from "./cognito-admin.js";
import { CALL_TIMEOUT_MS, createEmailVerifiedHandler, logCorrelation } from "./email-verified-handler.js";
import { LOG_CORRELATION_KEY_ENV } from "./names.js";

const obs = createObservability({ service: "sign-in" });
const updateUserAttributes = cognitoAdmin({ region: obs.region, timeoutMs: CALL_TIMEOUT_MS });
const key = process.env[LOG_CORRELATION_KEY_ENV];
export const handler = withObservability(obs, createEmailVerifiedHandler({ updateUserAttributes, obs, ...(key ? { correlate: logCorrelation(key) } : {}) }));
