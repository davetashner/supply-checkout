// Profile photos through the account API (supply-checkout-6uw.30): PUT and
// DELETE /me/photo, `photoUrl` on GET /me and the members list, and GET
// /teams/{teamId}/photos, against the in-memory table with each request's
// handles scoped to the partitions its session tags allow (account-db.ts), and
// an in-memory bucket. test/photo-jpeg.test.ts covers the JPEG check itself;
// test/roles.test.ts has /photos in the per-role matrix.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { AccountScope, DbForAccount } from "../src/api/account-db.js";
import { createAccountHandler, PHOTO_BODY_BYTES } from "../src/api/account-handler.js";
import type { DataEvent } from "../src/api/data-handler.js";
import { ACCOUNT_ROUTES, routeKey } from "../src/api/routes.js";
import { PHOTO_UPLOADS_PER_USER_PER_DAY, MAX_PHOTO_ORPHANS } from "../src/data/index.js";
import type { PhotoStore } from "../src/photos/store.js";
import type { Observability } from "../src/observability/index.js";
import { connection } from "../src/data/client.js";
import { accountPartitions, fakeDb, fakeMailer, memoryDeletionLog, unusedDeletionLog, unusedEmailCodes, unusedTotp } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/photos/${name}`, import.meta.url));
const BASELINE = fixture("baseline.jpg");
const CAMERA = fixture("camera.jpg");
const NOW = Date.parse("2026-10-09T12:00:00Z");
const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
const OWNER = "user-owner";
const CREW = "user-crew";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";
const URL_HOST = "https://photos.test";

let table: MemoryTable;
let scopes: AccountScope[];
let logs: unknown[][];
let objects: Map<string, Buffer>;
let calls: string[];
let failing: { put?: boolean; delete?: boolean };
let deleted: string[];
let handler: ReturnType<typeof createAccountHandler>;
let deps: Parameters<typeof createAccountHandler>[0];
let now: number;

function member(teamId: string, userId: string, role: string) {
  table.put({ PK: `TEAM#${teamId}`, SK: `MEMBER#${userId}`, type: "member", teamId, userId, role, email: `${userId.slice(5)}@example.com`, joinedAt: "2026-09-01T00:00:00.000Z" });
  table.put({ PK: `USER#${userId}`, SK: `TEAM#${teamId}`, type: "userTeam", userId, teamId, teamName: teamId, role });
}

function team(teamId: string, members: Record<string, string>, extra: Record<string, unknown> = {}) {
  const owners = Object.values(members).filter((r) => r === "owner").length;
  table.put({ PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: teamId, homeRegion: "test-local-1", owners, members: Object.keys(members).length, version: 1, ...extra });
  for (const [userId, role] of Object.entries(members)) member(teamId, userId, role);
}

/** An in-memory photos bucket: URLs name the object, as a presigned URL does. */
function memoryStore(): PhotoStore {
  return {
    async put(photoId, jpeg) {
      calls.push(`put ${photoId}`);
      if (failing.put) throw Object.assign(new Error("Slow down"), { name: "SlowDown" });
      objects.set(photoId, jpeg);
    },
    async delete(photoId) {
      calls.push(`delete ${photoId}`);
      if (failing.delete) throw Object.assign(new Error("Internal error"), { name: "InternalError" });
      objects.delete(photoId);
      deleted.push(photoId);
    },
    async url(photoId) {
      return `${URL_HOST}/photos/${photoId}.jpg?X-Amz-Signature=sig`;
    },
  };
}

beforeEach(() => {
  now = NOW;
  table = new MemoryTable();
  scopes = [];
  logs = [];
  objects = new Map();
  calls = [];
  failing = {};
  deleted = [];
  team("team-a", { [OWNER]: "owner", [CREW]: "contributor", [VIEWER]: "viewer" });
  team("team-b", { [OUTSIDER]: "owner", [CREW]: "viewer" });
  const dbFor: DbForAccount = (scope) => {
    scopes.push(scope);
    return table.scoped(accountPartitions(scope));
  };
  const obs = {
    region: "test-local-1",
    logger: { info: (...a: unknown[]) => logs.push(["info", ...a]), warn: (...a: unknown[]) => logs.push(["warn", ...a]), error: (...a: unknown[]) => logs.push(["error", ...a]), addContext: () => {} },
    count: () => {},
    flush: () => {},
  } as unknown as Observability;
  const userInfo = async (token: string) => {
    const sub = token.replace(/^token-/, "");
    return { sub, email: `${sub.slice(5)}@example.com`, emailVerified: true, emailVerifiedInCognito: true, totp: false, federated: false };
  };
  deps = { dbFor, userInfo, issuerUrl: ISSUER, obs, mailer: fakeMailer().mailer, deleteUser: async () => {}, deletions: unusedDeletionLog, emailCodes: unusedEmailCodes, totp: unusedTotp, photos: memoryStore(), now: () => now };
  handler = createAccountHandler(deps);
});

