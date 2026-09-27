// The caller's email address, and whether Cognito has verified it; and
// deleting the caller's own Cognito user when they delete their account.
//
// Cognito access tokens don't carry the email. The account function needs a
// verified one to find and accept invites, so it calls Cognito's GetUser with
// the caller's own access token (the app requests the
// aws.cognito.signin.user.admin scope, which GetUser needs). GetUser is
// authorized by the token itself: no IAM permission, no AWS signature. The
// endpoint is the user pool's regional endpoint, taken from the configured
// issuer URL, so no region name appears here (ADR 0010).
//
// A native user with a Google or Apple identity linked (supply-checkout-0b1)
// counts as verified only while its email is the one recorded in
// `custom:linked_email` (supply-checkout-kgw). Cognito rewrites a linked
// user's email from the provider at each provider sign-in and leaves
// email_verified "true"; the pre token generation trigger unverifies such an
// address at that sign-in, and this is the same rule, so a rewritten address
// never lists another person's invites, even if the trigger's write failed.
// After the person verifies a new address with a Cognito code, the trigger
// records it at their next token refresh, and from then it counts.

import { isRecordedEmail, linkedUser } from "../identity/email-verified-handler.js";
import { ApiError } from "./http.js";

/** Deletes the user whose access token this is. */
export type DeleteUser = (accessToken: string) => Promise<void>;

export interface CognitoUser {
  readonly sub: string;
  readonly email?: string;
  /** True only when Cognito says `email_verified` is "true" (and, for a linked user, the email is the recorded one). */
  readonly emailVerified: boolean;
}

/**
 * Whether GetUser's attributes (or a trigger's) say the email is verified:
 * email_verified is "true" and, for a native user with a Google or Apple
 * identity linked, the email is the recorded one.
 */
export function emailVerifiedFrom(username: unknown, attributes: Readonly<Record<string, string | undefined>>): boolean {
  if (attributes.email_verified !== "true") return false;
  return !linkedUser(username, attributes) || isRecordedEmail(attributes);
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
    const body = (await response.json().catch(() => ({}))) as { __type?: string; Username?: string; UserAttributes?: { Name?: string; Value?: string }[] };
    if (!response.ok) {
      // A revoked token (signed out elsewhere, or the account was deleted), or one without the admin scope
      if (response.status === 400 && /NotAuthorized|UserNotFound/.test(body.__type ?? "")) throw new ApiError(401, "unauthenticated", "Sign in again");
      throw new Error(`GetUser failed: ${response.status} ${body.__type ?? ""}`);
    }
    const attributes: Record<string, string | undefined> = Object.fromEntries(
      (body.UserAttributes ?? []).filter((a) => typeof a.Name === "string" && typeof a.Value === "string").map((a) => [a.Name, a.Value]),
    );
    return {
      sub: attributes.sub ?? "",
      email: attributes.email,
      emailVerified: emailVerifiedFrom(body.Username, attributes),
    };
  };
}

/**
 * Cognito's DeleteUser with the caller's own access token (it needs the same
 * aws.cognito.signin.user.admin scope as GetUser). Like GetUser it's
 * authorized by the token alone, so the account function needs no IAM
 * permission to delete users, and it can only ever delete the user who sent
 * the request: AdminDeleteUser would let a bug delete anyone in the pool.
 * The user's refresh tokens stop working at once; their access tokens pass
 * API Gateway's check until they expire, but every account route that
 * matters calls GetUser, which refuses them, and they're in no team.
 */
export function cognitoDeleteUser(issuerUrl: string, doFetch: typeof fetch = fetch): DeleteUser {
  if (!ISSUER.test(issuerUrl)) throw new Error("ISSUER_URL is not a Cognito user pool issuer");
  const endpoint = `${new URL(issuerUrl).origin}/`;
  return async (accessToken: string) => {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.DeleteUser" },
      body: JSON.stringify({ AccessToken: accessToken }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { __type?: string };
    if (response.status === 400 && /NotAuthorized|UserNotFound/.test(body.__type ?? "")) throw new ApiError(401, "unauthenticated", "Sign in again");
    // Only the status and error type: Cognito's messages can echo the username
    throw new Error(`DeleteUser failed: ${response.status} ${body.__type ?? ""}`);
  };
}
