// Checks that need no database: keys, TeamContext, region routing, cursors.

import { describe, expect, it } from "vitest";
import * as data from "../src/data/index.js";
import {
  ConflictError,
  createDb,
  ForbiddenError,
  InvalidInputError,
  listProjectsByDate,
  localRegion,
  TeamContext,
  teamContextForStripeCustomer,
  updateProduct,
  writeRegionFor,
} from "../src/data/index.js";
import { connection } from "../src/data/client.js";
import { conflictOnConditionFailure, isCancelledAsTooLarge, isItemTooLarge, startsWithAny } from "../src/data/errors.js";
import { retryDelay } from "../src/data/documents.js";
import { MAX_MONEY, money } from "../src/data/money.js";
import { date, dateFormat, gsi1, keys, strip } from "../src/data/keys.js";
import { legacy } from "../src/data/legacy-sheets.js";
import { billingAccess, deletionLastDay, deletionTime, MEMBERS_PER_TEAM, MEMBERS_PER_TRIAL_TEAM, memberCap, PAYMENT_GRACE_DAYS, READ_ONLY_RETENTION_DAYS, teamCounts } from "../src/data/model.js";
import { tableName } from "../src/data/schema.js";
import { assertContext, writable } from "../src/data/team-context.js";
import * as teamContextFile from "../src/data/team-context.js";
import { usageMonth } from "../src/data/usage.js";
import { contextFor, fakeDb, offlineDb, REGION } from "./helpers.js";

const offline = offlineDb();

