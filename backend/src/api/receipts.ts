// Lambda entry point for reading receipts (see receipts-handler.ts). Built
// once per container: the Bedrock client, the per-team DynamoDB clients and
// the logger.
//
// The client is the Anthropic SDK's Bedrock client on Bedrock's InvokeModel
// API, signed with the function's own role, which may invoke only the
// receipt model through its US inference profile (infra/lib/stacks/api-stack.ts).
// The model ID names that profile (RECEIPT_MODEL_ID in infra/lib/config.ts).

import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import { createObservability, withObservability } from "../observability/index.js";
import { createReceiptsHandler } from "./receipts-handler.js";
import { API_ENV } from "./routes.js";
import { teamScopedDbs } from "./team-db.js";

const roleArn = process.env[API_ENV.receiptRoleArn];
const modelId = process.env[API_ENV.receiptModelId];
// Fail closed: without the scoped role there is no second layer of isolation
if (!roleArn) throw new Error(`${API_ENV.receiptRoleArn} is not set`);
if (!modelId) throw new Error(`${API_ENV.receiptModelId} is not set`);

const obs = createObservability({ service: "receipts" });
// The region and credentials are the function's (AWS_REGION and its role); retries and timeouts are per call
const model = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION, maxRetries: 0 });
export const handler = withObservability(obs, createReceiptsHandler({ dbForTeam: teamScopedDbs({ roleArn }), obs, model, modelId }));
