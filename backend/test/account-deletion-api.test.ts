// Closing a team, deleting an account and purging closed teams (bead
// supply-checkout-b1h), through the account and data handlers against the
// in-memory table. Each request's handles reach only the partitions its
// session tags allow, as IAM would (account-db.ts). test/closing.test.ts runs
// the same data functions against DynamoDB Local.

import { beforeEach, describe, expect, it } from "vitest";
import type { AccountScope, DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import type { CognitoUser } from "../src/api/cognito-user.js";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { ACCOUNT_ROUTES, DATA_ROUTES, routeKey } from "../src/api/routes.js";
import { authorizeTeam, CLOSED_TEAM_RETENTION_DAYS, createInvite, hashEmail, liveUpdateRecipients, purgeTeam, recordReceiptRead, startAccountDeletion, TeamClosedError, updateTeam } from "../src/data/index.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { PURGE_BUDGET_MS } from "../src/ops/names.js";
import { createTeamPurgeHandler } from "../src/ops/team-purge-handler.js";
import { TEAM_PURGE_ATTRIBUTES, TEAM_PURGE_MARK_ATTRIBUTES } from "../src/data/schema.js";
import { REGION, accountPartitions, fakeDb, fakeMailer, unusedEmailCodes } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";
import { connection } from "../src/data/client.js";
import { EmailNotSentError, type Mailer } from "../src/email/mailer.js";
import type { EmailInput } from "../src/email/templates.js";

const mails = fakeMailer();
const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const DAY = 86400_000;
const NOW = Date.parse("2026-09-26T12:00:00Z");
const OWNER = "user-owner";
const CO_OWNER = "user-co-owner";
const PAT = "user-pat";
const VIEWER = "user-viewer";
const SOLO = "user-solo";

const USERS: Record<string, CognitoUser> = {
  [OWNER]: { sub: OWNER, email: "owner@example.com", emailVerified: true, emailVerifiedInCognito: true },
  [CO_OWNER]: { sub: CO_OWNER, email: "co@example.com", emailVerified: true, emailVerifiedInCognito: true },
  [PAT]: { sub: PAT, email: "pat@example.com", emailVerified: true, emailVerifiedInCognito: true },
  [VIEWER]: { sub: VIEWER, email: "viewer@example.com", emailVerified: false, emailVerifiedInCognito: false },
  [SOLO]: { sub: SOLO, email: "solo@example.com", emailVerified: true, emailVerifiedInCognito: true },
};

let table: MemoryTable;
let now: number;
let scopes: AccountScope[];
let counts: Record<string, number>;
let gauges: Record<string, number>;
let logs: [string, string, unknown][];
let deleted: string[];
let deleteFails: boolean;
// Closure emails, per recipient: SES refuses the addresses in `refuse`
let notices: { to: string; input: EmailInput; teamId?: string }[];
let refuse: Set<string>;
// The owners of a team that just closed can't be listed
let memberListFails: boolean;
let accountHandler: ReturnType<typeof createAccountHandler>;
let dataHandler: ReturnType<typeof createDataHandler>;

function observability(): Observability {
  const log = (level: string) => (message: string, data?: unknown) => logs.push([level, message, data]);
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1) => {
      counts[metric] = (counts[metric] ?? 0) + value;
    },
    gauge: (metric, value) => {
      gauges[metric] = value;
    },
    flush: () => {},
  };
}

function member(teamId: string, userId: string, role: string) {
  table.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#${userId}`, type: "member", teamId, userId, role, email: USERS[userId]?.email?.toLowerCase(), joinedAt: "2026-09-01T00:00:00.000Z" });
  table.put({ PK: `USER#${userId}`, SK: `TEAM#${teamId}`, type: "userTeam", userId, teamId, teamName: `Team ${teamId}`, role });
}

function team(teamId: string, members: Record<string, string>, extra: Record<string, unknown> = {}) {
  const owners = Object.values(members).filter((r) => r === "owner").length;
  table.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: `Team ${teamId}`, homeRegion: REGION, status: "trialing", owners, members: Object.keys(members).length, version: 1, ...extra });
  for (const [userId, role] of Object.entries(members)) member(teamId, userId, role);
}

function invite(teamId: string, inviteId: string, email: string, expiresAt = NOW / 1000 + DAY / 1000) {
  table.put({
    PK: `TEAM#${teamId}`,
    SK: `INVITE#${inviteId}`,
    GSI1PK: `INVITE#${inviteId.padEnd(64, "0").slice(0, 64)}`,
    GSI1SK: "INVITE",
    GSI2PK: `INVITEE#${hashEmail(email)}`,
    GSI2SK: `INVITE#${inviteId}`,
    type: "invite",
    teamId,
    teamName: `Team ${teamId}`,
    inviteId,
    email,
    role: "viewer",
    invitedBy: OWNER,
    createdAt: "2026-09-25T12:00:00.000Z",
    expiresAt,
  });
}

