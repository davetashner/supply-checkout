// node --test scripts/ops.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CALLBACK_URL, endpoints, sortTeams, TEAM_HEADER, jwtClaims, main, monthsLeft, parseArgs, pkce, readCachedToken, signIn, UsageError, waitForCode, writeCachedToken } from "./ops.mjs";

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
      const route = routes[`${request.method} ${request.path}`];
      const answer = (typeof route === "function" ? route(request) : route) ?? { status: 404, body: { error: { message: "No such route" } } };
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

test("sorts a page of teams by status, closed last, oldest first, then name and ID, under a header row", async () => {
  const t = (id, status, createdAt, extra = {}) => ({ ...TEAM, id, name: `Team ${id}`, status, createdAt, ...extra });
  const teams = [
    t("closed-active", "active", "2026-01-01T00:00:00.000Z", { closedAt: "2026-09-01T00:00:00.000Z" }),
    t("closed-canceled", "canceled", "2025-01-01T00:00:00.000Z", { closedAt: "2026-09-01T00:00:00.000Z" }),
    t("weird", "zzz", "2020-01-01T00:00:00.000Z"),
    t("canceled", "canceled", "2020-01-01T00:00:00.000Z"),
    t("incomplete", "incomplete", "2020-01-01T00:00:00.000Z"),
    t("unpaid", "unpaid", "2020-01-01T00:00:00.000Z"),
    t("past-due", "past_due", "2020-01-01T00:00:00.000Z"),
    t("trial-new", "trialing", "2026-09-02T00:00:00.000Z"),
    t("trial-old", "trialing", "2026-01-01T00:00:00.000Z"),
    t("active-b2", "active", "2026-03-01T00:00:00.000Z", { name: "Same" }),
    t("active-b1", "active", "2026-03-01T00:00:00.000Z", { name: "Same" }),
    t("active-a", "active", "2026-03-01T00:00:00.000Z", { name: "Alpha" }),
    t("active-old", "active", "2025-06-01T00:00:00.000Z"),
  ];
  const order = ["active-old", "active-a", "active-b1", "active-b2", "trial-old", "trial-new", "past-due", "unpaid", "incomplete", "canceled", "weird", "closed-active", "closed-canceled"];
  assert.deepEqual(sortTeams(teams).map((x) => x.id), order);
  assert.equal(teams[0].id, "closed-active", "the page itself isn't reordered");
  // Missing fields sort as empty, not as errors
  assert.deepEqual(sortTeams([{ id: "b", status: "active" }, { id: "a" }]).map((x) => x.id), ["b", "a"]);
  const { deps, logs } = harness({ routes: { "GET /ops/teams": { status: 200, body: { teams } } } });
  await main(["teams"], deps);
  const lines = logs[0].split("\n");
  assert.equal(lines[0], TEAM_HEADER);
  assert.match(lines[0], /^TEAM ID\s+NAME\s+PLAN\/STATUS\s+CREATED, CLOSED, COMP, OWNERS$/);
  assert.deepEqual(lines.slice(1).map((l) => l.split(" ")[0]), order);
  // The header's columns line up with the rows'
  for (const col of ["NAME", "PLAN/STATUS", "CREATED"]) {
    const at = lines[0].indexOf(col);
    assert.equal(lines[1][at - 1], " ");
    assert.notEqual(lines[1][at], " ");
  }
  assert.equal(lines[0].indexOf("CREATED"), lines[1].indexOf("created"));
  // --json keeps the API's order, with no header
  const json = harness({ routes: { "GET /ops/teams": { status: 200, body: { teams } } } });
  await main(["teams", "--json"], json.deps);
  assert.deepEqual(JSON.parse(json.logs[0]).teams.map((x) => x.id), teams.map((x) => x.id));
  // No teams: no header
  const none = harness({ routes: { "GET /ops/teams": { status: 200, body: { teams: [] } } } });
  await main(["teams"], none.deps);
  assert.equal(none.logs[0], "No teams.");
});

