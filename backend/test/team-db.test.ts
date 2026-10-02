// Per-team role sessions (src/api/team-db.ts), with a fake STS.

import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import { CLOSE_EVICTED_AFTER_MS, receiptScopedDbs, teamScopedDbs } from "../src/api/team-db.js";
import { connection } from "../src/data/client.js";
import type { Db } from "../src/data/index.js";
import { REGION } from "./helpers.js";

const ROLE = "data-access-role-arn";

function fakeSts(lifetimeMs = 3600_000) {
  const calls: AssumeRoleCommand["input"][] = [];
  const sts = {
    send: vi.fn(async (command: AssumeRoleCommand) => {
      calls.push(command.input);
      return {
        Credentials: {
          AccessKeyId: `AK${calls.length}`,
          SecretAccessKey: "secret",
          SessionToken: "token",
          Expiration: new Date(Date.now() + lifetimeMs),
        },
      };
    }),
  };
  return { sts, calls };
}

const env = { AWS_REGION: REGION, TABLE_NAME: "app" };

/** Resolves the credentials the handle's DynamoDB client would sign with. */
async function credentials(db: Db) {
  const provider = connection(db).client.config.credentials as () => Promise<{ accessKeyId: string }>;
  return provider();
}

describe("teamScopedDbs", () => {
  it("signs each team's calls with a role session tagged with that team", async () => {
    const { sts, calls } = fakeSts();
    const dbForTeam = teamScopedDbs({ roleArn: ROLE, env, sts });
    const a = dbForTeam("team-a");
    expect(a.tableName).toBe("app");
    expect(a.region).toBe(REGION);
    expect((await credentials(a)).accessKeyId).toBe("AK1");
    expect(calls).toEqual([
      { RoleArn: ROLE, RoleSessionName: "team-team-a", DurationSeconds: 3600, Tags: [{ Key: "teamId", Value: "team-a" }] },
    ]);
    await credentials(dbForTeam("team-b"));
    expect(calls[1]?.Tags).toEqual([{ Key: "teamId", Value: "team-b" }]);
  });

  it("reuses a team's handle and session while it's fresh", async () => {
    const { sts } = fakeSts();
    const dbForTeam = teamScopedDbs({ roleArn: ROLE, env, sts });
    const a = dbForTeam("team-a");
    expect(dbForTeam("team-a")).toBe(a);
    await Promise.all([credentials(a), credentials(a)]);
    await credentials(a);
    expect(sts.send).toHaveBeenCalledTimes(1);
  });

  it("assumes the role again when the session is about to expire", async () => {
    const { sts } = fakeSts(60_000);
    const dbForTeam = teamScopedDbs({ roleArn: ROLE, env, sts });
    const a = dbForTeam("team-a");
    const first = await credentials(a);
    const second = await credentials(a);
    // (The SDK's own cache also refreshes near expiry, so it may ask more than once)
    expect(second.accessKeyId).not.toBe(first.accessKeyId);
    expect(sts.send.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("fails if STS returns no credentials, and tries again next time", async () => {
    const sts = { send: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ Credentials: { AccessKeyId: "AK", SecretAccessKey: "s", SessionToken: "t", Expiration: new Date(Date.now() + 3600_000) } }) };
    const a = teamScopedDbs({ roleArn: ROLE, env, sts })("team-a");
    await expect(credentials(a)).rejects.toThrow(/no credentials/);
    expect((await credentials(a)).accessKeyId).toBe("AK");
  });

  it("refuses an invalid team ID before assuming anything", () => {
    const { sts } = fakeSts();
    const dbForTeam = teamScopedDbs({ roleArn: ROLE, env, sts });
    for (const bad of ["", "TEAM#x", "a/b", "x".repeat(129), 7 as unknown as string]) expect(() => dbForTeam(bad)).toThrow(/Invalid team ID/);
    expect(sts.send).not.toHaveBeenCalled();
  });

  it("keeps at most maxTeams handles, closing the least recently used once no request can still be using it", () => {
    vi.useFakeTimers();
    const { sts } = fakeSts();
    const dbForTeam = teamScopedDbs({ roleArn: ROLE, env, sts, maxTeams: 2 });
    const a = dbForTeam("a");
    const b = dbForTeam("b");
    const destroyB = vi.spyOn(connection(b).client, "destroy");
    dbForTeam("a");
    dbForTeam("c");
    // Evicted, but a request that already holds it can finish
    expect(destroyB).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CLOSE_EVICTED_AFTER_MS - 1);
    expect(destroyB).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    expect(destroyB).toHaveBeenCalled();
    expect(dbForTeam("a")).toBe(a);
    expect(dbForTeam("b")).not.toBe(b);
  });

  it("truncates the session name to STS's 64 characters", async () => {
    const { sts, calls } = fakeSts();
    await credentials(teamScopedDbs({ roleArn: ROLE, env, sts })("t".repeat(128)));
    expect(calls[0]?.RoleSessionName).toHaveLength(64);
    expect(calls[0]?.Tags).toEqual([{ Key: "teamId", Value: "t".repeat(128) }]);
  });
});

describe("receiptScopedDbs", () => {
  it("signs each team and user's calls with a session tagged with both, one handle per pair", async () => {
    const { sts, calls } = fakeSts();
    const dbFor = receiptScopedDbs({ roleArn: ROLE, env, sts });
    const a = dbFor("team-a", "user-1");
    expect(dbFor("team-a", "user-1")).toBe(a);
    expect(dbFor("team-a", "user-2")).not.toBe(a);
    expect(dbFor("team-b", "user-1")).not.toBe(a);
    await credentials(a);
    expect(calls).toEqual([
      { RoleArn: ROLE, RoleSessionName: "receipts-team-a", DurationSeconds: 3600, Tags: [{ Key: "teamId", Value: "team-a" }, { Key: "userId", Value: "user-1" }] },
    ]);
  });

  it("refuses an invalid team or user ID before assuming anything", () => {
    const { sts } = fakeSts();
    const dbFor = receiptScopedDbs({ roleArn: ROLE, env, sts });
    expect(() => dbFor("team a", "user-1")).toThrow("Invalid team ID");
    expect(() => dbFor("team-a", "user/1")).toThrow("Invalid user ID");
    expect(() => dbFor("team-a", "")).toThrow("Invalid user ID");
    expect(sts.send).not.toHaveBeenCalled();
  });
});