function event(method: string, path: string, user: string, body?: unknown, raw?: string): DataEvent {
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
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    isBase64Encoded: false,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "192.0.2.1", userAgent: "test" },
      authorizer: { principalId: "", integrationLatency: 0, jwt: { claims: { sub: user, token_use: "access", exp: String(Math.floor(now / 1000) + 600), iss: ISSUER }, scopes: null } },
    },
  } as unknown as DataEvent;
}

async function call(method: string, path: string, user: string, body?: unknown, raw?: string) {
  const response = await handler(event(method, path, user, body, raw));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined };
}

const upload = (user: string, jpeg: Buffer = BASELINE) => call("PUT", "/me/photo", user, { image: jpeg.toString("base64") });
const photos = (user: string, teamId = "team-a") => call("GET", `/teams/${teamId}/photos`, user);
const record = (user: string) => table.get(`USER#${user}`, "PHOTO");
const memberPhoto = (teamId: string, user: string) => table.get(`TEAM#${teamId}`, `MEMBER#${user}`)?.photoId;
const urlFor = (photoId: unknown) => `${URL_HOST}/photos/${String(photoId)}.jpg?X-Amz-Signature=sig`;
const refusal = (status: number, code: string, reason: string) => ({ status, body: { error: { code, message: expect.any(String), reason } } });

