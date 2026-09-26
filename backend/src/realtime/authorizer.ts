// Lambda entry point for the AppSync Events authorizer (see authorizer-handler.ts).
// The verifier caches the user pool's signing keys per container.

import { CognitoJwtVerifier } from "aws-jwt-verify";
import { createObservability, withObservability } from "../observability/index.js";
import { createAuthorizerHandler } from "./authorizer-handler.js";
import { REALTIME_ENV } from "./channels.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const verifier = CognitoJwtVerifier.create({
  userPoolId: required(REALTIME_ENV.userPoolId),
  clientId: required(REALTIME_ENV.clientId),
  tokenUse: "access",
});
const obs = createObservability({ service: "realtime-authorizer" });
export const handler = withObservability(obs, createAuthorizerHandler({ verifier, obs }));
