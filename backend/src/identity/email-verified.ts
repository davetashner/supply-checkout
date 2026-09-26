// Lambda entry point for the user pool's pre token generation trigger (see email-verified-handler.ts).

import { createObservability, withObservability } from "../observability/index.js";
import { cognitoAdmin } from "./cognito-admin.js";
import { createEmailVerifiedHandler } from "./email-verified-handler.js";

const obs = createObservability({ service: "sign-in" });
const updateUserAttributes = cognitoAdmin({ region: obs.region });
export const handler = withObservability(obs, createEmailVerifiedHandler({ updateUserAttributes, obs }));
