// Lambda entry point for the ops API (see ops-handler.ts). The STS client,
// the operator-access sessions and the logger are built once per container.

import { API_ENV } from "../api/routes.js";
import { createObservability, withObservability } from "../observability/index.js";
import { operatorDirectory } from "./cognito.js";
import { createOpsHandler } from "./ops-handler.js";
import { opsScopedDbs } from "./ops-db.js";

function required(name: string): string {
  const value = process.env[name];
  // Fail closed: without these there is no operator check or no scoped role
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const issuerUrl = required(API_ENV.opsIssuerUrl);
const obs = createObservability({ service: "ops-api" });
export const handler = withObservability(
  obs,
  createOpsHandler({
    dbFor: opsScopedDbs({ roleArn: required(API_ENV.opsRoleArn) }),
    directory: operatorDirectory({ issuerUrl, userPoolId: required(API_ENV.opsUserPoolId) }),
    issuerUrl,
    clientId: required(API_ENV.opsClientId),
    obs,
  }),
);
