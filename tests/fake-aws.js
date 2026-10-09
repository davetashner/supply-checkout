// A fake AWS backend for the web build's runtime (src/aws/), so its tests run offline:
// config.json, the API (docs/api/openapi.yaml: auth, account and data routes), Managed
// Login (every request to it answers 204, so a navigation there leaves the page where it
// is and the test can check where it would have gone), and AppSync Events' WebSocket
// (a fake in the page, docs/api/realtime.md).
//
// The API is served from the app's own origin (under /_api), so the tests need no CORS.
// tests/content-security-policy.spec.js covers the real cross-origin setup.
import { gunzipSync } from "node:zlib";
import { builtFiles } from "../scripts/builds.mjs";
import { GLOBAL_SERVICES_REGION } from "../infra/lib/config.ts";

export const ORIGIN = "https://supply-checkout.test";
export const API = ORIGIN + "/_api";
export const AUTH = "https://auth.supply-checkout.test";
export const REALTIME_HOST = "realtime.supply-checkout.test";
export const CONFIG = { apiUrl: API, authUrl: AUTH, clientId: "test-client", realtimeUrl: `wss://${REALTIME_HOST}/event/realtime`, realtimeHost: REALTIME_HOST };
// CloudWatch RUM (src/aws/rum.js): config.json's app monitor, and Cognito's and the RUM data
// plane's endpoints in its region. Not in CONFIG, so the other suites never load the client.
export const RUM_REGION = GLOBAL_SERVICES_REGION;
export const RUM = { rumAppMonitorId: "monitor-1", rumIdentityPoolId: `${RUM_REGION}:pool-1`, rumRegion: RUM_REGION };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" };
const AWS = /^https:\/\/[^/]+\.amazonaws\.com\//;

// Cognito's GetId and GetCredentialsForIdentity, and the data plane's PutRumEvents
export class FakeRum {
  // cognitoFails: Cognito Identity's requests fail, with an answer the client can't read (an
  // outage page). Not an aborted request: Firefox logs that as a CORS console error.
  constructor({ cognitoFails = false } = {}) {
    this.cognitoFails = cognitoFails;
    this.cognito = [];
    this.batches = [];
    this.other = [];
  }

  async install(page) {
    await page.route(AWS, (route) => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      if (url.host === `cognito-identity.${RUM_REGION}.amazonaws.com`) return this.answerCognito(route, req);
      if (url.host === `dataplane.rum.${RUM_REGION}.amazonaws.com` && url.pathname === `/appmonitors/${RUM.rumAppMonitorId}`) {
        const raw = req.postDataBuffer();
        const headers = req.headers();
        const body = JSON.parse((headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8"));
        this.batches.push({ headers, text: JSON.stringify(body), body });
        return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: "{}" });
      }
      this.other.push(req.url());
      return route.fulfill({ status: 404, headers: CORS });
    });
  }

  answerCognito(route, req) {
    const target = req.headers()["x-amz-target"], body = req.postDataJSON();
    this.cognito.push({ target, body });
    if (this.cognitoFails) return route.fulfill({ status: 503, headers: CORS, contentType: "text/html", body: "<h1>Service Unavailable</h1>" });
    const reply = (json) => route.fulfill({ status: 200, headers: CORS, contentType: "application/x-amz-json-1.1", body: JSON.stringify(json) });
    if (target === "AWSCognitoIdentityService.GetId") return reply({ IdentityId: `${RUM_REGION}:identity-1` });
    return reply({
      IdentityId: body.IdentityId,
      Credentials: { AccessKeyId: "AKIDGUEST", SecretKey: "guest-secret", SessionToken: "guest-session", Expiration: Math.floor(Date.now() / 1000) + 3600 },
    });
  }

  // Every event sent so far, with its details and metadata parsed
  events() {
    return this.batches.flatMap((b) => b.body.RumEvents.map((e) => ({ ...e, details: JSON.parse(e.details), metadata: JSON.parse(e.metadata) })));
  }
}

const ABORTED = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
let files;

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const jwt = (claims) => `${b64url({ alg: "none" })}.${b64url(claims)}.sig`;

export const TEAM = { id: "t1", name: "Echo Cleaning", role: "owner", plan: "trial", status: "trialing", trialEndsAt: "2026-10-10T12:00:00.000Z", homeRegion: "test" };
export const USER = { id: "u-pat", email: "pat@example.com", emailVerified: true };

const clone = (o) => JSON.parse(JSON.stringify(o));
function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = clone(v);
  }
}

// The team's marks on an item's alert: its acknowledgment and its order (supply-checkout-005.14)
const MARKS = ["ackedAtStock", "orderedQty", "orderedOn"];
const dropMarks = (data) => MARKS.forEach((f) => delete data[f]);
// A stock change that raises a marked item above its reorder level ends the team's marks on its
// low-stock alert, as backend/src/data/reorder.ts does (a count, whichever way it goes, counts as
// raising)
const endAck = (data, delta) => {
  if (delta > 0 && MARKS.some((f) => Object.hasOwn(data, f)) && !(typeof data.reorderAt === "number" && data.stock <= data.reorderAt)) dropMarks(data);
};

export class FakeBackend {
  // docs: { "<teamId>/<collection>/<id>": data }
  // members: { "<teamId>": [{ userId, name, email, role, joinedAt }] }, for the members screen
  // teamInvites: { "<teamId>": [{ id, email, role, createdAt, expiresAt, inviteStatus, failureReason, failedAt }] },
  // the invites its owners see there (invites is the signed-in user's own, for /me)
  // supportActions: { "<teamId>": [{ eventId, ts, actor, action, reason, before, after }] }, newest first
  // settings: { "<teamId>": { equipmentMarkup, version } }, the team settings (ADR 0017)
  // receipt: what POST /teams/{teamId}/receipts/read answers (the lines, with `match` as
  // product keys); receiptLimit: the team's receipts a month (RECEIPTS_PER_TEAM_PER_MONTH), or
  // in all for a trial (receiptPeriod "trial", RECEIPTS_PER_TRIAL)
  constructor({ teams = [TEAM], invites = [], members = {}, teamInvites = {}, supportActions = {}, settings = {}, user = USER, docs = {}, signedIn = true, claims = { given_name: "Pat", family_name: "Lee", email: USER.email }, config = CONFIG, expiresIn = 3600, receipt = { store: null, date: null, items: [], subtotal: null, tax: null, total: null }, receiptLimit = 200, receiptPeriod = "month" } = {}) {
    Object.assign(this, { teams: clone(teams), invites: clone(invites), members: clone(members), teamInvites: clone(teamInvites), supportActions: clone(supportActions), settings: clone(settings), user, signedIn, claims, config, expiresIn, receipt: clone(receipt), receiptLimit, receiptPeriod });
    // Receipts read per team, as the API counts them (backend/src/data/usage.ts)
    this.receiptsRead = {};
    // Invites for the user's address that /me lists once they verify it (the email routes)
    this.pendingInvites = [];
    // An address a provider rewrites the user's email to while a code is being sent: that
    // send answers 409 email_changed, as the API does when GetUser shows a new address
    this.rewriteEmail = null;
    this.inviteIds = 0;
    this.docs = new Map(Object.entries(docs).map(([k, data]) => [k, { version: 1, data: clone(data) }]));
    this.calls = [];
    // Checkout, return and stock operations: "<teamId>/<operationId>" -> { request, result }
    this.operations = new Map();
    // Accept every access token issued, not only the latest, for tests with two pages signed in
    this.shareTokens = false;
    this.issued = new Set();
    this.authRequests = [];
    this.rules = [];
    this.token = null;
    this.tokens = 0;
    this.pageSize = 1000;
    this.pageLoads = 0;
    this.cors = null;
  }

