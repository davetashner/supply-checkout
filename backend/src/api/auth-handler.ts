// Sign-in session endpoints for the web app (ADR 0007). The app keeps access
// and ID tokens in memory only; the refresh token lives in an HttpOnly cookie
// that page scripts can't read, set and rotated here.
//
//   POST /auth/session   After Managed Login redirects back with ?code=, the
//                        app sends the code and its PKCE verifier. We redeem
//                        them at Cognito's /oauth2/token, set the cookie, and
//                        return the access and ID tokens.
//   POST /auth/refresh   Redeems the cookie's refresh token. Rotation is on,
//                        so Cognito returns a new refresh token each time and
//                        the cookie is replaced. (REFRESH_TOKEN_AUTH is
//                        disabled with rotation, hence /oauth2/token.)
//   POST /auth/sign-out  Revokes the refresh token and clears the cookie.
//
// CSRF: the cookie is SameSite=Strict (sent only on requests from our own
// site, app. and api. being the same site), Secure, HttpOnly and scoped to
// /auth, and every request must carry an Origin header naming an allowed
// origin. The web client is public (PKCE, no secret), so nothing here is a
// secret beyond the tokens themselves, which are never logged.

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { ApiError, errorFor, errorResponse, header, json, jsonBody, noContent } from "./http.js";
import { AUTH_ROUTES, REFRESH_COOKIE, REFRESH_COOKIE_PATH, routeKey } from "./routes.js";

export interface AuthConfig {
  /** `https://auth.<env domain>` */
  readonly authUrl: string;
  readonly clientId: string;
  /** Exact origins, e.g. `https://app.<env domain>`. */
  readonly allowedOrigins: readonly string[];
}

export interface AuthHandlerDeps {
  readonly config: AuthConfig;
  readonly obs: Observability;
  readonly fetch?: typeof fetch;
}

/** Refresh tokens last 30 days (the identity stack's refreshTokenValidity). */
const COOKIE_MAX_AGE = 30 * 24 * 3600;
const TIMEOUT_MS = 5000;
const CODE = /^[A-Za-z0-9_-]{1,2048}$/;
// RFC 7636: 43–128 unreserved characters
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{1,8192}$/;

const ROUTES = new Map(AUTH_ROUTES.map((r) => [routeKey(r), r.action]));

