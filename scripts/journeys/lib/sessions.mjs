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
import { RefreshInFlight } from "./app-stop.mjs";

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

/**
 * The sessions a test holds, one per browser context, and how each goes back to the pool.
 *
 * A context has one refresh cookie, so it holds one role's session: check() (and hold()) throw
 * when the context already holds another role's, so release can never file one account's session
 * under another's.
 *
 * release(context), in this order: refuses if the context is still being traced (the cookie read
 * would be in its trace.zip), stops the app (`stopApp`: after it nothing in the context can
 * refresh, so the cookie read is the live one and nobody spends it after it's pooled), reads the
 * cookie and puts it back. No cookie to put back is a warning (`warn`); a closed context has none
 * and isn't one. If the app couldn't be stopped, or a refresh was still in flight when it was
 * (stopApp throws RefreshInFlight: the cookie may be spent), the cookie isn't pooled.
 *
 * A context is let go before release checks anything, so a refused release (still tracing) is
 * deliberately never retried: its cookie is never read, and the next test signs in again.
 */
export function createSessionHolds({ pool, apiOrigin, stopApp, assertNotTracing, warn, read = readSession }) {
  const held = new Map();
  const holds = {
    check(context, role) {
      const holder = held.get(context);
      if (holder !== undefined && holder !== role) throw new Error(`This browser context holds the ${holder} session already: sign ${role} in in a context of their own`);
    },
    hold(context, role) {
      holds.check(context, role);
      held.set(context, role);
    },
    contexts: () => [...held.keys()],
    async release(context) {
      if (!held.has(context)) return;
      const role = held.get(context);
      held.delete(context);
      assertNotTracing(context, "reading the session's refresh cookie");
      try { await stopApp(context); } catch (err) {
        const why = err instanceof RefreshInFlight ? "a refresh was still in flight when the app was stopped" : "the app couldn't be stopped after the test";
        warn(`${role}: ${why}, so its session wasn't saved and the next test signs in through Managed Login again`);
        return;
      }
      let cookie;
      try { cookie = await read(context, apiOrigin); } catch { return; }
      if (!pool.put(role, cookie)) warn(`${role}: no session to save after the test, so the next test signs in through Managed Login again`);
    },
  };
  return holds;
}

/**
 * Drops the context's refresh cookie for the API (a spent session): only that cookie, on the
 * API's host and the cookie's path, never another origin's cookie of the same name.
 */
export function dropSession(context, apiOrigin) {
  return context.clearCookies({ name: REFRESH_COOKIE, domain: new URL(apiOrigin).hostname, path: REFRESH_COOKIE_PATH });
}

/**
 * Opens the app on `page` with a pooled session (or none) and says whether the app took it up:
 * its GET /me (`meResponse`) came before the sign-in screen (`signInShown()`). A session the app
 * can't refresh (revoked, or spent by a refresh elsewhere) ends on the sign-in screen, maybe with
 * the app's requests still in flight. Then, before anything navigates to Managed Login, the app
 * is stopped (`stopApp`, which allows those requests' cut-off), the spent cookie is dropped
 * (`dropSession`), and the app is loaded again, signed out. False means: sign in through Managed
 * Login, from the app's sign-in screen.
 */
export async function resumeSession(page, session, { meResponse, signInShown, stopApp, dropSession }) {
  const context = page.context();
  if (session) await context.addCookies([session]);
  await page.goto("/");
  if (!session) return false;
  const reused = await Promise.race([meResponse.then(() => true, () => false), signInShown().then(() => false, () => false)]);
  if (reused) return true;
  // The session is dropped anyway, so a refresh still in flight doesn't matter here
  try { await stopApp(context); } catch (err) { if (!(err instanceof RefreshInFlight)) throw err; }
  await dropSession(context);
  await page.goto("/");
  return false;
}
