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
// and projects. The web build keeps one per team, at draftKey(teamId), and forgets them all
// on sign-out along with the team. The key without a team is the artifact's (and older
// web builds'), and is forgotten the same way.
export const DRAFT_KEY = "supplyCheckout.receiptDraft";
export const draftKey = (teamId) => `${DRAFT_KEY}.${teamId}`;
// The first-run checklist's state for a team this device's owner created (src/first-run.js):
// {} while it's showing, invited once they've invited someone, done once it's finished or
// dismissed. Not forgotten on sign-out, so a dismissed checklist stays dismissed; it holds no
// team data.
export const FIRST_RUN_KEY = "supplyCheckout.firstRun";
export const firstRunKey = (teamId) => `${FIRST_RUN_KEY}.${teamId}`;
// Whose the team choice and drafts on this device are: the user ID from /me. A session can
// end without Sign out (it expired, or a sign-out timed out here but went through), and then
// the next person to sign in may be someone else; account.js forgets the saved team and
// drafts when the user doesn't match. Another tab still open as the last user sees the mark
// change (or go, on sign-out) and stops (account.js).
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
// can't be removed doesn't keep the rest. True when none are left.
const saved = () => local.keys().filter((k) => k === TEAM_KEY || k === DRAFT_KEY || k.startsWith(DRAFT_KEY + "."));
export function forgetLocal() {
  for (const key of saved()) local.remove(key);
  return !saved().length;
}

// A first Google or Apple sign-in whose email already has an account: the pre sign-up trigger
// (backend/src/identity/account-link-handler.ts) links it to that account and fails that one
// sign-in on purpose, and Cognito sends the person back with "PreSignUp failed with error
// ACCOUNT_LINKED:<provider>." Signing in again with the provider lands in the existing account.
const LINKED = /\bACCOUNT_LINKED:(Google|SignInWithApple)\b/;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
// Why a call is refused once the session has ended here
const ENDED = { code: "unauthenticated", message: "Signed out" };
// Why a refresh is dropped once the API has refused the session for a password reset
const RESETTING = { code: "unauthenticated", message: "Password reset" };
const claimsOf = (jwt) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));

