// node --test scripts/journeys/test/ (part of npm run test:scripts): the long-lived accounts'
// saved sessions (lib/sessions.mjs), leased one test at a time and never uploaded.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PROD } from "../lib/config.mjs";
import { createMasker } from "../lib/mask.mjs";
import { RefreshInFlight, isAbandonedRequestError, stopApp, trackRequests } from "../lib/app-stop.mjs";
import { REFRESH_COOKIE, REFRESH_COOKIE_PATH, SESSIONS_DIR, createSessionHolds, createSessionPool, dropSession, readSession, resumeSession, sessionCookie, sessionUrl } from "../lib/sessions.mjs";
import { assertNotTracing, markTracing, unmarkTracing } from "../lib/tracing.mjs";
import { fakeBrowserContext, fakeRequest } from "./helpers.mjs";
import { NOT_UPLOADED, filesToUpload } from "../upload-results.mjs";

const NOW = 1_800_000_000;
const host = new URL(PROD.api).hostname;
const cookie = (value, extra = {}) => ({ name: "__Secure-sc_refresh", value, domain: host, path: "/auth", expires: NOW + 30 * 86400, httpOnly: true, secure: true, sameSite: "Strict", ...extra });
const pool = (dir = mkdtempSync(path.join(tmpdir(), "sessions-")), masker = createMasker({ github: false })) => ({ dir, masker, sessions: createSessionPool(dir, { masker, now: () => NOW }) });

test("sessionCookie takes only the API's HttpOnly, Secure refresh cookie under /auth", () => {
  const good = cookie("refresh-token-value");
  assert.deepEqual(sessionCookie([{ ...good, name: "other" }, { ...good, path: "/" }, { ...good, httpOnly: false }, { ...good, secure: false }, { ...good, domain: "app.example.com" }, { ...good, value: "" }, good], PROD.api), good);
  assert.deepEqual(sessionCookie([{ ...good, domain: `.${host}`, path: "/auth/refresh" }], PROD.api)?.path, "/auth/refresh");
  assert.equal(sessionCookie([{ ...good, path: "/authx" }], PROD.api), null);
  assert.equal(sessionCookie([], PROD.api), null);
  assert.equal(sessionCookie(undefined, PROD.api), null);
});

test("sessionCookie keeps only the fields addCookies takes in every browser", () => {
  const got = sessionCookie([{ ...cookie("refresh-token-value"), partitionKey: "https://app.example.com", _crHasCrossSiteAncestor: false }], PROD.api);
  assert.deepEqual(got, cookie("refresh-token-value"));
  assert.equal("sameSite" in sessionCookie([{ ...cookie("v-aaaa"), sameSite: "bogus" }], PROD.api), false);
});

// A browser context's cookies(urls), as Playwright filters them (filterCookies in
// playwright-core): a cookie whose domain matches the URL's host and whose path is a prefix of
// the URL's path; Secure ones only for https
const fakeContext = (jar) => ({
  async cookies(urls) {
    const list = urls === undefined ? [] : [urls].flat().map((u) => new URL(u));
    return jar.filter((c) => !list.length || list.some((u) => {
      const domain = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
      return `.${u.hostname}`.endsWith(domain) && u.pathname.startsWith(c.path) && (u.protocol === "https:" || !c.secure);
    }));
  },
});

test("readSession finds the refresh cookie under its path, which the API's origin alone never shows", async () => {
  const jar = [cookie("refresh-token-zzzz"), { ...cookie("app-cookie"), name: "other", domain: new URL(PROD.app).hostname, path: "/" }];
  const ctx = fakeContext(jar);
  // The bug: cookies(PROD.api) asks for path "/", which a Path=/auth cookie doesn't match
  assert.equal(sessionCookie(await ctx.cookies(PROD.api), PROD.api), null);
  assert.equal(sessionUrl(PROD.api), `${PROD.api}${REFRESH_COOKIE_PATH}/refresh`);
  assert.equal(sessionUrl(`${PROD.api}/`), `${PROD.api}/auth/refresh`);
  assert.deepEqual(await readSession(ctx, PROD.api), cookie("refresh-token-zzzz"));
  assert.equal(await readSession(fakeContext([]), PROD.api), null, "a signed-out context has none");
});

test("a session read from a test's context goes back in the pool and out to the next test", async () => {
  const { sessions } = pool();
  assert.equal(sessions.put("crew", await readSession(fakeContext([cookie("rotated-token-yyyy")]), PROD.api)), true);
  assert.equal(sessions.take("crew").value, "rotated-token-yyyy");
});

