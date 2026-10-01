// The one-off migrations (src/data/backfill.ts) and their CLI
// (scripts/backfill.ts). The migrations scan the whole table, so each suite
// gets its own table in DynamoDB Local; skipped unless DYNAMODB_ENDPOINT is
// set (CI sets it; locally, npm run test:ddb -- test/backfill.test.ts).

import { DeleteCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { createDb, createTeam, type Db, emailSeenHash, getOpsTeam, listOpsTeams, noticeAddress, recordNoticeAddress, startAccountDeletion } from "../src/data/index.js";
import { connection, dbFromConnection } from "../src/data/client.js";
import { backfillMemberCounts, backfillOpsIndex, expectedOpsKeys, type NoticeAddressCandidate, runBackfill, stripStrayOpsKeys } from "../src/data/backfill.js";
import type { PoolUser } from "../src/identity/cognito-admin.js";
import { formatReport, main, USAGE } from "../scripts/backfill.js";
import { endpoint, newUser, rawItem, REGION, useTable } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";

const op = { sub: "op-sub-backfill" };
const now = new Date();

const put = (db: Db, Item: Record<string, unknown>) => connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item }));
const newTeamId = () => `team-${newUser().slice(5)}`;

/** A team as it was stored before PR #93 and PR #99: no `members`, no GSI3 keys. */
async function legacyTeam(db: Db, members: { userId: string; role: string }[], extra: Record<string, unknown> = {}) {
  const teamId = newTeamId();
  const createdAt = now.toISOString();
  await put(db, { PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: `Legacy ${teamId}`, plan: "trial", seats: 1, status: "trialing", homeRegion: REGION, owners: members.filter((m) => m.role === "owner").length, createdAt, version: 1, ...extra });
  for (const m of members) {
    await put(db, { PK: `TEAM#${teamId}`, SK: `MEMBER#${m.userId}`, type: "member", teamId, userId: m.userId, role: m.role, email: `${m.userId}@example.com`, joinedAt: createdAt });
  }
  return teamId;
}

/**
 * A Db on the same table that runs `first` just before its first update is
 * sent, so a test can change the item between the scan and the write and
 * DynamoDB Local judges the condition.
 */
function interleaved(db: Db, first: () => Promise<unknown>): Db {
  const real = connection(db);
  let pending = true;
  const doc = {
    send: async (command: unknown) => {
      if (pending && command instanceof UpdateCommand) {
        pending = false;
        await first();
      }
      return real.doc.send(command as never);
    },
  } as unknown as typeof real.doc;
  return dbFromConnection({ ...real, doc });
}

describe("expectedOpsKeys", () => {
  it("names the keys of a team, an owner and an operator audit event, and nothing else", () => {
    expect(expectedOpsKeys({ PK: "TEAM#t1", SK: "META" })).toEqual({ GSI3PK: "OPS#TEAMS", GSI3SK: "t1" });
    expect(expectedOpsKeys({ PK: "TEAM#t1", SK: "MEMBER#u1", role: "owner" })).toEqual({ GSI3PK: "OPS#OWNERS#t1", GSI3SK: "u1" });
    expect(expectedOpsKeys({ PK: "OPAUDIT#t1", SK: "AUDIT#2026-09-27T10:00:00.000Z#e1" })).toEqual({ GSI3PK: "OPS#AUDIT#2026-09", GSI3SK: "2026-09-27T10:00:00.000Z#e1" });
    expect(expectedOpsKeys({ PK: "TEAM#t1", SK: "MEMBER#u1", role: "contributor" })).toBeUndefined();
    expect(expectedOpsKeys({ PK: "TEAM#t1", SK: "SHEET#s1" })).toBeUndefined();
    expect(expectedOpsKeys({ PK: "OPAUDIT#t1", SK: "REQUEST#abc" })).toBeUndefined();
    expect(expectedOpsKeys({ PK: "TEAM#bad id", SK: "META" })).toBeUndefined();
    expect(expectedOpsKeys({ PK: "USER#u1", SK: "TEAM#t1" })).toBeUndefined();
  });
});

