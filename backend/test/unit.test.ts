// Checks that need no database: keys, TeamContext, region routing, cursors.

import { describe, expect, it } from "vitest";
import * as data from "../src/data/index.js";
import {
  ConflictError,
  createDb,
  ForbiddenError,
  InvalidInputError,
  listSheetsByDate,
  localRegion,
  TeamContext,
  teamContextForStripeCustomer,
  updateProduct,
  writeRegionFor,
} from "../src/data/index.js";
import { connection } from "../src/data/client.js";
import { conflictOnConditionFailure } from "../src/data/errors.js";
import { gsi1, keys, strip } from "../src/data/keys.js";
import { MEMBERS_PER_TEAM, MEMBERS_PER_TRIAL_TEAM, memberCap, teamCounts } from "../src/data/model.js";
import { tableName } from "../src/data/schema.js";
import { assertContext, writable } from "../src/data/team-context.js";
import * as teamContextFile from "../src/data/team-context.js";
import { usageMonth } from "../src/data/usage.js";
import { contextFor, fakeDb, offlineDb, REGION } from "./helpers.js";

const offline = offlineDb();

describe("keys (ADR 0005)", () => {
  it("builds every entity's key", () => {
    expect(keys.team("t1")).toEqual({ PK: "TEAM#t1", SK: "META" });
    expect(keys.member("t1", "u1")).toEqual({ PK: "TEAM#t1", SK: "MEMBER#u1" });
    expect(keys.userTeam("u1", "t1")).toEqual({ PK: "USER#u1", SK: "TEAM#t1" });
    expect(keys.invite("t1", "i1")).toEqual({ PK: "TEAM#t1", SK: "INVITE#i1" });
    expect(keys.product("t1", "0123 456")).toEqual({ PK: "TEAM#t1", SK: "PRODUCT#0123 456" });
    expect(keys.sheet("t1", "s1")).toEqual({ PK: "TEAM#t1", SK: "SHEET#s1" });
    expect(keys.usage("t1", "2026-09")).toEqual({ PK: "TEAM#t1", SK: "USAGE#2026-09" });
    expect(keys.audit("t1", "2026-09-25T00:00:00.000Z", "e1")).toEqual({ PK: "TEAM#t1", SK: "AUDIT#2026-09-25T00:00:00.000Z#e1" });
    expect(keys.stripe("cus_1")).toEqual({ PK: "STRIPE#cus_1", SK: "TEAM" });
    expect(keys.webhook("evt_1")).toEqual({ PK: "WEBHOOK#evt_1", SK: "DONE" });
    expect(gsi1.sheetsByDate("t1", "2026-09-25", "s1")).toEqual({ GSI1PK: "TEAM#t1#SHEETS", GSI1SK: "2026-09-25#s1" });
    expect(gsi1.inviteToken("abc")).toEqual({ GSI1PK: "INVITE#abc", GSI1SK: "INVITE" });
  });

  it("rejects IDs that could reach into another key", () => {
    expect(() => keys.team("t1#SHEET")).toThrow(InvalidInputError);
    expect(() => keys.member("t1", "")).toThrow(InvalidInputError);
    expect(() => keys.sheet("t1", "a".repeat(129))).toThrow(InvalidInputError);
    expect(() => keys.product("t1", "")).toThrow(InvalidInputError);
    expect(() => keys.product("t1", "a\nb")).toThrow(InvalidInputError);
    expect(() => keys.product("t1", "x".repeat(257))).toThrow(InvalidInputError);
    expect(() => keys.usage("t1", "2026-13")).toThrow(InvalidInputError);
    expect(() => gsi1.sheetsByDate("t1", "25/09/2026", "s1")).toThrow(InvalidInputError);
    expect(() => keys.team(42 as unknown as string)).toThrow(InvalidInputError);
  });

  it("strips key attributes from items leaving the module", () => {
    expect(strip({ PK: "a", SK: "b", GSI1PK: "c", GSI1SK: "d", name: "x" })).toEqual({ name: "x" });
    expect(strip(undefined)).toBeUndefined();
  });

  it("names the table per environment, the same in every region", () => {
    expect(tableName("prod")).toBe("supply-checkout-prod-app");
  });

  it("counts usage by UTC month", () => {
    expect(usageMonth(new Date("2026-09-30T23:59:59Z"))).toBe("2026-09");
  });
});

