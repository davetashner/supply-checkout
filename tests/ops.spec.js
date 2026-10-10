// The operator page (npm run build:ops, ops/; supply-checkout-gxlt, ADR 0015 §6). Built and
// tested with the web build (BUILD=web), in every browser. It runs here as CloudFront serves it:
// at its own origin, with the operator page's CSP and headers (failing on any violation),
// signing in through a stand-in for the operator pool's Managed Login and calling a stand-in
// for the /ops routes. The page's logic has its own unit tests (ops/test/, npm run test:ops).
import { createHash } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, allowConsoleError } from "./helpers.js";
import { OPS, builtFiles } from "../scripts/builds.mjs";
import { opsContentSecurityPolicy } from "../infra/lib/web/ops-content-security-policy.ts";


const DOMAIN = "supply-checkout.test";
// Its own origin, like ops.<env domain>, so coverage of src/ ignores it
const SITE = `https://ops.${DOMAIN}`;
const API = `https://api.${DOMAIN}`;
const AUTH = `https://ops-auth.${DOMAIN}`;
const CLIENT_ID = "opsclient123";
const OPS_ISS = "https://cognito-idp.example-1.amazonaws.com/example-1_OpsPool";
const CUSTOMER_ISS = "https://cognito-idp.example-1.amazonaws.com/example-1_Customers";
const CSP = opsContentSecurityPolicy({ api: `api.${DOMAIN}`, opsAuth: `ops-auth.${DOMAIN}` });
const NOW = Date.parse("2026-10-02T12:00:00Z");

const files = builtFiles(OPS);