test("a session is leased: take() removes it, so two takers never get the same one", () => {
  const { dir, masker, sessions } = pool();
  assert.equal(sessions.take("crew"), null, "an empty pool");
  assert.equal(sessions.put("crew", cookie("token-one-aaaa")), true);
  assert.equal(sessions.put("crew", cookie("token-two-bbbb")), true);
  const a = sessions.take("crew"), b = sessions.take("crew");
  assert.deepEqual([a.value, b.value].sort(), ["token-one-aaaa", "token-two-bbbb"]);
  assert.equal(sessions.take("crew"), null);
  assert.equal(sessions.take("viewer"), null, "each account has its own");
  assert.ok(masker.has("token-one-aaaa") && masker.has("token-two-bbbb"), "every token is masked");
  assert.deepEqual(readdirSync(path.join(dir, SESSIONS_DIR, "crew")), [], "nothing left behind");
});

test("the pool is private: a 700 directory of 600 files", () => {
  const { dir, sessions } = pool();
  sessions.put("viewer", cookie("token-three-cccc"));
  const slot = path.join(dir, SESSIONS_DIR, "viewer");
  assert.equal(statSync(slot).mode & 0o777, 0o700);
  for (const f of readdirSync(slot)) assert.equal(statSync(path.join(slot, f)).mode & 0o777, 0o600);
});

test("expired, nearly expired and malformed sessions aren't kept or given out", () => {
  const { dir, sessions } = pool();
  assert.equal(sessions.put("crew", cookie("old-token-dddd", { expires: NOW + 60 })), false);
  assert.equal(sessions.put("crew", null), false);
  assert.equal(sessions.put("crew", { ...cookie("x"), value: "" }), false);
  const slot = path.join(dir, SESSIONS_DIR, "crew");
  sessions.put("crew", cookie("session-token-eeee", { expires: -1 }));
  writeFileSync(path.join(slot, "broken.json"), "{ not json", { mode: 0o600 });
  writeFileSync(path.join(slot, "stale.json"), JSON.stringify(cookie("stale-token-ffff", { expires: NOW + 10 })), { mode: 0o600 });
  const got = [sessions.take("crew"), sessions.take("crew")].filter(Boolean).map((c) => c.value);
  assert.deepEqual(got, ["session-token-eeee"]);
  assert.deepEqual(readdirSync(slot), [], "the bad ones are dropped as they're found");
});

test("slot names are checked", () => {
  const { sessions } = pool();
  for (const role of ["crew/../../x", "../x", "Crew", ""]) assert.throws(() => sessions.put(role, cookie("token-gggg")), /session slot/, role);
});

test("one pool serves both browser projects, and remembers that a role was given a session", () => {
  const { sessions } = pool();
  assert.equal(sessions.wasIssued("crew"), false);
  sessions.markIssued("crew");
  assert.equal(sessions.wasIssued("crew"), true);
  assert.equal(sessions.wasIssued("viewer"), false);
  assert.equal(sessions.take("crew"), null, "the marker isn't a session");
  assert.deepEqual(sessions.tokens(), [], "nor a token");
  sessions.put("crew", cookie("desktop-made-kkkk"));
  assert.equal(sessions.take("crew").value, "desktop-made-kkkk", "a session put back by one project's test is taken by the other's");
});

test("tokens() lists what's left for the upload's leak check, and clear() deletes the pool", () => {
  const { dir, sessions } = pool();
  assert.deepEqual(sessions.tokens(), []);
  sessions.put("owner", cookie("owner-token-hhhh"));
  sessions.put("crew", cookie("crew-token-iiii"));
  assert.deepEqual(sessions.tokens().sort(), ["crew-token-iiii", "owner-token-hhhh"]);
  sessions.clear();
  assert.equal(existsSync(path.join(dir, SESSIONS_DIR)), false);
  assert.deepEqual(sessions.tokens(), []);
  sessions.clear();
});

test("the sessions are never uploaded", () => {
  const { dir, sessions } = pool();
  writeFileSync(path.join(dir, "report.json"), "{}");
  sessions.put("crew", cookie("crew-token-jjjj"));
  assert.deepEqual(filesToUpload(dir), ["report.json"]);
  assert.ok(NOT_UPLOADED.includes(`${SESSIONS_DIR}/*`));
});

