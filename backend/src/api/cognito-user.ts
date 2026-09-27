// The caller's email address, and whether Cognito has verified it.
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
//
// A user whose downgrade is pending (`custom:downgrade_pending` set: the
// trigger's downgrade failed after it flagged it, supply-checkout-0qr8)
// doesn't count as verified either, whatever its email, until a Managed Login
// sign-in downgrades it or an administrator clears it.
//
// Verifying: cognitoEmailCodes() asks Cognito to email the caller a code
// (GetUserAttributeVerificationCode) and checks the code they enter
// (VerifyUserAttribute), both with the caller's own access token, like
// GetUser. The API makes these calls rather than the browser so that the app
// only ever talks to our API (the content security policy's connect-src has
// no Cognito regional endpoint, and the app's config names no region), and
// API Gateway's throttle sits in front of Cognito's own limits. Neither the
// token nor the code is ever logged.

import { isDowngradePending, isRecordedEmail, linkedUser } from "../identity/email-verified-handler.js";
import { ApiError } from "./http.js";

export interface CognitoUser {
  readonly sub: string;
  readonly email?: string;
  /** True only when Cognito says `email_verified` is "true" with no downgrade pending (and, for a linked user, the email is the recorded one). */
  readonly emailVerified: boolean;
}

/**
 * Whether GetUser's attributes (or a trigger's) say the email is verified:
 * email_verified is "true", no downgrade is pending, and, for a native user
 * with a Google or Apple identity linked, the email is the recorded one.
 */
export function emailVerifiedFrom(username: unknown, attributes: Readonly<Record<string, string | undefined>>): boolean {
  if (attributes.email_verified !== "true" || isDowngradePending(attributes)) return false;
  return !linkedUser(username, attributes) || isRecordedEmail(attributes);
}

export type UserInfo = (accessToken: string) => Promise<CognitoUser>;

const TIMEOUT_MS = 5000;
const ISSUER = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/;

/** Cognito's user pool endpoint for `issuerUrl`, checked to be a Cognito issuer. */
function poolEndpoint(issuerUrl: string): string {
  if (!ISSUER.test(issuerUrl)) throw new Error("ISSUER_URL is not a Cognito user pool issuer");
  return `${new URL(issuerUrl).origin}/`;
}

interface CognitoReply {
  readonly ok: boolean;
  readonly status: number;
  /** The error's name, without Cognito's namespace prefix, or "". */
  readonly type: string;
  readonly body: Record<string, unknown>;
}

/** One call to a Cognito user pool action authorized by the caller's access token. */
async function callCognito(endpoint: string, doFetch: typeof fetch, action: string, body: Record<string, string>): Promise<CognitoReply> {
  const response = await doFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSCognitoIdentityProviderService.${action}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown> | null;
  const reply = parsed && typeof parsed === "object" ? parsed : {};
  const type = typeof reply.__type === "string" ? (reply.__type.split("#").pop() ?? "") : "";
  return { ok: response.ok, status: response.status, type, body: reply };
}

/** A revoked token (signed out elsewhere), or one without the admin scope. */
const signInAgain = () => new ApiError(401, "unauthenticated", "Sign in again");

/** GetUser against the pool that issued the token (`issuerUrl`). */
export function cognitoUserInfo(issuerUrl: string, doFetch: typeof fetch = fetch): UserInfo {
  const endpoint = poolEndpoint(issuerUrl);
  return async (accessToken: string) => {
    const { ok, status, type, body } = await callCognito(endpoint, doFetch, "GetUser", { AccessToken: accessToken });
    if (!ok) {
      if (status === 400 && type === "NotAuthorizedException") throw signInAgain();
      throw new Error(`GetUser failed: ${status} ${type}`);
    }
    const { Username, UserAttributes } = body as { Username?: string; UserAttributes?: { Name?: string; Value?: string }[] };
    const attributes: Record<string, string | undefined> = Object.fromEntries(
      (Array.isArray(UserAttributes) ? UserAttributes : []).filter((a) => typeof a?.Name === "string" && typeof a.Value === "string").map((a) => [a.Name, a.Value]),
    );
    return {
      sub: attributes.sub ?? "",
      email: attributes.email,
      emailVerified: emailVerifiedFrom(Username, attributes),
    };
  };
}

/** Emailing the caller a verification code for their address, and checking it. */
export interface EmailCodes {
  /** Cognito emails a new code to the caller's `email`. */
  send(accessToken: string): Promise<void>;
  /** Marks the caller's `email` verified if `code` is the one Cognito sent. */
  verify(accessToken: string, code: string): Promise<void>;
}

/**
 * Cognito's refusals the person can act on, as the API answers them. Cognito
 * does the rate limiting: a few codes an hour, and a few wrong tries per code.
 */
const REFUSALS = new Map<string, () => ApiError>(Object.entries({
  NotAuthorizedException: signInAgain,
  CodeMismatchException: () => new ApiError(400, "bad_request", "That code isn't right", "code_mismatch"),
  ExpiredCodeException: () => new ApiError(400, "bad_request", "That code has expired; send a new one", "code_expired"),
  LimitExceededException: () => new ApiError(429, "quota_exceeded", "Too many attempts; try again later"),
  TooManyRequestsException: () => new ApiError(429, "quota_exceeded", "Too many attempts; try again later"),
  TooManyFailedAttemptsException: () => new ApiError(429, "quota_exceeded", "Too many attempts; try again later"),
  AliasExistsException: () => new ApiError(409, "aborted", "Another account already uses this email address", "email_in_use"),
  CodeDeliveryFailureException: () => new ApiError(503, "internal", "Couldn't send the code; try again"),
}));

/** GetUserAttributeVerificationCode and VerifyUserAttribute for `email`, against the pool that issued the token. */
export function cognitoEmailCodes(issuerUrl: string, doFetch: typeof fetch = fetch): EmailCodes {
  const endpoint = poolEndpoint(issuerUrl);
  const call = async (action: string, body: Record<string, string>) => {
    const { ok, status, type } = await callCognito(endpoint, doFetch, action, body);
    if (ok) return;
    const refusal = status === 400 ? REFUSALS.get(type) : undefined;
    if (refusal) throw refusal();
    // Only the status and the error's name: never the token, the code or Cognito's message
    throw new Error(`${action} failed: ${status} ${type}`);
  };
  return {
    send: (accessToken) => call("GetUserAttributeVerificationCode", { AccessToken: accessToken, AttributeName: "email" }),
    verify: (accessToken, code) => call("VerifyUserAttribute", { AccessToken: accessToken, AttributeName: "email", Code: code }),
  };
}
