// Signed-in sessions of the long-lived accounts, reused across a run's tests. Each password
// sign-in through Managed Login also mails crew and viewer a code, and a dozen in a few minutes
// hit Cognito's request limit ("Too many requests"), so each account signs in about once per
// browser project and later tests reuse the session.
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
const SAFE = /^[a-z0-9-]{1,40}$/;
/** A session expiring sooner than this isn't worth taking. */
const MIN_LIFE_S = 300;

/** The API's refresh-token cookie (backend/src/api/routes.ts REFRESH_COOKIE). */
export const REFRESH_COOKIE = "__Secure-sc_refresh";

/** The one cookie a session keeps, from a context's cookies: the API's refresh cookie. */
export function sessionCookie(cookies, apiOrigin) {
  const host = new URL(apiOrigin).hostname;
  return (cookies ?? []).find((c) => c && c.name === REFRESH_COOKIE && c.httpOnly && c.secure && (c.domain === host || c.domain === `.${host}`) && /^\/auth(\/|$)/.test(c.path) && typeof c.value === "string" && c.value.length > 0) ?? null;
}

/**
 * The pool under `runDirectory`. `masker` masks every token it reads or writes; `now` is in
 * seconds, as a cookie's `expires` is.
 */
export function createSessionPool(runDirectory, { masker, now = () => Date.now() / 1000 } = {}) {
  const root = path.join(runDirectory, SESSIONS_DIR);
  const slot = (project, role) => {
    if (!SAFE.test(project) || !SAFE.test(role)) throw new Error("A session slot is a project and a role in lowercase letters, digits and dashes");
    return path.join(root, project, role);
  };
  const usable = (c) => c && typeof c.value === "string" && c.value && (c.expires === -1 || c.expires === undefined || c.expires - now() > MIN_LIFE_S);
  return {
    root,
    /** A session for `role` in `project`, taken out of the pool, or null. */
    take(project, role) {
      const dir = slot(project, role);
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
    put(project, role, cookie) {
      if (!usable(cookie)) return false;
      masker?.add(cookie.value);
      const dir = slot(project, role);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const name = `${randomBytes(8).toString("hex")}.json`;
      const tmp = path.join(dir, `${name}.tmp`);
      writeFileSync(tmp, JSON.stringify(cookie), { mode: 0o600 });
      renameSync(tmp, path.join(dir, name));
      return true;
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