describe("TeamContext (ADR 0005)", () => {
  it("can't be built outside the data layer", () => {
    expect(() => new TeamContext(Symbol("issue TeamContext"), "t1", "u1", "owner", REGION)).toThrow(ForbiddenError);
  });

  it("rejects look-alike objects", () => {
    const fake = Object.create(TeamContext.prototype, { teamId: { value: "t1" }, role: { value: "owner" } }) as TeamContext;
    expect(() => assertContext(fake)).toThrow(ForbiddenError);
    expect(() => assertContext({ teamId: "t1", userId: "u1", role: "owner", homeRegion: REGION } as unknown as TeamContext)).toThrow(ForbiddenError);
  });

  it("has no exported issuer, from the module entry point or its own file", () => {
    for (const exports of [data, teamContextFile]) {
      expect(Object.keys(exports).filter((name) => /issue/i.test(name))).toEqual([]);
    }
    expect(Object.keys(teamContextFile).sort()).toEqual([
      "TeamContext",
      "acceptInvite",
      "assertContext",
      "authorizeTeam",
      "createTeam",
      "findInvite",
      "readable",
      "teamContextForEmailEvent",
      "teamContextForStripeCustomer",
      "writable",
    ]);
  });

  it("is issued to members by authorizeTeam, and to nobody else", async () => {
    const ctx = await contextFor("contributor");
    expect(assertContext(ctx)).toMatchObject({ teamId: "t1", userId: "u1", role: "contributor", homeRegion: REGION });
    const noMember = fakeDb(async () => ({ Responses: [{ Item: { homeRegion: REGION } }, {}] }));
    await expect(data.authorizeTeam(noMember, "u1", "t1")).rejects.toThrow(ForbiddenError);
  });

  it("is issued as system to a Stripe webhook for a linked customer only", async () => {
    const linked = fakeDb(async ({ input }) => ({
      Item: String((input.Key as { PK: string }).PK).startsWith("STRIPE#") ? { teamId: "t1" } : { homeRegion: REGION },
    }));
    expect(await teamContextForStripeCustomer(linked, "cus_1")).toMatchObject({ teamId: "t1", role: "system", userId: "system:stripe" });
    expect(await teamContextForStripeCustomer(fakeDb(async () => ({})), "cus_1")).toBeUndefined();
    const deletedTeam = fakeDb(async ({ input }) => ({
      Item: String((input.Key as { PK: string }).PK).startsWith("STRIPE#") ? { teamId: "t1" } : undefined,
    }));
    expect(await teamContextForStripeCustomer(deletedTeam, "cus_1")).toBeUndefined();
  });

  it("is frozen, so the team can't be swapped", async () => {
    const ctx = await contextFor("viewer");
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => Object.assign(ctx, { teamId: "t2" })).toThrow(TypeError);
  });

  it("gates writes by role", async () => {
    const viewer = await contextFor("viewer");
    const contributor = await contextFor("contributor");
    const owner = await contextFor("owner");
    // Only the Stripe issuer makes a system context; a MEMBER item can't hold that role
    const replies = [{ Item: { teamId: "t1" } }, { Item: { homeRegion: REGION } }];
    const system = (await teamContextForStripeCustomer(fakeDb(async () => replies.shift()), "cus_1")) as TeamContext;
    expect(() => writable(offline, viewer)).toThrow(ForbiddenError);
    expect(writable(offline, contributor)).toBe(contributor);
    expect(() => writable(offline, contributor, "owner")).toThrow(ForbiddenError);
    expect(writable(offline, owner, "owner")).toBe(owner);
    expect(() => writable(offline, owner, "system")).toThrow(ForbiddenError);
    expect(writable(offline, system, "owner")).toBe(system);
  });

  it("treats a MEMBER item with a missing, unknown or system role as no membership", async () => {
    for (const role of [undefined, "superuser", "system", "", 2]) {
      const db = fakeDb(async () => ({ Responses: [{ Item: { homeRegion: REGION } }, { Item: role === undefined ? {} : { role } }] }));
      await expect(data.authorizeTeam(db, "u1", "t1"), String(role)).rejects.toThrow(ForbiddenError);
    }
  });

  it("rejects a viewer's write before it reaches DynamoDB", async () => {
    const viewer = await contextFor("viewer");
    await expect(updateProduct(offline, viewer, "p1", { code: "", name: "x", price: 1 }, 1)).rejects.toThrow(ForbiddenError);
  });
});

describe("region routing (ADR 0010)", () => {
  it("reads the local region from AWS_REGION, never a constant", () => {
    expect(localRegion({ AWS_REGION: "somewhere-1" })).toBe("somewhere-1");
    expect(localRegion({ AWS_DEFAULT_REGION: "somewhere-2" })).toBe("somewhere-2");
    expect(() => localRegion({})).toThrow(/AWS_REGION/);
  });

  it("sends every team's writes to the local region in the MVP, whatever its home region", async () => {
    expect(writeRegionFor({ teamId: "t1", homeRegion: "home-1" }, "local-1")).toBe("local-1");
    // So a team homed elsewhere can still be written here
    const ctx = await contextFor("owner", "home-1");
    expect(writable(offline, ctx)).toBe(ctx);
  });
});

