// The account API (first sign-in: /me, POST /teams, accepting invites) against
// the in-memory table. Each request's Db handles only reach the partitions its
// session tags would allow (account-db.ts), so a call outside them fails the
// way IAM would refuse it. test/access-patterns.test.ts runs the same data
// functions against DynamoDB Local in CI.

import { beforeEach, describe, expect, it } from "vitest";
import type { AccountScope, DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import type { CognitoUser } from "../src/api/cognito-user.js";
import type { DataEvent } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { ACCOUNT_ROUTES, routeKey } from "../src/api/routes.js";
import { authorizeTeam, createInvite, EMAIL_CODES_PER_USER_PER_DAY, hashEmail, MAX_TEAMS_PER_USER, TEAMS_PER_USER_PER_DAY, TRIAL_DAYS, verifiedEmailHash } from "../src/data/index.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { connection } from "../src/data/client.js";
import { REGION, accountPartitions, fakeDb, fakeMailer, unusedDeleteUser } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const mails = fakeMailer();
const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const DAY = 86400_000;
const OWNER = "user-owner";
const PAT = "user-pat";
const MALLORY = "user-mallory";
const UNVERIFIED = "user-unverified";
// Somehow got Pat's address marked verified on their own account (the identity
// stack stops users writing email_verified; this is the second line)
const IMPOSTOR = "user-impostor";

const USERS: Record<string, CognitoUser> = {
  [OWNER]: { sub: OWNER, email: "owner@example.com", emailVerified: true, emailVerifiedInCognito: true },
  [PAT]: { sub: PAT, email: "Pat@Example.com", emailVerified: true, emailVerifiedInCognito: true },
  [MALLORY]: { sub: MALLORY, email: "mallory@example.com", emailVerified: true, emailVerifiedInCognito: true },
  // Signed up with Pat's address but never confirmed it
  [UNVERIFIED]: { sub: UNVERIFIED, email: "pat@example.com", emailVerified: false, emailVerifiedInCognito: false },
  [IMPOSTOR]: { sub: IMPOSTOR, email: "pat@example.com", emailVerified: true, emailVerifiedInCognito: true },
};

let table: MemoryTable;
let now: number;
let counts: Record<string, number>;
let scopes: AccountScope[];
let cognitoDown: boolean;
// Email codes: the tokens Cognito was asked to send a code for, the codes checked, which
// users Cognito now has verified, and what the next Cognito code call fails with
let codesSent: string[];
let codesChecked: [string, string][];
let verifiedNow: Set<string>;
let codeFailure: Error | undefined;
let logs: unknown[];
let handler: ReturnType<typeof createAccountHandler>;

function fakeObservability(): Observability {
  counts = {};
  return {
    region: REGION,
    logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1) => {
      counts[metric] = (counts[metric] ?? 0) + value;
    },
    gauge: () => {},
    flush: () => {},
  };
}

beforeEach(() => {
  now = Date.now();
  cognitoDown = false;
  codesSent = [];
  codesChecked = [];
  verifiedNow = new Set();
  codeFailure = undefined;
  logs = [];
  scopes = [];
  table = new MemoryTable();
  table.seedTeam("team-a", { [OWNER]: "owner", [PAT]: "contributor" });
  table.put({ PK: `USER#${PAT}`, SK: "TEAM#team-a", type: "userTeam", userId: PAT, teamId: "team-a", teamName: "team-a", role: "contributor" });
  table.put({ PK: `USER#${OWNER}`, SK: "TEAM#team-a", type: "userTeam", userId: OWNER, teamId: "team-a", teamName: "team-a", role: "owner" });
  // Like accountScopedDbs: each handle reaches only its session tags' partitions
  const dbFor: DbForAccount = (scope) => {
    scopes.push(scope);
    return table.scoped(accountPartitions(scope));
  };
  const userInfo = async (token: string) => {
    if (cognitoDown) throw new Error("GetUser failed: 500");
    const user = USERS[token.replace(/^token-/, "")];
    if (!user) throw new ApiError(401, "unauthenticated", "Sign in again");
    return verifiedNow.has(user.sub) ? { ...user, emailVerified: true, emailVerifiedInCognito: true } : user;
  };
  const emailCodes = {
    async send(token: string) {
      if (codeFailure) throw codeFailure;
      codesSent.push(token);
    },
    async verify(token: string, code: string) {
      if (codeFailure) throw codeFailure;
      codesChecked.push([token, code]);
      if (code !== "123456") throw new ApiError(400, "bad_request", "That code isn't right", "code_mismatch");
      verifiedNow.add(token.replace(/^token-/, ""));
    },
  };
  handler = createAccountHandler({ dbFor, userInfo, emailCodes, issuerUrl: ISSUER, obs: fakeObservability(), mailer: mails.mailer, deleteUser: unusedDeleteUser, now: () => now });
});

