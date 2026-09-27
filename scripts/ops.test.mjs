// node --test scripts/ops.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CALLBACK_URL, endpoints, jwtClaims, main, parseArgs, pkce, readCachedToken, signIn, UsageError, waitForCode, writeCachedToken } from "./ops.mjs";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const ISS = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_ops";
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const TOKEN = jwt({ exp: NOW / 1000 + 900, iss: ISS, sub: "op-1" });
const TEAM = { id: "team-a", name: "Acme", plan: "trial", status: "trialing", seats: 1, ownerCount: 1, closedAt: null, createdAt: "2026-09-01T00:00:00.000Z", version: 4, comp: null, owners: [{ userId: "u1", email: "owner@example.com" }] };

/** Fakes for everything main() touches, with an API that answers from `routes`. */
function harness({ cached = TOKEN, routes = {}, env = {} } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "ops-cli-"));
  if (cached) {
    mkdirSync(path.join(home, ".config", "supply-checkout"), { recursive: true });
    writeFileSync(path.join(home, ".config", "supply-checkout", "ops-prod.json"), JSON.stringify({ accessToken: cached }));
  }
  const requests = [];
  const logs = [];
  const runs = [];
  const deps = {
    env,
    home,
    now: () => NOW,
    log: (m) => logs.push(m),
    run: (cmd, args) => {
      runs.push([cmd, ...args]);
      return "clientfromssm\n";
    },
    signIn: async (e, clientId) => {
      requests.push({ signIn: [e, clientId] });
      return TOKEN;
    },
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const request = { method: init.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined, origin: u.origin };
      requests.push(request);
      const answer = routes[`${request.method} ${request.path}`] ?? { status: 404, body: { error: { message: "No such route" } } };
      const { status, body } = typeof answer === "function" ? answer(request) : answer;
      return new Response(JSON.stringify(body), { status });
    },
  };
  return { deps, requests, logs, runs, home };
}

test("parses commands, positionals and flags, and refuses unknown or empty ones", () => {
  assert.deepEqual(parseArgs(["comp", "team-a", "--plan", "free", "--until=2026-12-31", "--json"]), {
    command: "comp",
    args: ["team-a"],
    flags: { plan: "free", until: "2026-12-31", json: true },
  });
  assert.throws(() => parseArgs(["teams", "--nope"]), UsageError);
  assert.throws(() => parseArgs(["comp", "t", "--reason"]), UsageError);
  assert.throws(() => parseArgs(["comp", "t", "--reason", "--json"]), UsageError);
});

test("points at the environment's API and operator sign-in host", () => {
  assert.deepEqual(endpoints("prod"), { api: "https://api.supplycheckout.com", auth: "https://ops-auth.supplycheckout.com" });
  assert.deepEqual(endpoints("staging"), { api: "https://api.staging.supplycheckout.com", auth: "https://ops-auth.staging.supplycheckout.com" });
  assert.throws(() => endpoints("../x"), UsageError);
});

test("makes an S256 PKCE pair, and reads a JWT's claims without trusting them", () => {
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.notEqual(verifier, challenge);
  assert.deepEqual(jwtClaims(TOKEN).sub, "op-1");
  assert.deepEqual(jwtClaims("garbage"), {});
});

test("never reads or writes the token through a symlink, and keeps the folder owner-only", async () => {
  const { symlinkSync, statSync: stat, existsSync } = await import("node:fs");
  const home = mkdtempSync(path.join(tmpdir(), "ops-link-"));
  const target = path.join(home, "elsewhere.json");
  writeFileSync(target, JSON.stringify({ accessToken: TOKEN }));
  const dir = path.join(home, "cfg");
  mkdirSync(dir, { mode: 0o755 });
  symlinkSync(target, path.join(dir, "ops-prod.json"));
  assert.equal(readCachedToken(path.join(dir, "ops-prod.json"), NOW), undefined);
  assert.throws(() => writeCachedToken(path.join(dir, "ops-prod.json"), TOKEN), /ELOOP|symbolic/i);
  assert.equal(stat(dir).mode & 0o777, 0o700);
  assert.equal(existsSync(target), true);
});

