// The caller's email address, and whether Cognito has verified it.
//
// Cognito access tokens don't carry the email. The account function needs a
// verified one to find and accept invites, so it calls Cognito's GetUser with
// the caller's own access token (the app requests the
// aws.cognito.signin.user.admin scope, which GetUser needs). GetUser is
// authorized by the token itself: no IAM permission, no AWS signature. The
// endpoint is the user pool's regional endpoint, taken from the configured
// issuer URL, so no region name appears here (ADR 0010).

import { ApiError } from "./http.js";

export interface CognitoUser {
  readonly sub: string;
  readonly email?: string;
  /** True only when Cognito says `email_verified` is "true". */
  readonly emailVerified: boolean;
}

export type UserInfo = (accessToken: string) => Promise<CognitoUser>;

const TIMEOUT_MS = 5000;
const ISSUER = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/;

/** GetUser against the pool that issued the token (`issuerUrl`). */
export function cognitoUserInfo(issuerUrl: string, doFetch: typeof fetch = fetch): UserInfo {
  if (!ISSUER.test(issuerUrl)) throw new Error("ISSUER_URL is not a Cognito user pool issuer");
  const endpoint = `${new URL(issuerUrl).origin}/`;
  return async (accessToken: string) => {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.GetUser" },
      body: JSON.stringify({ AccessToken: accessToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as { __type?: string; UserAttributes?: { Name?: string; Value?: string }[] };
    if (!response.ok) {
      // A revoked token (signed out elsewhere), or one without the admin scope
      if (response.status === 400 && /NotAuthorized/.test(body.__type ?? "")) throw new ApiError(401, "unauthenticated", "Sign in again");
      throw new Error(`GetUser failed: ${response.status} ${body.__type ?? ""}`);
    }
    const attributes = new Map((body.UserAttributes ?? []).map((a) => [a.Name, a.Value]));
    return {
      sub: attributes.get("sub") ?? "",
      email: attributes.get("email"),
      emailVerified: attributes.get("email_verified") === "true",
    };
  };
}
