// The operator page's report routes (supply-checkout-3sv.26): /ops/feedback
// against the in-memory table, every call checked against the operator-access
// role's policy (ops-policy.ts): reports read only by their own attributes
// (projected), updated only in their status fields, and only in the path's
// team's reports partition; audit items only in the operators' PLATFORM
// partition, never the team's (its owners read that one).

import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/http.js";
import { OPS_ROUTES, routeKey } from "../src/api/routes.js";
import { BEAD_ID, dismissReasonProblem, feedbackBeadId, getFeedback, hasEmail, listFeedback } from "../src/data/feedback-owner.js";
import { dismissOpsFeedback, recordOpsFeedbackBead } from "../src/data/index.js";
import { type Observability } from "../src/observability/index.js";
import type { OperatorDirectory } from "../src/operator/cognito.js";
import { createOpsHandler, type OpsEvent } from "../src/operator/ops-handler.js";
import type { ReporterContact } from "../src/operator/reporter-email.js";
import { fakeDb, REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";
import { opsPolicy } from "./ops-policy.js";

const OPS_ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_ops";
const OPS_CLIENT = "ops-client";
const NOW = Date.parse("2026-10-10T12:00:00Z");
const OPERATOR = "op-sub-1";
const TEAM_A = "team_a";
const TEAM_B = "team_b";
const USER = "11111111-2222-4333-8444-555555555555";
const EMAIL = "sender@example.com";
const SECRET_TEXT = "The scanner froze on the second scan at the Riverside job";

let table: MemoryTable;
let now: number;
let denied: { command: string; input: Record<string, unknown> }[];
let tags: string[];
let logs: unknown[];
let lookups: string[];
let contact: ReporterContact | Error;
let handler: ReturnType<typeof createOpsHandler>;

const reportId = (n: number) => n.toString(16).padStart(32, "0");

/** A stored report, as sendFeedback writes it. */
function putReport(teamId: string, n: number, extra: Record<string, unknown> = {}) {
  const id = reportId(n);
  const createdAt = new Date(NOW - (100 - n) * 60_000).toISOString();
  const status = (extra.status as string | undefined) ?? "new";
  table.put({
    PK: `FEEDBACK#${teamId}`,
    SK: `REPORT#${id}`,
    GSI1PK: `FEEDBACK#STATUS#${status}`,
    GSI1SK: `${createdAt}#${id}`,
    type: "feedback",
    reportId: id,
    shortId: id.slice(0, 8),
    teamId,
    userId: USER,
    role: "member",
    createdAt,
    category: "bug",
    message: SECRET_TEXT,
    expected: "",
    contactOk: false,
    context: { build: "1.13.0", screen: "scan", browser: "safari" },
    status,
    beadId: "",
    expiresAt: Math.floor(NOW / 1000) + 730 * 86_400,
    ...extra,
  });
  return id;
}

const stored = (teamId: string, id: string) => table.get(`FEEDBACK#${teamId}`, `REPORT#${id}`) as Record<string, unknown>;
const auditItems = () => [...table.items.values()].filter((i) => String(i.PK).startsWith("OPAUDIT#") && String(i.SK).startsWith("AUDIT#"));

function fakeObservability(): Observability {
  const log = (...args: unknown[]) => logs.push(args);
  return {
    region: REGION,
    logger: { info: log, warn: log, error: log, addContext: () => {} } as unknown as Observability["logger"],
    count: () => {},
    gauge: () => {},
    flush: () => {},
  };
}

const directory: OperatorDirectory = {
  async getUser(token) {
    const sub = token.replace(/^token-/, "");
    if (sub !== OPERATOR) throw new ApiError(401, "unauthenticated", "Sign in again");
    return { username: `name-${sub}`, sub };
  },
  async groupsFor() {
    return ["operators"];
  },
};

function event(method: string, path: string, options: { body?: unknown; query?: Record<string, string>; key?: string; groups?: string } = {}): OpsEvent {
  const segments = path.split("/");
  const route = OPS_ROUTES.find((r) => r.method === method && r.path.split("/").length === segments.length && r.path.split("/").every((s, i) => s.startsWith("{") || s === segments[i]));
  const params: Record<string, string> = {};
  route?.path.split("/").forEach((s, i) => {
    if (s.startsWith("{")) params[s.slice(1, -1)] = segments[i] as string;
  });
  const claims = { iss: OPS_ISSUER, client_id: OPS_CLIENT, token_use: "access", exp: Math.floor(now / 1000) + 900, sub: OPERATOR, "cognito:groups": options.groups ?? "[operators]" };
  return {
    routeKey: route ? routeKey(route) : `${method} ${path}`,
    rawPath: path,
    headers: { authorization: `Bearer token-${OPERATOR}`, ...(options.key ? { "idempotency-key": options.key } : {}) },
    queryStringParameters: options.query,
    pathParameters: params,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims, scopes: [] } } },
  } as unknown as OpsEvent;
}

