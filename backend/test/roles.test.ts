// Every team route, called by every role (ADR 0007): owner, contributor,
// viewer and someone outside the team. A role below the route's gets 403
// `permission_denied` with the reason the client acts on, and nothing is
// written; a role at or above it gets through. Against the in-memory table,
// with each request's handle scoped as IAM would scope it.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import { createDataHandler, type DataEvent } from "../src/api/data-handler.js";
import { hasRole, requireRole } from "../src/api/roles.js";
import { ACCOUNT_ROUTES, DATA_ROUTES, routeKey, TEAM_ROLES, type TeamRole } from "../src/api/routes.js";
import { hashEmail, InvalidInputError } from "../src/data/index.js";
import type { Observability } from "../src/observability/index.js";
import { accountPartitions, fakeMailer, unusedDeleteUser, unusedDeletionLog, unusedEmailCodes, unusedTotp } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const mails = fakeMailer();
const NOW = Date.parse("2026-09-26T12:00:00Z");
const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const USERS = { owner: "user-owner", contributor: "user-contributor", viewer: "user-viewer", outsider: "user-outsider" } as const;
type Caller = keyof typeof USERS;
const CALLERS = Object.keys(USERS) as Caller[];
const SECOND_OWNER = "user-owner-2";
const TARGET = "user-target";
const INVITE = "invite-1";

const obs = {
  region: "test-local-1",
  logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} },
  count: () => {},
  flush: () => {},
} as unknown as Observability;

let table: MemoryTable;
let dataHandler: ReturnType<typeof createDataHandler>;
let accountHandler: ReturnType<typeof createAccountHandler>;

function seed() {
  table = new MemoryTable();
  table.seedTeam("team-a", { [USERS.owner]: "owner", [SECOND_OWNER]: "owner", [USERS.contributor]: "contributor", [USERS.viewer]: "viewer", [TARGET]: "viewer" });
  table.seedTeam("team-b", { [USERS.outsider]: "owner" });
  for (const [userId, role] of [[USERS.owner, "owner"], [SECOND_OWNER, "owner"], [USERS.contributor, "contributor"], [USERS.viewer, "viewer"], [TARGET, "viewer"]]) {
    table.put({ PK: `USER#${userId}`, SK: "TEAM#team-a", type: "userTeam", userId, teamId: "team-a", teamName: "team-a", role });
  }
  table.put({
    PK: "TEAM#team-a",
    SK: `INVITE#${INVITE}`,
    GSI1PK: `INVITE#${"0".repeat(64)}`,
    GSI1SK: "INVITE",
    GSI2PK: `INVITEE#${hashEmail("invited@example.com")}`,
    GSI2SK: `INVITE#${INVITE}`,
    type: "invite",
    teamId: "team-a",
    teamName: "team-a",
    inviteId: INVITE,
    email: "invited@example.com",
    role: "viewer",
    invitedBy: USERS.owner,
    createdAt: "2026-09-25T12:00:00.000Z",
    expiresAt: NOW / 1000 + 86400,
  });
  table.put({ PK: "TEAM#team-a", SK: "PRODUCT#0123", type: "product", key: "0123", version: 3, code: "0123", name: "Nitrile gloves", price: 12.5, stock: 10 });
  table.put({
    PK: "TEAM#team-a",
    SK: "SHEET#s1",
    type: "sheet",
    id: "s1",
    version: 1,
    client: "Echo",
    date: "2026-09-26",
    status: "open",
    items: {
      "0123": { code: "0123", name: "Nitrile gloves", price: 12.5, out: 2, returned: 0 },
      ladder: { code: "", name: "Ladder", kind: "equipment", cost: 120, out: 1, returned: 0 },
    },
  });
  // The team's open ad hoc sheet (ADR 0017), for the move
  table.put({ PK: "TEAM#team-a", SK: "ADHOC", type: "adhoc", count: 1, open: "adhoc-1", version: 1 });
  table.put({
    PK: "TEAM#team-a",
    SK: "SHEET#adhoc-1",
    type: "sheet",
    id: "adhoc-1",
    version: 1,
    kind: "adhoc",
    client: "",
    date: "2026-09-26",
    status: "open",
    items: { rags: { code: "", name: "Rags", price: 1.5, out: 3, returned: 0 } },
  });
  dataHandler = createDataHandler({
    dbForTeam: (teamId) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(teamId)) throw new InvalidInputError("Invalid team ID");
      return table.db(teamId);
    },
    obs,
    now: () => NOW,
  });
  const dbFor: DbForAccount = (scope) =>
    table.scoped(accountPartitions(scope));
  accountHandler = createAccountHandler({ dbFor, userInfo: async () => Promise.reject(new Error("not used")), issuerUrl: ISSUER, obs, mailer: mails.mailer, deleteUser: unusedDeleteUser, deletions: unusedDeletionLog, emailCodes: unusedEmailCodes, totp: unusedTotp, now: () => NOW });
}

