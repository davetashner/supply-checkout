// The billing function's role sessions (src/api/billing-db.ts), with a fake STS.

import type { AssumeRoleCommand } from "@aws-sdk/client-sts";
import { describe, expect, it, vi } from "vitest";
import { billingScopedDbs } from "../src/api/billing-db.js";
import { connection } from "../src/data/client.js";
import type { Db } from "../src/data/index.js";
import { REGION } from "./helpers.js";

const ROLE = "billing-access-role-arn";
const env = { AWS_REGION: REGION, TABLE_NAME: "app" };

function fakeSts() {
  const calls: AssumeRoleCommand["input"][] = [];
  const sts = {
    send: vi.fn(async (command: AssumeRoleCommand) => {
      calls.push(command.input);
      return { Credentials: { AccessKeyId: `AK${calls.length}`, SecretAccessKey: "secret", SessionToken: "token", Expiration: new Date(Date.now() + 3600_000) } };
    }),
  };
  return { sts, calls };
}

async function credentials(db: Db) {
  const provider = connection(db).client.config.credentials as () => Promise<{ accessKeyId: string }>;
  return provider();
}

describe("billingScopedDbs", () => {
  it("tags every session with the team and the Stripe customer, or the unused marker before there is one", async () => {
    const { sts, calls } = fakeSts();
    const dbFor = billingScopedDbs({ roleArn: ROLE, env, sts });
    await credentials(dbFor({ teamId: "team-a" }));
    await credentials(dbFor({ teamId: "team-a", stripeCustomer: "cus_test_1" }));
    expect(calls).toEqual([
      { RoleArn: ROLE, RoleSessionName: "billing-team-a", DurationSeconds: 3600, Tags: [{ Key: "teamId", Value: "team-a" }, { Key: "stripeCustomer", Value: "." }] },
      { RoleArn: ROLE, RoleSessionName: "billing-team-a", DurationSeconds: 3600, Tags: [{ Key: "teamId", Value: "team-a" }, { Key: "stripeCustomer", Value: "cus_test_1" }] },
    ]);
  });

  it("reuses a scope's handle", () => {
    const { sts } = fakeSts();
    const dbFor = billingScopedDbs({ roleArn: ROLE, env, sts });
    expect(dbFor({ teamId: "team-a" })).toBe(dbFor({ teamId: "team-a" }));
    expect(dbFor({ teamId: "team-a" })).not.toBe(dbFor({ teamId: "team-a", stripeCustomer: "cus_test_1" }));
  });

  it("refuses a malformed team or customer before assuming anything", () => {
    const { sts } = fakeSts();
    const dbFor = billingScopedDbs({ roleArn: ROLE, env, sts, maxScopes: 2 });
    for (const bad of ["", "TEAM#x", "x".repeat(129), 7 as unknown as string]) expect(() => dbFor({ teamId: bad })).toThrow(/Invalid team ID/);
    for (const bad of ["", ".", "cus/1", "STRIPE#cus", 7 as unknown as string]) expect(() => dbFor({ teamId: "team-a", stripeCustomer: bad })).toThrow(/Invalid Stripe customer ID/);
    expect(sts.send).not.toHaveBeenCalled();
  });

  it("defaults its STS client and clock", () => {
    expect(billingScopedDbs({ roleArn: ROLE, env })({ teamId: "team-a" }).tableName).toBe("app");
  });
});
