// Cognito's AdminUpdateUserAttributes, signed with the Lambda's role (IAM).
// The role may call it only on the environment's user pool (identity stack).
// The endpoint is the regional Cognito endpoint for the Lambda's own region,
// which is the pool's region: the trigger runs beside the pool.

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";

/** Sets `attributes` on one user. Throws if Cognito doesn't answer 200. */
export type UpdateUserAttributes = (userPoolId: string, username: string, attributes: Readonly<Record<string, string>>) => Promise<void>;

export interface CognitoAdminOptions {
  readonly region: string;
  /** Defaults to the Lambda's role. */
  readonly credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** For tests. */
  readonly fetch?: typeof fetch;
  /** Per request. Cognito gives a trigger 5 seconds in all. */
  readonly timeoutMs?: number;
}

const Sha256 = Hash.bind(null, "sha256");
const REGION = /^[a-z0-9-]+$/;

export function cognitoAdmin(options: CognitoAdminOptions): UpdateUserAttributes {
  if (!REGION.test(options.region)) throw new Error("Not an AWS region name");
  const host = `cognito-idp.${options.region}.amazonaws.com`;
  const signer = new SignatureV4({ service: "cognito-idp", region: options.region, credentials: options.credentials ?? defaultProvider(), sha256: Sha256 });
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;

  return async (userPoolId, username, attributes) => {
    const body = JSON.stringify({
      UserPoolId: userPoolId,
      Username: username,
      UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
    });
    const signed = await signer.sign({
      method: "POST",
      protocol: "https:",
      hostname: host,
      path: "/",
      headers: {
        host,
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.AdminUpdateUserAttributes",
      },
      body,
      query: {},
    });
    const response = await doFetch(`https://${host}/`, { method: "POST", headers: signed.headers, body, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      // Only the error type: Cognito's messages can echo the username
      const answer = (await response.json().catch(() => ({}))) as { __type?: unknown };
      const type = typeof answer.__type === "string" ? answer.__type.replace(/^.*#/, "") : "";
      throw new Error(`AdminUpdateUserAttributes failed: ${response.status} ${type}`.trim());
    }
  };
}