beforeEach(seed);

function event(routes: readonly { method: string; path: string }[], method: string, path: string, user: string, body?: unknown, query?: Record<string, string>): DataEvent {
  const [rawPath] = path.split("?");
  const segments = (rawPath as string).split("/");
  const route = routes.find((r) => {
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
    rawPath,
    rawQueryString: "",
    headers: {},
    queryStringParameters: query,
    pathParameters,
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(NOW / 1000 + 600), iss: ISSUER }, scopes: null } },
    },
  } as unknown as DataEvent;
}

interface Case {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly query?: Record<string, string>;
  readonly minRole: TeamRole;
}

/** A request each data route answers with a 2xx for a role that may call it. */
const DATA_CASES: Record<string, Omit<Case, "minRole">> = {
  "GET /teams/{teamId}/products": { method: "GET", path: "/teams/team-a/products" },
  "GET /teams/{teamId}/products/{key}": { method: "GET", path: "/teams/team-a/products/0123" },
  "PUT /teams/{teamId}/products/{key}": { method: "PUT", path: "/teams/team-a/products/0123", body: { data: { code: "0123", name: "Gloves", price: 13 }, expectedVersion: 3 } },
  "PATCH /teams/{teamId}/products/{key}": { method: "PATCH", path: "/teams/team-a/products/0123", body: { data: { name: "Gloves" }, expectedVersion: 3 } },
  "DELETE /teams/{teamId}/products/{key}": { method: "DELETE", path: "/teams/team-a/products/0123", query: { expectedVersion: "3" } },
  "GET /teams/{teamId}/sheets": { method: "GET", path: "/teams/team-a/sheets" },
  "GET /teams/{teamId}/sheets/{sheetId}": { method: "GET", path: "/teams/team-a/sheets/s1" },
  "PUT /teams/{teamId}/sheets/{sheetId}": { method: "PUT", path: "/teams/team-a/sheets/s2", body: { data: { client: "Delta", date: "2026-09-27", items: {} }, expectedVersion: 0 } },
  "PATCH /teams/{teamId}/sheets/{sheetId}": { method: "PATCH", path: "/teams/team-a/sheets/s1", body: { data: { client: "Echo 2" }, expectedVersion: 1 } },
  "DELETE /teams/{teamId}/sheets/{sheetId}": { method: "DELETE", path: "/teams/team-a/sheets/s1", query: { expectedVersion: "1" } },
  "POST /teams/{teamId}/sheets/{sheetId}/checkout": { method: "POST", path: "/teams/team-a/sheets/s1/checkout", body: { operationId: randomUUID(), productKey: "0123", quantity: 1 } },
  "POST /teams/{teamId}/adhoc/checkout": { method: "POST", path: "/teams/team-a/adhoc/checkout", body: { operationId: randomUUID(), productKey: "0123", quantity: 1 } },
  "POST /teams/{teamId}/sheets/{sheetId}/move": { method: "POST", path: "/teams/team-a/sheets/adhoc-1/move", body: { operationId: randomUUID(), productKey: "rags", toSheetId: "s1" } },
  "POST /teams/{teamId}/sheets/{sheetId}/lines": { method: "POST", path: "/teams/team-a/sheets/s1/lines", body: { operationId: randomUUID(), lines: [{ productKey: "k-1", quantity: 1, name: "Rags", price: 1.5 }] } },
  "POST /teams/{teamId}/sheets/{sheetId}/return": { method: "POST", path: "/teams/team-a/sheets/s1/return", body: { operationId: randomUUID(), productKey: "0123", quantity: 1 } },
  "POST /teams/{teamId}/sheets/{sheetId}/lost": { method: "POST", path: "/teams/team-a/sheets/s1/lost", body: { operationId: randomUUID(), productKey: "ladder", quantity: 1, charge: 50 } },
  // The same routes under the projects name (supply-checkout-005.6), with the new field names
  "GET /teams/{teamId}/projects": { method: "GET", path: "/teams/team-a/projects" },
  "GET /teams/{teamId}/projects/{projectId}": { method: "GET", path: "/teams/team-a/projects/s1" },
  "PUT /teams/{teamId}/projects/{projectId}": { method: "PUT", path: "/teams/team-a/projects/s2", body: { data: { client: "Delta", date: "2026-09-27", items: {} }, expectedVersion: 0 } },
  "PATCH /teams/{teamId}/projects/{projectId}": { method: "PATCH", path: "/teams/team-a/projects/s1", body: { data: { client: "Echo 2" }, expectedVersion: 1 } },
  "DELETE /teams/{teamId}/projects/{projectId}": { method: "DELETE", path: "/teams/team-a/projects/s1", query: { expectedVersion: "1" } },
  "POST /teams/{teamId}/projects/{projectId}/checkout": { method: "POST", path: "/teams/team-a/projects/s1/checkout", body: { operationId: randomUUID(), productKey: "0123", quantity: 1 } },
  "POST /teams/{teamId}/projects/{projectId}/move": { method: "POST", path: "/teams/team-a/projects/adhoc-1/move", body: { operationId: randomUUID(), productKey: "rags", toProjectId: "s1" } },
  "POST /teams/{teamId}/projects/{projectId}/lines": { method: "POST", path: "/teams/team-a/projects/s1/lines", body: { operationId: randomUUID(), lines: [{ productKey: "k-1", quantity: 1, name: "Rags", price: 1.5 }] } },
  "POST /teams/{teamId}/projects/{projectId}/return": { method: "POST", path: "/teams/team-a/projects/s1/return", body: { operationId: randomUUID(), productKey: "0123", quantity: 1 } },
  "POST /teams/{teamId}/projects/{projectId}/lost": { method: "POST", path: "/teams/team-a/projects/s1/lost", body: { operationId: randomUUID(), productKey: "ladder", quantity: 1, charge: 50 } },
  "GET /teams/{teamId}/settings": { method: "GET", path: "/teams/team-a/settings" },
  "PUT /teams/{teamId}/settings": { method: "PUT", path: "/teams/team-a/settings", body: { equipmentMarkup: 25, expectedVersion: 0 } },
  "POST /teams/{teamId}/products/{key}/stock": { method: "POST", path: "/teams/team-a/products/0123/stock", body: { operationId: randomUUID(), reason: "count", count: 4 } },
  "GET /teams/{teamId}/products/{key}/movements": { method: "GET", path: "/teams/team-a/products/0123/movements" },
  "POST /teams/{teamId}/imports": { method: "POST", path: "/teams/team-a/imports", body: { importId: randomUUID(), csv: "name,price\nRags,1.5\n" } },
  "GET /teams/{teamId}/support-actions": { method: "GET", path: "/teams/team-a/support-actions" },
};

