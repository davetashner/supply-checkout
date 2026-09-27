// Who gets a team's live-update notices (ADR 0016): liveUpdateRecipients reads
// the team's members and billing status, naming only the attributes the
// consumer's IAM policy allows, and the consumer's Audience caches the answer
// for AUDIENCE_TTL_MS. The end-to-end cut-off is in live-update-cutoff.test.ts.

import { beforeEach, describe, expect, it } from "vitest";
import { type Db, ENDED_STATUSES, hasEnded, InvalidInputError, liveUpdateRecipients } from "../src/data/index.js";
import { LIVE_AUDIENCE_ATTRIBUTES } from "../src/data/schema.js";
import { createAudience } from "../src/realtime/audience.js";
import { AUDIENCE_TTL_MS } from "../src/realtime/channels.js";
import { fakeDb } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const TEAM = "7d3b8a52-5a61-4c3e-9d1f-0b6f2f7c1a11";
const OTHER = "0f0e8a52-5a61-4c3e-9d1f-0b6f2f7c1a22";

describe("liveUpdateRecipients", () => {
  let table: MemoryTable;
  beforeEach(() => {
    table = new MemoryTable();
    table.seedTeam(TEAM, { "user-owner": "owner", "user-crew": "contributor", "user-view": "viewer" });
    table.seedTeam(OTHER, { "user-other": "owner" });
  });

  it("is every current member of the team, whatever their role, and nobody from another team", async () => {
    expect((await liveUpdateRecipients(table.db(), TEAM)).sort()).toEqual(["user-crew", "user-owner", "user-view"]);
    expect(await liveUpdateRecipients(table.db(), OTHER)).toEqual(["user-other"]);
    // It reads only the team's own partition
    expect(new Set(table.calls.flatMap((c) => c.partitions))).toEqual(new Set([`TEAM#${TEAM}`, `TEAM#${OTHER}`]));
  });

  it("leaves out a removed member at once (strongly consistent reads)", async () => {
    table.items.delete(`TEAM#${TEAM}\u0000MEMBER#user-crew`);
    expect(await liveUpdateRecipients(table.db(), TEAM)).not.toContain("user-crew");
  });

  it("leaves out MEMBER items with an unknown role or an invalid user ID", async () => {
    table.put({ PK: `TEAM#${TEAM}`, SK: "MEMBER#user-odd", userId: "user-odd", role: "admin" });
    table.put({ PK: `TEAM#${TEAM}`, SK: "MEMBER#x", userId: "a#b", role: "viewer" });
    table.put({ PK: `TEAM#${TEAM}`, SK: "MEMBER#y", role: "viewer" });
    expect((await liveUpdateRecipients(table.db(), TEAM)).sort()).toEqual(["user-crew", "user-owner", "user-view"]);
  });

  it.each(ENDED_STATUSES)("is nobody once the team's subscription is %s", async (status) => {
    table.put({ ...table.get(`TEAM#${TEAM}`, "META"), status });
    expect(await liveUpdateRecipients(table.db(), TEAM)).toEqual([]);
  });

  it.each(ENDED_STATUSES)("still reaches members of a %s team while it has a live comp (ADR 0015), and not after", async (status) => {
    table.put({ ...table.get(`TEAM#${TEAM}`, "META"), status, compPlan: "free", compUntil: "2026-12-31T00:00:00.000Z" });
    expect(await liveUpdateRecipients(table.db(), TEAM, new Date("2026-10-01T00:00:00Z"))).toHaveLength(3);
    expect(await liveUpdateRecipients(table.db(), TEAM, new Date("2027-01-01T00:00:00Z"))).toEqual([]);
  });

  it.each(["trialing", "active", "past_due", undefined])("still reaches members while the status is %s", async (status) => {
    table.put({ ...table.get(`TEAM#${TEAM}`, "META"), status });
    expect(await liveUpdateRecipients(table.db(), TEAM)).toHaveLength(3);
  });

  it("is nobody for a team that doesn't exist, and refuses a bad team ID", async () => {
    expect(await liveUpdateRecipients(table.db(), "00000000-0000-4000-8000-000000000000")).toEqual([]);
    await expect(liveUpdateRecipients(table.db(), "TEAM#x")).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("names only the attributes the consumer's IAM policy allows, and follows pages", async () => {
    const inputs: Record<string, unknown>[] = [];
    let page = 0;
    const db = fakeDb(async ({ input }) => {
      inputs.push(input);
      if (!input.KeyConditionExpression) return { Item: { status: "active" } };
      page++;
      return page === 1
        ? { Items: [{ userId: "user-1", role: "owner" }], LastEvaluatedKey: { PK: `TEAM#${TEAM}`, SK: "MEMBER#user-1" } }
        : { Items: [{ userId: "user-2", role: "viewer" }] };
    });
    expect(await liveUpdateRecipients(db, TEAM)).toEqual(["user-1", "user-2"]);
    expect(inputs).toHaveLength(3);
    for (const input of inputs) {
      const names = Object.values(input.ExpressionAttributeNames as Record<string, string>);
      const keyAttributes = ["PK", "SK"];
      expect([...names, ...keyAttributes].every((n) => (LIVE_AUDIENCE_ATTRIBUTES as readonly string[]).includes(n))).toBe(true);
      expect(input.ProjectionExpression).toEqual(expect.any(String));
      expect(input.ConsistentRead).toBe(true);
    }
    expect(inputs[1]?.Select).toBe("SPECIFIC_ATTRIBUTES");
    expect(inputs[2]?.ExclusiveStartKey).toEqual({ PK: `TEAM#${TEAM}`, SK: "MEMBER#user-1" });
  });

  it("knows which statuses have ended", () => {
    expect(hasEnded("canceled")).toBe(true);
    expect(hasEnded("active")).toBe(false);
    expect(hasEnded(undefined)).toBe(false);
  });
});

describe("the consumer's audience cache", () => {
  let clock: number;
  let reads: string[];
  let answers: Record<string, string[] | Error>;
  const db = {} as Db;
  const read = async (_: Db, teamId: string) => {
    reads.push(teamId);
    const a = answers[teamId] ?? [];
    if (a instanceof Error) throw a;
    return [...a];
  };
  const audience = (maxTeams?: number) => createAudience({ db, read, now: () => clock, maxTeams });

  beforeEach(() => {
    clock = 1_000_000;
    reads = [];
    answers = { [TEAM]: ["u1", "u2"], [OTHER]: ["u3"] };
  });

  it("reads a team once per AUDIENCE_TTL_MS (about 30 s), then again", async () => {
    const a = audience();
    expect(await a.recipients(TEAM)).toEqual(["u1", "u2"]);
    answers[TEAM] = ["u1"];
    clock += AUDIENCE_TTL_MS - 1;
    expect(await a.recipients(TEAM)).toEqual(["u1", "u2"]);
    clock += 1;
    expect(await a.recipients(TEAM)).toEqual(["u1"]);
    expect(reads).toEqual([TEAM, TEAM]);
    expect(AUDIENCE_TTL_MS).toBeLessThanOrEqual(60_000);
  });

  it("shares one read between callers at the same moment", async () => {
    const a = audience();
    await Promise.all([a.recipients(TEAM), a.recipients(TEAM)]);
    expect(reads).toEqual([TEAM]);
  });

  it("reads again right after forget", async () => {
    const a = audience();
    await a.recipients(TEAM);
    a.forget(TEAM);
    a.forget("never-read");
    await a.recipients(TEAM);
    expect(reads).toEqual([TEAM, TEAM]);
  });

  it("doesn't keep a failed read", async () => {
    const a = audience();
    answers[TEAM] = new Error("down");
    await expect(a.recipients(TEAM)).rejects.toThrow("down");
    answers[TEAM] = ["u1"];
    expect(await a.recipients(TEAM)).toEqual(["u1"]);
  });

  it("keeps a newer read when an older one for the same team fails", async () => {
    let fail: (e: Error) => void = () => {};
    const slow = createAudience({
      db,
      now: () => clock,
      read: async (_, teamId) => {
        reads.push(teamId);
        if (reads.length === 1) return new Promise<string[]>((_, reject) => (fail = reject));
        return ["fresh"];
      },
    });
    const first = slow.recipients(TEAM);
    slow.forget(TEAM);
    expect(await slow.recipients(TEAM)).toEqual(["fresh"]);
    fail(new Error("late failure"));
    await expect(first).rejects.toThrow("late failure");
    expect(await slow.recipients(TEAM)).toEqual(["fresh"]);
    expect(reads).toHaveLength(2);
  });

  it("keeps at most maxTeams teams, dropping the oldest", async () => {
    const a = audience(1);
    await a.recipients(TEAM);
    await a.recipients(OTHER);
    await a.recipients(OTHER);
    await a.recipients(TEAM);
    expect(reads).toEqual([TEAM, OTHER, TEAM]);
  });

  it("defaults to the data module's read, the real clock and the TTL", async () => {
    const table = new MemoryTable();
    table.seedTeam(TEAM, { u9: "viewer" });
    expect(await createAudience({ db: table.db() }).recipients(TEAM)).toEqual(["u9"]);
  });
});