describe("the backfill CLI's arguments", () => {
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, (l) => out.push(l), (l) => err.push(l));
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("prints the usage for --help", async () => {
    expect(await run(["--help"])).toEqual({ code: 0, out: USAGE, err: "" });
  });

  it.each([
    [[], /No mode given/],
    [["everything", "--table", "t", "--region", "r"], /Unknown mode: everything/],
    [["members", "extra", "--table", "t", "--region", "r"], /Unknown mode: members extra/],
    [["members", "--region", "r"], /--table and --region are required/],
    [["members", "--table", "t"], /--table and --region are required/],
    [["members", "--table", "t", "--region", "r", "--force"], /Unknown option '--force'/],
    [["members", "--table", "supply-checkout-prod-app", "--region", "r"], /--profile is required/],
    [["members", "--table", "supply-checkout-prod-app", "--region", "r", "--apply"], /--profile is required/],
    [["members", "--table", "supply-checkout-prod-ap", "--region", "r", "--profile", "p"], /--table must be an app table/],
    [["members", "--table", "other-table", "--region", "r", "--profile", "p", "--apply"], /--table must be an app table/],
    [["members", "--table", "supply-checkout-Prod-app", "--region", "r", "--profile", "p"], /--table must be an app table/],
    [["notice-address", "--table", "supply-checkout-prod-app", "--region", "test-local-1", "--profile", "p"], /--user-pool must be the app user pool's ID/],
    [["notice-address", "--table", "supply-checkout-prod-app", "--region", "test-local-1", "--profile", "p", "--user-pool", "test-local-1"], /--user-pool must be the app user pool's ID/],
    [["notice-address", "--table", "supply-checkout-prod-app", "--region", "test-local-1", "--profile", "p", "--user-pool", "test-local-1_ab/c"], /--user-pool must be the app user pool's ID/],
    [["notice-address", "--table", "supply-checkout-prod-app", "--region", "test-local-1", "--profile", "p", "--user-pool", "test-other-2_AbC123"], /--user-pool is in test-other-2, not --region test-local-1/],
    [["members", "--table", "supply-checkout-prod-app", "--region", "test-local-1", "--profile", "p", "--user-pool", "test-local-1_AbC123"], /--user-pool is for notice-address only/],
  ])("refuses %j", async (args, message) => {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(result.err).toContain(USAGE);
  });

  it("stops before reading when the profile's account can't be identified", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const connect = () => {
      throw new Error("must not connect");
    };
    const callerAccount = () => Promise.reject(Object.assign(new Error("The SSO session has expired"), { name: "CredentialsProviderError" }));
    const code = await main(["members", "--table", "supply-checkout-prod-app", "--region", "r", "--profile", "p", "--apply"], (l) => out.push(l), (l) => err.push(l), { callerAccount, connect });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(["Failed to identify the profile's account: CredentialsProviderError: The SSO session has expired"]);
  });

  it("reports a failure without item contents", async () => {
    // Nothing listens on port 9: the SDK fails to connect
    const result = await run(["members", "--table", "t", "--region", "r", "--endpoint", "http://127.0.0.1:9"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^Failed: /);
  });

  it("formats a report with the races, invalid keys and strays it has", () => {
    expect(formatReport({ mode: "members", apply: true, found: 3, changed: 1, raced: 1, invalid: 1 })).toEqual([
      "Teams without a members count: 3",
      "  count set: 1",
      "  changed by something else first, left alone: 1",
      "  keys that aren't valid IDs, left alone: 1",
      "Done.",
    ]);
    expect(formatReport({ mode: "stray-ops-keys", apply: false, found: 1, changed: 1, raced: 0, invalid: 0, strays: ["TEAM#t1 SHEET: 1"] })).toEqual([
      "Items with GSI3 keys they shouldn't have: 1",
      "  keys removed: 1 (dry run: would be)",
      "  TEAM#t1 SHEET: 1",
      "Dry run: nothing was written. Run again with --apply to write.",
    ]);
    expect(formatReport({ mode: "notice-address", apply: true, found: 2, changed: 1, raced: 1, invalid: 0, accounts: { listed: 6, untrusted: 2, present: 1, deleting: 1 } })).toEqual([
      "App pool users: 6",
      "  no verified address the API trusts, left alone: 2",
      "  address already recorded, left alone: 1",
      "  being deleted, left alone: 1",
      "Accounts with a trusted verified address and no notice address: 2",
      "  address recorded: 1",
      "  changed by something else first, left alone: 1",
      "Done.",
    ]);
  });

  it("needs the pool's users for notice-address", async () => {
    await expect(runBackfill(new MemoryTable().db(), "notice-address", { apply: false })).rejects.toThrow(/needs the app pool's users/);
  });
});

// supply-checkout-8jc.31: every app pool user whose verified address the API trusts gets a NOTICE_ADDRESS
describe("the notice-address backfill", () => {
  const POOL = `${REGION}_AppPool1`;
  const sub = (n: number) => `4f1c2b7e-9a3d-4e5f-8b6a-${String(n).padStart(12, "0")}`;
  const user = (n: number, attributes: Record<string, string> = {}): PoolUser => ({
    username: sub(n),
    status: "CONFIRMED",
    enabled: true,
    attributes: { sub: sub(n), email: `Person${n}@Example.com`, email_verified: "true", ...attributes },
  });
  async function* listed(users: PoolUser[]) {
    yield* users;
  }
  async function* candidates(list: NoticeAddressCandidate[]) {
    yield* list;
  }

  /** Runs the CLI against `db` with the given pool users; returns the exit code and output. */
  async function run(db: Db, users: PoolUser[], apply: boolean) {
    const out: string[] = [];
    const seen: { region?: string; pool?: string } = {};
    const deps = {
      callerAccount: async () => "ACCOUNT-PLACEHOLDER",
      connect: () => db,
      listUsers: (region: string, pool: string) => {
        Object.assign(seen, { region, pool });
        return listed(users);
      },
    };
    const args = ["notice-address", "--table", "supply-checkout-test-app", "--region", REGION, "--profile", "supply-test", "--user-pool", POOL, ...(apply ? ["--apply"] : [])];
    const code = await main(args, (l) => out.push(l), (l) => out.push(l), deps);
    return { code, out, seen };
  }

  /** Each case the backfill tells apart, on `db`. */
  async function seed(db: Db): Promise<PoolUser[]> {
    await recordNoticeAddress(db, sub(3), "kept@example.com", emailSeenHash("kept@example.com"));
    await startAccountDeletion(db, sub(4));
    return [
      user(1),
      user(2, { email: "Second@Example.com" }),
      user(3),
      user(4),
      user(5, { email_verified: "false" }),
      user(6, { "custom:downgrade_pending": "1" }),
      { username: "no-sub", status: "UNCONFIRMED", enabled: true, attributes: {} },
    ];
  }

  async function check(db: Db) {
    const users = await seed(db);
    const dry = await run(db, users, false);
    expect(dry.code).toBe(0);
    expect(dry.seen).toEqual({ region: REGION, pool: POOL });
    expect(dry.out).toEqual([
      `notice-address on supply-checkout-test-app and pool ${POOL} in ${REGION} in account ACCOUNT-PLACEHOLDER (profile supply-test) (dry run)`,
      "App pool users: 7",
      "  no verified address the API trusts, left alone: 3",
      "  address already recorded, left alone: 1",
      "  being deleted, left alone: 1",
      "Accounts with a trusted verified address and no notice address: 2",
      "  address recorded: 2 (dry run: would be)",
      "Dry run: nothing was written. Run again with --apply to write.",
    ]);
    expect(await noticeAddress(db, sub(1))).toBeUndefined();

    const applied = await run(db, users, true);
    expect(applied.code).toBe(0);
    expect(applied.out.slice(-3)).toEqual(["Accounts with a trusted verified address and no notice address: 2", "  address recorded: 2", "Done."]);
    // Counts only: no address, sub or name
    expect(applied.out.join("\n")).not.toMatch(/@|4f1c2b7e/);
    expect(await noticeAddress(db, sub(1))).toEqual({ address: "person1@example.com", seen: emailSeenHash("Person1@Example.com") });
    expect((await noticeAddress(db, sub(2)))?.address).toBe("second@example.com");
    expect((await noticeAddress(db, sub(3)))?.address).toBe("kept@example.com");
    for (const n of [4, 5, 6]) expect(await noticeAddress(db, sub(n)), String(n)).toBeUndefined();

    // Idempotent: a second run finds nothing to do
    const again = await run(db, users, true);
    expect(again.out).toContain("  address already recorded, left alone: 3");
    expect(again.out).toContain("Accounts with a trusted verified address and no notice address: 0");
  }

  it("records each trusted address once, never over one recorded or for an account being deleted (in memory)", async () => {
    await check(new MemoryTable().db());
  });

  describe.skipIf(!endpoint)("on DynamoDB Local", () => {
    const ddb = useTable();

    it("does the same", async () => {
      await check(ddb.db);
    });
  });

  it("leaves an account alone when its address is recorded, or its deletion starts, between the check and the write", async () => {
    for (const race of ["recorded", "deleting"] as const) {
      const table = new MemoryTable();
      table.beforeTransactWrite = () => {
        table.beforeTransactWrite = undefined;
        if (race === "recorded") table.put({ PK: `USER#${sub(1)}`, SK: "NOTICE_ADDRESS", noticeAddress: "first@example.com", noticeAddressAt: "then", noticeSeenHash: "h" });
        else table.put({ PK: `USER#${sub(1)}`, SK: "DELETING" });
      };
      const report = await runBackfill(table.db(), "notice-address", { apply: true }, { accounts: candidates([{ userId: sub(1), address: "person1@example.com", seen: "h" }]) });
      expect(report, race).toMatchObject({ found: 1, changed: 0, raced: 1 });
      expect(table.get(`USER#${sub(1)}`, "NOTICE_ADDRESS")?.noticeAddress ?? null, race).toBe(race === "recorded" ? "first@example.com" : null);
    }
  });

  it("counts a candidate whose ID isn't valid as invalid, and writes nothing for it", async () => {
    const table = new MemoryTable();
    const accounts = candidates([
      { userId: "bad id", address: "a@example.com", seen: "h" },
      { userId: sub(1), address: "", seen: "h" },
    ]);
    const report = await runBackfill(table.db(), "notice-address", { apply: true }, { accounts });
    expect(report).toMatchObject({ found: 0, changed: 0, invalid: 2 });
    expect(table.items.size).toBe(0);
  });
});

describe.skipIf(!endpoint)("the members backfill on DynamoDB Local", () => {
  const table = useTable();

  it("counts MEMBER items onto teams without a count, in a dry run first, and only once", async () => {
    const db = table.db;
    const owner = newUser();
    const { team: current } = await createTeam(db, { userId: owner, email: "owner@example.com" }, { name: `Current ${owner}` }, now);
    const three = await legacyTeam(db, [{ userId: newUser(), role: "owner" }, { userId: newUser(), role: "contributor" }, { userId: newUser(), role: "viewer" }]);
    const closed = await legacyTeam(db, [{ userId: newUser(), role: "owner" }], { closedAt: now.toISOString() });
    const empty = await legacyTeam(db, []);

    expect(await backfillMemberCounts(db, { apply: false })).toEqual({ mode: "members", apply: false, found: 3, changed: 3, raced: 0, invalid: 0 });
    expect((await rawItem(db, `TEAM#${three}`, "META"))?.members).toBeUndefined();

    expect(await backfillMemberCounts(db, { apply: true })).toEqual({ mode: "members", apply: true, found: 3, changed: 3, raced: 0, invalid: 0 });
    expect((await rawItem(db, `TEAM#${three}`, "META"))?.members).toBe(3);
    expect((await rawItem(db, `TEAM#${closed}`, "META"))?.members).toBe(1);
    expect((await rawItem(db, `TEAM#${empty}`, "META"))?.members).toBe(0);
    // A team with a count keeps it, and nothing else on the item moves
    expect(await rawItem(db, `TEAM#${current.teamId}`, "META")).toMatchObject({ members: 1, version: 1 });
    expect(await rawItem(db, `TEAM#${three}`, "META")).toMatchObject({ version: 1, owners: 1 });

    expect(await backfillMemberCounts(db, { apply: true })).toMatchObject({ found: 0, changed: 0 });
  });

  it("leaves a count set after its read alone, and never re-creates a purged team", async () => {
    const db = table.db;
    const joined = await legacyTeam(db, [{ userId: newUser(), role: "owner" }]);
    const racing = interleaved(db, () =>
      connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${joined}`, SK: "META" }, UpdateExpression: "SET #m = :m", ExpressionAttributeNames: { "#m": "members" }, ExpressionAttributeValues: { ":m": 2 } })),
    );
    expect(await backfillMemberCounts(racing, { apply: true })).toMatchObject({ found: 1, changed: 0, raced: 1 });
    expect((await rawItem(db, `TEAM#${joined}`, "META"))?.members).toBe(2);

    const purged = await legacyTeam(db, []);
    const purging = interleaved(db, () => connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: { PK: `TEAM#${purged}`, SK: "META" } })));
    expect(await backfillMemberCounts(purging, { apply: true })).toMatchObject({ found: 1, changed: 0, raced: 1 });
    expect(await rawItem(db, `TEAM#${purged}`, "META")).toBeUndefined();
  });

  it("skips a team whose ID isn't valid", async () => {
    const db = table.db;
    await put(db, { PK: "TEAM#not valid", SK: "META", type: "team" });
    expect(await backfillMemberCounts(db, { apply: true })).toMatchObject({ found: 1, changed: 0, invalid: 1 });
    expect((await rawItem(db, "TEAM#not valid", "META"))?.members).toBeUndefined();
  });
});

describe.skipIf(!endpoint)("the operators' index backfill on DynamoDB Local", () => {
  const table = useTable();

  it("puts every team and its owners in GSI3, so the ops list shows every team", async () => {
    const db = table.db;
    const owner = newUser();
    const { team: current } = await createTeam(db, { userId: owner, email: "owner@example.com" }, { name: `Current ${owner}` }, now);
    const [ownerA, ownerB, contributor] = [newUser(), newUser(), newUser()];
    const legacy = await legacyTeam(db, [{ userId: ownerA, role: "owner" }, { userId: ownerB, role: "owner" }, { userId: contributor, role: "contributor" }]);
    const closedOwner = newUser();
    const closed = await legacyTeam(db, [{ userId: closedOwner, role: "owner" }], { closedAt: now.toISOString() });

    const before = (await listOpsTeams(db, op, { limit: 100 }, now)).teams.map((t) => t.teamId);
    expect(before).toEqual([current.teamId]);

    // Two META items and three owners
    expect(await backfillOpsIndex(db, { apply: false })).toEqual({ mode: "ops-index", apply: false, found: 5, changed: 5, raced: 0, invalid: 0 });
    expect((await rawItem(db, `TEAM#${legacy}`, "META"))?.GSI3PK).toBeUndefined();

    expect(await backfillOpsIndex(db, { apply: true })).toEqual({ mode: "ops-index", apply: true, found: 5, changed: 5, raced: 0, invalid: 0 });
    expect(await rawItem(db, `TEAM#${legacy}`, "META")).toMatchObject({ GSI3PK: "OPS#TEAMS", GSI3SK: legacy, version: 1 });
    expect(await rawItem(db, `TEAM#${legacy}`, `MEMBER#${ownerA}`)).toMatchObject({ GSI3PK: `OPS#OWNERS#${legacy}`, GSI3SK: ownerA });
    expect((await rawItem(db, `TEAM#${legacy}`, `MEMBER#${contributor}`))?.GSI3PK).toBeUndefined();

    const after = (await listOpsTeams(db, op, { limit: 100 }, now)).teams.map((t) => t.teamId);
    expect(after.sort()).toEqual([current.teamId, legacy, closed].sort());
    const { team, owners } = await getOpsTeam(db, op, closed, now);
    expect(team.closedAt).toBe(now.toISOString());
    expect(owners.map((o) => o.userId)).toEqual([closedOwner]);
    expect((await getOpsTeam(db, op, legacy, now)).owners.map((o) => o.userId).sort()).toEqual([ownerA, ownerB].sort());

    expect(await backfillOpsIndex(db, { apply: true })).toMatchObject({ found: 0, changed: 0 });
  });

  it("never overwrites newer keys, indexes an owner demoted since the scan, or re-creates a purged team", async () => {
    const db = table.db;
    const demoted = newUser();
    const team = await legacyTeam(db, [{ userId: demoted, role: "owner" }]);
    await put(db, { ...(await rawItem(db, `TEAM#${team}`, "META")), GSI3PK: "OPS#TEAMS", GSI3SK: team });
    const demoting = interleaved(db, () =>
      connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${team}`, SK: `MEMBER#${demoted}` }, UpdateExpression: "SET #r = :r", ExpressionAttributeNames: { "#r": "role" }, ExpressionAttributeValues: { ":r": "viewer" } })),
    );
    expect(await backfillOpsIndex(demoting, { apply: true })).toMatchObject({ found: 1, changed: 0, raced: 1 });
    expect((await rawItem(db, `TEAM#${team}`, `MEMBER#${demoted}`))?.GSI3PK).toBeUndefined();

    const newer = await legacyTeam(db, []);
    const indexing = interleaved(db, () =>
      connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${newer}`, SK: "META" }, UpdateExpression: "SET GSI3PK = :p, GSI3SK = :s", ExpressionAttributeValues: { ":p": "OPS#TEAMS", ":s": newer } })),
    );
    expect(await backfillOpsIndex(indexing, { apply: true })).toMatchObject({ found: 1, changed: 0, raced: 1 });

    const purged = await legacyTeam(db, []);
    const purging = interleaved(db, () => connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: { PK: `TEAM#${purged}`, SK: "META" } })));
    expect(await backfillOpsIndex(purging, { apply: true })).toMatchObject({ found: 1, changed: 0, raced: 1 });
    expect(await rawItem(db, `TEAM#${purged}`, "META")).toBeUndefined();
  });

  it("skips items whose keys aren't valid IDs", async () => {
    const db = table.db;
    await put(db, { PK: "TEAM#not valid", SK: "META", type: "team" });
    const teamId = newTeamId();
    await put(db, { PK: `TEAM#${teamId}`, SK: "MEMBER#not valid", role: "owner" });
    await put(db, { PK: `TEAM#${teamId}`, SK: "META", type: "team", GSI3PK: "OPS#TEAMS", GSI3SK: teamId });
    expect(await backfillOpsIndex(db, { apply: true })).toMatchObject({ found: 2, changed: 0, invalid: 2 });
  });
});

describe.skipIf(!endpoint)("the stray index key cleanup on DynamoDB Local", () => {
  const table = useTable();

  it("removes GSI3 keys from items that shouldn't have them, and keeps the rest", async () => {
    const db = table.db;
    const owner = newUser();
    const { team } = await createTeam(db, { userId: owner, email: "owner@example.com" }, { name: `Current ${owner}` }, now);
    await getOpsTeam(db, op, team.teamId, now); // an operator audit item, in GSI3
    const t = team.teamId;
    const viewer = newUser();
    await put(db, { PK: `TEAM#${t}`, SK: "SHEET#s1", type: "sheet", GSI3PK: "OPS#TEAMS", GSI3SK: "forged" });
    await put(db, { PK: `TEAM#${t}`, SK: `MEMBER#${viewer}`, type: "member", role: "viewer", email: "viewer@example.com", GSI3PK: `OPS#OWNERS#${t}`, GSI3SK: viewer });
    await put(db, { PK: `USER#${viewer}`, SK: `TEAM#${t}`, GSI3SK: "only-a-sort-key" });
    const wrong = await legacyTeam(db, []);
    await put(db, { ...(await rawItem(db, `TEAM#${wrong}`, "META")), GSI3PK: "OPS#TEAMS", GSI3SK: "someone-else" });

    const dry = await stripStrayOpsKeys(db, { apply: false });
    expect(dry).toMatchObject({ found: 4, changed: 4, raced: 0 });
    expect(dry.strays).toEqual([`TEAM#${t} MEMBER: 1`, `TEAM#${t} SHEET: 1`, `TEAM#${wrong} META: 1`, "USER# TEAM: 1"].sort((a, b) => a.localeCompare(b)));
    // No user IDs or emails in the report
    expect(JSON.stringify(dry)).not.toContain(viewer);
    expect(JSON.stringify(dry)).not.toContain("@");
    expect((await rawItem(db, `TEAM#${t}`, "SHEET#s1"))?.GSI3PK).toBe("OPS#TEAMS");

    expect(await stripStrayOpsKeys(db, { apply: true })).toMatchObject({ found: 4, changed: 4, raced: 0 });
    for (const [pk, sk] of [[`TEAM#${t}`, "SHEET#s1"], [`TEAM#${t}`, `MEMBER#${viewer}`], [`USER#${viewer}`, `TEAM#${t}`], [`TEAM#${wrong}`, "META"]] as const) {
      const item = await rawItem(db, pk, sk);
      expect(item?.GSI3PK).toBeUndefined();
      expect(item?.GSI3SK).toBeUndefined();
    }
    expect((await rawItem(db, `TEAM#${t}`, `MEMBER#${viewer}`))?.email).toBe("viewer@example.com");
    // The current team, its owner and the audit stay in the index
    expect(await rawItem(db, `TEAM#${t}`, "META")).toMatchObject({ GSI3PK: "OPS#TEAMS", GSI3SK: t });
    expect(await rawItem(db, `TEAM#${t}`, `MEMBER#${owner}`)).toMatchObject({ GSI3PK: `OPS#OWNERS#${t}`, GSI3SK: owner });
    expect((await getOpsTeam(db, op, t, now)).team.teamId).toBe(t);

    expect(await stripStrayOpsKeys(db, { apply: true })).toMatchObject({ found: 0, changed: 0, strays: [] });

    // Then ops-index puts the team whose keys were wrong back, correctly
    expect(await backfillOpsIndex(db, { apply: true })).toMatchObject({ found: 1, changed: 1 });
    expect(await rawItem(db, `TEAM#${wrong}`, "META")).toMatchObject({ GSI3PK: "OPS#TEAMS", GSI3SK: wrong });
  });

  it("leaves keys changed since the scan alone, and a member promoted since", async () => {
    const db = table.db;
    const teamId = newTeamId();
    await put(db, { PK: `TEAM#${teamId}`, SK: "SHEET#s2", GSI3PK: "OPS#TEAMS", GSI3SK: "forged" });
    const changing = interleaved(db, () =>
      connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "SHEET#s2" }, UpdateExpression: "SET GSI3SK = :s", ExpressionAttributeValues: { ":s": "other" } })),
    );
    expect(await stripStrayOpsKeys(changing, { apply: true })).toMatchObject({ found: 1, changed: 0, raced: 1 });
    expect((await rawItem(db, `TEAM#${teamId}`, "SHEET#s2"))?.GSI3SK).toBe("other");
    await connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "SHEET#s2" } }));

    const promoted = newUser();
    await put(db, { PK: `TEAM#${teamId}`, SK: `MEMBER#${promoted}`, role: "contributor", GSI3PK: `OPS#OWNERS#${teamId}`, GSI3SK: promoted });
    const promoting = interleaved(db, () =>
      connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: `MEMBER#${promoted}` }, UpdateExpression: "SET #r = :r", ExpressionAttributeNames: { "#r": "role" }, ExpressionAttributeValues: { ":r": "owner" } })),
    );
    expect(await stripStrayOpsKeys(promoting, { apply: true })).toMatchObject({ found: 1, changed: 0, raced: 1 });
    expect((await rawItem(db, `TEAM#${teamId}`, `MEMBER#${promoted}`))?.GSI3PK).toBe(`OPS#OWNERS#${teamId}`);
  });
});