/** The same for the team routes the account function serves. */
const MEMBER_CASES: Record<string, Omit<Case, "minRole">> = {
  "GET /teams/{teamId}/members": { method: "GET", path: "/teams/team-a/members" },
  "PATCH /teams/{teamId}/members/{userId}": { method: "PATCH", path: `/teams/team-a/members/${TARGET}`, body: { role: "contributor" } },
  "DELETE /teams/{teamId}/members/{userId}": { method: "DELETE", path: `/teams/team-a/members/${TARGET}` },
  "GET /teams/{teamId}/invites": { method: "GET", path: "/teams/team-a/invites" },
  "POST /teams/{teamId}/invites": { method: "POST", path: "/teams/team-a/invites", body: { email: "new@example.com", role: "viewer" } },
  "DELETE /teams/{teamId}/invites/{inviteId}": { method: "DELETE", path: `/teams/team-a/invites/${INVITE}` },
  "POST /teams/{teamId}/invites/{inviteId}/resend": { method: "POST", path: `/teams/team-a/invites/${INVITE}/resend` },
  "POST /teams/{teamId}/close": { method: "POST", path: "/teams/team-a/close", body: { name: "team-a" } },
  "POST /teams/{teamId}/reopen": { method: "POST", path: "/teams/team-a/reopen", body: { name: "team-a" } },
};
const MEMBER_MIN_ROLE: Record<string, TeamRole> = {
  "GET /teams/{teamId}/members": "owner",
  "PATCH /teams/{teamId}/members/{userId}": "owner",
  "DELETE /teams/{teamId}/members/{userId}": "owner",
  "GET /teams/{teamId}/invites": "owner",
  "POST /teams/{teamId}/invites": "owner",
  "DELETE /teams/{teamId}/invites/{inviteId}": "owner",
  "POST /teams/{teamId}/invites/{inviteId}/resend": "owner",
  "POST /teams/{teamId}/close": "owner",
  "POST /teams/{teamId}/reopen": "owner",
};

const TEAM_ACCOUNT_ROUTES = ACCOUNT_ROUTES.filter((r) => r.path.startsWith("/teams/{teamId}"));
const WRITE_COMMANDS = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"]);

