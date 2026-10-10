// "Report an issue" through the account API (supply-checkout-bmsh.1): POST
// /teams/{teamId}/feedback, against the in-memory table with each request's
// handle scoped to the partitions its session tags allow, and the account-
// access role's policy for the reports partition (PutItem only, naming only
// FEEDBACK_ATTRIBUTES). test/roles.test.ts has the route in the per-role
// matrix, test/feedback-ddb.test.ts runs the storage against DynamoDB Local.

import { beforeEach, describe, expect, it } from "vitest";
import type { AccountScope, DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { ACCOUNT_ROUTES, DATA_ROUTES, routeKey } from "../src/api/routes.js";
import { FEEDBACK_ATTRIBUTES, FEEDBACK_RETENTION_DAYS } from "../src/data/schema.js";
import { dismissFeedback } from "../src/data/feedback-owner.js";
import { authorizeTeam, FEEDBACK_BODY_BYTES, FEEDBACK_PER_USER_PER_DAY, feedbackInput, sendFeedback } from "../src/data/index.js";
import { BusinessMetric } from "../src/observability/names.js";
import type { Observability } from "../src/observability/index.js";
import { accountFeedbackPolicy, accountPartitions, fakeDb, fakeMailer, unusedDeleteUser, unusedDeletionLog, unusedEmailCodes, unusedTotp } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const OWNER = "user-owner";
const CREW = "user-crew";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";
const SECRET = "ZEBRA-STRIPE-7731 the scanner froze on aisle nine";

let table: MemoryTable;
let scopes: AccountScope[];
let logs: unknown[][];
let counts: { metric: string; metadata: unknown }[];
let denied: { command: string; input: Record<string, unknown> }[];
let handler: ReturnType<typeof createAccountHandler>;
let now: number;

function team(teamId: string, members: Record<string, string>, extra: Record<string, unknown> = {}) {
  const owners = Object.values(members).filter((r) => r === "owner").length;
  table.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: teamId, homeRegion: "test-local-1", owners, members: Object.keys(members).length, version: 1, ...extra });
  for (const [userId, role] of Object.entries(members)) {
    table.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#${userId}`, type: "member", teamId, userId, role, email: `${userId.slice(5)}@example.com`, joinedAt: "2026-09-01T00:00:00.000Z" });
    table.put({ PK: `USER#${userId}`, SK: `TEAM#${teamId}`, type: "userTeam", userId, teamId, teamName: teamId, role });
  }
}

beforeEach(() => {
  now = NOW;
  table = new MemoryTable();
  scopes = [];
  logs = [];
  counts = [];
  denied = [];
  team("team-a", { [OWNER]: "owner", [CREW]: "contributor", [VIEWER]: "viewer" });
  team("team-b", { [OUTSIDER]: "owner", [CREW]: "viewer" });
  const dbFor: DbForAccount = (scope) => {
    scopes.push(scope);
    return table.scoped(accountPartitions(scope), accountFeedbackPolicy(denied));
  };
  const obs = {
    region: "test-local-1",
    logger: { info: (...a: unknown[]) => logs.push(["info", ...a]), warn: (...a: unknown[]) => logs.push(["warn", ...a]), error: (...a: unknown[]) => logs.push(["error", ...a]), addContext: () => {} },
    count: (metric: string, _n: number, metadata: unknown) => counts.push({ metric, metadata }),
    flush: () => {},
  } as unknown as Observability;
  handler = createAccountHandler({
    dbFor,
    userInfo: async () => Promise.reject(new Error("the report route never reads the user's Cognito record")),
    issuerUrl: ISSUER,
    obs,
    mailer: fakeMailer().mailer,
    deleteUser: unusedDeleteUser,
    deletions: unusedDeletionLog,
    emailCodes: unusedEmailCodes,
    totp: unusedTotp,
    now: () => now,
  });
});

function event(user: string, path: string, body?: unknown, headers: Record<string, string> = {}, raw?: string): DataEvent {
  const route = ACCOUNT_ROUTES.find((r) => r.method === "POST" && r.path === "/teams/{teamId}/feedback");
  const teamId = path.split("/")[2] as string;
  return {
    version: "2.0",
    routeKey: routeKey(route as { method: string; path: string }),
    rawPath: path,
    rawQueryString: "",
    headers: { authorization: `Bearer token-${user}`, ...headers },
    pathParameters: { teamId },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    isBase64Encoded: false,
    requestContext: {
      http: { method: "POST", path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER }, scopes: null } },
    },
  } as unknown as DataEvent;
}