describe.skipIf(!endpoint)("the backfill CLI on DynamoDB Local", () => {
  const table = useTable();

  it("runs each mode as a dry run, then with --apply, printing counts only", async () => {
    const db = table.db;
    const ownerId = newUser();
    const teamId = await legacyTeam(db, [{ userId: ownerId, role: "owner" }]);
    const base = ["--table", db.tableName, "--region", REGION, "--endpoint", String(endpoint)];
    const run = async (args: string[]) => {
      const out: string[] = [];
      const code = await main(args, (l) => out.push(l), (l) => out.push(l));
      return { code, out };
    };

    expect(await run(["members", ...base])).toEqual({
      code: 0,
      out: [`members on ${db.tableName} in ${REGION} at ${endpoint} (dry run)`, "Teams without a members count: 1", "  count set: 1 (dry run: would be)", "Dry run: nothing was written. Run again with --apply to write."],
    });
    expect((await rawItem(db, `TEAM#${teamId}`, "META"))?.members).toBeUndefined();

    for (const mode of ["stray-ops-keys", "ops-index", "members"]) {
      const { code, out } = await run([mode, ...base, "--apply", "--profile", "ignored-with-an-endpoint"]);
      expect(code).toBe(0);
      expect(out.at(-1)).toBe("Done.");
      expect(out.join("\n")).not.toContain(ownerId);
      expect(out.join("\n")).not.toContain("@");
    }
    expect(await rawItem(db, `TEAM#${teamId}`, "META")).toMatchObject({ members: 1, GSI3PK: "OPS#TEAMS", GSI3SK: teamId });
    expect((await runBackfill(db, "ops-index", { apply: false })).found).toBe(0);
  });

  it("with a profile, names the account it signs in to before it writes", async () => {
    const out: string[] = [];
    const seen: { region?: string; credentials?: unknown } = {};
    const deps = {
      callerAccount: async (region: string, credentials: unknown) => {
        Object.assign(seen, { region, credentials });
        return "ACCOUNT-PLACEHOLDER";
      },
      // The app table's name, but DynamoDB Local's handle on this suite's table
      connect: () => createDb({ tableName: table.db.tableName, region: REGION, endpoint, env: {} }),
    };
    const code = await main(["members", "--table", "supply-checkout-test-app", "--region", REGION, "--profile", "supply-test", "--apply"], (l) => out.push(l), (l) => out.push(l), deps);
    expect(code).toBe(0);
    expect(out[0]).toBe(`members on supply-checkout-test-app in ${REGION} in account ACCOUNT-PLACEHOLDER (profile supply-test)`);
    expect(out.at(-1)).toBe("Done.");
    expect(seen.region).toBe(REGION);
    expect(typeof seen.credentials).toBe("function");
  });
});
