// Unit tests for the operator page's config and API client (ops/lib/config.js, ops/lib/api.js).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, NetworkError, PAGE_SIZE, SEARCH_REQUESTS, createApi, teamPath } from "../lib/api.js";
import { CONFIG_PATH, ConfigError, checkConfig, envDomainOf, loadConfig } from "../lib/config.js";

const location = { protocol: "https:", hostname: "ops.example.test" };
const good = { apiUrl: "https://api.example.test", authUrl: "https://ops-auth.example.test", clientId: "abc123" };

test("the config must point at this environment's api. and ops-auth. hosts", () => {
  assert.deepEqual(checkConfig(good, location), { ...good, redirectUri: "https://ops.example.test/", domain: "example.test" });
  assert.equal(envDomainOf("ops.staging.supplycheckout.com"), "staging.supplycheckout.com");
  assert.throws(() => envDomainOf("app.example.test"), ConfigError);
  assert.throws(() => envDomainOf("ops.localhost"), ConfigError);
  assert.throws(() => checkConfig(good, { ...location, protocol: "http:" }), /https/);
  assert.throws(() => checkConfig({ ...good, apiUrl: "https://evil.test" }, location), /apiUrl/);
  // The customers' sign-in host is refused: only the operator pool's
  assert.throws(() => checkConfig({ ...good, authUrl: "https://auth.example.test" }, location), /authUrl/);
  assert.throws(() => checkConfig({ ...good, clientId: "a b" }, location), /client ID/);
  assert.throws(() => checkConfig({ ...good, clientId: 5 }, location), /client ID/);
  assert.throws(() => checkConfig(null, location), /apiUrl/);
});

test("loadConfig fetches ops-config.json without the cache or cookies", async () => {
  let seen;
  const fetchFn = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => good };
  };
  assert.equal((await loadConfig(fetchFn, location)).clientId, "abc123");
  assert.equal(seen.url, CONFIG_PATH);
  assert.deepEqual(seen.init, { cache: "no-store", credentials: "omit" });
  await assert.rejects(loadConfig(async () => ({ ok: false, status: 404 }), location), /404/);
  await assert.rejects(loadConfig(async () => ({ ok: true, json: async () => Promise.reject(new Error("x")) }), location), ConfigError);
});

function fakeFetch(answers) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, json: async () => (next.body === undefined ? Promise.reject(new Error("no body")) : next.body) };
  };
  return { fetchFn, calls };
}

const apiWith = (answers, { token = "TOKEN", ...rest } = {}) => {
  const fake = fakeFetch(answers);
  let unauthorized = 0;
  const api = createApi({ apiUrl: "https://api.example.test", getToken: () => token, onUnauthorized: () => unauthorized++, fetchFn: fake.fetchFn, ...rest });
  return { api, calls: fake.calls, unauthorized: () => unauthorized };
};

test("listTeams sends the bearer token only in the header, with no cookies", async () => {
  const { api, calls } = apiWith([{ status: 200, body: { teams: [{ id: "t1" }], cursor: "c2" } }]);
  assert.deepEqual(await api.listTeams(), { teams: [{ id: "t1" }], cursor: "c2" });
  assert.equal(calls[0].url.toString(), `https://api.example.test/ops/teams?limit=${PAGE_SIZE}`);
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(calls[0].init.headers, { authorization: "Bearer TOKEN" });
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.body, undefined);
});

test("a search follows empty pages for a while, as the CLI does", async () => {
  const empty = { status: 200, body: { teams: [], cursor: "next" } };
  const { api, calls } = apiWith([empty, empty, { status: 200, body: { teams: [{ id: "t9" }] } }]);
  assert.deepEqual(await api.listTeams({ q: "acme" }), { teams: [{ id: "t9" }], cursor: undefined });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url.searchParams.get("cursor"), "next");
  assert.equal(calls[2].url.searchParams.get("q"), "acme");

  const many = apiWith(Array.from({ length: 30 }, () => empty));
  assert.deepEqual(await many.api.listTeams({ q: "x", cursor: "c0" }), { teams: [], cursor: "next" });
  assert.equal(many.calls.length, SEARCH_REQUESTS);
  assert.equal(many.calls[0].url.searchParams.get("cursor"), "c0");

  const odd = apiWith([{ status: 200, body: { teams: "no", cursor: 5 } }]);
  assert.deepEqual(await odd.api.listTeams(), { teams: [], cursor: undefined });
});

