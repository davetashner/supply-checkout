// node --test scripts/journeys/test/ (part of npm run test:scripts): the long-lived accounts'
// saved sessions (lib/sessions.mjs), leased one test at a time and never uploaded.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PROD } from "../lib/config.mjs";
import { createMasker } from "../lib/mask.mjs";
import { SESSIONS_DIR, createSessionPool, sessionCookie } from "../lib/sessions.mjs";
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
