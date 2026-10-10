// Lambda entry point for the account API (see account-handler.ts). The STS
// client, the per-user DynamoDB clients, the SES client and the logger are
// built once per container, outside the handler.

import { BILLING_ENV } from "../billing/names.js";
import { sqsSeatSyncQueue } from "../billing/seat-queue.js";
import { TEST_MAIL_DOMAIN_ENV, testMailDomain } from "../data/index.js";
import { deletionLogFromEnv } from "../deletions/records.js";
import { mailerFromEnv } from "../email/mailer.js";
import { photoStoreFromEnv } from "../photos/store.js";
import { createObservability, withObservability } from "../observability/index.js";
import { accountScopedDbs } from "./account-db.js";
import { createAccountHandler } from "./account-handler.js";
import { cognitoDeleteUser, cognitoEmailCodes, cognitoTotp, cognitoUserInfo } from "./cognito-user.js";
import { API_ENV } from "./routes.js";
import { sessionCheckFromEnv } from "./session-reset.js";

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
  createAccountHandler({ dbFor: accountScopedDbs({ roleArn: required(API_ENV.accountRoleArn) }), userInfo: cognitoUserInfo(issuerUrl), emailCodes: cognitoEmailCodes(issuerUrl), totp: cognitoTotp(issuerUrl), issuerUrl, obs, mailer: mailerFromEnv(), deleteUser: cognitoDeleteUser(issuerUrl), deletions: deletionLogFromEnv(), photos: photoStoreFromEnv(), seats: sqsSeatSyncQueue(required(BILLING_ENV.seatQueueUrl)), testMailDomain: testMailDomain(process.env[TEST_MAIL_DOMAIN_ENV]), sessionCheck: sessionCheckFromEnv() }),
);
