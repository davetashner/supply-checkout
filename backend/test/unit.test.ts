// Checks that need no database: keys, TeamContext, region routing, cursors.

import { describe, expect, it } from "vitest";
import {
  ConflictError,
  createDb,
  ForbiddenError,
  InvalidInputError,
  listSheetsByDate,
  localRegion,
  TeamContext,
  updateProduct,
  writeRegionFor,
  type Db,
} from "../src/data/index.js";
import { conflictOnConditionFailure } from "../src/data/errors.js";
import { gsi1, keys, strip } from "../src/data/keys.js";
import { tableName } from "../src/data/schema.js";
import { assertContext, issueContext, writable } from "../src/data/team-context.js";
import { usageMonth } from "../src/data/usage.js";
import { REGION } from "./helpers.js";

/** A Db whose calls fail loudly: these tests must never reach DynamoDB. */
const offline: Db = {
  ...createDb({ tableName: "offline", region: REGION, env: {} }),
  doc: { send: () => Promise.reject(new Error("unexpected DynamoDB call")) } as unknown as Db["doc"],
};

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

  it("is frozen, so the team can't be swapped", () => {
    const ctx = issueContext("t1", "u1", "viewer", REGION);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => Object.assign(ctx, { teamId: "t2" })).toThrow(TypeError);
  });

  it("gates writes by role", () => {
    const viewer = issueContext("t1", "u1", "viewer", REGION);
    const contributor = issueContext("t1", "u1", "contributor", REGION);
    const owner = issueContext("t1", "u1", "owner", REGION);
    const system = issueContext("t1", "system:stripe", "system", REGION);
    expect(() => writable(offline, viewer)).toThrow(ForbiddenError);
    expect(writable(offline, contributor)).toBe(contributor);
    expect(() => writable(offline, contributor, "owner")).toThrow(ForbiddenError);
    expect(writable(offline, owner, "owner")).toBe(owner);
    expect(() => writable(offline, owner, "system")).toThrow(ForbiddenError);
    expect(writable(offline, system, "owner")).toBe(system);
  });

  it("rejects a viewer's write before it reaches DynamoDB", async () => {
    const viewer = issueContext("t1", "u1", "viewer", REGION);
    await expect(updateProduct(offline, viewer, "p1", { code: "", name: "x", price: 1 }, 1)).rejects.toThrow(ForbiddenError);
  });
});

describe("region routing (ADR 0010)", () => {
  it("reads the local region from AWS_REGION, never a constant", () => {
    expect(localRegion({ AWS_REGION: "somewhere-1" })).toBe("somewhere-1");
    expect(localRegion({ AWS_DEFAULT_REGION: "somewhere-2" })).toBe("somewhere-2");
    expect(() => localRegion({})).toThrow(/AWS_REGION/);
  });

  it("sends every team's writes to the local region in the MVP, whatever its home region", () => {
    expect(writeRegionFor({ teamId: "t1", homeRegion: "home-1" }, "local-1")).toBe("local-1");
    // So a team homed elsewhere can still be written here
    const ctx = issueContext("t1", "u1", "owner", "home-1");
    expect(writable(offline, ctx)).toBe(ctx);
  });
});

describe("createDb", () => {
  it("takes the table and region from the Lambda environment", () => {
    const db = createDb({ env: { TABLE_NAME: "tbl", AWS_REGION: "somewhere-1" } });
    expect(db.tableName).toBe("tbl");
    expect(db.region).toBe("somewhere-1");
  });

  it("requires a table name", () => {
    expect(() => createDb({ env: { AWS_REGION: "somewhere-1" } })).toThrow(/TABLE_NAME/);
  });
});

describe("cursors", () => {
  const ctx = issueContext("t1", "u1", "viewer", REGION);
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
  });

  it("rethrows anything else", () => {
    const other = { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ThrottlingError" }] };
    expect(() => map(other)).toThrow(expect.objectContaining({ name: "TransactionCanceledException" }));
    expect(() => map(null)).toThrow();
  });
});
