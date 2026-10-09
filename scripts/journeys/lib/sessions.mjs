// Signed-in sessions of the long-lived accounts, reused across a run's tests. Each password
// sign-in through Managed Login also mails crew and viewer a code, and a dozen in a few minutes
// hit Cognito's request limit ("Too many requests"), so later tests reuse a session. The pool
// is per account, shared by both browser projects (the cookie isn't tied to a browser): an
// account goes through Managed Login once, plus once more for each test that needs it while
// all its sessions are leased (the two workers overlapping), plus J0.2's own sign-in in each
// project, which is always fresh.
//
// A session is the app's refresh-token cookie on the API's origin (HttpOnly, Path=/auth). The
// tokens the app holds in memory aren't kept. Refresh tokens rotate (the old one dies 10 seconds
// after it's used), so a session is leased, not shared: take() moves it out of the pool with an
// atomic rename, so two workers never hold the same one, and the test puts the latest cookie
// back when it's done (put()). A test that finds the pool empty signs in through Managed Login.
//
// The pool is the run directory's sessions/ (mode 700, each file 600, on the runner's temporary
// disk): never uploaded (upload-results.mjs NOT_UPLOADED), each token masked when read or
// written, and deleted by cleanup after GlobalSignOut has revoked every refresh token of the
// long-lived accounts.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SESSIONS_DIR = "sessions";
/** The annotation signIn adds for each sign-in ("<role>: Managed Login" or "<role>: saved session"), counted in the job summary. */
export const SIGN_IN = "journeys-sign-in";
const SAFE = /^[a-z0-9-]{1,40}$/;
/** A session expiring sooner than this isn't worth taking. */
const MIN_LIFE_S = 300;

/** The API's refresh-token cookie (backend/src/api/routes.ts REFRESH_COOKIE). */
export const REFRESH_COOKIE = "__Secure-sc_refresh";

/** The cookie's path (backend/src/api/routes.ts REFRESH_COOKIE_PATH). */
export const REFRESH_COOKIE_PATH = "/auth";

/**
 * The URL whose cookies hold the session: where the app sends its refresh. A context's
 * cookies(url) returns only the cookies a request to that URL would carry, path included, so
 * cookies(apiOrigin) (path "/") never has the refresh cookie (Path=/auth), and nothing was put
 * back in the pool (supply-checkout-o60.7).
 */
export const sessionUrl = (apiOrigin) => `${new URL(apiOrigin).origin}${REFRESH_COOKIE_PATH}/refresh`;

/**
 * The one cookie a session keeps, from a context's cookies: the API's refresh cookie, with only
 * the fields addCookies needs in any browser (no partition key or browser-specific field).
 */
export function sessionCookie(cookies, apiOrigin) {
  const host = new URL(apiOrigin).hostname;
  const c = (cookies ?? []).find((c) => c && c.name === REFRESH_COOKIE && c.httpOnly && c.secure && (c.domain === host || c.domain === `.${host}`) && /^\/auth(\/|$)/.test(c.path) && typeof c.value === "string" && c.value.length > 0);
  if (!c) return null;
  const out = { name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: true, secure: true };
  if (["Strict", "Lax", "None"].includes(c.sameSite)) out.sameSite = c.sameSite;
  return out;
}

/** A browser context's session as it is now (the app's refresh rotates it), or null. */
export async function readSession(context, apiOrigin) {
  return sessionCookie(await context.cookies(sessionUrl(apiOrigin)), apiOrigin);
}

/**
 * The pool under `runDirectory`. `masker` masks every token it reads or writes; `now` is in
 * seconds, as a cookie's `expires` is.
 */
export function createSessionPool(runDirectory, { masker, now = () => Date.now() / 1000 } = {}) {
  const root = path.join(runDirectory, SESSIONS_DIR);
  const slot = (role) => {
    if (!SAFE.test(role)) throw new Error("A session slot is a role in lowercase letters, digits and dashes");
    return path.join(root, role);
  };
  const usable = (c) => c && typeof c.value === "string" && c.value && (c.expires === -1 || c.expires === undefined || c.expires - now() > MIN_LIFE_S);
  return {
    root,
    /** A session for `role`, taken out of the pool, or null. */
    take(role) {
      const dir = slot(role);
      let names;
      try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return null; }
      for (const name of names) {
        const leased = path.join(dir, `${name}.taken-${process.pid}-${randomBytes(4).toString("hex")}`);
        try { renameSync(path.join(dir, name), leased); } catch { continue; } // another worker took it
        let cookie = null;
        try { cookie = JSON.parse(readFileSync(leased, "utf8")); } catch { /* unreadable: dropped */ }
        try { unlinkSync(leased); } catch { /* already gone */ }
        if (cookie?.value) masker?.add(cookie.value);
        if (usable(cookie)) return cookie;
      }
      return null;
    },
    /** Puts a session (the latest cookie) back for the next test. */
    put(role, cookie) {
      if (!usable(cookie)) return false;
      masker?.add(cookie.value);
      const dir = slot(role);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const name = `${randomBytes(8).toString("hex")}.json`;
      const tmp = path.join(dir, `${name}.tmp`);
      writeFileSync(tmp, JSON.stringify(cookie), { mode: 0o600 });
      renameSync(tmp, path.join(dir, name));
      return true;
    },
    /** Records that `role` has a session (one is out on lease or in the pool). */
    markIssued(role) {
      const dir = slot(role);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, `.issued-${randomBytes(4).toString("hex")}`), "", { mode: 0o600 });
    },
    /** Whether `role` was ever given a session this run (worth waiting for one to come back). */
    wasIssued(role) {
      try { return readdirSync(slot(role)).some((n) => n.startsWith(".issued-")); } catch { return false; }
    },
    /** Every token still in the pool (for the upload's leak check). */
    tokens() {
      const out = [];
      let entries;
      try { entries = readdirSync(root, { recursive: true, withFileTypes: true }); } catch { return out; }
      for (const d of entries) {
        if (!d.isFile()) continue;
        try { const v = JSON.parse(readFileSync(path.join(d.parentPath ?? d.path, d.name), "utf8"))?.value; if (typeof v === "string" && v) out.push(v); } catch { /* not a session */ }
      }
      return out;
    },
    /** Deletes the pool. */
    clear() { rmSync(root, { recursive: true, force: true }); },
  };
}
