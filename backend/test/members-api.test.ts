// A team's members through the account API: owners list members, change
// roles and remove members; anyone can leave; the last owner can't be
// removed, demoted or leave. Against the in-memory table, each request's
// handles scoped to the partitions its session tags allow (account-db.ts).
// test/roles.test.ts has the per-role matrix for these routes.

import { beforeEach, describe, expect, it } from "vitest";
import type { AccountScope, DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler } from "../src/api/account-handler.js";
import type { DataEvent } from "../src/api/data-handler.js";
import { ACCOUNT_ROUTES, routeKey } from "../src/api/routes.js";
import { MEMBER_ROW_ATTRIBUTES } from "../src/data/schema.js";
import { connection } from "../src/data/client.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { accountPartitions, fakeDb, fakeMailer, unusedDeleteUser, unusedDeletionLog, unusedEmailCodes, unusedTotp } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const mails = fakeMailer();
const NOW = Date.parse("2026-09-26T12:00:00Z");
const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const OWNER = "user-owner";
const CONTRIBUTOR = "user-contributor";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";

let table: MemoryTable;
let scopes: AccountScope[];
let handler: ReturnType<typeof createAccountHandler>;
let errors: unknown[];
// Seat syncs queued (billing/seats.ts), and the switches that make queueing or the team read after a change fail
let queued: [string, string][];
let counted: [string, number, unknown][];
let queueFails: boolean;
let teamReadFails: boolean;

function member(teamId: string, userId: string, role: string, email?: string) {
  table.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#${userId}`, type: "member", teamId, userId, role, ...(email ? { email } : {}), joinedAt: "2026-09-01T00:00:00.000Z" });
  table.put({ PK: `USER#${userId}`, SK: `TEAM#${teamId}`, type: "userTeam", userId, teamId, teamName: teamId, role });
}

function team(teamId: string, members: Record<string, string>) {
  const owners = Object.values(members).filter((r) => r === "owner").length;
  table.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: teamId, homeRegion: "test-local-1", owners, version: 1 });
  for (const [userId, role] of Object.entries(members)) member(teamId, userId, role, `${userId.slice(5)}@example.com`);
}

beforeEach(() => {
  table = new MemoryTable();
  scopes = [];
  errors = [];
  queued = [];
  counted = [];
  queueFails = false;
  teamReadFails = false;
  team("team-a", { [OWNER]: "owner", [CONTRIBUTOR]: "contributor", [VIEWER]: "viewer" });
  team("team-b", { [OUTSIDER]: "owner" });
  const dbFor: DbForAccount = (scope) => {
    scopes.push(scope);
    const db = table.scoped(accountPartitions(scope));
    if (!teamReadFails) return db;
    // The whole team item (getTeam) can't be read; everything else can
    return fakeDb(async (command) => {
      const input = command.input as { Key?: { SK?: string }; ProjectionExpression?: string };
      if (command.constructor.name === "GetCommand" && input.Key?.SK === "META" && !input.ProjectionExpression) throw Object.assign(new Error("Throttled"), { name: "ThrottlingException" });
      return connection(db).doc.send(command as never);
    });
  };
  const obs = {
    region: "test-local-1",
    logger: { info: () => {}, warn: () => {}, error: (_m: string, e: unknown) => errors.push(e), addContext: () => {} },
    count: (metric: string, n: number, meta: unknown) => counted.push([metric, n, meta]),
    flush: () => {},
  } as unknown as Observability;
  // Leaving reads the caller's verified address from Cognito (their pending invites to it go too)
  const userInfo = async (token: string) => {
    const sub = token.replace(/^token-/, "");
    return { sub, email: `${sub.slice(5)}@example.com`, emailVerified: true, emailVerifiedInCognito: true, totp: false, federated: false };
  };
  handler = createAccountHandler({ dbFor, userInfo, issuerUrl: ISSUER, obs, mailer: mails.mailer, deleteUser: unusedDeleteUser, deletions: unusedDeletionLog, emailCodes: unusedEmailCodes, totp: unusedTotp, now: () => NOW, seats: async (customer, reason) => {
    if (queueFails) throw Object.assign(new Error("SQS is down"), { name: "ServiceUnavailable" });
    queued.push([customer, reason]);
  } });
});