beforeEach(() => {
  now = NOW;
  scopes = [];
  counts = {};
  logs = [];
  gauges = {};
  deleted = [];
  deleteFails = false;
  notices = [];
  refuse = new Set();
  memberListFails = false;
  table = new MemoryTable();
  // team-a: an owner, a contributor and a viewer; team-b: two owners and Pat
  team("team-a", { [OWNER]: "owner", [PAT]: "contributor", [VIEWER]: "viewer" });
  team("team-b", { [OWNER]: "owner", [CO_OWNER]: "owner", [PAT]: "viewer" });
  table.put({ PK: "TEAM#team-a", SK: "PRODUCT#0123", type: "product", key: "0123", version: 3, code: "0123", name: "Nitrile gloves", price: 12.5, stock: 10 });
  table.put({ PK: "TEAM#team-a", SK: "SHEET#s1", GSI1PK: "TEAM#team-a#SHEETS", GSI1SK: "2026-09-26#s1", type: "sheet", id: "s1", version: 1, client: "Echo", date: "2026-09-26", status: "open", items: {} });
  invite("team-a", "inv-a1", "newbie@example.com");
  const dbFor: DbForAccount = (scope) => {
    scopes.push(scope);
    const db = table.scoped(accountPartitions(scope));
    if (!memberListFails) return db;
    return fakeDb(async (command) => {
      if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes('"MEMBER#')) throw Object.assign(new Error("Throttled"), { name: "ThrottlingException" });
      return connection(db).doc.send(command as never);
    });
  };
  const userInfo = async (token: string) => {
    const user = USERS[token.replace(/^token-/, "")];
    if (!user || deleted.includes(user.sub)) throw new ApiError(401, "unauthenticated", "Sign in again");
    return user;
  };
  const deleteUser = async (token: string) => {
    if (deleteFails) throw new Error("DeleteUser failed: 500");
    deleted.push(token.replace(/^token-/, ""));
  };
  const obs = observability();
  // Invite emails go to the shared fake; closure notices are recorded here, one per recipient
  const mailer: Mailer = {
    async send(to, input, tags = {}) {
      if (input.kind !== "teamClosed") return mails.mailer.send(to, input, tags);
      if (refuse.has(to)) throw new EmailNotSentError("MessageRejected");
      notices.push({ to, input, teamId: tags.teamId });
      return { messageId: `notice-${notices.length}` };
    },
  };
  accountHandler = createAccountHandler({ dbFor, userInfo, issuerUrl: ISSUER, obs, mailer, emailCodes: unusedEmailCodes, deleteUser, now: () => now });
  dataHandler = createDataHandler({ dbForTeam: (teamId) => table.db(teamId), obs, now: () => now });
});

