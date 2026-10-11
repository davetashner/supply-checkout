// The caller's own name through the account API (supply-checkout-bt3g): PUT
// /me/name checks both parts, sets them in Cognito with the caller's own
// token (a fake here; test/account-db.test.ts covers cognitoSetName's calls),
// and copies the name to their MEMBER items, against the in-memory table with
// each request's handles scoped to the partitions its session tags allow
// (account-db.ts).

import { beforeEach, describe, expect, it } from "vitest";
import type { DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import type { DataEvent } from "../src/api/data-handler.js";
import { ApiError } from "../src/api/http.js";
import { ACCOUNT_ROUTES, routeKey } from "../src/api/routes.js";
import type { Observability } from "../src/observability/index.js";
import { accountPartitions, fakeMailer, unusedDeletionLog, unusedEmailCodes, unusedTotp } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const PAT = "user-pat";
const SAM = "user-sam";

let table: MemoryTable;
let logs: unknown[][];
let set: { token: string; given: string; family: string }[];
let cognitoFails: Error | undefined;
let dbFails: boolean;
let subFor: (token: string) => string;
let handler: ReturnType<typeof createAccountHandler>;
let deps: Parameters<typeof createAccountHandler>[0];

function team(teamId: string, members: Record<string, string>, extra: Record<string, unknown> = {}) {
  const owners = Object.values(members).filter((r) => r === "owner").length;
  table.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: teamId, homeRegion: "test-local-1", owners, members: Object.keys(members).length, version: 1, ...extra });
  for (const [userId, role] of Object.entries(members)) {
    table.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#${userId}`, type: "member", teamId, userId, role, email: `${userId.slice(5)}@example.com`, displayName: "Old Name", joinedAt: "2026-09-01T00:00:00.000Z" });
    table.put({ PK: `USER#${userId}`, SK: `TEAM#${teamId}`, type: "userTeam", userId, teamId, teamName: teamId, role });
  }
}

beforeEach(() => {
  table = new MemoryTable();
  logs = [];
  set = [];
  cognitoFails = undefined;
  dbFails = false;
  subFor = (token) => token.replace(/^token-/, "");
  team("team-a", { [PAT]: "owner", [SAM]: "contributor" });
  team("team-b", { [SAM]: "owner", [PAT]: "viewer" });
  team("team-closed", { [PAT]: "owner" }, { closedAt: "2026-10-01T00:00:00.000Z", purgeAfter: "2026-10-31T00:00:00.000Z" });
  const dbFor: DbForAccount = (scope) => {
    if (dbFails) throw Object.assign(new Error("throttled"), { name: "ThrottlingException" });
    return table.scoped(accountPartitions(scope));
  };
  const obs = {
    region: "test-local-1",
    logger: { info: (...a: unknown[]) => logs.push(["info", ...a]), warn: (...a: unknown[]) => logs.push(["warn", ...a]), error: (...a: unknown[]) => logs.push(["error", ...a]), addContext: () => {} },
    count: () => {},
    flush: () => {},
  } as unknown as Observability;
  const userInfo = async (token: string) => {
    const sub = subFor(token);
    return { sub, email: `${sub.slice(5)}@example.com`, emailVerified: true, emailVerifiedInCognito: true, totp: false, federated: false };
  };
  deps = {
    dbFor,
    userInfo,
    issuerUrl: ISSUER,
    obs,
    mailer: fakeMailer().mailer,
    deleteUser: async () => {},
    deletions: unusedDeletionLog,
    emailCodes: unusedEmailCodes,
    totp: unusedTotp,
    setName: async (token, given, family) => {
      if (cognitoFails) throw cognitoFails;
      set.push({ token, given, family });
    },
    now: () => NOW,
  };
  handler = createAccountHandler(deps);
});