test("warns when it can't also listen on ::1", async () => {
  const { createServer } = await import("node:http");
  const port = 18766;
  const blocker = createServer();
  const listening = await new Promise((resolve) => {
    blocker.once("error", () => resolve(false));
    blocker.listen(port, "::1", () => resolve(true));
  });
  const warnings = [];
  const waiting = waitForCode("s", { port, timeoutMs: 2000, warn: (m) => warnings.push(m) });
  await new Promise((r) => setTimeout(r, 50));
  await fetch(`http://127.0.0.1:${port}/?code=c&state=s`);
  assert.equal(await waiting, "c");
  blocker.close();
  // Where the machine has IPv6, the blocked ::1 was reported
  if (listening) assert.match(warnings[0], /Couldn't listen on \[::1\]/);
});

test("caches only the access token, owner-only, and ignores it within a minute of expiry", () => {
  const home = mkdtempSync(path.join(tmpdir(), "ops-cache-"));
  const file = path.join(home, "sub", "ops-prod.json");
  writeFileSync(path.join(home, "loose.json"), "{}", { mode: 0o644 });
  writeCachedToken(path.join(home, "loose.json"), TOKEN);
  writeCachedToken(file, TOKEN);
  for (const f of [file, path.join(home, "loose.json")]) {
    const fd = openSync(f, "r");
    try {
      assert.equal(fstatSync(fd).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(fd, "utf8")), { accessToken: TOKEN });
    } finally {
      closeSync(fd);
    }
  }
  assert.equal(readCachedToken(file, NOW), TOKEN);
  assert.equal(readCachedToken(file, NOW + 841_000), undefined);
  assert.equal(readCachedToken(path.join(home, "missing.json"), NOW), undefined);
});

test("lists teams with the cached token", async () => {
  const { deps, requests, logs } = harness({ routes: { "GET /ops/teams": { status: 200, body: { teams: [TEAM], cursor: "team-a" } } } });
  assert.equal(await main(["teams", "--q", "acme"], deps), 0);
  assert.deepEqual(requests[0], { method: "GET", path: "/ops/teams", query: { q: "acme" }, headers: { authorization: `Bearer ${TOKEN}` }, body: undefined, origin: "https://api.supplycheckout.com" });
  assert.match(logs[0], /team-a\s+Acme\s+trial\/trialing\s+created 2026-09-01\s+owners: owner@example.com/);
  assert.match(logs[0], /More: --cursor team-a/);
});

test("signs in when there's no live token, with the client ID from SSM, and caches the new token", async () => {
  const { deps, requests, runs, home } = harness({ cached: jwt({ exp: NOW / 1000 - 1 }), routes: { "GET /ops/teams": { status: 200, body: { teams: [] } } } });
  await main(["teams", "--profile", "ops-admin"], deps);
  assert.deepEqual(requests[0], { signIn: ["prod", "clientfromssm"] });
  assert.deepEqual(runs[0], ["aws", "ssm", "get-parameter", "--profile", "ops-admin", "--name", "/supply-checkout/prod/identity/ops-client-id", "--query", "Parameter.Value", "--output", "text"]);
  assert.equal(readCachedToken(path.join(home, ".config", "supply-checkout", "ops-prod.json"), NOW), TOKEN);
});

test("takes the client ID from the flag or the environment without calling AWS", async () => {
  for (const [argv, env] of [[["teams", "--client-id", "flagclient"], {}], [["teams"], { SUPPLY_OPS_CLIENT_ID: "flagclient" }]]) {
    const { deps, requests, runs } = harness({ cached: null, env, routes: { "GET /ops/teams": { status: 200, body: { teams: [] } } } });
    await main(argv, deps);
    assert.deepEqual(requests[0], { signIn: ["prod", "flagclient"] });
    assert.deepEqual(runs, []);
  }
});

