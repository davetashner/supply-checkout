// How the ops function asks the operator reopen function to reopen a team
// (reopen-handler.ts): a synchronous Lambda Invoke, signed with the ops
// function's role, which may invoke that one function and nothing else.

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";
import type { ReopenAnswer, ReopenRequest } from "./reopen-handler.js";

export type Reopener = (request: ReopenRequest) => Promise<ReopenAnswer>;

export interface ReopenerOptions {
  /** The reopen function's name (OPS_REOPEN_FUNCTION). */
  readonly functionName: string;
  readonly region: string;
  /** Defaults to the Lambda's role. */
  readonly credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** For tests. */
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const Sha256 = Hash.bind(null, "sha256");
const REGION = /^[a-z0-9-]+$/;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A Reopener that invokes the reopen function. Throws when the invoke fails or the function throws. */
export function lambdaReopener(options: ReopenerOptions): Reopener {
  if (!REGION.test(options.region)) throw new Error("Not an AWS region name");
  if (!NAME.test(options.functionName)) throw new Error("Not a Lambda function name");
  const host = `lambda.${options.region}.amazonaws.com`;
  const path = `/2015-03-31/functions/${options.functionName}/invocations`;
  const signer = new SignatureV4({ service: "lambda", region: options.region, credentials: options.credentials ?? defaultProvider(), sha256: Sha256 });
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  return async (request) => {
    const body = JSON.stringify(request);
    const signed = await signer.sign({
      method: "POST",
      protocol: "https:",
      hostname: host,
      path,
      headers: { host, "content-type": "application/json", "x-amz-invocation-type": "RequestResponse" },
      body,
      query: {},
    });
    const response = await doFetch(`https://${host}${path}`, { method: "POST", headers: signed.headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    // The function threw (X-Amz-Function-Error) or Lambda refused the call: name only the status
    if (!response.ok || response.headers.get("x-amz-function-error")) throw new Error(`Reopen function failed: ${response.status}${response.headers.get("x-amz-function-error") ? " (function error)" : ""}`);
    const answer = JSON.parse(text) as ReopenAnswer;
    if (typeof answer !== "object" || answer === null || typeof answer.ok !== "boolean") throw new Error("Reopen function answered without a result");
    return answer;
  };
}