const jwt = (claims) => ["eyJhbGciOiJub25lIn0", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const opsToken = (extra = {}) => jwt({ token_use: "access", client_id: CLIENT_ID, iss: OPS_ISS, exp: Math.floor(NOW / 1000) + 900, username: "ops-alice", "cognito:groups": ["operators"], ...extra });

const TEAM = {
  id: "team_acme",
  name: "Acme Cleaning",
  plan: "pro",
  seats: 5,
  status: "active",
  trialEndsAt: null,
  ownerCount: 1,
  closedAt: null,
  createdAt: "2026-01-15T10:00:00Z",
  stripeCustomerId: "cus_123",
  version: 7,
  comp: { plan: "pro", seats: null, until: "2026-12-03T00:00:00Z", reason: "Pilot", by: "sub-1", at: "2026-10-02T12:00:00Z", live: true },
  owners: [{ userId: "u_owner", email: "owner@example.test", joinedAt: "2026-01-15T10:00:00Z" }],
};
const STRIPE = {
  subscription: { id: "sub_1", status: "active", plan: "pro", interval: "month", lookupKey: "pro_month", seats: 5, currentPeriodEnd: "2026-11-01T00:00:00Z", cancelAtPeriodEnd: false, cancelAt: null, trialEnd: null, compDiscountUntil: "2026-12-02T00:00:00Z", discountCount: 1 },
  subscriptionCount: 1,
  invoices: [{ id: "in_1", number: "ACME-0001", status: "paid", createdAt: "2026-09-01T00:00:00Z", currency: "usd", total: 0, amountDue: 0, amountPaid: 0 }],
  hasMoreInvoices: false,
};

const REPORT_A = "0123456789abcdef0123456789abcdef";
const REPORT_B = "fedcba9876543210fedcba9876543210";
/** A report as GET /ops/feedback returns it (backend/src/operator/ops-handler.ts, opsFeedbackBody). */
const report = (reportId, extra = {}) => ({
  reportId,
  shortId: reportId.slice(0, 8),
  teamId: "team_acme",
  userId: "11111111-2222-4333-8444-555555555555",
  role: "member",
  createdAt: "2026-10-01T09:00:00.000Z",
  category: "bug",
  message: "The scanner froze\non the second scan",
  expected: "It keeps scanning",
  contactOk: true,
  context: { build: "1.13.0", screen: "scan", browser: "safari" },
  status: "new",
  beadId: null,
  statusAt: null,
  dismissReason: null,
  ...extra,
});

/** A stand-in for the /ops routes, as backend/src/operator/ops-handler.ts answers them. */
class FakeOpsApi {
  constructor({
    teams = [structuredClone(TEAM), { ...structuredClone(TEAM), id: "team_beta", name: "Beta Builders", comp: null, stripeCustomerId: null, owners: [] }],
    reports = [report(REPORT_A), report(REPORT_B, { teamId: "team_beta", contactOk: false, message: "Add a dark mode", category: "idea", createdAt: "2026-10-02T09:00:00.000Z" })],
  } = {}) {
    this.teams = new Map(teams.map((t) => [t.id, t]));
    this.reports = reports;
    // As the ops authorizer and function would: an ops-client token, until it's revoked
    this.revoked = false;
    this.requests = [];
    this.audit = [{ ts: "2026-10-01T09:00:00Z", action: "ops.comp.set", teamId: "team_acme", operatorSub: "sub-1", reason: "Pilot", after: { plan: "pro", until: "2026-12-02T12:00:00Z", months: 2 } }];
    this.forbidden = false;
  }

  cors(extra = {}) {
    return { "access-control-allow-origin": SITE, "access-control-allow-headers": "authorization, content-type, idempotency-key", "access-control-allow-methods": "GET, PUT, DELETE, POST", ...extra };
  }

  json(route, status, body) {
    return route.fulfill({ status, headers: this.cors({ "content-type": "application/json" }), body: JSON.stringify(body) });
  }

  async route(route) {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: this.cors() });
    const url = new URL(req.url());
    const headers = await req.allHeaders();
    const body = req.postData() ? JSON.parse(req.postData()) : undefined;
    this.requests.push({ method: req.method(), path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body });
    const claims = JSON.parse(Buffer.from((headers.authorization ?? "").replace(/^Bearer /, "").split(".")[1] ?? "", "base64url").toString() || "{}");
    if (this.revoked || claims.client_id !== CLIENT_ID || claims.iss !== OPS_ISS) return this.json(route, 401, { message: "Unauthorized" });
    if (headers.cookie) throw new Error("The page sent a cookie to the API");
    if (this.forbidden) return this.json(route, 403, { error: { code: "permission_denied", message: "Operators only" } });
    const [, , kind, id, sub, verb] = url.pathname.split("/");
    if (kind === "feedback") return this.feedback(route, req.method(), url, headers, body, id, sub, verb);
    if (kind === "teams" && !id && req.method() === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const teams = [...this.teams.values()].filter((t) => !q || t.name.toLowerCase().includes(q) || t.id === q);
      // A search's first page can be empty with a cursor: the page follows it
      if (q && !url.searchParams.get("cursor")) return this.json(route, 200, { teams: [], cursor: "page2" });
      return this.json(route, 200, { teams });
    }
    const team = this.teams.get(id);
    if (kind === "teams" && !team) return this.json(route, 404, { error: { code: "not_found", message: "No such team" } });
    if (kind === "teams" && !sub && req.method() === "GET") {
      return this.json(route, 200, { team, stripe: team.stripeCustomerId ? STRIPE : null, receipts: { trialReceipts: 3, months: [{ month: "2026-10", receipts: 12, estimatedCostUsd: 0.084 }] } });
    }
    if (kind === "teams" && sub === "comp") {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(headers["idempotency-key"] ?? "")) return this.json(route, 400, { error: { code: "bad_request", message: "Send an Idempotency-Key" } });
      if (typeof body?.reason !== "string" || body.reason.trim().length < 3) return this.json(route, 400, { error: { code: "bad_request", message: "Give a reason" } });
      if (body.expectedVersion !== team.version) return this.json(route, 409, { error: { code: "aborted", message: "The team changed since you read it; read it again and retry" } });
      team.version += 1;
      const eventId = `evt_${this.audit.length + 1}`;
      if (req.method() === "DELETE") {
        team.comp = { ...team.comp, until: new Date(NOW).toISOString(), live: false };
        this.audit.unshift({ ts: new Date(NOW).toISOString(), action: "ops.comp.end", teamId: id, operatorSub: "sub-1", reason: body.reason, after: null });
        return this.json(route, 200, { eventId, replayed: false, comp: null, version: team.version, stripeDiscount: "queued" });
      }
      const until = body.months ? new Date(Date.UTC(2026, 9 + body.months, 2, 12)).toISOString() : `${body.until}T00:00:00.000Z`;
      team.comp = { plan: body.plan, seats: body.seats ?? null, until, reason: body.reason, by: "sub-1", at: new Date(NOW).toISOString(), live: true };
      this.audit.unshift({ ts: new Date(NOW).toISOString(), action: "ops.comp.set", teamId: id, operatorSub: "sub-1", reason: body.reason, after: { plan: body.plan, until, ...(body.months ? { months: body.months } : {}) } });
      return this.json(route, 200, { eventId, replayed: false, comp: team.comp, ...(body.months ? { months: body.months } : {}), version: team.version, stripeDiscount: team.stripeCustomerId ? "queued" : "no_stripe_customer" });
    }
    if (kind === "audit") {
      const teamId = url.searchParams.get("teamId");
      const events = this.audit.filter((e) => !teamId || e.teamId === teamId);
      if (!url.searchParams.get("cursor") && !teamId) return this.json(route, 200, { events: events.slice(0, 1), cursor: "a2" });
      return this.json(route, 200, { events: url.searchParams.get("cursor") ? events.slice(1) : events });
    }
    return this.json(route, 404, { error: { code: "not_found", message: "No such route" } });
  }

  feedback(route, method, url, headers, body, teamId, reportId, verb) {
    if (!teamId && method === "GET") {
      const status = url.searchParams.get("status") ?? "new";
      return this.json(route, 200, { reports: this.reports.filter((r) => r.status === status) });
    }
    const found = this.reports.find((r) => r.teamId === teamId && r.reportId === reportId);
    if (!found) return this.json(route, 404, { error: { code: "not_found", message: "No such report" } });
    if (!verb && method === "GET") return this.json(route, 200, { report: found, email: found.contactOk ? "sender@example.test" : null, emailNote: null });
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(headers["idempotency-key"] ?? "")) return this.json(route, 400, { error: { code: "bad_request", message: "Send an Idempotency-Key" } });
    if (found.status !== "new") return this.json(route, 409, { error: { code: "aborted", message: `This report is already ${found.status}${found.beadId ? ` (bead ${found.beadId})` : ""}` } });
    const eventId = `evt_${this.audit.length + 1}`;
    this.audit.unshift({ ts: new Date(NOW).toISOString(), action: `ops.feedback.${verb}`, teamId: "PLATFORM", target: `feedback/${teamId}/${reportId}`, operatorSub: "sub-1", after: {} });
    if (verb === "dismiss") Object.assign(found, { status: "dismissed", dismissReason: body.reason, statusAt: new Date(NOW).toISOString() });
    else Object.assign(found, { status: "triaged", beadId: body.beadId, statusAt: new Date(NOW).toISOString() });
    return this.json(route, 200, { eventId, replayed: false, report: found });
  }
}

