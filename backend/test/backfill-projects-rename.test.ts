// The projects-rename backfill (src/data/projects-rename.ts) and its CLI mode
// (scripts/backfill.ts). The DynamoDB suites are skipped unless
// DYNAMODB_ENDPOINT is set (CI sets it; locally,
// npm run test:ddb -- test/backfill-projects-rename.test.ts).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, describe, expect, it } from "vitest";
import { type Db } from "../src/data/index.js";
import { connection, dbFromConnection, storable } from "../src/data/client.js";
import { dateFormat } from "../src/data/keys.js";
import { itemBytes, projectTotals, renamedItem, renameHash, renameProjects, PROJECTS, SHEETS, type ProjectsRenameOptions } from "../src/data/projects-rename.js";
import { exportPath, formatRenameReport, main } from "../scripts/backfill.js";
import { endpoint, rawItem, REGION, useTable } from "./helpers.js";

const fast: Partial<ProjectsRenameOptions> = { writesPerSecond: Infinity, indexWaitMs: 5_000 };
const newTeamId = () => `team-${randomUUID()}`;
const put = (db: Db, Item: Record<string, unknown>) => connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: storable(Item) }));

/**
 * A sheet as stored before the rename (pre-migration data): SHEET#, GSI1PK
 * TEAM#<t>#SHEETS, type "sheet". (documents.ts writes new projects as PROJECT#
 * now, so the seed builds the old layout itself.)
 */
function sheetItem(teamId: string, id: string, data: Record<string, unknown>, version: number): Record<string, unknown> {
  const day = dateFormat(data.date);
  return { ...data, PK: `TEAM#${teamId}`, SK: `SHEET#${id}`, GSI1PK: `TEAM#${teamId}#SHEETS`, GSI1SK: `${day}#${id}`, type: "sheet", id, version };
}

/** A sheet's data, as the app writes it. */
function sheetData(n: number) {
  return {
    client: `Client ${n} Ltd`,
    date: `2026-09-${String((n % 28) + 1).padStart(2, "0")}`,
    status: n % 2 ? "open" : "closed",
    createdByName: `Person ${n}`,
    items: {
      gloves: { name: "Gloves", code: "123", price: 2.5, out: 4 + n, returned: 1 },
      constructor: { name: "A key named constructor", price: 1.1, out: 3, returned: 0 },
      drill: { name: "Drill", kind: "equipment", out: 2, returned: 0, lost: 1, lostCharge: 40 },
    },
    savedReceipts: [{ store: "Hardware", receiptDate: "2026-09-01" }],
  };
}

async function seedTeam(db: Db, sheets: number, extra: { movements?: number; teamId?: string } = {}) {
  const teamId = extra.teamId ?? newTeamId();
  await put(db, { PK: `TEAM#${teamId}`, SK: "META", type: "team", teamId, name: `Team ${teamId}`, version: 1 });
  for (let n = 1; n <= sheets; n++) await put(db, sheetItem(teamId, `s${n}`, sheetData(n), n));
  await put(db, { PK: `TEAM#${teamId}`, SK: "PRODUCT#gloves", type: "product", key: "gloves", name: "Gloves", stock: 12, version: 3 });
  for (let n = 1; n <= (extra.movements ?? 0); n++) {
    await put(db, { PK: `TEAM#${teamId}`, SK: `MOVE#gloves#2026-09-0${n}T10:00:00.000Z#op${n}`, type: "movement", productKey: "gloves", reason: n === 1 ? "move" : "checkout", delta: -1, tracked: true, sheetId: `s${n}`, ...(n === 1 ? { fromSheetId: "adhoc-1" } : {}), operationId: `op${n}`, userId: "user-a", at: `2026-09-0${n}T10:00:00.000Z` });
  }
  return teamId;
}

