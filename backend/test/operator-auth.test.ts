// The ops function's Cognito checks (src/operator/cognito.ts) and its
// operator-access role sessions (src/operator/ops-db.ts), with fakes.

import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import { connection } from "../src/data/client.js";
import { InvalidInputError } from "../src/data/index.js";
import { operatorDirectory } from "../src/operator/cognito.js";
import { opsScopedDbs } from "../src/operator/ops-db.js";
import { REGION } from "./helpers.js";

const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_ops`;
const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

function fakeFetch(answers: { status: number; body: unknown }[]) {
  const calls: { url: string; target: string; body: Record<string, unknown>; signed: boolean }[] = [];
  const doFetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, target: headers["x-amz-target"] as string, body: JSON.parse(init.body), signed: "authorization" in headers });
    const next = answers.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  });
  return { doFetch: doFetch as unknown as typeof fetch, calls };
}

describe("operatorDirectory", () => {
  it("refuses an issuer that isn't a Cognito pool", () => {
    expect(() => operatorDirectory({ issuerUrl: "https://example.com/pool", userPoolId: "p", credentials })).toThrow(/issuer/);
  });

  it("asks GetUser with the operator's own token, unsigned, at the pool's endpoint", async () => {
    const { doFetch, calls } = fakeFetch([{ status: 200, body: { Username: "alex", UserAttributes: [{ Name: "sub", Value: "sub-1" }] } }]);
    const dir = operatorDirectory({ issuerUrl: ISSUER, userPoolId: "pool", credentials, fetch: doFetch });
    expect(await dir.getUser("access-token")).toEqual({ username: "alex", sub: "sub-1" });
    expect(calls[0]).toMatchObject({ url: `https://cognito-idp.${REGION}.amazonaws.com/`, target: "AWSCognitoIdentityProviderService.GetUser", body: { AccessToken: "access-token" }, signed: false });
  });

  it.each(["NotAuthorizedException", "UserNotFoundException"])("answers 401 when Cognito says %s (revoked, disabled or deleted)", async (type) => {
    const { doFetch } = fakeFetch([{ status: 400, body: { __type: type, message: "Access Token has been revoked" } }]);
    const dir = operatorDirectory({ issuerUrl: ISSUER, userPoolId: "pool", credentials, fetch: doFetch });
    await expect(dir.getUser("t")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  });

  it("fails without echoing Cognito's message for anything else", async () => {
    const { doFetch } = fakeFetch([
      { status: 500, body: { __type: "com.amazon#InternalErrorException", message: "user alex" } },
      { status: 200, body: { UserAttributes: [] } },
      { status: 500, body: "not json" },
    ]);
    const dir = operatorDirectory({ issuerUrl: ISSUER, userPoolId: "pool", credentials, fetch: doFetch });
    await expect(dir.getUser("t")).rejects.toThrow(/^GetUser failed: 500 InternalErrorException$/);
    await expect(dir.getUser("t")).rejects.toThrow("GetUser answered without a user");
    await expect(dir.getUser("t")).rejects.toThrow(/^GetUser failed: 500$/);
  });

  it("lists the user's groups with a signed AdminListGroupsForUser, following pages", async () => {
    const { doFetch, calls } = fakeFetch([
      { status: 200, body: { Groups: [{ GroupName: "support" }, {}], NextToken: "more" } },
      { status: 200, body: { Groups: [{ GroupName: "operators" }] } },
    ]);
    const dir = operatorDirectory({ issuerUrl: ISSUER, userPoolId: "pool", credentials, fetch: doFetch });
    expect(await dir.groupsFor("alex")).toEqual(["support", "operators"]);
    expect(calls.map((c) => [c.target, c.body, c.signed])).toEqual([
      ["AWSCognitoIdentityProviderService.AdminListGroupsForUser", { UserPoolId: "pool", Username: "alex", Limit: 60 }, true],
      ["AWSCognitoIdentityProviderService.AdminListGroupsForUser", { UserPoolId: "pool", Username: "alex", Limit: 60, NextToken: "more" }, true],
    ]);
  });
});

describe("opsScopedDbs", () => {
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
  const env = { AWS_REGION: REGION, TABLE_NAME: "app" };
  const resolve = (db: ReturnType<ReturnType<typeof opsScopedDbs>>) => (connection(db).client.config.credentials as () => Promise<unknown>)();

  it("names each session after the operator, and tags it with the team or the unused marker", async () => {
    const { sts, calls } = fakeSts();
    const dbFor = opsScopedDbs({ roleArn: "ops-role", env, sts });
    await resolve(dbFor("op-1"));
    await resolve(dbFor("op-1", "team-a"));
    expect(calls).toEqual([
      expect.objectContaining({ RoleArn: "ops-role", RoleSessionName: "ops-op-1", Tags: [{ Key: "teamId", Value: "." }] }),
      expect.objectContaining({ RoleArn: "ops-role", RoleSessionName: "ops-op-1", Tags: [{ Key: "teamId", Value: "team-a" }] }),
    ]);
    // Reused while it lasts
    expect(dbFor("op-1", "team-a")).toBe(dbFor("op-1", "team-a"));
  });

  it("refuses a bad operator or team ID before assuming anything", () => {
    const { sts } = fakeSts();
    const dbFor = opsScopedDbs({ roleArn: "ops-role", env, sts });
    expect(() => dbFor("bad sub")).toThrow(InvalidInputError);
    expect(() => dbFor("op-1", "TEAM#x")).toThrow(InvalidInputError);
    expect(sts.send).not.toHaveBeenCalled();
  });
});
