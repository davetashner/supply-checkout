// A team's invites through the account API, end to end: an owner invites an
// address, the email goes out with a single-use link, the invitee accepts it;
// owners list invites as pending, failed or expired, revoke and re-send them;
// invites are rate-limited per team and per address; removing a member
// revokes their other invites. Against the in-memory table, each request's
// handles scoped to the partitions its session tags allow (account-db.ts), as
// IAM would. test/roles.test.ts has the per-role matrix for these routes, and
// test/access-patterns.test.ts runs the data functions against DynamoDB Local.

import { beforeEach, describe, expect, it } from "vitest";
import type { AccountScope, DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import type { CognitoUser } from "../src/api/cognito-user.js";
import type { DataEvent } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { ACCOUNT_ROUTES, routeKey } from "../src/api/routes.js";
import { hashEmail, hashInviteToken, inviteLimitKey, INVITES_PER_ADDRESS_PER_DAY, INVITES_PER_TEAM_ADDRESS_PER_DAY, INVITES_PER_TEAM_PER_DAY, MEMBERS_PER_TRIAL_TEAM } from "../src/data/index.js";
import { INVITE_LIMIT_ATTRIBUTES } from "../src/data/schema.js";
import type { Observability } from "../src/observability/index.js";
import { accountPartitions, fakeMailer, unusedDeleteUser, unusedEmailCodes } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const START = Date.parse("2026-09-26T12:00:00Z");
const DAY = 86400_000;
const OWNER = "user-owner";
const CO_OWNER = "user-co-owner";
const SAM = "user-sam";
const PAT = "user-pat";
const OTHER_OWNER = "user-other-owner";

const USERS: Record<string, CognitoUser> = {
  [OWNER]: { sub: OWNER, email: "owner@example.com", emailVerified: true },
  [CO_OWNER]: { sub: CO_OWNER, email: "co-owner@example.com", emailVerified: true },
  [SAM]: { sub: SAM, email: "sam@example.com", emailVerified: true },
  [PAT]: { sub: PAT, email: "Pat@Example.com", emailVerified: true },
  [OTHER_OWNER]: { sub: OTHER_OWNER, email: "other@example.com", emailVerified: true },
};

let table: MemoryTable;
let now: number;
let scopes: AccountScope[];
let mails: ReturnType<typeof fakeMailer>;
let counts: [string, number, Record<string, unknown> | undefined][];
let logs: unknown[];
let handler: ReturnType<typeof createAccountHandler>;

function member(teamId: string, userId: string, role: string) {
  const email = USERS[userId]?.email?.toLowerCase();
  table.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#${userId}`, type: "member", teamId, userId, role, ...(email ? { email } : {}), joinedAt: "2026-09-01T00:00:00.000Z" });
  table.put({ PK: `USER#${userId}`, SK: `TEAM#${teamId}`, type: "userTeam", userId, teamId, teamName: teamId, role });
}

function team(teamId: string, name: string, members: Record<string, string>) {
  const owners = Object.values(members).filter((r) => r === "owner").length;
  table.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name, homeRegion: "test-local-1", owners, version: 1 });
  for (const [userId, role] of Object.entries(members)) member(teamId, userId, role);
}

beforeEach(() => {
  now = START;
  table = new MemoryTable();
  scopes = [];
  counts = [];
  logs = [];
  mails = fakeMailer();
  team("team-a", "Echo Cleaning", { [OWNER]: "owner", [CO_OWNER]: "owner", [SAM]: "contributor" });
  team("team-b", "Bravo Co", { [OTHER_OWNER]: "owner" });
  const dbFor: DbForAccount = (scope) => {
    scopes.push(scope);
    return table.scoped(accountPartitions(scope));
  };
  const record = (level: string) => (message: string, extra?: unknown) => logs.push([level, message, extra]);
  const obs = {
    region: "test-local-1",
    logger: { info: record("info"), warn: record("warn"), error: record("error"), addContext: () => {} },
    count: (metric: string, n: number, metadata?: Record<string, unknown>) => counts.push([metric, n, metadata]),
    flush: () => {},
  } as unknown as Observability;
  const userInfo = async (token: string) => {
    const user = USERS[token.replace(/^token-/, "")];
    if (!user) throw new ApiError(401, "unauthenticated", "Sign in again");
    return user;
  };
  handler = createAccountHandler({ dbFor, userInfo, issuerUrl: ISSUER, obs, mailer: mails.mailer, deleteUser: unusedDeleteUser, emailCodes: unusedEmailCodes, now: () => now });
});