// The sessions a test holds and their release (createSessionHolds), with a browser context that
// logs what happens to it, in order
const holdsFor = ({ log = [], stop, read, sessions = pool().sessions } = {}) => {
  const warnings = [];
  const holds = createSessionHolds({
    pool: sessions,
    apiOrigin: PROD.api,
    stopApp: stop ?? (async (ctx) => { log.push("stopApp"); await stopApp(ctx, { apiOrigin: PROD.api, settleMs: 0, sleep: async () => {} }); }),
    assertNotTracing: (ctx, what) => { log.push("assertNotTracing"); assertNotTracing(ctx, what); },
    warn: (w) => warnings.push(w),
    ...(read ? { read } : {}),
  });
  return { holds, warnings, sessions, log };
};

test("release puts the context's refresh cookie back under the role that holds the context", async () => {
  const { holds, warnings, sessions } = holdsFor();
  const ctx = fakeBrowserContext({ jar: [cookie("rotated-crew-llll")] });
  holds.hold(ctx, "crew");
  holds.hold(ctx, "crew"); // the same role again is the same session
  assert.deepEqual(holds.contexts(), [ctx]);
  await holds.release(ctx);
  assert.deepEqual(warnings, []);
  assert.equal(sessions.take("viewer"), null);
  assert.equal(sessions.take("crew").value, "rotated-crew-llll");
  await holds.release(ctx);
  assert.equal(sessions.take("crew"), null, "released once: a second release has nothing to give back");
  assert.deepEqual(holds.contexts(), []);
  await holds.release(fakeBrowserContext({ jar: [cookie("never-held-mmmm")] }));
  assert.equal(sessions.take("crew"), null, "a context that holds nothing gives nothing back");
});

test("one cookie per context: a second role can't sign in in a context that holds a session", () => {
  const { holds } = holdsFor();
  const ctx = fakeBrowserContext();
  holds.check(ctx, "viewer");
  holds.hold(ctx, "crew");
  assert.throws(() => holds.check(ctx, "viewer"), /holds the crew session already: sign viewer in in a context of their own/);
  assert.throws(() => holds.hold(ctx, "owner"), /holds the crew session already/);
  holds.check(ctx, "crew");
  holds.hold(fakeBrowserContext(), "viewer");
  assert.equal(holds.contexts().length, 2, "each context its own role");
});

test("release with no cookie to save warns; a closed context doesn't", async () => {
  const { holds, warnings, sessions } = holdsFor();
  const signedOut = fakeBrowserContext();
  holds.hold(signedOut, "viewer");
  await holds.release(signedOut);
  assert.deepEqual(warnings, ["viewer: no session to save after the test, so the next test signs in through Managed Login again"]);
  const expiring = fakeBrowserContext({ jar: [cookie("expiring-nnnn", { expires: NOW + 60 })] });
  holds.hold(expiring, "crew");
  await holds.release(expiring);
  assert.equal(warnings.length, 2, "an unusable cookie isn't saved either");
  const closed = fakeBrowserContext();
  closed.cookies = async () => { throw new Error("Target page, context or browser has been closed"); };
  holds.hold(closed, "owner");
  await holds.release(closed);
  assert.equal(warnings.length, 2);
  assert.equal(sessions.take("owner"), null);
});

test("release stops the app before it reads the cookie, so nothing refreshes it once it's pooled", async () => {
  const log = [];
  const { holds, sessions } = holdsFor({ log });
  const ctx = fakeBrowserContext({ pages: 2, log, jar: [cookie("crew-token-oooo")] });
  // The app would refresh (and spend the cookie) if it were still running when it's read
  ctx.cookies = ((cookies) => async (url) => {
    assert.ok(ctx.pages().every((p) => p.url() === "about:blank"), "every page is stopped before the read");
    return cookies(url);
  })(ctx.cookies);
  holds.hold(ctx, "crew");
  await holds.release(ctx);
  assert.deepEqual(log, ["assertNotTracing", "stopApp", "page0 goto about:blank", "page1 goto about:blank", "cookies"]);
  assert.equal(sessions.take("crew").value, "crew-token-oooo");
});

test("release waits for the app's refresh on its way, and pools the cookie that refresh set", async () => {
  const { sessions } = pool();
  const ctx = fakeBrowserContext({ jar: [cookie("before-refresh-pppp")] });
  trackRequests(ctx, PROD.api);
  const refresh = fakeRequest(`${PROD.api}/auth/refresh`);
  ctx.emit("request", refresh);
  const holds = createSessionHolds({
    pool: sessions, apiOrigin: PROD.api, assertNotTracing, warn: assert.fail,
    // The refresh answers while stopApp waits: its Set-Cookie replaces the spent cookie
    stopApp: (c) => stopApp(c, { apiOrigin: PROD.api, settleMs: 0, sleep: async () => { ctx.jar = [cookie("after-refresh-qqqq")]; ctx.emit("requestfinished", refresh); } }),
  });
  holds.hold(ctx, "crew");
  await holds.release(ctx);
  assert.equal(sessions.take("crew").value, "after-refresh-qqqq");
});