// Managed Login sends the browser back with a redirect; here, a page that does the same
const redirectPage = (route, location) =>
  route.fulfill({ status: 200, headers: { "content-type": "text/html" }, body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">` });

/**
 * Serves the page at SITE with CloudFront's headers, a stand-in for the operator pool's
 * Managed Login at AUTH (authorize, token, logout) and the API. Records what each saw.
 */
async function serve(page, { api = new FakeOpsApi(), token = () => opsToken(), clock = true } = {}) {
  const auth = { authorize: [], token: [], logout: [] };
  if (clock) await page.clock.install({ time: NOW });
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"}`));
  });
  await page.route(`${SITE}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const headers = { "content-security-policy": CSP, "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };
    if (pathname === "/ops-config.json") {
      return route.fulfill({ status: 200, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ apiUrl: API, authUrl: AUTH, clientId: CLIENT_ID }) });
    }
    const file = files.get(pathname);
    return file ? route.fulfill({ ...file, headers: { ...headers, "content-type": file.contentType } }) : route.fulfill({ status: 404, headers });
  });
  await page.route(`${AUTH}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === "/oauth2/authorize") {
      auth.authorize.push(Object.fromEntries(url.searchParams));
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", "the-code");
      back.searchParams.set("state", url.searchParams.get("state"));
      return redirectPage(route, back.toString());
    }
    if (url.pathname === "/oauth2/token") {
      const form = Object.fromEntries(new URLSearchParams(req.postData() ?? ""));
      auth.token.push({ form, headers: await req.allHeaders() });
      const challenge = auth.authorize.at(-1)?.code_challenge;
      const ok = form.code === "the-code" && challenge === createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
      return route.fulfill({
        status: ok ? 200 : 400,
        headers: { "content-type": "application/json", "access-control-allow-origin": SITE },
        body: JSON.stringify(ok ? { access_token: token(), id_token: jwt({ token_use: "id" }), refresh_token: "the-refresh-token", token_type: "Bearer", expires_in: 900 } : { error: "invalid_grant" }),
      });
    }
    if (url.pathname === "/logout") {
      auth.logout.push(Object.fromEntries(url.searchParams));
      return redirectPage(route, url.searchParams.get("logout_uri"));
    }
    return route.fulfill({ status: 404 });
  });
  await page.route(`${API}/**`, (route) => api.route(route));
  // Anything else would be a real request: fail it loudly
  await page.route((url) => ![SITE, AUTH, API].includes(url.origin), (route) => route.abort());
  return { api, auth };
}

