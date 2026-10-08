// Responses and errors shared by the API's handlers. Every error body is
// `{ "error": { "code": "...", "message": "..." } }`, with the codes the
// app's runtime already understands (docs/api/openapi.yaml lists them).

//
// No imports from the data module, so the auth function's bundle doesn't
// carry DynamoDB. data-handler.ts maps the data layer's errors.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export type ErrorCode =
  | "bad_request"
  | "unauthenticated"
  | "permission_denied"
  | "invalid_argument"
  | "not_found"
  | "aborted"
  | "quota_exceeded"
  | "unavailable"
  | "internal";

/**
 * Why a request was refused, where the code alone doesn't say: `view_only` (a
 * viewer writing), `owners_only` (an owners-only route), `not_member` (not in
 * the team, or no such team), `last_owner` (the change would leave the team
 * without an owner), `team_full` (the team is at its member cap), and for
 * verifying an email address: `code_mismatch` and `code_expired` (the code
 * entered), `already_verified` and `email_in_use` (another account has it).
 * And `already_subscribed`: the team has a Stripe subscription that hasn't
 * ended, so it can't start another checkout. `subscription_ended`: the
 * team's subscription ended, so it's read-only until an owner subscribes.
 * `no_billing_account`: the team has no Stripe customer yet (no owner has
 * started a checkout), so there's no Customer Portal to open. `mfa_required`:
 * a billing route for an owner without two-step sign-in (an authenticator
 * app) on. `mfa_sign_in_again`: a billing route for an owner whose session
 * began before two-step sign-in was turned on, so they sign in again with
 * the password and the code. `password_reset` (401 `unauthenticated`): the
 * session began before the account's password was reset (session-reset.ts),
 * so the app signs out, of Managed Login too, and asks for the new password. Setting it up: `password_invalid` (the password policy),
 * `password_mismatch` (the current password is wrong or missing) and
 * `federated_sign_in` (a Google or Apple user, who has nothing to set up), and
 * `signout_failed` (it's on, but the user's other sessions weren't ended yet:
 * POST /me/sign-out-everywhere finishes it).
 * Reading a receipt (ADR 0008): `image_rejected` (the photo isn't a JPEG or
 * PNG, is too large, or the model service couldn't use it), `receipt_limit`
 * (the team has read all its receipts this month, or all its trial's),
 * `rate_limited` (the caller has read too many receipts in a short time; the
 * response has Retry-After), `model_busy` (the model
 * service is throttling), `model_timeout` (no answer in time) and
 * `invalid_output` (the model's reply couldn't be used).
 */
export type ErrorReason =
  | "view_only"
  | "owners_only"
  | "not_member"
  | "last_owner"
  | "team_full"
  | "team_closed"
  | "team_deleting"
  | "stock_changed"
  | "equipment_out"
  | "adhoc_open"
  | "code_mismatch"
  | "code_expired"
  | "already_verified"
  | "email_in_use"
  | "email_changed"
  | "already_subscribed"
  | "subscription_ended"
  | "no_billing_account"
  | "mfa_required"
  | "mfa_sign_in_again"
  | "password_reset"
  | "password_invalid"
  | "password_mismatch"
  | "federated_sign_in"
  | "signout_failed"
  | "image_rejected"
  | "receipt_limit"
  | "rate_limited"
  | "model_busy"
  | "model_timeout"
  | "invalid_output";

/** An error with the HTTP status and code the client sees. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: ErrorCode;
  readonly reason?: ErrorReason;
  /** Response headers the error carries (Retry-After on a rate limit). */
  readonly headers?: Readonly<Record<string, string>>;

  constructor(status: number, code: ErrorCode, message: string, reason?: ErrorReason, headers?: Readonly<Record<string, string>>) {
    super(message);
    this.status = status;
    this.code = code;
    if (reason) this.reason = reason;
    if (headers) this.headers = headers;
  }
}

/** The largest request body the API reads. Documents are smaller (MAX_DOCUMENT_BYTES). */
export const MAX_BODY_BYTES = 1_000_000;

const BASE_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export function json(status: number, body: unknown, headers: Record<string, string> = {}, cookies?: string[]): APIGatewayProxyStructuredResultV2 {
  return { statusCode: status, headers: { ...BASE_HEADERS, ...headers }, body: JSON.stringify(body), ...(cookies ? { cookies } : {}) };
}

export function noContent(cookies?: string[]): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 204, headers: { "cache-control": "no-store" }, ...(cookies ? { cookies } : {}) };
}

/** An ApiError as it is, anything else as a 500 whose details stay in the logs. */
export function errorFor(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(500, "internal", "Something went wrong");
}

export function errorResponse(error: ApiError, cookies?: string[]): APIGatewayProxyStructuredResultV2 {
  return json(error.status, { error: { code: error.code, message: error.message, ...(error.reason ? { reason: error.reason } : {}) } }, error.headers ?? {}, cookies);
}

/**
 * A viewer writing. The web build's runtime (src/aws/db.js) hands this to the
 * app as `invalid_argument`, the code the artifact runtime uses for view-only
 * access (src/main.js).
 */
export function viewOnly(): ApiError {
  return new ApiError(403, "permission_denied", "You have view-only access to this team", "view_only");
}

/** A contributor or viewer calling an owners-only route. */
export function ownersOnly(): ApiError {
  return new ApiError(403, "permission_denied", "Only the team's owners can do this", "owners_only");
}

/** Not a member of the team, or no such team: one answer for both, so it doesn't reveal which teams exist. */
export function notMember(): ApiError {
  return new ApiError(403, "permission_denied", "You're not a member of this team", "not_member");
}

/** The caller's access token, as API Gateway verified it (with or without the Bearer prefix). */
export function accessToken(event: Pick<APIGatewayProxyEventV2, "headers">): string {
  const token = (header(event, "authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new ApiError(401, "unauthenticated", "Sign in again");
  return token;
}

/** The request body as text, decoded and size-checked (at most `max` bytes, MAX_BODY_BYTES unless a route says otherwise). */
export function bodyText(event: Pick<APIGatewayProxyEventV2, "body" | "isBase64Encoded">, max = MAX_BODY_BYTES): string {
  if (event.body === undefined || event.body === null || event.body === "") return "";
  // Checked before decoding too, so an oversized body is never copied
  if (event.body.length > (event.isBase64Encoded ? Math.ceil(max / 3) * 4 : max)) throw new ApiError(413, "quota_exceeded", "Request body is too large");
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (Buffer.byteLength(text, "utf8") > max) throw new ApiError(413, "quota_exceeded", "Request body is too large");
  return text;
}

/** The body as a JSON object with no fields but `allowed`. */
export function jsonBody(event: Pick<APIGatewayProxyEventV2, "body" | "isBase64Encoded">, allowed: readonly string[], max = MAX_BODY_BYTES): Record<string, unknown> {
  const text = bodyText(event, max);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad_request", "Body must be JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ApiError(400, "bad_request", "Body must be a JSON object");
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) throw new ApiError(400, "bad_request", `Unexpected field "${field}"`);
  }
  return value as Record<string, unknown>;
}

/** A header, whatever its case (API Gateway lowercases them, tests may not). */
export function header(event: Pick<APIGatewayProxyEventV2, "headers">, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (k.toLowerCase() === wanted) return v;
  return undefined;
}