test("getTeam and the audit read the ops routes; IDs are checked first", async () => {
  const { api, calls } = apiWith([{ status: 200, body: { team: { id: "t1" } } }, { status: 200, body: { events: [{ action: "ops.comp.set" }], cursor: "a2" } }, { status: 200, body: {} }]);
  assert.deepEqual(await api.getTeam("t1"), { team: { id: "t1" } });
  assert.equal(calls[0].url.pathname, "/ops/teams/t1");
  assert.deepEqual(await api.audit({ teamId: "t1", cursor: "a1" }), { events: [{ action: "ops.comp.set" }], cursor: "a2" });
  assert.equal(calls[1].url.search, "?teamId=t1&cursor=a1");
  assert.deepEqual(await api.audit({ month: "2026-10" }), { events: [], cursor: undefined });
  assert.equal(calls[2].url.search, "?month=2026-10");
  assert.throws(() => teamPath("../admin"), ApiError);
  await assert.rejects(api.audit({ teamId: "a/b" }), ApiError);
  await assert.rejects(api.getTeam("x?y"), ApiError);
  assert.equal(calls.length, 3);
  assert.deepEqual(await apiWith([{ status: 200, body: {} }]).api.audit(), { events: [], cursor: undefined });
});

test("comp writes send the body, JSON, and the Idempotency-Key", async () => {
  const { api, calls } = apiWith([{ status: 200, body: { eventId: "e1" } }, { status: 200, body: { eventId: "e2" } }]);
  await api.setComp("t1", { plan: "pro", months: 2, reason: "Pilot", expectedVersion: 7 }, "key-1");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].url.pathname, "/ops/teams/t1/comp");
  assert.deepEqual(calls[0].init.headers, { authorization: "Bearer TOKEN", "content-type": "application/json", "idempotency-key": "key-1" });
  assert.deepEqual(JSON.parse(calls[0].init.body), { plan: "pro", months: 2, reason: "Pilot", expectedVersion: 7 });
  await api.endComp("t1", { reason: "Over", expectedVersion: 8 }, "key-2");
  assert.equal(calls[1].init.method, "DELETE");
  assert.equal(calls[1].init.headers["idempotency-key"], "key-2");
});

test("errors: the API's message, 401 signs out, no answer is a NetworkError", async () => {
  const conflict = apiWith([{ status: 409, body: { error: { code: "aborted", message: "The team changed since you read it; read it again and retry" } } }]);
  const error = await conflict.api.setComp("t1", {}, "k").catch((e) => e);
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 409);
  assert.equal(error.code, "aborted");
  assert.match(error.message, /read it again/);
  assert.equal(conflict.unauthorized(), 0);

  const closed = await apiWith([{ status: 409, body: { error: { code: "aborted", message: "m", reason: "team_deleting" } } }]).api.getTeam("t").catch((e) => e);
  assert.equal(closed.reason, "team_deleting");

  const expired = apiWith([{ status: 401, body: { message: "Unauthorized" } }]);
  const e401 = await expired.api.getTeam("t1").catch((e) => e);
  assert.equal(e401.status, 401);
  assert.equal(e401.message, "The API answered 401");
  assert.equal(expired.unauthorized(), 1);

  const notJson = await apiWith([{ status: 502 }]).api.getTeam("t1").catch((e) => e);
  assert.equal(notJson.message, "The API answered 502");
  assert.equal(notJson.code, "");

  const offline = await apiWith([new TypeError("Failed to fetch")]).api.getTeam("t1").catch((e) => e);
  assert.ok(offline instanceof NetworkError);
});

test("no token: nothing is sent, and the page signs in again", async () => {
  const none = apiWith([], { token: null });
  const error = await none.api.getTeam("t1").catch((e) => e);
  assert.equal(error.status, 401);
  assert.equal(none.calls.length, 0);
  assert.equal(none.unauthorized(), 1);
});

test("the default 401 handler and a null error body", async () => {
  const api = createApi({ apiUrl: "https://api.example.test", getToken: () => "T", fetchFn: fakeFetch([{ status: 401, body: null }]).fetchFn });
  const error = await api.getTeam("t1").catch((e) => e);
  assert.equal(error.message, "The API answered 401");
});

test("a request that takes too long is aborted", async () => {
  const fetchFn = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const api = createApi({ apiUrl: "https://api.example.test", getToken: () => "T", fetchFn, timeoutMs: 5 });
  await assert.rejects(api.getTeam("t1"), NetworkError);
});