test("comps a team: reads it for its version, then PUTs with a new Idempotency-Key", async () => {
  const { deps, requests, logs } = harness({
    routes: {
      "GET /ops/teams/team-a": { status: 200, body: { team: TEAM } },
      "PUT /ops/teams/team-a/comp": { status: 200, body: { eventId: "ev-1", replayed: false, comp: { plan: "free", until: "2026-12-31T00:00:00.000Z" }, version: 5 } },
    },
  });
  await main(["comp", "team-a", "--plan", "free", "--until", "2026-12-31", "--reason", "Pilot, 90 days", "--seats", "5"], deps);
  const put = requests[1];
  assert.equal(put.method, "PUT");
  assert.deepEqual(put.body, { plan: "free", until: "2026-12-31", reason: "Pilot, 90 days", seats: 5, expectedVersion: 4 });
  assert.match(put.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.match(logs[0], /Comped Acme \(team-a\): free until 2026-12-31T00:00:00.000Z. Audit event ev-1./);
});

test("ends a comp", async () => {
  const { deps, requests, logs } = harness({
    routes: {
      "GET /ops/teams/team-a": { status: 200, body: { team: { ...TEAM, comp: { plan: "free", until: "2026-12-31T00:00:00.000Z", live: true, reason: "Pilot" } } } },
      "DELETE /ops/teams/team-a/comp": { status: 200, body: { eventId: "ev-2", replayed: false, comp: null, version: 6 } },
    },
  });
  await main(["uncomp", "team-a", "--reason", "Pilot over"], deps);
  assert.deepEqual(requests[1].body, { reason: "Pilot over", expectedVersion: 4 });
  assert.match(logs[0], /Ended the comp of Acme/);
});

test("shows one team, and the audit, and prints JSON when asked", async () => {
  const routes = {
    "GET /ops/teams/team-a": { status: 200, body: { team: { ...TEAM, comp: { plan: "free", seats: 3, until: "2026-12-31T00:00:00.000Z", live: true, reason: "Pilot" } } } },
    "GET /ops/audit": (r) => ({ status: 200, body: { events: [{ ts: "2026-09-26T12:00:00.000Z", action: "ops.comp.set", teamId: "team-a", operatorSub: "op-1", reason: "Pilot", after: { plan: "free", until: "2026-12-31T00:00:00.000Z" }, query: r.query }] } }),
  };
  const one = harness({ routes });
  await main(["team", "team-a"], one.deps);
  assert.match(one.logs[0], /comp free \(3 seats\) until 2026-12-31T00:00:00.000Z: Pilot/);
  assert.match(one.logs[0], /owner owner@example.com \(u1\)/);
  const closed = harness({ routes: { "GET /ops/teams/team-a": { status: 200, body: { team: { ...TEAM, closedAt: "2026-09-20T00:00:00.000Z" } } }, "GET /ops/teams": { status: 200, body: { teams: [{ ...TEAM, closedAt: "2026-09-20T00:00:00.000Z" }] } } } });
  await main(["team", "team-a"], closed.deps);
  assert.match(closed.logs[0], /CLOSED 2026-09-20T00:00:00.000Z/);
  await main(["teams"], closed.deps);
  assert.match(closed.logs[1], /closed 2026-09-20/);
  const audit = harness({ routes });
  await main(["audit", "--team", "team-a"], audit.deps);
  assert.deepEqual(audit.requests[0].query, { teamId: "team-a" });
  assert.match(audit.logs[0], /ops.comp.set\s+team team-a\s+by op-1 -> free until 2026-12-31\s+"Pilot"/);
  const json = harness({ routes });
  await main(["team", "team-a", "--json"], json.deps);
  assert.equal(JSON.parse(json.logs[0]).team.id, "team-a");
});

test("refuses bad usage before calling anything", async () => {
  for (const argv of [["frobnicate"], ["team"], ["team", "bad id"], ["comp", "team-a", "--plan", "free", "--until", "2026-12-31"], ["comp", "team-a", "--reason", "x"], ["comp", "team-a", "--plan", "free", "--until", "2026-12-31", "--reason", "x", "--seats", "two"], ["audit", "--team", "t", "--month", "2026-09"]]) {
    const { deps, requests } = harness();
    await assert.rejects(main(argv, deps), UsageError, argv.join(" "));
    assert.deepEqual(requests.filter((r) => r.method !== "GET" || r.path !== "/ops/teams/team-a"), [], argv.join(" "));
  }
});

test("reports the API's error, and forgets a token the API refused", async () => {
  const { deps, home } = harness({ routes: { "GET /ops/teams": { status: 401, body: { error: { message: "Sign in again" } } } } });
  await assert.rejects(main(["teams"], deps), /Sign in again/);
  assert.equal(readCachedToken(path.join(home, ".config", "supply-checkout", "ops-prod.json"), NOW), undefined);
});

test("sign-out revokes every token with GlobalSignOut at the token's pool, forgets it, and logs out of the sign-in page", async () => {
  const { deps, requests, logs, home } = harness({ routes: { "POST /": { status: 200, body: {} } }, env: { SUPPLY_OPS_CLIENT_ID: "client-1" } });
  const opened = [];
  deps.openBrowser = (url) => opened.push(new URL(url));
  await main(["sign-out"], deps);
  assert.equal(opened[0].origin + opened[0].pathname, "https://ops-auth.supplycheckout.com/logout");
  assert.deepEqual(Object.fromEntries(opened[0].searchParams), { client_id: "client-1", logout_uri: CALLBACK_URL });
  assert.equal(requests[0].origin, "https://cognito-idp.test-local-1.amazonaws.com");
  assert.equal(requests[0].headers["x-amz-target"], "AWSCognitoIdentityProviderService.GlobalSignOut");
  assert.deepEqual(requests[0].body, { AccessToken: TOKEN });
  assert.match(logs[0], /^Signed out everywhere/);
  assert.equal(readCachedToken(path.join(home, ".config", "supply-checkout", "ops-prod.json"), NOW), undefined);
  const none = harness({ cached: null });
  none.deps.run = () => {
    throw new Error("no SSO session");
  };
  none.deps.openBrowser = () => assert.fail("no client ID, so no logout page");
  await main(["sign-out"], none.deps);
  assert.deepEqual(none.requests, []);
  assert.match(none.logs[0], /nothing was revoked.*admin-user-global-sign-out/);
  assert.match(none.logs[1], /Couldn't open the sign-in page's logout \(no SSO session\)/);
});

test("prints usage for help or no command", async () => {
  const { deps, logs } = harness();
  assert.equal(await main([], deps), 0);
  assert.match(logs[0], /^Usage: npm run ops/);
});

test("signs in with the authorization code and PKCE, redirecting to localhost, and exchanges the code", async () => {
  let authorizeUrl;
  let expectedState;
  const token = [];
  const deps = {
    waitForCode: (state) => {
      expectedState = state;
      return Promise.resolve("the-code");
    },
    openBrowser: (url) => {
      authorizeUrl = new URL(url);
    },
    fetch: async (url, init) => {
      token.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(init.body)) });
      return new Response(JSON.stringify({ access_token: TOKEN, refresh_token: "r", id_token: "i" }), { status: 200 });
    },
    log: () => {},
  };
  assert.equal(await signIn("prod", "client-1", deps), TOKEN);
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, "https://ops-auth.supplycheckout.com/oauth2/authorize");
  const q = Object.fromEntries(authorizeUrl.searchParams);
  assert.deepEqual({ ...q, state: undefined, code_challenge: undefined }, {
    response_type: "code",
    client_id: "client-1",
    redirect_uri: CALLBACK_URL,
    scope: "openid aws.cognito.signin.user.admin",
    state: undefined,
    code_challenge: undefined,
    code_challenge_method: "S256",
  });
  assert.equal(q.state, expectedState);
  assert.equal(token[0].url, "https://ops-auth.supplycheckout.com/oauth2/token");
  assert.deepEqual({ ...token[0].body, code_verifier: undefined }, { grant_type: "authorization_code", client_id: "client-1", code: "the-code", redirect_uri: CALLBACK_URL, code_verifier: undefined });
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(token[0].body.code_verifier).digest("base64url"), q.code_challenge);

  const failing = { ...deps, fetch: async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }) };
  await assert.rejects(signIn("prod", "client-1", failing), /invalid_grant/);
});

