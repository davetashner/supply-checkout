// Operator sign-in for the page (supply-checkout-gxlt, ADR 0015): the authorization code flow
// with PKCE against the operator pool's Managed Login (ops-auth.<env domain>), never the
// customers' pool. Password, then TOTP, which the pool requires.
//
// - Before the redirect, only the PKCE verifier, the state and where to come back to are kept,
//   in sessionStorage (they have to survive the page leaving for the sign-in host), and they're
//   removed as soon as the page comes back, whatever the answer.
// - The access token lives only in the page's memory (main.js), never in storage or a cookie.
//   The token response's refresh and ID tokens are dropped without being kept anywhere: when the
//   access token expires (15 minutes) the operator signs in again, which within Managed Login's
//   one-hour session doesn't ask again.
// - A token is used only if its unverified claims say it's an access token for this page's ops
//   client from a Cognito user pool. That's not trust (the API's ops authorizer verifies it), it
//   stops the page from ever sending another client's token, a customer's say, to the ops routes.

export const SCOPE = "openid aws.cognito.signin.user.admin";
export const PENDING_KEY = "supplyCheckoutOps.pendingSignIn";
/** How long a started sign-in may take before its state is refused. */
export const PENDING_TTL_MS = 10 * 60_000;
const ISSUER = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/;
const RETURN_TO = /^#\/[A-Za-z0-9/_-]{0,200}$/;

export class SignInError extends Error {}

export function base64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE verifier and its S256 challenge. */
export async function pkce(crypto = globalThis.crypto) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function randomState(crypto = globalThis.crypto) {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

/** The Managed Login authorize URL for the ops client. */
export function authorizeUrl(config, { state, challenge }) {
  const url = new URL("/oauth2/authorize", config.authUrl);
  const params = {
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** Managed Login's logout, which ends its own session and comes back to the page. */
export function logoutUrl(config) {
  const url = new URL("/logout", config.authUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("logout_uri", config.redirectUri);
  return url.toString();
}

/** Only an in-page view (#/team/<id>, #/audit) is kept to come back to. */
export const safeReturnTo = (hash) => (RETURN_TO.test(String(hash ?? "")) ? hash : "");

/** Starts a sign-in: keeps the verifier and state for the way back, and returns where to go. */
export async function beginSignIn(config, { storage, crypto = globalThis.crypto, now = Date.now(), returnTo = "" }) {
  const { verifier, challenge } = await pkce(crypto);
  const state = randomState(crypto);
  storage.setItem(PENDING_KEY, JSON.stringify({ state, verifier, at: now, returnTo: safeReturnTo(returnTo) }));
  return authorizeUrl(config, { state, challenge });
}

/** The sign-in answer in the page's URL (?code=&state= or ?error=), or null if there's none. */
export function callbackParams(href) {
  const params = new URL(href).searchParams;
  if (!params.has("code") && !params.has("error") && !params.has("state")) return null;
  return { code: params.get("code"), state: params.get("state"), error: params.get("error") };
}

/** The page's URL without the sign-in answer, for history.replaceState. */
export function withoutCallback(href) {
  const url = new URL(href);
  return url.origin + url.pathname;
}

/**
 * Takes the pending sign-in out of storage (always) and checks the answer against it.
 * Returns { code, verifier, returnTo }, or throws SignInError.
 */
export function takePending(storage, answer, now = Date.now()) {
  let pending = null;
  try {
    pending = JSON.parse(storage.getItem(PENDING_KEY) ?? "null");
  } catch {}
  storage.removeItem(PENDING_KEY);
  if (answer.error) throw new SignInError(`Sign-in didn't finish (${String(answer.error).slice(0, 64)}). Sign in again.`);
  if (!pending || typeof pending.state !== "string" || typeof pending.verifier !== "string") {
    throw new SignInError("This sign-in wasn't started here. Sign in again.");
  }
  if (!answer.state || answer.state !== pending.state) throw new SignInError("The sign-in answer didn't match this request. Sign in again.");
  if (!(now - Number(pending.at) < PENDING_TTL_MS)) throw new SignInError("The sign-in took too long. Sign in again.");
  if (!answer.code) throw new SignInError("Sign-in didn't finish. Sign in again.");
  return { code: answer.code, verifier: pending.verifier, returnTo: safeReturnTo(pending.returnTo) };
}

/** A JWT's claims, unverified: only to decide whether to use it and when it expires. */
export function jwtClaims(token) {
  try {
    const part = String(token).split(".")[1] ?? "";
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (c) => c.charCodeAt(0))));
    return claims && typeof claims === "object" ? claims : {};
  } catch {
    return {};
  }
}

/**
 * The session for an access token, or SignInError if it isn't one for this page: an access
 * token (token_use), for the ops client (client_id), from a Cognito user pool (iss), not expired.
 */
export function sessionFor(token, config, now = Date.now()) {
  const claims = jwtClaims(token);
  if (claims.token_use !== "access") throw new SignInError("That isn't an access token. Sign in again.");
  if (claims.client_id !== config.clientId) throw new SignInError("That token isn't for the operator page. Sign in with an operator account.");
  if (typeof claims.iss !== "string" || !ISSUER.test(claims.iss)) throw new SignInError("That token isn't from the operator sign-in. Sign in again.");
  const exp = Number(claims.exp) * 1000;
  if (!Number.isFinite(exp) || exp <= now) throw new SignInError("That session has already ended. Sign in again.");
  return { token, expiresAt: exp, username: typeof claims.username === "string" ? claims.username.slice(0, 128) : "" };
}

/** Redeems the code at the ops pool's token endpoint. Keeps only the access token. */
export async function exchangeCode(config, { code, verifier }, fetchFn) {
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code, redirect_uri: config.redirectUri, code_verifier: verifier });
  let response;
  try {
    response = await fetchFn(new URL("/oauth2/token", config.authUrl).toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    throw new SignInError("Couldn't reach the operator sign-in. Sign in again.");
  }
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || typeof tokens?.access_token !== "string") {
    const reason = typeof tokens?.error === "string" ? tokens.error.slice(0, 64) : String(response.status);
    throw new SignInError(`Sign-in failed (${reason}). Sign in again.`);
  }
  return tokens.access_token;
}