test("follows a search's empty pages until it finds teams or runs out, at most 20 requests (supply-checkout-6uw.8)", async () => {
  const pages = { "": { teams: [], cursor: "c1" }, c1: { teams: [], cursor: "c2" }, c2: { teams: [TEAM], cursor: "c3" } };
  const { deps, requests, logs } = harness({ routes: { "GET /ops/teams": (r) => ({ status: 200, body: pages[r.query.cursor ?? ""] }) } });
  assert.equal(await main(["teams", "--q", "acme"], deps), 0);
  assert.deepEqual(requests.map((r) => r.query), [{ q: "acme" }, { q: "acme", cursor: "c1" }, { q: "acme", cursor: "c2" }]);
  assert.match(logs[0], /team-a\s+Acme/);
  assert.match(logs[0], /More: --cursor c3/);
  // Never searched all the way: says where to go on
  const endless = harness({ routes: { "GET /ops/teams": (r) => ({ status: 200, body: { teams: [], cursor: `${r.query.cursor ?? ""}x` } }) } });
  await main(["teams", "--q", "nobody"], endless.deps);
  assert.equal(endless.requests.length, 20);
  assert.match(endless.logs[0], /No teams yet[^\n]*\nMore: --cursor x{20}/);
  // Without a search, one page as asked
  const plain = harness({ routes: { "GET /ops/teams": { status: 200, body: { teams: [], cursor: "c1" } } } });
  await main(["teams"], plain.deps);
  assert.equal(plain.requests.length, 1);
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

test("comps a team for months: the team's own plan unless given, and says what happens in Stripe (supply-checkout-6e4b)", async () => {
  const outcome = (stripeDiscount) => ({ status: 200, body: { eventId: "ev-3", replayed: false, comp: { plan: "starter", until: "2026-11-26T12:00:00.000Z" }, months: 2, version: 5, stripeDiscount } });
  const run = async (argv, stripeDiscount) => {
    const h = harness({ routes: { "GET /ops/teams/team-a": { status: 200, body: { team: { ...TEAM, plan: "starter" } } }, "PUT /ops/teams/team-a/comp": outcome(stripeDiscount) } });
    await main(argv, h.deps);
    return h;
  };
  const queued = await run(["comp", "team-a", "--months", "2", "--reason", "Two months on us"], "queued");
  assert.deepEqual(queued.requests[1].body, { plan: "starter", months: 2, reason: "Two months on us", expectedVersion: 4 });
  assert.match(queued.requests[1].headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.match(queued.logs[0], /Comped Acme \(team-a\): starter until 2026-11-26T12:00:00.000Z \(2 months\)/);
  assert.match(queued.logs[0], /billing worker is making the subscription's discount match/);
  const given = await run(["comp", "team-a", "--months=1", "--plan", "free", "--seats", "3", "--reason", "Pilot"], "no_stripe_customer");
  assert.deepEqual(given.requests[1].body, { plan: "free", months: 1, reason: "Pilot", seats: 3, expectedVersion: 4 });
  assert.match(given.logs[0], /no customer, so nothing to discount/);
  assert.match((await run(["comp", "team-a", "--months", "2", "--reason", "x y z"], "not_queued")).logs[0], /nightly reconciliation/);
  // An older API that doesn't say
  assert.doesNotMatch((await run(["comp", "team-a", "--months", "2", "--reason", "x y z"], undefined)).logs[0], /Stripe/);
  for (const argv of [["--months", "0"], ["--months", "13"], ["--months", "1.5"], ["--months", "two"], ["--months", "2", "--until", "2026-12-31"]]) {
    const { deps, requests } = harness();
    await assert.rejects(main(["comp", "team-a", ...argv, "--reason", "Pilot"], deps), UsageError, argv.join(" "));
    assert.deepEqual(requests, [], argv.join(" "));
  }
});

test("shows a comp's months left, its Stripe discount, and the worker's audit (supply-checkout-6e4b)", async () => {
  const comp = (until) => ({ plan: "starter", until, live: true, reason: "Two months on us" });
  const sub = { id: "sub_1", status: "active", lookupKey: "supply_checkout_starter_monthly", plan: "starter", interval: "month", seats: 3, currentPeriodEnd: null, cancelAtPeriodEnd: false, cancelAt: null, trialEnd: null, createdAt: null };
  const show = async (team, subscription) => {
    const h = harness({ routes: { "GET /ops/teams/team-a": { status: 200, body: { team: { ...TEAM, stripeCustomerId: "cus_A1", ...team }, stripe: { customerId: "cus_A1", subscription, subscriptionCount: 1, invoices: [], hasMoreInvoices: false } } } } });
    await main(["team", "team-a"], h.deps);
    return h.logs[0];
  };
  const discounted = await show({ comp: comp(new Date(NOW + 61 * 86400_000).toISOString()) }, { ...sub, discountCount: 1, compDiscountUntil: new Date(NOW + 61 * 86400_000).toISOString() });
  assert.match(discounted, /: Two months on us/);
  assert.match(discounted, /, 2 months left: /);
  assert.match(discounted, /comp discount: invoices \$0 until about \d{4}-\d{2}-\d{2}, then billing resumes/);
  assert.match(await show({ comp: comp(new Date(NOW + 40 * 86400_000).toISOString()) }, { ...sub, discountCount: 2, compDiscountUntil: null }), /1 month left[\s\S]*2 discounts on the subscription \(not a comp's\)/);
  assert.match(await show({ comp: comp(new Date(NOW + 5 * 86400_000).toISOString()) }, { ...sub, discountCount: 1 }), /less than a month left[\s\S]*1 discount on the subscription/);
  assert.doesNotMatch(await show({}, sub), /discount/);
  assert.equal(monthsLeft("soon", NOW), "");
  const audit = harness({
    routes: {
      "GET /ops/audit": {
        status: 200,
        body: {
          events: [
            { ts: "2026-09-26T12:00:01.000Z", action: "ops.comp.discount", teamId: "team-a", operatorSub: "system-billing-worker", after: { outcome: "applied", coupon: "supply-checkout-comp-2m", until: "2026-11-26T12:00:00.000Z", subscriptionId: "sub_1" } },
            { ts: "2026-09-26T12:00:02.000Z", action: "ops.comp.discount", teamId: "team-a", operatorSub: "system-billing-worker", after: { outcome: "no_subscription", coupon: null, until: null, subscriptionId: null } },
            { ts: "2026-09-26T12:00:00.000Z", action: "ops.comp.set", teamId: "team-a", operatorSub: "op-1", reason: "Two months on us", after: { plan: "starter", until: "2026-11-26T12:00:00.000Z", months: 2 } },
          ],
        },
      },
    },
  });
  await main(["audit", "--team", "team-a"], audit.deps);
  assert.match(audit.logs[0], /ops.comp.discount team team-a {2}by system-billing-worker Stripe discount: applied \(supply-checkout-comp-2m until 2026-11-26\)/);
  assert.match(audit.logs[0], /Stripe discount: no_subscription$/m);
  assert.match(audit.logs[0], /-> starter until 2026-11-26 \(2 months\)/);
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
  assert.match(one.logs[0], /comp free \(3 seats\) until 2026-12-31T00:00:00.000Z, 3 months left: Pilot/);
  assert.match(one.logs[0], /owner owner@example.com \(u1\)/);
  const closed = harness({ routes: { "GET /ops/teams/team-a": { status: 200, body: { team: { ...TEAM, closedAt: "2026-09-20T00:00:00.000Z" } } }, "GET /ops/teams": { status: 200, body: { teams: [{ ...TEAM, closedAt: "2026-09-20T00:00:00.000Z" }] } } } });
  await main(["team", "team-a"], closed.deps);
  assert.match(closed.logs[0], /CLOSED 2026-09-20T00:00:00.000Z/);
  await main(["teams"], closed.deps);
  assert.match(closed.logs[1], /closed 2026-09-20/);
  assert.doesNotMatch(closed.logs.join("\n"), /\[TEST\]/);
  // A test team (supply-checkout-o60.2): a badge in the list and the record, nothing more
  const marked = harness({ routes: { "GET /ops/teams/team-a": { status: 200, body: { team: { ...TEAM, test: true } } }, "GET /ops/teams": { status: 200, body: { teams: [{ ...TEAM, test: true }] } } } });
  await main(["team", "team-a"], marked.deps);
  assert.match(marked.logs[0], /^Acme \(team-a\) \[TEST\]: made by the prod journey tests/);
  await main(["teams"], marked.deps);
  assert.match(marked.logs[1], /Acme \[TEST\]/);
  const audit = harness({ routes });
  await main(["audit", "--team", "team-a"], audit.deps);
  assert.deepEqual(audit.requests[0].query, { teamId: "team-a" });
  assert.match(audit.logs[0], /ops.comp.set\s+team team-a\s+by op-1 -> free until 2026-12-31\s+"Pilot"/);
  const json = harness({ routes });
  await main(["team", "team-a", "--json"], json.deps);
  assert.equal(JSON.parse(json.logs[0]).team.id, "team-a");
});

test("shows a team's Stripe subscription and invoices, or why it can't (supply-checkout-6uw.4)", async () => {
  const stripe = {
    customerId: "cus_A1",
    subscription: { id: "sub_1", status: "active", lookupKey: "supply_checkout_starter_monthly", plan: "starter", interval: "month", seats: 3, currentPeriodEnd: "2026-10-01T00:00:00.000Z", cancelAtPeriodEnd: true, cancelAt: "2026-10-01T00:00:00.000Z", trialEnd: null, createdAt: "2026-08-01T00:00:00.000Z" },
    subscriptionCount: 2,
    invoices: [{ id: "in_1", number: "ABC-0001", status: "paid", createdAt: "2026-09-01T00:00:00.000Z", currency: "usd", total: 2700, amountDue: 2700, amountPaid: 2700 }],
    hasMoreInvoices: true,
  };
  const team = { ...TEAM, stripeCustomerId: "cus_A1" };
  const show = async (body) => {
    const h = harness({ routes: { "GET /ops/teams/team-a": { status: 200, body: { team, ...body } } } });
    await main(["team", "team-a"], h.deps);
    return h.logs[0];
  };
  const full = await show({ stripe });
  assert.match(full, /subscription sub_1 active, starter\/month \(supply_checkout_starter_monthly\), 3 seats, period ends 2026-10-01, cancels at period end/);
  assert.match(full, /2 subscriptions for this customer/);
  assert.match(full, /invoice ABC-0001\s+paid\s+27\.00 USD\s+2026-09-01/);
  assert.match(full, /older invoices in Stripe/);
  const none = await show({ stripe: { ...stripe, subscription: null, subscriptionCount: 0, invoices: [], hasMoreInvoices: false } });
  assert.match(none, /no subscription/);
  assert.match(none, /no invoices/);
  const unknown = await show({ stripe: { ...stripe, subscription: { ...stripe.subscription, plan: null, interval: null, lookupKey: null, cancelAtPeriodEnd: false, cancelAt: null, currentPeriodEnd: null, trialEnd: "2026-10-05T00:00:00.000Z" }, subscriptionCount: 1, invoices: [{ ...stripe.invoices[0], number: null }] } });
  assert.match(unknown, /subscription sub_1 active, unknown price, 3 seats, trial ends 2026-10-05$/m);
  assert.match(unknown, /invoice in_1/);
  assert.match(await show({ stripe: { error: "unavailable" } }), /Stripe: unavailable/);
  assert.doesNotMatch(await show({ stripe: null }), /Stripe:|subscription/);
  // An older API with no Stripe part
  assert.doesNotMatch(await show({}), /Stripe:|subscription/);
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

test("reopens a closed team at the version it read, with a new Idempotency-Key, and leaves an open one alone", async () => {
  const closed = { id: "team-c", name: "Charlie", plan: "trial", status: "trialing", seats: 3, ownerCount: 1, closedAt: "2026-09-01T10:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z", version: 4, comp: null };
  const routes = {
    "GET /ops/teams/team-c": { status: 200, body: { team: closed } },
    "POST /ops/teams/team-c/reopen": { status: 200, body: { eventId: "ev-9", replayed: false, version: 5 } },
  };
  const run = harness({ routes });
  await main(["reopen", "team-c", "--reason", "Owner disputes the closure"], run.deps);
  assert.deepEqual(
    run.requests.map((r) => r.method),
    ["GET", "POST"],
  );
  assert.deepEqual(run.requests[1].body, { reason: "Owner disputes the closure", expectedVersion: 4 });
  assert.match(run.requests[1].headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.match(run.logs[0], /Reopened Charlie \(team-c\), closed 2026-09-01T10:00:00.000Z: it won't be deleted.*Audit event ev-9./);

  const open = harness({ routes: { "GET /ops/teams/team-c": { status: 200, body: { team: { ...closed, closedAt: null } } } } });
  await main(["reopen", "team-c", "--reason", "Owner disputes the closure"], open.deps);
  assert.deepEqual(
    open.requests.map((r) => r.method),
    ["GET"],
  );
  assert.equal(open.logs[0], "Charlie (team-c) isn't closed; nothing to reopen.");

  const late = harness({ routes: { ...routes, "POST /ops/teams/team-c/reopen": { status: 409, body: { error: { code: "aborted", message: "This team is about to be deleted and can't be reopened any more", reason: "team_deleting" } } } } });
  await assert.rejects(main(["reopen", "team-c", "--reason", "Too late"], late.deps), /about to be deleted/);
  for (const argv of [["reopen", "--reason", "x"], ["reopen", "team-c"], ["reopen", "bad id", "--reason", "x"]]) {
    await assert.rejects(main(argv, harness().deps), UsageError, argv.join(" "));
  }
  const audit = harness({ routes: { "GET /ops/audit": { status: 200, body: { events: [{ ts: "t", action: "ops.team.reopen", teamId: "team-c", operatorSub: "op-1", reason: "Disputed", before: { closedAt: "2026-09-01T10:00:00.000Z", purgeAfter: "2026-10-01T10:00:00.000Z" }, after: null }] } } } });
  await main(["audit"], audit.deps);
  assert.match(audit.logs[0], /ops.team.reopen team team-c {2}by op-1 closed 2026-09-01T10:00:00.000Z -> open {2}"Disputed"/);
});

test("ranks the month's receipt reads with estimated cost, shows a team's, and audits them (supply-checkout-wxx)", async () => {
  const ranking = {
    month: "2026-09",
    teams: [
      { teamId: "team-b", name: "Bravo", status: "active", plan: "starter", compLive: false, receipts: 150, trialReceipts: 20, estimatedCostUsd: 1.05 },
      { teamId: "team-a", name: "Acme", status: "trialing", plan: "trial", compLive: true, receipts: 1, trialReceipts: 1, estimatedCostUsd: 0.007 },
      { teamId: "team-c", name: "Cee", status: "trialing", plan: "trial", compLive: false, receipts: 0, trialReceipts: 0, estimatedCostUsd: 0.001 },
    ],
    teamsRead: 1000,
    complete: false,
    estimatedCostPerReceiptUsd: 0.007,
  };
  const list = harness({ routes: { "GET /ops/receipts": (r) => ({ status: 200, body: { ...ranking, month: r.query.month ?? "2026-09" } }) } });
  await main(["receipts", "--month", "2026-08", "--limit", "5"], list.deps);
  assert.deepEqual(list.requests[0].query, { month: "2026-08", limit: "5" });
  assert.match(list.logs[0], /^Receipts read in 2026-08, most first \(est\. \$0\.007 a read\):/);
  assert.match(list.logs[0], /150\s+est\. \$1\.05\s+Bravo \(team-b\) {2}starter, active, trial reads 20/);
  assert.match(list.logs[0], /1\s+est\. \$0\.01\s+Acme \(team-a\) {2}comped, trial reads 1/);
  assert.match(list.logs[0], /est\. <\$0\.01\s+Cee/);
  assert.match(list.logs[0], /Only the first 1000 teams were read/);
  const empty = harness({ routes: { "GET /ops/receipts": { status: 200, body: { ...ranking, teams: [], complete: true } } } });
  await main(["receipts"], empty.deps);
  assert.deepEqual(empty.requests[0].query, {});
  assert.equal(empty.logs[0], "Receipts read in 2026-09, most first (est. $0.007 a read):\nNo receipts read in 2026-09.");
  await assert.rejects(main(["receipts", "--month", "Sept"], harness().deps), UsageError);
  // A team's record has its months and its trial
  const receipts = { months: [{ month: "2026-09", receipts: 40, estimatedCostUsd: 0.28 }, { month: "2026-08", receipts: 0, estimatedCostUsd: 0 }], trialReceipts: 25 };
  const one = harness({ routes: { "GET /ops/teams/team-a": { status: 200, body: { team: TEAM, stripe: null, receipts } } } });
  await main(["team", "team-a"], one.deps);
  assert.match(one.logs[0], /receipts in its trial: 25\n {2}receipts 2026-09: 40\s+est\. \$0\.28\n {2}receipts 2026-08: 0\s+est\. \$0\.00/);
  const unavailable = harness({ routes: { "GET /ops/teams/team-a": { status: 200, body: { team: TEAM, stripe: null, receipts: null } } } });
  await main(["team", "team-a"], unavailable.deps);
  assert.match(unavailable.logs[0], /receipts: unavailable/);
  // The audit names the month
  const audit = harness({ routes: { "GET /ops/audit": { status: 200, body: { events: [{ ts: "t", action: "ops.receipts.usage", teamId: "PLATFORM", operatorSub: "op-1", before: null, after: { month: "2026-09", teams: ["team-b", "team-a"] } }] } } } });
  await main(["audit"], audit.deps);
  assert.match(audit.logs[0], /ops.receipts.usage team PLATFORM {2}by op-1 receipts 2026-09, 2 teams/);
});