export function refreshCookie(token: string): string {
  return `${REFRESH_COOKIE}=${token}; Path=${REFRESH_COOKIE_PATH}; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedCookie(): string {
  return `${REFRESH_COOKIE}=; Path=${REFRESH_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

/** The refresh token from the request's cookies, if it looks like one. */
export function cookieToken(event: Pick<APIGatewayProxyEventV2, "cookies">): string | undefined {
  for (const cookie of event.cookies ?? []) {
    const eq = cookie.indexOf("=");
    if (eq > 0 && cookie.slice(0, eq).trim() === REFRESH_COOKIE) {
      const value = cookie.slice(eq + 1).trim();
      return TOKEN.test(value) ? value : undefined;
    }
  }
  return undefined;
}

interface TokenResponse {
  readonly access_token?: string;
  readonly id_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
}

const APP_ORIGIN = /^https:\/\/app\.([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

/**
 * The only sign-in endpoint this function may send a grant or a refresh token
 * to (supply-checkout-6uw.23): `https://auth.<D>`, where `https://app.<D>` is
 * the first such origin in ALLOWED_ORIGINS. Both come from the template, not
 * from SSM, so a rewritten parameter can't point the function elsewhere.
 */
export function expectedAuthUrl(allowedOrigins: readonly string[]): string {
  for (const origin of allowedOrigins) {
    const match = APP_ORIGIN.exec(origin);
    if (match) return `https://auth.${match[1]}`;
  }
  throw new Error("ALLOWED_ORIGINS has no https://app.<domain> origin to check AUTH_URL against");
}

export function createAuthHandler(deps: AuthHandlerDeps) {
  const { config, obs } = deps;
  // Refuse to start rather than send anyone's grant or refresh token to another host
  if (config.authUrl !== expectedAuthUrl(config.allowedOrigins)) throw new Error("AUTH_URL must be https://auth.<the app's domain>");
  const doFetch = deps.fetch ?? fetch;
  const origins = new Set(config.allowedOrigins);

  /** POSTs a form to one of Cognito's OAuth endpoints. */
  const post = async (path: "/oauth2/token" | "/oauth2/revoke", form: Record<string, string>) => {
    let response: Response;
    try {
      response = await doFetch(`${config.authUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: config.clientId, ...form }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      obs.logger.error("Cognito unreachable", { path, error: (error as Error).name });
      throw new ApiError(503, "internal", "Sign-in is unavailable; try again");
    }
    return response;
  };

  /** Redeems a grant at /oauth2/token. A refused grant is a 401 that clears the cookie. */
  const redeem = async (form: Record<string, string>) => {
    const response = await post("/oauth2/token", form);
    if (response.status === 400 || response.status === 401) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      obs.logger.info("Grant refused", { grant: form.grant_type ?? "", error: String(body.error ?? response.status) });
      throw new ApiError(401, "unauthenticated", "Sign in again");
    }
    if (!response.ok) {
      obs.logger.error("Token endpoint failed", { status: response.status });
      throw new ApiError(503, "internal", "Sign-in is unavailable; try again");
    }
    const tokens = (await response.json()) as TokenResponse;
    if (!tokens.access_token || !tokens.id_token) throw new ApiError(502, "internal", "Sign-in returned no tokens");
    return tokens;
  };

  const tokensResponse = (tokens: TokenResponse) =>
    json(
      200,
      { accessToken: tokens.access_token, idToken: tokens.id_token, expiresIn: tokens.expires_in ?? 3600 },
      {},
      tokens.refresh_token ? [refreshCookie(tokens.refresh_token)] : undefined,
    );

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const action = ROUTES.get(event.routeKey);
    try {
      if (!action) throw new ApiError(404, "not_found", "No such route");
      const origin = header(event, "origin");
      if (!origin || !origins.has(origin)) throw new ApiError(403, "permission_denied", "Origin not allowed");

      if (action === "session") {
        const body = jsonBody(event, ["code", "codeVerifier", "redirectUri"]);
        const { code, codeVerifier, redirectUri } = body;
        if (typeof code !== "string" || !CODE.test(code)) throw new ApiError(400, "bad_request", "Invalid code");
        if (typeof codeVerifier !== "string" || !VERIFIER.test(codeVerifier)) throw new ApiError(400, "bad_request", "Invalid code verifier");
        // The callback must be on the calling origin (Cognito also checks it against the client's callback URLs)
        if (typeof redirectUri !== "string" || !redirectUri.startsWith(`${origin}/`)) throw new ApiError(400, "bad_request", "Invalid redirect URI");
        const tokens = await redeem({ grant_type: "authorization_code", code, code_verifier: codeVerifier, redirect_uri: redirectUri });
        if (!tokens.refresh_token) throw new ApiError(502, "internal", "Sign-in returned no refresh token");
        return tokensResponse(tokens);
      }

      const token = cookieToken(event);
      if (action === "refresh") {
        if (!token) throw new ApiError(401, "unauthenticated", "Sign in again");
        // With rotation, the response carries the next refresh token; the old one stops working
        return tokensResponse(await redeem({ grant_type: "refresh_token", refresh_token: token }));
      }

      // Sign-out: revoke if we can, and always clear the cookie
      if (token) {
        const response = await post("/oauth2/revoke", { token }).catch(() => undefined);
        if (!response?.ok) {
          // The token stays valid at Cognito until it expires; the "Sign-out not
          // revoking" alarm (docs/journeys.md, J0) watches this count
          obs.logger.warn("Refresh token not revoked", { status: response?.status ?? 0 });
          obs.count(BusinessMetric.SignOutRevokeFailures);
        }
      }
      return noContent([clearedCookie()]);
    } catch (error) {
      const apiError = errorFor(error);
      if (apiError.status >= 500 && !(error instanceof ApiError)) obs.logger.error("Request failed", error as Error);
      // A refused refresh token is dead: drop it so the app shows sign-in
      return errorResponse(apiError, apiError.status === 401 ? [clearedCookie()] : undefined);
    }
  };
}