const cases: [string, Case, "data" | "account"][] = [
  ...DATA_ROUTES.map((r) => [routeKey(r), { ...(DATA_CASES[routeKey(r)] as Case), minRole: r.minRole }, "data"] as [string, Case, "data"]),
  ...TEAM_ACCOUNT_ROUTES.map((r) => [routeKey(r), { ...(MEMBER_CASES[routeKey(r)] as Case), minRole: MEMBER_MIN_ROLE[routeKey(r)] as TeamRole }, "account"] as [string, Case, "account"]),
];

const expectedRefusal = (caller: Caller, minRole: TeamRole) => ({
  code: "permission_denied",
  message: expect.any(String),
  reason: caller === "outsider" ? "not_member" : minRole === "owner" ? "owners_only" : "view_only",
});

describe("the role matrix", () => {
  it("has a case for every team route", () => {
    expect(Object.keys(DATA_CASES).sort()).toEqual(DATA_ROUTES.map(routeKey).sort());
    expect(Object.keys(MEMBER_CASES).sort()).toEqual(TEAM_ACCOUNT_ROUTES.map(routeKey).sort());
  });

  it("needs at least contributor for every data route that isn't a read, and owner for the import, support actions and settings writes", () => {
    for (const route of DATA_ROUTES) {
      if (route.method !== "GET") expect(hasRole("viewer", route.minRole), routeKey(route)).toBe(false);
      else if (route.operation !== "supportActions") expect(route.minRole, routeKey(route)).toBe("viewer");
    }
    expect(DATA_ROUTES.find((r) => r.operation === "importProducts")?.minRole).toBe("owner");
    expect(DATA_ROUTES.find((r) => r.operation === "supportActions")?.minRole).toBe("owner");
    expect(DATA_ROUTES.find((r) => r.operation === "setSettings")?.minRole).toBe("owner");
  });

  it("gives every old /sheets route exactly its /projects twin's role, and nothing else differs (supply-checkout-005.6)", () => {
    const legacy = DATA_ROUTES.filter((r) => r.legacy);
    expect(legacy.map(routeKey).sort()).toEqual(DATA_ROUTES.filter((r) => r.path.includes("/sheets")).map(routeKey).sort());
    expect(legacy).toHaveLength(10);
    for (const route of legacy) {
      const twin = DATA_ROUTES.find((r) => !r.legacy && r.method === route.method && r.path === route.path.replace("/sheets/{sheetId}", "/projects/{projectId}").replace(/\/sheets$/, "/projects"));
      expect(twin, routeKey(route)).toBeDefined();
      expect({ ...route, path: twin?.path, legacy: undefined }, routeKey(route)).toEqual({ ...twin, legacy: undefined });
    }
  });

  for (const [key, c, fn] of cases) {
    for (const caller of CALLERS) {
      const allowed = caller !== "outsider" && hasRole(caller, c.minRole);
      it(`${key} as ${caller}: ${allowed ? "allowed" : "refused"}`, async () => {
        const handler = fn === "data" ? dataHandler : accountHandler;
        const routes = fn === "data" ? DATA_ROUTES : ACCOUNT_ROUTES;
        const before = structuredClone([...table.items.entries()]);
        table.calls.length = 0;
        const response = await handler(event(routes, c.method, c.path, USERS[caller], c.body, c.query));
        const body = response.body ? JSON.parse(response.body) : undefined;
        if (allowed) {
          expect(response.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(200);
          expect(response.statusCode, JSON.stringify(body)).toBeLessThan(300);
        } else {
          expect(response.statusCode).toBe(403);
          expect(body.error).toEqual(expectedRefusal(caller, c.minRole));
          expect(table.calls.filter((call) => WRITE_COMMANDS.has(call.command))).toEqual([]);
          expect([...table.items.entries()]).toEqual(before);
        }
      });
    }
  }
});

describe("requireRole", () => {
  it("ranks viewer < contributor < owner, and never lets an unknown role through", () => {
    for (const role of TEAM_ROLES) for (const minimum of TEAM_ROLES) expect(hasRole(role, minimum)).toBe(TEAM_ROLES.indexOf(role) >= TEAM_ROLES.indexOf(minimum));
    for (const role of ["system", "", "admin", "__proto__"]) expect(hasRole(role, "viewer")).toBe(false);
    expect(() => requireRole("superuser", "viewer")).toThrow(expect.objectContaining({ status: 403, reason: "not_member" }));
    expect(() => requireRole("viewer", "contributor")).toThrow(expect.objectContaining({ status: 403, code: "permission_denied", reason: "view_only" }));
    expect(() => requireRole("contributor", "owner")).toThrow(expect.objectContaining({ status: 403, code: "permission_denied", reason: "owners_only" }));
    expect(() => requireRole("owner", "owner")).not.toThrow();
  });
});