interface Request {
  readonly user?: string;
  readonly claims?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly query?: Record<string, string>;
}

function event(method: string, path: string, request: Request = {}): DataEvent {
  const segments = path.split("/");
  const route = ACCOUNT_ROUTES.find((r) => {
    const parts = r.path.split("/");
    return r.method === method && parts.length === segments.length && parts.every((p, i) => p.startsWith("{") || p === segments[i]);
  });
  const user = request.user ?? OWNER;
  const claims = request.claims ?? { sub: user, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER, client_id: "web" };
  const pathParameters: Record<string, string> = {};
  route?.path.split("/").forEach((p, i) => {
    if (p.startsWith("{")) pathParameters[p.slice(1, -1)] = segments[i] as string;
  });
  return {
    version: "2.0",
    routeKey: route ? routeKey(route) : `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: { authorization: `Bearer token-${user}`, ...request.headers },
    queryStringParameters: request.query,
    pathParameters,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function call(method: string, path: string, request: Request = {}) {
  const response = await handler(event(method, path, request));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const create = (user: string, name: string, key: string) => call("POST", "/teams", { user, body: { name }, headers: { "Idempotency-Key": key } });

/** An invite from team-a's owner, made through the data layer (test/invites-api.test.ts covers the invite routes). */
async function invite(email: string, options: { role?: "contributor" | "viewer" | "owner"; ttlDays?: number; team?: string } = {}) {
  const team = options.team ?? "team-a";
  const owner = await authorizeTeam(table.db(), OWNER, team);
  const { invite: made, token } = await createInvite(table.db(), owner, { email, role: options.role ?? "viewer", ttlDays: options.ttlDays });
  return { ...made, token };
}

/** Accept, as the app does from the emailed link: the invite ID and its token. */
const accept = (user: string, inviteId: string, token?: string) =>
  call("POST", `/invites/${inviteId}/accept`, { user, ...(token === undefined ? {} : { body: { token } }) });

describe("POST /teams", () => {
  it("creates a team on a 14-day trial with the caller as its only owner, in this region", async () => {
    const { status, body } = await create(MALLORY, "  Mallory Cleaning  ", "create-key-1");
    expect(status).toBe(201);
    expect(body.team).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Mallory Cleaning",
      role: "owner",
      plan: "trial",
      status: "trialing",
      trialEndsAt: new Date(now + TRIAL_DAYS * DAY).toISOString(),
      homeRegion: REGION,
      closedAt: null,
      deletesAt: null,
      comp: null,
    });
    const id = body.team.id as string;
    expect(table.get(`TEAM#${id}`, "META")).toMatchObject({ owners: 1, homeRegion: REGION, createdAt: new Date(now).toISOString() });
    expect(table.get(`TEAM#${id}`, `MEMBER#${MALLORY}`)).toMatchObject({ role: "owner", email: "mallory@example.com" });
    expect(table.get(`USER#${MALLORY}`, `TEAM#${id}`)).toMatchObject({ role: "owner", teamName: "Mallory Cleaning" });
    expect(counts.SignUps).toBe(1);
    // The new owner can use the team's data routes at once
    expect((await authorizeTeam(table.db(id), MALLORY, id)).role).toBe("owner");
  });

  it("makes one team from a double submit, and another only with a new key", async () => {
    const [a, b] = await Promise.all([create(MALLORY, "Echo", "double-click"), create(MALLORY, "Echo", "double-click")]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.team).toEqual(b.body.team);
    expect((await create(MALLORY, "Echo", "double-click")).status).toBe(200);
    expect((await call("GET", "/me", { user: MALLORY })).body.teams).toHaveLength(1);
    expect(counts.SignUps).toBe(1);
    const other = await create(MALLORY, "Echo", "second-team");
    expect(other.status).toBe(201);
    expect(other.body.team.id).not.toBe(a.body.team.id);
  });

  it("answers 409 to a key reused for a differently named team", async () => {
    expect((await create(MALLORY, "Echo", "reused-key")).status).toBe(201);
    expect(await create(MALLORY, "Foxtrot", "reused-key")).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect((await create(MALLORY, "Echo", "reused-key")).status).toBe(200);
  });

  it("stops at the most teams one account can be in", async () => {
    for (let i = 0; i < MAX_TEAMS_PER_USER; i++) {
      table.put({ PK: `USER#${MALLORY}`, SK: `TEAM#busy-${i}`, type: "userTeam", userId: MALLORY, teamId: `busy-${i}`, teamName: "x", role: "viewer" });
    }
    expect(await create(MALLORY, "One more", "cap-key-1")).toMatchObject({ status: 429, body: { error: { code: "quota_exceeded", message: expect.stringMatching(/at most 20 teams/) } } });
  });

  it("needs a well-formed idempotency key and a name, and nothing else", async () => {
    for (const headers of [{}, { "Idempotency-Key": "short" }, { "Idempotency-Key": "has spaces in it" }] as Record<string, string>[]) {
      expect(await call("POST", "/teams", { user: MALLORY, body: { name: "Echo" }, headers }), JSON.stringify(headers)).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    }
    for (const body of [{}, { name: " " }, { name: "x".repeat(201) }, { name: "Echo", teamId: "team-a" }, { name: "Echo", owner: OWNER }]) {
      expect((await call("POST", "/teams", { user: MALLORY, body, headers: { "Idempotency-Key": "valid-key-1" } })).status, JSON.stringify(body)).toBe(400);
    }
    expect(scopes.every((s) => s.userId === MALLORY)).toBe(true);
  });

  it("limits how many teams a user creates a day", async () => {
    for (let i = 0; i < TEAMS_PER_USER_PER_DAY; i++) expect((await create(MALLORY, `Team ${i}`, `limit-key-${i}`)).status).toBe(201);
    expect(await create(MALLORY, "One more", "limit-key-x")).toMatchObject({ status: 429, body: { error: { code: "quota_exceeded" } } });
    // Someone else can still create one
    expect((await create(PAT, "Pat's", "limit-key-x")).status).toBe(201);
  });
});

