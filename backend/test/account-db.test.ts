// Per-user role sessions for the account API (src/api/account-db.ts) with a
// fake STS, and the Cognito GetUser client (src/api/cognito-user.ts) with a
// fake fetch.

import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import { accountScopedDbs } from "../src/api/account-db.js";
import { cognitoDeleteUser, cognitoEmailCodes, cognitoTotp, cognitoUserInfo } from "../src/api/cognito-user.js";
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
    expect(await cognitoUserInfo(ISSUER, fetch)("access-token")).toEqual({ sub: "user-1", email: "pat@example.com", emailVerified: true, emailVerifiedInCognito: true, totp: false, federated: false });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cognito-idp.test-local-1.amazonaws.com/");
    expect(init.headers).toMatchObject({ "x-amz-target": "AWSCognitoIdentityProviderService.GetUser" });
    expect(JSON.parse(init.body as string)).toEqual({ AccessToken: "access-token" });
  });

  it("gives the name from given_name and family_name, made safe to store, and none when there's none (supply-checkout-lx7)", async () => {
    const named = (attributes: Record<string, string>) =>
      reply(200, { UserAttributes: [{ Name: "sub", Value: "u" }, ...Object.entries(attributes).map(([Name, Value]) => ({ Name, Value }))] });
    expect((await cognitoUserInfo(ISSUER, named({ given_name: " Pat ", family_name: "Lee\u202E" }))("t")).name).toBe("Pat Lee");
    expect((await cognitoUserInfo(ISSUER, named({ given_name: "Pat" }))("t")).name).toBe("Pat");
    expect(await cognitoUserInfo(ISSUER, named({ given_name: "  " }))("t")).not.toHaveProperty("name");
    expect(await cognitoUserInfo(ISSUER, named({}))("t")).not.toHaveProperty("name");
  });

  it("treats an unverified or missing email as unverified", async () => {
    const unverified = reply(200, { UserAttributes: [{ Name: "sub", Value: "u" }, { Name: "email", Value: "a@example.com" }, { Name: "email_verified", Value: "false" }] });
    expect(await cognitoUserInfo(ISSUER, unverified)("t")).toMatchObject({ emailVerified: false, emailVerifiedInCognito: false, totp: false, federated: false });
    expect(await cognitoUserInfo(ISSUER, reply(200, {}))("t")).toEqual({ sub: "", email: undefined, emailVerified: false, emailVerifiedInCognito: false, totp: false, federated: false });
  });

  it("says what Cognito says of email_verified apart from whether the API trusts the email", async () => {
    // A linked user whose email isn't the recorded one: Cognito says verified, the API doesn't trust it
    const rewritten = reply(200, {
      Username: "u",
      UserAttributes: [
        { Name: "sub", Value: "u" },
        { Name: "email", Value: "pat@example.com" },
        { Name: "email_verified", Value: "true" },
        { Name: "identities", Value: JSON.stringify([{ providerName: "Google", providerType: "Google", userId: "1" }]) },
        { Name: "custom:linked_email", Value: "someone@example.net" },
      ],
    });
    expect(await cognitoUserInfo(ISSUER, rewritten)("t")).toMatchObject({ emailVerified: false, emailVerifiedInCognito: true });
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

  it("says whether an authenticator app is on and preferred, and whether it's a Google or Apple user", async () => {
    const google = JSON.stringify([{ userId: "1076", providerName: "Google", providerType: "Google" }]);
    const user = (body: Record<string, unknown>) => cognitoUserInfo(ISSUER, reply(200, { Username: "u", UserAttributes: [{ Name: "sub", Value: "u" }], ...body }))("t");
    expect(await user({ UserMFASettingList: ["SOFTWARE_TOKEN_MFA"], PreferredMfaSetting: "SOFTWARE_TOKEN_MFA" })).toMatchObject({ totp: true, federated: false });
    // On but not preferred, preferred but not on, or not a list: Cognito might not ask for it
    expect(await user({ UserMFASettingList: ["SOFTWARE_TOKEN_MFA"] })).toMatchObject({ totp: false });
    expect(await user({ UserMFASettingList: ["EMAIL_OTP"], PreferredMfaSetting: "SOFTWARE_TOKEN_MFA" })).toMatchObject({ totp: false });
    expect(await user({ UserMFASettingList: "SOFTWARE_TOKEN_MFA", PreferredMfaSetting: "SOFTWARE_TOKEN_MFA" })).toMatchObject({ totp: false });
    expect(await user({ Username: "google_1076", UserAttributes: [{ Name: "sub", Value: "u" }, { Name: "identities", Value: google }] })).toMatchObject({ totp: false, federated: true });
    // A native user with Google linked signs in natively too: not federated
    expect(await user({ UserAttributes: [{ Name: "sub", Value: "u" }, { Name: "identities", Value: google }] })).toMatchObject({ federated: false });
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

describe("cognitoDeleteUser", () => {
  const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it("calls DeleteUser on the issuer's endpoint with the caller's own token: no IAM, and only that user", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await cognitoDeleteUser(ISSUER, fetch)("access-token");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cognito-idp.test-local-1.amazonaws.com/");
    expect(init.headers).toEqual({ "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.DeleteUser" });
    expect(JSON.parse(init.body as string)).toEqual({ AccessToken: "access-token" });
  });

  it("answers 401 to a revoked token or a user already gone, and fails on anything else without Cognito's message", async () => {
    await expect(cognitoDeleteUser(ISSUER, reply(400, { __type: "NotAuthorizedException" }))("t")).rejects.toThrow(ApiError);
    await expect(cognitoDeleteUser(ISSUER, reply(400, { __type: "UserNotFoundException" }))("t")).rejects.toThrow(ApiError);
    await expect(cognitoUserInfo(ISSUER, reply(400, { __type: "UserNotFoundException" }))("t")).rejects.toThrow(ApiError);
    await expect(cognitoDeleteUser(ISSUER, reply(400, { __type: "InvalidParameterException", message: "pat@example.com" }))("t")).rejects.toThrow(/^DeleteUser failed: 400 InvalidParameterException$/);
    await expect(cognitoDeleteUser(ISSUER, vi.fn(async () => new Response("<html>", { status: 503 })))("t")).rejects.toThrow(/DeleteUser failed: 503/);
  });

  it("only talks to a Cognito issuer", () => {
    expect(() => cognitoDeleteUser("https://evil.example.com/pool")).toThrow(/not a Cognito user pool issuer/);
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

describe("cognitoTotp", () => {
  const ISSUER = "https://cognito-idp.test-local-1.amazonaws.com/test-local-1_pool";
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const sent = (fetch: ReturnType<typeof reply>) =>
    fetch.mock.calls.map((c) => {
      const [, init] = c as unknown as [string, RequestInit];
      return [(init.headers as Record<string, string>)["x-amz-target"]?.split(".")[1], JSON.parse(init.body as string)];
    });

  it("makes each call with the caller's own token", async () => {
    const fetch = reply(200, { SecretCode: "JBSWY3DPEHPK3PXP", Status: "SUCCESS" });
    const totp = cognitoTotp(ISSUER, fetch);
    await totp.setPassword("t", "New-Password-1");
    await totp.setPassword("t", "New-Password-2", "New-Password-1");
    expect(await totp.associate("t")).toBe("JBSWY3DPEHPK3PXP");
    await totp.verify("t", "654321");
    await totp.signOutEverywhere("t");
    expect(sent(fetch)).toEqual([
      ["ChangePassword", { AccessToken: "t", ProposedPassword: "New-Password-1" }],
      ["ChangePassword", { AccessToken: "t", ProposedPassword: "New-Password-2", PreviousPassword: "New-Password-1" }],
      ["AssociateSoftwareToken", { AccessToken: "t" }],
      ["VerifySoftwareToken", { AccessToken: "t", UserCode: "654321", FriendlyDeviceName: "Authenticator app" }],
      ["SetUserMFAPreference", { AccessToken: "t", SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true } }],
      ["GlobalSignOut", { AccessToken: "t" }],
    ]);
  });

  it("turns nothing on for a code Cognito doesn't accept", async () => {
    const fetch = reply(200, { Status: "ERROR" });
    await expect(cognitoTotp(ISSUER, fetch).verify("t", "654321")).rejects.toMatchObject({ status: 400, reason: "code_mismatch" });
    expect(sent(fetch).map((c) => c[0])).toEqual(["VerifySoftwareToken"]);
  });

  it("fails without a secret", async () => {
    await expect(cognitoTotp(ISSUER, reply(200, {})).associate("t")).rejects.toThrow(/no secret/);
  });

  it("passes on the refusals the person can act on, and nothing of Cognito's message", async () => {
    const refused = (type: string, message = "") => cognitoTotp(ISSUER, reply(400, { __type: `com.amazonaws#${type}`, message }));
    await expect(refused("NotAuthorizedException", "Incorrect username or password.").setPassword("t", "p", "old")).rejects.toMatchObject({ status: 400, reason: "password_mismatch" });
    await expect(refused("NotAuthorizedException", "Access Token has been revoked").setPassword("t", "p")).rejects.toMatchObject({ status: 401 });
    await expect(refused("NotAuthorizedException").associate("t")).rejects.toMatchObject({ status: 401 });
    await expect(refused("InvalidPasswordException", "Password did not conform with policy").setPassword("t", "p")).rejects.toMatchObject({ status: 400, reason: "password_invalid" });
    await expect(refused("PasswordHistoryPolicyViolationException").setPassword("t", "p")).rejects.toMatchObject({ status: 400, reason: "password_invalid" });
    await expect(refused("InvalidParameterException").setPassword("t", "p")).rejects.toMatchObject({ status: 400, reason: "password_mismatch" });
    // Only ChangePassword's means a missing current password
    await expect(refused("InvalidParameterException").associate("t")).rejects.toThrow("AssociateSoftwareToken failed: 400 InvalidParameterException");
    await expect(refused("NotAuthorizedException", "Password attempts exceeded").setPassword("t", "p", "old")).rejects.toMatchObject({ status: 429 });
    for (const type of ["CodeMismatchException", "EnableSoftwareTokenMFAException"]) await expect(refused(type).verify("t", "1")).rejects.toMatchObject({ status: 400, reason: "code_mismatch" });
    await expect(refused("SoftwareTokenMFANotFoundException").verify("t", "1")).rejects.toMatchObject({ status: 409, reason: "code_expired" });
    for (const type of ["LimitExceededException", "TooManyRequestsException", "TooManyFailedAttemptsException"]) await expect(refused(type).verify("t", "1")).rejects.toMatchObject({ status: 429 });
    const unknown = refused("InternalErrorException", "secret stuff: t");
    await expect(unknown.signOutEverywhere("t")).rejects.toThrow("GlobalSignOut failed: 400 InternalErrorException");
    await expect(cognitoTotp(ISSUER, reply(500, {})).associate("t")).rejects.toThrow("AssociateSoftwareToken failed: 500 ");
  });
});
