// Lambda entry point for the user pool's pre sign-up trigger (see account-link-handler.ts).

import type { Context, PreSignUpTriggerEvent } from "aws-lambda";
import { createObservability, withObservability } from "../observability/index.js";
import { answerCognito, createAccountLinkHandler } from "./account-link-handler.js";
import { cognitoLinking } from "./cognito-admin.js";

const obs = createObservability({ service: "sign-in" });
// Three calls at most (ListUsers, recording the email, the link), each capped
// so all of them fit in the 5 seconds Cognito gives a trigger
const { listUsersByEmail, updateUserAttributes, linkProviderForUser } = cognitoLinking({ region: obs.region, timeoutMs: 1_500 });
const decide = withObservability(obs, createAccountLinkHandler({ listUsersByEmail, updateUserAttributes, linkProviderForUser, obs }));
export const handler = async (event: PreSignUpTriggerEvent, context: Context): Promise<PreSignUpTriggerEvent> => answerCognito(await decide(event, context));
