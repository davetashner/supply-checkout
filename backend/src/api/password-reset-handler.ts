// Resetting a forgotten password from the app's sign-in screen
// (supply-checkout-6uw.26, PASSWORD_RESET_ROUTES):
//
//   POST /auth/password-reset          {email}: hands the request to the
//                                      password reset function (an
//                                      asynchronous invoke) and answers 204.
//   POST /auth/password-reset/confirm  {email, code, password}: Cognito's
//                                      ConfirmForgotPassword, which sets the
//                                      new password if the code is right.
//
// No account enumeration. Asking for a reset answers 204 whatever the
// address: this function never looks the address up, and does the same work
// (check the body, queue the request) for every address, so neither the answer
// nor its timing depends on whether there's an account. The password reset
// function (email/password-reset-handler.ts) decides, after the answer has
// gone, whether Cognito emails a code or we email help, and applies the
// per-address and per-IP limits. Only a malformed body (400), a refused
// origin (403) or a request Lambda wouldn't queue (503) answers otherwise,
// none of which depends on the address having an account.
//
// Confirming maps Cognito's answers to the app's, and every way a code can
// fail (wrong, expired, no such user, no code asked for) is the one answer,
// `code_mismatch`. Cognito's ConfirmForgotPassword is a public call with the
// web client's ID, which is public too (config.json), so this answers nothing
// that Cognito wouldn't answer anyone directly. The password is checked
// against the pool's policy first, so a weak one never reaches Cognito.
//
// CSRF: there's no cookie or token to ride on, but every request must still
// carry an Origin header naming an allowed origin, as the auth routes do.
// Nothing is logged but the outcome: never the address, the code or the
// password.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { mailAddress } from "../data/index.js";
import type { PasswordResetRequest } from "../email/names.js";
import type { Observability } from "../observability/index.js";
import { ApiError, errorFor, errorResponse, header, jsonBody, noContent } from "./http.js";
import { PASSWORD_RESET_ROUTES, routeKey } from "./routes.js";

export interface PasswordResetConfig {
  /** The web app's public client, for ConfirmForgotPassword. */
  readonly clientId: string;
  /** `https://cognito-idp.<region>.amazonaws.com/<pool>`: where ConfirmForgotPassword is called. */
  readonly issuerUrl: string;
  /** Exact origins, e.g. `https://app.<env domain>`. */
  readonly allowedOrigins: readonly string[];
}

export interface PasswordResetHandlerDeps {
  readonly config: PasswordResetConfig;
  readonly obs: Observability;
  /** Queues one request for the password reset function. Throws if Lambda didn't accept it. */
  readonly queue: (request: PasswordResetRequest) => Promise<void>;
  readonly fetch?: typeof fetch;
}

const ROUTES = new Map(PASSWORD_RESET_ROUTES.map((r) => [routeKey(r), r.action]));
const ISSUER = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/;
const TIMEOUT_MS = 5000;
/** Cognito's reset codes: six digits. */
const CODE = /^[0-9]{6}$/;

/** The user pool's password policy (the identity stack): 12 or more characters, with a lowercase and an uppercase letter, a digit and a symbol. Cognito allows at most 256. */
export function meetsPasswordPolicy(password: string): boolean {
  return (
    password.length >= 12 &&
    password.length <= 256 &&
    password === password.trim() &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9\s]/.test(password)
  );
}

const codeWrong = () => new ApiError(400, "bad_request", "That code isn't right, or it has expired. Check it, or ask for a new one", "code_mismatch");
const passwordInvalid = () =>
  new ApiError(400, "bad_request", "Choose a password of at least 12 characters, with upper and lower case letters, a number and a symbol, that you haven't used before", "password_invalid");
const tooMany = () => new ApiError(429, "quota_exceeded", "Too many tries; wait a few minutes, then try again");