async function call(method: string, path: string, options: Parameters<typeof event>[2] = {}) {
  const response = await handler(event(method, path, options));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

function makeHandler(withLookup = true) {
  return createOpsHandler({
    dbFor: (_sub, teamId) => {
      tags.push(teamId ?? ".");
      return table.guarded(opsPolicy(teamId ?? ".", denied));
    },
    reopen: async () => {
      throw new Error("not used");
    },
    directory,
    ...(withLookup
      ? {
          reporterEmail: async (userId: string) => {
            lookups.push(userId);
            if (contact instanceof Error) throw contact;
            return contact;
          },
        }
      : {}),
    issuerUrl: OPS_ISSUER,
    clientId: OPS_CLIENT,
    obs: fakeObservability(),
    now: () => now,
  });
}

beforeEach(() => {
  now = NOW;
  table = new MemoryTable();
  denied = [];
  tags = [];
  logs = [];
  lookups = [];
  contact = { email: EMAIL };
  handler = makeHandler();
});

describe("listing reports", () => {
  it("lists one status's reports across teams, oldest first, paged, and audits which it returned", async () => {
    const first = putReport(TEAM_A, 1);
    const second = putReport(TEAM_B, 2);
    putReport(TEAM_A, 3, { status: "dismissed", dismissReason: "Duplicate" });
    const page = await call("GET", "/ops/feedback", { query: { limit: "1" } });
    expect(page.status).toBe(200);
    expect(page.body.reports).toEqual([
      {
        reportId: first,
        shortId: first.slice(0, 8),
        teamId: TEAM_A,
        userId: USER,
        role: "member",
        createdAt: expect.any(String),
        category: "bug",
        message: SECRET_TEXT,
        expected: "",
        contactOk: false,
        context: { build: "1.13.0", screen: "scan", browser: "safari" },
        status: "new",
        beadId: null,
        statusAt: null,
        dismissReason: null,
      },
    ]);
    const next = await call("GET", "/ops/feedback", { query: { limit: "1", cursor: page.body.cursor } });
    expect(next.body.reports.map((r: { reportId: string }) => r.reportId)).toEqual([second]);
    const dismissed = await call("GET", "/ops/feedback", { query: { status: "dismissed" } });
    expect(dismissed.body.reports).toHaveLength(1);
    expect(dismissed.body.reports[0].dismissReason).toBe("Duplicate");
    expect(dismissed.body.cursor).toBeUndefined();
    // Read on an untagged session, through the policy
    expect(tags).toEqual([".", ".", "."]);
    expect(denied).toEqual([]);
    // Audited in the operators' partition only, by ID, never the text
    const audits = auditItems();
    expect(audits.map((a) => [a.PK, a.action, a.target])).toEqual([
      ["OPAUDIT#PLATFORM", "ops.feedback.list", "feedback"],
      ["OPAUDIT#PLATFORM", "ops.feedback.list", "feedback"],
      ["OPAUDIT#PLATFORM", "ops.feedback.list", "feedback"],
    ]);
    expect(audits[0]).toMatchObject({ before: null, after: { status: "new", cursor: null, reports: [`${TEAM_A}/${first}`] } });
    expect(JSON.stringify(audits)).not.toContain(SECRET_TEXT);
  });

  it.each<Record<string, string>>([{ status: "open" }, { limit: "0" }, { limit: "101" }, { cursor: "not-a-cursor" }])("refuses %o", async (query) => {
    expect((await call("GET", "/ops/feedback", { query })).status).toBe(400);
    expect(auditItems()).toEqual([]);
  });

  it("refuses a body, and a cursor from another status", async () => {
    putReport(TEAM_A, 1);
    putReport(TEAM_A, 2);
    expect((await call("GET", "/ops/feedback", { body: { status: "new" } })).status).toBe(400);
    const page = await call("GET", "/ops/feedback", { query: { limit: "1" } });
    expect((await call("GET", "/ops/feedback", { query: { status: "triaged", cursor: page.body.cursor } })).status).toBe(400);
  });

  it("is for operators only", async () => {
    expect((await call("GET", "/ops/feedback", { groups: "" })).status).toBe(403);
    expect(table.calls).toEqual([]);
  });
});

describe("reading one report", () => {
  it("returns a report without contact OK, with no email lookup, audited as a read", async () => {
    const id = putReport(TEAM_A, 1);
    const res = await call("GET", `/ops/feedback/${TEAM_A}/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ report: { reportId: id, teamId: TEAM_A, message: SECRET_TEXT, contactOk: false }, email: null, emailNote: null });
    expect(lookups).toEqual([]);
    // On a session tagged with the path's team: the role reads FEEDBACK#<tag> only
    expect(tags).toEqual([TEAM_A]);
    expect(denied).toEqual([]);
    expect(auditItems()).toEqual([expect.objectContaining({ PK: "OPAUDIT#PLATFORM", teamId: "PLATFORM", action: "ops.feedback.read", target: `feedback/${TEAM_A}/${id}`, before: null, after: { status: "new", emailLookup: false } })]);
  });

  it("looks up the sender's verified email for a report with contact OK, only after auditing it as a personal-data read", async () => {
    const id = putReport(TEAM_A, 1, { contactOk: true });
    let auditedFirst = false;
    handler = createOpsHandler({
      dbFor: (_sub, teamId) => table.guarded(opsPolicy(teamId ?? ".", denied)),
      reopen: async () => {
        throw new Error("not used");
      },
      directory,
      reporterEmail: async (userId) => {
        auditedFirst = auditItems().some((a) => a.action === "ops.feedback.email");
        lookups.push(userId);
        return { email: EMAIL };
      },
      issuerUrl: OPS_ISSUER,
      clientId: OPS_CLIENT,
      obs: fakeObservability(),
      now: () => now,
    });
    const res = await call("GET", `/ops/feedback/${TEAM_A}/${id}`);
    expect(res.body).toMatchObject({ email: EMAIL, emailNote: null, report: { contactOk: true } });
    expect(lookups).toEqual([USER]);
    expect(auditedFirst).toBe(true);
    const [audit] = auditItems();
    expect(audit).toMatchObject({ action: "ops.feedback.email", after: { status: "new", emailLookup: true } });
    // No email, report text or name in the audit or the logs
    expect(JSON.stringify(audit)).not.toContain(EMAIL);
    expect(JSON.stringify(logs)).not.toContain(EMAIL);
    expect(JSON.stringify(logs)).not.toContain(SECRET_TEXT);
  });

  it.each<[string, ReporterContact | Error | undefined, string]>([
    ["no such native user", { email: null, why: "not_found" }, "not_found"],
    ["no address the API trusts", { email: null, why: "unverified" }, "unverified"],
    ["a failed lookup", Object.assign(new Error("AdminGetUser failed: 500"), { name: "InternalErrorException" }), "unavailable"],
    ["no lookup configured", undefined, "unavailable"],
  ])("still returns the report with %s, saying why there's no email", async (_what, found, note) => {
    const id = putReport(TEAM_A, 1, { contactOk: true });
    if (found === undefined) handler = makeHandler(false);
    else contact = found;
    const res = await call("GET", `/ops/feedback/${TEAM_A}/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: null, emailNote: note, report: { reportId: id } });
    if (found instanceof Error) expect(JSON.stringify(logs)).toContain("InternalErrorException");
  });

  it("answers 404 for a missing report or one in another team, and audits nothing", async () => {
    const id = putReport(TEAM_A, 1);
    expect((await call("GET", `/ops/feedback/${TEAM_B}/${id}`)).status).toBe(404);
    expect((await call("GET", `/ops/feedback/${TEAM_A}/${reportId(9)}`)).status).toBe(404);
    expect(auditItems()).toEqual([]);
    expect(denied).toEqual([]);
  });

  it.each([
    ["a short ID", `/ops/feedback/${TEAM_A}/00000001`],
    ["an uppercase ID", `/ops/feedback/${TEAM_A}/${"A".repeat(32)}`],
    ["a bad team ID", `/ops/feedback/bad.team/${"a".repeat(32)}`],
  ])("refuses %s", async (_what, path) => {
    expect((await call("GET", path)).status).toBe(400);
    expect(table.calls).toEqual([]);
  });

  it("the policy refuses a read of another team's report on a session tagged with this team", async () => {
    const id = putReport(TEAM_B, 1);
    await expect(getFeedback(table.guarded(opsPolicy(TEAM_A, denied)), TEAM_B, id)).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(denied).toHaveLength(1);
  });

  it("every read names the report's attributes only (a projection), as the role requires", async () => {
    putReport(TEAM_A, 1);
    const db = fakeDb(async (command) => {
      const input = command.input as Record<string, unknown>;
      expect(typeof input.ProjectionExpression).toBe("string");
      expect(Object.values(input.ExpressionAttributeNames as Record<string, string>)).not.toContain("PK");
      return "IndexName" in input ? { Items: [] } : { Item: undefined };
    });
    await listFeedback(db);
    await getFeedback(db, TEAM_A, reportId(1));
  });
});