let keyCounter = 0;
const nextKey = () => `report-key-${String(++keyCounter).padStart(6, "0")}`;

async function send(user: string, body: unknown, options: { teamId?: string; key?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = options.key === null ? {} : { "idempotency-key": options.key ?? nextKey() };
  const response = await handler(event(user, `/teams/${options.teamId ?? "team-a"}/feedback`, body, headers, options.raw));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const valid = { category: "bug", message: SECRET };
const reports = (teamId = "team-a") => [...table.items.values()].filter((i) => String(i.PK) === `FEEDBACK#${teamId}`);
const refused = (status: number, code: string, reason?: string) => ({ status, body: { error: { code, message: expect.any(String), ...(reason ? { reason } : {}) } } });
const badRequest = (field: string) => ({ status: 400, body: { error: { code: "bad_request", message: expect.stringContaining(field) } } });

describe("POST /teams/{teamId}/feedback", () => {
  it("stores a report for a member of any role, with the team from the path and the user and role from the token", async () => {
    for (const [user, role] of [[OWNER, "owner"], [CREW, "contributor"], [VIEWER, "viewer"]] as const) {
      now += 1000;
      const sent = await send(user, { ...valid, expected: "It scans", contactOk: true, context: { build: "1.11.1+3f2a9c1", screen: "scan", browser: "safari" } });
      expect(sent.status).toBe(201);
      expect(sent.body).toEqual({ report: { id: expect.stringMatching(/^[0-9a-f]{32}$/), shortId: sent.body.report.id.slice(0, 8) } });
      const stored = table.get("FEEDBACK#team-a", `REPORT#${sent.body.report.id}`);
      expect(stored).toEqual({
        PK: "FEEDBACK#team-a",
        SK: `REPORT#${sent.body.report.id}`,
        GSI1PK: "FEEDBACK#STATUS#new",
        GSI1SK: `${new Date(now).toISOString()}#${sent.body.report.id}`,
        type: "feedback",
        reportId: sent.body.report.id,
        shortId: sent.body.report.shortId,
        teamId: "team-a",
        userId: user,
        role,
        createdAt: new Date(now).toISOString(),
        category: "bug",
        message: SECRET,
        expected: "It scans",
        contactOk: true,
        context: { build: "1.11.1+3f2a9c1", screen: "scan", browser: "safari" },
        status: "new",
        beadId: "",
        expiresAt: Math.floor(now / 1000) + FEEDBACK_RETENTION_DAYS * 86_400,
      });
      // Every attribute the account role may name, and no email
      expect(Object.keys(stored as object).every((k) => (FEEDBACK_ATTRIBUTES as readonly string[]).includes(k))).toBe(true);
      expect(JSON.stringify(stored)).not.toContain("@");
    }
    expect(reports()).toHaveLength(3);
    expect(denied).toEqual([]);
  });

  it("defaults: contactOk false, no expected, no context", async () => {
    const sent = await send(VIEWER, valid);
    expect(table.get("FEEDBACK#team-a", `REPORT#${sent.body.report.id}`)).toMatchObject({ contactOk: false, expected: "", context: {} });
  });

  it("is idempotent by Idempotency-Key: a retry stores one report, answers 200 with the same IDs, and counts nothing", async () => {
    const first = await send(CREW, valid, { key: "retry-key-0001" });
    const again = await send(CREW, { ...valid, message: "A different text on the retry" }, { key: "retry-key-0001" });
    expect(first.status).toBe(201);
    expect(again).toEqual({ status: 200, body: first.body });
    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.message).toBe(SECRET);
    expect(table.get(`USER#${CREW}`, "LIMIT#FEEDBACK#2026-10-09")).toMatchObject({ count: 1 });
    expect(counts.filter((c) => c.metric === BusinessMetric.FeedbackReceived)).toHaveLength(1);
    // Another key, another report; the same key from another user or team is its own
    const other = await send(CREW, valid, { key: "retry-key-0002" });
    expect(other.body.report.id).not.toBe(first.body.report.id);
    const otherUser = await send(OWNER, valid, { key: "retry-key-0001" });
    expect(otherUser.body.report.id).not.toBe(first.body.report.id);
    expect(reports()).toHaveLength(3);
  });

  it("needs an Idempotency-Key", async () => {
    expect(await send(CREW, valid, { key: null })).toMatchObject(badRequest("Idempotency-Key"));
    expect(await send(CREW, valid, { key: "short" })).toMatchObject(badRequest("Idempotency-Key"));
    expect(await send(CREW, valid, { key: "has spaces in it!" })).toMatchObject(badRequest("Idempotency-Key"));
    expect(reports()).toHaveLength(0);
  });

  it("limits a user to 5 reports a UTC day across all their teams, with a plain message, and resets the next day", async () => {
    for (let i = 0; i < FEEDBACK_PER_USER_PER_DAY; i++) {
      expect((await send(CREW, valid, { teamId: i % 2 ? "team-b" : "team-a" })).status).toBe(201);
    }
    const sixth = await send(CREW, valid, { teamId: "team-a" });
    expect(sixth).toEqual(refused(429, "quota_exceeded", "feedback_limit"));
    expect(sixth.body.error.message).toBe("You can send 5 reports a day. Try again tomorrow.");
    expect((await send(CREW, valid, { teamId: "team-b" })).status).toBe(429);
    expect(reports("team-a").length + reports("team-b").length).toBe(5);
    // Others aren't held to it
    expect((await send(OWNER, valid)).status).toBe(201);
    // A retry of one that was stored still answers, at the limit
    now += 1000;
    const retried = await send(OWNER, valid, { key: "retry-at-limit-1" });
    expect(retried.status).toBe(201);
    for (let i = 0; i < FEEDBACK_PER_USER_PER_DAY - 2; i++) await send(OWNER, valid);
    expect((await send(OWNER, valid)).status).toBe(429);
    expect((await send(OWNER, valid, { key: "retry-at-limit-1" })).status).toBe(200);
    // Tomorrow (UTC)
    now = Date.parse("2026-10-10T00:00:01Z");
    expect((await send(CREW, valid)).status).toBe(201);
    expect(table.get(`USER#${CREW}`, "LIMIT#FEEDBACK#2026-10-09")).toMatchObject({ count: 5, expiresAt: expect.any(Number) });
  });

  it("refuses a caller outside the team, a team that doesn't exist, and a path that isn't an ID, whatever they send, and writes nothing", async () => {
    const before = structuredClone([...table.items.entries()]);
    expect(await send(OUTSIDER, valid, { teamId: "team-a" })).toEqual(refused(403, "permission_denied", "not_member"));
    expect(await send(OUTSIDER, { rubbish: true }, { teamId: "team-a" })).toEqual(refused(403, "permission_denied", "not_member"));
    expect(await send(OWNER, valid, { teamId: "team-b" })).toEqual(refused(403, "permission_denied", "not_member"));
    expect(await send(OWNER, valid, { teamId: "team-zzz" })).toEqual(refused(403, "permission_denied", "not_member"));
    expect((await send(OWNER, valid, { teamId: "team%23a" })).status).toBe(400);
    expect([...table.items.entries()]).toEqual(before);
  });

  it("takes the team and user only from the path and token: a body naming them or any server-owned field is refused", async () => {
    for (const field of ["teamId", "userId", "role", "status", "beadId", "reportId", "shortId", "createdAt", "expiresAt", "email", "type", "PK", "GSI1PK"]) {
      expect((await send(CREW, { ...valid, [field]: "team-b" })).status, field).toBe(400);
    }
    expect(reports("team-a")).toHaveLength(0);
    expect(reports("team-b")).toHaveLength(0);
  });

  describe("validation", () => {
    it.each([
      ["category missing", { message: "x" }, "category"],
      ["category unknown", { category: "complaint", message: "x" }, "category"],
      ["category not text", { category: 1, message: "x" }, "category"],
      ["message missing", { category: "bug" }, "message"],
      ["message empty", { category: "bug", message: "" }, "message"],
      ["message blank", { category: "bug", message: " \n\t " }, "message"],
      ["message only invisible characters", { category: "bug", message: "\u200b\u202e\u0000" }, "message"],
      ["message not text", { category: "bug", message: { text: "x" } }, "message"],
      ["message a number", { category: "bug", message: 12 }, "message"],
      ["message null", { category: "bug", message: null }, "message"],
      ["message too long", { category: "bug", message: "x".repeat(2001) }, "message"],
      ["expected too long", { ...valid, expected: "y".repeat(1001) }, "expected"],
      ["expected not text", { ...valid, expected: ["a"] }, "expected"],
      ["contactOk not a boolean", { ...valid, contactOk: "yes" }, "contactOk"],
      ["context not an object", { ...valid, context: "chrome" }, "context"],
      ["context an array", { ...valid, context: [] }, "context"],
      ["context with another key", { ...valid, context: { build: "1.0.0", userAgent: "Mozilla" } }, "context"],
      ["context.build not text", { ...valid, context: { build: 1 } }, "context.build"],
      ["context.build malformed", { ...valid, context: { build: "1.0.0 <script>" } }, "context.build"],
      ["context.build too long", { ...valid, context: { build: "1".repeat(65) } }, "context.build"],
      ["context.screen not text", { ...valid, context: { screen: ["scan"] } }, "context.screen"],
      ["context.browser not text", { ...valid, context: { browser: 5 } }, "context.browser"],
    ])("refuses %s", async (_what, body, field) => {
      const response = await send(CREW, body);
      expect(response).toMatchObject(badRequest(field));
      expect(reports()).toHaveLength(0);
      // Not even a count: validation comes before any write
      expect(table.get(`USER#${CREW}`, "LIMIT#FEEDBACK#2026-10-09")).toBeUndefined();
    });

    it("refuses a body that isn't a JSON object", async () => {
      expect((await send(CREW, undefined, { raw: "not json" })).status).toBe(400);
      expect((await send(CREW, undefined, { raw: "[1]" })).status).toBe(400);
      expect((await send(CREW, undefined, { raw: "" })).status).toBe(400);
    });

    it("accepts the longest text, counted in characters, and trims it", async () => {
      const long = "é".repeat(2000);
      const sent = await send(CREW, { category: "idea", message: `  ${long}  ` });
      expect(sent.status).toBe(201);
      expect(table.get("FEEDBACK#team-a", `REPORT#${sent.body.report.id}`)).toMatchObject({ message: long });
      const expected = await send(CREW, { category: "idea", message: "m", expected: "z".repeat(1000) });
      expect(table.get("FEEDBACK#team-a", `REPORT#${expected.body.report.id}`)).toMatchObject({ expected: "z".repeat(1000) });
      // Emoji count once each
      expect((await send(CREW, { category: "idea", message: "\u{1F9E4}".repeat(1000) })).status).toBe(201);
    });

    it("strips control and hidden characters, keeps line breaks, and turns tabs and other controls into spaces", async () => {
      const sent = await send(CREW, { category: "bug", message: "  line one\r\nline\u0000two\u202e\u200b\ttabbed\u001b[31m\r\n\r\n  line\u0085three  ", expected: "a\u0007b" });
      expect(table.get("FEEDBACK#team-a", `REPORT#${sent.body.report.id}`)).toMatchObject({
        message: "line one\nline two tabbed [31m\n\nline three",
        expected: "a b",
      });
    });

    it("stores a screen or browser this version doesn't know as other, and leaves missing context keys out", async () => {
      const sent = await send(CREW, { ...valid, context: { screen: "bulk-edit", browser: "netscape" } });
      expect(table.get("FEEDBACK#team-a", `REPORT#${sent.body.report.id}`)?.context).toEqual({ screen: "other", browser: "other" });
      const partial = await send(CREW, { ...valid, context: { build: "2.0.0" } });
      expect(table.get("FEEDBACK#team-a", `REPORT#${partial.body.report.id}`)?.context).toEqual({ build: "2.0.0" });
    });

    it("caps the body at 4 KB", async () => {
      const big = JSON.stringify({ category: "bug", message: "x".repeat(FEEDBACK_BODY_BYTES) });
      expect(await send(CREW, undefined, { raw: big })).toEqual(refused(413, "quota_exceeded"));
      // 2000 two-byte characters fit; 2000 four-byte ones don't
      expect((await send(CREW, { category: "bug", message: "é".repeat(1900) })).status).toBe(201);
      expect((await send(CREW, { category: "bug", message: "\u{1F9E4}".repeat(1100) })).status).toBe(413);
    });
  });

  describe("while the team isn't open for edits", () => {
    it("takes a report from a member of a closed team, and of one that's read-only for billing", async () => {
      team("team-closed", { [CREW]: "viewer" }, { closedAt: "2026-10-01T00:00:00.000Z", purgeAfter: "2026-10-31T00:00:00.000Z" });
      team("team-unpaid", { [CREW]: "viewer" }, { status: "unpaid" });
      expect((await send(CREW, valid, { teamId: "team-closed" })).status).toBe(201);
      expect((await send(CREW, valid, { teamId: "team-unpaid" })).status).toBe(201);
      expect(reports("team-closed")).toHaveLength(1);
      expect(reports("team-unpaid")).toHaveLength(1);
    });

    it("refuses once the purge has marked the team, and for a team that's gone from under the request", async () => {
      team("team-purging", { [CREW]: "viewer" }, { closedAt: "2026-10-01T00:00:00.000Z", purgeAfter: "2026-10-09T00:00:00.000Z", purging: "2026-10-09T11:00:00.000Z" });
      expect(await send(CREW, valid, { teamId: "team-purging" })).toEqual(refused(409, "aborted", "team_deleting"));
      expect(reports("team-purging")).toHaveLength(0);
      expect(table.get(`USER#${CREW}`, "LIMIT#FEEDBACK#2026-10-09")).toBeUndefined();
      // The membership check passed, then the team went: the transaction's own check refuses it
      table.beforeTransactWrite = () => table.delete("TEAM#team-a", "META");
      expect(await send(CREW, valid)).toEqual(refused(409, "aborted", "team_deleting"));
      table.beforeTransactWrite = undefined;
      expect(reports()).toHaveLength(0);
    });

    it("refuses an account that's being deleted", async () => {
      table.beforeTransactWrite = () => table.put({ PK: `USER#${CREW}`, SK: "DELETING", startedAt: new Date(now).toISOString() });
      const response = await send(CREW, valid);
      expect(response.status).toBe(409);
      expect(reports()).toHaveLength(0);
    });
  });

  describe("privacy", () => {
    it("keeps the text out of logs, metrics and errors, and the email out of the table", async () => {
      const text = { category: "bug", message: SECRET, expected: "EXPECTED-TEXT-5512", context: { build: "9.9.9-BUILD" } };
      const sent = await send(CREW, text, { key: "privacy-key-0001" });
      await send(CREW, text, { key: "privacy-key-0001" });
      await send(OUTSIDER, text, { teamId: "team-a" });
      const bad = await send(CREW, { ...text, message: "" });
      const unknown = await send(CREW, { ...text, userId: SECRET });
      const dump = JSON.stringify({ logs, counts, errors: [bad, unknown], sent });
      for (const needle of [SECRET, "ZEBRA", "EXPECTED-TEXT", "9.9.9-BUILD", "crew@example.com", "owner@example.com"]) expect(dump, needle).not.toContain(needle);
      // What is logged and counted: IDs and the category
      expect(counts).toEqual([{ metric: BusinessMetric.FeedbackReceived, metadata: { teamId: "team-a", category: "bug" } }]);
      expect(logs.filter((l) => l[1] === "Report received")).toEqual([["info", "Report received", { teamId: "team-a", reportId: sent.body.report.id, category: "bug" }]]);
    });

    it("can't be listed, fetched or changed by the data role or any data route", async () => {
      await send(CREW, valid);
      const id = reports()[0]?.reportId as string;
      // The role's partitions (LeadingKeys): the team's and its project index, never FEEDBACK#
      const dataDb = table.dataDb("team-a");
      const refusal = { name: "AccessDeniedException" };
      const { GetCommand, QueryCommand, PutCommand, UpdateCommand, DeleteCommand } = await import("@aws-sdk/lib-dynamodb");
      const { connection } = await import("../src/data/client.js");
      const { doc, } = connection(dataDb);
      await expect(doc.send(new GetCommand({ TableName: dataDb.tableName, Key: { PK: "FEEDBACK#team-a", SK: `REPORT#${id}` } }))).rejects.toMatchObject(refusal);
      await expect(doc.send(new QueryCommand({ TableName: dataDb.tableName, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": "FEEDBACK#team-a" } }))).rejects.toMatchObject(refusal);
      await expect(doc.send(new PutCommand({ TableName: dataDb.tableName, Item: { PK: "FEEDBACK#team-a", SK: "REPORT#forged" } }))).rejects.toMatchObject(refusal);
      await expect(doc.send(new UpdateCommand({ TableName: dataDb.tableName, Key: { PK: "FEEDBACK#team-a", SK: `REPORT#${id}` }, UpdateExpression: "SET message = :m", ExpressionAttributeValues: { ":m": "x" } }))).rejects.toMatchObject(refusal);
      await expect(doc.send(new DeleteCommand({ TableName: dataDb.tableName, Key: { PK: "FEEDBACK#team-a", SK: `REPORT#${id}` } }))).rejects.toMatchObject(refusal);
      // Nor the status index
      await expect(doc.send(new QueryCommand({ TableName: dataDb.tableName, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "FEEDBACK#STATUS#new" } }))).rejects.toMatchObject(refusal);
      // And the data routes, called by every role, never name it: the same answers with and without a report
      const data = createDataHandler({ dbForTeam: (teamId) => table.dataDb(teamId), obs: { region: "x", logger: { info() {}, warn() {}, error() {}, addContext() {} }, count() {}, flush() {} } as unknown as Observability, now: () => now });
      for (const route of DATA_ROUTES.filter((r) => r.method === "GET" && !r.path.includes("{key}") && !r.path.includes("{projectId}"))) {
        const path = route.path.replace("{teamId}", "team-a");
        const response = await data({
          version: "2.0",
          routeKey: routeKey(route),
          rawPath: path,
          rawQueryString: "",
          headers: {},
          pathParameters: { teamId: "team-a" },
          isBase64Encoded: false,
          requestContext: {
            http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
            authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: OWNER, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER }, scopes: null } },
          },
        } as unknown as DataEvent);
        expect(response.body ?? "", path).not.toContain(SECRET);
        expect(response.body ?? "", path).not.toContain(id);
      }
    });

    it("is written through a policy that allows only a put naming the report's own attributes", async () => {
      // The account role may put into the partition and nothing more (WriteFeedbackReport): the route works under it,
      // and the policy refuses a read, a query or an update, and a put naming anything else
      await send(CREW, valid);
      expect(denied).toEqual([]);
      const policy = accountFeedbackPolicy();
      const key = { PK: "FEEDBACK#team-a", SK: "REPORT#r" };
      expect(policy("PutCommand", { Item: { ...key, message: "x" } })).toBe(true);
      expect(policy("PutCommand", { Item: { ...key, email: "x" } })).toBe(false);
      expect(policy("PutCommand", { Item: { ...key, message: "x" }, ConditionExpression: "attribute_not_exists(PK)" })).toBe(true);
      expect(policy("GetCommand", { Key: key })).toBe(false);
      expect(policy("UpdateCommand", { Key: key, UpdateExpression: "SET message = :m" })).toBe(false);
      expect(policy("DeleteCommand", { Key: key })).toBe(false);
      expect(policy("QueryCommand", { ExpressionAttributeValues: { ":pk": "FEEDBACK#team-a" } })).toBe(false);
      expect(policy("TransactWriteCommand", { TransactItems: [{ ConditionCheck: { Key: key } }] })).toBe(false);
    });
  });

  it("uses a session for the path's team and the caller only", async () => {
    await send(VIEWER, valid);
    expect(scopes.every((s) => s.userId === VIEWER && s.teamId === "team-a" && s.invitee === undefined && s.member === undefined && s.inviteLimit === undefined)).toBe(true);
  });
});

describe("storage errors", () => {
  const input = feedbackInput({ category: "bug", message: "x" });
  const failing = (error: unknown) => fakeDb(() => Promise.reject(error));

  it("passes on what it doesn't know: a transport error, and a cancellation for a reason it doesn't expect", async () => {
    const ctx = await authorizeTeam(table.db("team-a"), CREW, "team-a", new Date(NOW));
    const throttled = Object.assign(new Error("Slow down"), { name: "ProvisionedThroughputExceededException" });
    await expect(sendFeedback(failing(throttled), ctx, input, "storage-key-0001", new Date(NOW))).rejects.toBe(throttled);
    const conflict = Object.assign(new Error("Cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }, { Code: "None" }, { Code: "None" }] });
    await expect(sendFeedback(failing(conflict), ctx, input, "storage-key-0001", new Date(NOW))).rejects.toBe(conflict);
    const bare = Object.assign(new Error("Cancelled"), { name: "TransactionCanceledException" });
    await expect(sendFeedback(failing(bare), ctx, input, "storage-key-0001", new Date(NOW))).rejects.toBe(bare);
  });

  it("answers a failed triage update that isn't a missing report as it is", async () => {
    const down = Object.assign(new Error("Unavailable"), { name: "ServiceUnavailable" });
    await expect(dismissFeedback(failing(down), "team-a", "a".repeat(32))).rejects.toBe(down);
  });

  it("refuses a body with a field of its own that isn't a report's, even without the handler's own check", () => {
    expect(() => feedbackInput({ category: "bug", message: "x", teamId: "t" })).toThrow("Unexpected field");
  });
});
