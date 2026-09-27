// Sign-in for the web build (the auth routes in docs/api/openapi.yaml, and "Sign-in" in
// docs/infrastructure.md): Managed Login with the authorization code flow and PKCE. The
// API redeems the code at /auth/session and keeps the refresh token in an HttpOnly cookie;
// the access and ID tokens live only in this module's memory, never in storage.
import { request, json } from "./http.js";

const PKCE_KEY = "supplyCheckout.signIn";
// The admin scope lets the API read the user's email for invites (docs/api/onboarding.md)
const SCOPES = "openid email profile aws.cognito.signin.user.admin";
// Refresh this long before the access token expires (it lasts 60 minutes, the
// default when a response doesn't say)
const EARLY = 300, LIFETIME = 3600;
// The invite from a link, kept across sign-in (account.js)
export const INVITE_KEY = "supplyCheckout.invite";
// The team the user last chose (account.js)
export const TEAM_KEY = "supplyCheckout.team";
// The receipt being entered (DKEY in src/main.js), which names the team's items, prices
// and sheets. The web build keeps one per team, at draftKey(teamId), and forgets them all
// on sign-out along with the team. The key without a team is the artifact's (and older
// web builds'), and is forgotten the same way.
export const DRAFT_KEY = "supplyCheckout.receiptDraft";
export const draftKey = (teamId) => `${DRAFT_KEY}.${teamId}`;
// Whose the team choice and drafts on this device are: the user ID from /me. A session can
// end without Sign out (it expired, or a sign-out timed out here but went through), and then
// the next person to sign in may be someone else; account.js forgets the saved team and
// drafts when the user doesn't match.
export const OWNER_KEY = "supplyCheckout.owner";

// localStorage and sessionStorage, where any access can throw (blocked site data, some
// sandboxed frames, a full quota): a read that fails finds nothing, and a write that fails
// is skipped, so storage is only ever a convenience.
const store = (area) => ({
  get(key) { try { return window[area].getItem(key); } catch { return null; } },
  json(key) { try { return JSON.parse(window[area].getItem(key)); } catch { return null; } },
  set(key, value) { try { window[area].setItem(key, value); } catch { /* not kept */ } },
  remove(key) { try { window[area].removeItem(key); } catch { /* nothing more to do */ } },
  keys() { try { return Object.keys(window[area]); } catch { return []; } },
});
export const local = store("localStorage"), tab = store("sessionStorage");

// Forgets the chosen team and every team's receipt draft, one key at a time, so one that
// can't be removed doesn't keep the rest
export function forgetLocal() {
  for (const key of [TEAM_KEY, ...local.keys().filter((k) => k === DRAFT_KEY || k.startsWith(DRAFT_KEY + "."))]) local.remove(key);
}

// A first Google or Apple sign-in whose email already has an account: the pre sign-up trigger
// (backend/src/identity/account-link-handler.ts) links it to that account and fails that one
// sign-in on purpose, and Cognito sends the person back with "PreSignUp failed with error
// ACCOUNT_LINKED:<provider>." Signing in again with the provider lands in the existing account.
const LINKED = /\bACCOUNT_LINKED:(Google|SignInWithApple)\b/;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const claimsOf = (jwt) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));

