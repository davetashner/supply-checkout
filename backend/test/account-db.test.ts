// Per-user role sessions for the account API (src/api/account-db.ts) with a
// fake STS, and the Cognito GetUser client (src/api/cognito-user.ts) with a
// fake fetch.

import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import { accountScopedDbs } from "../src/api/account-db.js";
import { cognitoEmailCodes, cognitoUserInfo } from "../src/api/cognito-user.js";
import { ApiError } from "../src/api/http.js";
import { connection } from "../src/data/client.js";
import { type Db, hashEmail, InvalidInputError } from "../src/data/index.js";
import { REGION } from "./helpers.js";

const ROLE = "account-access-role-arn";
const env = { AWS_REGION: REGION, TABLE_NAME: "app" };

function fakeSts() {
  const calls: AssumeRoleCommand["input"][] = [];
  const sts = {
    send: vi.fn(async (command: AssumeRoleCommand) => {
      calls.push(command.input);
      return { Credentials: { AccessKeyId: `AK${calls.length}`, SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(Date.now() + 3600_000) } };
    }),
  };
  return { sts, calls };
}

async function credentials(db: Db) {
  const provider = connection(db).client.config.credentials as () => Promise<{ accessKeyId: string }>;
  return provider();
}

describe("accountScopedDbs", () => {
  it("tags every session with the user, and the team, invitee, member and invite limit or the unused marker", async () => {
    const { sts, calls } = fakeSts();
    const dbFor = accountScopedDbs({ roleArn: ROLE, env, sts });
    const invitee = hashEmail("pat@example.com");
    await credentials(dbFor({ userId: "user-1" }));
    await credentials(dbFor({ userId: "user-1", teamId: "team-a" }));
    await credentials(dbFor({ userId: "user-1", invitee }));
    await credentials(dbFor({ userId: "user-1", teamId: "team-a", member: "user-2" }));
    await credentials(dbFor({ userId: "user-1", teamId: "team-a", inviteLimit: invitee }));
    const tags = (teamId: string, inv: string, member: string, limit = ".") => [
      { Key: "userId", Value: "user-1" },
      { Key: "teamId", Value: teamId },
      { Key: "invitee", Value: inv },
      { Key: "member", Value: member },
      { Key: "inviteLimit", Value: limit },
    ];
    expect(calls.map((c) => [c.RoleArn, c.RoleSessionName, c.Tags])).toEqual([
      [ROLE, "user-user-1", tags(".", ".", ".")],
      [ROLE, "user-user-1", tags("team-a", ".", ".")],
      [ROLE, "user-user-1", tags(".", invitee, ".")],
      [ROLE, "user-user-1", tags("team-a", ".", "user-2")],
      [ROLE, "user-user-1", tags("team-a", ".", ".", invitee)],
    ]);
    // The same scope reuses its handle and session
    expect(dbFor({ userId: "user-1", teamId: "team-a" })).toBe(dbFor({ userId: "user-1", teamId: "team-a" }));
    await credentials(dbFor({ userId: "user-1", teamId: "team-a" }));
    expect(calls).toHaveLength(5);
  });

  it("refuses anything that could reach into another key", () => {
    const dbFor = accountScopedDbs({ roleArn: ROLE, env, sts: fakeSts().sts });
    for (const scope of [{ userId: "USER#x" }, { userId: "" }, { userId: "u", teamId: "a#b" }, { userId: "u", invitee: "pat@example.com" }, { userId: "u", invitee: "A".repeat(64) }, { userId: "u", teamId: "t", member: "USER#x" }, { userId: "u", member: "user-2" }, { userId: "u", teamId: "t", inviteLimit: "pat@example.com" }, { userId: "u", inviteLimit: "a".repeat(64) }]) {
      expect(() => dbFor(scope), JSON.stringify(scope)).toThrow(InvalidInputError);
    }
  });
});