/** Cognito's refusals of ConfirmForgotPassword, by error type: every failed code is code_mismatch. */
const REFUSALS = new Map<string, () => ApiError>(Object.entries({
  CodeMismatchException: codeWrong,
  ExpiredCodeException: codeWrong,
  UserNotFoundException: codeWrong,
  NotAuthorizedException: codeWrong,
  InvalidParameterException: codeWrong,
  InvalidPasswordException: passwordInvalid,
  PasswordHistoryPolicyViolationException: passwordInvalid,
  LimitExceededException: tooMany,
  TooManyRequestsException: tooMany,
  TooManyFailedAttemptsException: tooMany,
}));

/** The address in a request body, as the mailer would send to it, or a 400. */
function addressIn(body: Record<string, unknown>): string {
  try {
    return mailAddress(body.email);
  } catch {
    throw new ApiError(400, "bad_request", "Enter your email address, like name@example.com");
  }
}

export function createPasswordResetHandler(deps: PasswordResetHandlerDeps) {
  const { config, obs, queue } = deps;
  if (!ISSUER.test(config.issuerUrl)) throw new Error("ISSUER_URL is not a Cognito user pool issuer");
  const endpoint = `${new URL(config.issuerUrl).origin}/`;
  const origins = new Set(config.allowedOrigins);
  const doFetch = deps.fetch ?? fetch;

  async function requestReset(event: APIGatewayProxyEventV2) {
    const body = jsonBody(event, ["email"]);
    addressIn(body);
    const ip = event.requestContext?.http?.sourceIp;
    if (typeof ip !== "string" || !ip) throw new ApiError(400, "bad_request", "No source address");
    try {
      // As typed (trimmed), so the function can look the address up as it was given as well as in its usual form
      await queue({ email: (body.email as string).trim(), ip });
    } catch (error) {
      obs.logger.error("Password reset not queued", { error: (error as Error).name });
      throw new ApiError(503, "unavailable", "Couldn't send that just now; try again");
    }
    obs.logger.info("Password reset", { outcome: "queued" });
    return noContent();
  }

  async function confirmReset(event: APIGatewayProxyEventV2) {
    const body = jsonBody(event, ["email", "code", "password"]);
    const email = addressIn(body);
    if (typeof body.code !== "string" || !CODE.test(body.code)) throw codeWrong();
    if (typeof body.password !== "string" || !meetsPasswordPolicy(body.password)) throw passwordInvalid();
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.ConfirmForgotPassword" },
        body: JSON.stringify({ ClientId: config.clientId, Username: email, ConfirmationCode: body.code, Password: body.password }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      obs.logger.error("Cognito unreachable", { error: (error as Error).name });
      throw new ApiError(503, "unavailable", "Couldn't reset the password just now; try again");
    }
    if (response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      obs.logger.info("Password reset", { outcome: "confirmed" });
      return noContent();
    }
    const answer = (await response.json().catch(() => ({}))) as { __type?: unknown };
    const type = typeof answer.__type === "string" ? answer.__type.replace(/^.*#/, "") : "";
    const refusal = response.status === 400 ? REFUSALS.get(type) : undefined;
    if (refusal) {
      const error = refusal();
      obs.logger.info("Password reset", { outcome: "refused", reason: error.reason ?? error.code });
      throw error;
    }
    // Only the status and the error's name: never the address, the code or Cognito's message
    obs.logger.error("ConfirmForgotPassword failed", { status: response.status, type });
    throw new ApiError(503, "unavailable", "Couldn't reset the password just now; try again");
  }

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const action = ROUTES.get(event.routeKey);
    try {
      if (!action) throw new ApiError(404, "not_found", "No such route");
      const origin = header(event, "origin");
      if (!origin || !origins.has(origin)) throw new ApiError(403, "permission_denied", "Origin not allowed");
      return action === "requestReset" ? await requestReset(event) : await confirmReset(event);
    } catch (error) {
      const apiError = errorFor(error);
      if (apiError.status >= 500 && !(error instanceof ApiError)) obs.logger.error("Request failed", error as Error);
      return errorResponse(apiError);
    }
  };
}