async function partition(db: Db, teamId: string, prefix: string) {
  const { Items } = await connection(db).doc.send(
    new QueryCommand({ TableName: db.tableName, KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)", ExpressionAttributeValues: { ":pk": `TEAM#${teamId}`, ":p": prefix }, ConsistentRead: true }),
  );
  return Items ?? [];
}

/** A Db that runs `before` ahead of the first `times` transactions, so a test can change an item between the read and the write. */
function interleaved(db: Db, before: () => Promise<unknown>, times = 1, kind: new (...args: never[]) => unknown = TransactWriteCommand): Db {
  const real = connection(db);
  let left = times;
  const doc = {
    send: async (command: unknown) => {
      if (left > 0 && command instanceof kind) {
        left--;
        await before();
      }
      return real.doc.send(command as never);
    },
  } as unknown as typeof real.doc;
  return dbFromConnection({ ...real, doc });
}

describe("the rename's pieces", () => {
  it("hashes attributes in any order, leaving out only the renamed ones", () => {
    const item = sheetItem("t1", "s1", sheetData(1), 4);
    const moved = renamedItem(item, "t1", "s1", PROJECTS);
    expect(moved).toMatchObject({ PK: "TEAM#t1", SK: "PROJECT#s1", GSI1PK: "TEAM#t1#PROJECTS", GSI1SK: "2026-09-02#s1", type: "project", version: 4, id: "s1" });
    expect(renameHash(moved)).toBe(renameHash(item));
    const reordered = Object.fromEntries(Object.entries(item).reverse());
    expect(renameHash(reordered)).toBe(renameHash(item));
    expect(renameHash({ ...item, client: "Other" })).not.toBe(renameHash(item));
    expect(renameHash({ ...item, version: 5 })).not.toBe(renameHash(item));
    expect(renameHash({ a: new Set(["y", "x"]), b: new Uint8Array([1]), c: new Map([["k", 1]]) })).toBe(renameHash({ c: { k: 1 }, b: new Uint8Array([1]), a: new Set(["x", "y"]) }));
  });

  it("keeps the index sort key as read, and counts it in the hash", () => {
    const item = sheetItem("t1", "s1", sheetData(1), 1);
    expect(renamedItem(item, "t1", "s1", SHEETS)).toMatchObject({ GSI1SK: "2026-09-02#s1", GSI1PK: "TEAM#t1#SHEETS", SK: "SHEET#s1", type: "sheet" });
    expect(renameHash({ ...item, GSI1SK: "2026-09-03#s1" })).not.toBe(renameHash(item));
  });

  it("adds totals as sheet-math.js does: supplies charged, equipment lost charged, equipment on loan apart", () => {
    expect(projectTotals(sheetData(1))).toEqual({ out: 8, ret: 1, used: 4 + 3 + 1, chargeCents: 4 * 250 + 330 + 4000, valueCents: 5 * 250 + 330, count: 2, equipmentOut: 1 });
    expect(projectTotals({ items: { a: { price: 0.1, out: 3, returned: 5 }, b: null, c: { kind: "equipment", out: 1, lostCharge: -2 } } })).toEqual({ out: 3, ret: 3, used: 0, chargeCents: 0, valueCents: 30, count: 2, equipmentOut: 1 });
    expect(projectTotals({})).toEqual({ out: 0, ret: 0, used: 0, chargeCents: 0, valueCents: 0, count: 0, equipmentOut: 0 });
  });

  it("estimates an item's size", () => {
    expect(itemBytes({ a: "xy", n: 12.5, b: true, z: null, l: [1, "q"], s: new Set(["ab"]), bin: new Uint8Array(4) })).toBeGreaterThan(10);
    expect(itemBytes(undefined)).toBe(1);
    expect(itemBytes(Symbol("x"))).toBe(0);
  });

  it("refuses a bad team ID or limit before reading", async () => {
    const offline = {} as Db;
    await expect(renameProjects(offline, { apply: false, team: "a#b" })).rejects.toThrow("Invalid team ID");
    await expect(renameProjects(offline, { apply: false, team: "t1", limit: 0 })).rejects.toThrow("Invalid limit");
  });

  it("formats a report with every line it has, and none it doesn't", () => {
    const base = { apply: true, from: "SHEET#", to: "PROJECT#", teams: 1, invalidTeams: 1, teamMissing: true, skippedTeams: 1, found: 3, moved: 1, duplicates: 1, conflicts: 1, gone: 1, failed: 1, retries: 2, invalid: 1, leftByLimit: 1, bytes: 300, largest: 120, exported: 4 };
    const lines = formatRenameReport({ ...base, movements: { found: 0, renamed: 0, conflicts: 0, raced: 0, skipped: true }, verification: { ok: false, checks: [{ check: "x", ok: false }, { check: "y", ok: true }] } });
    expect(lines).toEqual([
      "SHEET# to PROJECT#, teams: 1",
      "No team META item for --team: check the team ID",
      "Teams left alone (no META item, closed or being purged): 1",
      "Team partitions whose ID isn't a valid ID, left alone: 1",
      "Exported 4 items to the file first",
      "Items under SHEET#: 3 (about 300 bytes; the largest about 120)",
      "  moved: 1",
      "  an equal PROJECT# copy already there, old item removed: 1",
      "  conflicts: a different PROJECT# copy exists, both left alone: 1",
      "  gone before it was read, left alone: 1",
      "  still changing after 5 tries, left alone: 1",
      "  retried after someone changed it: 2",
      "  keys that aren't valid IDs, left alone: 1",
      "  not read (--limit): 1",
      "Movements: left for a run without --limit",
      "Verification:",
      "  FAILED: x",
      "  ok: y",
      "Not done: see above. Run it again (it skips what's moved), or roll back with --reverse.",
    ]);
    const quiet = formatRenameReport({ ...base, apply: false, invalidTeams: 0, teamMissing: false, skippedTeams: 0, duplicates: 0, conflicts: 0, gone: 0, failed: 0, retries: 0, invalid: 0, leftByLimit: 0, exported: undefined, movements: { found: 2, renamed: 1, conflicts: 1, raced: 1, skipped: false } });
    expect(quiet).toEqual([
      "SHEET# to PROJECT#, teams: 1",
      "Items under SHEET#: 3 (about 300 bytes; the largest about 120)",
      "  moved: 1 (dry run: would be)",
      "Movements with old attribute names: 2",
      "  renamed: 1 (dry run: would be)",
      "  already have the new names too, left alone: 1",
      "  changed by something else first, left alone: 1",
      "Dry run: nothing was written. Run again with --apply to write.",
    ]);
  });
});

describe("where an export may go", () => {
  const outside = mkdtempSync(join(tmpdir(), "rename-export-"));
  afterAll(() => rmSync(outside, { recursive: true, force: true }));
  const repo = join(outside, "repo");

  it("refuses a path inside the repo, a missing folder or an existing file, and takes a new file outside", () => {
    writeFileSync(join(outside, "taken.json"), "{}");
    expect(exportPath(join(repo, "x.json"), [repo])).toEqual({ problem: expect.stringContaining("doesn't exist") });
    expect(exportPath(join(outside, "taken.json"), [repo])).toEqual({ problem: expect.stringContaining("exists") });
    expect(exportPath(join(outside, "new.json"), [repo])).toEqual({ path: expect.stringMatching(/new\.json$/) });
    // This test file is in the repo: its own folder is refused
    expect(exportPath(join(import.meta.dirname, "export.json"), [join(import.meta.dirname, "..", "..")])).toEqual({ problem: expect.stringContaining("outside the repo") });
    expect(exportPath(join(outside, "new.json"), [outside])).toEqual({ problem: expect.stringContaining("outside the repo") });
  });

  it("refuses anywhere under a folder with a .git entry, even with no roots given: a worktree's main checkout too", () => {
    const nested = join(outside, "checkout", "deep", "er");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(outside, "checkout", ".git"));
    expect(exportPath(join(nested, "x.json"), [])).toEqual({ problem: expect.stringContaining("outside the repo") });
    // This repo's main checkout, from wherever this runs (a worktree is inside it)
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
    expect(exportPath(join(dirname(common), "rename-t.json"), [])).toEqual({ problem: expect.stringContaining("outside the repo") });
    expect(exportPath(join(dirname(common), "rename-t.json"), [import.meta.dirname])).toEqual({ problem: expect.stringContaining("outside the repo") });
  });

  const lower = import.meta.dirname.toLowerCase();
  it.skipIf(lower === import.meta.dirname || !existsSync(lower))("refuses a path inside the repo spelled in another case, on a case-insensitive disk", () => {
    const root = join(import.meta.dirname, "..", "..");
    expect(exportPath(join(lower, "export.json"), [root])).toEqual({ problem: expect.stringContaining("outside the repo") });
  });

  it("refuses rename options on other modes, and bad values, before reading", async () => {
    const run = async (args: string[]) => {
      const err: string[] = [];
      const code = await main(args, () => {}, (l) => err.push(l));
      return { code, err: err.join("\n") };
    };
    const base = ["--table", "t", "--region", REGION, "--endpoint", "http://localhost:1"];
    expect(await run(["members", ...base, "--team", "t1"])).toMatchObject({ code: 2, err: expect.stringContaining("for projects-rename only") });
    expect(await run(["members", ...base, "--reverse"])).toMatchObject({ code: 2 });
    expect(await run(["projects-rename", ...base, "--team", "a#b"])).toMatchObject({ code: 2, err: expect.stringContaining("--team must be a team ID") });
    expect(await run(["projects-rename", ...base, "--limit", "0"])).toMatchObject({ code: 2, err: expect.stringContaining("--limit must be") });
    expect(await run(["projects-rename", ...base, "--limit", "2x"])).toMatchObject({ code: 2 });
    expect(await run(["projects-rename", ...base, "--export-to", join(import.meta.dirname, "export.json")])).toMatchObject({ code: 2, err: expect.stringContaining("outside the repo") });
  });

  it("stops before reading unless the profile signs in to --expect-account's account", async () => {
    const run = async (args: string[]) => {
      const err: string[] = [];
      const deps = { callerAccount: async () => "111111111111", connect: () => ({}) as Db };
      const code = await main(args, () => {}, (l) => err.push(l), deps);
      return { code, err: err.join("\n") };
    };
    const prod = ["projects-rename", "--table", "supply-checkout-test-app", "--region", REGION, "--profile", "p"];
    expect(await run([...prod, "--expect-account", "222222222222"])).toMatchObject({ code: 1, err: expect.stringContaining("not 222222222222 (--expect-account): nothing was read or written") });
    expect(await run([...prod, "--expect-account", "12"])).toMatchObject({ code: 2, err: expect.stringContaining("12-digit") });
    expect(await run(["projects-rename", "--table", "t", "--region", REGION, "--endpoint", "http://localhost:1", "--expect-account", "111111111111"])).toMatchObject({ code: 2 });
    // The right account goes on to connect
    expect(await run([...prod, "--expect-account", "111111111111"])).toMatchObject({ code: 1, err: expect.stringMatching(/^Failed: /) });
  });

  it("reports a failure without item contents", async () => {
    const err: string[] = [];
    const code = await main(["projects-rename", "--table", "t", "--region", REGION, "--endpoint", "http://localhost:1"], () => {}, (l) => err.push(l), {
      callerAccount: () => Promise.reject(new Error("unused")),
      connect: () => ({}) as Db,
      renameOptions: { team: "t1" },
    });
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/^Failed: /);
  });
});

