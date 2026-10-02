// Unit tests for the operator page's sign-in (ops/lib/auth.js). npm run test:ops
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  PENDING_KEY,
  PENDING_TTL_MS,
  SCOPE,
  SignInError,
  authorizeUrl,
  base64url,
  beginSignIn,
  callbackParams,
  exchangeCode,
  jwtClaims,
  logoutUrl,
  pkce,
  randomState,
  safeReturnTo,
  sessionFor,
  takePending,
  withoutCallback,
} from "../lib/auth.js";

const config = { authUrl: "https://ops-auth.example.test", apiUrl: "https://api.example.test", clientId: "opsclient123", redirectUri: "https://ops.example.test/" };
const NOW = Date.parse("2026-10-02T12:00:00Z");
const OPS_ISS = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OpsPool";
const CUSTOMER_ISS = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Customers";

export const jwt = (claims) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const opsToken = (extra = {}) => jwt({ token_use: "access", client_id: config.clientId, iss: OPS_ISS, exp: NOW / 1000 + 900, username: "ops-alice", ...extra });

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data };
}

test("base64url has no padding or +/", () => {
  assert.equal(base64url(new Uint8Array([251, 255, 254])), "-__-");
  assert.equal(base64url(new Uint8Array([1])), "AQ");
});

test("pkce makes an S256 challenge of its verifier", async () => {
  const { verifier, challenge } = await pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{64}$/);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.notEqual(randomState(), randomState());
});

test("the authorize URL is the ops pool's, for the ops client, with PKCE and state", () => {
  const url = new URL(authorizeUrl(config, { state: "st", challenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://ops-auth.example.test/oauth2/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: "code",
    client_id: "opsclient123",
    redirect_uri: "https://ops.example.test/",
    scope: SCOPE,
    state: "st",
    code_challenge: "ch",
    code_challenge_method: "S256",
  });
});

test("logout goes to the ops pool's logout and back to the page", () => {
  const url = new URL(logoutUrl(config));
  assert.equal(url.origin + url.pathname, "https://ops-auth.example.test/logout");
  assert.equal(url.searchParams.get("client_id"), "opsclient123");
  assert.equal(url.searchParams.get("logout_uri"), "https://ops.example.test/");
});

test("only in-page views are kept to come back to", () => {
  assert.equal(safeReturnTo("#/team/t_1"), "#/team/t_1");
  assert.equal(safeReturnTo("#/audit"), "#/audit");
  assert.equal(safeReturnTo("https://evil.test/"), "");
  assert.equal(safeReturnTo("#/team/<img>"), "");
  assert.equal(safeReturnTo(undefined), "");
});

test("beginSignIn keeps only the verifier, state and view, and returns the authorize URL", async () => {
  const storage = memoryStorage();
  const url = new URL(await beginSignIn(config, { storage, now: NOW, returnTo: "#/team/t1" }));
  const pending = JSON.parse(storage.getItem(PENDING_KEY));
  assert.deepEqual(Object.keys(pending).sort(), ["at", "returnTo", "state", "verifier"]);
  assert.equal(url.searchParams.get("state"), pending.state);
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(pending.verifier).digest("base64url"));
  assert.equal(pending.returnTo, "#/team/t1");
  const other = memoryStorage();
  await beginSignIn(config, { storage: other });
  assert.equal(JSON.parse(other.getItem(PENDING_KEY)).returnTo, "");
});

test("callbackParams reads the answer, or null with none", () => {
  assert.equal(callbackParams("https://ops.example.test/#/teams"), null);
  assert.deepEqual(callbackParams("https://ops.example.test/?code=c&state=s"), { code: "c", state: "s", error: null });
  assert.deepEqual(callbackParams("https://ops.example.test/?error=access_denied"), { code: null, state: null, error: "access_denied" });
  assert.deepEqual(callbackParams("https://ops.example.test/?state=s"), { code: null, state: "s", error: null });
  assert.equal(withoutCallback("https://ops.example.test/?code=c&state=s#x"), "https://ops.example.test/");
});

