// Lambda entry point for the account API (see account-handler.ts). The STS
// client, the per-user DynamoDB clients, the SES client and the logger are
// built once per container, outside the handler.

import { deletionLogFromEnv } from "../deletions/records.js";
import { mailerFromEnv } from "../email/mailer.js";
import { createObservability, withObservability } from "../observability/index.js";
import { accountScopedDbs } from "./account-db.js";
import { createAccountHandler } from "./account-handler.js";
import { cognitoDeleteUser, cognitoEmailCodes, cognitoUserInfo } from "./cognito-user.js";
import { API_ENV } from "./routes.js";

function required(name: string): string {
  const value = process.env[name];
  // Fail closed: without the scoped role there is no IAM layer of isolation
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const issuerUrl = required(API_ENV.issuerUrl);
const obs = createObservability({ service: "account-api" });
export const handler = withObservability(
  obs,
  createAccountHandler({ dbFor: accountScopedDbs({ roleArn: required(API_ENV.accountRoleArn) }), userInfo: cognitoUserInfo(issuerUrl), emailCodes: cognitoEmailCodes(issuerUrl), issuerUrl, obs, mailer: mailerFromEnv(), deleteUser: cognitoDeleteUser(issuerUrl), deletions: deletionLogFromEnv() }),
);
