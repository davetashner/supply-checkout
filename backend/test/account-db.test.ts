// Per-user role sessions for the account API (src/api/account-db.ts) with a
// fake STS, and the Cognito GetUser client (src/api/cognito-user.ts) with a
// fake fetch.

import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import { accountScopedDbs } from "../src/api/account-db.js";
import { cognitoUserInfo } from "../src/api/cognito-user.js";
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
  it("tags every session with the user, and the team and invitee or the unused marker", async () => {
    const { sts, calls } = fakeSts();
    const dbFor = accountScopedDbs({ roleArn: ROLE, env, sts });
    const invitee = hashEmail("pat@example.com");
    await credentials(dbFor({ userId: "user-1" }));
    await credentials(dbFor({ userId: "user-1", teamId: "team-a" }));
    await credentials(dbFor({ userId: "user-1", invitee }));
    expect(calls.map((c) => [c.RoleArn, c.RoleSessionName, c.Tags])).toEqual([
      [ROLE, "user-user-1", [{ Key: "userId", Value: "user-1" }, { Key: "teamId", Value: "." }, { Key: "invitee", Value: "." }]],
      [ROLE, "user-user-1", [{ Key: "userId", Value: "user-1" }, { Key: "teamId", Value: "team-a" }, { Key: "invitee", Value: "." }]],
      [ROLE, "user-user-1", [{ Key: "userId", Value: "user-1" }, { Key: "teamId", Value: "." }, { Key: "invitee", Value: invitee }]],
    ]);
    // The same scope reuses its handle and session
    expect(dbFor({ userId: "user-1", teamId: "team-a" })).toBe(dbFor({ userId: "user-1", teamId: "team-a" }));
    await credentials(dbFor({ userId: "user-1", teamId: "team-a" }));
    expect(calls).toHaveLength(3);
  });

  it("refuses anything that could reach into another key", () => {
    const dbFor = accountScopedDbs({ roleArn: ROLE, env, sts: fakeSts().sts });
    for (const scope of [{ userId: "USER#x" }, { userId: "" }, { userId: "u", teamId: "a#b" }, { userId: "u", invitee: "pat@example.com" }, { userId: "u", invitee: "A".repeat(64) }]) {
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
