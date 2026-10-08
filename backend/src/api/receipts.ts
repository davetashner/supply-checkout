// Lambda entry point for reading receipts (see receipts-handler.ts). Built
// once per container: the Bedrock client, the per-team-and-user DynamoDB clients and
// the logger.
//
// The client is the Anthropic SDK's Bedrock client on Bedrock's InvokeModel
// API (receipts/client.ts), signed with the function's own role, which may
// invoke only the receipt model through its US inference profile
// (infra/lib/stacks/api-stack.ts). The model ID names that profile
// (RECEIPT_MODEL_ID in infra/lib/config.ts).

import { trialReadsPerDayFrom } from "../data/index.js";
import { createObservability, withObservability } from "../observability/index.js";
import { receiptModelClient } from "../receipts/client.js";
import { createReceiptsHandler } from "./receipts-handler.js";
import { API_ENV } from "./routes.js";
import { sessionCheckFromEnv } from "./session-reset.js";
import { receiptScopedDbs } from "./team-db.js";

const roleArn = process.env[API_ENV.receiptRoleArn];
const modelId = process.env[API_ENV.receiptModelId];
// Fail closed: without the scoped role there is no second layer of isolation
if (!roleArn) throw new Error(`${API_ENV.receiptRoleArn} is not set`);
if (!modelId) throw new Error(`${API_ENV.receiptModelId} is not set`);
// The account-wide trial cap: the default when unset, and a bad value fails the start rather than lift it
const trialReadsPerDay = trialReadsPerDayFrom(process.env[API_ENV.receiptTrialReadsPerDay]);

const obs = createObservability({ service: "receipts" });
// The region and credentials are the function's (AWS_REGION and its role); see receipts/client.ts
const model = receiptModelClient();
export const handler = withObservability(obs, createReceiptsHandler({ dbFor: receiptScopedDbs({ roleArn }), obs, model, modelId, trialReadsPerDay, sessionCheck: sessionCheckFromEnv() }));