describe("cognitoUserInfo", () => {
  const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("calls GetUser on the issuer's endpoint with the caller's token", async () => {
    const fetch = reply(200, {
      Username: "u",
      UserAttributes: [
        { Name: "sub", Value: "user-1" },
        { Name: "email", Value: "pat@example.com" },
        { Name: "email_verified", Value: "true" },
      ],
    });
    expect(await cognitoUserInfo(ISSUER, fetch)("access-token")).toEqual({ sub: "user-1", email: "pat@example.com", emailVerified: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cognito-idp.test-local-1.amazonaws.com/");
    expect(init.headers).toMatchObject({ "x-amz-target": "AWSCognitoIdentityProviderService.GetUser" });
    expect(JSON.parse(init.body as string)).toEqual({ AccessToken: "access-token" });
  });

  it("treats an unverified or missing email as unverified", async () => {
    const unverified = reply(200, { UserAttributes: [{ Name: "sub", Value: "u" }, { Name: "email", Value: "a@example.com" }, { Name: "email_verified", Value: "false" }] });
    expect(await cognitoUserInfo(ISSUER, unverified)("t")).toMatchObject({ emailVerified: false });
    expect(await cognitoUserInfo(ISSUER, reply(200, {}))("t")).toEqual({ sub: "", email: undefined, emailVerified: false });
  });

  it("counts a linked user's email as verified only while it's the recorded one (supply-checkout-kgw)", async () => {
    const google = JSON.stringify([{ userId: "1076", providerName: "Google", providerType: "Google", issuer: null, primary: false, dateCreated: 1 }]);
    const user = (username: string, attributes: Record<string, string>) =>
      cognitoUserInfo(ISSUER, reply(200, { Username: username, UserAttributes: [{ Name: "sub", Value: "u" }, { Name: "email_verified", Value: "true" }, ...Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })), { Name: 7 }] }))("t");
    // Linked, email still the recorded one (in any ASCII case)
    expect(await user("u", { email: "Pat@Example.com", identities: google, "custom:linked_email": "pat@example.com" })).toMatchObject({ emailVerified: true });
    // Linked, email rewritten from the provider while email_verified stayed "true": no invites for that address
    expect(await user("u", { email: "victim@example.com", identities: google, "custom:linked_email": "pat@example.com" })).toMatchObject({ emailVerified: false });
    expect(await user("u", { email: "pat@example.com", identities: google })).toMatchObject({ emailVerified: false });
    expect(await user("u", { email: "pat@example.com", identities: "not json", "custom:linked_email": "other@example.com" })).toMatchObject({ emailVerified: false });
    // Native and federated-only users are as before; a federated-only user has no recorded email
    expect(await user("u", { email: "pat@example.com" })).toMatchObject({ emailVerified: true });
    expect(await user("u", { email: "pat@example.com", identities: "[]", "custom:linked_email": "other@example.com" })).toMatchObject({ emailVerified: true });
    expect(await user("google_1076", { email: "pat@example.com", identities: google })).toMatchObject({ emailVerified: true });
  });

  it("answers 401 to a revoked token and fails on anything else", async () => {
    await expect(cognitoUserInfo(ISSUER, reply(400, { __type: "NotAuthorizedException" }))("t")).rejects.toThrow(ApiError);
    await expect(cognitoUserInfo(ISSUER, reply(400, { __type: "InvalidParameterException" }))("t")).rejects.toThrow(/GetUser failed: 400/);
    await expect(cognitoUserInfo(ISSUER, vi.fn(async () => new Response("<html>", { status: 503 })))("t")).rejects.toThrow(/GetUser failed: 503/);
  });

  it("only talks to a Cognito issuer", () => {
    for (const issuer of ["https://evil.example.com/pool", "http://cognito-idp.test-local-1.amazonaws.com/pool", "https://cognito-idp.x.amazonaws.com.evil.example/pool"]) {
      expect(() => cognitoUserInfo(issuer), issuer).toThrow(/not a Cognito user pool issuer/);
    }
  });
});