function event(routes: readonly { method: string; path: string }[], method: string, path: string, user: string, body?: unknown, query?: Record<string, string>): DataEvent {
  const segments = path.split("/");
  const route = routes.find((r) => {
    const parts = r.path.split("/");
    return r.method === method && parts.length === segments.length && parts.every((p, i) => p.startsWith("{") || p === segments[i]);
  });
  const pathParameters: Record<string, string> = {};
  route?.path.split("/").forEach((p, i) => {
    if (p.startsWith("{")) pathParameters[p.slice(1, -1)] = segments[i] as string;
  });
  return {
    version: "2.0",
    routeKey: route ? routeKey(route) : `${method} ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: { authorization: `Bearer token-${user}` },
    queryStringParameters: query,
    pathParameters,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER }, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function call(method: string, path: string, user = OWNER, body?: unknown) {
  const response = await accountHandler(event(ACCOUNT_ROUTES, method, path, user, body));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

async function data(method: string, path: string, user = OWNER, body?: unknown, query?: Record<string, string>) {
  const response = await dataHandler(event(DATA_ROUTES, method, path, user, body, query));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const close = (teamId = "team-a", name: unknown = `Team ${teamId}`, user = OWNER) => call("POST", `/teams/${teamId}/close`, user, { name });
const deleteAccount = (user: string, confirm: unknown = "DELETE") => call("DELETE", "/me", user, { confirm });
const meta = (teamId = "team-a") => table.get(`TEAM#${teamId}`, "META");
const partition = (pk: string) => [...table.items.values()].filter((i) => i.PK === pk);
const audits = (teamId: string) => partition(`TEAM#${teamId}`).filter((i) => String(i.SK).startsWith("AUDIT#"));

describe("closing a team", () => {
  it("makes it read-only, deletes its invites, audits it and says when it'll be deleted", async () => {
    const { status, body } = await close("team-a", "  team TEAM-A ");
    expect(status).toBe(200);
    const deletesAt = new Date(NOW + CLOSED_TEAM_RETENTION_DAYS * DAY).toISOString();
    expect(body.team).toMatchObject({ id: "team-a", role: "owner", closedAt: new Date(NOW).toISOString(), deletesAt });
    expect(meta()).toMatchObject({ closedAt: new Date(NOW).toISOString(), closedBy: OWNER, purgeAfter: deletesAt, GSI1PK: "TEAMS#CLOSED", GSI1SK: `${deletesAt}#team-a`, version: 2 });
    expect(table.get("TEAM#team-a", "INVITE#inv-a1")).toBeUndefined();
    expect(audits("team-a")).toEqual([expect.objectContaining({ action: "team.closed", userId: OWNER })]);
    expect(counts[BusinessMetric.TeamsClosed]).toBe(1);
    expect(logs).toContainEqual(["info", "Team closed", { teamId: "team-a", purgeAfter: deletesAt }]);
    // Members keep reading it; /me says it's closed
    expect((await data("GET", "/teams/team-a/products", PAT)).status).toBe(200);
    expect((await data("GET", "/teams/team-a/sheets/s1", VIEWER)).status).toBe(200);
    const me = await call("GET", "/me", PAT);
    expect(me.body.teams.find((t: { id: string }) => t.id === "team-a")).toMatchObject({ closedAt: new Date(NOW).toISOString(), deletesAt });
    // Its live updates stop
    expect(await liveUpdateRecipients(table.db("team-a"), "team-a")).toEqual([]);
    expect((await liveUpdateRecipients(table.db("team-b"), "team-b")).sort()).toEqual([CO_OWNER, OWNER, PAT]);
  });

  it("refuses every change but leaving, removing members and revoking invites", async () => {
    await close();
    const closed = { status: 403, body: { error: { code: "permission_denied", message: expect.stringContaining("closed"), reason: "team_closed" } } };
    expect(await data("PATCH", "/teams/team-a/products/0123", PAT, { data: { name: "Gloves" }, expectedVersion: 3 })).toEqual(closed);
    expect(await data("DELETE", "/teams/team-a/sheets/s1", OWNER, undefined, { expectedVersion: "1" })).toEqual(closed);
    expect(await data("POST", "/teams/team-a/sheets/s1/checkout", PAT, { operationId: crypto.randomUUID(), productKey: "0123", quantity: 1 })).toEqual(closed);
    // A viewer is still told they're view-only: the role check comes first
    expect((await data("PATCH", "/teams/team-a/products/0123", VIEWER, { data: { name: "Gloves" }, expectedVersion: 3 })).body.error.reason).toBe("view_only");
    expect(await call("POST", "/teams/team-a/invites", OWNER, { email: "late@example.com", role: "viewer" })).toEqual(closed);
    expect(await call("PATCH", `/teams/team-a/members/${PAT}`, OWNER, { role: "viewer" })).toEqual(closed);
    invite("team-a", "inv-a2", "stray@example.com");
    expect((await call("POST", "/teams/team-a/invites/inv-a2/resend")).body.error.reason).toBe("team_closed");
    expect((await call("DELETE", "/teams/team-a/invites/inv-a2")).status).toBe(204);
    expect((await call("DELETE", `/teams/team-a/members/${VIEWER}`)).status).toBe(204);
    expect(audits("team-a").map((a) => [a.action, a.target])).toContainEqual(["member.removed", VIEWER]);
    expect(meta()).toMatchObject({ members: 2, owners: 1 });
  });

  it("refuses a CSV import, a rename and a receipt read", async () => {
    await close();
    const imported = await data("POST", "/teams/team-a/imports", OWNER, { importId: crypto.randomUUID(), csv: "name,price\nRags,1.5\n" });
    expect(imported).toMatchObject({ status: 403, body: { error: { code: "permission_denied", reason: "team_closed" } } });
    expect(partition("TEAM#team-a").filter((i) => String(i.SK).startsWith("IMPORT#") || i.name === "Rags")).toEqual([]);
    const owner = await authorizeTeam(table.db("team-a"), OWNER, "team-a");
    await expect(updateTeam(table.db("team-a"), owner, { name: "Renamed" }, 2)).rejects.toBeInstanceOf(TeamClosedError);
    const pat = await authorizeTeam(table.db("team-a"), PAT, "team-a");
    await expect(recordReceiptRead(table.db("team-a"), pat, "2026-09", 200)).rejects.toBeInstanceOf(TeamClosedError);
    expect(meta()).toMatchObject({ name: "Team team-a", version: 2 });
    expect(table.get("TEAM#team-a", "USAGE#2026-09")).toBeUndefined();
  });

  it("refuses an invite whose check passed before the team closed, if it commits after", async () => {
    const owner = await authorizeTeam(table.db("team-a"), OWNER, "team-a");
    // The team closes between the invite's checks and its transaction
    table.beforeTransactWrite = () => {
      table.put({ ...(meta() as Record<string, unknown>), closedAt: new Date(NOW).toISOString() });
      table.beforeTransactWrite = undefined;
    };
    await expect(createInvite(table.db(undefined), owner, { email: "racer@example.com", role: "viewer" }, new Date(NOW))).rejects.toBeInstanceOf(TeamClosedError);
    expect(partition("TEAM#team-a").filter((i) => i.email === "racer@example.com")).toEqual([]);
  });

  it("lets its last owner leave, moving both counts", async () => {
    await close();
    expect((await call("DELETE", `/teams/team-a/members/${PAT}`, PAT)).status).toBe(204);
    expect((await call("DELETE", `/teams/team-a/members/${OWNER}`, OWNER)).status).toBe(204);
    expect(meta()).toMatchObject({ members: 1, owners: 0 });
    expect(table.get(`USER#${OWNER}`, "TEAM#team-a")).toBeUndefined();
    expect(audits("team-a").map((a) => [a.action, a.target]).sort()).toEqual([["member.left", OWNER], ["member.left", PAT], ["team.closed", undefined]]);
  });

  it("still keeps the last owner of an open team", async () => {
    expect(await call("DELETE", `/teams/team-a/members/${OWNER}`, OWNER)).toMatchObject({ status: 409, body: { error: { reason: "last_owner" } } });
  });

  it("takes nobody new, even with an invite that's still there", async () => {
    await close();
    USERS["user-new"] = { sub: "user-new", email: "newbie@example.com", emailVerified: true, emailVerifiedInCognito: true };
    invite("team-a", "inv-late", "newbie@example.com");
    expect(await call("POST", "/invites/inv-late/accept", "user-new", { token: "t".repeat(32) })).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(table.get("TEAM#team-a", "MEMBER#user-new")).toBeUndefined();
  });

  it("needs the team's name, an owner, and a body with only the name", async () => {
    expect(await close("team-a", "Team B")).toMatchObject({ status: 400, body: { error: { code: "bad_request", message: "Type the team's name to close it" } } });
    expect(await close("team-a", 7)).toMatchObject({ status: 400 });
    expect((await call("POST", "/teams/team-a/close", OWNER, { name: "Team team-a", extra: 1 })).status).toBe(400);
    expect((await close("team-a", "Team team-a", PAT)).body.error.reason).toBe("owners_only");
    expect((await close("team-a", "Team team-a", CO_OWNER)).body.error.reason).toBe("not_member");
    expect(meta()?.closedAt).toBeUndefined();
    expect(table.get("TEAM#team-a", "INVITE#inv-a1")).toBeDefined();
    expect(audits("team-a")).toEqual([]);
  });

  it("is idempotent: closing again returns it as it was, without counting it twice", async () => {
    const first = await close();
    now += DAY;
    invite("team-a", "inv-left-over", "left@example.com");
    const again = await close("team-a", "anything");
    expect(again).toEqual(first);
    expect(table.get("TEAM#team-a", "INVITE#inv-left-over")).toBeUndefined();
    expect(counts[BusinessMetric.TeamsClosed]).toBe(1);
    expect(audits("team-a")).toHaveLength(1);
  });

  it("emails every owner the day the team will be deleted, and nobody else, once", async () => {
    const deletesAt = new Date(NOW + CLOSED_TEAM_RETENTION_DAYS * DAY).toISOString();
    expect((await close("team-b")).status).toBe(200);
    expect(notices.map((n) => n.to).sort()).toEqual(["co@example.com", "owner@example.com"]);
    for (const n of notices) expect(n).toMatchObject({ input: { kind: "teamClosed", teamName: "Team team-b", purgeAfter: deletesAt }, teamId: "team-b" });
    expect(counts[BusinessMetric.TeamClosedNotices]).toBe(2);
    expect(counts[BusinessMetric.TeamClosedNoticeFailures]).toBeUndefined();
    // Closing it again sends nothing more
    await close("team-b", "anything");
    expect(notices).toHaveLength(2);
    // No address or name in any log line
    expect(JSON.stringify(logs)).not.toMatch(/@example\.com|Team team-b/);
  });

  it("closes the team even when an owner can't be emailed, and counts each owner who wasn't", async () => {
    refuse.add("co@example.com");
    // An owner with no address on file
    table.put({ ...table.get("TEAM#team-b", `MEMBER#${PAT}`), role: "owner", email: undefined });
    const { status, body } = await close("team-b");
    expect(status).toBe(200);
    expect(body.team.closedAt).toBe(new Date(NOW).toISOString());
    expect(meta("team-b")?.closedAt).toBe(new Date(NOW).toISOString());
    expect(notices.map((n) => n.to)).toEqual(["owner@example.com"]);
    expect(counts[BusinessMetric.TeamClosedNotices]).toBe(1);
    expect(counts[BusinessMetric.TeamClosedNoticeFailures]).toBe(2);
    expect(logs).toContainEqual(["warn", "Team closure emails not sent", { teamId: "team-b", failed: 2, owners: 3, codes: expect.stringMatching(/^(MessageRejected,NoAddress|NoAddress,MessageRejected)$/) }]);
    expect(JSON.stringify(logs)).not.toMatch(/@example\.com/);
  });

  it("counts nobody emailed when SES refuses them all, or the owners can't be listed", async () => {
    refuse.add("owner@example.com");
    await close("team-a");
    expect(meta("team-a")?.closedAt).toBeDefined();
    expect(counts[BusinessMetric.TeamClosedNotices]).toBeUndefined();
    expect(counts[BusinessMetric.TeamClosedNoticeFailures]).toBe(1);

    memberListFails = true;
    expect((await close("team-b")).status).toBe(200);
    expect(meta("team-b")?.closedAt).toBeDefined();
    expect(notices).toEqual([]);
    expect(counts[BusinessMetric.TeamClosedNoticeFailures]).toBe(2);
    expect(logs).toContainEqual(["warn", "Team closure emails not sent", { teamId: "team-b", code: "ThrottlingException" }]);
  });

  it("refuses an owner who was demoted after their check, and changes nothing", async () => {
    table.beforeTransactWrite = () => {
      table.put({ ...table.get("TEAM#team-a", `MEMBER#${OWNER}`), role: "viewer" });
      table.beforeTransactWrite = undefined;
    };
    expect(await close()).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(meta()?.closedAt).toBeUndefined();
  });
});

describe("deleting an account", () => {
  it("leaves every team, deletes invites to the address and every USER# row, then the Cognito user", async () => {
    team("team-solo", { [PAT]: "owner" });
    invite("team-solo", "inv-solo", "someone@example.com");
    invite("team-c", "inv-c1", "pat@example.com");
    invite("team-c", "inv-c2", "pat@example.com", NOW / 1000 - 60);
    invite("team-a", "inv-a-pat", "pat@example.com");
    table.put({ PK: `USER#${PAT}`, SK: "TEAM#gone", type: "userTeam", userId: PAT, teamId: "gone", teamName: "Gone", role: "viewer" });
    table.put({ PK: `USER#${PAT}`, SK: "LIMIT#TEAMS#2026-09-26", type: "teamsCreated", count: 1, expiresAt: NOW / 1000 + 86400 });
    table.put({ PK: `USER#${PAT}`, SK: "LIMIT#EMAILCODES#2026-09-26", type: "emailCodes", count: 2, expiresAt: NOW / 1000 + 86400 });
    // The proven address and the last code's address (supply-checkout-ytr2, supply-checkout-cjw7) go too
    table.put({ PK: `USER#${PAT}`, SK: "VERIFIED_EMAIL", type: "verifiedEmail", verifiedEmailHash: "a".repeat(64), verifiedAt: new Date(NOW).toISOString() });
    table.put({ PK: `USER#${PAT}`, SK: "EMAIL_CODE_SENT", type: "emailCodeSent", sentEmailHash: "b".repeat(64), sentAt: new Date(NOW).toISOString(), expiresAt: NOW / 1000 + 86400 });

    expect(await deleteAccount(PAT, " delete ")).toEqual({ status: 204, body: undefined });
    expect(deleted).toEqual([PAT]);
    // Out of team-a and team-b, with the counts moved and the leaving audited
    for (const teamId of ["team-a", "team-b"]) {
      expect(table.get(`TEAM#${teamId}`, `MEMBER#${PAT}`)).toBeUndefined();
      expect(audits(teamId)).toEqual([expect.objectContaining({ action: "member.left", userId: PAT, target: PAT, detail: { reason: "account_deleted" } })]);
    }
    expect(meta("team-a")).toMatchObject({ members: 2, owners: 1 });
    expect(meta("team-b")).toMatchObject({ members: 2, owners: 2 });
    // The team only Pat was in: closed, then left, its invites gone
    expect(meta("team-solo")).toMatchObject({ closedAt: new Date(NOW).toISOString(), closedBy: PAT, members: 0, owners: 0 });
    expect(table.get("TEAM#team-solo", "INVITE#inv-solo")).toBeUndefined();
    expect(audits("team-solo").map((a) => a.action).sort()).toEqual(["member.left", "team.closed"]);
    // Every invite to Pat's address, from any team, expired or not (team-a's went when Pat left it)
    for (const [teamId, inviteId] of [["team-c", "inv-c1"], ["team-c", "inv-c2"], ["team-a", "inv-a-pat"]]) expect(table.get(`TEAM#${teamId}`, `INVITE#${inviteId}`)).toBeUndefined();
    expect(table.get("TEAM#team-a", "INVITE#inv-a1")).toBeDefined();
    // Nothing left in Pat's partition but the deletion mark and the daily limit counters, which all expire:
    // deleting the account doesn't reset a daily limit
    expect(partition(`USER#${PAT}`).map((i) => i.SK).sort()).toEqual(["DELETING", "LIMIT#EMAILCODES#2026-09-26", "LIMIT#TEAMS#2026-09-26"]);
    expect(table.get(`USER#${PAT}`, "DELETING")).toMatchObject({ type: "accountDeletion", expiresAt: NOW / 1000 + 30 * 86400 });
    expect(counts).toMatchObject({ [BusinessMetric.AccountsDeleted]: 1, [BusinessMetric.TeamsClosed]: 1 });
    expect(logs).toContainEqual(["info", "Account deleted", { userId: PAT, teamsLeft: 3, teamsClosed: 1, invitesDeleted: 2, rowsDeleted: 3 }]);
    // No addresses or team names in any log line
    expect(JSON.stringify(logs)).not.toMatch(/@|Team /);
    // Every session was for Pat, and reached only Pat's teams and the teams that invited Pat's verified address
    expect(new Set(scopes.map((s) => s.userId))).toEqual(new Set([PAT]));
    expect(new Set(scopes.map((s) => s.teamId).filter(Boolean))).toEqual(new Set(["gone", "team-a", "team-b", "team-solo", "team-c"]));
    expect(scopes.every((s) => s.member === undefined && s.inviteLimit === undefined)).toBe(true);
    expect(new Set(scopes.map((s) => s.invitee).filter(Boolean))).toEqual(new Set([hashEmail("pat@example.com")]));
    // Signed out everywhere: the next request is refused
    expect((await call("GET", "/me", PAT)).status).toBe(401);
  });

  it("is refused, changing nothing, while the caller is the only owner of an open team with other members", async () => {
    team("team-z", { [OWNER]: "owner", [PAT]: "viewer" }, { name: "Zeta" });
    team("team-y", { [OWNER]: "owner", [VIEWER]: "viewer" }, { name: "Alpha" });
    team("team-x", { [OWNER]: "owner", [CO_OWNER]: "viewer" }, { name: "Beta" });
    const before = structuredClone([...table.items.entries()]);
    const { status, body } = await deleteAccount(OWNER);
    expect(status).toBe(409);
    expect(body.error).toEqual({ code: "aborted", reason: "last_owner", message: "You're the only owner of Alpha, Beta, Team team-a and 1 more. Make someone else an owner, or close the team, before you delete your account." });
    expect([...table.items.entries()]).toEqual(before);
    expect(deleted).toEqual([]);
    // Once the team is closed, deleting the account works
    for (const t of ["team-a", "team-x", "team-y", "team-z"]) {
      const name = String(meta(t)?.name);
      expect((await close(t, name)).status).toBe(200);
    }
    expect((await deleteAccount(OWNER)).status).toBe(204);
    expect(meta("team-a")).toMatchObject({ owners: 0, members: 2 });
    // team-b has another owner, so the caller just left it
    expect(meta("team-b")).toMatchObject({ owners: 1, members: 2 });
    expect(meta("team-b")?.closedAt).toBeUndefined();
  });

  it("doesn't close a team someone joined after the caller's check, and doesn't leave the account blocked", async () => {
    team("team-solo", { [SOLO]: "owner" });
    // Sam accepts an invite between the deletion's read of the team and its closing
    table.beforeTransactWrite = () => {
      member("team-solo", "user-sam", "contributor");
      table.put({ ...(meta("team-solo") as Record<string, unknown>), members: 2 });
      table.beforeTransactWrite = undefined;
    };
    expect(await deleteAccount(SOLO)).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(meta("team-solo")?.closedAt).toBeUndefined();
    expect(table.get("TEAM#team-solo", `MEMBER#${SOLO}`)).toBeDefined();
    expect(table.get(`USER#${SOLO}`, "DELETING")).toBeUndefined();
    expect(deleted).toEqual([]);
    // Now they're the only owner of a team with someone else in it
    expect((await deleteAccount(SOLO)).body.error.reason).toBe("last_owner");
  });

  it("takes the mark away when a team refuses the caller's leaving after the check (the other owner stepped down meanwhile)", async () => {
    await close("team-a");
    table.beforeTransactWrite = () => {
      table.put({ ...(table.get("TEAM#team-b", `MEMBER#${CO_OWNER}`) as Record<string, unknown>), role: "viewer" });
      table.put({ ...(meta("team-b") as Record<string, unknown>), owners: 1 });
      table.beforeTransactWrite = undefined;
    };
    const res = await deleteAccount(OWNER);
    expect(res).toMatchObject({ status: 409, body: { error: { reason: "last_owner" } } });
    expect(table.get(`USER#${OWNER}`, "DELETING")).toBeUndefined();
    expect(table.get("TEAM#team-b", `MEMBER#${OWNER}`)).toBeDefined();
    expect(deleted).toEqual([]);
  });

  it("names a single blocking team on its own", async () => {
    expect((await deleteAccount(OWNER)).body.error.message).toBe("You're the only owner of Team team-a. Make someone else an owner, or close the team, before you delete your account.");
  });

  it("counts the members of a team from before the member count", async () => {
    team("team-old", { [SOLO]: "owner" });
    const old = meta("team-old") as Record<string, unknown>;
    delete old.members;
    table.put(old);
    expect((await deleteAccount(SOLO)).status).toBe(204);
    expect(meta("team-old")).toMatchObject({ closedAt: expect.any(String), members: 0, owners: 0 });
    team("team-old2", { [OWNER]: "owner", [CO_OWNER]: "viewer" });
    const old2 = meta("team-old2") as Record<string, unknown>;
    delete old2.members;
    table.put(old2);
    await close("team-a");
    expect((await deleteAccount(OWNER)).body.error.message).toContain("Team team-old2");
  });

  it("needs DELETE typed, and a body with only that", async () => {
    for (const confirm of ["delete my account", "", 1, null]) {
      expect(await deleteAccount(PAT, confirm)).toMatchObject({ status: 400, body: { error: { code: "bad_request", message: "Type DELETE to confirm" } } });
    }
    expect((await call("DELETE", "/me", PAT, { confirm: "DELETE", also: 1 })).status).toBe(400);
    expect((await call("DELETE", "/me", PAT)).status).toBe(400);
    expect(deleted).toEqual([]);
    expect(table.get(`USER#${PAT}`, "DELETING")).toBeUndefined();
  });

  it("carries on after a failure part-way, without counting anyone twice", async () => {
    deleteFails = true;
    expect((await deleteAccount(PAT)).status).toBe(500);
    expect(meta("team-a")).toMatchObject({ members: 2 });
    expect(logs.some(([level]) => level === "error")).toBe(true);
    deleteFails = false;
    expect((await deleteAccount(PAT)).status).toBe(204);
    expect(meta("team-a")).toMatchObject({ members: 2, owners: 1 });
    expect(meta("team-b")).toMatchObject({ members: 2, owners: 2 });
    expect(deleted).toEqual([PAT]);
  });

  it("keeps going with the other teams when one fails, and fails the request", async () => {
    let first = true;
    table.beforeTransactWrite = () => {
      if (!first) return;
      first = false;
      throw Object.assign(new Error("Throughput exceeded"), { name: "ProvisionedThroughputExceededException" });
    };
    expect((await deleteAccount(PAT)).status).toBe(500);
    // One of the two teams was left
    const left = ["team-a", "team-b"].filter((t) => !table.get(`TEAM#${t}`, `MEMBER#${PAT}`));
    expect(left).toHaveLength(1);
    expect(deleted).toEqual([]);
    expect((await deleteAccount(PAT)).status).toBe(204);
  });

  it("leaves an unverified address's invites alone: nothing proves they're the caller's", async () => {
    invite("team-c", "inv-v", "viewer@example.com");
    expect((await deleteAccount(VIEWER)).status).toBe(204);
    expect(table.get("TEAM#team-c", "INVITE#inv-v")).toBeDefined();
    expect(scopes.every((s) => s.invitee === undefined)).toBe(true);
  });

  it("stops the caller joining or creating teams while it runs", async () => {
    await startAccountDeletion(table.scoped([`USER#${PAT}`]), PAT, new Date(NOW));
    const created = await accountHandler({ ...event(ACCOUNT_ROUTES, "POST", "/teams", PAT, { name: "New" }), headers: { authorization: `Bearer token-${PAT}`, "idempotency-key": "key-00000001" } } as DataEvent);
    expect(created.statusCode).toBe(403);
    expect(JSON.parse(created.body as string).error.message).toBe("This account is being deleted");
    expect(partition(`USER#${PAT}`).filter((i) => String(i.SK).startsWith("TEAM#"))).toHaveLength(2);
  });

  it("answers 401 when Cognito no longer knows the caller", async () => {
    deleted.push(PAT);
    expect((await deleteAccount(PAT)).status).toBe(401);
  });
});

describe("purging closed teams", () => {
  const purge = (at: number) => createTeamPurgeHandler({ db: table.db(undefined), obs: observability(), now: () => at })();

  it("deletes a closed team, its members' switcher rows and its Stripe link once 30 days have passed, and nothing else", async () => {
    table.put({ ...(meta("team-a") as Record<string, unknown>), stripeCustomerId: "cus_123" });
    table.put({ PK: "STRIPE#cus_123", SK: "TEAM", type: "stripeLink", customerId: "cus_123", teamId: "team-a" });
    table.put({ PK: "TEAM#team-a", SK: "MOVE#0123#2026-09-26T12:00:00.000Z#op1", type: "movement" });
    await close();
    const others = [...table.items.values()].filter((i) => i.PK !== "TEAM#team-a" && !(String(i.PK).startsWith("USER#") && i.SK === "TEAM#team-a") && i.PK !== "STRIPE#cus_123");
    // Not yet
    expect(await purge(NOW + (CLOSED_TEAM_RETENTION_DAYS - 1) * DAY)).toEqual({ purged: 0, failed: 0, due: 0, overdue: 0 });
    expect(partition("TEAM#team-a").length).toBeGreaterThan(5);
    // Due: gone
    expect(await purge(NOW + CLOSED_TEAM_RETENTION_DAYS * DAY + 1000)).toEqual({ purged: 1, failed: 0, due: 1, overdue: 0 });
    expect(partition("TEAM#team-a")).toEqual([]);
    expect(table.get("STRIPE#cus_123", "TEAM")).toBeUndefined();
    for (const user of [OWNER, PAT, VIEWER]) expect(table.get(`USER#${user}`, "TEAM#team-a")).toBeUndefined();
    expect([...table.items.values()]).toEqual(others);
    expect(counts[BusinessMetric.TeamsPurged]).toBe(1);
    // Purged on time: nothing overdue, and the gauge says so (zero, not missing)
    expect(gauges[BusinessMetric.ClosedTeamsOverdue]).toBe(0);
    // A second run finds nothing
    expect(await purge(NOW + CLOSED_TEAM_RETENTION_DAYS * DAY + 2000)).toEqual({ purged: 0, failed: 0, due: 0, overdue: 0 });
  });

  it("names only the attributes its IAM policy allows, reads only projected keys, and never asks for old values back", async () => {
    table.put({ ...(meta("team-a") as Record<string, unknown>), stripeCustomerId: "cus_123" });
    table.put({ PK: "STRIPE#cus_123", SK: "TEAM", type: "stripeLink", customerId: "cus_123", teamId: "team-a" });
    await close();
    table.requests.length = 0;
    await purge(NOW + 31 * DAY);
    expect(table.requests.length).toBeGreaterThan(5);
    const seen = new Set<string>();
    for (const { command, input } of table.requests) {
      seen.add(`${command} ${String(input.Select ?? "")}`.trim());
      const names = Object.values((input.ExpressionAttributeNames ?? {}) as Record<string, string>);
      const text = [input.ProjectionExpression, input.ConditionExpression, input.KeyConditionExpression, input.UpdateExpression].filter(Boolean).join(" ");
      const bare = [...String(text).replace(/:[A-Za-z0-9_]+/g, " ").matchAll(/(?<![#\w])[A-Za-z_][A-Za-z0-9_]*\b(?!\s*\()/g)].map((m) => m[0]).filter((w) => !["AND", "OR", "SET"].includes(w));
      // The one update, the purging mark, has its own narrower list (its own IAM statement)
      const allowed: readonly string[] = command === "UpdateCommand" ? TEAM_PURGE_MARK_ATTRIBUTES : TEAM_PURGE_ATTRIBUTES;
      for (const a of [...names, ...bare, ...Object.keys((input.Key ?? {}) as object)]) expect(allowed, `${command} ${a}`).toContain(a);
      if (command === "QueryCommand" && input.Select !== "COUNT") expect(input).toMatchObject({ Select: "SPECIFIC_ATTRIBUTES", ProjectionExpression: expect.any(String) });
      if (command === "QueryCommand" && input.Select === "COUNT") expect(input).toMatchObject({ IndexName: "GSI1", ExpressionAttributeValues: expect.objectContaining({ ":pk": "TEAMS#CLOSED" }) });
      if (command === "GetCommand") expect(input.ProjectionExpression).toEqual(expect.any(String));
      if (command === "UpdateCommand") expect(input).toMatchObject({ Key: { PK: "TEAM#team-a", SK: "META" }, UpdateExpression: "SET purging = :now" });
      expect(input.ReturnValues).toBeUndefined();
      expect(["QueryCommand", "GetCommand", "DeleteCommand", "UpdateCommand"]).toContain(command);
    }
    expect([...seen].sort()).toEqual(["DeleteCommand", "GetCommand", "QueryCommand COUNT", "QueryCommand SPECIFIC_ATTRIBUTES", "UpdateCommand"]);
  });

  it("skips a team listed in the index that isn't closed or isn't due, and leaves another team's Stripe link", async () => {
    table.put({ ...(meta("team-b") as Record<string, unknown>), GSI1PK: "TEAMS#CLOSED", GSI1SK: "2026-01-01T00:00:00.000Z#team-b" });
    table.put({ ...(meta("team-a") as Record<string, unknown>), closedAt: "2026-09-01T00:00:00.000Z", purgeAfter: "2027-01-01T00:00:00.000Z", GSI1PK: "TEAMS#CLOSED", GSI1SK: "2026-01-02T00:00:00.000Z#team-a" });
    expect(await purge(NOW)).toEqual({ purged: 0, failed: 0, due: 2, overdue: 0 });
    expect(meta("team-a")).toBeDefined();
    expect(meta("team-b")).toBeDefined();
    expect(await purgeTeam(table.db(undefined), "team-missing", new Date(NOW))).toEqual({ deleted: 0, skipped: true });
    table.put({ ...(meta("team-a") as Record<string, unknown>), purgeAfter: "2026-01-02T00:00:00.000Z", stripeCustomerId: "cus_9" });
    table.put({ PK: "STRIPE#cus_9", SK: "TEAM", type: "stripeLink", customerId: "cus_9", teamId: "team-other" });
    await expect(purge(NOW)).rejects.toThrow("1 of 2 closed teams weren't purged");
    expect(table.get("STRIPE#cus_9", "TEAM")).toBeDefined();
    // A failed run still sends the gauge: the team that failed is months past its date, the skipped one isn't counted
    expect(gauges[BusinessMetric.ClosedTeamsOverdue]).toBe(1);
  });

  it("counts a team as overdue only once it's more than a day past its deletion date and this run didn't delete it", async () => {
    await close("team-a");
    const due = NOW + CLOSED_TEAM_RETENTION_DAYS * DAY;
    // The purge couldn't reach it (a run that ran out of time before it): not overdue until a day has passed
    // Each read of the clock moves it past the budget, so the run starts at the time set here and stops before the team
    const step = PURGE_BUDGET_MS + 1;
    let clock = due + DAY - 1000 - step;
    const stuck = () => createTeamPurgeHandler({ db: table.db(undefined), obs: observability(), now: () => (clock += step) })();
    expect((await stuck()).overdue).toBe(0);
    clock = due + DAY + 1000 - step;
    expect((await stuck()).overdue).toBe(1);
    expect(gauges[BusinessMetric.ClosedTeamsOverdue]).toBe(1);
    expect(logs).toContainEqual(["info", "Purged closed teams", { due: 1, purged: 0, failed: 0, overdue: 1 }]);
    // Once a run deletes it, the gauge goes back to zero
    expect(await purge(due + DAY + 2000)).toEqual({ purged: 1, failed: 0, due: 1, overdue: 0 });
    expect(gauges[BusinessMetric.ClosedTeamsOverdue]).toBe(0);
  });

  it("ignores index entries it didn't write, and stops starting teams after its time budget", async () => {
    table.put({ PK: "SOMETHING", SK: "META", GSI1PK: "TEAMS#CLOSED", GSI1SK: "2026-01-01T00:00:00.000Z#x" });
    table.put({ PK: "TEAM#bad id", SK: "META", GSI1PK: "TEAMS#CLOSED", GSI1SK: "2026-01-01T00:00:00.000Z#bad" });
    table.put({ PK: "TEAM#team-a", SK: "INVITE#x", GSI1PK: "TEAMS#CLOSED", GSI1SK: "2026-01-01T00:00:00.000Z#team-a" });
    await close("team-a");
    await close("team-b");
    let clock = NOW + 40 * DAY;
    const run = createTeamPurgeHandler({ db: table.db(undefined), obs: observability(), now: () => (clock += PURGE_BUDGET_MS + 1) })();
    // Ten days past their deletion date and not reached: overdue. The three entries it didn't
    // write aren't listed, but they're counted: nothing will ever delete them, so a person should look
    expect(await run).toEqual({ purged: 0, failed: 0, due: 2, overdue: 5 });
    expect(gauges[BusinessMetric.ClosedTeamsOverdue]).toBe(5);
    expect(meta("team-a")).toBeDefined();
  });

  it("counts every overdue team, not just the first page it lists", async () => {
    // More overdue teams than one listing holds (100)
    for (let i = 0; i < 130; i++) {
      const teamId = `team-old-${String(i).padStart(3, "0")}`;
      team(teamId, {}, { closedAt: "2026-08-01T00:00:00.000Z", purgeAfter: "2026-08-31T00:00:00.000Z", GSI1PK: "TEAMS#CLOSED", GSI1SK: `2026-08-31T00:00:00.000Z#${teamId}` });
    }
    // Due, but not yet overdue
    team("team-new", {}, { closedAt: "2026-08-27T00:00:00.000Z", purgeAfter: "2026-09-26T00:00:00.000Z", GSI1PK: "TEAMS#CLOSED", GSI1SK: "2026-09-26T00:00:00.000Z#team-new" });
    let clock = NOW;
    // Out of time before the first team
    const stuck = createTeamPurgeHandler({ db: table.db(undefined), obs: observability(), now: () => (clock += PURGE_BUDGET_MS + 1) });
    expect(await stuck()).toEqual({ purged: 0, failed: 0, due: 100, overdue: 130 });
    expect(gauges[BusinessMetric.ClosedTeamsOverdue]).toBe(130);
    // A run that deletes the 100 it listed leaves the other 30 overdue
    expect(await purge(NOW)).toEqual({ purged: 100, failed: 0, due: 100, overdue: 30 });
    expect(gauges[BusinessMetric.ClosedTeamsOverdue]).toBe(30);
    expect(await purge(NOW)).toEqual({ purged: 31, failed: 0, due: 31, overdue: 0 });
  });

  it("sends no gauge when it can't read the index, so the not-running alarm sees the gap", async () => {
    await close("team-a");
    const db = table.guarded((command, input) => !(command === "QueryCommand" && input.Select === "COUNT"));
    await expect(createTeamPurgeHandler({ db, obs: observability(), now: () => NOW + 40 * DAY })()).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(gauges[BusinessMetric.ClosedTeamsOverdue]).toBeUndefined();
  });

  it("marks a team purging before it deletes anything, and leaves it marked if it stops part-way", async () => {
    await close("team-a");
    const at = new Date(NOW + 31 * DAY);
    let deletes = 0;
    const db = table.guarded((command) => command !== "DeleteCommand" || ++deletes < 3);
    await expect(purgeTeam(db, "team-a", at)).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(meta("team-a")).toMatchObject({ purging: at.toISOString(), closedAt: expect.any(String) });
    // The next run carries on, and finishes it
    expect((await purgeTeam(table.db(undefined), "team-a", new Date(at.getTime() + 3_600_000))).skipped).toBe(false);
    expect(partition("TEAM#team-a")).toEqual([]);
  });

  it("leaves a team alone that was reopened between reading it and marking it", async () => {
    await close("team-a");
    const before = partition("TEAM#team-a").length;
    // Reopened right after the purge read it: closure fields and index keys gone
    table.afterGet = (item) => {
      if (item?.PK === "TEAM#team-a" && item.SK === "META") {
        table.afterGet = undefined;
        const open = { ...(item as Record<string, unknown>) };
        for (const k of ["closedAt", "closedBy", "purgeAfter", "GSI1PK", "GSI1SK"]) Reflect.deleteProperty(open, k);
        table.put(open);
      }
    };
    expect(await purgeTeam(table.db(undefined), "team-a", new Date(NOW + 31 * DAY))).toEqual({ deleted: 0, skipped: true });
    expect(partition("TEAM#team-a")).toHaveLength(before);
    expect(meta("team-a")?.purging).toBeUndefined();
  });
});