  // The next `times` requests matching method and path get this answer instead. path is a
  // string, a RegExp, or a function of (path, call), where call is as in requests().
  // { status, body }, { abort: true }, or { lost: true } (the API handles the request, but
  // the answer never arrives), and optionally { wait: promise } first.
  on(method, path, answer, times = 1) {
    this.rules.push({ method, path, answer, times });
  }

  // Holds matching requests until the returned function is called
  hold(method, path) {
    let release;
    const wait = new Promise((r) => { release = r; });
    this.rules.push({ method, path, answer: { wait }, times: Infinity });
    return () => { this.rules = this.rules.filter((x) => x.answer.wait !== wait); release(); };
  }

  // Answers the next matching request as the API does when it arrives, but delivers the
  // answer only when the returned function is called. A refresh's answer sets the refresh
  // cookie when it's delivered, as the browser does, even after a sign-out cleared it.
  delay(method, path) {
    let release;
    const wait = new Promise((r) => { release = r; });
    this.rules.push({ method, path, answer: { wait, late: true }, times: 1 });
    return release;
  }

  // Another user's write, as the API would store it
  write(team, coll, id, data) {
    const key = `${team}/${coll}/${id}`, cur = this.docs.get(key);
    this.docs.set(key, { version: (cur ? cur.version : 0) + 1, data: clone(data) });
    return this.docs.get(key).version;
  }
  doc(team, coll, id) { return this.docs.get(`${team}/${coll}/${id}`); }
  requests(method, path) { return this.calls.filter((c) => c.method === method && (typeof path === "string" ? c.path === path : path.test(c.path))); }

  issue() {
    this.token = `at-${++this.tokens}`;
    this.issued.add(this.token);
    return { accessToken: this.token, idToken: jwt({ sub: this.user.id, ...this.claims }), expiresIn: this.expiresIn };
  }