async function signIn(page, opts) {
  const served = await serve(page, opts);
  await page.goto(`${SITE}/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Teams", level: 1 })).toBeVisible();
  return served;
}

const noViolations = async (page) => expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);

test("signs in through the operator pool with PKCE, keeps the token in memory only, and strips the code from the URL", async ({ page }) => {
  const { api, auth } = await signIn(page);
  expect(auth.authorize).toHaveLength(1);
  const authorize = auth.authorize[0];
  expect(authorize).toMatchObject({ response_type: "code", client_id: CLIENT_ID, redirect_uri: `${SITE}/`, scope: "openid aws.cognito.signin.user.admin", code_challenge_method: "S256" });
  expect(authorize.state).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(auth.token).toHaveLength(1);
  expect(auth.token[0].form).toMatchObject({ grant_type: "authorization_code", client_id: CLIENT_ID, code: "the-code", redirect_uri: `${SITE}/` });
  expect(auth.token[0].headers.cookie).toBeUndefined();
  // The answer is gone from the address bar and the history entry
  expect(page.url()).toBe(`${SITE}/`);
  // Nothing kept in the browser: no storage (the pending sign-in was removed), no cookies
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie }))).toEqual({ local: 0, session: 0, cookie: "" });
  expect(await page.context().cookies()).toEqual([]);
  // The refresh token was never kept, or sent anywhere
  expect(JSON.stringify(api.requests)).not.toContain("the-refresh-token");
  await expect(page.getByText("Signed in as ops-alice")).toBeVisible();
  await expect(page.getByText("Session ends in 15 min")).toBeVisible();
  // Every API call carries the ops token, and only in the header
  expect(api.requests.length).toBeGreaterThan(0);
  for (const r of api.requests) expect(r.headers.authorization).toBe(`Bearer ${opsToken()}`);
  await noViolations(page);
});

test("searches teams, opens one, and shows its billing and comp", async ({ page }) => {
  const { api } = await signIn(page);
  await expect(page.getByRole("row", { name: /Acme Cleaning/ })).toContainText("owner@example.test");
  await expect(page.getByRole("row", { name: /Beta Builders/ })).toBeVisible();
  await page.getByLabel("Team name or ID").fill("acme");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("row", { name: /Beta Builders/ })).toHaveCount(0);
  // The empty first page was followed with its cursor, as the CLI does
  expect(api.requests.filter((r) => r.path === "/ops/teams" && r.query.q === "acme").map((r) => r.query.cursor ?? null)).toEqual([null, "page2"]);

  await page.getByRole("link", { name: "Acme Cleaning" }).click();
  await expect(page.getByRole("heading", { name: "Acme Cleaning", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(`${SITE}/#/team/team_acme`);
  const facts = page.locator("dl.facts");
  await expect(facts).toContainText("pro until 2026-12-03, 2 months left");
  await expect(facts).toContainText("Version7");
  await expect(page.locator("#discount")).toHaveText("Comp discount: invoices $0 until about 2026-12-02, then billing resumes");
  await expect(page.getByText("Subscription sub_1: active, pro/month (pro_month), 5 seats, period ends 2026-11-01")).toBeVisible();
  await expect(page.getByRole("table", { name: "Latest invoices" })).toContainText("ACME-0001");
  await expect(page.getByText("Receipts 2026-10: 12, est. $0.08")).toBeVisible();
  await expect(page.getByText("owner@example.test (u_owner)")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // Back to the list, from memory
  await page.getByRole("link", { name: "Back to teams" }).click();
  await expect(page.getByRole("row", { name: /Acme Cleaning/ })).toBeVisible();
  await noViolations(page);
});

test("shows a Test badge on a test team, in the list and its record, and nothing else changes (supply-checkout-o60.2)", async ({ page }) => {
  const teams = [{ ...structuredClone(TEAM), test: true }, { ...structuredClone(TEAM), id: "team_beta", name: "Beta Builders", comp: null, stripeCustomerId: null, owners: [], test: false }];
  await signIn(page, { api: new FakeOpsApi({ teams }) });
  await expect(page.getByRole("row", { name: /Acme Cleaning/ }).locator(".badge")).toHaveText("Test");
  await expect(page.getByRole("row", { name: /Beta Builders/ }).locator(".badge")).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.getByRole("link", { name: "Acme Cleaning" }).click();
  await expect(page.getByRole("heading", { name: "Acme Cleaning Test", level: 1 })).toBeVisible();
  await expect(page.locator("dl.facts")).toContainText("left out of customer metrics");
  // Only a label: the record's comp and billing are the same as any team's
  await expect(page.locator("#discount")).toBeVisible();
  await expect(page.getByRole("button", { name: /comp/i }).first()).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await noViolations(page);
});

test("comps a team for N months, with its version and an Idempotency-Key, after asking for a reason", async ({ page }) => {
  const { api } = await signIn(page);
  await page.getByRole("link", { name: "Acme Cleaning" }).click();
  await page.getByLabel("Months", { exact: true }).selectOption("3");
  await page.getByRole("button", { name: "Comp team" }).click();
  await expect(page.getByRole("alert")).toHaveText("Give a reason (at least 3 characters)");
  expect(api.requests.filter((r) => r.method !== "GET")).toEqual([]);

  await page.getByLabel(/^Reason/).first().fill("Three months on us");
  await page.getByRole("button", { name: "Comp team" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Comped" })).toContainText("Comped Acme Cleaning: pro until 2027-01-02 (3 months). Audit event evt_2.");
  await expect(page.getByRole("status").filter({ hasText: "Comped" })).toContainText("billing worker");
  const [put] = api.requests.filter((r) => r.method === "PUT");
  expect(put.path).toBe("/ops/teams/team_acme/comp");
  expect(put.body).toEqual({ plan: "pro", months: 3, reason: "Three months on us", expectedVersion: 7 });
  expect(put.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(put.headers["content-type"]).toBe("application/json");
  // Read again after the write: the new version
  await expect(page.locator("dl.facts")).toContainText("Version8");
  await noViolations(page);
});

test("comps until a date with a plan and seats, then ends the comp", async ({ page }) => {
  const { api } = await signIn(page);
  await page.getByRole("link", { name: "Beta Builders" }).click();
  await expect(page.getByRole("heading", { name: "Comp this team" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "End the comp" })).toHaveCount(0);
  await page.getByLabel("Until a date").check();
  await page.getByLabel(/^Until \(UTC/).fill("2026-12-31");
  await page.getByLabel("Plan", { exact: true }).fill("free");
  await page.getByLabel("Seats (optional)").fill("4");
  await page.getByLabel(/^Reason/).first().fill("Pilot, 90 days");
  await page.getByRole("button", { name: "Comp team" }).click();
  await expect(page.getByText("Comped Beta Builders: free until 2026-12-31. Audit event evt_2.")).toBeVisible();
  await expect(page.getByText("Stripe: no customer, so nothing to discount.")).toBeVisible();
  expect(api.requests.find((r) => r.method === "PUT").body).toEqual({ plan: "free", until: "2026-12-31", seats: 4, reason: "Pilot, 90 days", expectedVersion: 7 });

  // End it: a reason first
  await page.getByRole("button", { name: "End comp now" }).click();
  await expect(page.getByRole("alert")).toContainText("Give a reason");
  await page.locator("#end-reason").fill("Pilot over");
  await page.getByRole("button", { name: "End comp now" }).click();
  await expect(page.getByText("Ended the comp of Beta Builders. Audit event evt_3.")).toBeVisible();
  const del = api.requests.find((r) => r.method === "DELETE");
  expect(del.body).toEqual({ reason: "Pilot over", expectedVersion: 8 });
  expect(del.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(del.headers["idempotency-key"]).not.toBe(api.requests.find((r) => r.method === "PUT").headers["idempotency-key"]);
  await expect(page.locator("dl.facts")).toContainText("(ended)");
  await noViolations(page);
});

test("a 409 says the team changed and to read it again, keeping what was typed", async ({ page }) => {
  const { api } = await signIn(page);
  await page.getByRole("link", { name: "Acme Cleaning" }).click();
  await page.getByLabel(/^Reason/).first().fill("Extend the pilot");
  // Another operator changes the team meanwhile
  api.teams.get("team_acme").version = 9;
  await page.getByRole("button", { name: "Comp team" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Not saved. The team changed since you read it; read it again and retry");
  await expect(alert).toContainText("Read it again, check what it says now, then send the change again.");
  const firstKey = api.requests.find((r) => r.method === "PUT").headers["idempotency-key"];

  await alert.getByRole("button", { name: "Read the team again" }).click();
  await expect(page.locator("dl.facts")).toContainText("Version9");
  await expect(page.getByLabel(/^Reason/).first()).toHaveValue("Extend the pilot");
  await page.getByRole("button", { name: "Comp team" }).click();
  await expect(page.getByText(/Comped Acme Cleaning/)).toBeVisible();
  const puts = api.requests.filter((r) => r.method === "PUT");
  expect(puts.map((r) => r.body.expectedVersion)).toEqual([7, 9]);
  // A new request after an answer gets a new key
  expect(puts[1].headers["idempotency-key"]).not.toBe(firstKey);
  await noViolations(page);
});

test("a write that gets no answer can be sent again with the same Idempotency-Key", async ({ page }) => {
  const { api } = await signIn(page);
  await page.getByRole("link", { name: "Acme Cleaning" }).click();
  await page.getByLabel(/^Reason/).first().fill("Two months on us");
  // A cross-origin request that fails on the network (here a reset connection) is one Firefox
  // logs as a console error, "Cross-Origin Request Blocked … (Reason: CORS request did not
  // succeed)", as it would for a real dropped connection. The page handles it (the alert below),
  // so that one error, for this URL, is expected; Chromium and WebKit log nothing for it.
  allowConsoleError(page, /Cross-Origin Request Blocked: .* at https:\/\/api\.supply-checkout\.test\/ops\/teams\/team_acme\/comp\. \(Reason: CORS request did not succeed\)/);
  let dropped;
  await page.route(`${API}/ops/teams/team_acme/comp`, async (route) => {
    if (route.request().method() === "PUT" && !dropped) {
      dropped = await route.request().allHeaders();
      return route.abort("connectionreset");
    }
    return route.fallback();
  });
  await page.getByRole("button", { name: "Comp team" }).click();
  await expect(page.getByRole("alert")).toContainText("No answer from the API");
  await expect(page.getByRole("alert")).toContainText("applied at most once");
  await page.getByRole("button", { name: "Comp team" }).click();
  await expect(page.getByText(/Comped Acme Cleaning/)).toBeVisible();
  const puts = api.requests.filter((r) => r.method === "PUT");
  expect(puts).toHaveLength(1);
  expect(dropped["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(puts[0].headers["idempotency-key"]).toBe(dropped["idempotency-key"]);
});

test("reads the operator audit by month, follows its cursor, and by team", async ({ page }) => {
  const { api } = await signIn(page);
  await page.getByRole("link", { name: "Audit" }).click();
  await expect(page.getByRole("heading", { name: "Operator audit" })).toBeVisible();
  await expect(page.getByLabel("Or month")).toHaveValue("2026-10");
  await expect(page.getByRole("row", { name: /ops\.comp\.set/ })).toContainText("-> pro until 2026-12-02 (2 months)");
  await page.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("button", { name: "More" })).toHaveCount(0);
  expect(api.requests.filter((r) => r.path === "/ops/audit").map((r) => r.query)).toEqual([{ month: "2026-10" }, { month: "2026-10", cursor: "a2" }]);

  await page.getByLabel("Team ID").fill("team_acme");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("alert")).toHaveText("Give a team ID or a month, not both");
  await page.getByLabel("Or month").fill("");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("row", { name: /ops\.comp\.set/ })).toBeVisible();
  expect(api.requests.at(-1).query).toEqual({ teamId: "team_acme" });
  await page.getByLabel("Team ID").fill("../x");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("alert")).toHaveText("That isn't a team ID");
  await page.getByLabel("Team ID").fill("");
  await page.getByLabel("Or month").fill("2026-13");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByRole("alert")).toHaveText("The month is YYYY-MM");
  // From a team's page, its own audit
  await page.getByRole("link", { name: "Teams" }).click();
  await page.getByRole("link", { name: "Acme Cleaning" }).click();
  await page.getByRole("link", { name: "This team's operator audit" }).click();
  await expect(page.getByLabel("Team ID")).toHaveValue("team_acme");
  await expect(page.getByRole("row", { name: /ops\.comp\.set/ })).toBeVisible();
  await page.getByRole("row", { name: /ops\.comp\.set/ }).getByRole("link", { name: "team_acme" }).click();
  await expect(page.getByRole("heading", { name: "Acme Cleaning", level: 1 })).toBeVisible();
  await noViolations(page);
});

test("shows API data as text, never as HTML", async ({ page }) => {
  const hostile = { ...structuredClone(TEAM), id: "team_x", name: '<img src=x onerror="window.__pwned=1">Evil', owners: [{ userId: "u", email: "<b>bold</b>@example.test", joinedAt: null }] };
  await signIn(page, { api: new FakeOpsApi({ teams: [hostile] }) });
  await expect(page.getByRole("row", { name: /Evil/ })).toContainText('<img src=x onerror="window.__pwned=1">Evil');
  await page.getByRole("link", { name: /Evil/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText('<img src=x onerror="window.__pwned=1">Evil');
  await expect(page.getByText("<b>bold</b>@example.test (u)")).toBeVisible();
  expect(await page.locator("main img, main b").count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await noViolations(page);
});

test("a customer-pool token is never used: the page refuses it and calls nothing", async ({ page }) => {
  // As if the token endpoint handed back the customer app's access token
  const { api } = await serve(page, { token: () => opsToken({ client_id: "webclient999", iss: CUSTOMER_ISS }) });
  await page.goto(`${SITE}/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("That token isn't for the operator page. Sign in with an operator account.");
  expect(api.requests).toEqual([]);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await noViolations(page);
});

test("refuses a sign-in answer it didn't ask for, and strips it from the URL", async ({ page }) => {
  const { auth } = await serve(page);
  await page.goto(`${SITE}/?code=stolen&state=forged`);
  await expect(page.getByRole("alert")).toHaveText("This sign-in wasn't started here. Sign in again.");
  expect(page.url()).toBe(`${SITE}/`);
  expect(auth.token).toEqual([]);
  await page.goto(`${SITE}/?error=access_denied&state=x`);
  await expect(page.getByRole("alert")).toContainText("Sign-in didn't finish (access_denied)");
  await noViolations(page);
});

test("comes back to the view it was on after signing in", async ({ page }) => {
  await serve(page);
  await page.goto(`${SITE}/#/team/team_acme`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Acme Cleaning", level: 1 })).toBeVisible();
  await noViolations(page);
});

test("asks to sign in again when the 15-minute token expires, or the API refuses it", async ({ page }) => {
  // The second sign-in's token is issued after the first expired
  let issued = 0;
  const { api } = await signIn(page, { token: () => opsToken({ exp: Math.floor(NOW / 1000) + 900 + (issued++ ? 3600 : 0) }) });
  await page.clock.fastForward("14:10");
  await expect(page.getByText("Session ends in 1 min")).toBeVisible();
  await page.clock.fastForward("01:00");
  await expect(page.getByRole("alert")).toHaveText("Your 15-minute session ended. Sign in again.");
  await expect(page.getByText(/Signed in as/)).toHaveCount(0);

  // Sign in again, then the token is revoked (sign-out elsewhere, removed from the group)
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Teams" })).toBeVisible();
  api.revoked = true;
  await page.getByRole("link", { name: "Acme Cleaning" }).click();
  await expect(page.getByRole("alert")).toHaveText("Your session ended or was signed out. Sign in again.");
  await noViolations(page);
});

test("says so when the account isn't an operator", async ({ page }) => {
  const api = new FakeOpsApi();
  api.forbidden = true;
  await serve(page, { api });
  await page.goto(`${SITE}/`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("This account isn't an operator (or no longer is). Ask an administrator.");
});

test("signs out: forgets the token and ends the operator pool's session", async ({ page }) => {
  const { api, auth } = await signIn(page);
  const before = api.requests.length;
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(auth.logout).toEqual([{ client_id: CLIENT_ID, logout_uri: `${SITE}/` }]);
  await expect(page.getByText(/Signed in as/)).toHaveCount(0);
  // Nothing of the session is left to use
  await page.goto(`${SITE}/#/teams`);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect(api.requests.length).toBe(before);
  expect(await page.evaluate(() => sessionStorage.length + localStorage.length)).toBe(0);
  await noViolations(page);
});

test("refuses a config that points anywhere but this environment", async ({ page }) => {
  await serve(page);
  await page.route(`${SITE}/ops-config.json`, (route) =>
    route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ apiUrl: "https://evil.example", authUrl: AUTH, clientId: CLIENT_ID }) }),
  );
  await page.goto(`${SITE}/`);
  await expect(page.getByRole("alert")).toHaveText(`ops-config.json apiUrl must be ${API}`);
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
});

test("lists reports by status, opens one with its sender's verified email, and records its bead (supply-checkout-3sv.26)", async ({ page }) => {
  const { api } = await signIn(page);
  await page.getByRole("link", { name: "Feedback" }).click();
  await expect(page.getByRole("heading", { name: "Feedback", level: 1 })).toBeVisible();
  const table = page.getByRole("table", { name: "New reports" });
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row", { name: /01234567/ })).toContainText("The scanner froze on the second scan");
  expect(api.requests.filter((r) => r.path === "/ops/feedback").map((r) => r.query)).toEqual([{ status: "new", limit: "25" }]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await table.getByRole("link", { name: "Report 01234567" }).click();
  await expect(page).toHaveURL(`${SITE}/#/report/team_acme/${REPORT_A}`);
  await expect(page.getByRole("heading", { name: "Report 01234567", level: 1 })).toBeVisible();
  await expect(page.locator(".report-text").first()).toHaveText("The scanner froze\non the second scan");
  await expect(page.locator("#contact")).toHaveText("Email (verified): sender@example.test");
  await expect(page.locator("dl.facts")).toContainText("member (user 11111111-2222-4333-8444-555555555555)");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // A bead ID is checked before anything is sent
  await page.getByLabel("Bead ID").fill("other-project-1");
  await page.getByRole("button", { name: "Record bead" }).click();
  await expect(page.getByRole("alert")).toHaveText("Give a bead ID of this project, like supply-checkout-abc.1");
  expect(api.requests.filter((r) => r.method === "POST")).toEqual([]);
  await page.getByLabel("Bead ID").fill("supply-checkout-abc.1");
  await page.getByRole("button", { name: "Record bead" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Recorded" })).toHaveText("Recorded supply-checkout-abc.1: the report is triaged. Audit event evt_2.");
  const [post] = api.requests.filter((r) => r.method === "POST");
  expect(post.path).toBe(`/ops/feedback/team_acme/${REPORT_A}/record`);
  expect(post.body).toEqual({ beadId: "supply-checkout-abc.1" });
  expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  // Read again: triaged, and no forms for it now
  await expect(page.locator("dl.facts")).toContainText("Triaged: supply-checkout-abc.1");
  await expect(page.getByRole("button", { name: "Record bead" })).toHaveCount(0);
  await expect(page.getByText("Only a new report can be dismissed or have a bead recorded.")).toBeVisible();

  // Back to the list it's in now, read again
  await page.getByRole("link", { name: "Back to feedback" }).click();
  await expect(page.getByLabel("Status")).toHaveValue("triaged");
  await expect(page.getByRole("table", { name: "Triaged reports" }).getByRole("row", { name: /01234567/ })).toContainText("Triaged: supply-checkout-abc.1");
  await page.getByLabel("Status").selectOption("dismissed");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(page.getByText("No dismissed reports.")).toBeVisible();
  await noViolations(page);
});

test("dismisses a report with a reason, says so when it isn't new any more, and never looks up an email it wasn't allowed to", async ({ page }) => {
  // Straight to the report: it's where the page comes back to after signing in
  const { api } = await serve(page);
  await page.goto(`${SITE}/#/report/team_beta/${REPORT_B}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Report fedcba98", level: 1 })).toBeVisible();
  await expect(page.locator("#contact")).toHaveText("The sender didn't agree to be contacted: no email was looked up.");
  await page.getByRole("button", { name: "Dismiss report" }).click();
  await expect(page.getByRole("alert")).toHaveText("Give a reason (at least 3 characters)");
  // Meanwhile someone records a bead for it
  Object.assign(api.reports[1], { status: "triaged", beadId: "supply-checkout-x.1" });
  await page.getByLabel(/^Reason/).fill("Not something we'll build");
  await page.getByRole("button", { name: "Dismiss report" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Not saved. This report is already triaged (bead supply-checkout-x.1)");
  await alert.getByRole("button", { name: "Read the report again" }).click();
  await expect(page.locator("dl.facts")).toContainText("Triaged: supply-checkout-x.1");

  // Put back to new (say the bead was a mistake, fixed with the CLI): dismissed from the list
  api.reports[1] = report(REPORT_B, { teamId: "team_beta", contactOk: false });
  await page.getByRole("link", { name: "Feedback", exact: true }).click();
  await page.getByRole("link", { name: "Report fedcba98" }).click();
  await expect(page.getByLabel(/^Reason/)).toHaveValue("Not something we'll build");
  await page.getByLabel(/^Reason/).fill("Duplicate of a known issue");
  await page.getByRole("button", { name: "Dismiss report" }).click();
  await expect(page.getByText("Dismissed. Audit event")).toBeVisible();
  const post = api.requests.filter((r) => r.method === "POST").at(-1);
  expect(post.body).toEqual({ reason: "Duplicate of a known issue" });
  await expect(page.locator("dl.facts")).toContainText("Dismissed: Duplicate of a known issue");
  await noViolations(page);
});

test("shows a report's text as text, never as HTML", async ({ page }) => {
  const hostile = report(REPORT_A, { message: '<img src=x onerror="window.__pwned=1">Broken', expected: "<b>bold</b>" });
  await signIn(page, { api: new FakeOpsApi({ reports: [hostile] }) });
  await page.getByRole("link", { name: "Feedback" }).click();
  await expect(page.getByRole("row", { name: /01234567/ })).toContainText('<img src=x onerror="window.__pwned=1">Broken');
  await page.getByRole("link", { name: "Report 01234567" }).click();
  await expect(page.locator(".report-text").first()).toHaveText('<img src=x onerror="window.__pwned=1">Broken');
  await expect(page.locator(".report-text").nth(1)).toHaveText("<b>bold</b>");
  expect(await page.locator("main img, main b").count()).toBe(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  await noViolations(page);
});