describe("PUT /me/photo", () => {
  it("stores the photo stripped, under a new random ID, and answers with its URL", async () => {
    const response = await upload(CREW, CAMERA);
    const photoId = record(CREW)?.photoId as string;
    expect(photoId).toMatch(/^[0-9a-f]{32}$/);
    expect(response).toEqual({ status: 200, body: { photoUrl: urlFor(photoId) } });
    const stored = objects.get(photoId) as Buffer;
    expect(stored.includes(Buffer.from("ExampleCam"))).toBe(false);
    expect(stored.includes(Buffer.from("secret comment"))).toBe(false);
    expect(stored.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(record(CREW)).toMatchObject({ type: "photo", photoId, orphans: [], version: 2, updatedAt: new Date(NOW).toISOString() });
    // Copied to the caller's member item in each team they're in
    expect(memberPhoto("team-a", CREW)).toBe(photoId);
    expect(memberPhoto("team-b", CREW)).toBe(photoId);
    expect(memberPhoto("team-a", OWNER)).toBeUndefined();
    // Counted for the day
    expect(table.get(`USER#${CREW}`, "LIMIT#PHOTOS#2026-10-09")).toMatchObject({ count: 1 });
    // Every session was the caller's, and reached only their own partition and their teams
    expect(new Set(scopes.map((s) => s.userId))).toEqual(new Set([CREW]));
    expect(new Set(scopes.map((s) => s.teamId).filter(Boolean))).toEqual(new Set(["team-a", "team-b"]));
    expect(scopes.every((s) => s.member === undefined && s.inviteLimit === undefined && s.invitee === undefined)).toBe(true);
  });

  it("accepts a data URL, and replaces an earlier photo, deleting its object", async () => {
    await upload(CREW);
    const first = record(CREW)?.photoId as string;
    const second = await call("PUT", "/me/photo", CREW, { image: `data:image/jpeg;base64,${BASELINE.toString("base64")}` });
    expect(second.status).toBe(200);
    const current = record(CREW)?.photoId as string;
    expect(current).not.toBe(first);
    expect([...objects.keys()]).toEqual([current]);
    expect(deleted).toEqual([first]);
    expect(record(CREW)?.orphans).toEqual([]);
    expect(memberPhoto("team-a", CREW)).toBe(current);
    // The URL is the new photo's
    expect(second.body.photoUrl).toBe(urlFor(current));
  });

  it("refuses anything but a 256×256 JPEG in base64 with photo_invalid, storing and counting nothing", async () => {
    const bodies: unknown[] = [
      { image: fixture("photo.png").toString("base64") },
      { image: fixture("photo.gif").toString("base64") },
      { image: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64") },
      { image: Buffer.from("<html><script>alert(1)</script></html>").toString("base64") },
      { image: fixture("wrong-size.jpg").toString("base64") },
      { image: Buffer.concat([BASELINE, Buffer.from("<script>")]).toString("base64") },
      { image: "not base64!" },
      { image: "abc" },
      { image: "" },
      { image: `data:image/png;base64,${BASELINE.toString("base64")}` },
      { image: 42 },
      { image: null },
      {},
    ];
    for (const body of bodies) expect(await call("PUT", "/me/photo", CREW, body), JSON.stringify(body).slice(0, 60)).toEqual(refusal(400, "bad_request", "photo_invalid"));
    // Fields other than image, and a body that isn't JSON, are refused as any other bad request
    expect((await call("PUT", "/me/photo", CREW, { image: BASELINE.toString("base64"), userId: OWNER })).body.error.code).toBe("bad_request");
    expect((await call("PUT", "/me/photo", CREW, undefined, "{")).status).toBe(400);
    expect(objects.size).toBe(0);
    expect(calls).toEqual([]);
    expect(record(CREW)).toBeUndefined();
    expect(table.get(`USER#${CREW}`, "LIMIT#PHOTOS#2026-10-09")).toBeUndefined();
  });

  it("refuses a photo over 64 KB, and a body over its limit, with photo_too_large", async () => {
    const padded = Buffer.concat([BASELINE.subarray(0, 2), ...Array.from({ length: 2 }, () => Buffer.concat([Buffer.from([0xff, 0xfe, 0x9c, 0x40]), Buffer.alloc(39_998, 0x41)])), BASELINE.subarray(2)]);
    expect(await upload(CREW, padded)).toEqual(refusal(413, "quota_exceeded", "photo_too_large"));
    expect(await call("PUT", "/me/photo", CREW, undefined, JSON.stringify({ image: "A".repeat(PHOTO_BODY_BYTES) }))).toEqual(refusal(413, "quota_exceeded", "photo_too_large"));
    expect(objects.size).toBe(0);
  });

  it("allows PHOTO_UPLOADS_PER_USER_PER_DAY a UTC day per user, then photo_limit, and more the next day", async () => {
    for (let i = 0; i < PHOTO_UPLOADS_PER_USER_PER_DAY; i++) expect((await upload(CREW)).status).toBe(200);
    expect(await upload(CREW)).toEqual(refusal(429, "quota_exceeded", "photo_limit"));
    // The refused upload wrote nothing, and only the current photo is in the bucket
    expect(objects.size).toBe(1);
    // Someone else's limit is their own
    expect((await upload(OWNER)).status).toBe(200);
    now += 86_400_000;
    expect((await upload(CREW)).status).toBe(200);
  });

  it("keeps the photo it replaced as an orphan when its object can't be deleted, and deletes it on the next upload", async () => {
    await upload(CREW);
    const first = record(CREW)?.photoId as string;
    failing.delete = true;
    expect((await upload(CREW)).status).toBe(200);
    const second = record(CREW)?.photoId as string;
    expect(record(CREW)?.orphans).toEqual([first]);
    expect(logs).toContainEqual(["warn", "Photos not deleted", { userId: CREW, failed: 1, code: "InternalError" }]);
    failing.delete = false;
    expect((await upload(CREW)).status).toBe(200);
    expect(deleted).toContain(first);
    expect(deleted).toContain(second);
    expect([...objects.keys()]).toEqual([record(CREW)?.photoId]);
    expect(record(CREW)?.orphans).toEqual([]);
  });

  it("refuses an upload while too many orphans are left, rather than piling them up", async () => {
    table.put({ PK: `USER#${CREW}`, SK: "PHOTO", type: "photo", orphans: Array.from({ length: MAX_PHOTO_ORPHANS }, (_, i) => String(i).repeat(32)), version: 3 });
    failing.delete = true;
    expect(await upload(CREW)).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(calls.filter((c) => c.startsWith("put"))).toEqual([]);
  });

  it("fails without a stored photo when the bucket refuses the object, leaving it named as an orphan", async () => {
    failing.put = true;
    expect((await upload(CREW)).status).toBe(500);
    expect(record(CREW)?.photoId).toBeUndefined();
    expect(record(CREW)?.orphans).toHaveLength(1);
    failing.put = false;
    expect((await upload(CREW)).status).toBe(200);
    expect(record(CREW)?.orphans).toEqual([]);
    expect(objects.size).toBe(1);
  });

  it("deletes its own object when the account started being deleted meanwhile", async () => {
    // The deletion mark lands between the upload's staging and its commit
    let puts = 0;
    const store = memoryStore();
    handler = createAccountHandler({
      ...deps,
      photos: {
        ...store,
        async put(photoId, jpeg) {
          puts++;
          table.put({ PK: `USER#${CREW}`, SK: "DELETING", type: "accountDeletion", userId: CREW });
          await store.put(photoId, jpeg);
        },
      },
    });
    expect(await upload(CREW)).toMatchObject({ status: 409, body: { error: { code: "aborted" } } });
    expect(puts).toBe(1);
    expect(objects.size).toBe(0);
    // And while it's marked, nothing is staged at all
    expect(await upload(CREW)).toMatchObject({ status: 409 });
    expect(puts).toBe(1);
  });

  it("logs the photo's ID at most: never the image, its URL, a name or an email", async () => {
    await upload(CREW, CAMERA);
    await call("GET", "/teams/team-a/photos", OWNER);
    await call("GET", "/me", CREW);
    const text = JSON.stringify(logs);
    expect(text).toContain(record(CREW)?.photoId as string);
    expect(text).not.toContain(URL_HOST);
    expect(text).not.toContain("X-Amz");
    expect(text).not.toMatch(/@|\/9j\//);
  });

  it("isn't served without a photo store", async () => {
    handler = createAccountHandler({ ...deps, photos: undefined });
    expect((await upload(CREW)).status).toBe(500);
    expect(await photos(OWNER)).toEqual({ status: 200, body: { photos: {} } });
    expect((await call("GET", "/me", CREW)).body.user.photoUrl).toBeNull();
  });
});

describe("DELETE /me/photo", () => {
  it("deletes the object and the photo's ID everywhere, and is idempotent", async () => {
    await upload(CREW);
    const photoId = record(CREW)?.photoId as string;
    expect(await call("DELETE", "/me/photo", CREW)).toEqual({ status: 204, body: undefined });
    expect(objects.size).toBe(0);
    expect(deleted).toEqual([photoId]);
    expect(record(CREW)).toMatchObject({ orphans: [] });
    expect(record(CREW)?.photoId).toBeUndefined();
    expect(memberPhoto("team-a", CREW)).toBeUndefined();
    expect(memberPhoto("team-b", CREW)).toBeUndefined();
    expect((await photos(OWNER)).body).toEqual({ photos: {} });
    expect(await call("DELETE", "/me/photo", CREW)).toEqual({ status: 204, body: undefined });
    // Someone who never had one
    expect(await call("DELETE", "/me/photo", VIEWER)).toEqual({ status: 204, body: undefined });
    expect(record(VIEWER)).toBeUndefined();
  });

  it("answers 503 when the object can't be deleted, shows no photo meanwhile, and a retry finishes it", async () => {
    await upload(CREW);
    failing.delete = true;
    expect(await call("DELETE", "/me/photo", CREW)).toMatchObject({ status: 503, body: { error: { code: "unavailable" } } });
    expect(record(CREW)?.photoId).toBeUndefined();
    expect((await call("GET", "/me", CREW)).body.user.photoUrl).toBeNull();
    failing.delete = false;
    expect((await call("DELETE", "/me/photo", CREW)).status).toBe(204);
    expect(objects.size).toBe(0);
    expect(memberPhoto("team-a", CREW)).toBeUndefined();
  });

  it("refuses a body", async () => {
    expect((await call("DELETE", "/me/photo", CREW, { userId: OWNER })).status).toBe(400);
  });
});

describe("GET /me", () => {
  it("has photoUrl: the caller's own photo, or null", async () => {
    expect((await call("GET", "/me", CREW)).body.user.photoUrl).toBeNull();
    await upload(CREW);
    expect((await call("GET", "/me", CREW)).body.user.photoUrl).toBe(urlFor(record(CREW)?.photoId));
    expect((await call("GET", "/me", OWNER)).body.user.photoUrl).toBeNull();
  });

  it("brings the caller's member items up to their photo (a team joined since, or a copy that failed)", async () => {
    await upload(CREW);
    const photoId = record(CREW)?.photoId as string;
    member("team-c", CREW, "viewer");
    table.put({ PK: "TEAM#team-c", SK: "META", type: "team", teamId: "team-c", name: "team-c", homeRegion: "test-local-1", owners: 0, members: 1, version: 1 });
    table.put({ ...(table.get("TEAM#team-a", `MEMBER#${CREW}`) as Record<string, unknown>), photoId: "f".repeat(32) });
    await call("GET", "/me", CREW);
    expect(memberPhoto("team-a", CREW)).toBe(photoId);
    expect(memberPhoto("team-c", CREW)).toBe(photoId);
    // Removed since: the copies go on the next /me
    table.put({ ...(record(CREW) as Record<string, unknown>), photoId: undefined });
    await call("GET", "/me", CREW);
    expect(memberPhoto("team-a", CREW)).toBeUndefined();
  });

  it("still answers, with no photo, when the photo record can't be read", async () => {
    table.put({ PK: `USER#${CREW}`, SK: "PHOTO", type: "photo", photoId: "../../not-an-id", orphans: ["junk", 7], version: "x" });
    expect((await call("GET", "/me", CREW)).body.user.photoUrl).toBeNull();
    // A throttled read of the photo record: /me still answers, with no photo, and leaves the member copies alone
    await upload(OWNER);
    const photoId = record(OWNER)?.photoId;
    handler = createAccountHandler({
      ...deps,
      dbFor: (scope) => {
        const db = table.scoped(accountPartitions(scope));
        return fakeDb(async (command) => {
          const input = command.input as { Key?: { SK?: string } };
          if (command.constructor.name === "GetCommand" && input.Key?.SK === "PHOTO") throw Object.assign(new Error("Throttled"), { name: "ThrottlingException" });
          return connection(db).doc.send(command as never);
        });
      },
    });
    const me = await call("GET", "/me", OWNER);
    expect(me.status).toBe(200);
    expect(me.body.user.photoUrl).toBeNull();
    expect(memberPhoto("team-a", OWNER)).toBe(photoId);
    expect(logs).toContainEqual(["warn", "Photo not read", { code: "ThrottlingException" }]);
  });
});

describe("GET /teams/{teamId}/photos", () => {
  it("gives any member the URLs of the team's members who have a photo, by user ID only", async () => {
    await upload(CREW);
    await upload(OWNER);
    const expected = { photos: { [CREW]: urlFor(record(CREW)?.photoId), [OWNER]: urlFor(record(OWNER)?.photoId) } };
    for (const user of [OWNER, CREW, VIEWER]) expect(await photos(user)).toEqual({ status: 200, body: expected });
    // Owners see them on the members list too
    const { body } = await call("GET", "/teams/team-a/members", OWNER);
    expect(Object.fromEntries(body.members.map((m: { userId: string; photoUrl: string | null }) => [m.userId, m.photoUrl]))).toEqual({ ...expected.photos, [VIEWER]: null });
  });

  it("never gives a member of one team another team's photos", async () => {
    await upload(OUTSIDER);
    await upload(CREW);
    // The outsider isn't in team-a: refused, as every team route refuses a non-member
    expect(await photos(OUTSIDER, "team-a")).toEqual(refusal(403, "permission_denied", "not_member"));
    // Team-b's photos are its own members' (Crew is in both), never team-a's owner's
    await upload(OWNER);
    expect((await photos(CREW, "team-b")).body.photos).toEqual({ [OUTSIDER]: urlFor(record(OUTSIDER)?.photoId), [CREW]: urlFor(record(CREW)?.photoId) });
    expect(await photos(VIEWER, "team-b")).toEqual(refusal(403, "permission_denied", "not_member"));
    // A team that doesn't exist answers the same as one the caller isn't in
    expect(await photos(OWNER, "no-such-team")).toEqual(refusal(403, "permission_denied", "not_member"));
    // Path IDs that aren't IDs never reach a key
    for (const teamId of ["TEAM%23team-b", "team-b%23x", "..%2Fteam-b", "USER%23user-outsider"]) expect((await photos(OWNER, teamId)).status).toBe(400);
    // Each read stayed in the path's team
    scopes.length = 0;
    await photos(CREW, "team-b");
    expect(scopes.map((s) => s.teamId)).toEqual(["team-b", "team-b"]);
  });

  it("drops a member's photo as soon as they're removed from the team, or leave it", async () => {
    await upload(CREW);
    await upload(VIEWER);
    expect(Object.keys((await photos(OWNER)).body.photos).sort()).toEqual([CREW, VIEWER]);
    expect((await call("DELETE", `/teams/team-a/members/${CREW}`, OWNER)).status).toBe(204);
    expect(Object.keys((await photos(OWNER)).body.photos)).toEqual([VIEWER]);
    expect((await call("DELETE", `/teams/team-a/members/${VIEWER}`, VIEWER)).status).toBe(204);
    expect((await photos(OWNER)).body.photos).toEqual({});
    // Gone from team-a, still shown in team-b
    expect(Object.keys((await photos(OUTSIDER, "team-b")).body.photos)).toEqual([CREW]);
    // The removed member can't read team-a's photos any more
    expect(await photos(CREW)).toEqual(refusal(403, "permission_denied", "not_member"));
  });

  it("signs only well-formed photo IDs from the team's own member items", async () => {
    table.put({ ...(table.get("TEAM#team-a", `MEMBER#${CREW}`) as Record<string, unknown>), photoId: "../users/someone-else" });
    table.put({ ...(table.get("TEAM#team-a", `MEMBER#${VIEWER}`) as Record<string, unknown>), photoId: 12 });
    expect(await photos(OWNER)).toEqual({ status: 200, body: { photos: {} } });
    // A user ID that is an object's own property name is just a key
    member("team-a", "__proto__", "viewer");
    table.put({ ...(table.get("TEAM#team-a", "MEMBER#__proto__") as Record<string, unknown>), photoId: "a".repeat(32) });
    const body = (await photos(OWNER)).body;
    expect(Object.keys(body.photos)).toEqual(["__proto__"]);
  });

  it("works on a closed team, and never names a photo there that was replaced or removed", async () => {
    await upload(CREW);
    const closeA = () => table.put({ ...(table.get("TEAM#team-a", "META") as Record<string, unknown>), closedAt: new Date(NOW).toISOString(), purgeAfter: new Date(NOW + 30 * 86_400_000).toISOString() });
    closeA();
    expect(Object.keys((await photos(VIEWER)).body.photos)).toEqual([CREW]);
    // Replaced: the closed team's copy follows, so its URL is the new photo's, never the deleted one's
    const old = memberPhoto("team-a", CREW);
    await upload(CREW);
    const current = record(CREW)?.photoId;
    expect(current).not.toBe(old);
    expect(memberPhoto("team-a", CREW)).toBe(current);
    expect((await photos(VIEWER)).body.photos).toEqual({ [CREW]: urlFor(current) });
    // Removed: gone from the closed team's photos too
    expect((await call("DELETE", "/me/photo", CREW)).status).toBe(204);
    expect(memberPhoto("team-a", CREW)).toBeUndefined();
    expect((await photos(VIEWER)).body.photos).toEqual({});
    // A copy left stale (a failed write) is brought up to date by /me, closed team or not; its email and name stay as they were
    table.put({ ...(table.get("TEAM#team-a", `MEMBER#${CREW}`) as Record<string, unknown>), photoId: "f".repeat(32), email: "old@example.com" });
    await call("GET", "/me", CREW);
    expect(table.get("TEAM#team-a", `MEMBER#${CREW}`)).toMatchObject({ email: "old@example.com" });
    expect(memberPhoto("team-a", CREW)).toBeUndefined();
  });
});

describe("deleting an account", () => {
  it("deletes every photo object the account's record names, before its rows", async () => {
    const log = memoryDeletionLog();
    handler = createAccountHandler({ ...deps, deletions: log.log });
    await upload(VIEWER);
    failing.delete = true;
    await upload(VIEWER);
    failing.delete = false;
    expect(objects.size).toBe(2);
    expect(await call("DELETE", "/me", VIEWER, { confirm: "DELETE" })).toEqual({ status: 204, body: undefined });
    expect(objects.size).toBe(0);
    expect(record(VIEWER)).toBeUndefined();
    expect(logs).toContainEqual(["info", "Account deleted", expect.objectContaining({ userId: VIEWER, photosDeleted: 2 })]);
  });

  it("stops before the rows go when an object can't be deleted, and a retry finishes it", async () => {
    handler = createAccountHandler({ ...deps, deletions: memoryDeletionLog().log });
    await upload(VIEWER);
    failing.delete = true;
    expect((await call("DELETE", "/me", VIEWER, { confirm: "DELETE" })).status).toBe(500);
    expect(record(VIEWER)?.photoId).toBeDefined();
    failing.delete = false;
    expect((await call("DELETE", "/me", VIEWER, { confirm: "DELETE" })).status).toBe(204);
    expect(objects.size).toBe(0);
    expect(record(VIEWER)).toBeUndefined();
  });
});