export function createSession(config, { onSignedOut, onRefreshed, onUserChanged, onPasswordReset }) {
  const redirectUri = location.origin + "/";
  // ended: this tab is done with the session for good (the account was deleted, or another
  // tab changed who's signed in), so a refresh still on its way isn't taken up
  // user: the ID token's sub from sign-in, which every refresh must match
  // resetting: the API refused this session as older than the account's password reset
  let tokens = null, refreshing = null, timer, signingOut = false, ended = false, user = null, resetting = false;
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

  // The tokens this session starts with, and whose they are
  function begin(t) {
    user = claimsOf(t.idToken).sub;
    accept(t);
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

  // Another tab signed someone else in, or signed out: this tab stops using the session at
  // once. Nothing is revoked or forgotten (that's the other tab's), no refresh is sent or
  // taken up (the refresh cookie may be the other user's now), and every API call is
  // refused as unauthenticated without reaching the API. Calls already sent finish as
  // they were: with this user's token.
  function end() {
    signingOut = ended = true;
    clearTimeout(timer);
    tokens = null;
  }

  // One refresh at a time; a 401 means the session is over. None while signing out: with
  // refresh-token rotation, one that started after the revoke (a 401 from a live update's
  // fetch, say) would set a new refresh cookie and sign the user back in. One that answers
  // after the session ended here is dropped: after another tab signed in, its tokens are
  // the other user's.
  function refresh() {
    if (ended) return Promise.reject(ENDED);
    if (signingOut) return Promise.reject({ code: "unavailable", message: "Signing out" });
    refreshing ||= post("/auth/refresh")
      .then((t) => {
        if (ended) throw ENDED;
        // The reset screen stays: a refresh on its way when the API refused the session for a
        // password reset neither takes up new tokens (they'd keep the old sign-in time) nor
        // shows the sign-in screen over it
        if (resetting) throw RESETTING;
        // Someone else signed in in another tab (the refresh cookie is shared), and this tab
        // didn't hear of it: never take up their tokens here
        if (claimsOf(t.idToken).sub !== user) { end(); onUserChanged(); throw ENDED; }
        accept(t);
        onRefreshed();
      }, (e) => { if (e.code === "unauthenticated" && !resetting) { tokens = null; onSignedOut(); } throw e; })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  // The API refused this session: it began before the account's password was reset
  // (supply-checkout-6uw.33), and every call with its tokens will be refused the same way, so
  // no refresh is tried (refreshed tokens keep the session's sign-in time). Said once; this
  // call and every later one (each refused the same way) never settle, so nothing behind
  // them shows an error or a sign-in screen over the one onPasswordReset shows, whose
  // sign-out leaves the page.
  function passwordWasReset() {
    clearTimeout(timer);
    if (!resetting) { resetting = true; onPasswordReset(); }
    return new Promise(() => {});
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
          try { begin(await post("/auth/session", { code, codeVerifier: saved.verifier, redirectUri })); return true; }
          catch (e) { if (e.code !== "unauthenticated") throw e; }
        }
        this.notice = "Sign-in didn't finish. Please try again.";
        return false;
      }
      try { begin(await post("/auth/refresh")); return true; }
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

    // New tokens now, as the scheduled refresh gets them. After the user verifies their email
    // (verify-email.js), this is what has the pre token generation trigger record it.
    refresh: () => refresh(),

    // The access token and the ID token's claims; "" and null once the session has ended
    // (signed out, or a refresh found it over), rather than throwing
    token: () => (tokens ? tokens.accessToken : ""),
    claims: () => (tokens ? claimsOf(tokens.idToken) : null),

    // An API call with the access token. A 401 refreshes the token and tries once more.
    // Once the session has ended (signed out, or a refresh found it over) there's no token:
    // a call then, such as a save while the Managed Login sign-out page loads, is refused
    // as unauthenticated without reaching the API.
    // `options` are request()'s: a longer timeout, and the caller's abort signal.
    async api(method, path, body, headers, options) {
      if (!tokens) throw ENDED;
      const send = () => {
        const init = body ? json(method, body, headers) : { method, headers: { ...headers } };
        init.headers.authorization = "Bearer " + tokens.accessToken;
        return request(config.apiUrl + path, init, options).catch((e) => {
          if (e.reason === "password_reset") return passwordWasReset();
          throw e;
        });
      };
      try { return await send(); }
      catch (e) {
        if (e.code !== "unauthenticated") throw e;
        // A refresh dropped for a password reset leaves this call unanswered, as the reset's own are
        await refresh().catch((r) => (resetting ? passwordWasReset() : Promise.reject(r)));
        return send();
      }
    },

    // Revokes the refresh token, forgets sign-in's saved state, the chosen team, every
    // team's receipt draft and whose they were, then signs out of Managed Login too. False, still signed in, when the API couldn't be
    // reached. A refresh already in flight finishes first: with refresh-token rotation, its
    // response would otherwise set a new refresh cookie after sign-out cleared it. With `keep`
    // (signing in again for billing, account.js), nothing of theirs is forgotten: the same
    // person signs straight back in and keeps their team and drafts.
    async signOut(keep = false) {
      signingOut = true;
      clearTimeout(timer);
      if (refreshing) await refreshing.catch(() => {});
      clearTimeout(timer);
      // Still signed in when it fails, so refresh again in a minute
      try { await post("/auth/sign-out"); } catch { signingOut = false; timer = setTimeout(background, 60_000); return false; }
      tokens = null;
      clearTimeout(timer);
      if (!keep) forget();
      location.assign(logoutUrl());
      return true;
    },

    end,

    // After two-step sign-in was turned on (mfa.js): the API signed the user out everywhere,
    // so nothing is revoked here, and the refresh the API now refuses clears the refresh
    // cookie. Nothing of theirs is forgotten: the same person signs straight back in, and
    // keeps their team and drafts. Resolves to Managed Login's sign-out URL, which ends its
    // own session too, so the next sign-in asks for the password and the app's code.
    async endEverywhere() {
      signingOut = ended = true;
      clearTimeout(timer);
      tokens = null;
      await post("/auth/refresh").catch(() => {});
      return logoutUrl();
    },

    // After the account was deleted (DELETE /me): Cognito already ended every session, so
    // nothing is revoked. Forgets what signOut forgets, and asks for a refresh, which the
    // API refuses now the user is gone and answers by clearing the refresh cookie. No
    // refresh after that (a live update's 401, say) signs anyone in or out again. Resolves
    // to Managed Login's sign-out URL.
    async forgetDeleted() {
      signingOut = ended = true;
      clearTimeout(timer);
      tokens = null;
      forget();
      await post("/auth/refresh").catch(() => {});
      return logoutUrl();
    },
  };
}