describe("createDb", () => {
  it("takes the table and region from the Lambda environment", () => {
    const db = createDb({ env: { TABLE_NAME: "tbl", AWS_REGION: "somewhere-1" } });
    expect(db.tableName).toBe("tbl");
    expect(db.region).toBe("somewhere-1");
  });

  it("hides the DynamoDB clients behind an opaque handle", () => {
    const db = createDb({ env: { TABLE_NAME: "tbl", AWS_REGION: "somewhere-1" } });
    expect(Object.keys(db).sort()).toEqual(["region", "tableName"]);
    expect(Object.isFrozen(db)).toBe(true);
    expect(connection(db).tableName).toBe("tbl");
    expect(() => connection({ tableName: "tbl", region: "somewhere-1" } as typeof db)).toThrow(/createDb/);
  });

  it("requires a table name", () => {
    expect(() => createDb({ env: { AWS_REGION: "somewhere-1" } })).toThrow(/TABLE_NAME/);
  });
});

describe("cursors", async () => {
  const ctx = await contextFor("viewer");
  const cursor = (key: unknown) => Buffer.from(JSON.stringify(key)).toString("base64url");

  it.each([
    ["not base64 JSON", "%%%"],
    ["another team's partition", cursor({ GSI1PK: "TEAM#t2#SHEETS", GSI1SK: "x", PK: "TEAM#t2", SK: "SHEET#s" })],
    ["an array", cursor(["TEAM#t1#SHEETS"])],
    ["non-string values", cursor({ GSI1PK: "TEAM#t1#SHEETS", GSI1SK: { S: "x" } })],
  ])("rejects %s before querying", async (_label, value) => {
    await expect(listSheetsByDate(offline, ctx, { cursor: value })).rejects.toThrow(InvalidInputError);
  });
});

describe("conflictOnConditionFailure", () => {
  const map = conflictOnConditionFailure("changed");

  it("maps condition failures to ConflictError", () => {
    expect(() => map({ name: "ConditionalCheckFailedException" })).toThrow(ConflictError);
    expect(() => map({ name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }] })).toThrow(ConflictError);
    expect(() => map({ name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }] })).toThrow(ConflictError);
  });

  it("rethrows anything else", () => {
    const other = { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ThrottlingError" }] };
    expect(() => map(other)).toThrow(expect.objectContaining({ name: "TransactionCanceledException" }));
    expect(() => map(null)).toThrow();
  });
});

describe("member cap", () => {
  it("is the trial cap unless the team is paying, and doesn't look at seats yet", () => {
    expect(MEMBERS_PER_TRIAL_TEAM).toBeLessThan(MEMBERS_PER_TEAM);
    for (const status of ["trialing", "canceled", "unpaid", "incomplete", "incomplete_expired", undefined, 7]) expect(memberCap({ status })).toBe(MEMBERS_PER_TRIAL_TEAM);
    for (const status of ["active", "past_due"]) expect(memberCap({ status, seats: 1 })).toBe(MEMBERS_PER_TEAM);
  });

  it("moves both counts in one update on the team's META item", () => {
    const join = teamCounts("t", "team", { members: 1, owners: 1, cap: 10 }).Update;
    expect(join).toMatchObject({
      Key: keys.team("team"),
      UpdateExpression: "ADD #members :members, owners :owners",
      ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(closedAt) AND #members < :cap",
      ExpressionAttributeValues: { ":members": 1, ":owners": 1, ":cap": 10 },
    });
    const leave = teamCounts("t", "team", { members: -1, owners: -1 }).Update;
    expect(leave.ConditionExpression).toBe("attribute_exists(PK) AND attribute_exists(#members) AND owners > :one");
    // The last owner may leave a closed team
    const closed = teamCounts("t", "team", { members: -1, owners: -1, closed: true }).Update;
    expect(closed.ConditionExpression).toBe("attribute_exists(PK) AND attribute_exists(#members) AND attribute_exists(closedAt)");
    const first = teamCounts("t", "team", { members: -1, counted: 0 }).Update;
    expect(first).toMatchObject({ UpdateExpression: "SET #members = :members", ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(#members)", ExpressionAttributeValues: { ":members": 0 } });
    expect(() => teamCounts("t", "team", { members: 1 })).toThrow("cap");
  });
});
