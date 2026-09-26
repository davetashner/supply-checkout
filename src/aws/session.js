// Sign-in for the web build (the auth routes in docs/api/openapi.yaml, and the README's
// "Sign-in"): Managed Login with the authorization code flow and PKCE. The API redeems
// the code at /auth/session and keeps the refresh token in an HttpOnly cookie; the access
// and ID tokens live only in this module's memory, never in storage.
import { request, json } from "./http.js";

const PKCE_KEY = "supplyCheckout.signIn";
// The admin scope lets the API read the user's email for invites (docs/api/onboarding.md)
const SCOPES = "openid email profile aws.cognito.signin.user.admin";
// Refresh this long before the access token expires (it lasts 60 minutes, the
// default when a response doesn't say)
const EARLY = 300, LIFETIME = 3600;
// The invite from a link, kept across sign-in (account.js)
export const INVITE_KEY = "supplyCheckout.invite";

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const claimsOf = (jwt) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));

export function createSession(config, { onSignedOut, onRefreshed }) {
  const redirectUri = location.origin + "/";
  let tokens = null, refreshing = null, timer;
  const post = (path, body) => request(config.apiUrl + path, { ...json("POST", body), credentials: "include" });

  function accept(t) {
    tokens = t;
    clearTimeout(timer);
    const life = t.expiresIn > 0 ? t.expiresIn : LIFETIME;
    timer = setTimeout(() => refresh().catch(() => {}), Math.max(60, life - EARLY) * 1000);
  }

  // One refresh at a time; a 401 means the session is over
  function refresh() {
    refreshing ||= post("/auth/refresh")
      .then((t) => { accept(t); onRefreshed(); }, (e) => { if (e.code === "unauthenticated") { tokens = null; onSignedOut(); } throw e; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    // Why the last sign-in didn't finish, for the sign-in screen
    notice: "",

    // Finishes a sign-in redirect, or resumes the session from the cookie. True when signed in.
    async start() {
      const q = new URLSearchParams(location.search);
      if (q.has("code") || q.has("error")) {
        const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY)) || {};
        const code = q.get("code"), state = q.get("state");
        sessionStorage.removeItem(PKCE_KEY);
        history.replaceState(null, "", location.pathname);
        if (code && state && state === saved.state) {
          try { accept(await post("/auth/session", { code, codeVerifier: saved.verifier, redirectUri })); return true; }
          catch (e) { if (e.code !== "unauthenticated") throw e; }
        }
        this.notice = "Sign-in didn't finish. Please try again.";
        return false;
      }
      try { accept(await post("/auth/refresh")); return true; }
      catch (e) { if (e.code === "unauthenticated") return false; throw e; }
    },

    // The Managed Login URL, with a new PKCE verifier and state kept for the redirect back
    async signInUrl() {
      const verifier = random(32), state = random(16);
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
      const q = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" });
      return `${config.authUrl}/oauth2/authorize?${q}`;
    },

    token: () => tokens.accessToken,
    claims: () => claimsOf(tokens.idToken),

    // An API call with the access token. A 401 refreshes the token and tries once more.
    async api(method, path, body, headers) {
      const send = () => {
        const init = body ? json(method, body, headers) : { method, headers: { ...headers } };
        init.headers.authorization = "Bearer " + tokens.accessToken;
        return request(config.apiUrl + path, init);
      };
      try { return await send(); }
      catch (e) {
        if (e.code !== "unauthenticated") throw e;
        await refresh();
        return send();
      }
    },

    // Revokes the refresh token, forgets sign-in's saved state, then signs out of Managed
    // Login too. False, still signed in, when the API couldn't be reached.
    async signOut() {
      try { await post("/auth/sign-out"); } catch { return false; }
      tokens = null;
      clearTimeout(timer);
      for (const key of [PKCE_KEY, INVITE_KEY]) sessionStorage.removeItem(key);
      location.assign(`${config.authUrl}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri })}`);
      return true;
    },
  };
}