describe("GET /me", () => {
  it("lists every team the caller is in, with role and trial status, for the switcher", async () => {
    const created = (await create(PAT, "Bravo Co", "pat-team-1")).body.team;
    const { status, body } = await call("GET", "/me", { user: PAT });
    expect(status).toBe(200);
    expect(body.user).toEqual({ id: PAT, email: "Pat@Example.com", emailVerified: true });
    expect(body.teams).toEqual([
      created,
      { id: "team-a", name: "team-a", role: "contributor", plan: undefined, status: undefined, trialEndsAt: null, homeRegion: REGION, closedAt: null, deletesAt: null, comp: null },
    ].map((t) => JSON.parse(JSON.stringify(t))));
    expect(body.invites).toEqual([]);
  });

  it("shows a live comp from support (ADR 0015), but not one that has run out", async () => {
    table.put({ ...table.get("TEAM#team-a", "META"), compPlan: "free", compUntil: new Date(now + DAY).toISOString(), compReason: "Pilot", compBy: "op-1" });
    const live = (await call("GET", "/me", { user: PAT })).body.teams[0];
    expect(live.comp).toEqual({ plan: "free", until: new Date(now + DAY).toISOString() });
    now += 2 * DAY;
    expect((await call("GET", "/me", { user: PAT })).body.teams[0].comp).toBeNull();
  });

  it("shows a new user no teams and no invites", async () => {
    expect(await call("GET", "/me", { user: MALLORY })).toEqual({
      status: 200,
      body: { user: { id: MALLORY, email: "mallory@example.com", emailVerified: true }, teams: [], invites: [] },
    });
  });

  it("shows only the caller's own teams and invites, whatever the request says", async () => {
    await invite("owner-two@example.com");
    const mine = await call("GET", "/me", { user: MALLORY, query: { userId: OWNER, email: "owner@example.com" } });
    expect(mine.body.teams).toEqual([]);
    expect(mine.body.user.id).toBe(MALLORY);
    // Someone else's token for the same sub can't happen, but if Cognito ever disagreed with the JWT, fail closed
    expect((await call("GET", "/me", { user: MALLORY, headers: { authorization: `Bearer token-${OWNER}` } })).status).toBe(401);
    // Every session was for the caller
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes.every((s) => s.userId === MALLORY)).toBe(true);
  });

  it("does per-team work for at most the membership limit, however many rows there are", async () => {
    for (let i = 0; i < MAX_TEAMS_PER_USER + 5; i++) {
      table.seedTeam(`many-${String(i).padStart(2, "0")}`, { [MALLORY]: "viewer" });
      table.put({ PK: `USER#${MALLORY}`, SK: `TEAM#many-${String(i).padStart(2, "0")}`, type: "userTeam", userId: MALLORY, teamId: `many-${String(i).padStart(2, "0")}`, teamName: "x", role: "viewer" });
    }
    expect((await call("GET", "/me", { user: MALLORY })).body.teams).toHaveLength(MAX_TEAMS_PER_USER);
    expect(scopes.filter((s) => s.teamId !== undefined)).toHaveLength(MAX_TEAMS_PER_USER);
  });

  it("skips a switcher row for a team the caller was removed from", async () => {
    table.put({ PK: `USER#${MALLORY}`, SK: "TEAM#team-a", type: "userTeam", userId: MALLORY, teamId: "team-a", teamName: "team-a", role: "viewer" });
    expect((await call("GET", "/me", { user: MALLORY })).body.teams).toEqual([]);
  });

  it("lists live invites for the caller's verified email only", async () => {
    await table.seedTeam("team-b", { [OWNER]: "owner" });
    const fromA = await invite("pat@example.com", { role: "contributor" });
    const fromB = await invite("PAT@example.com", { team: "team-b" });
    await invite("someone@example.com", { team: "team-b" });
    await invite("mallory@example.com", { ttlDays: 1, team: "team-b" });

    const pat = (await call("GET", "/me", { user: PAT })).body;
    // Pat is already in team-a, so that invite isn't offered
    expect(pat.invites).toEqual([
      { id: fromB.inviteId, teamName: "team-b", role: "viewer", expiresAt: new Date(fromB.expiresAt * 1000).toISOString() },
    ]);
    expect(fromA.teamId).toBe("team-a");
    // Same address, not verified: nothing, and no invitee session at all
    const unverified = (await call("GET", "/me", { user: UNVERIFIED })).body;
    expect(unverified).toMatchObject({ user: { emailVerified: false }, invites: [] });
    expect(scopes.filter((s) => s.userId === UNVERIFIED).every((s) => s.invitee === undefined)).toBe(true);
    // Expired invites aren't listed
    expect((await call("GET", "/me", { user: MALLORY })).body.invites).toHaveLength(1);
    now += 2 * DAY;
    expect((await call("GET", "/me", { user: MALLORY })).body.invites).toEqual([]);
  });
});