test("takePending checks the state and always forgets the pending sign-in", () => {
  const pending = { state: "s1", verifier: "v1", at: NOW, returnTo: "#/audit" };
  const fresh = () => memoryStorage({ [PENDING_KEY]: JSON.stringify(pending) });
  let storage = fresh();
  assert.deepEqual(takePending(storage, { code: "c", state: "s1" }, NOW + 1000), { code: "c", verifier: "v1", returnTo: "#/audit" });
  assert.equal(storage.getItem(PENDING_KEY), null);

  const refused = (answer, s = fresh(), now = NOW) => {
    assert.throws(() => takePending(s, answer, now), SignInError);
    assert.equal(s.getItem(PENDING_KEY), null);
  };
  refused({ code: "c", state: "other" });
  refused({ code: "c", state: null });
  refused({ code: null, state: "s1" });
  refused({ error: "access_denied", state: "s1" });
  refused({ code: "c", state: "s1" }, fresh(), NOW + PENDING_TTL_MS);
  refused({ code: "c", state: "s1" }, memoryStorage());
  refused({ code: "c", state: "s1" }, memoryStorage({ [PENDING_KEY]: "{not json" }));
  refused({ code: "c", state: "s1" }, memoryStorage({ [PENDING_KEY]: JSON.stringify({ state: "s1" }) }));
  refused({ code: "c", state: "s1" }, memoryStorage({ [PENDING_KEY]: JSON.stringify({ ...pending, at: "x" }) }));
});

test("jwtClaims reads claims, and {} for anything else", () => {
  assert.equal(jwtClaims(opsToken()).client_id, "opsclient123");
  assert.equal(jwtClaims(jwt({ name: "Zoë" })).name, "Zoë");
  assert.deepEqual(jwtClaims("nope"), {});
  assert.deepEqual(jwtClaims(undefined), {});
  assert.deepEqual(jwtClaims(["a", Buffer.from("null").toString("base64url"), "c"].join(".")), {});
});

test("an ops access token makes a session", () => {
  assert.deepEqual(sessionFor(opsToken(), config, NOW), { token: opsToken(), expiresAt: NOW + 900_000, username: "ops-alice" });
  assert.equal(sessionFor(opsToken({ username: 5 }), config, NOW).username, "");
});

test("a customer-pool token is never used: wrong client, and the ID token too", () => {
  // The customer app's access token: the customer pool and the web client
  assert.throws(() => sessionFor(opsToken({ client_id: "webclient999", iss: CUSTOMER_ISS }), config, NOW), /isn't for the operator page/);
  // A customer ID token (aud, not client_id)
  assert.throws(() => sessionFor(jwt({ token_use: "id", aud: "webclient999", iss: CUSTOMER_ISS, exp: NOW / 1000 + 900 }), config, NOW), /isn't an access token/);
  assert.throws(() => sessionFor(opsToken({ iss: "https://evil.test/pool" }), config, NOW), /isn't from the operator sign-in/);
  assert.throws(() => sessionFor(opsToken({ iss: 5 }), config, NOW), SignInError);
  assert.throws(() => sessionFor(opsToken({ exp: NOW / 1000 }), config, NOW), /already ended/);
  assert.throws(() => sessionFor(opsToken({ exp: "soon" }), config, NOW), /already ended/);
  assert.throws(() => sessionFor("garbage", config, NOW), SignInError);
});

test("exchangeCode posts the code and verifier to the ops pool, and keeps only the access token", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ access_token: "AT", id_token: "IT", refresh_token: "RT" }) };
  };
  assert.equal(await exchangeCode(config, { code: "c1", verifier: "v1" }, fetchFn), "AT");
  assert.equal(calls[0].url, "https://ops-auth.example.test/oauth2/token");
  assert.equal(calls[0].init.credentials, "omit");
  assert.deepEqual(Object.fromEntries(calls[0].init.body), { grant_type: "authorization_code", client_id: "opsclient123", code: "c1", redirect_uri: "https://ops.example.test/", code_verifier: "v1" });
});

test("exchangeCode fails with a SignInError", async () => {
  const answer = (ok, status, body) => async () => ({ ok, status, json: async () => (body instanceof Error ? Promise.reject(body) : body) });
  await assert.rejects(exchangeCode(config, { code: "c", verifier: "v" }, answer(false, 400, { error: "invalid_grant" })), /invalid_grant/);
  await assert.rejects(exchangeCode(config, { code: "c", verifier: "v" }, answer(false, 500, new Error("not json"))), /\(500\)/);
  await assert.rejects(exchangeCode(config, { code: "c", verifier: "v" }, answer(true, 200, { token_type: "Bearer" })), /\(200\)/);
  await assert.rejects(exchangeCode(config, { code: "c", verifier: "v" }, answer(true, 200, null)), /\(200\)/);
  await assert.rejects(exchangeCode(config, { code: "c", verifier: "v" }, async () => { throw new TypeError("offline"); }), /Couldn't reach/);
});