test("release never reads the cookie while the context is traced, and reads it once tracing stops", async () => {
  const log = [];
  const { holds, sessions } = holdsFor({ log });
  const ctx = fakeBrowserContext({ log, jar: [cookie("traced-token-rrrr")] });
  holds.hold(ctx, "owner");
  markTracing(ctx);
  await assert.rejects(holds.release(ctx), /Refusing to enter reading the session's refresh cookie while this page is being traced/);
  assert.deepEqual(log, ["assertNotTracing"], "neither stopped nor read");
  assert.equal(sessions.take("owner"), null);
  // The page fixture stops the trace (and unmarks the context) before it releases
  const later = fakeBrowserContext({ log: [], jar: [cookie("untraced-token-ssss")] });
  holds.hold(later, "owner");
  markTracing(later);
  unmarkTracing(later);
  await holds.release(later);
  assert.equal(sessions.take("owner").value, "untraced-token-ssss");
});

test("release doesn't pool the cookie when the app couldn't be stopped", async () => {
  const log = [];
  const { holds, warnings, sessions } = holdsFor({ log, stop: async () => { log.push("stopApp"); throw new Error("navigation failed"); } });
  const ctx = fakeBrowserContext({ log, jar: [cookie("still-running-tttt")] });
  holds.hold(ctx, "crew");
  await holds.release(ctx);
  assert.deepEqual(log, ["assertNotTracing", "stopApp"], "never read");
  assert.match(warnings[0], /^crew: the app couldn't be stopped after the test/);
  assert.equal(sessions.take("crew"), null);
});

test("release doesn't pool the cookie when a refresh was still in flight as the app stopped", async () => {
  const log = [];
  const { holds, warnings, sessions } = holdsFor({ log, stop: async (c) => { log.push("stopApp"); await stopApp(c, { apiOrigin: PROD.api, authWaitMs: 100, settleMs: 0, sleep: async () => {} }); } });
  const ctx = fakeBrowserContext({ log, jar: [cookie("maybe-spent-uuuu")] });
  trackRequests(ctx, PROD.api);
  ctx.emit("request", fakeRequest(`${PROD.api}/auth/refresh`));
  holds.hold(ctx, "viewer");
  await holds.release(ctx);
  assert.deepEqual(log, ["assertNotTracing", "stopApp", "page0 goto about:blank"], "stopped, never read");
  assert.deepEqual(warnings, ["viewer: a refresh was still in flight when the app was stopped, so its session wasn't saved and the next test signs in through Managed Login again"]);
  assert.equal(sessions.take("viewer"), null);
});

test("a refused release is never retried: the context is let go first", async () => {
  const log = [];
  const { holds, sessions } = holdsFor({ log });
  const ctx = fakeBrowserContext({ log, jar: [cookie("traced-token-xxxx")] });
  holds.hold(ctx, "crew");
  markTracing(ctx);
  await assert.rejects(holds.release(ctx), /being traced/);
  unmarkTracing(ctx);
  assert.deepEqual(holds.contexts(), []);
  await holds.release(ctx);
  assert.deepEqual(log, ["assertNotTracing"], "the second release does nothing");
  assert.equal(sessions.take("crew"), null);
});

test("dropSession clears only the API's refresh cookie, on its host and path", async () => {
  const keep = [
    cookie("other-host-yyyy", { domain: "app.example.com" }),
    cookie("other-path-yyyy", { path: "/" }),
    { ...cookie("other-name-yyyy"), name: "theme" },
  ];
  const ctx = fakeBrowserContext({ jar: [cookie("spent-token-yyyy"), ...keep] });
  await dropSession(ctx, PROD.api);
  assert.deepEqual(ctx.jar, keep);
  assert.deepEqual(ctx.log, [`clearCookies ${REFRESH_COOKIE}`]);
});

test("release reads the cookie under its path by default (readSession), never the API's origin alone", async () => {
  const { holds, sessions } = holdsFor();
  const ctx = fakeBrowserContext({ jar: [cookie("path-token-uuuu")] });
  holds.hold(ctx, "viewer");
  await holds.release(ctx);
  assert.equal(sessions.take("viewer").value, "path-token-uuuu");
});

// resumeSession: a page whose app either takes the session up (GET /me) or shows sign-in
const resumePage = (log) => {
  const ctx = fakeBrowserContext({ log });
  trackRequests(ctx, PROD.api);
  return { ctx, page: ctx.pages()[0] };
};
const never = () => new Promise(() => {});

test("a session the app takes up is reused, and the app keeps running", async () => {
  const log = [];
  const { ctx, page } = resumePage(log);
  const reused = await resumeSession(page, cookie("good-token-vvvv"), {
    meResponse: Promise.resolve({ status: () => 200 }),
    signInShown: never,
    stopApp: assert.fail,
    dropSession: assert.fail,
  });
  assert.equal(reused, true);
  assert.deepEqual(log, ["addCookies __Secure-sc_refresh", `page0 goto /`]);
  assert.equal(ctx.jar[0].value, "good-token-vvvv");
});

test("a spent session stops the app before Managed Login, so its cut-off requests aren't page errors", async () => {
  const log = [];
  const { ctx, page } = resumePage(log);
  const list = `${PROD.api}/teams/t1/projects?since=2026-01-01`;
  const cutOff = `/${new URL(PROD.api).host}/teams/t1/projects?since=2026-01-01 due to access control checks.`;
  const errors = [];
  // The app showed sign-in with a list still in flight; navigating away cuts it off
  ctx.onGoto = (url) => {
    if (url === "/") return;
    if (!isAbandonedRequestError(ctx, cutOff)) errors.push(cutOff);
  };
  const reused = await resumeSession(page, cookie("spent-token-wwww"), {
    meResponse: never(),
    signInShown: async () => { log.push("sign-in shown"); ctx.emit("request", fakeRequest(list)); },
    stopApp: async (c) => { log.push("stopApp"); await stopApp(c, { apiOrigin: PROD.api, settleMs: 0, sleep: async () => {} }); },
    dropSession: async (c) => c.clearCookies({ name: REFRESH_COOKIE }),
  });
  assert.equal(reused, false, "the caller goes through Managed Login, from the app's sign-in screen");
  assert.deepEqual(log, [
    "addCookies __Secure-sc_refresh", "page0 goto /", "sign-in shown",
    "stopApp", "page0 goto about:blank", `clearCookies ${REFRESH_COOKIE}`, "page0 goto /",
  ]);
  assert.deepEqual(errors, [], "the deliberate cut-off is allowed");
  assert.deepEqual(ctx.jar, [], "the spent cookie is gone");
  assert.equal(page.url(), "/", "a fresh app, signed out, for Managed Login");
  assert.equal(isAbandonedRequestError(ctx, cutOff), false, "and once it's done, the same error is a failure again");
});

test("a spent session is dropped even when a refresh is still in flight as the app stops; other failures aren't swallowed", async () => {
  const log = [];
  const { ctx, page } = resumePage(log);
  const spent = { meResponse: never(), signInShown: async () => { log.push("sign-in shown"); }, dropSession: (c) => dropSession(c, PROD.api) };
  const reused = await resumeSession(page, cookie("spent-token-zzzz"), { ...spent, stopApp: async () => { log.push("stopApp"); throw new RefreshInFlight(); } });
  assert.equal(reused, false);
  assert.deepEqual(log, ["addCookies __Secure-sc_refresh", "page0 goto /", "sign-in shown", "stopApp", `clearCookies ${REFRESH_COOKIE}`, "page0 goto /"]);
  assert.deepEqual(ctx.jar, []);
  const other = resumePage([]);
  await assert.rejects(resumeSession(other.page, cookie("spent-token-zzzz"), { ...spent, stopApp: async () => { throw new Error("page crashed"); } }), /page crashed/);
});

test("no session means Managed Login straight away: nothing to stop", async () => {
  const log = [];
  const { page } = resumePage(log);
  const reused = await resumeSession(page, null, { meResponse: never(), signInShown: assert.fail, stopApp: assert.fail, dropSession: assert.fail });
  assert.equal(reused, false);
  assert.deepEqual(log, ["page0 goto /"]);
});

test("a /me that fails and a sign-in screen that never shows count as not reused", async () => {
  const { page } = resumePage([]);
  const failed = Promise.reject(new Error("timeout"));
  let stopped = 0;
  const reused = await resumeSession(page, cookie("odd-token-xxxx"), { meResponse: failed, signInShown: never, stopApp: async () => { stopped++; }, dropSession: async () => {} });
  assert.equal(reused, false);
  assert.equal(stopped, 1);
  const shownFails = await resumeSession(page, cookie("odd-token-yyyy"), { meResponse: never(), signInShown: () => Promise.reject(new Error("timeout")), stopApp: async () => { stopped++; }, dropSession: async () => {} });
  assert.equal(shownFails, false);
  assert.equal(stopped, 2);
});