describe("POST /invites/{inviteId}/accept", () => {
  it("adds the caller to the team with the invited role, once", async () => {
    await table.seedTeam("team-b", { [OWNER]: "owner" });
    const { inviteId, token } = await invite("pat@example.com", { team: "team-b", role: "owner" });
    const accepted = await accept(PAT, inviteId, token);
    expect(accepted).toMatchObject({ status: 200, body: { team: { id: "team-b", role: "owner" } } });
    expect(table.get("TEAM#team-b", `MEMBER#${PAT}`)).toMatchObject({ role: "owner", email: "pat@example.com" });
    expect(table.get("TEAM#team-b", "META")?.owners).toBe(2);
    expect(counts.InvitesAccepted).toBe(1);
    const me = (await call("GET", "/me", { user: PAT })).body;
    expect(me.teams.map((t: { id: string }) => t.id)).toEqual(["team-a", "team-b"]);
    expect(me.invites).toEqual([]);
    // Used: it's gone
    expect(await accept(PAT, inviteId, token)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  });

  it("needs the token from the emailed link: none, a wrong one or another invite's is 404", async () => {
    await table.seedTeam("team-b", { [OWNER]: "owner" });
    const { inviteId, token } = await invite("pat@example.com", { team: "team-b" });
    await table.seedTeam("team-c", { [OWNER]: "owner" });
    const other = await invite("pat@example.com", { team: "team-c" });
    for (const wrong of [undefined, "", "x".repeat(43), other.token, 42 as unknown as string]) {
      expect(await accept(PAT, inviteId, wrong), String(wrong)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    }
    expect(table.get("TEAM#team-b", `MEMBER#${PAT}`)).toBeUndefined();
    expect(table.get("TEAM#team-b", `INVITE#${inviteId}`)).toBeDefined();
    expect((await call("POST", `/invites/${inviteId}/accept`, { user: PAT, body: { token, teamId: "team-a" } })).status).toBe(400);
    expect((await accept(PAT, inviteId, token)).status).toBe(200);
  });

  it("keeps out someone with the invited address marked verified but no token", async () => {
    await table.seedTeam("team-b", { [OWNER]: "owner" });
    const { inviteId } = await invite("pat@example.com", { team: "team-b", role: "owner" });
    // They can see the invite exists (team name and role)...
    expect((await call("GET", "/me", { user: IMPOSTOR })).body.invites).toEqual([expect.objectContaining({ id: inviteId, teamName: "team-b", role: "owner" })]);
    // ...but can't join without the link, however they guess
    for (const guess of [undefined, inviteId, "a".repeat(43)]) expect((await accept(IMPOSTOR, inviteId, guess)).status).toBe(404);
    expect(table.get("TEAM#team-b", `MEMBER#${IMPOSTOR}`)).toBeUndefined();
  });

  it("refuses another email address, an unverified one, and an expired invite, even with the token", async () => {
    await table.seedTeam("team-b", { [OWNER]: "owner" });
    const { inviteId, token } = await invite("pat@example.com", { team: "team-b", ttlDays: 1 });
    expect((await accept(MALLORY, inviteId, token)).status).toBe(404);
    expect(await accept(UNVERIFIED, inviteId, token)).toMatchObject({ status: 403, body: { error: { code: "permission_denied" } } });
    now += 2 * DAY;
    expect((await accept(PAT, inviteId, token)).status).toBe(404);
    for (const user of [MALLORY, UNVERIFIED, PAT]) expect(table.get("TEAM#team-b", `MEMBER#${user}`)).toBeUndefined();
    // Mallory's lookups ran on her own invitee partition, never Pat's
    expect(scopes.filter((s) => s.userId === MALLORY && s.invitee).map((s) => s.invitee)).toEqual([hashEmail("mallory@example.com")]);
    expect(scopes.some((s) => s.userId === MALLORY && s.teamId === "team-b")).toBe(false);
  });

  it("matches a Kelvin-sign address to the plain one", async () => {
    await table.seedTeam("team-b", { [OWNER]: "owner" });
    // U+212A KELVIN SIGN: NFKC folds it to K on both sides
    const { inviteId, token } = await invite("\u212Aat@example.com", { team: "team-b" });
    USERS["user-kat"] = { sub: "user-kat", email: "kat@example.com", emailVerified: true, emailVerifiedInCognito: true };
    expect((await call("GET", "/me", { user: "user-kat" })).body.invites).toHaveLength(1);
    expect((await accept("user-kat", inviteId, token)).status).toBe(200);
  });

  it("answers 409 to someone already in the team, 429 at the team limit, and 400 to a malformed ID", async () => {
    const { inviteId, token } = await invite("pat@example.com");
    expect(await accept(PAT, inviteId, token)).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(table.get("TEAM#team-a", `INVITE#${inviteId}`)).toBeDefined();
    expect((await accept(PAT, "not%20an%20id", token)).status).toBe(400);
    for (let i = 0; i < MAX_TEAMS_PER_USER; i++) {
      table.put({ PK: `USER#${MALLORY}`, SK: `TEAM#busy-${i}`, type: "userTeam", userId: MALLORY, teamId: `busy-${i}`, teamName: "x", role: "viewer" });
    }
    const busy = await invite("mallory@example.com");
    expect(await accept(MALLORY, busy.inviteId, busy.token)).toMatchObject({ status: 429, body: { error: { code: "quota_exceeded" } } });
  });
});

describe("verifying the caller's email address", () => {
  it("emails a code, checks it with the caller's own token, and then /me lists their invites", async () => {
    await invite("pat@example.com");
    expect((await call("GET", "/me", { user: UNVERIFIED })).body).toMatchObject({ user: { emailVerified: false }, invites: [] });
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED })).status).toBe(204);
    expect(codesSent).toEqual([`token-${UNVERIFIED}`]);
    expect(await call("POST", "/me/email/verify", { user: UNVERIFIED, body: { code: "654321" } })).toMatchObject({ status: 400, body: { error: { code: "bad_request", reason: "code_mismatch" } } });
    expect((await call("POST", "/me/email/verify", { user: UNVERIFIED, body: { code: "123456" } })).status).toBe(204);
    expect(codesChecked).toEqual([[`token-${UNVERIFIED}`, "654321"], [`token-${UNVERIFIED}`, "123456"]]);
    // Recorded as the address the caller proved, in their own partition (supply-checkout-ytr2)
    expect(table.get(`USER#${UNVERIFIED}`, "VERIFIED_EMAIL")).toEqual({
      PK: `USER#${UNVERIFIED}`,
      SK: "VERIFIED_EMAIL",
      type: "verifiedEmail",
      verifiedEmailHash: verifiedEmailHash("pat@example.com"),
      verifiedAt: new Date(now).toISOString(),
    });
    const me = (await call("GET", "/me", { user: UNVERIFIED })).body;
    expect(me.user).toEqual({ id: UNVERIFIED, email: "pat@example.com", emailVerified: true });
    expect(me.invites).toHaveLength(1);
    // Neither the code nor the token is logged
    expect(JSON.stringify(logs)).not.toMatch(/123456|654321|token-|pat@/);
  });

  it("answers 409 already_verified to a verified address, sending and checking nothing", async () => {
    for (const path of ["/me/email/code", "/me/email/verify"]) {
      expect(await call("POST", path, { user: PAT, body: path.endsWith("verify") ? { code: "123456" } : undefined }), path).toMatchObject({ status: 409, body: { error: { code: "aborted", reason: "already_verified" } } });
    }
    expect(codesSent).toEqual([]);
    expect(codesChecked).toEqual([]);
  });

  it("checks the request before calling Cognito", async () => {
    for (const body of [undefined, {}, { code: 123456 }, { code: "12345" }, { code: "1234567" }, { code: "12a456" }, { code: "123456", email: "x@example.com" }]) {
      expect((await call("POST", "/me/email/verify", { user: UNVERIFIED, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED, body: { email: "someone@example.com" } })).status).toBe(400);
    expect(codesSent).toEqual([]);
    expect(codesChecked).toEqual([]);
  });

  it("has nothing to verify for a user with no email", async () => {
    USERS["user-no-email"] = { sub: "user-no-email", emailVerified: false, emailVerifiedInCognito: false };
    try {
      expect(await call("POST", "/me/email/code", { user: "user-no-email" })).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    } finally {
      delete USERS["user-no-email"];
    }
    expect(codesSent).toEqual([]);
  });

  it("passes on Cognito's refusals and fails on anything else", async () => {
    codeFailure = new ApiError(429, "quota_exceeded", "Too many attempts; try again later");
    expect(await call("POST", "/me/email/code", { user: UNVERIFIED })).toMatchObject({ status: 429, body: { error: { code: "quota_exceeded" } } });
    codeFailure = undefined;
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED })).status).toBe(204);
    codeFailure = new Error("VerifyUserAttribute failed: 500 InternalErrorException");
    expect(await call("POST", "/me/email/verify", { user: UNVERIFIED, body: { code: "123456" } })).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
    cognitoDown = true;
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED })).status).toBe(500);
    // Each 5xx is counted for the Email codes failing alarm; a refusal (4xx) isn't
    expect(counts[BusinessMetric.EmailCodeVerifyFailures]).toBe(1);
    expect(counts[BusinessMetric.EmailCodeSendFailures]).toBe(1);
    // Another route's 5xx isn't an email code failure
    expect((await call("GET", "/me", { user: UNVERIFIED })).status).toBe(500);
    expect(counts[BusinessMetric.EmailCodeSendFailures]).toBe(1);
    expect(counts[BusinessMetric.EmailCodeVerifyFailures]).toBe(1);
  });

  it("limits how many codes a user asks for a day, in their own partition", async () => {
    for (let i = 0; i < EMAIL_CODES_PER_USER_PER_DAY; i++) expect((await call("POST", "/me/email/code", { user: UNVERIFIED })).status).toBe(204);
    expect(await call("POST", "/me/email/code", { user: UNVERIFIED })).toMatchObject({ status: 429, body: { error: { code: "quota_exceeded" } } });
    expect(codesSent).toHaveLength(EMAIL_CODES_PER_USER_PER_DAY);
    expect(table.get(`USER#${UNVERIFIED}`, `LIMIT#EMAILCODES#${new Date(now).toISOString().slice(0, 10)}`)).toMatchObject({ count: EMAIL_CODES_PER_USER_PER_DAY, type: "emailCodes" });
    expect(scopes.at(-1)).toEqual({ userId: UNVERIFIED });
    // The next day starts again
    now += DAY;
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED })).status).toBe(204);
  });

  // supply-checkout-cjw7: a code proves only the address it was sent to
  it("records the address the code went to, and a proof only for that address, once", async () => {
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED })).status).toBe(204);
    expect(table.get(`USER#${UNVERIFIED}`, "EMAIL_CODE_SENT")).toEqual({
      PK: `USER#${UNVERIFIED}`,
      SK: "EMAIL_CODE_SENT",
      type: "emailCodeSent",
      sentEmailHash: verifiedEmailHash("pat@example.com"),
      sentAt: new Date(now).toISOString(),
      expiresAt: Math.floor(now / 1000) + 2 * DAY / 1000,
    });
    expect((await call("POST", "/me/email/verify", { user: UNVERIFIED, body: { code: "123456" } })).status).toBe(204);
    // Used: gone, in the same transaction as the proof
    expect(table.get(`USER#${UNVERIFIED}`, "EMAIL_CODE_SENT")).toBeUndefined();
    expect(table.get(`USER#${UNVERIFIED}`, "VERIFIED_EMAIL")).toBeDefined();
  });

  it("refuses to check a code no code was sent for through the API, or one sent over a day ago, without asking Cognito", async () => {
    expect(await call("POST", "/me/email/verify", { user: UNVERIFIED, body: { code: "123456" } })).toMatchObject({ status: 409, body: { error: { code: "aborted", reason: "email_changed" } } });
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED })).status).toBe(204);
    now += DAY + 1;
    expect(await call("POST", "/me/email/verify", { user: UNVERIFIED, body: { code: "123456" } })).toMatchObject({ status: 409, body: { error: { reason: "email_changed" } } });
    expect(codesChecked).toEqual([]);
    expect(table.get(`USER#${UNVERIFIED}`, "VERIFIED_EMAIL")).toBeUndefined();
    // Neither the address nor the code is logged
    expect(JSON.stringify(logs)).not.toMatch(/123456|pat@/);
  });

  it("only for the token's own user", async () => {
    // The authorizer's user and the token's user differ: something is badly wrong
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED, claims: { sub: PAT, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER } })).status).toBe(401);
    expect(codesSent).toEqual([]);
  });
});