function event(method: string, path: string, user: string, body?: unknown): DataEvent {
  const segments = path.split("/");
  const route = ACCOUNT_ROUTES.find((r) => {
    const parts = r.path.split("/");
    return r.method === method && parts.length === segments.length && parts.every((p, i) => p.startsWith("{") || p === segments[i]);
  });
  const pathParameters: Record<string, string> = {};
  route?.path.split("/").forEach((p, i) => {
    if (p.startsWith("{")) pathParameters[p.slice(1, -1)] = decodeURIComponent(segments[i] as string);
  });
  return {
    version: "2.0",
    routeKey: route ? routeKey(route) : `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: { authorization: `Bearer token-${user}` },
    pathParameters,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER }, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function call(method: string, path: string, user = OWNER, body?: unknown) {
  const response = await handler(event(method, path, user, body));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const invite = (email: string, role = "contributor", user = OWNER, teamId = "team-a") => call("POST", `/teams/${teamId}/invites`, user, { email, role });
const list = (user = OWNER, teamId = "team-a") => call("GET", `/teams/${teamId}/invites`, user);
const revoke = (id: string, user = OWNER, teamId = "team-a") => call("DELETE", `/teams/${teamId}/invites/${id}`, user);
const resend = (id: string, user = OWNER, teamId = "team-a", body?: unknown) => call("POST", `/teams/${teamId}/invites/${id}/resend`, user, body);
const accept = (id: string, token: string | undefined, user = PAT) => call("POST", `/invites/${id}/accept`, user, token === undefined ? undefined : { token });
/** The token in the latest invite email's link, as the invitee would click it. */
const lastLink = () => {
  const sent = mails.sent.at(-1);
  if (sent?.input.kind !== "invite") throw new Error("No invite email");
  return { to: sent.to, id: sent.input.inviteId, token: sent.input.token, tags: sent.tags, teamName: sent.input.teamName, role: sent.input.role };
};
const stored = (id: string, teamId = "team-a") => table.get(`TEAM#${teamId}`, `INVITE#${id}`);
const invitesIn = (teamId = "team-a") => [...table.items.values()].filter((i) => i.PK === `TEAM#${teamId}` && String(i.SK).startsWith("INVITE#"));

/** Every attribute a write names, as IAM's dynamodb:Attributes would see them. */
function attributesOf(body: Record<string, unknown>): string[] {
  const names = new Set(Object.keys((body.Key ?? body.Item ?? {}) as object));
  for (const n of Object.values((body.ExpressionAttributeNames ?? {}) as Record<string, string>)) names.add(n);
  const text = [body.UpdateExpression, body.ConditionExpression].filter(Boolean).join(" ");
  for (const [word] of text.matchAll(/(?<![#:\w])[A-Za-z_]\w*(?!\w*\s*\()/g)) if (!["SET", "ADD", "REMOVE", "DELETE", "AND", "OR", "NOT"].includes(word)) names.add(word);
  return [...names].sort();
}

/** Each write into a partition starting with `prefix`, as [kind, attributes, ReturnValues]. */
function writesTo(prefix: string) {
  return table.requests.flatMap((c) =>
    ((c.input.TransactItems as Record<string, Record<string, unknown>>[] | undefined) ?? [{ [c.command]: c.input }])
      .map((op) => Object.entries(op)[0] as [string, Record<string, unknown>])
      .filter(([kind]) => kind !== "GetCommand" && kind !== "QueryCommand" && kind !== "TransactGetCommand")
      .filter(([, body]) => String((body.Key as { PK?: string } | undefined)?.PK ?? (body.Item as { PK?: string } | undefined)?.PK ?? "").startsWith(prefix))
      .map(([kind, body]) => [kind, attributesOf(body), body.ReturnValues ?? "NONE"]),
  );
}

describe("POST /teams/{teamId}/invites", () => {
  it("makes an invite, emails its single-use link, and the invitee joins with it", async () => {
    const res = await invite(" Pat@Example.COM ", "contributor");
    expect(res.status).toBe(201);
    expect(res.body.invite).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      email: "pat@example.com",
      role: "contributor",
      createdAt: new Date(START).toISOString(),
      expiresAt: new Date(START + 7 * DAY).toISOString(),
      inviteStatus: "pending",
      failureReason: null,
      failedAt: null,
    });
    // One email, to the normalized address, tagged so a bounce finds this invite
    expect(mails.sent).toHaveLength(1);
    const link = lastLink();
    expect(link).toMatchObject({ to: "pat@example.com", id: res.body.invite.id, teamName: "Echo Cleaning", role: "contributor", tags: { teamId: "team-a", inviteId: res.body.invite.id } });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the token's hash is stored, and the response never has either
    const item = stored(res.body.invite.id);
    expect(item).toMatchObject({ GSI1PK: `INVITE#${hashInviteToken(link.token)}`, GSI2PK: `INVITEE#${hashEmail("pat@example.com")}`, invitedBy: OWNER, teamName: "Echo Cleaning" });
    expect(JSON.stringify(item)).not.toContain(link.token);
    expect(JSON.stringify(res.body)).not.toContain(link.token);
    expect(JSON.stringify(res.body)).not.toContain(hashInviteToken(link.token));
    expect(counts).toContainEqual(["InvitesSent", 1, { teamId: "team-a" }]);
    // No address or token in any log line
    expect(JSON.stringify(logs).toLowerCase()).not.toContain("example.com");
    expect(JSON.stringify(logs).toLowerCase()).not.toContain("pat@");
    expect(JSON.stringify(logs)).not.toContain(link.token);

    // Pat signs in with that address and accepts: they join with the role, once
    const joined = await accept(link.id, link.token);
    expect(joined).toMatchObject({ status: 200, body: { team: { id: "team-a", name: "Echo Cleaning", role: "contributor" } } });
    expect(table.get("TEAM#team-a", `MEMBER#${PAT}`)).toMatchObject({ role: "contributor", email: "pat@example.com" });
    expect(stored(link.id)).toBeUndefined();
    expect((await accept(link.id, link.token)).status).toBe(404);
    expect((await list()).body.invites).toEqual([]);
  });

  it("runs on the team's session plus the invited address's counter, and writes nothing else there", async () => {
    await invite("pat@example.com");
    expect(scopes).toContainEqual({ userId: OWNER, teamId: "team-a", inviteLimit: inviteLimitKey("pat@example.com") });
    // Only the create's own session has the counter's tag
    expect(scopes.filter((s) => s.inviteLimit !== undefined)).toHaveLength(1);
    // IAM allows only UpdateItem on the counter, naming only these attributes, returning nothing
    const counter = writesTo("INVITELIMIT#");
    expect(counter).toEqual([["Update", [...INVITE_LIMIT_ATTRIBUTES].sort(), "NONE"]]);
    expect(table.get(`INVITELIMIT#${inviteLimitKey("pat@example.com")}`, "LIMIT#INVITES#2026-09-26")).toMatchObject({ count: 1, expiresAt: START / 1000 + 2 * 86400 });
    expect(table.get("TEAM#team-a", `LIMIT#INVITES#2026-09-26#${inviteLimitKey("pat@example.com")}`)).toMatchObject({ count: 1 });
    expect(table.get("TEAM#team-a", "LIMIT#INVITES#2026-09-26")).toMatchObject({ count: 1 });
  });

  it("keeps an invite whose email SES won't send, marked failed, for the owner to re-send", async () => {
    mails.state.fail = "SendingPausedException";
    const res = await invite("pat@example.com");
    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({ inviteStatus: "failed", failureReason: "not_sent", failedAt: new Date(START).toISOString() });
    expect(stored(res.body.invite.id)).toMatchObject({ inviteStatus: "failed", failureReason: "not_sent" });
    expect(counts).toContainEqual(["InvitesFailed", 1, { teamId: "team-a", reason: "not_sent" }]);
    expect(counts.find(([m]) => m === "InvitesSent")).toBeUndefined();
    expect(logs).toContainEqual(["warn", "Invite email not sent", { teamId: "team-a", inviteId: res.body.invite.id, code: "SendingPausedException" }]);
    expect(JSON.stringify(logs)).not.toContain("example.com");
    expect((await list()).body.invites).toMatchObject([{ id: res.body.invite.id, inviteStatus: "failed", failureReason: "not_sent" }]);

    // SES is back: re-sending clears the failure
    mails.state.fail = undefined;
    const again = await resend(res.body.invite.id);
    expect(again.body.invite).toMatchObject({ inviteStatus: "pending", failureReason: null, failedAt: null });
  });

  it("counts any mailer error as not sent, logging only its name", async () => {
    const broken = createAccountHandler({
      dbFor: (scope) => table.scoped(accountPartitions(scope)),
      userInfo: async () => USERS[OWNER] as CognitoUser,
      issuerUrl: ISSUER,
      obs: { region: "x", logger: { info: () => {}, warn: (m: string, e: unknown) => logs.push(["warn", m, e]), error: () => {} }, count: () => {}, flush: () => {} } as unknown as Observability,
      emailCodes: unusedEmailCodes,
      mailer: { send: () => Promise.reject(Object.assign(new Error("to pat@example.com"), { name: "TypeError" })) },
      deleteUser: unusedDeleteUser,
      now: () => now,
    });
    const response = await broken(event("POST", "/teams/team-a/invites", OWNER, { email: "pat@example.com", role: "viewer" }));
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body as string).invite).toMatchObject({ inviteStatus: "failed", failureReason: "not_sent" });
    expect(logs).toContainEqual(["warn", "Invite email not sent", expect.objectContaining({ code: "TypeError" })]);
    expect(JSON.stringify(logs)).not.toContain("pat@");
    const nameless = createAccountHandler({
      dbFor: (scope) => table.scoped(accountPartitions(scope)),
      userInfo: async () => USERS[OWNER] as CognitoUser,
      issuerUrl: ISSUER,
      obs: { region: "x", logger: { info: () => {}, warn: (m: string, e: unknown) => logs.push(["warn", m, e]), error: () => {} }, count: () => {}, flush: () => {} } as unknown as Observability,
      emailCodes: unusedEmailCodes,
      mailer: { send: () => Promise.reject(null) },
      deleteUser: unusedDeleteUser,
      now: () => now,
    });
    await nameless(event("POST", "/teams/team-a/invites", OWNER, { email: "quinn@example.com", role: "viewer" }));
    expect(logs).toContainEqual(["warn", "Invite email not sent", expect.objectContaining({ code: "Unknown" })]);
  });

  it("refuses a member's address, and a second live invite to the same address", async () => {
    expect(await invite("SAM@example.com")).toMatchObject({ status: 409, body: { error: { code: "aborted", message: "They're already a member of this team" } } });
    expect((await invite("pat@example.com")).status).toBe(201);
    expect(await invite("pat@example.com", "viewer")).toMatchObject({ status: 409, body: { error: { code: "aborted", message: expect.stringContaining("Resend it instead") } } });
    // Another team may invite them too
    expect((await invite("pat@example.com", "viewer", OTHER_OWNER, "team-b")).status).toBe(201);
    // Once the first has expired, a new one is fine
    now += 8 * DAY;
    expect((await invite("pat@example.com")).status).toBe(201);
    expect(mails.sent).toHaveLength(3);
  });

  it("checks the body: an address, a role, and nothing else", async () => {
    for (const body of [
      { email: "not-an-address", role: "viewer" },
      { email: "pat@example.com", role: "system" },
      { email: "pat@example.com", role: "admin" },
      { email: 42, role: "viewer" },
      { email: "pat@example.com" },
      { role: "viewer" },
      { email: "pat@example.com", role: "viewer", teamName: "Evil Co" },
      { email: "pat@example.com", role: "viewer", ttlDays: 30 },
      { email: `${"x".repeat(250)}@example.com`, role: "viewer" },
      // Only a bare addr-spec: anything SES would read as a display name, a list or a quoted part
      { email: "x<v@example.com>", role: "viewer" },
      { email: "Mallory <v@example.com>", role: "viewer" },
      { email: '"a"@b.com', role: "viewer" },
      { email: "a,b@c.com", role: "viewer" }, // public-safety: allow (deliberate test addresses)
      { email: "a@b", role: "viewer" },
      { email: "a@b.com;v@example.com", role: "viewer" }, // public-safety: allow (deliberate test addresses)
      { email: `${"x".repeat(65)}@example.com`, role: "viewer" },
      { email: "pät@example.com", role: "viewer" },
    ]) {
      expect((await call("POST", "/teams/team-a/invites", OWNER, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("POST", "/teams/team-a/invites", OWNER, "not json")).status).toBe(400);
    expect(mails.sent).toEqual([]);
    expect(invitesIn()).toEqual([]);
  });

  it("names the team as stored, never as sent", async () => {
    await invite("pat@example.com");
    expect(lastLink().teamName).toBe("Echo Cleaning");
  });
});

describe("member cap", () => {
  const FULL = { code: "quota_exceeded", reason: "team_full" };

  it(`refuses an invite once members and live invites fill a trial team's ${MEMBERS_PER_TRIAL_TEAM} places`, async () => {
    // Three members already
    for (let i = 0; i < MEMBERS_PER_TRIAL_TEAM - 3; i++) expect((await invite(`crew${i}@example.com`)).status).toBe(201);
    const refused = await invite("one-too-many@example.com");
    expect(refused).toMatchObject({ status: 429, body: { error: FULL } });
    expect(refused.body.error.message).toContain(`${MEMBERS_PER_TRIAL_TEAM} members`);
    expect(mails.sent).toHaveLength(MEMBERS_PER_TRIAL_TEAM - 3);
    // Revoking one makes room; an expired one doesn't count
    await revoke(lastLink().id);
    expect((await invite("one-too-many@example.com")).status).toBe(201);
    now += 8 * DAY;
    expect((await invite("next-week@example.com")).status).toBe(201);
  });

  it("refuses to let someone join a full team, and keeps their invite", async () => {
    await invite("pat@example.com");
    const link = lastLink();
    // Others joined meanwhile: the team's count is at its cap
    table.put({ ...table.get("TEAM#team-a", "META"), members: MEMBERS_PER_TRIAL_TEAM });
    const res = await accept(link.id, link.token);
    expect(res).toMatchObject({ status: 429, body: { error: FULL } });
    expect(table.get("TEAM#team-a", `MEMBER#${PAT}`)).toBeUndefined();
    expect(table.get(`USER#${PAT}`, "TEAM#team-a")).toBeUndefined();
    expect(stored(link.id)).toBeDefined();
    // Room again: the same link works, and the count moves with the membership
    table.put({ ...table.get("TEAM#team-a", "META"), members: MEMBERS_PER_TRIAL_TEAM - 1 });
    expect((await accept(link.id, link.token)).status).toBe(200);
    expect(table.get("TEAM#team-a", "META")?.members).toBe(MEMBERS_PER_TRIAL_TEAM);
  });

  it("counts a team from before the member count on its next change", async () => {
    expect(table.get("TEAM#team-a", "META")?.members).toBeUndefined();
    await invite("pat@example.com");
    const link = lastLink();
    expect((await accept(link.id, link.token)).status).toBe(200);
    expect(table.get("TEAM#team-a", "META")?.members).toBe(4);
    expect((await call("DELETE", `/teams/team-a/members/${PAT}`, PAT)).status).toBe(204);
    expect(table.get("TEAM#team-a", "META")?.members).toBe(3);
  });
});

describe("rate limits", () => {
  it(`lets a team send ${INVITES_PER_TEAM_PER_DAY} invites a day, re-sends included`, async () => {
    // A paying team: a trial team's member cap is below the day's invite limit
    table.put({ ...table.get("TEAM#team-a", "META"), status: "active" });
    for (let i = 0; i < INVITES_PER_TEAM_PER_DAY - 1; i++) expect((await invite(`crew${i}@example.com`)).status).toBe(201);
    const last = await invite("last@example.com");
    expect(last.status).toBe(201);
    const refused = await resend(last.body.invite.id);
    expect(refused).toMatchObject({ status: 429, body: { error: { code: "quota_exceeded", message: "You've sent as many invites as you can for now. Try again tomorrow." } } });
    expect((await invite("one-more@example.com")).status).toBe(429);
    // Nothing was written or sent for the refused ones, and the re-sent invite is untouched
    expect(invitesIn()).toHaveLength(INVITES_PER_TEAM_PER_DAY);
    expect(stored(last.body.invite.id)).toBeDefined();
    expect(mails.sent).toHaveLength(INVITES_PER_TEAM_PER_DAY);
    // Another team isn't affected, and tomorrow (UTC) is a new day
    expect((await invite("one-more@example.com", "viewer", OTHER_OWNER, "team-b")).status).toBe(201);
    now += DAY;
    expect((await invite("one-more@example.com")).status).toBe(201);
  });

  it(`lets one team send one address ${INVITES_PER_TEAM_ADDRESS_PER_DAY} invites a day, so it can't use up other teams' allowance`, async () => {
    let id = (await invite("pat@example.com")).body.invite.id as string;
    for (let i = 1; i < INVITES_PER_TEAM_ADDRESS_PER_DAY; i++) id = (await resend(id)).body.invite.id;
    expect(await resend(id)).toMatchObject({ status: 429, body: { error: { code: "quota_exceeded", message: "You've sent as many invites as you can for now. Try again tomorrow." } } });
    expect(stored(id)).toBeDefined();
    // Another team can still invite them
    expect((await invite("pat@example.com", "viewer", OTHER_OWNER, "team-b")).status).toBe(201);
    now += DAY;
    expect((await resend(id)).status).toBe(201);
  });

  it(`sends one address at most ${INVITES_PER_ADDRESS_PER_DAY} invites a day, from every team together`, async () => {
    // Enough teams, each at its own cap for the address, to reach the address's cap
    const teams = Array.from({ length: INVITES_PER_ADDRESS_PER_DAY / INVITES_PER_TEAM_ADDRESS_PER_DAY }, (_, i) => `team-flood-${i}`);
    for (const teamId of teams) {
      team(teamId, teamId, { [OWNER]: "owner" });
      let id = (await invite("pat@example.com", "viewer", OWNER, teamId)).body.invite.id as string;
      for (let i = 1; i < INVITES_PER_TEAM_ADDRESS_PER_DAY; i++) id = (await resend(id, OWNER, teamId)).body.invite.id;
    }
    expect(mails.sent).toHaveLength(INVITES_PER_ADDRESS_PER_DAY);
    // Another team is refused, with the same message
    const elsewhere = await invite("PAT@example.com", "viewer", OTHER_OWNER, "team-b");
    expect(elsewhere).toMatchObject({ status: 429, body: { error: { code: "quota_exceeded", message: "You've sent as many invites as you can for now. Try again tomorrow." } } });
    expect(invitesIn("team-b")).toEqual([]);
    // Other addresses still go, and tomorrow is a new day
    expect((await invite("quinn@example.com", "viewer", OTHER_OWNER, "team-b")).status).toBe(201);
    now += DAY;
    expect((await invite("pat@example.com", "viewer", OTHER_OWNER, "team-b")).status).toBe(201);
  });

  it("counts +tags, and dots in a Gmail address, as the same mailbox", async () => {
    // Each is a new invite with its own address, but one mailbox's limit
    for (const [i, email] of ["pat.lee@gmail.com", "patlee+1@gmail.com", "p.a.t.l.e.e+x@googlemail.com"].entries()) { // public-safety: allow (deliberate test addresses)
      expect((await invite(email)).status, email).toBe(201);
      expect(stored((mails.sent.at(-1)?.tags.inviteId) as string)).toMatchObject({ email });
      expect(i).toBeLessThan(INVITES_PER_TEAM_ADDRESS_PER_DAY);
    }
    expect((await invite("PatLee+2@Gmail.com")).status).toBe(429); // public-safety: allow (deliberate test addresses)
    const key = inviteLimitKey("patlee@gmail.com"); // public-safety: allow (deliberate test addresses)
    expect(table.get(`INVITELIMIT#${key}`, "LIMIT#INVITES#2026-09-26")).toMatchObject({ count: INVITES_PER_TEAM_ADDRESS_PER_DAY });
    expect(scopes.filter((s) => s.inviteLimit !== undefined).every((s) => s.inviteLimit === key)).toBe(true);
    // Elsewhere, only the +tag goes, and dots count
    expect(inviteLimitKey("a.b+c@example.com")).toBe(inviteLimitKey("a.b@example.com"));
    expect(inviteLimitKey("a.b@example.com")).not.toBe(inviteLimitKey("ab@example.com"));
    expect(inviteLimitKey("+x@example.com")).not.toBe(inviteLimitKey("x@example.com"));
  });
});

describe("GET /teams/{teamId}/invites", () => {
  it("shows each invite as pending, failed (with why) or expired, newest first, without its token", async () => {
    const bounced = (await invite("bounced@example.com")).body.invite.id as string;
    now += 1000;
    const complained = (await invite("spam@example.com", "viewer")).body.invite.id as string;
    now += 1000;
    const pending = (await invite("pat@example.com", "owner")).body.invite.id as string;
    // What the email-events handler records for SES's reports
    table.put({ ...stored(bounced), inviteStatus: "failed", failureReason: "bounced", failedAt: "2026-09-26T12:05:00.000Z" });
    table.put({ ...stored(complained), inviteStatus: "failed", failureReason: "complained", failedAt: "2026-09-26T12:06:00.000Z" });
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.invites.map((i: { id: string }) => i.id)).toEqual([pending, complained, bounced]);
    expect(body.invites).toEqual([
      expect.objectContaining({ email: "pat@example.com", role: "owner", inviteStatus: "pending", failureReason: null, failedAt: null }),
      expect.objectContaining({ email: "spam@example.com", inviteStatus: "failed", failureReason: "complained", failedAt: "2026-09-26T12:06:00.000Z" }),
      expect.objectContaining({ email: "bounced@example.com", inviteStatus: "failed", failureReason: "bounced" }),
    ]);
    for (const i of body.invites) expect(Object.keys(i).sort()).toEqual(["createdAt", "email", "expiresAt", "failedAt", "failureReason", "id", "inviteStatus", "role"]);
    // After 7 days the pending one is expired (TTL removes it later), and a failed one stays failed
    now = START + 7 * DAY + 5000;
    expect((await list()).body.invites.map((i: { inviteStatus: string }) => i.inviteStatus)).toEqual(["expired", "failed", "failed"]);
    // An item that says it failed without saying why still reads as failed
    table.put({ ...stored(bounced), failureReason: undefined, failedAt: undefined });
    expect((await list()).body.invites.at(-1)).toMatchObject({ inviteStatus: "failed", failureReason: null, failedAt: null });
  });

  it("lists only the path's team's invites", async () => {
    await invite("pat@example.com");
    await invite("quinn@example.com", "viewer", OTHER_OWNER, "team-b");
    expect((await list()).body.invites.map((i: { email: string }) => i.email)).toEqual(["pat@example.com"]);
    expect((await list(OTHER_OWNER, "team-b")).body.invites.map((i: { email: string }) => i.email)).toEqual(["quinn@example.com"]);
    // Another team's owner gets the same 403 as anyone outside
    expect(await list(OTHER_OWNER)).toMatchObject({ status: 403, body: { error: { reason: "not_member" } } });
  });
});

describe("DELETE /teams/{teamId}/invites/{inviteId}", () => {
  it("revokes an invite, so its link no longer works", async () => {
    await invite("pat@example.com");
    const link = lastLink();
    expect((await revoke(link.id)).status).toBe(204);
    expect(stored(link.id)).toBeUndefined();
    expect(await accept(link.id, link.token)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(table.get("TEAM#team-a", `MEMBER#${PAT}`)).toBeUndefined();
    // Again, or an unknown ID: nothing to do
    expect((await revoke(link.id)).status).toBe(204);
    expect((await revoke("no-such-invite")).status).toBe(204);
    expect((await revoke("bad#id")).status).toBe(400);
  });

  it("reaches only an invite: another item's key can't be named", async () => {
    // The ID is validated before a key is built, so "MEMBER#x" can't be reached
    expect((await revoke(encodeURIComponent(`x#MEMBER#${SAM}`))).status).toBe(400);
    expect(table.get("TEAM#team-a", `MEMBER#${SAM}`)).toBeDefined();
  });

  it("can't revoke another team's invite", async () => {
    await invite("quinn@example.com", "viewer", OTHER_OWNER, "team-b");
    const link = lastLink();
    // By path: the owner of team-a naming team-b isn't a member there
    expect((await revoke(link.id, OWNER, "team-b")).status).toBe(403);
    // By ID under their own team: it's not in their partition, so nothing happens
    expect((await revoke(link.id)).status).toBe(204);
    expect(stored(link.id, "team-b")).toBeDefined();
  });
});

describe("POST /teams/{teamId}/invites/{inviteId}/resend", () => {
  it("replaces the invite with a new link and expiry, clearing any failure; the old link stops working", async () => {
    await invite("pat@example.com", "viewer");
    const old = lastLink();
    table.put({ ...stored(old.id), inviteStatus: "failed", failureReason: "bounced", failedAt: "2026-09-26T12:01:00.000Z" });
    now += 3 * DAY;
    const res = await resend(old.id);
    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({ email: "pat@example.com", role: "viewer", inviteStatus: "pending", failureReason: null, failedAt: null, expiresAt: new Date(now + 7 * DAY).toISOString() });
    expect(res.body.invite.id).not.toBe(old.id);
    const fresh = lastLink();
    expect(fresh).toMatchObject({ to: "pat@example.com", id: res.body.invite.id, tags: { teamId: "team-a", inviteId: res.body.invite.id } });
    expect(fresh.token).not.toBe(old.token);
    // One invite for the address, with none of the old failure fields
    expect(stored(old.id)).toBeUndefined();
    expect(invitesIn()).toHaveLength(1);
    const item = stored(res.body.invite.id);
    expect(item).not.toHaveProperty("inviteStatus");
    expect(item).not.toHaveProperty("failureReason");
    expect(item).not.toHaveProperty("failedAt");
    expect(counts.filter(([m]) => m === "InvitesSent")).toHaveLength(2);
    // The old link is dead; the new one works
    expect((await accept(old.id, old.token)).status).toBe(404);
    expect((await accept(fresh.id, old.token)).status).toBe(404);
    expect((await accept(fresh.id, fresh.token)).status).toBe(200);
  });

  it("re-sends an expired invite", async () => {
    await invite("pat@example.com");
    const old = lastLink();
    now += 8 * DAY;
    expect((await accept(old.id, old.token)).status).toBe(404);
    const res = await resend(old.id);
    expect(res.body.invite.inviteStatus).toBe("pending");
    expect((await accept(lastLink().id, lastLink().token)).status).toBe(200);
  });

  it("is 404 for an invite that was accepted or revoked, and takes no body", async () => {
    await invite("pat@example.com");
    const link = lastLink();
    expect((await resend(link.id, OWNER, "team-a", { email: "mallory@example.com" })).status).toBe(400);
    expect((await resend(link.id, OWNER, "team-a", {})).status).toBe(201);
    const current = lastLink();
    await revoke(current.id);
    expect(await resend(current.id)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(await resend("no-such-invite")).toMatchObject({ status: 404 });
    // Nothing else was sent to anyone
    expect(mails.sent.map((m) => m.to)).toEqual(["pat@example.com", "pat@example.com"]);
  });

  it("can't re-send another team's invite", async () => {
    await invite("quinn@example.com", "viewer", OTHER_OWNER, "team-b");
    const link = lastLink();
    expect((await resend(link.id)).status).toBe(404);
    expect((await resend(link.id, OWNER, "team-b")).status).toBe(403);
    expect(mails.sent).toHaveLength(1);
  });

  it("loses cleanly to an accept that lands first", async () => {
    await invite("pat@example.com");
    const link = lastLink();
    // Pat accepts between the owner's read and the replacing transaction
    let raced = false;
    table.beforeTransactWrite = () => {
      if (raced) return;
      raced = true;
      table.items.delete(`TEAM#team-a\u0000INVITE#${link.id}`);
    };
    expect(await resend(link.id)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    table.beforeTransactWrite = undefined;
    expect(invitesIn()).toEqual([]);
    expect(mails.sent).toHaveLength(1);
  });
});

describe("removing a member", () => {
  /** An unused invite to team-a for an address, as if made before they joined. */
  function staleInvite(email: string, id: string) {
    table.put({
      PK: "TEAM#team-a",
      SK: `INVITE#${id}`,
      GSI1PK: `INVITE#${hashInviteToken(`token-${id}-${"x".repeat(20)}`)}`,
      GSI1SK: "INVITE",
      GSI2PK: `INVITEE#${hashEmail(email)}`,
      GSI2SK: `INVITE#${id}`,
      type: "invite",
      teamId: "team-a",
      teamName: "Echo Cleaning",
      inviteId: id,
      email,
      role: "owner",
      invitedBy: OWNER,
      createdAt: new Date(START).toISOString(),
      expiresAt: START / 1000 + 7 * 86400,
    });
  }

  it("revokes their other pending invites, so they can't rejoin with one", async () => {
    staleInvite("sam@example.com", "sam-second");
    staleInvite("sam@example.com", "sam-third");
    await invite("pat@example.com");
    expect((await call("DELETE", `/teams/team-a/members/${SAM}`)).status).toBe(204);
    expect(stored("sam-second")).toBeUndefined();
    expect(stored("sam-third")).toBeUndefined();
    // Other people's invites stay
    expect(invitesIn().map((i) => i.email)).toEqual(["pat@example.com"]);
    // Sam's old link no longer gets them back in
    const rejoin = await handler(event("POST", "/invites/sam-second/accept", SAM, { token: `token-sam-second-${"x".repeat(20)}` }));
    expect(rejoin.statusCode).toBe(404);
    expect(table.get("TEAM#team-a", `MEMBER#${SAM}`)).toBeUndefined();
  });

  it("revokes them when someone leaves, too", async () => {
    staleInvite("sam@example.com", "sam-second");
    expect((await call("DELETE", `/teams/team-a/members/${SAM}`, SAM)).status).toBe(204);
    expect(stored("sam-second")).toBeUndefined();
  });

  it("leaves invites alone for a member without an address", async () => {
    table.put({ PK: "TEAM#team-a", SK: "MEMBER#user-anon", type: "member", teamId: "team-a", userId: "user-anon", role: "viewer", joinedAt: "2026-09-01T00:00:00.000Z" });
    staleInvite("pat@example.com", "pat-1");
    expect((await call("DELETE", "/teams/team-a/members/user-anon")).status).toBe(204);
    expect(stored("pat-1")).toBeDefined();
  });
});

describe("expiry", () => {
  it("accepts up to 7 days after the invite, and not after", async () => {
    await invite("pat@example.com");
    const link = lastLink();
    now = START + 7 * DAY;
    expect((await accept(link.id, link.token)).status).toBe(404);
    now = START + 7 * DAY - 1000;
    expect((await accept(link.id, link.token)).status).toBe(200);
  });
});