describe("keys (ADR 0005)", () => {
  it("takes only dates that exist, from 2000 on, and lets the index take any date's form", () => {
    for (const day of ["2000-01-01", "2026-10-07", "2028-02-29", "2026-12-31", "9999-12-31"]) expect(date(day)).toBe(day);
    for (const day of ["2026-02-30", "2026-04-31", "2025-02-29", "0000-01-01", "1999-12-31", "2026-13-01", "2026-1-01", "", undefined, 20261007]) {
      expect(() => date(day), String(day)).toThrow(InvalidInputError);
    }
    // The date index and a date range's bounds only need the form
    expect(dateFormat("2026-02-30")).toBe("2026-02-30");
    expect(dateFormat("0000-01-01")).toBe("0000-01-01");
    expect(() => dateFormat("2026-2-30")).toThrow(InvalidInputError);
  });

  it("builds every entity's key", () => {
    expect(keys.team("t1")).toEqual({ PK: "TEAM#t1", SK: "META" });
    expect(keys.member("t1", "u1")).toEqual({ PK: "TEAM#t1", SK: "MEMBER#u1" });
    expect(keys.userTeam("u1", "t1")).toEqual({ PK: "USER#u1", SK: "TEAM#t1" });
    expect(keys.invite("t1", "i1")).toEqual({ PK: "TEAM#t1", SK: "INVITE#i1" });
    expect(keys.product("t1", "0123 456")).toEqual({ PK: "TEAM#t1", SK: "PRODUCT#0123 456" });
    expect(keys.project("t1", "s1")).toEqual({ PK: "TEAM#t1", SK: "PROJECT#s1" });
    expect(() => keys.project("t1", "a#b")).toThrow(InvalidInputError);
    expect(keys.usage("t1", "2026-09")).toEqual({ PK: "TEAM#t1", SK: "USAGE#2026-09" });
    expect(keys.audit("t1", "2026-09-25T00:00:00.000Z", "e1")).toEqual({ PK: "TEAM#t1", SK: "AUDIT#2026-09-25T00:00:00.000Z#e1" });
    expect(keys.stripe("cus_1")).toEqual({ PK: "STRIPE#cus_1", SK: "TEAM" });
    expect(keys.webhook("evt_1")).toEqual({ PK: "WEBHOOK#evt_1", SK: "DONE" });
    expect(gsi1.projectsByDate("t1", "2026-09-25", "s1")).toEqual({ GSI1PK: "TEAM#t1#PROJECTS", GSI1SK: "2026-09-25#s1" });
    expect(gsi1.projectsPartition("t1")).toBe("TEAM#t1#PROJECTS");
    expect(() => gsi1.projectsByDate("t1", "25/09/2026", "s1")).toThrow(InvalidInputError);
    expect(gsi1.inviteToken("abc")).toEqual({ GSI1PK: "INVITE#abc", GSI1SK: "INVITE" });
  });

  it("rejects IDs that could reach into another key", () => {
    expect(() => keys.team("t1#PROJECT")).toThrow(InvalidInputError);
    expect(() => keys.member("t1", "")).toThrow(InvalidInputError);
    expect(() => keys.project("t1", "a".repeat(129))).toThrow(InvalidInputError);
    expect(() => keys.product("t1", "")).toThrow(InvalidInputError);
    expect(() => keys.product("t1", "a\nb")).toThrow(InvalidInputError);
    expect(() => keys.product("t1", "x".repeat(257))).toThrow(InvalidInputError);
    expect(() => keys.usage("t1", "2026-13")).toThrow(InvalidInputError);
    expect(() => gsi1.projectsByDate("t1", "25/09/2026", "s1")).toThrow(InvalidInputError);
    expect(() => keys.team(42 as unknown as string)).toThrow(InvalidInputError);
  });

  it("builds a project's legacy keys from before the rename, checking the IDs the same way (supply-checkout-005.6)", () => {
    expect(legacy.sheetKey("t1", "s1")).toEqual({ PK: "TEAM#t1", SK: "SHEET#s1" });
    expect(legacy.sheetsPartition("t1")).toBe("TEAM#t1#SHEETS");
    expect(legacy.sheetPrefix).toBe("SHEET#");
    for (const bad of ["a#b", "a".repeat(129), ""]) expect(() => legacy.sheetKey("t1", bad)).toThrow(InvalidInputError);
    expect(() => legacy.sheetKey("t1#x", "s1")).toThrow(InvalidInputError);
    expect(() => legacy.sheetsPartition("t1#x")).toThrow(InvalidInputError);
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

  it("ends a request that takes longer than requestTimeoutMs, so it's retried and fails instead of hanging", async () => {
    const { createServer } = await import("node:http");
    // @smithy/node-http-handler only logs a warning on requestTimeout unless throwOnRequestTimeout is set
    // (createDb passes both in the requestHandler options, which NodeHttpHandler.create takes as its config);
    // without it this request hangs until the test times out.
    // Accepts requests and never answers them
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const db = createDb({ tableName: "tbl", region: "somewhere-1", endpoint: `http://127.0.0.1:${port}`, requestTimeoutMs: 50, env: {} });
      const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
      const started = Date.now();
      await expect(connection(db).doc.send(new GetCommand({ TableName: "tbl", Key: { PK: "a", SK: "b" } }))).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
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
    ["another team's partition", cursor({ GSI1PK: "TEAM#t2#PROJECTS", GSI1SK: "x", PK: "TEAM#t2", SK: "PROJECT#s" })],
    ["an array", cursor(["TEAM#t1#PROJECTS"])],
    ["non-string values", cursor({ GSI1PK: "TEAM#t1#PROJECTS", GSI1SK: { S: "x" } })],
  ])("rejects %s before querying", async (_label, value) => {
    await expect(listProjectsByDate(offline, ctx, { cursor: value })).rejects.toThrow(InvalidInputError);
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

describe("DynamoDB's item-size refusal (supply-checkout-j1mu)", () => {
  const validation = (message: unknown) => ({ name: "ValidationException", message });
  const cancelled = (...reasons: { Code?: string; Message?: string }[]) => ({ name: "TransactionCanceledException", message: "Transaction cancelled", CancellationReasons: reasons });

  it("matches DynamoDB's messages from the start only", () => {
    expect(startsWithAny("  Item size has exceeded the maximum allowed size (x)", ["Item size has exceeded the maximum allowed size"])).toBe(true);
    expect(startsWithAny("Not: Item size has exceeded the maximum allowed size", ["Item size has exceeded the maximum allowed size"])).toBe(false);
    expect(startsWithAny(undefined, ["Item size"])).toBe(false);
  });

  it("is a ValidationException with a size message, or a transaction cancelled with one as a ValidationError", () => {
    expect(isItemTooLarge(validation("Item size has exceeded the maximum allowed size"))).toBe(true);
    expect(isItemTooLarge(validation("Item size to update has exceeded the maximum allowed size"))).toBe(true);
    expect(isItemTooLarge(cancelled({ Code: "None" }, { Code: "ValidationError", Message: "Item size to update has exceeded the maximum allowed size" }))).toBe(true);
    expect(isCancelledAsTooLarge(cancelled({ Code: "ValidationError", Message: "Item size has exceeded the maximum allowed size" }))).toBe(true);
    // Anything else isn't
    for (const error of [
      validation("One or more parameter values were invalid: Size of hashkey has exceeded the maximum size limit of 2048 bytes"),
      validation(42),
      { name: "SomethingElse", message: "Item size has exceeded the maximum allowed size" },
      cancelled({ Code: "ValidationError", Message: "Invalid size" }),
      cancelled({ Code: "ConditionalCheckFailed", Message: "Item size has exceeded the maximum allowed size" }),
      cancelled(),
      { name: "TransactionCanceledException" },
      null,
      undefined,
    ]) {
      expect(isItemTooLarge(error), JSON.stringify(error)).toBe(false);
    }
    expect(isCancelledAsTooLarge(validation("Item size has exceeded the maximum allowed size"))).toBe(false);
  });

  it("backs off a lost race with full jitter, up to a cap", () => {
    expect(retryDelay(1, () => 0)).toBe(0);
    expect(retryDelay(1, () => 0.999)).toBe(19);
    expect(retryDelay(3, () => 0.5)).toBe(40);
    expect(retryDelay(10, () => 0.999)).toBe(199);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const ms = retryDelay(attempt);
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(ms).toBeLessThan(200);
    }
  });
});

describe("money (ADR 0014, supply-checkout-mryk)", () => {
  it("stores whole cents, including a sum a hair off them", () => {
    expect(money(0.1 + 0.2, "price")).toBe(0.3);
    expect(money(12.5, "price")).toBe(12.5);
    expect(money(0, "price")).toBe(0);
    expect(money(MAX_MONEY, "price")).toBe(MAX_MONEY);
    for (const bad of [0.001, 1.005, -0.01, MAX_MONEY + 0.01, Number.NaN, "3"]) expect(() => money(bad, "price"), String(bad)).toThrow(data.InvalidInputError);
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

describe("billing access (billingAccess, ADR 0009, supply-checkout-qdx)", () => {
  const NOW = new Date("2026-10-02T12:00:00.000Z");
  const DAY = 86400_000;
  const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();

  it("uses the Terms' periods", () => {
    expect(PAYMENT_GRACE_DAYS).toBe(7);
    expect(READ_ONLY_RETENTION_DAYS).toBe(30);
  });

  it("gives full access to an active team, a Stripe trial, an incomplete or paused subscription, and anything it doesn't know", () => {
    for (const team of [
      { status: "active" },
      { status: "trialing", stripeSubscriptionId: "sub_1", trialEndsAt: at(-5) },
      { status: "incomplete", stripeSubscriptionId: "sub_1" },
      { status: "paused", stripeSubscriptionId: "sub_1" },
      {},
      { status: 7 },
    ]) {
      expect(billingAccess(team, NOW)).toEqual({ readOnly: false });
    }
  });

  it("rounds a deletion up to the end of its UTC date everywhere (UTC-12), and states that date, so nobody loses data on the day they were told", () => {
    const cases: [string, string, string][] = [
      // Due at 12:00 UTC on Nov 1: told November 1, deleted at 12:00 UTC on Nov 2 (04:00 or 05:00 Pacific, midnight in UTC-12)
      ["2026-11-01T12:00:00.000Z", "2026-11-02T12:00:00.000Z", "2026-11-01"],
      // The first and last moments of a UTC date round to the same time
      ["2026-11-01T00:00:00.000Z", "2026-11-02T12:00:00.000Z", "2026-11-01"],
      ["2026-11-01T23:59:59.999Z", "2026-11-02T12:00:00.000Z", "2026-11-01"],
      // Across a month and a year
      ["2026-12-31T20:00:00.000Z", "2027-01-01T12:00:00.000Z", "2026-12-31"],
    ];
    for (const [due, time, day] of cases) {
      const rounded = deletionTime(Date.parse(due));
      expect(new Date(rounded).toISOString(), due).toBe(time);
      expect(rounded).toBeGreaterThanOrEqual(Date.parse(due));
      expect(deletionLastDay(new Date(rounded).toISOString())).toBe(day);
    }
    // November 1 is over in every US time zone (Hawaii is UTC-10, Samoa UTC-11) before it's deleted
    for (const zone of ["America/New_York", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "Pacific/Pago_Pago"]) {
      const local = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date("2026-11-02T12:00:00.000Z"));
      expect(local, zone).toBe("2026-11-02");
    }
    // billingAccess gives the rounded time: 30 days from noon is the next day's noon
    expect(billingAccess({ status: "trialing", trialEndsAt: "2026-10-02T03:00:00.000Z" }, NOW)).toMatchObject({ deleteAfter: "2026-11-02T12:00:00.000Z" });
  });

  it("makes an app trial read-only when it ends, with a deletion date 30 days on, and never on a date it can't read", () => {
    expect(billingAccess({ status: "trialing", trialEndsAt: at(1) }, NOW)).toEqual({ readOnly: false });
    expect(billingAccess({ status: "trialing", trialEndsAt: at(0) }, NOW)).toEqual({ readOnly: true, reason: "trial_ended", readOnlyFrom: at(0), deleteAfter: at(31) });
    // A team from before trials: TRIAL_DAYS after it was made
    expect(billingAccess({ status: "trialing", createdAt: at(-20) }, NOW)).toEqual({ readOnly: true, reason: "trial_ended", readOnlyFrom: at(-6), deleteAfter: at(25) });
    expect(billingAccess({ status: "trialing", trialEndsAt: "soon", createdAt: "long ago" }, NOW)).toEqual({ readOnly: false });
  });

  it("makes an ended subscription read-only, and deletes it 30 days after it ended only when that's recorded", () => {
    for (const status of ["canceled", "incomplete_expired"]) {
      expect(billingAccess({ status, subscriptionEndedAt: at(-3) }, NOW)).toEqual({ readOnly: true, reason: "subscription_ended", readOnlyFrom: at(-3), deleteAfter: at(28) });
      expect(billingAccess({ status }, NOW)).toEqual({ readOnly: true, reason: "subscription_ended" });
      expect(billingAccess({ status, subscriptionEndedAt: "yesterday" }, NOW)).toEqual({ readOnly: true, reason: "subscription_ended" });
    }
  });

  it("makes an unpaid subscription read-only as an overdue payment at once, and never gives it a deletion date (Terms 5.6)", () => {
    expect(billingAccess({ status: "unpaid" }, NOW)).toEqual({ readOnly: true, reason: "payment_overdue" });
    expect(billingAccess({ status: "unpaid", subscriptionEndedAt: at(-60), pastDueSince: at(-1) }, NOW)).toEqual({ readOnly: true, reason: "payment_overdue" });
    expect(billingAccess({ status: "unpaid", compPlan: "starter", compUntil: at(1) }, NOW)).toEqual({ readOnly: false });
  });

  it("gives a past-due team 7 days, then makes it read-only with no deletion date; with no date recorded, it stays in grace", () => {
    expect(billingAccess({ status: "past_due", pastDueSince: at(-6) }, NOW)).toEqual({ readOnly: false, graceEndsAt: at(1) });
    expect(billingAccess({ status: "past_due", pastDueSince: at(-7) }, NOW)).toEqual({ readOnly: true, reason: "payment_overdue", readOnlyFrom: at(0) });
    expect(billingAccess({ status: "past_due" }, NOW)).toEqual({ readOnly: false });
  });

  it("drops a date past what Date can hold rather than throwing (corrupt data)", () => {
    const far = "+275760-09-13T00:00:00.000Z";
    expect(billingAccess({ status: "canceled", subscriptionEndedAt: far }, NOW)).toEqual({ readOnly: true, reason: "subscription_ended", readOnlyFrom: far });
    expect(billingAccess({ status: "past_due", pastDueSince: far }, new Date(far))).toEqual({ readOnly: false });
  });

  it("gives full access, and no deletion date, while a comp is live; once it runs out, no clock starts before it did", () => {
    const comp = { compPlan: "starter", compUntil: at(10) };
    for (const team of [{ status: "trialing", trialEndsAt: at(-90) }, { status: "canceled", subscriptionEndedAt: at(-90) }, { status: "past_due", pastDueSince: at(-90) }]) {
      expect(billingAccess({ ...team, ...comp }, NOW)).toEqual({ readOnly: false });
    }
    const ran = { compPlan: "starter", compUntil: at(-2) };
    expect(billingAccess({ status: "trialing", trialEndsAt: at(-90), ...ran }, NOW)).toEqual({ readOnly: true, reason: "trial_ended", readOnlyFrom: at(-2), deleteAfter: at(29) });
    expect(billingAccess({ status: "canceled", subscriptionEndedAt: at(-90), ...ran }, NOW)).toEqual({ readOnly: true, reason: "subscription_ended", readOnlyFrom: at(-2), deleteAfter: at(29) });
    // A fresh grace from the comp's end
    expect(billingAccess({ status: "past_due", pastDueSince: at(-90), ...ran }, NOW)).toEqual({ readOnly: false, graceEndsAt: at(5) });
    // A comp that ran out before the clock started changes nothing
    expect(billingAccess({ status: "trialing", trialEndsAt: at(-1), compPlan: "starter", compUntil: at(-9) }, NOW)).toMatchObject({ readOnlyFrom: at(-1) });
    // A comp end that isn't a date is ignored
    expect(billingAccess({ status: "trialing", trialEndsAt: at(-1), compPlan: "starter", compUntil: "never" }, NOW)).toMatchObject({ readOnlyFrom: at(-1) });
  });
});

describe("the proven email (supply-checkout-ytr2)", () => {
  it("hashes the address trimmed and ASCII-lowercased only", () => {
    expect(data.verifiedEmailHash(" Pat@Example.COM ")).toBe(data.verifiedEmailHash("pat@example.com"));
    expect(data.verifiedEmailHash("pat@example.com")).toMatch(/^[0-9a-f]{64}$/);
    expect(data.verifiedEmailHash("Kat@example.com")).not.toBe(data.verifiedEmailHash("kat@example.com"));
  });

  it("reads only the hash and its time, strongly consistent, with the timeout as an abort signal, and honours a proof for an hour", async () => {
    const at = Date.parse("2026-09-26T12:00:00.000Z");
    const hash = data.verifiedEmailHash("pat@example.com");
    const sent: { input: Record<string, unknown>; options: unknown }[] = [];
    let item: Record<string, unknown> | undefined = { verifiedEmailHash: "not-a-hash", verifiedAt: new Date(at).toISOString() };
    const db = fakeDb(async (command, ...rest: unknown[]) => {
      sent.push({ input: command.input, options: rest[0] });
      return { Item: item };
    });
    const read = (now: number, timeoutMs?: number) => data.provenEmailHash(db, "u1", { now: () => now, ...(timeoutMs ? { timeoutMs } : {}) });
    expect(await read(at, 1_200)).toBeUndefined();
    expect(sent[0]?.input).toEqual({
      TableName: "fake",
      Key: { PK: "USER#u1", SK: "VERIFIED_EMAIL" },
      ProjectionExpression: "#hash, #at",
      ExpressionAttributeNames: { "#hash": "verifiedEmailHash", "#at": "verifiedAt" },
      ConsistentRead: true,
    });
    expect((sent[0]?.options as { abortSignal?: unknown }).abortSignal).toBeInstanceOf(AbortSignal);
    item = { verifiedEmailHash: 7, verifiedAt: new Date(at).toISOString() };
    expect(await read(at)).toBeUndefined();
    expect(sent[1]?.options).toBeUndefined();
    item = { verifiedEmailHash: hash, verifiedAt: new Date(at).toISOString() };
    expect(await read(at)).toBe(hash);
    expect(await read(at + data.VERIFIED_EMAIL_TTL_MS)).toBe(hash);
    expect(await read(at + data.VERIFIED_EMAIL_TTL_MS + 1)).toBeUndefined();
    // A little clock skew between the functions, but not a time from the future
    expect(await read(at - 60_000)).toBe(hash);
    expect(await read(at - 60_001)).toBeUndefined();
    item = { verifiedEmailHash: hash };
    expect(await read(at)).toBeUndefined();
    item = undefined;
    expect(await data.provenEmailHash(db, "u1")).toBeUndefined();
  });

  it("honours a sent code's address for a day, and passes on errors other than a canceled transaction", async () => {
    const at = Date.parse("2026-09-26T12:00:00.000Z");
    const hash = data.verifiedEmailHash("pat@example.com");
    let item: Record<string, unknown> | undefined = { sentEmailHash: hash, sentAt: new Date(at).toISOString() };
    const reader = fakeDb(async () => ({ Item: item }));
    expect(await data.codeSentHash(reader, "u1", new Date(at + data.CODE_SENT_TTL_MS))).toBe(hash);
    expect(await data.codeSentHash(reader, "u1", new Date(at + data.CODE_SENT_TTL_MS + 1))).toBeUndefined();
    expect(await data.codeSentHash(reader, "u1", new Date(at - 60_001))).toBeUndefined();
    item = { sentEmailHash: "x", sentAt: new Date(at).toISOString() };
    expect(await data.codeSentHash(reader, "u1", new Date(at))).toBeUndefined();
    item = undefined;
    expect(await data.codeSentHash(reader, "u1")).toBeUndefined();
    const failing = fakeDb(async () => Promise.reject(Object.assign(new Error("throttled"), { name: "ProvisionedThroughputExceededException" })));
    await expect(data.recordVerifiedEmail(failing, "u1", "pat@example.com")).rejects.toThrow("throttled");
    const canceled = fakeDb(async () => Promise.reject(Object.assign(new Error("canceled"), { name: "TransactionCanceledException" })));
    expect(await data.recordVerifiedEmail(canceled, "u1", "pat@example.com")).toBe(false);
    await expect(data.recordCodeSent(canceled, "u1", " ")).rejects.toThrow("No address to record");
  });
});