function event(user: string, raw: string | undefined): DataEvent {
  const route = ACCOUNT_ROUTES.find((r) => r.action === "setName");
  if (!route) throw new Error("no setName route");
  return {
    version: "2.0",
    routeKey: routeKey(route),
    rawPath: "/me/name",
    rawQueryString: "",
    headers: { authorization: `Bearer token-${user}` },
    pathParameters: {},
    body: raw,
    isBase64Encoded: false,
    requestContext: {
      http: { method: "PUT", path: "/me/name", protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(Math.floor(NOW / 1000) + 600), iss: ISSUER }, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function setName(user: string, body: unknown, raw?: string) {
  const response = await handler(event(user, raw ?? JSON.stringify(body)));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const displayName = (teamId: string, user: string) => table.get(`TEAM#${teamId}`, `MEMBER#${user}`)?.displayName;

describe("PUT /me/name", () => {
  it("sets the caller's own name in Cognito with their own token, and on their member item in each open team", async () => {
    expect(await setName(PAT, { givenName: "Pat", familyName: "Lee" })).toEqual({ status: 200, body: { name: "Pat Lee" } });
    expect(set).toEqual([{ token: "token-user-pat", given: "Pat", family: "Lee" }]);
    expect(displayName("team-a", PAT)).toBe("Pat Lee");
    expect(displayName("team-b", PAT)).toBe("Pat Lee");
    // Nobody else's item, and a closed team keeps the name it had
    expect(displayName("team-a", SAM)).toBe("Old Name");
    expect(displayName("team-closed", PAT)).toBe("Old Name");
  });

  it("changes it, trimming each part, and takes one part alone", async () => {
    await setName(PAT, { givenName: "Pat", familyName: "Lee" });
    expect(await setName(PAT, { givenName: "  Patricia ", familyName: " Lee-Smith " })).toEqual({ status: 200, body: { name: "Patricia Lee-Smith" } });
    expect(set.at(-1)).toEqual({ token: "token-user-pat", given: "Patricia", family: "Lee-Smith" });
    expect(displayName("team-a", PAT)).toBe("Patricia Lee-Smith");
    expect(await setName(PAT, { givenName: "", familyName: "Lee" })).toEqual({ status: 200, body: { name: "Lee" } });
    expect(set.at(-1)).toEqual({ token: "token-user-pat", given: "", family: "Lee" });
  });

  it("clears it: both parts empty (or only spaces) removes the name from Cognito and the member items", async () => {
    expect(await setName(PAT, { givenName: " ", familyName: "" })).toEqual({ status: 200, body: { name: null } });
    expect(set).toEqual([{ token: "token-user-pat", given: "", family: "" }]);
    expect(displayName("team-a", PAT)).toBeUndefined();
    expect(displayName("team-b", PAT)).toBeUndefined();
  });

  it("refuses a part that isn't one line, has a control or invisible character, or a name over 100 characters, before Cognito", async () => {
    const refused = { status: 400, body: { error: { code: "bad_request", message: expect.any(String), reason: "name_invalid" } } };
    for (const body of [
      { givenName: "Pat\nLee", familyName: "" },
      { givenName: "Pat", familyName: "Lee\tSmith" },
      { givenName: "Pat\u0000", familyName: "Lee" },
      { givenName: "Pat​", familyName: "Lee" },
      { givenName: "‮Lee", familyName: "Pat" },
      { givenName: "a".repeat(60), familyName: "b".repeat(40) },
      { givenName: "a".repeat(201), familyName: "" },
      { givenName: 5, familyName: "Lee" },
      { givenName: "Pat", familyName: null },
      { givenName: "Pat" },
    ]) {
      expect(await setName(PAT, body)).toEqual(refused);
    }
    // 100 together is fine
    expect((await setName(PAT, { givenName: "a".repeat(50), familyName: "b".repeat(49) })).status).toBe(200);
    expect(set).toHaveLength(1);
  });

  it("refuses any other field, and a body that isn't JSON or is too large", async () => {
    expect((await setName(PAT, { givenName: "Pat", familyName: "Lee", email_verified: "true" })).body.error.code).toBe("bad_request");
    expect((await setName(PAT, { givenName: "Pat", familyName: "Lee", userId: SAM })).body.error.code).toBe("bad_request");
    expect((await setName(PAT, undefined, "not json")).status).toBe(400);
    expect((await setName(PAT, undefined, JSON.stringify({ givenName: "a".repeat(5000), familyName: "" }))).status).toBe(413);
    expect(set).toEqual([]);
  });

  it("changes nothing when Cognito refuses, and answers as it did", async () => {
    cognitoFails = new ApiError(401, "unauthenticated", "Sign in again");
    expect((await setName(PAT, { givenName: "Pat", familyName: "Lee" })).status).toBe(401);
    expect(displayName("team-a", PAT)).toBe("Old Name");
    cognitoFails = new Error("UpdateUserAttributes failed: 500 InternalErrorException");
    expect((await setName(PAT, { givenName: "Pat", familyName: "Lee" })).status).toBe(500);
    expect(displayName("team-a", PAT)).toBe("Old Name");
  });

  it("refuses a token whose user isn't the one API Gateway verified", async () => {
    subFor = () => SAM;
    expect((await setName(PAT, { givenName: "Pat", familyName: "Lee" })).status).toBe(401);
    expect(set).toEqual([]);
  });

  it("is saved even when the member items can't be updated: the next /me catches up", async () => {
    // Every table handle fails, after Cognito has the name
    const original = deps.setName;
    handler = createAccountHandler({ ...deps, setName: async (...a) => { await original?.(...a); dbFails = true; } });
    expect(await setName(PAT, { givenName: "Pat", familyName: "Lee" })).toEqual({ status: 200, body: { name: "Pat Lee" } });
    expect(logs).toContainEqual(["warn", "Member names not updated", { code: "ThrottlingException" }]);
  });

  it("fails without a name setter (the Lambda entry always has one)", async () => {
    handler = createAccountHandler({ ...deps, setName: undefined });
    expect((await setName(PAT, { givenName: "Pat", familyName: "Lee" })).status).toBe(500);
  });

  it("never logs the name", async () => {
    await setName(PAT, { givenName: "Zebulon", familyName: "Quixote" });
    await setName(PAT, { givenName: "Zebulon\n", familyName: "Quixote" });
    cognitoFails = new Error("UpdateUserAttributes failed: 500 InternalErrorException");
    await setName(PAT, { givenName: "Zebulon", familyName: "Quixote" });
    expect(JSON.stringify(logs)).not.toMatch(/Zebulon|Quixote/);
  });
});
