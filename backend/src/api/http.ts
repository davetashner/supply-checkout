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
  | "internal";

/** An error with the HTTP status and code the client sees. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
  return json(error.status, { error: { code: error.code, message: error.message } }, {}, cookies);
}

/**
 * A member whose role can't write. The app treats `invalid_argument` on a
 * write as "you have view-only access" (src/main.js), as the artifact runtime
 * reports it.
 */
export function viewOnly(): ApiError {
  return new ApiError(403, "invalid_argument", "You have view-only access to this team");
}

/** The request body as text, decoded and size-checked. */
export function bodyText(event: Pick<APIGatewayProxyEventV2, "body" | "isBase64Encoded">): string {
  if (event.body === undefined || event.body === null || event.body === "") return "";
  const text = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new ApiError(413, "quota_exceeded", "Request body is too large");
  return text;
}

/** The body as a JSON object with no fields but `allowed`. */
export function jsonBody(event: Pick<APIGatewayProxyEventV2, "body" | "isBase64Encoded">, allowed: readonly string[]): Record<string, unknown> {
  const text = bodyText(event);
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