// supply-checkout-xv3k: MEMBER.email follows the address the user has verified now
describe("keeping members' email current", () => {
  const memberEmail = (team: string, user: string) => table.get(`TEAM#${team}`, `MEMBER#${user}`)?.email;
  const memberUpdates = () => table.calls.filter((c) => c.command === "UpdateCommand" && c.partitions.some((p) => p.startsWith("TEAM#")));
  /** `user` in `team` as `role`, with a switcher row, and the member item's email if given. */
  function join(team: string, user: string, role: "owner" | "contributor" | "viewer", email?: string) {
    table.put({ PK: `TEAM#${team}`, SK: `MEMBER#${user}`, type: "member", teamId: team, userId: user, role, ...(email ? { email } : {}) });
    table.put({ PK: `USER#${user}`, SK: `TEAM#${team}`, type: "userTeam", userId: user, teamId: team, teamName: team, role });
  }

  it("copies the verified address to the caller's member item in every team on /me, and writes nothing when it's current", async () => {
    table.seedTeam("team-b", { [OWNER]: "owner" });
    join("team-b", PAT, "viewer", "pat-old@example.com");
    table.put({ ...(table.get("TEAM#team-a", `MEMBER#${OWNER}`) as Record<string, unknown>), email: "owner-old@example.com" });
    expect((await call("GET", "/me", { user: PAT })).status).toBe(200);
    // Normalized, as createTeam and acceptInvite store it
    expect(memberEmail("team-a", PAT)).toBe("pat@example.com");
    expect(memberEmail("team-b", PAT)).toBe("pat@example.com");
    // Only the caller's own member items
    expect(memberEmail("team-a", OWNER)).toBe("owner-old@example.com");
    expect(memberEmail("team-b", OWNER)).toBeUndefined();
    expect(table.get("TEAM#team-a", `MEMBER#${PAT}`)).toMatchObject({ role: "contributor", type: "member", userId: PAT });
    const writes = memberUpdates().length;
    expect(writes).toBe(2);
    expect((await call("GET", "/me", { user: PAT })).status).toBe(200);
    expect(memberUpdates()).toHaveLength(writes);
    // And the owner's list shows it
    const listed = (await call("GET", "/teams/team-a/members")).body.members;
    expect(listed.find((m: { userId: string }) => m.userId === PAT).email).toBe("pat@example.com");
  });

  it("never stores an unverified address", async () => {
    join("team-a", UNVERIFIED, "viewer", "old@example.com");
    expect((await call("GET", "/me", { user: UNVERIFIED })).status).toBe(200);
    expect(memberEmail("team-a", UNVERIFIED)).toBe("old@example.com");
    expect(memberUpdates()).toEqual([]);
  });

  it("leaves closed teams and teams the caller was removed from as they are", async () => {
    table.seedTeam("team-closed", { [OWNER]: "owner" });
    table.put({ ...(table.get("TEAM#team-closed", "META") as Record<string, unknown>), closedAt: new Date(now).toISOString() });
    join("team-closed", PAT, "viewer", "pat-old@example.com");
    table.seedTeam("team-gone", { [OWNER]: "owner" });
    table.put({ PK: `USER#${PAT}`, SK: "TEAM#team-gone", type: "userTeam", userId: PAT, teamId: "team-gone", teamName: "team-gone", role: "viewer" });
    expect((await call("GET", "/me", { user: PAT })).status).toBe(200);
    expect(memberEmail("team-closed", PAT)).toBe("pat-old@example.com");
    expect(table.get("TEAM#team-gone", `MEMBER#${PAT}`)).toBeUndefined();
    expect(memberEmail("team-a", PAT)).toBe("pat@example.com");
  });

  it("updates every team's member item as soon as a new address is verified", async () => {
    join("team-a", UNVERIFIED, "viewer", "old@example.com");
    table.seedTeam("team-b", { [OWNER]: "owner" });
    join("team-b", UNVERIFIED, "owner");
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED })).status).toBe(204);
    expect((await call("POST", "/me/email/verify", { user: UNVERIFIED, body: { code: "123456" } })).status).toBe(204);
    expect(memberEmail("team-a", UNVERIFIED)).toBe("pat@example.com");
    expect(memberEmail("team-b", UNVERIFIED)).toBe("pat@example.com");
    // Each team's write on a session for that team only
    const teamScopes = scopes.filter((s) => s.userId === UNVERIFIED && s.teamId).map((s) => s.teamId);
    expect(new Set(teamScopes)).toEqual(new Set(["team-a", "team-b"]));
    expect(scopes.every((s) => s.userId === UNVERIFIED || s.userId === OWNER)).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(/pat@|old@/);
  });

  it("goes on when a member item can't be updated, logging only the team and the error's name", async () => {
    table.seedTeam("team-b", { [OWNER]: "owner" });
    join("team-b", PAT, "viewer", "pat-old@example.com");
    const original = table.scoped.bind(table);
    table.scoped = (partitions) => {
      const db = original(partitions);
      return fakeDb(async (command) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === "UpdateCommand" && String((command.input.Key as { PK?: string }).PK) === "TEAM#team-b") {
          throw Object.assign(new Error("Throughput exceeded"), { name: "ProvisionedThroughputExceededException" });
        }
        return connection(db).doc.send(command as never);
      });
    };
    const me = await handler(event("GET", "/me", { user: PAT }));
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body as string).teams).toHaveLength(2);
    expect(memberEmail("team-a", PAT)).toBe("pat@example.com");
    expect(memberEmail("team-b", PAT)).toBe("pat-old@example.com");
    expect(logs).toContainEqual(["Member email not updated", { teamId: "team-b", code: "ProvisionedThroughputExceededException" }]);
    expect(JSON.stringify(logs)).not.toMatch(/pat@|pat-old@/);
  });

  it("still verifies the address when the teams can't be listed", async () => {
    join("team-a", UNVERIFIED, "viewer", "old@example.com");
    expect((await call("POST", "/me/email/code", { user: UNVERIFIED })).status).toBe(204);
    const original = table.scoped.bind(table);
    table.scoped = (partitions) => {
      const db = original(partitions);
      return fakeDb(async (command) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        if (name === "QueryCommand") throw Object.assign(new Error("Service unavailable"), { name: "InternalServerError" });
        return connection(db).doc.send(command as never);
      });
    };
    expect((await call("POST", "/me/email/verify", { user: UNVERIFIED, body: { code: "123456" } })).status).toBe(204);
    expect(table.get(`USER#${UNVERIFIED}`, "VERIFIED_EMAIL")).toBeDefined();
    expect(memberEmail("team-a", UNVERIFIED)).toBe("old@example.com");
    expect(logs).toContainEqual(["Member emails not updated", { code: "InternalServerError" }]);
  });
});

describe("authentication", () => {
  it("requires an unexpired access token from our issuer, and a working Cognito", async () => {
    const claims = (over: Record<string, unknown>) => ({ sub: PAT, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER, ...over });
    for (const over of [{ token_use: "id" }, { exp: String(Math.floor(now / 1000) - 1) }, { iss: "https://cognito-idp.test-local-1.amazonaws.com/other" }, { sub: "bad sub" }]) {
      expect(await call("GET", "/me", { user: PAT, claims: claims(over) }), JSON.stringify(over)).toMatchObject({ status: 401, body: { error: { code: "unauthenticated" } } });
    }
    expect((await call("GET", "/me", { user: PAT, headers: { authorization: "" } })).status).toBe(401);
    expect((await call("GET", "/me", { user: "user-unknown" })).status).toBe(401);
    cognitoDown = true;
    expect(await call("GET", "/me", { user: PAT })).toMatchObject({ status: 500, body: { error: { code: "internal" } } });
    expect((await call("GET", "/nope")).status).toBe(404);
  });
});