describe("cognitoEmailCodes", () => {
  const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("asks Cognito to email a code, and checks one, for the caller's email with their own token", async () => {
    const fetch = reply(200, { CodeDeliveryDetails: { Destination: "p***@e***", DeliveryMedium: "EMAIL", AttributeName: "email" } });
    const codes = cognitoEmailCodes(ISSUER, fetch);
    await expect(codes.send("access-token")).resolves.toBeUndefined();
    await expect(codes.verify("access-token", "123456")).resolves.toBeUndefined();
    const [[url, send], [, verify]] = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(url).toBe("https://cognito-idp.test-local-1.amazonaws.com/");
    expect(send.headers).toMatchObject({ "x-amz-target": "AWSCognitoIdentityProviderService.GetUserAttributeVerificationCode" });
    expect(JSON.parse(send.body as string)).toEqual({ AccessToken: "access-token", AttributeName: "email" });
    expect(verify.headers).toMatchObject({ "x-amz-target": "AWSCognitoIdentityProviderService.VerifyUserAttribute" });
    expect(JSON.parse(verify.body as string)).toEqual({ AccessToken: "access-token", AttributeName: "email", Code: "123456" });
  });

  it("answers Cognito's refusals the person can act on, with or without a namespace", async () => {
    const refused = async (type: string) => {
      const error = await cognitoEmailCodes(ISSUER, reply(400, { __type: type, message: "for pat@example.com" })).verify("t", "123456").catch((e: unknown) => e);
      expect(error, type).toBeInstanceOf(ApiError);
      return { status: (error as ApiError).status, code: (error as ApiError).code, reason: (error as ApiError).reason, message: (error as ApiError).message };
    };
    expect(await refused("CodeMismatchException")).toMatchObject({ status: 400, code: "bad_request", reason: "code_mismatch" });
    expect(await refused("com.amazonaws.cognito#ExpiredCodeException")).toMatchObject({ status: 400, code: "bad_request", reason: "code_expired" });
    for (const t of ["LimitExceededException", "TooManyRequestsException", "TooManyFailedAttemptsException"]) expect(await refused(t)).toMatchObject({ status: 429, code: "quota_exceeded" });
    expect(await refused("AliasExistsException")).toMatchObject({ status: 409, code: "aborted", reason: "email_in_use" });
    expect(await refused("CodeDeliveryFailureException")).toMatchObject({ status: 503, code: "internal" });
    expect(await refused("NotAuthorizedException")).toMatchObject({ status: 401, code: "unauthenticated" });
    // Cognito's own message (which could name the address) never reaches the answer
    expect(JSON.stringify(await refused("CodeMismatchException"))).not.toContain("pat@");
  });

  it("fails on anything else, naming only the action, status and error", async () => {
    for (const type of ["InvalidParameterException", "constructor", "toString"]) {
      await expect(cognitoEmailCodes(ISSUER, reply(400, { __type: type, message: "for pat@example.com" })).send("secret-token"), type).rejects.toThrow(/^GetUserAttributeVerificationCode failed: 400 /);
    }
    const error = (await cognitoEmailCodes(ISSUER, reply(500, { __type: "InternalErrorException", message: "pat@example.com" })).verify("secret-token", "123456").catch((e: unknown) => e)) as Error;
    expect(error.message).toBe("VerifyUserAttribute failed: 500 InternalErrorException");
    await expect(cognitoEmailCodes(ISSUER, vi.fn(async () => new Response("<html>", { status: 503 }))).send("t")).rejects.toThrow(/failed: 503 $/);
    await expect(cognitoEmailCodes(ISSUER, reply(400, null)).send("t")).rejects.toThrow(/failed: 400 $/);
    await expect(cognitoEmailCodes(ISSUER, reply(400, { __type: 7 })).send("t")).rejects.toThrow(/failed: 400 $/);
  });

  it("only talks to a Cognito issuer", () => {
    expect(() => cognitoEmailCodes("https://evil.example.com/pool")).toThrow(/not a Cognito user pool issuer/);
  });
});
