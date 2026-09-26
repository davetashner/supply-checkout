// The AppSync Events authorizer: who may connect, and who may subscribe to a
// team's channel. Tokens are real JWTs, signed with a key made for the test and
// checked by the same aws-jwt-verify verifier the Lambda uses, so an expired
// token or an ID token is refused by the real checks.

import { createSign, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authorizeTeam, ForbiddenError } from "../src/data/index.js";
import { createAuthorizerHandler, type EventsAuthorizerEvent } from "../src/realtime/authorizer-handler.js";
import type { Observability } from "../src/observability/index.js";
import { MemoryTable } from "./memory-table.js";
import { offlineDb, REGION } from "./helpers.js";

// aws-jwt-verify reads the region from the pool ID, in AWS's format; a made-up one
const POOL_REGION = "zz-test-1";
const POOL = `${POOL_REGION}_testpool`;
const ISSUER = `https://cognito-idp.${POOL_REGION}.amazonaws.com/${POOL}`;
const CLIENT = "web-client";
const KID = "test-key";
const NOW = Math.floor(Date.now() / 1000);
const TEAM = "7d3b8a52-5a61-4c3e-9d1f-0b6f2f7c1a11";
const OTHER_TEAM = "0f0e8a52-5a61-4c3e-9d1f-0b6f2f7c1a22";
const MEMBER = "user-member";
const VIEWER = "user-viewer";
const OUTSIDER = "user-outsider";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

