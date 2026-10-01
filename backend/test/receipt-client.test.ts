// The receipts function's Bedrock client (src/receipts/client.ts): the
// endpoint, logging and auth come from the code, never from the environment.

import { describe, expect, it, vi } from "vitest";
import { bedrockRuntimeUrl, receiptModelClient } from "../src/receipts/client.js";
import { REGION } from "./helpers.js";

describe("the receipt model client", () => {
  it("calls Bedrock's runtime endpoint in the function's region, with the SDK's logging off and no retries of its own", () => {
    const client = receiptModelClient({ AWS_REGION: REGION });
    expect(client.baseURL).toBe(bedrockRuntimeUrl(REGION));
    expect(client.baseURL).toBe(`https://bedrock-runtime.${REGION}.amazonaws.com`);
    expect(client.awsRegion).toBe(REGION);
    expect(client.logLevel).toBe("off");
    expect(client.maxRetries).toBe(0);
    expect(client.authToken).toBeNull();
  });

  it("ignores a base URL, log level or Anthropic credentials in the environment", () => {
    const client = receiptModelClient({
      AWS_REGION: REGION,
      ANTHROPIC_BEDROCK_BASE_URL: "https://attacker.example",
      ANTHROPIC_BASE_URL: "https://attacker.example",
      ANTHROPIC_LOG: "debug",
      ANTHROPIC_API_KEY: "sk-test",
      ANTHROPIC_AUTH_TOKEN: "token",
    });
    // The SDK reads process.env itself: set them there too, for the duration of the check
    vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", "https://attacker.example");
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "token");
    try {
      const fromProcess = receiptModelClient({ AWS_REGION: REGION });
      for (const c of [client, fromProcess]) {
        expect(c.baseURL).toBe(bedrockRuntimeUrl(REGION));
        expect(c.logLevel).toBe("off");
        expect(c.authToken).toBeNull();
        expect(c.apiKey).toBeNull();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses to start with a Bedrock bearer token, or without a region", () => {
    expect(() => receiptModelClient({ AWS_REGION: REGION, AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key" })).toThrow(/AWS_BEARER_TOKEN_BEDROCK/);
    expect(() => receiptModelClient({})).toThrow(/AWS_REGION/);
    expect(() => receiptModelClient({ AWS_REGION: "https://x" })).toThrow(/AWS_REGION/);
  });

  it("refuses a bearer token that reached the client from the process environment", () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "bedrock-api-key");
    try {
      expect(() => receiptModelClient({ AWS_REGION: REGION })).toThrow(/bearer token/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