test("takes the redirect's code only with the matching state, on a local port", async () => {
  const port = 18765;
  const good = waitForCode("s1", { port, timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 50));
  const ok = await fetch(`http://127.0.0.1:${port}/?code=c1&state=s1`);
  assert.equal(ok.status, 200);
  assert.equal(await good, "c1");

  const bad = assert.rejects(waitForCode("s2", { port, timeoutMs: 5000 }), /didn't match/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/?code=c2&state=other`)).status, 400);
  await bad;

  const denied = assert.rejects(waitForCode("s3", { port, timeoutMs: 5000 }), /access_denied/);
  await new Promise((r) => setTimeout(r, 50));
  await fetch(`http://127.0.0.1:${port}/?error=access_denied&state=s3`);
  await denied;

  await assert.rejects(waitForCode("s4", { port, timeoutMs: 20 }), /timed out/);
});

test("lists stuck imports and clears one with a new Idempotency-Key", async () => {
  const routes = {
    "GET /ops/imports": { status: 200, body: { imports: [{ teamId: "team-a", importId: "imp-1", startedAt: "2026-09-26T09:00:00.000Z", committed: 49, total: 200 }], stuckAfterMinutes: 60 } },
    "POST /ops/teams/team-a/imports/imp-1/clear": { status: 200, body: { eventId: "ev-3", replayed: false } },
  };
  const list = harness({ routes });
  await main(["stuck-imports"], list.deps);
  assert.equal(list.logs[0], "team team-a  import imp-1  started 2026-09-26T09:00:00.000Z  49 of 200 rows");
  const none = harness({ routes: { "GET /ops/imports": { status: 200, body: { imports: [], stuckAfterMinutes: 60 } } } });
  await main(["stuck-imports"], none.deps);
  assert.equal(none.logs[0], "No imports stuck for more than 60 minutes.");
  const clear = harness({ routes });
  await main(["clear-import", "team-a", "imp-1", "--reason", "Owner re-imported it"], clear.deps);
  assert.equal(clear.requests[0].method, "POST");
  assert.deepEqual(clear.requests[0].body, { reason: "Owner re-imported it" });
  assert.match(clear.requests[0].headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.match(clear.logs[0], /Took import imp-1 of team team-a out of the stuck-import check. Audit event ev-3./);
  for (const argv of [["clear-import", "team-a", "--reason", "x"], ["clear-import", "team-a", "bad id", "--reason", "x"], ["clear-import", "team-a", "imp-1"]]) {
    await assert.rejects(main(argv, harness().deps), UsageError, argv.join(" "));
  }
  const audit = harness({ routes: { "GET /ops/audit": { status: 200, body: { events: [{ ts: "t", action: "ops.import.clear", teamId: "team-a", operatorSub: "op-1", after: { importId: "imp-1", committing: false } }] } } } });
  await main(["audit"], audit.deps);
  assert.match(audit.logs[0], /ops.import.clear team team-a {2}by op-1 import imp-1/);
});