function jwt(claims: Record<string, unknown>, kid = KID): string {
  const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

function accessToken(sub: string, overrides: Record<string, unknown> = {}): string {
  return jwt({ sub, iss: ISSUER, client_id: CLIENT, token_use: "access", scope: "openid", iat: NOW - 60, exp: NOW + 3600, ...overrides });
}

const verifier = CognitoJwtVerifier.create({ userPoolId: POOL, clientId: CLIENT, tokenUse: "access" });
beforeAll(() => {
  const jwk = publicKey.export({ format: "jwk" }) as JsonWebKey;
  verifier.cacheJwks({ keys: [{ ...jwk, kid: KID, alg: "RS256", use: "sig" } as never] });
});

let table: MemoryTable;
let logs: { message: string; fields: Record<string, unknown> }[];
let handler: ReturnType<typeof createAuthorizerHandler>;

function fakeObservability(): Observability {
  const log = (message: string, fields: Record<string, unknown> = {}) => logs.push({ message, fields });
  return {
    region: REGION,
    logger: { info: log, warn: log, error: log, addContext: () => {} } as unknown as Observability["logger"],
    count: () => {},
    flush: () => {},
  };
}

beforeEach(() => {
  logs = [];
  table = new MemoryTable();
  table.seedTeam(TEAM, { [MEMBER]: "contributor", [VIEWER]: "viewer" });
  table.seedTeam(OTHER_TEAM, { [OUTSIDER]: "owner" });
  handler = createAuthorizerHandler({ verifier, db: table.db(), obs: fakeObservability() });
});

function subscribe(token: string | undefined, channel: string, extra: Partial<NonNullable<EventsAuthorizerEvent["requestContext"]>> = {}) {
  return handler({
    authorizationToken: token,
    requestContext: { apiId: "api", accountId: "acct", requestId: "r1", operation: "EVENT_SUBSCRIBE", channelNamespaceName: "teams", channel, ...extra },
  });
}

describe("subscribing to a team channel", () => {
  it("lets a member subscribe to their team, with nothing cached", async () => {
    expect(await subscribe(accessToken(MEMBER), `/teams/${TEAM}`)).toEqual({ isAuthorized: true, ttlOverride: 0 });
    expect(logs.at(-1)).toMatchObject({ message: "Subscribe allowed", fields: { teamId: TEAM, userId: MEMBER } });
  });

  it("lets a viewer subscribe: every member can read", async () => {
    expect((await subscribe(accessToken(VIEWER), `/teams/${TEAM}`)).isAuthorized).toBe(true);
  });

  it("accepts the channel without its leading slash and a Bearer prefix on the token", async () => {
    expect((await subscribe(`Bearer ${accessToken(MEMBER)}`, `teams/${TEAM}`)).isAuthorized).toBe(true);
  });

  it("refuses a non-member", async () => {
    expect(await subscribe(accessToken(OUTSIDER), `/teams/${TEAM}`)).toEqual({ isAuthorized: false, ttlOverride: 0 });
    expect(logs.at(-1)).toMatchObject({ message: "Denied", fields: { reason: "Not a member of this team" } });
  });

  it("refuses a team that doesn't exist, the same way", async () => {
    expect((await subscribe(accessToken(MEMBER), "/teams/00000000-0000-4000-8000-000000000000")).isAuthorized).toBe(false);
    expect(logs.at(-1)?.fields.reason).toBe("Not a member of this team");
  });

  it("refuses a member whose MEMBER item has an unknown role", async () => {
    table.put({ PK: `TEAM#${TEAM}`, SK: "MEMBER#user-odd", role: "admin" });
    expect((await subscribe(accessToken("user-odd"), `/teams/${TEAM}`)).isAuthorized).toBe(false);
  });

  it("refuses a member once they're removed, and the API they refetch through refuses them too", async () => {
    expect((await subscribe(accessToken(MEMBER), `/teams/${TEAM}`)).isAuthorized).toBe(true);
    table.items.delete(`TEAM#${TEAM}\u0000MEMBER#${MEMBER}`);
    expect((await subscribe(accessToken(MEMBER), `/teams/${TEAM}`)).isAuthorized).toBe(false);
    // Events carry no document data (realtime-publisher.test.ts), so contents
    // come only from the data API, which runs this same check on every request
    await expect(authorizeTeam(table.db(TEAM), MEMBER, TEAM)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it.each([
    ["a wildcard", "/teams/*"],
    ["the namespace alone", "/teams"],
    ["a deeper path", `/teams/${TEAM}/products`],
    ["another namespace", `/default/${TEAM}`],
    ["a team ID with #", `/teams/${TEAM}#x`],
    ["a team ID with _ (not a channel segment)", "/teams/team_a"],
    ["a team ID over 50 characters", `/teams/${"a".repeat(51)}`],
    ["an empty team ID", "/teams/"],
  ])("refuses %s", async (_, channel) => {
    expect((await subscribe(accessToken(MEMBER), channel)).isAuthorized).toBe(false);
    expect(logs.at(-1)?.fields.reason).toBe("Not a team channel");
  });

  it("refuses a missing channel", async () => {
    expect((await handler({ authorizationToken: accessToken(MEMBER), requestContext: { operation: "EVENT_SUBSCRIBE" } })).isAuthorized).toBe(false);
  });

  it("refuses a subscription in another namespace, even to a well-formed path", async () => {
    expect((await subscribe(accessToken(MEMBER), `/teams/${TEAM}`, { channelNamespaceName: "default" })).isAuthorized).toBe(false);
    expect(logs.at(-1)?.fields.reason).toBe("Unknown namespace");
  });

  it("fails closed when the table can't be read", async () => {
    handler = createAuthorizerHandler({ verifier, db: offlineDb(), obs: fakeObservability() });
    await expect(subscribe(accessToken(MEMBER), `/teams/${TEAM}`)).rejects.toThrow("unexpected DynamoDB call");
  });
});

describe("tokens", () => {
  it.each([
    ["missing", undefined, "No token"],
    ["empty", "", "No token"],
    ["not a JWT", "not-a-token", "Token rejected"],
    ["expired", accessToken(MEMBER, { exp: NOW - 10 }), "Token rejected"],
    ["an ID token", accessToken(MEMBER, { token_use: "id", aud: CLIENT }), "Token rejected"],
    ["for another client", accessToken(MEMBER, { client_id: "other-client" }), "Token rejected"],
    ["from another issuer", accessToken(MEMBER, { iss: `https://cognito-idp.${POOL_REGION}.amazonaws.com/${POOL_REGION}_other` }), "Token rejected"],
    ["signed with an unknown key", jwt({ sub: MEMBER, iss: ISSUER, client_id: CLIENT, token_use: "access", exp: NOW + 3600 }, "other-key"), "Token rejected"],
  ])("refuses a token that is %s", async (_, token, reason) => {
    expect((await subscribe(token, `/teams/${TEAM}`)).isAuthorized).toBe(false);
    expect(String(logs.at(-1)?.fields.reason)).toContain(reason);
  });

  it("refuses a token the verifier passes but whose claims are wrong (second look)", async () => {
    const lenient = (claims: Record<string, unknown>) =>
      createAuthorizerHandler({ verifier: { verify: async () => claims }, db: table.db(), obs: fakeObservability(), now: () => NOW * 1000 });
    const event = (h: ReturnType<typeof lenient>) => h({ authorizationToken: "t", requestContext: { operation: "EVENT_SUBSCRIBE", channel: `/teams/${TEAM}` } });
    const exp = NOW + 60;
    expect((await event(lenient({ sub: MEMBER, token_use: "id", exp }))).isAuthorized).toBe(false);
    expect(logs.at(-1)?.fields.reason).toBe("Not an access token");
    expect((await event(lenient({ sub: MEMBER, token_use: "access", exp: NOW }))).isAuthorized).toBe(false);
    expect(logs.at(-1)?.fields.reason).toBe("Token expired");
    expect((await event(lenient({ sub: MEMBER, token_use: "access" }))).isAuthorized).toBe(false);
    expect(logs.at(-1)?.fields.reason).toBe("Token expired");
    expect((await event(lenient({ sub: "a#b", token_use: "access", exp }))).isAuthorized).toBe(false);
    expect(logs.at(-1)?.fields.reason).toBe("Bad subject");
    expect((await event(lenient({ token_use: "access", exp }))).isAuthorized).toBe(false);
    expect((await event(lenient({ sub: MEMBER, token_use: "access", exp }))).isAuthorized).toBe(true);
  });
});

describe("connecting and publishing", () => {
  it("lets any valid access token connect", async () => {
    const result = await handler({ authorizationToken: accessToken(OUTSIDER), requestContext: { operation: "EVENT_CONNECT" } });
    expect(result).toEqual({ isAuthorized: true, ttlOverride: 0 });
  });

  it("refuses to connect without a valid token", async () => {
    expect((await handler({ authorizationToken: accessToken(MEMBER, { exp: NOW - 1 }), requestContext: { operation: "EVENT_CONNECT" } })).isAuthorized).toBe(false);
    expect((await handler({ requestContext: { operation: "EVENT_CONNECT" } })).isAuthorized).toBe(false);
  });

  it.each(["EVENT_PUBLISH", "SOMETHING_NEW", undefined])("never allows %s from a client, even a member's", async (operation) => {
    const result = await handler({ authorizationToken: accessToken(MEMBER), requestContext: { operation, channel: `/teams/${TEAM}` } });
    expect(result.isAuthorized).toBe(false);
    expect(logs.at(-1)?.fields.reason).toBe("Operation not allowed for clients");
  });

  it("refuses an event with no request context", async () => {
    expect((await handler({ authorizationToken: accessToken(MEMBER) })).isAuthorized).toBe(false);
  });
});