describe("dismissing a report", () => {
  it("dismisses a new report with a reason: the status fields, the audit and the key's record in one transaction", async () => {
    const id = putReport(TEAM_A, 1);
    const res = await call("POST", `/ops/feedback/${TEAM_A}/${id}/dismiss`, { body: { reason: "  Not a bug: works as designed  " }, key: "dismiss-key-0001" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ eventId: expect.any(String), replayed: false, report: { reportId: id, status: "dismissed", beadId: null, dismissReason: "Not a bug: works as designed", statusAt: new Date(NOW).toISOString() } });
    expect(stored(TEAM_A, id)).toMatchObject({ status: "dismissed", GSI1PK: "FEEDBACK#STATUS#dismissed", dismissReason: "Not a bug: works as designed", message: SECRET_TEXT });
    expect(tags).toEqual([TEAM_A]);
    expect(denied).toEqual([]);
    const transaction = table.requests.find((r) => r.command === "TransactWriteCommand");
    expect((transaction?.input.TransactItems as unknown[]).length).toBe(3);
    const [audit] = auditItems();
    expect(audit).toMatchObject({
      PK: "OPAUDIT#PLATFORM",
      action: "ops.feedback.dismiss",
      target: `feedback/${TEAM_A}/${id}`,
      reason: "Not a bug: works as designed",
      before: { status: "new" },
      after: { status: "dismissed", beadId: "" },
      idempotencyKey: "dismiss-key-0001",
      eventId: res.body.eventId,
    });
    // Nothing in the team's own audit partition, which its owners read
    expect([...table.items.values()].filter((i) => i.PK === `OPAUDIT#${TEAM_A}`)).toEqual([]);
  });

  it("replays a retry with the same key, and answers a repeat with another key with the report as it is", async () => {
    const id = putReport(TEAM_A, 1);
    const first = await call("POST", `/ops/feedback/${TEAM_A}/${id}/dismiss`, { body: { reason: "Duplicate" }, key: "dismiss-key-0001" });
    const retry = await call("POST", `/ops/feedback/${TEAM_A}/${id}/dismiss`, { body: { reason: "Duplicate" }, key: "dismiss-key-0001" });
    expect(retry.body).toMatchObject({ eventId: first.body.eventId, replayed: true, report: { status: "dismissed" } });
    const again = await call("POST", `/ops/feedback/${TEAM_A}/${id}/dismiss`, { body: { reason: "Duplicate" }, key: "dismiss-key-0002" });
    expect(again.body).toMatchObject({ eventId: null, replayed: true, report: { status: "dismissed" } });
    // The same key for another request
    expect((await call("POST", `/ops/feedback/${TEAM_A}/${id}/dismiss`, { body: { reason: "Something else" }, key: "dismiss-key-0001" })).status).toBe(409);
    expect(auditItems()).toHaveLength(1);
    expect(denied).toEqual([]);
  });

  it("refuses to dismiss a triaged report, naming its bead, never its text", async () => {
    const id = putReport(TEAM_A, 1, { status: "triaged", beadId: "supply-checkout-abc.1" });
    const res = await call("POST", `/ops/feedback/${TEAM_A}/${id}/dismiss`, { body: { reason: "Duplicate" }, key: "dismiss-key-0001" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe("This report is already triaged (bead supply-checkout-abc.1)");
    expect(stored(TEAM_A, id)).toMatchObject({ status: "triaged", beadId: "supply-checkout-abc.1" });
    expect(auditItems()).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string | undefined]>([
    ["no reason", {}, "dismiss-key-0001"],
    ["a short reason", { reason: "no" }, "dismiss-key-0001"],
    ["a long reason", { reason: "x".repeat(201) }, "dismiss-key-0001"],
    ["a reason over two lines", { reason: "Not a bug\nreally" }, "dismiss-key-0001"],
    ["a reason that isn't text", { reason: 42 }, "dismiss-key-0001"],
    ["a reason with an email address", { reason: `Wrote to ${EMAIL}` }, "dismiss-key-0001"],
    ["a reason quoting the report", { reason: SECRET_TEXT.toUpperCase() }, "dismiss-key-0001"],
    ["a reason naming the sender", { reason: `Sender ${USER} again` }, "dismiss-key-0001"],
    ["another field", { reason: "Duplicate", status: "triaged" }, "dismiss-key-0001"],
    ["no Idempotency-Key", { reason: "Duplicate" }, undefined],
  ])("refuses %s, changing nothing", async (_what, body, key) => {
    const id = putReport(TEAM_A, 1);
    const res = await call("POST", `/ops/feedback/${TEAM_A}/${id}/dismiss`, { body, key });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TEXT);
    expect(stored(TEAM_A, id)).toMatchObject({ status: "new" });
    expect(auditItems()).toEqual([]);
  });

  it("answers 404 for a report that isn't there", async () => {
    expect((await call("POST", `/ops/feedback/${TEAM_A}/${reportId(5)}/dismiss`, { body: { reason: "Duplicate" }, key: "dismiss-key-0001" })).status).toBe(404);
  });
});

describe("recording a report's bead", () => {
  it("marks a new report triaged with this project's bead, audited with the key", async () => {
    const id = putReport(TEAM_A, 1);
    const res = await call("POST", `/ops/feedback/${TEAM_A}/${id}/record`, { body: { beadId: "supply-checkout-3sv.26" }, key: "record-key-0001" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ eventId: expect.any(String), replayed: false, report: { status: "triaged", beadId: "supply-checkout-3sv.26", dismissReason: null } });
    expect(stored(TEAM_A, id)).toMatchObject({ status: "triaged", beadId: "supply-checkout-3sv.26", GSI1PK: "FEEDBACK#STATUS#triaged" });
    expect(auditItems()).toEqual([expect.objectContaining({ PK: "OPAUDIT#PLATFORM", action: "ops.feedback.record", reason: "bead supply-checkout-3sv.26", before: { status: "new" }, after: { status: "triaged", beadId: "supply-checkout-3sv.26" } })]);
    expect(denied).toEqual([]);
    // The CLI sees the same: it's on the triaged list now
    const listed = await listFeedback(table.db(), { status: "triaged" });
    expect(listed.items.map((r) => r.reportId)).toEqual([id]);
    // The same bead again is a repeat; another bead is a conflict
    expect((await call("POST", `/ops/feedback/${TEAM_A}/${id}/record`, { body: { beadId: "supply-checkout-3sv.26" }, key: "record-key-0002" })).body).toMatchObject({ eventId: null, replayed: true });
    const other = await call("POST", `/ops/feedback/${TEAM_A}/${id}/record`, { body: { beadId: "supply-checkout-3sv.27" }, key: "record-key-0003" });
    expect(other.status).toBe(409);
    expect(other.body.error.message).toBe("This report is already triaged (bead supply-checkout-3sv.26)");
  });

  it.each([["another project's bead", "other-abc.1"], ["text", "not a bead!"], ["a number", 7], ["an uppercase bead", "supply-checkout-ABC"], ["nothing", undefined]])("refuses %s", async (_what, beadId) => {
    const id = putReport(TEAM_A, 1);
    expect((await call("POST", `/ops/feedback/${TEAM_A}/${id}/record`, { body: { beadId }, key: "record-key-0001" })).status).toBe(400);
    expect(stored(TEAM_A, id)).toMatchObject({ status: "new" });
  });

  it("refuses to record a bead for a dismissed report, or one that isn't there", async () => {
    const id = putReport(TEAM_A, 1, { status: "dismissed", dismissReason: "Spam" });
    expect((await call("POST", `/ops/feedback/${TEAM_A}/${id}/record`, { body: { beadId: "supply-checkout-abc.1" }, key: "record-key-0001" })).status).toBe(409);
    expect((await call("POST", `/ops/feedback/${TEAM_A}/${reportId(8)}/record`, { body: { beadId: "supply-checkout-abc.1" }, key: "record-key-0002" })).status).toBe(404);
  });

  it("the policy refuses a change to another team's report, or to any other attribute", async () => {
    const id = putReport(TEAM_B, 1);
    const op = { sub: OPERATOR };
    await expect(recordOpsFeedbackBead(table.guarded(opsPolicy(TEAM_A, denied)), op, TEAM_B, id, { beadId: "supply-checkout-abc.1", idempotencyKey: "record-key-0001" })).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(stored(TEAM_B, id)).toMatchObject({ status: "new" });
    const policy = opsPolicy(TEAM_B);
    expect(policy("UpdateCommand", { Key: { PK: `FEEDBACK#${TEAM_B}`, SK: `REPORT#${id}` }, UpdateExpression: "SET message = :m", ExpressionAttributeValues: { ":m": "x" } })).toBe(false);
    expect(policy("UpdateCommand", { Key: { PK: `FEEDBACK#${TEAM_B}`, SK: `REPORT#${id}` }, UpdateExpression: "SET #s = :s", ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": "new" }, ReturnValues: "ALL_NEW" })).toBe(false);
    expect(policy("GetCommand", { Key: { PK: `FEEDBACK#${TEAM_B}`, SK: `REPORT#${id}` } })).toBe(false);
    expect(policy("QueryCommand", { IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "FEEDBACK#STATUS#new" } })).toBe(false);
  });
});

describe("the data functions", () => {
  it("dismissOpsFeedback and recordOpsFeedbackBead need an operator and a key before reading anything", async () => {
    const never = fakeDb(() => Promise.reject(new Error("must not be called")));
    await expect(dismissOpsFeedback(never, { sub: "" }, TEAM_A, reportId(1), { reason: "Duplicate", idempotencyKey: "key-00001" })).rejects.toThrow();
    await expect(dismissOpsFeedback(never, { sub: OPERATOR }, TEAM_A, reportId(1), { reason: "Duplicate", idempotencyKey: "short" })).rejects.toThrow("Idempotency-Key");
    await expect(recordOpsFeedbackBead(never, { sub: OPERATOR }, TEAM_A, reportId(1), { beadId: "supply-checkout-a", idempotencyKey: undefined })).rejects.toThrow("Idempotency-Key");
  });

  it("checks bead IDs and dismissal reasons as the CLI does", () => {
    expect(BEAD_ID.test("supply-checkout-3sv.26")).toBe(true);
    expect(BEAD_ID.test(`supply-checkout-${"a".repeat(49)}`)).toBe(false);
    expect(feedbackBeadId("supply-checkout-abc")).toBe("supply-checkout-abc");
    expect(() => feedbackBeadId("supply-checkout-")).toThrow("Invalid bead ID");
    expect(hasEmail("ｍe＠example.com")).toBe(true);
    expect(hasEmail("no address here")).toBe(false);
    const report = { message: "help", expected: "", teamId: TEAM_A, userId: USER, reportId: reportId(1) };
    expect(dismissReasonProblem("Help", report)).toBe("The reason can't hold the report's own words or IDs");
    expect(dismissReasonProblem(`see ${TEAM_A.toUpperCase()}`, report)).toBe("The reason can't hold the report's own words or IDs");
    expect(dismissReasonProblem("Duplicate of a known issue", report)).toBeUndefined();
  });
});