export function createSession(config, { onSignedOut, onRefreshed }) {
  const redirectUri = location.origin + "/";
  let tokens = null, refreshing = null, timer, signingOut = false;
  const post = (path, body) => request(config.apiUrl + path, { ...json("POST", body), credentials: "include" });
  const logoutUrl = () => `${config.authUrl}/logout?${new URLSearchParams({ client_id: config.clientId, logout_uri: redirectUri })}`;

  // Sign-in's saved state, the chosen team, every team's receipt draft and whose they were.
  // Storage that can't be written (blocked site data) mustn't stop the Managed Login
  // sign-out, and a key that can't be removed mustn't keep the others.
  function forget() {
    for (const key of [PKCE_KEY, INVITE_KEY]) tab.remove(key);
    forgetLocal();
    local.remove(OWNER_KEY);
  }

  function accept(t) {
    tokens = t;
    clearTimeout(timer);
    const life = t.expiresIn > 0 ? t.expiresIn : LIFETIME;
    timer = setTimeout(background, Math.max(60, life - EARLY) * 1000);
  }

  // A scheduled refresh that fails for any reason but an ended session (the API didn't
  // answer, or timed out) tries again in a minute, so the live updates' token doesn't go
  // stale until the next 401. Not while signing out: that sets its own timer if it fails.
  const background = () => refresh().catch((e) => {
    if (e.code !== "unauthenticated" && !signingOut) { clearTimeout(timer); timer = setTimeout(background, 60_000); }
  });

  // One refresh at a time; a 401 means the session is over. None while signing out: with
  // refresh-token rotation, one that started after the revoke (a 401 from a live update's
  // fetch, say) would set a new refresh cookie and sign the user back in.
  function refresh() {
    if (signingOut) return Promise.reject({ code: "unavailable", message: "Signing out" });
    refreshing ||= post("/auth/refresh")
      .then((t) => { accept(t); onRefreshed(); }, (e) => { if (e.code === "unauthenticated") { tokens = null; onSignedOut(); } throw e; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    // Why the last sign-in didn't finish, for the sign-in screen
    notice: "",
    // The provider to sign in with again, straight away, after a sign-in was linked to an
    // existing account (see LINKED)
    relink: "",

    // Finishes a sign-in redirect, or resumes the session from the cookie. True when signed in.
    async start() {
      const q = new URLSearchParams(location.search);
      if (q.has("code") || q.has("error")) {
        const saved = tab.json(PKCE_KEY) || {};
        const code = q.get("code"), state = q.get("state");
        tab.remove(PKCE_KEY);
        history.replaceState(null, "", location.pathname);
        // Only for the sign-in this tab started, and only once, so it can't loop
        const linked = !code && state && state === saved.state && !saved.relinked && LINKED.exec(q.get("error_description") || "");
        if (linked) { this.relink = linked[1]; return false; }
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

    // The Managed Login URL, with a new PKCE verifier and state kept for the redirect back.
    // With `provider` (a relink), it goes straight to that provider, and is marked so a second
    // link error isn't retried.
    async signInUrl(provider) {
      const verifier = random(32), state = random(16);
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      tab.set(PKCE_KEY, JSON.stringify(provider ? { verifier, state, relinked: true } : { verifier, state }));
      const q = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: redirectUri, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: "S256" });
      if (provider) q.set("identity_provider", provider);
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

    // Revokes the refresh token, forgets sign-in's saved state, the chosen team, every
    // team's receipt draft and whose they were, then signs out of Managed Login too. False, still signed in, when the API couldn't be
    // reached. A refresh already in flight finishes first: with refresh-token rotation, its
    // response would otherwise set a new refresh cookie after sign-out cleared it.
    async signOut() {
      signingOut = true;
      clearTimeout(timer);
      if (refreshing) await refreshing.catch(() => {});
      clearTimeout(timer);
      // Still signed in when it fails, so refresh again in a minute
      try { await post("/auth/sign-out"); } catch { signingOut = false; timer = setTimeout(background, 60_000); return false; }
      tokens = null;
      clearTimeout(timer);
      forget();
      location.assign(logoutUrl());
      return true;
    },

    // After the account was deleted (DELETE /me): Cognito already ended every session, so
    // nothing is revoked. Forgets what signOut forgets, and asks for a refresh, which the
    // API refuses now the user is gone and answers by clearing the refresh cookie. No
    // refresh after that (a live update's 401, say) signs anyone in or out again. Resolves
    // to Managed Login's sign-out URL.
    async forgetDeleted() {
      signingOut = true;
      clearTimeout(timer);
      tokens = null;
      forget();
      await post("/auth/refresh").catch(() => {});
      return logoutUrl();
    },
  };
}