describe.skipIf(!endpoint)("the projects rename on DynamoDB Local", () => {
  const table = useTable();
  const opts = (more: Partial<ProjectsRenameOptions> = {}): ProjectsRenameOptions => ({ apply: true, ...fast, ...more });

  it("finds nothing to do for an empty team, and verifies it", async () => {
    const teamId = await seedTeam(table.db, 0);
    const report = await renameProjects(table.db, opts({ team: teamId }));
    expect(report).toMatchObject({ teams: 1, found: 0, moved: 0, teamMissing: false, movements: { found: 0 } });
    expect(report.verification?.ok).toBe(true);
    expect(formatRenameReport(report).at(-1)).toBe("Done.");
  });

  it("moves many sheets in a dry run's count, then for real, keeping every attribute and the version", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 30, { movements: 3 });
    const before = await partition(db, teamId, "SHEET#");
    const dry = await renameProjects(db, opts({ apply: false, team: teamId }));
    expect(dry).toMatchObject({ found: 30, moved: 30, conflicts: 0, movements: { found: 3, renamed: 3 } });
    expect(dry.verification).toBeUndefined();
    expect(dry.bytes).toBeGreaterThan(30 * 100);
    expect(await partition(db, teamId, "PROJECT#")).toHaveLength(0);

    const report = await renameProjects(db, opts({ team: teamId }));
    expect(report).toMatchObject({ found: 30, moved: 30, retries: 0, movements: { found: 3, renamed: 3 } });
    expect(report.verification).toEqual({ ok: true, checks: expect.any(Array) });
    expect(await partition(db, teamId, "SHEET#")).toHaveLength(0);
    const after = await partition(db, teamId, "PROJECT#");
    expect(after).toHaveLength(30);
    for (const old of before) {
      const id = String(old.SK).slice("SHEET#".length);
      const now = after.find((i) => i.SK === `PROJECT#${id}`);
      expect(now).toEqual({ ...old, SK: `PROJECT#${id}`, GSI1PK: `TEAM#${teamId}#PROJECTS`, type: "project" });
    }
    const { Count } = await connection(db).doc.send(new QueryCommand({ TableName: db.tableName, IndexName: "GSI1", KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": `TEAM#${teamId}#PROJECTS` }, Select: "COUNT" }));
    expect(Count).toBe(30);
    const moves = await partition(db, teamId, "MOVE#");
    expect(moves.every((m) => m.sheetId === undefined && m.fromSheetId === undefined && typeof m.projectId === "string")).toBe(true);
    expect(moves.find((m) => m.reason === "move")).toMatchObject({ projectId: "s1", fromProjectId: "adhoc-1" });

    // Re-run: nothing under SHEET#, nothing to do, and it still verifies
    const again = await renameProjects(db, opts({ team: teamId }));
    expect(again).toMatchObject({ found: 0, moved: 0, movements: { found: 0 } });
    expect(again.verification?.ok).toBe(true);
  });

  it("never overwrites a different project copy, and removes the old item when the copy is equal", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 3);
    const s1 = (await rawItem(db, `TEAM#${teamId}`, "SHEET#s1")) as Record<string, unknown>;
    const s2 = (await rawItem(db, `TEAM#${teamId}`, "SHEET#s2")) as Record<string, unknown>;
    await put(db, renamedItem(s1, teamId, "s1", PROJECTS));
    await put(db, { ...renamedItem(s2, teamId, "s2", PROJECTS), client: "Edited since" });

    const exported: string[] = [];
    const exportTo = async (teams: readonly { items: readonly Record<string, unknown>[] }[]) => void exported.push(...teams.flatMap((t) => t.items.map((i) => String(i.SK))));
    expect(await renameProjects(db, opts({ apply: false, team: teamId, exportTo }))).toMatchObject({ found: 3, moved: 1, duplicates: 1, conflicts: 1, exported: 5 });
    expect(exported.sort()).toEqual(["PROJECT#s1", "PROJECT#s2", "SHEET#s1", "SHEET#s2", "SHEET#s3"]);
    const report = await renameProjects(db, opts({ team: teamId }));
    expect(report).toMatchObject({ found: 3, moved: 1, duplicates: 1, conflicts: 1 });
    expect(report.verification?.ok).toBe(false);
    expect(report.verification?.checks.find((c) => !c.ok)?.check).toBe("no SHEET# items left");
    expect(formatRenameReport(report).at(-1)).toMatch(/^Not done/);
    expect(await rawItem(db, `TEAM#${teamId}`, "SHEET#s1")).toBeUndefined();
    expect(await rawItem(db, `TEAM#${teamId}`, "SHEET#s2")).toEqual(s2);
    expect((await rawItem(db, `TEAM#${teamId}`, "PROJECT#s2"))?.client).toBe("Edited since");
  });

  it("never deletes the old item when the equal copy is deleted before the delete: it moves it instead", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 1);
    const s1 = (await rawItem(db, `TEAM#${teamId}`, "SHEET#s1")) as Record<string, unknown>;
    await put(db, renamedItem(s1, teamId, "s1", PROJECTS));
    const removeCopy = () => connection(db).doc.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "PROJECT#s1" } } }] }));
    const report = await renameProjects(interleaved(db, removeCopy), opts({ team: teamId }));
    expect(report).toMatchObject({ moved: 1, duplicates: 0, retries: 1 });
    // The copy counted before the run is gone, which the count check reports
    expect(report.verification?.checks.filter((c) => !c.ok).map((c) => c.check)).toEqual(["PROJECT# items = PROJECT# items before + moved"]);
    expect(await rawItem(db, `TEAM#${teamId}`, "PROJECT#s1")).toEqual(renamedItem(s1, teamId, "s1", PROJECTS));
  });

  it("leaves a closed or purging team alone, and never calls it done", async () => {
    const { db } = table;
    for (const mark of [{ purgeAfter: "2026-12-01T00:00:00.000Z", closedAt: "2026-10-01T00:00:00.000Z" }, { purging: "2026-10-06T00:00:00.000Z" }]) {
      const teamId = await seedTeam(db, 2);
      await connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "META" }, UpdateExpression: `SET ${Object.keys(mark).map((k) => `${k} = :${k}`).join(", ")}`, ExpressionAttributeValues: Object.fromEntries(Object.entries(mark).map(([k, v]) => [`:${k}`, v])) }));
      const report = await renameProjects(db, opts({ team: teamId }));
      expect(report).toMatchObject({ teams: 0, skippedTeams: 1, teamMissing: false, found: 0 });
      expect(formatRenameReport(report).at(-1)).toMatch(/^Not done/);
      expect(await partition(db, teamId, "SHEET#")).toHaveLength(2);
      expect(await partition(db, teamId, "PROJECT#")).toHaveLength(0);
    }
  });

  it("never moves a sheet once its team starts being purged mid-run", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 1);
    const purge = () => connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "META" }, UpdateExpression: "SET purging = :p", ExpressionAttributeValues: { ":p": "now" } }));
    const report = await renameProjects(interleaved(db, purge), opts({ team: teamId }));
    expect(report).toMatchObject({ moved: 0, failed: 1 });
    expect(await partition(db, teamId, "SHEET#")).toHaveLength(1);
    expect(await partition(db, teamId, "PROJECT#")).toHaveLength(0);
  });

  it("says when --team names no team, and never calls it done", async () => {
    const report = await renameProjects(table.db, opts({ team: newTeamId() }));
    expect(report).toMatchObject({ teamMissing: true, skippedTeams: 1, teams: 0, found: 0 });
    expect(report.verification?.ok).toBe(true);
    expect(formatRenameReport(report).at(-1)).toMatch(/^Not done/);
  });

  it("retries a sheet edited between its read and the move, and moves the edited one", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 1);
    const edit = () =>
      connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "SHEET#s1" }, UpdateExpression: "SET client = :c, version = version + :one", ExpressionAttributeValues: { ":c": "Edited mid-run", ":one": 1 } }));
    const report = await renameProjects(interleaved(db, edit), opts({ team: teamId }));
    expect(report).toMatchObject({ moved: 1, retries: 1, failed: 0 });
    expect(report.verification?.ok).toBe(true);
    expect(await rawItem(db, `TEAM#${teamId}`, "PROJECT#s1")).toMatchObject({ client: "Edited mid-run", version: 2 });
  });

  it("gives up on a sheet still changing after 5 tries, and on one deleted meanwhile", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 2);
    const edit = () => connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "SHEET#s1" }, UpdateExpression: "SET version = version + :one", ExpressionAttributeValues: { ":one": 1 } }));
    const busy = interleaved(db, edit, 5);
    const report = await renameProjects(busy, opts({ team: teamId }));
    expect(report).toMatchObject({ found: 2, moved: 1, failed: 1, retries: 4 });
    expect(await rawItem(db, `TEAM#${teamId}`, "SHEET#s1")).toBeDefined();

    const gone = await seedTeam(db, 1);
    const remove = () => connection(db).doc.send(new TransactWriteCommand({ TransactItems: [{ Delete: { TableName: db.tableName, Key: { PK: `TEAM#${gone}`, SK: "SHEET#s1" } } }] }));
    const report2 = await renameProjects(interleaved(db, remove), opts({ team: gone }));
    expect(report2).toMatchObject({ found: 1, moved: 0, gone: 1, retries: 1 });
  });

  it("reports stock that changed during the run", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 1);
    const checkout = () => connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "PRODUCT#gloves" }, UpdateExpression: "SET stock = :s", ExpressionAttributeValues: { ":s": 11 } }));
    const report = await renameProjects(interleaved(db, checkout), opts({ team: teamId }));
    expect(report.verification?.checks.filter((c) => !c.ok).map((c) => c.check)).toEqual(["product stock unchanged"]);
  });

  it("round-trips: --reverse puts every item back as it was", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 4, { movements: 2 });
    const sheets = await partition(db, teamId, "SHEET#");
    const moves = await partition(db, teamId, "MOVE#");
    expect((await renameProjects(db, opts({ team: teamId }))).verification?.ok).toBe(true);
    const back = await renameProjects(db, opts({ team: teamId, reverse: true }));
    expect(back).toMatchObject({ from: "PROJECT#", to: "SHEET#", found: 4, moved: 4, movements: { renamed: 2 } });
    expect(back.verification?.ok).toBe(true);
    expect(await partition(db, teamId, "SHEET#")).toEqual(sheets);
    expect(await partition(db, teamId, "MOVE#")).toEqual(moves);
    expect(await partition(db, teamId, "PROJECT#")).toHaveLength(0);
  });

  it("leaves a movement that already has the new names alone, and one changed meanwhile", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 0, { movements: 2 });
    await connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "MOVE#gloves#2026-09-01T10:00:00.000Z#op1" }, UpdateExpression: "SET projectId = :p", ExpressionAttributeValues: { ":p": "s9" } }));
    const fix = () => connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${teamId}`, SK: "MOVE#gloves#2026-09-02T10:00:00.000Z#op2" }, UpdateExpression: "REMOVE sheetId" }));
    const report = await renameProjects(interleaved(db, fix, 1, UpdateCommand), opts({ team: teamId }));
    expect(report.movements).toEqual({ found: 2, renamed: 0, conflicts: 1, raced: 1, skipped: false });
    expect(report.verification?.checks.find((c) => !c.ok)?.check).toBe("no movements with sheetId or fromSheetId");
  });

  it("stops at --limit, leaving the rest and the movements for a full run", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 5, { movements: 1 });
    const report = await renameProjects(db, opts({ team: teamId, limit: 2 }));
    expect(report).toMatchObject({ found: 5, moved: 2, leftByLimit: 3, movements: { skipped: true } });
    expect(report.verification?.ok).toBe(false);
    expect(await partition(db, teamId, "SHEET#")).toHaveLength(3);
    const rest = await renameProjects(db, opts({ team: teamId }));
    expect(rest).toMatchObject({ found: 3, moved: 3, movements: { renamed: 1 } });
    expect(rest.verification?.ok).toBe(true);
  });

  it("skips a sheet whose key isn't a valid ID", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 0);
    await put(db, { PK: `TEAM#${teamId}`, SK: "SHEET#bad id", type: "sheet", version: 1 });
    expect(await renameProjects(db, opts({ team: teamId }))).toMatchObject({ found: 1, invalid: 1, moved: 0 });
  });

  it("runs from the CLI with an export, printing counts only, and exits non-zero until it's done", async () => {
    const { db } = table;
    const teamId = await seedTeam(db, 2, { movements: 1 });
    const folder = mkdtempSync(join(tmpdir(), "rename-cli-"));
    try {
      const file = join(folder, "team.json");
      const out: string[] = [];
      const deps = { callerAccount: () => Promise.reject(new Error("unused")), connect: () => db, renameOptions: fast, repoRoots: () => [join(import.meta.dirname, "..", "..")] };
      const base = ["projects-rename", "--table", db.tableName, "--region", REGION, "--endpoint", String(endpoint), "--team", teamId];
      expect(await main([...base, "--export-to", file], (l) => out.push(l), (l) => out.push(l), deps)).toBe(0);
      expect(out.at(-1)).toBe("Dry run: nothing was written. Run again with --apply to write.");
      expect(out).toContain("Exported 3 items to the file first");
      const exported = JSON.parse(readFileSync(file, "utf8"));
      expect(exported).toMatchObject({ mode: "projects-rename", direction: "forward", teams: [{ teamId, items: expect.any(Array) }] });
      expect(exported.teams[0].items.map((i: { SK: string }) => i.SK).sort()).toEqual(["MOVE#gloves#2026-09-01T10:00:00.000Z#op1", "SHEET#s1", "SHEET#s2"]);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // Never over an export already there
      expect(await main([...base, "--export-to", file], () => {}, () => {}, deps)).toBe(2);

      expect(await main([...base, "--limit", "1", "--apply"], (l) => out.push(l), (l) => out.push(l), deps)).toBe(1);
      expect(await main([...base, "--apply"], (l) => out.push(l), (l) => out.push(l), deps)).toBe(0);
      expect(out.at(-1)).toBe("Done.");
      const printed = out.join("\n");
      for (const secret of [teamId, "Client 1", "Person 1", "user-a", "s1", "Gloves", "@"]) expect(printed).not.toContain(secret);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!endpoint)("the projects rename of every team on DynamoDB Local", () => {
  const table = useTable();

  it("finds every team with sheets or old movements by a key-only scan", async () => {
    const { db } = table;
    const a = await seedTeam(db, 2);
    const b = await seedTeam(db, 1, { movements: 1 });
    const c = await seedTeam(db, 0, { movements: 2 });
    await put(db, { PK: "USER#someone", SK: "SHEET#looks-like-one", type: "other" });
    const dry = await renameProjects(db, { apply: false, ...fast });
    expect(dry).toMatchObject({ teams: 3, found: 3, moved: 3, movements: { found: 3 } });
    const report = await renameProjects(db, { apply: true, ...fast });
    expect(report).toMatchObject({ teams: 3, moved: 3, movements: { renamed: 3 } });
    expect(report.verification?.ok).toBe(true);
    for (const t of [a, b, c]) expect(await partition(db, t, "SHEET#")).toHaveLength(0);
    expect(await rawItem(db, "USER#someone", "SHEET#looks-like-one")).toBeDefined();
    expect(await renameProjects(db, { apply: true, ...fast })).toMatchObject({ teams: 0, found: 0, verification: { ok: true } });

    // A team partition whose ID isn't valid is counted, and holds back Done
    await put(db, { PK: "TEAM#bad id", SK: "SHEET#s1", type: "sheet", version: 1 });
    const bad = await renameProjects(db, { apply: true, ...fast });
    expect(bad).toMatchObject({ teams: 0, invalidTeams: 1 });
    expect(formatRenameReport(bad).at(-1)).toMatch(/^Not done/);

    // A closed team is found by the scan but left alone
    const closed = await seedTeam(db, 1);
    await connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, Key: { PK: `TEAM#${closed}`, SK: "META" }, UpdateExpression: "SET purgeAfter = :p", ExpressionAttributeValues: { ":p": "2026-12-01T00:00:00.000Z" } }));
    expect(await renameProjects(db, { apply: true, ...fast })).toMatchObject({ teams: 0, skippedTeams: 1, invalidTeams: 1, found: 0 });
    expect(await partition(db, closed, "SHEET#")).toHaveLength(1);
  });
});
