// Hands a new account's welcome email to the welcome email function
// (email/welcome-handler.ts, supply-checkout-6uw.25), from the user pool's
// post confirmation and pre token generation triggers.
//
// An asynchronous invoke (InvocationType Event): Lambda queues the request
// and answers 202 at once, so the trigger spends one short call of Cognito's
// 5 seconds, and the send (a Cognito lookup, DynamoDB, SES) happens outside
// the sign-up. Lambda tries a failed request twice more, then puts it on the
// function's dead-letter queue. The request holds the user's sub and how they
// signed up, never an address or a name.
//
// Signed with the trigger's role, which may invoke only that function (the
// identity stack). The function is in the trigger's own region.

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";
import type { WelcomeRequest } from "../email/names.js";

/** Queues one welcome email request. Throws (naming only the status and error type) unless Lambda accepted it. */
export type SendWelcome = (request: WelcomeRequest) => Promise<void>;

export interface WelcomeInvokerOptions {
  readonly region: string;
  readonly functionName: string;
  /** Defaults to the Lambda's role. */
  readonly credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** For tests. */
  readonly fetch?: typeof fetch;
  /** The call's timeout: best effort inside a trigger, so short. */
  readonly timeoutMs: number;
}

const Sha256 = Hash.bind(null, "sha256");
const REGION = /^[a-z0-9-]+$/;
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function welcomeInvoker(options: WelcomeInvokerOptions): SendWelcome {
  const invoke = eventInvoker(options);
  return (request) => invoke({ userId: request.userId, via: request.via });
}

/**
 * Queues one asynchronous invoke (InvocationType Event) of a function in
 * `region`, with `payload` as its event: what welcomeInvoker does, for any
 * payload. The API's password reset route hands its requests over this way
 * (api/password-reset-handler.ts, supply-checkout-6uw.26). Throws (naming only
 * the status and error type) unless Lambda accepted it.
 */
export function eventInvoker(options: WelcomeInvokerOptions): (payload: unknown) => Promise<void> {
  if (!REGION.test(options.region)) throw new Error("Not an AWS region name");
  if (!FUNCTION_NAME.test(options.functionName)) throw new Error("Not a Lambda function name");
  const host = `lambda.${options.region}.amazonaws.com`;
  const path = `/2015-03-31/functions/${options.functionName}/invocations`;
  const signer = new SignatureV4({ service: "lambda", region: options.region, credentials: options.credentials ?? defaultProvider(), sha256: Sha256 });
  const doFetch = options.fetch ?? fetch;

  return async (payload) => {
    const body = JSON.stringify(payload);
    const signed = await signer.sign({
      method: "POST",
      protocol: "https:",
      hostname: host,
      path,
      headers: { host, "content-type": "application/json", "x-amz-invocation-type": "Event" },
      body,
      query: {},
    });
    const response = await doFetch(`https://${host}${path}`, { method: "POST", headers: signed.headers, body, signal: AbortSignal.timeout(options.timeoutMs) });
    // Nothing to read in the answer, but drain it so the connection can be reused
    await response.arrayBuffer().catch(() => undefined);
    if (response.status !== 202) {
      // Only the status and Lambda's error type (its x-amzn-errortype header)
      const type = (response.headers.get("x-amzn-errortype") ?? "").replace(/:.*$/, "").replace(/[^A-Za-z]/g, "");
      throw Object.assign(new Error(`Invoke failed: ${response.status} ${type}`.trim()), { name: type || "InvokeFailed" });
    }
  };
}