  async route(route) {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.startsWith("/_api/")) return this.serveFile(route, url);
    const path = url.pathname.slice(5), method = req.method();
    if (method === "OPTIONS") return route.fulfill({ status: 204, headers: this.corsHeaders() });
    const call = { method, path, query: Object.fromEntries(url.searchParams), headers: req.headers(), body: req.postDataJSON() };
    this.calls.push(call);
    const rule = this.rules.find((r) => r.method === method && (typeof r.path === "string" ? r.path === path : typeof r.path === "function" ? r.path(path, call) : r.path.test(path)));
    if (rule) {
      if (--rule.times <= 0) this.rules.splice(this.rules.indexOf(rule), 1);
      if (rule.answer.late) {
        const [status, body] = this.answer(method, path, call);
        await rule.answer.wait;
        if (path === "/auth/refresh" && status === 200) this.signedIn = true;
        return this.reply(route, status, body);
      }
      if (rule.answer.wait) await rule.answer.wait;
      if (rule.answer.abort) return route.abort();
      if (rule.answer.lost) { this.answer(method, path, call); return route.abort(); }
      if (rule.answer.status) return this.reply(route, rule.answer.status, rule.answer.body);
    }
    const [status, body] = this.answer(method, path, call);
    return this.reply(route, status, body);
  }

  // With cors set to the app's origin, the API answers as a separate origin, as it is deployed
  corsHeaders() {
    return this.cors ? {
      "access-control-allow-origin": this.cors,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET, PUT, PATCH, DELETE, POST",
      "access-control-allow-headers": "authorization, content-type, idempotency-key",
    } : {};
  }

  reply(route, status, body) {
    const headers = this.corsHeaders();
    if (body === undefined) return route.fulfill({ status, headers });
    return route.fulfill({ status, headers: { ...headers, "content-type": typeof body === "string" ? "text/html" : "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  }

  serveFile(route, url) {
    if (url.pathname === "/config.json") return this.config === null ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: "application/json", body: typeof this.config === "string" ? this.config : JSON.stringify(this.config) });
    // A reload (switching teams, or after being removed) leaves the page as it is, so its
    // coverage isn't lost; tests check what it saved for the next load
    if (url.pathname === "/" && this.pageLoads++ > 0) return route.fulfill({ status: 204 });
    files ||= builtFiles("web");
    const file = files.get(url.pathname);
    return file ? route.fulfill(file) : route.fulfill({ status: 404 });
  }

  answer(method, path, call) {
    const err = (status, code, reason) => [status, { error: { code, message: code, ...(reason ? { reason } : {}) } }];
    if (path === "/auth/session") {
      if (call.body.code !== "good-code") return err(401, "unauthenticated");
      this.signedIn = true;
      return [200, this.issue()];
    }
    if (path === "/auth/refresh") return this.signedIn ? [200, this.issue()] : err(401, "unauthenticated");
    if (path === "/auth/sign-out") { this.signedIn = false; return [204]; }
    // Resetting a password (supply-checkout-6uw.26): any address is taken alike; 123456 is the
    // code, and a password the pool's policy refuses ("short") is refused
    if (path === "/auth/password-reset") return /^[^\s@]+@[^\s@]+$/.test(call.body.email) ? [204] : err(400, "bad_request");
    if (path === "/auth/password-reset/confirm") {
      if (call.body.code !== "123456") return err(400, "bad_request", "code_mismatch");
      if (call.body.password === "short") return err(400, "bad_request", "password_invalid");
      return [204];
    }
    const bearer = call.headers.authorization || "";
    if (!this.token || (bearer !== "Bearer " + this.token && !(this.shareTokens && this.issued.has(bearer.slice(7))))) return [401, { message: "Unauthorized" }];

    if (path === "/me" && method === "DELETE") return this.deleteAccount(call.body, err);
    if (path === "/me") return [200, { user: this.user, teams: this.teams, invites: this.invites }];
    // The user's own preferences (supply-checkout-005.17), as the account API checks them: either
    // field, of the right type. Only for a user that has them (an API from before them has no route)
    if (path === "/me/preferences" && method === "PATCH") {
      if (!this.user.preferences) return err(404, "not_found");
      const { whatsNew, whatsNewLastShown, ...rest } = call.body || {};
      if (Object.keys(rest).length || (whatsNew === undefined && whatsNewLastShown === undefined)) return err(400, "bad_request");
      if (whatsNew !== undefined && typeof whatsNew !== "boolean") return err(400, "bad_request");
      if (whatsNewLastShown !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(whatsNewLastShown)) return err(400, "bad_request");
      const preferences = { ...this.user.preferences, ...(whatsNew === undefined ? {} : { whatsNew }), ...(whatsNewLastShown === undefined ? {} : { whatsNewLastShown }) };
      this.user = { ...this.user, preferences };
      return [200, { preferences }];
    }
    // Verifying the email as Cognito does it: a code for an unverified address, and 123456 is
    // the code it sent. A code counts only for the address it was sent to (409 email_changed
    // otherwise, and the code is spent). Verifying lists pendingInvites (invites for the
    // address) in /me.
    if (path === "/me/email/code" || path === "/me/email/verify") {
      if (this.user.emailVerified) return err(409, "aborted", "already_verified");
      if (path === "/me/email/code") {
        if (this.rewriteEmail) {
          this.user = { ...this.user, email: this.rewriteEmail };
          this.rewriteEmail = null;
          return err(409, "aborted", "email_changed");
        }
        this.codeSentTo = this.user.email;
        return [204];
      }
      if (this.codeSentTo === undefined) return err(400, "bad_request", "code_expired");
      if (this.codeSentTo !== this.user.email) { this.codeSentTo = undefined; return err(409, "aborted", "email_changed"); }
      if (call.body.code !== "123456") return err(400, "bad_request", "code_mismatch");
      this.user = { ...this.user, emailVerified: true };
      this.invites.push(...this.pendingInvites.splice(0));
      return [204];
    }
    // Two-step sign-in as Cognito does it: a password that meets the policy ("short" doesn't),
    // with the current one if given ("wrong" isn't), a secret, and 654321 is the app's code.
    // A right code turns it on and signs the user out everywhere: their token and refresh
    // cookie stop working.
    if (path === "/me/password") {
      if (call.body.password === "short") return err(400, "bad_request", "password_invalid");
      if (call.body.currentPassword === "wrong") return err(400, "bad_request", "password_mismatch");
      return [204];
    }
    if (path === "/me/mfa/totp") { this.totpStarted = true; return [200, { totp: { secret: "JBSWY3DPEHPK3PXP" } }]; }
    if (path === "/me/sign-out-everywhere") { this.signedIn = false; this.token = null; return [204]; }
    if (path === "/me/mfa/totp/verify") {
      if (!this.totpStarted) return err(409, "aborted", "code_expired");
      if (call.body.code !== "654321") return err(400, "bad_request", "code_mismatch");
      this.user = { ...this.user, mfa: "totp" };
      this.signedIn = false;
      this.token = null;
      return [204];
    }
    if (path === "/teams" && method === "POST") {
      // A new team starts the first-run checklist (backend/src/data/checklist.ts)
      const team = { ...TEAM, id: "t-" + call.headers["idempotency-key"].slice(0, 8), name: call.body.name, role: "owner", members: 1, checklist: { receipt: false, done: false } };
      const again = this.teams.find((t) => t.id === team.id);
      if (again) return [200, { team: again }];
      this.teams.push(team);
      return [201, { team }];
    }
    let m = path.match(/^\/invites\/([^/]+)\/accept$/);
    if (m) {
      const invite = this.invites.find((i) => i.id === decodeURIComponent(m[1]));
      if (!invite || call.body.token !== "tok") return err(404, "not_found");
      const team = { ...TEAM, id: "t-" + invite.id, name: invite.teamName, role: invite.role };
      this.teams.push(team);
      this.invites = this.invites.filter((i) => i !== invite);
      return [200, { team }];
    }

    m = path.match(/^\/teams\/([^/]+)\/close$/);
    if (m && method === "POST") return this.closeTeam(decodeURIComponent(m[1]), call.body, err);
    m = path.match(/^\/teams\/([^/]+)\/reopen$/);
    if (m && method === "POST") return this.reopenTeam(decodeURIComponent(m[1]), call.body, err);

    m = path.match(/^\/teams\/([^/]+)\/support-actions$/);
    if (m) return this.support(decodeURIComponent(m[1]), call.query, err);

    m = path.match(/^\/teams\/([^/]+)\/checklist$/);
    if (m && method === "PATCH") return this.checklist(decodeURIComponent(m[1]), call.body, err);

    m = path.match(/^\/teams\/([^/]+)\/settings$/);
    if (m) return this.teamSettings(decodeURIComponent(m[1]), method, call.body, err);

    m = path.match(/^\/teams\/([^/]+)\/receipts\/read$/);
    if (m && method === "POST") return this.readReceipt(decodeURIComponent(m[1]), call.body, err);

    m = path.match(/^\/teams\/([^/]+)\/receipts\/usage$/);
    if (m && method === "GET") return this.receiptUsage(decodeURIComponent(m[1]), err);

    m = path.match(/^\/teams\/([^/]+)\/members(?:\/([^/]+))?$/);
    if (m) return this.member(decodeURIComponent(m[1]), m[2] && decodeURIComponent(m[2]), method, call.body, err);

    m = path.match(/^\/teams\/([^/]+)\/invites(?:\/([^/]+)(\/resend)?)?$/);
    if (m) return this.teamInvite(decodeURIComponent(m[1]), m[2] && decodeURIComponent(m[2]), !!m[3], method, call.body, err);

    m = path.match(/^\/teams\/([^/]+)\/projects\/([^/]+)\/(checkout|return|lost)$/);
    if (m && method === "POST") return this.command(decodeURIComponent(m[1]), decodeURIComponent(m[2]), m[3], call.body);

    m = path.match(/^\/teams\/([^/]+)\/adhoc\/checkout$/);
    if (m && method === "POST") return this.quickTake(decodeURIComponent(m[1]), call.body);
    m = path.match(/^\/teams\/([^/]+)\/projects\/([^/]+)\/move$/);
    if (m && method === "POST") return this.move(decodeURIComponent(m[1]), decodeURIComponent(m[2]), call.body);

    m = path.match(/^\/teams\/([^/]+)\/projects\/([^/]+)\/lines$/);
    if (m && method === "POST") return this.addLines(decodeURIComponent(m[1]), decodeURIComponent(m[2]), call.body);

    m = path.match(/^\/teams\/([^/]+)\/products\/([^/]+)\/stock$/);
    if (m && method === "POST") return this.adjustStock(decodeURIComponent(m[1]), decodeURIComponent(m[2]), call.body);

    m = path.match(/^\/teams\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
    if (!m) return err(404, "not_found");
    const [team, coll, id] = [decodeURIComponent(m[1]), m[2], m[3] && decodeURIComponent(m[3])];
    const member = this.teams.find((t) => t.id === team);
    if (!member) return err(403, "permission_denied");
    const prefix = `${team}/${coll}/`;
    if (!id) {
      // since: open projects, and finished ones dated or finished since the day, or undated (recentFilter in backend/src/data/documents.ts)
      const since = call.query.since;
      if (since !== undefined && (coll !== "projects" || !/^\d{4}-\d{2}-\d{2}$/.test(since))) return err(400, "bad_request");
      const recent = (d) => d.status !== "closed" || typeof d.date !== "string" || d.date < "0" || d.date >= since || (typeof d.closedAt === "string" && d.closedAt >= since);
      const all = [...this.docs].filter(([k, d]) => k.startsWith(prefix) && (since === undefined || recent(d.data))).map(([k, d]) => ({ id: k.slice(prefix.length), version: d.version, data: d.data })).sort((a, b) => (a.id < b.id ? -1 : 1));
      const from = Number(call.query.cursor || 0), page = all.slice(from, from + this.pageSize);
      return [200, from + this.pageSize < all.length ? { documents: page, cursor: String(from + this.pageSize) } : { documents: page }];
    }
    const key = prefix + id, cur = this.docs.get(key);
    const out = () => ({ id, version: this.docs.get(key).version, data: this.docs.get(key).data });
    if (method === "GET") return cur ? [200, out()] : err(404, "not_found");
    if (member.role === "viewer") return err(403, "permission_denied", "view_only");
    // Every write names the version it was made against (ADR 0006); 0: it doesn't exist yet
    const expected = method === "DELETE" ? call.query.expectedVersion : call.body.expectedVersion;
    if (expected === undefined) return err(400, "bad_request");
    if (Number(expected) !== (cur ? cur.version : 0)) return err(409, "aborted");
    if (method === "DELETE") { this.docs.delete(key); return [204]; }
    if (method === "PATCH" && !cur) return err(404, "not_found");
    // A product's stock moves only through the stock commands (keepStock in
    // backend/src/data/documents.ts): a write keeps what's stored and refuses a different stock
    const stored = cur && cur.data.stock;
    if (coll === "products" && Object.hasOwn(call.body.data, "stock") && call.body.data.stock !== stored) return err(400, "bad_request");
    const data = method === "PUT" ? clone(call.body.data) : clone(cur.data);
    if (method === "PATCH") merge(data, call.body.data);
    // A changed reorder level drops an acknowledgment carried over unchanged (checkReorderFields in backend/src/data/reorder.ts)
    if (coll === "products" && cur && JSON.stringify(data.reorderAt) !== JSON.stringify(cur.data.reorderAt) && Object.hasOwn(data, "ackedAtStock") && data.ackedAtStock === cur.data.ackedAtStock) delete data.ackedAtStock;
    if (coll === "products" && stored !== undefined) data.stock = stored;
    // A project line's cost each is an amount in whole cents (ADR 0014), as backend/src/data/documents.ts checks
    const cents = (n) => typeof n === "number" && n >= 0 && n <= 1e6 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
    const badCost = coll === "projects" && Object.values(data.items || {}).some((l) => l && typeof l === "object" && "cost" in l && !cents(l.cost));
    if (badCost) return err(400, "bad_request");
    // An equipment line a write adds has nothing out: equipment goes out only through the commands
    // (checkKinds in backend/src/data/documents.ts, supply-checkout-1dg.18)
    const whole = (n) => Number.isInteger(n) && n >= 0;
    const emptyLine = (l) => whole(l.out) && ["returned", "lost"].every((f) => !(f in l) || whole(l[f])) && l.out === (l.returned || 0) + (l.lost || 0);
    const added = (k, l) => l && typeof l === "object" && l.kind === "equipment" && !Object.hasOwn(cur?.data.items || {}, k);
    if (coll === "projects" && Object.entries(data.items || {}).some(([k, l]) => added(k, l) && !emptyLine(l))) return err(400, "bad_request");
    // No project closes while company equipment is still out on it (ADR 0017, documents.ts)
    const stillOut = (l) => l && l.kind === "equipment" && (l.out || 0) - (l.returned || 0) - (l.lost || 0) > 0;
    if (coll === "projects" && data.status === "closed" && cur?.data.status !== "closed" && Object.values(data.items || {}).some(stillOut)) {
      return [409, { error: { code: "aborted", message: "Equipment is still out on this project", reason: "equipment_out" } }];
    }
    // ...and no line with equipment still out is removed (supply-checkout-1dg.10)
    const kept = (k) => data.items && Object.hasOwn(data.items, k) && data.items[k] !== null;
    if (coll === "projects" && Object.entries(cur?.data.items || {}).some(([k, l]) => stillOut(l) && !kept(k))) {
      return [409, { error: { code: "aborted", message: "Equipment is still out on this line: return it or mark it lost before removing it", reason: "equipment_out" } }];
    }
    // One open General Use project per team (ADR 0017, documents.ts)
    if (coll === "projects" && data.kind === "adhoc" && data.status !== "closed" && cur?.data.status === "closed" && this.openAdhoc(team)) {
      return [409, { error: { code: "aborted", message: "Another General Use project is open. Finish it before reopening this one.", reason: "adhoc_open" } }];
    }
    this.write(team, coll, id, data);
    return [200, out()];
  }

  // Checkout and return as the API runs them (docs/api/commands.md, backend/src/data/commands.ts):
  // the line and the stock change together, by adding to what's stored, and each gives the
  // project (and a product that tracks stock) a new version. An operation ID that's been used
  // returns its first result and changes nothing; used for another request, it's refused.
  // The members routes as the API runs them: owners list, change roles and remove; anyone
  // can leave; the team always keeps an owner
  member(team, userId, method, body, err) {
    const mine = this.teams.find((t) => t.id === team);
    if (!mine) return err(403, "permission_denied", "not_member");
    if (mine.role !== "owner" && !(method === "DELETE" && userId === this.user.id)) return err(403, "permission_denied", "owners_only");
    const list = (this.members[team] ||= []);
    if (method === "GET") return [200, { members: clone(list) }];
    const target = list.find((x) => x.userId === userId);
    if (!target) return err(404, "not_found");
    const owners = list.filter((x) => x.role === "owner").length;
    const demoting = target.role === "owner" && (method === "DELETE" || body.role !== "owner");
    // A closed team's last owner may leave it
    if (demoting && owners === 1 && !(mine.closedAt && method === "DELETE")) return [409, { error: { code: "aborted", message: "A team needs at least one owner. Make someone else an owner first.", reason: "last_owner" } }];
    if (method === "DELETE") {
      this.members[team] = list.filter((x) => x !== target);
      // Their other invites to the team go too
      if (target.email) this.teamInvites[team] = (this.teamInvites[team] || []).filter((i) => i.email !== target.email);
      return [204];
    }
    target.role = body.role;
    return [200, { member: clone(target) }];
  }

  // What support did to the team, as owners read it: a page of `limit`, and a cursor for the next
  support(team, query, err) {
    const mine = this.teams.find((t) => t.id === team);
    if (!mine) return err(403, "permission_denied", "not_member");
    if (mine.role !== "owner") return err(403, "permission_denied", "owners_only");
    const all = this.supportActions[team] || [], from = Number(query.cursor || 0), limit = Number(query.limit || 100);
    const actions = all.slice(from, from + limit);
    return [200, from + limit < all.length ? { actions, cursor: String(from + limit) } : { actions }];
  }

  // Reading a receipt as the API runs it (backend/src/api/receipts-handler.ts): contributors
  // and owners; a JPEG or PNG as base64 whose bytes are that type; one read counted against the
  // team's month before the model answers with this.receipt
  readReceipt(team, body, err) {
    const mine = this.teams.find((t) => t.id === team);
    if (!mine) return err(403, "permission_denied", "not_member");
    if (mine.role === "viewer") return err(403, "permission_denied", "view_only");
    const image = body && body.image;
    const bytes = image && typeof image.data === "string" ? Buffer.from(image.data, "base64") : Buffer.alloc(0);
    const magic = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47] }[image && image.mediaType];
    if (Object.keys(body || {}).join() !== "image" || !magic || magic.some((b, i) => bytes[i] !== b)) return err(400, "bad_request", "image_rejected");
    if ((this.receiptsRead[team] || 0) >= this.receiptLimit) {
      const message = this.receiptPeriod === "trial" ? `This team has read all ${this.receiptLimit} receipts included in its trial. An owner can subscribe to read more.` : `This team has read all ${this.receiptLimit} receipts included this month.`;
      return [429, { error: { code: "quota_exceeded", message, reason: "receipt_limit" } }];
    }
    this.receiptsRead[team] = (this.receiptsRead[team] || 0) + 1;
    return [200, { ...clone(this.receipt), usage: this.usageOf(team) }];
  }

  // The team's receipts against its allowance, as GET /teams/{teamId}/receipts/usage answers
  // (getReceiptQuota in backend/src/data/usage.ts): contributors and owners
  usageOf(team) {
    const used = this.receiptsRead[team] || 0;
    return { period: this.receiptPeriod, month: "2026-09", used, limit: this.receiptLimit, remaining: Math.max(0, this.receiptLimit - used) };
  }

  receiptUsage(team, err) {
    const mine = this.teams.find((t) => t.id === team);
    if (!mine) return err(403, "permission_denied", "not_member");
    if (mine.role === "viewer") return err(403, "permission_denied", "view_only");
    return [200, { usage: this.usageOf(team) }];
  }

  // The first-run checklist's progress as the API keeps it (backend/src/data/checklist.ts): owners
  // of an open team only, each field only ever true; `started` starts one for a team without.
  // /me carries it as the team's `checklist`
  checklist(team, body, err) {
    const mine = this.teams.find((t) => t.id === team);
    if (!mine || mine.role !== "owner") return err(403, "permission_denied", mine ? "owners_only" : "not_member");
    if (mine.closedAt) return err(403, "permission_denied", "team_closed");
    if (mine.subscriptionEnded) return err(403, "permission_denied", "subscription_ended");
    const fields = Object.keys(body || {});
    if (!fields.length || fields.some((f) => !["started", "receipt", "done"].includes(f) || body[f] !== true)) return err(400, "bad_request");
    const cur = mine.checklist || { receipt: false, done: false };
    mine.checklist = { receipt: cur.receipt || !!body.receipt, done: cur.done || !!body.done };
    return [200, { checklist: mine.checklist }];
  }

  // The team settings as the API runs them (backend/src/data/settings.ts): owners get the
  // equipment markup and its version, anyone else an empty settings; only owners save, on the
  // version they read
  teamSettings(team, method, body, err) {
    const mine = this.teams.find((t) => t.id === team);
    if (!mine) return err(403, "permission_denied", "not_member");
    const cur = this.settings[team] || { equipmentMarkup: 0, version: 0 };
    if (method === "GET") return [200, mine.role === "owner" ? { version: cur.version, settings: { equipmentMarkup: cur.equipmentMarkup } } : { settings: {} }];
    if (mine.role !== "owner") return err(403, "permission_denied", "owners_only");
    const m = body.equipmentMarkup;
    if (typeof m !== "number" || m < 0 || m > 1000 || Math.abs(Math.round(m * 100) - m * 100) > 1e-6) return err(400, "bad_request");
    if (body.expectedVersion !== cur.version) return err(409, "aborted");
    this.settings[team] = { equipmentMarkup: m, version: cur.version + 1 };
    return [200, { version: cur.version + 1, settings: { equipmentMarkup: m } }];
  }

  // Closing a team as the API runs it: owners, typing its name (any case, spaces around);
  // closing it again returns it as it is
  closeTeam(team, body, err) {
    const mine = this.teams.find((t) => t.id === team);
    if (!mine) return err(403, "permission_denied", "not_member");
    if (mine.role !== "owner") return err(403, "permission_denied", "owners_only");
    const typed = (v) => String(v).normalize("NFKC").trim().toLowerCase();
    if (!mine.closedAt) {
      if (typed(body.name) !== typed(mine.name)) return err(400, "bad_request");
      const now = Date.now();
      Object.assign(mine, { closedAt: new Date(now).toISOString(), deletesAt: new Date(now + 30 * 86400_000).toISOString(), reopenBy: new Date(now + 30 * 86400_000 - 3600_000).toISOString() });
      this.teamInvites[team] = [];
    }
    return [200, { team: clone(mine) }];
  }

  // Reopening a closed team as the API runs it: owners, typing its name; reopening an open
  // team returns it as it is
  reopenTeam(team, body, err) {
    const mine = this.teams.find((t) => t.id === team);
    if (!mine) return err(403, "permission_denied", "not_member");
    if (mine.role !== "owner") return err(403, "permission_denied", "owners_only");
    const typed = (v) => String(v).normalize("NFKC").trim().toLowerCase();
    if (mine.closedAt) {
      if (typed(body.name) !== typed(mine.name)) return err(400, "bad_request");
      Object.assign(mine, { closedAt: null, deletesAt: null, reopenBy: null });
    }
    return [200, { team: clone(mine) }];
  }

  // Deleting the account as the API does it: refused while the user is the only owner of an
  // open team with other members; otherwise they're out of every team and signed out for good
  deleteAccount(body, err) {
    if (!body || String(body.confirm).trim().toUpperCase() !== "DELETE") return err(400, "bad_request");
    const stuck = this.teams.filter((t) => {
      const list = this.members[t.id] || [];
      return t.role === "owner" && !t.closedAt && list.filter((x) => x.role === "owner").length <= 1 && list.length > 1;
    });
    if (stuck.length) return [409, { error: { code: "aborted", reason: "last_owner", message: `You're the only owner of ${stuck.map((t) => t.name).join(", ")}. Make someone else an owner, or close the team, before you delete your account.` } }];
    this.teams = [];
    this.invites = [];
    this.signedIn = false;
    this.deleted = true;
    return [204];
  }

  // A team's invites as the API runs them: owners list, invite (the server emails the
  // link), revoke and re-send (a new ID and link, pending again)
  teamInvite(team, id, resend, method, body, err) {
    const mine = this.teams.find((t) => t.id === team);
    if (!mine) return err(403, "permission_denied", "not_member");
    if (mine.role !== "owner") return err(403, "permission_denied", "owners_only");
    const list = (this.teamInvites[team] ||= []);
    const fresh = (email, role) => {
      const now = Date.now();
      return { id: `inv-${++this.inviteIds}`, email, role, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 7 * 86400_000).toISOString(), inviteStatus: "pending", failureReason: null, failedAt: null };
    };
    if (method === "GET") return [200, { invites: clone(list) }];
    if (method === "DELETE") { this.teamInvites[team] = list.filter((i) => i.id !== id); return [204]; }
    if (resend) {
      const old = list.find((i) => i.id === id);
      if (!old) return err(404, "not_found");
      const invite = fresh(old.email, old.role);
      this.teamInvites[team] = [invite, ...list.filter((i) => i !== old)];
      return [201, { invite: clone(invite) }];
    }
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || !["owner", "contributor", "viewer"].includes(body.role)) return err(400, "bad_request");
    if ((this.members[team] || []).some((x) => x.email === email)) return [409, { error: { code: "aborted", message: "They're already a member of this team" } }];
    if (list.some((i) => i.email === email && i.inviteStatus !== "expired")) return [409, { error: { code: "aborted", message: "They already have an invite to this team. Resend it instead." } }];
    const invite = fresh(email, body.role);
    list.unshift(invite);
    return [201, { invite: clone(invite) }];
  }

  command(team, projectId, name, body) {
    // With the API's messages where the app shows them (a refused checkout or return)
    const err = (status, code, message = code, reason) => [status, { error: { code, message, ...(reason ? { reason } : {}) } }];
    const member = this.teams.find((t) => t.id === team);
    if (!member) return err(403, "permission_denied", "permission_denied", "not_member");
    if (member.role === "viewer") return err(403, "permission_denied", "permission_denied", "view_only");
    const { operationId, productKey: key, quantity: qty, ...oneOff } = body;
    // Not part of the request: the quick take's own marker that it may check out onto the General Use project
    const quick = oneOff.quickTake === true;
    delete oneOff.quickTake;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId) || typeof key !== "string" || !Number.isInteger(qty) || qty < 1) return err(400, "bad_request");
    const projectKey = `${team}/projects/${projectId}`, productKey = `${team}/products/${key}`;
    const out = (k) => { const d = this.docs.get(k); return d ? { id: k.slice(k.lastIndexOf("/") + 1), version: d.version, data: d.data } : null; };
    const answer = (result, replayed) => [200, { operationId, replayed, result, project: out(projectKey), product: out(productKey) }];
    const request = JSON.stringify([name, projectId, key, qty, oneOff]);
    const prior = this.operations.get(`${team}/${operationId}`);
    if (prior) return prior.request === request ? answer(prior.result, true) : err(400, "bad_request");

    const project = this.docs.get(projectKey), product = this.docs.get(productKey);
    if (!project) return err(404, "not_found", "No such project");
    if (project.data.status === "closed") return err(409, "aborted");
    const items = (project.data.items ||= {});
    const line = Object.hasOwn(items, key) ? items[key] : undefined;
    let delta;
    // Company equipment (ADR 0017): its line has kind and no price, and names who took it last and when
    const taken = { takenBy: this.user.id, takenAt: new Date().toISOString() };
    // The General Use project takes only quick takes (ADR 0017)
    if (name === "checkout" && project.data.kind === "adhoc" && !quick) return err(400, "bad_request", "Take items for no job with Quick take, not onto the General Use project");
    if (name === "checkout") {
      if (line) { line.out += qty; if (line.kind === "equipment") Object.assign(line, taken); }
      else {
        const from = product ? product.data : oneOff;
        if (!product && (oneOff.name === undefined || oneOff.price === undefined)) return err(400, "bad_request", "This item isn't in inventory; send its name and price");
        const equipment = from.kind === "equipment";
        items[key] = { code: from.code ?? "", name: from.name ?? "", ...(equipment ? { kind: "equipment" } : { price: from.price ?? 0 }), ...(from.cost === undefined ? {} : { cost: from.cost }), out: qty, returned: 0, ...(equipment ? taken : {}) };
      }
      delta = -qty;
    } else if (name === "lost") {
      // Company equipment lost or broken (ADR 0017): no stock moves, and a charge adds up on the line
      if (!line || line.kind !== "equipment") return err(400, "bad_request", "Only company equipment is recorded as lost or broken");
      const left = line.out - (line.returned || 0) - (line.lost || 0);
      if (qty > left) return err(400, "bad_request", `Only ${left} of this item ${left === 1 ? "is" : "are"} still out`);
      line.lost = (line.lost || 0) + qty;
      if (body.charge !== undefined) line.lostCharge = Math.round(((line.lostCharge || 0) + body.charge) * 100) / 100;
      delta = 0;
    } else {
      if (!line) return err(400, "bad_request", "This item isn't on this project");
      if (line.purchased) return err(400, "bad_request", "This was bought for the client, so it doesn't come back");
      const left = line.out - (line.returned || 0) - (line.lost || 0);
      if (qty > left) return err(400, "bad_request", `Only ${left} of this item ${left === 1 ? "is" : "are"} left to return`);
      line.returned = (line.returned || 0) + qty;
      delta = qty;
    }
    project.version++;
    const tracked = !!product && typeof product.data.stock === "number";
    if (tracked && delta) { product.data.stock += delta; product.version++; endAck(product.data, delta); }
    const result = { operationId, command: name, reason: name, productKey: key, projectId, quantity: qty, stockDelta: tracked ? delta : 0, userId: this.user.id, at: new Date().toISOString() };
    this.operations.set(`${team}/${operationId}`, { request, result });
    return answer(result, false);
  }

  // The team's open General Use project's ID, if there is one
  openAdhoc(team) {
    const prefix = `${team}/projects/`;
    const hit = [...this.docs].find(([k, d]) => k.startsWith(prefix) && d.data.kind === "adhoc" && d.data.status !== "closed");
    return hit && hit[0].slice(prefix.length);
  }

  // Quick take as the API runs it (quickTake in backend/src/data/commands.ts): a checkout onto the
  // team's open General Use project, or onto the next adhoc-<n>, which it starts. Replays as for checkout.
  quickTake(team, body) {
    const err = (status, code, message = code, reason) => [status, { error: { code, message, ...(reason ? { reason } : {}) } }];
    const member = this.teams.find((t) => t.id === team);
    if (!member) return err(403, "permission_denied", "permission_denied", "not_member");
    if (member.role === "viewer") return err(403, "permission_denied", "permission_denied", "view_only");
    const { date, ...take } = body;
    const prior = this.operations.get(`${team}/${body.operationId}`);
    if (prior) return this.command(team, prior.result.projectId, "checkout", { ...take, quickTake: true });
    let projectId = this.openAdhoc(team), created = false;
    if (!projectId) {
      const prefix = `${team}/projects/adhoc-`;
      const n = Math.max(0, ...[...this.docs.keys()].filter((k) => k.startsWith(prefix)).map((k) => Number(k.slice(prefix.length)) || 0)) + 1;
      projectId = `adhoc-${n}`;
      created = true;
      this.write(team, "projects", projectId, { kind: "adhoc", client: "", date, status: "open", createdBy: this.user.id, createdAt: new Date().toISOString(), items: {} });
    }
    const [status, answer] = this.command(team, projectId, "checkout", { ...take, quickTake: true });
    if (status !== 200) return [status, answer];
    Object.assign(answer.result, { command: "quickTake", ...(created ? { projectCreated: true } : {}) });
    return [status, answer];
  }

  // Moving an ad hoc line to a client project as the API runs it (moveLine in commands.ts): both
  // projects change together, the client project's line keeps its own price, and no stock moves
  move(team, fromId, body) {
    const err = (status, code, message = code, reason) => [status, { error: { code, message, ...(reason ? { reason } : {}) } }];
    const member = this.teams.find((t) => t.id === team);
    if (!member) return err(403, "permission_denied", "permission_denied", "not_member");
    if (member.role === "viewer") return err(403, "permission_denied", "permission_denied", "view_only");
    const { operationId, productKey: key, toProjectId: toId } = body;
    const fromKey = `${team}/projects/${fromId}`, toKey = `${team}/projects/${toId}`;
    const out = (k) => { const d = this.docs.get(k); return d ? { id: k.slice(k.lastIndexOf("/") + 1), version: d.version, data: d.data } : null; };
    const answer = (result, replayed) => [200, { operationId, replayed, result, project: out(fromKey), toProject: out(toKey), product: null }];
    const request = JSON.stringify(["move", fromId, key, toId]);
    const prior = this.operations.get(`${team}/${operationId}`);
    if (prior) return prior.request === request ? answer(prior.result, true) : err(400, "bad_request");
    const from = this.docs.get(fromKey), to = this.docs.get(toKey);
    if (!from || from.data.kind !== "adhoc" || this.openAdhoc(team) !== fromId) return err(400, "bad_request", "Only a line on the open General Use project moves to another project");
    if (!to) return err(404, "not_found", "No such project");
    if (to.data.status === "closed") return err(409, "aborted", "This project is closed. Reopen it to move a line to it.");
    const line = Object.hasOwn(from.data.items || {}, key) ? from.data.items[key] : undefined;
    if (!line) return err(400, "bad_request", "This item isn't on this project");
    const items = (to.data.items ||= {}), cur = Object.hasOwn(items, key) ? items[key] : undefined;
    if (cur && cur.kind !== line.kind) return err(400, "bad_request", cur.kind === "equipment" ? "The project has this item as company equipment; correct the lines by hand" : "The project has this item as a supply; correct the lines by hand");
    if (cur) Object.assign(cur, { out: cur.out + line.out, returned: (cur.returned || 0) + (line.returned || 0), ...(line.lost ? { lost: (cur.lost || 0) + line.lost } : {}) });
    else items[key] = clone(line);
    delete from.data.items[key];
    from.version++;
    to.version++;
    const result = { operationId, command: "move", reason: "move", productKey: key, projectId: fromId, toProjectId: toId, quantity: line.out, returned: line.returned || 0, lost: line.lost || 0, stockDelta: 0, lineCreated: !cur, userId: this.user.id, at: new Date().toISOString() };
    this.operations.set(`${team}/${operationId}`, { request, result });
    return answer(result, false);
  }

  // A receipt's lines for a client as the API adds them (addLines in backend/src/data/commands.ts):
  // all or none, a new line with the request's copy, an existing one adding to its out, no stock
  // moved, and the project a new version. Replays and reused IDs as for checkout.
  addLines(team, projectId, body) {
    const err = (status, code, message = code, reason) => [status, { error: { code, message, ...(reason ? { reason } : {}) } }];
    const member = this.teams.find((t) => t.id === team);
    if (!member) return err(403, "permission_denied", "permission_denied", "not_member");
    if (member.role === "viewer") return err(403, "permission_denied", "permission_denied", "view_only");
    const { operationId, lines, ...rest } = body;
    const cents = (n) => typeof n === "number" && n >= 0 && n <= 1e6 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
    const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId) && !Object.keys(rest).length && Array.isArray(lines) && lines.length >= 1 && lines.length <= 40
      && new Set(lines.map((l) => l.productKey)).size === lines.length
      && lines.every((l) => typeof l.productKey === "string" && Number.isInteger(l.quantity) && l.quantity >= 1 && typeof l.name === "string" && l.name.trim() && (l.price === undefined || cents(l.price)) && (l.cost === undefined || cents(l.cost))
        && (l.priceSet === undefined || (l.priceSet === "manual" && l.price !== undefined)));
    if (!valid) return err(400, "bad_request");
    const projectKey = `${team}/projects/${projectId}`;
    const answer = (result, replayed) => {
      const d = this.docs.get(projectKey);
      return [200, { operationId, replayed, result, project: d ? { id: projectId, version: d.version, data: d.data } : null }];
    };
    const request = JSON.stringify(["addLines", projectId, lines]);
    const prior = this.operations.get(`${team}/${operationId}`);
    if (prior) return prior.request === request ? answer(prior.result, true) : err(400, "bad_request");
    const project = this.docs.get(projectKey);
    if (!project) return err(404, "not_found", "No such project");
    if (project.data.status === "closed") return err(409, "aborted", "This project is closed. Reopen it to add to it.");
    const items = (project.data.items ||= {});
    // Company equipment bought for the client (ADR 0017, section 2a): its own line, priced by the
    // server from the receipt price and the team's markup, or at a typed price ("manual")
    const markup = (this.settings[team] || { equipmentMarkup: 0 }).equipmentMarkup;
    const plans = [];
    for (const { productKey, quantity, code = "", name, price, cost, priceSet } of lines) {
      const product = this.docs.get(`${team}/products/${productKey}`);
      const equipment = product?.data.kind === "equipment";
      if (equipment ? price !== undefined && priceSet !== "manual" : price === undefined) return err(400, "bad_request");
      if (equipment && priceSet !== "manual" && cost === undefined) return err(400, "bad_request");
      const key = equipment ? `${productKey}:bought` : productKey;
      const each = equipment && priceSet !== "manual" ? Math.round(cost * (1 + markup / 100) * 100) / 100 : price;
      const fresh = { code, name: name.trim(), price: each, ...(cost === undefined ? {} : { cost }), ...(equipment ? { purchased: true, priceSet: priceSet === "manual" ? "manual" : "markup", ...(priceSet === "manual" ? { priceSetBy: this.user.id, priceSetAt: new Date().toISOString() } : {}) } : {}), out: quantity, returned: 0 };
      plans.push({ key, quantity, fresh, result: { productKey, quantity, ...(equipment ? { lineKey: key, purchased: true } : {}) } });
    }
    const done = plans.map(({ key, quantity, fresh, result }) => {
      const line = Object.hasOwn(items, key) ? items[key] : undefined;
      if (line) line.out += quantity;
      else items[key] = fresh;
      return { ...result, lineCreated: !line };
    });
    project.version++;
    const result = { operationId, command: "addLines", projectId, lines: done, userId: this.user.id, at: new Date().toISOString() };
    this.operations.set(`${team}/${operationId}`, { request, result });
    return answer(result, false);
  }

  // A stock adjustment as the API runs it (adjustStockCommand in backend/src/data/commands.ts):
  // a receipt adds `quantity` (an item that wasn't counted starts at it), a count sets stock to
  // `count`, an uncount removes it. Each gives a counted item a new version (an uncount of an
  // item that isn't counted changes nothing). A count or uncount with `expectedStock` is refused
  // (409 stock_changed) when the stock moved from it. Replays and reused IDs as for checkout.
  adjustStock(team, key, body) {
    const err = (status, code, reason) => [status, { error: { code, message: code, ...(reason ? { reason } : {}) } }];
    const member = this.teams.find((t) => t.id === team);
    if (!member) return err(403, "permission_denied", "not_member");
    if (member.role === "viewer") return err(403, "permission_denied", "view_only");
    const { operationId, reason, quantity, unitCost, count, expectedStock, ...rest } = body;
    const cents = (n) => typeof n === "number" && n >= 0 && n <= 1e6 && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;
    const whole = (n, min) => Number.isInteger(n) && n >= min && n <= 1e6;
    const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId) && !Object.keys(rest).length
      && (expectedStock === undefined || expectedStock === null || (reason !== "receipt" && whole(expectedStock, 0)))
      && (reason === "receipt" ? whole(quantity, 1) && cents(unitCost) && count === undefined && expectedStock === undefined
        : reason === "count" ? whole(count, 0) && quantity === undefined && unitCost === undefined
          : reason === "uncount" && count === undefined && quantity === undefined && unitCost === undefined);
    if (!valid) return err(400, "bad_request");
    const productKey = `${team}/products/${key}`;
    const answer = (result, replayed) => {
      const d = this.docs.get(productKey);
      return [200, { operationId, replayed, result, product: d ? { id: key, version: d.version, data: d.data } : null }];
    };
    const request = JSON.stringify([key, reason, quantity, unitCost, count, expectedStock]);
    const prior = this.operations.get(`${team}/${operationId}`);
    if (prior) return prior.request === request ? answer(prior.result, true) : err(400, "bad_request");
    const product = this.docs.get(productKey);
    if (!product) return err(404, "not_found");
    const tracked = typeof product.data.stock === "number", before = tracked ? product.data.stock : 0;
    // Moved since the person saw it, and not already what they're setting: refused
    if (expectedStock !== undefined && (tracked ? before : null) !== expectedStock && (tracked ? before : undefined) !== (reason === "count" ? count : undefined)) {
      return [409, { error: { code: "aborted", reason: "stock_changed", message: `The count changed while you were editing: ${tracked ? `it's now ${before}` : "it's no longer counted"}` } }];
    }
    const delta = reason === "receipt" ? quantity : reason === "count" ? count - before : -before;
    // An uncounted item is never low: its acknowledgment goes too (reorder.ts)
    if (reason === "uncount") { delete product.data.stock; dropMarks(product.data); }
    else { product.data.stock = before + delta; endAck(product.data, reason === "count" ? 1 : delta); }
    if (tracked || reason !== "uncount") product.version++;
    const result = { operationId, command: "stockAdjust", reason, productKey: key, ...(reason === "receipt" ? { quantity, unitCost } : reason === "count" ? { count } : {}), stockDelta: delta, userId: this.user.id, at: new Date().toISOString() };
    this.operations.set(`${team}/${operationId}`, { request, result });
    return answer(result, false);
  }
}

// In the page, before the app: a stand-in for AppSync Events' WebSocket. By default it
// opens, acknowledges and subscribes; window.__wsMode changes that for later sockets.
export function installFakeSocket(mode) {
  window.__wsMode = { open: true, ack: true, subscribe: "success", ...mode };
  window.__sockets = [];
  class FakeSocket {
    constructor(url, protocols) {
      Object.assign(this, { url, protocols, sent: [], closed: false });
      window.__sockets.push(this);
      setTimeout(() => (window.__wsMode.open ? this.onopen() : this.close()), 0);
    }
    send(text) {
      const m = JSON.parse(text);
      this.sent.push(m);
      if (m.type === "connection_init" && window.__wsMode.ack) this.receive({ type: "connection_ack", connectionTimeoutMs: 300000 });
      if (m.type === "subscribe" && window.__wsMode.subscribe) this.receive({ type: "subscribe_" + window.__wsMode.subscribe, id: m.id });
    }
    // A reply to something the app sent: later, on a timer, as a real socket never answers
    // during send()
    receive(msg) {
      setTimeout(() => this.deliver(msg), 0);
    }
    // A message from the server, delivered now. The test's helpers use this, so the message
    // has arrived by the time they return, whatever the page's clock is doing.
    deliver(msg) {
      if (!this.closed) this.onmessage({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
    }
    event(ev) {
      this.deliver({ type: "data", id: this.sent.find((m) => m.type === "subscribe").id, event: typeof ev === "string" ? ev : JSON.stringify(ev) });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      setTimeout(() => this.onclose({}), 0);
    }
    // The server closes the socket: the app hears of it now
    drop() {
      if (this.closed) return;
      this.closed = true;
      this.onclose({});
    }
    // The access token in the subprotocol header
    get token() {
      const header = this.protocols[1].slice("header-".length).replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(header)).Authorization;
    }
  }
  window.WebSocket = FakeSocket;
}

// Counts the API requests the app hasn't finished reading the answer to (unanswered below),
// for a test on page.clock: a jump past 15 seconds also fires the timeout of any request still
// in flight (src/aws/http.js), and a test that sets the clock against a timer the app sets
// once an answer is read must wait for that first. Call before openAws.
export const trackAnswers = (page) => page.addInitScript(() => {
  window.__apiPending = 0;
  const fetch = window.fetch, json = Response.prototype.json;
  window.fetch = (url, ...rest) => {
    if (!String(url).includes("/_api/")) return fetch(url, ...rest);
    window.__apiPending++;
    return fetch(url, ...rest).then((res) => {
      if (res.status === 204) window.__apiPending--;
      else res.__api = true;
      return res;
    }, (e) => { window.__apiPending--; throw e; });
  };
  Response.prototype.json = function () {
    const read = json.call(this);
    if (this.__api) read.finally(() => window.__apiPending--).catch(() => {});
    return read;
  };
});
export const unanswered = (page) => page.evaluate(() => window.__apiPending);

// Loads the web build with the fake backend. storage: { local: {...}, session: {...} },
// set before the app starts.
export async function openAws(page, backend, { path = "/", ws = {}, storage } = {}) {
  await page.route(ABORTED, (r) => r.abort());
  await page.route(AUTH + "/**", (r) => { backend.authRequests.push(r.request().url()); return r.fulfill({ status: 204 }); });
  await page.route(ORIGIN + "/**", (r) => backend.route(r));
  await page.addInitScript(installFakeSocket, ws);
  if (storage) {
    await page.addInitScript((s) => {
      if (sessionStorage.getItem("__seeded")) return;
      sessionStorage.setItem("__seeded", "1");
      for (const [k, v] of Object.entries(s.local || {})) localStorage.setItem(k, v);
      for (const [k, v] of Object.entries(s.session || {})) sessionStorage.setItem(k, v);
    }, storage);
  }
  await page.goto(ORIGIN + path);
}

// Waits until the app has loaded the team's data
export const connected = (page) => page.waitForFunction(() => {
  const n = document.getElementById("notice");
  return !document.body.classList.contains("account-open") && (n.hidden || !n.textContent.startsWith("Connecting"));
});

// The page's sockets: how many, and the latest one's state
export const sockets = (page) => page.evaluate(() => window.__sockets.map((s) => ({ closed: s.closed, token: s.protocols[1] && s.token, sent: s.sent, url: s.url, protocols: s.protocols })));
export const lastSocket = async (page) => (await sockets(page)).at(-1);
// These three act as the server on the latest socket, and the app has handled what they send
// by the time they return. Don't put them on a timer in the page: page.clock.fastForward()
// runs every timer that falls due at the end of its jump, oldest first, so an older app
// timer (the acknowledgement wait, the keep-alive) could close the socket before a message
// on a newer timer arrived.
// Sends a live event (an object, or raw text). Live events are for team t1 unless they say otherwise
export const emit = (page, ev) => page.evaluate((e) => window.__sockets.at(-1).event(e), ev && typeof ev === "object" && !("teamId" in ev) ? { teamId: "t1", ...ev } : ev);
// Any other message from AppSync
export const receive = (page, msg) => page.evaluate((m) => window.__sockets.at(-1).deliver(m), msg);
// The server closes the socket
export const dropSocket = (page) => page.evaluate(() => window.__sockets.at(-1).drop());
export const setVisible = (page, visible) => page.evaluate((v) => {
  Object.defineProperty(document, "hidden", { value: !v, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}, visible);