function event(method: string, path: string, user: string, body?: unknown, rawBody?: string): DataEvent {
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
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(NOW / 1000 + 600), iss: ISSUER }, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function call(method: string, path: string, user = OWNER, body?: unknown, rawBody?: string) {
  const response = await handler(event(method, path, user, body, rawBody));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const list = (user = OWNER, teamId = "team-a") => call("GET", `/teams/${teamId}/members`, user);
const setRole = (userId: string, role: unknown, user = OWNER, teamId = "team-a") => call("PATCH", `/teams/${teamId}/members/${userId}`, user, { role });
const remove = (userId: string, user = OWNER, teamId = "team-a") => call("DELETE", `/teams/${teamId}/members/${userId}`, user);
const owners = (teamId = "team-a") => table.get(`TEAM#${teamId}`, "META")?.owners;
const roleOf = (userId: string, teamId = "team-a") => table.get(`TEAM#${teamId}`, `MEMBER#${userId}`)?.role;
const switcherRole = (userId: string, teamId = "team-a") => table.get(`USER#${userId}`, `TEAM#${teamId}`)?.role;
/**
 * Every attribute a write names: its keys, the names behind #placeholders, and bare
 * names in its expressions, as IAM's dynamodb:Attributes would see them.
 */
function attributesOf(body: Record<string, unknown>): string[] {
  const names = new Set(Object.keys((body.Key ?? body.Item ?? {}) as object));
  for (const n of Object.values((body.ExpressionAttributeNames ?? {}) as Record<string, string>)) names.add(n);
  const text = [body.UpdateExpression, body.ConditionExpression].filter(Boolean).join(" ");
  for (const [word] of text.matchAll(/(?<![#:\w])[A-Za-z_]\w*(?!\w*\s*\()/g)) if (!["SET", "ADD", "REMOVE", "DELETE", "AND", "OR", "NOT"].includes(word)) names.add(word);
  return [...names].sort();
}

/** Each write the handler sent into `partition`, as [kind, the attributes it names, its ReturnValues]. */
function writesTo(partition: string) {
  return table.requests.flatMap((c) =>
    ((c.input.TransactItems as Record<string, Record<string, unknown>>[] | undefined) ?? [{ [c.command]: c.input }])
      .map((op) => Object.entries(op)[0] as [string, Record<string, unknown>])
      .filter(([, body]) => (body.Key as { PK?: string } | undefined)?.PK === partition || (body.Item as { PK?: string } | undefined)?.PK === partition)
      .map(([kind, body]) => [kind, attributesOf(body), body.ReturnValues ?? "NONE"]),
  );
}

const lastOwner = { status: 409, body: { error: { code: "aborted", message: "A team needs at least one owner. Make someone else an owner first.", reason: "last_owner" } } };

describe("GET /teams/{teamId}/members", () => {
  it("lists the members, owners first, with only the fields the screen needs", async () => {
    member("team-a", "user-noemail", "viewer");
    table.put({ ...(table.get("TEAM#team-a", `MEMBER#${CONTRIBUTOR}`) as Record<string, unknown>), displayName: "Cora Contributor" });
    expect(await list()).toEqual({
      status: 200,
      body: {
        members: [
          { userId: OWNER, name: null, email: "owner@example.com", role: "owner", joinedAt: "2026-09-01T00:00:00.000Z" },
          { userId: CONTRIBUTOR, name: "Cora Contributor", email: "contributor@example.com", role: "contributor", joinedAt: "2026-09-01T00:00:00.000Z" },
          { userId: "user-noemail", name: null, email: null, role: "viewer", joinedAt: "2026-09-01T00:00:00.000Z" },
          { userId: VIEWER, name: null, email: "viewer@example.com", role: "viewer", joinedAt: "2026-09-01T00:00:00.000Z" },
        ],
      },
    });
  });

  it("stays in the path's team and never lists another team's members", async () => {
    table.calls.length = 0;
    await list();
    expect(new Set(table.calls.flatMap((c) => c.partitions))).toEqual(new Set(["TEAM#team-a"]));
    expect(await list(OWNER, "team-b")).toMatchObject({ status: 403, body: { error: { code: "permission_denied", reason: "not_member" } } });
    expect(await list(OWNER, "no-such-team")).toMatchObject({ status: 403, body: { error: { reason: "not_member" } } });
    expect((await list(OWNER, "TEAM%23b")).status).toBe(400);
  });
});

describe("PATCH /teams/{teamId}/members/{userId}", () => {
  it("changes the role on the member, their team switcher and the owner count together", async () => {
    expect(await setRole(VIEWER, "contributor")).toEqual({
      status: 200,
      body: { member: { userId: VIEWER, name: null, email: "viewer@example.com", role: "contributor", joinedAt: "2026-09-01T00:00:00.000Z" } },
    });
    expect([roleOf(VIEWER), switcherRole(VIEWER)]).toEqual(["contributor", "contributor"]);
    expect((await setRole(VIEWER, "owner")).status).toBe(200);
    expect(owners()).toBe(2);
    // The new owner can demote the first one, and then the team has one owner again
    expect((await setRole(OWNER, "viewer", VIEWER)).status).toBe(200);
    expect([owners(), roleOf(OWNER), switcherRole(OWNER)]).toEqual([1, "viewer", "viewer"]);
    // Setting the role a member already has changes nothing
    expect((await setRole(CONTRIBUTOR, "contributor", VIEWER)).status).toBe(200);
  });

  it("never demotes the last owner, themselves included", async () => {
    for (const role of ["contributor", "viewer"]) expect(await setRole(OWNER, role)).toEqual(lastOwner);
    expect([owners(), roleOf(OWNER), switcherRole(OWNER)]).toEqual([1, "owner", "owner"]);
  });

  it("lets an owner step down while another owner remains", async () => {
    await setRole(CONTRIBUTOR, "owner");
    expect((await setRole(OWNER, "viewer")).status).toBe(200);
    expect(await setRole(CONTRIBUTOR, "viewer", CONTRIBUTOR)).toEqual(lastOwner);
    expect(owners()).toBe(1);
  });

  it("of two owners demoting each other at once, lets only one through", async () => {
    await setRole(CONTRIBUTOR, "owner");
    const results = await Promise.all([setRole(CONTRIBUTOR, "viewer", OWNER), setRole(OWNER, "viewer", CONTRIBUTOR)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(owners()).toBe(1);
    expect([roleOf(OWNER), roleOf(CONTRIBUTOR)].filter((r) => r === "owner")).toHaveLength(1);
  });

  it("refuses a role that isn't one, a malformed body or ID, and someone not in the team", async () => {
    for (const role of ["system", "admin", "", 1, null, undefined]) expect((await setRole(VIEWER, role)).status, String(role)).toBe(400);
    expect((await call("PATCH", `/teams/team-a/members/${VIEWER}`, OWNER, { role: "viewer", teamId: "team-b" })).status).toBe(400);
    expect((await call("PATCH", `/teams/team-a/members/${VIEWER}`, OWNER, undefined, "not json")).status).toBe(400);
    expect((await setRole("user%23x", "viewer")).status).toBe(400);
    expect(await setRole("user-nobody", "viewer")).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    // A member of another team is no one here: the path's team decides
    expect(await setRole(OUTSIDER, "viewer")).toMatchObject({ status: 404 });
    expect(roleOf(OUTSIDER, "team-b")).toBe("owner");
    expect(switcherRole(OUTSIDER, "team-b")).toBe("owner");
  });

  it("doesn't let contributors or viewers change anyone's role, their own included", async () => {
    for (const user of [CONTRIBUTOR, VIEWER]) {
      expect(await setRole(user, "owner", user)).toMatchObject({ status: 403, body: { error: { code: "permission_denied", reason: "owners_only" } } });
      expect(await setRole(OWNER, "viewer", user)).toMatchObject({ status: 403 });
    }
    expect([roleOf(CONTRIBUTOR), roleOf(VIEWER), roleOf(OWNER)]).toEqual(["contributor", "viewer", "owner"]);
  });

  it("refuses an owner demoted by someone else meanwhile", async () => {
    await setRole(CONTRIBUTOR, "owner");
    // Between OWNER's membership check and its write, the other owner demotes them
    let once = false;
    table.beforeTransactWrite = () => {
      if (once) return;
      once = true;
      table.put({ ...table.get("TEAM#team-a", `MEMBER#${OWNER}`), role: "viewer" });
    };
    expect(await setRole(VIEWER, "owner")).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(roleOf(VIEWER)).toBe("viewer");
  });

  it("writes another member's partition only within what the account-access role allows there", async () => {
    // The member tag's IAM statement (MemberSwitcherRowOnly): UpdateItem or DeleteItem,
    // naming only MEMBER_ROW_ATTRIBUTES, returning nothing
    table.calls.length = 0;
    table.requests.length = 0;
    await setRole(VIEWER, "contributor");
    await setRole(CONTRIBUTOR, "owner");
    await setRole(CONTRIBUTOR, "viewer");
    await remove(VIEWER);
    const writes = [...writesTo(`USER#${VIEWER}`), ...writesTo(`USER#${CONTRIBUTOR}`)];
    expect(writes.map(([kind]) => kind).sort()).toEqual(["Delete", "Update", "Update", "Update"]);
    expect(writes.map(([, a]) => (a as string[]).join(","))).toContain("PK,SK,role");
    for (const [, attributes, returns] of writes) {
      expect((attributes as string[]).every((a) => (MEMBER_ROW_ATTRIBUTES as readonly string[]).includes(a)), String(attributes)).toBe(true);
      expect(returns).toBe("NONE");
    }
    // The update is conditioned on the row existing, so it never creates one
    const update = table.requests.flatMap((c) => (c.input.TransactItems as Record<string, Record<string, unknown>>[] | undefined) ?? []).find((op) => (op.Update?.Key as { PK: string } | undefined)?.PK === `USER#${CONTRIBUTOR}`);
    expect(update?.Update?.ConditionExpression).toBe("attribute_exists(PK)");
    // Everything else is in the caller's own team partition
    expect(new Set(table.calls.flatMap((c) => c.partitions))).toEqual(new Set(["TEAM#team-a", `USER#${VIEWER}`, `USER#${CONTRIBUTOR}`]));
  });

  it("won't create a team-switcher row a member doesn't have", async () => {
    table.items.delete(`USER#${VIEWER}\u0000TEAM#team-a`);
    expect(await setRole(VIEWER, "contributor")).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(table.get(`USER#${VIEWER}`, "TEAM#team-a")).toBeUndefined();
    expect(roleOf(VIEWER)).toBe("viewer");
  });

  it("answers anyone but an owner 403 whatever the body", async () => {
    for (const user of [CONTRIBUTOR, VIEWER]) expect(await call("PATCH", `/teams/team-a/members/${VIEWER}`, user, undefined, "not json")).toMatchObject({ status: 403 });
    expect(await call("PATCH", `/teams/team-a/members/${VIEWER}`, OUTSIDER, { role: "admin" })).toMatchObject({ status: 403, body: { error: { reason: "not_member" } } });
  });

  it("reaches another member's partition only to update their team-switcher row, after the checks", async () => {
    await setRole(VIEWER, "contributor");
    const tagged = scopes.filter((s) => s.member !== undefined);
    expect(tagged).toEqual([{ userId: OWNER, teamId: "team-a", member: VIEWER }]);
    scopes.length = 0;
    await setRole(VIEWER, "owner", CONTRIBUTOR);
    await setRole("user-nobody", "viewer");
    expect(scopes.filter((s) => s.member !== undefined)).toEqual([]);
  });
});

describe("DELETE /teams/{teamId}/members/{userId}", () => {
  it("removes the member and their team-switcher row", async () => {
    expect(await remove(VIEWER)).toEqual({ status: 204, body: undefined });
    expect(table.get("TEAM#team-a", `MEMBER#${VIEWER}`)).toBeUndefined();
    expect(table.get(`USER#${VIEWER}`, "TEAM#team-a")).toBeUndefined();
    expect(await remove(VIEWER)).toMatchObject({ status: 404 });
  });

  it("never removes the last owner, and lets anyone else leave", async () => {
    expect(await remove(OWNER)).toEqual(lastOwner);
    expect(roleOf(OWNER)).toBe("owner");
    expect((await remove(VIEWER, VIEWER)).status).toBe(204);
    expect((await remove(CONTRIBUTOR, CONTRIBUTOR)).status).toBe(204);
    expect(await remove(OWNER)).toEqual(lastOwner);
  });

  it("removes an owner while another remains, and never both at once", async () => {
    await setRole(CONTRIBUTOR, "owner");
    const results = await Promise.all([remove(CONTRIBUTOR, OWNER), remove(OWNER, CONTRIBUTOR)]);
    expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
    expect(owners()).toBe(1);
  });

  it("doesn't let contributors or viewers remove anyone else", async () => {
    expect(await remove(VIEWER, CONTRIBUTOR)).toMatchObject({ status: 403, body: { error: { reason: "owners_only" } } });
    expect(await remove(OWNER, VIEWER)).toMatchObject({ status: 403, body: { error: { reason: "owners_only" } } });
    expect(await remove(VIEWER, OUTSIDER)).toMatchObject({ status: 403, body: { error: { reason: "not_member" } } });
    expect(roleOf(VIEWER)).toBe("viewer");
  });

  it("can't reach another team's member through this team", async () => {
    expect(await remove(OUTSIDER)).toMatchObject({ status: 404 });
    expect(table.get(`USER#${OUTSIDER}`, "TEAM#team-b")).toBeDefined();
    expect((await remove("user%2Fx")).status).toBe(400);
  });

  it("answers a failure it didn't expect with a 500 whose details stay in the logs", async () => {
    table.beforeTransactWrite = () => {
      throw Object.assign(new Error("boom"), { name: "InternalServerError" });
    };
    expect(await remove(VIEWER)).toMatchObject({ status: 500, body: { error: { code: "internal", message: "Something went wrong" } } });
    expect(errors).toHaveLength(1);
  });
});

describe("seats (supply-checkout-l50)", () => {
  const withCustomer = (teamId = "team-a", extra: Record<string, unknown> = {}) => table.put({ ...(table.get(`TEAM#${teamId}`, "META") as Record<string, unknown>), stripeCustomerId: `cus_${teamId.slice(5)}`, ...extra });

  it("queues a seat sync for the team's Stripe customer after a role change, a removal and a leave", async () => {
    withCustomer();
    expect((await setRole(VIEWER, "contributor")).status).toBe(200);
    expect(queued).toEqual([["cus_a", "membership"]]);
    expect((await remove(CONTRIBUTOR)).status).toBe(204);
    expect((await remove(VIEWER, VIEWER)).status).toBe(204);
    expect(queued).toEqual([["cus_a", "membership"], ["cus_a", "membership"], ["cus_a", "membership"]]);
  });

  it("queues nothing for a team without a Stripe customer, or a closed one", async () => {
    expect((await setRole(VIEWER, "contributor")).status).toBe(200);
    withCustomer("team-a", { closedAt: "2026-09-25T00:00:00.000Z" });
    expect((await remove(VIEWER, VIEWER)).status).toBe(204);
    expect(queued).toEqual([]);
  });

  it("keeps the change when the sync can't be queued, or the team can't be read after it, and counts each", async () => {
    withCustomer();
    queueFails = true;
    expect((await setRole(VIEWER, "contributor")).status).toBe(200);
    expect(roleOf(VIEWER)).toBe("contributor");
    queueFails = false;
    teamReadFails = true;
    expect((await setRole(VIEWER, "viewer")).status).toBe(200);
    expect(roleOf(VIEWER)).toBe("viewer");
    expect(queued).toEqual([]);
    expect(counted.filter(([m]) => m === BusinessMetric.SeatSyncQueueFailures)).toEqual([
      [BusinessMetric.SeatSyncQueueFailures, 1, { teamId: "team-a" }],
      [BusinessMetric.SeatSyncQueueFailures, 1, { teamId: "team-a" }],
    ]);
  });

  it("queues nothing when the role change or removal is refused", async () => {
    withCustomer();
    expect((await setRole(OWNER, "viewer")).status).toBe(409);
    expect((await remove(OWNER, CONTRIBUTOR)).status).toBe(403);
    expect(queued).toEqual([]);
  });
});
