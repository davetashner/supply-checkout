// The Bedrock client the receipts function reads receipts with (ADR 0008):
// the Anthropic SDK's AnthropicBedrock, on Bedrock's InvokeModel API in the
// function's own region, signed (SigV4) with the function's role.
//
// Nothing in the environment can change where the photo goes or have it
// logged: the endpoint is set here (not ANTHROPIC_BEDROCK_BASE_URL), the
// SDK's logging is off (not ANTHROPIC_LOG, whose debug level logs request
// bodies), and the function refuses to start with a Bedrock bearer token
// (AWS_BEARER_TOKEN_BEDROCK), which would replace the role's signature.

import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

/** Bedrock's runtime endpoint in a region. */
export const bedrockRuntimeUrl = (region: string) => `https://bedrock-runtime.${region}.amazonaws.com`;

const REGION = /^[a-z]+(-[a-z]+)+-\d+$/;

export function receiptModelClient(env: NodeJS.ProcessEnv = process.env): AnthropicBedrock {
  const region = env.AWS_REGION;
  if (!region || !REGION.test(region)) throw new Error("AWS_REGION is not set to a region");
  if (env.AWS_BEARER_TOKEN_BEDROCK) throw new Error("AWS_BEARER_TOKEN_BEDROCK is set: receipts are signed with the function's role only");
  // Retries and timeouts are per call (readReceipt)
  const client = new AnthropicBedrock({ awsRegion: region, baseURL: bedrockRuntimeUrl(region), logLevel: "off", maxRetries: 0 });
  // SigV4 only: no bearer token from anywhere
  if (client.authToken) throw new Error("The Bedrock client has a bearer token");
  return client;
}
