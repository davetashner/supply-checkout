// Lambda entry point for the user pool's pre sign-up trigger (see account-link-handler.ts).

import type { Context, PreSignUpTriggerEvent } from "aws-lambda";
import { createObservability, withObservability } from "../observability/index.js";
import { answerCognito, createAccountLinkHandler } from "./account-link-handler.js";
import { cognitoLinking } from "./cognito-admin.js";

const obs = createObservability({ service: "sign-in" });
// Two calls at most, within the 5 seconds Cognito gives a trigger
const { listUsersByEmail, linkProviderForUser } = cognitoLinking({ region: obs.region, timeoutMs: 2_000 });
const decide = withObservability(obs, createAccountLinkHandler({ listUsersByEmail, linkProviderForUser, obs }));
export const handler = async (event: PreSignUpTriggerEvent, context: Context): Promise<PreSignUpTriggerEvent> => answerCognito(await decide(event, context));
