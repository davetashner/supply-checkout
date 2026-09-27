// Deletion records (src/deletions/records.ts) and putting a restored table
// back into service (src/data/restore.ts, scripts/restore.ts): re-applying
// deletions, copying back and checking the live table's settings. The suites
// that scan a table get their own table in DynamoDB Local and are skipped
// unless DYNAMODB_ENDPOINT is set (CI sets it; locally, npm run test:ddb --
// test/restore.test.ts).

import { randomUUID } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { acceptInvite, authorizeTeam, closeTeam, createInvite, createTeam, type Db, type MemberRole, setDocument } from "../src/data/index.js";
import { connection, dbFromConnection } from "../src/data/client.js";
import { applyDeletions, checkTableSettings, copyTable, planDeletions } from "../src/data/restore.js";
import { DELETION_RECORD_RETENTION_DAYS, deletionsBucketName } from "../src/deletions/names.js";
import { type DeletionRecord, deletionKey, deletionLogFromEnv, readDeletionRecords, s3DeletionLog, type S3Like, validRecord } from "../src/deletions/records.js";
import { formatCopy, formatDeletions, main, USAGE, usersInPool, type Deps } from "../scripts/restore.js";
import { endpoint, fakeDb, newUser, rawItem, REGION, useTable } from "./helpers.js";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const newTeamId = () => `team-${randomUUID()}`;

/** An in-memory bucket behind the three S3 calls records.ts makes, listing `pageSize` keys a page. */
function fakeS3(pageSize = 2) {
  const objects = new Map<string, string>();
  const calls: string[] = [];
  const state = { putError: undefined as string | undefined, getError: undefined as string | undefined };
  const s3: S3Like = {
    async send(command) {
      calls.push(command.constructor.name);
      if (command instanceof PutObjectCommand) {
        const { Key, Body, IfNoneMatch } = command.input;
        if (state.putError) throw Object.assign(new Error(state.putError), { name: state.putError });
        if (IfNoneMatch === "*" && objects.has(Key as string)) throw Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), { name: "PreconditionFailed" });
        objects.set(Key as string, String(Body));
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const keys = [...objects.keys()].filter((k) => k.startsWith(command.input.Prefix ?? "")).sort();
        const start = Number(command.input.ContinuationToken ?? 0);
        const next = start + pageSize;
        return { Contents: [...keys.slice(start, next).map((Key) => ({ Key })), ...(start === 0 ? [{}] : [])], NextContinuationToken: next < keys.length ? String(next) : undefined };
      }
      if (state.getError) throw Object.assign(new Error(state.getError), { name: state.getError });
      const body = objects.get((command as GetObjectCommand).input.Key as string);
      return { Body: body === undefined ? undefined : { transformToString: async () => body } };
    },
  };
  return { s3, objects, calls, state };
}

describe("deletion records", () => {
  it("keeps records well past the longest a backup can be kept", () => {
    // The vault locks' maximum retention is 365 days (infra/lib/backup.ts)
    expect(DELETION_RECORD_RETENTION_DAYS).toBeGreaterThan(365);
    expect(deletionsBucketName("prod", "test-local-1", "acct")).toBe("supply-checkout-prod-deletions-test-local-1-acct");
  });

  it("names objects by kind and ID, and refuses anything that isn't an ID", () => {
    expect(deletionKey("user", "u-1")).toBe("users/u-1.json");
    expect(deletionKey("team", "t_1")).toBe("teams/t_1.json");
    for (const id of ["", "a/b", "../x", "a b", "x".repeat(129), 5 as unknown as string]) expect(() => deletionKey("user", id)).toThrow("Invalid ID");
    expect(() => deletionKey("sheet" as "user", "s1")).toThrow("Unknown deletion kind");
  });

  it("checks a record: its kind, IDs and time, and closed teams only on a user's", () => {
    const at = NOW.toISOString();
    expect(validRecord({ kind: "user", id: "u1", deletedAt: at, teamsClosed: ["t1"] })).toEqual({ kind: "user", id: "u1", deletedAt: at, teamsClosed: ["t1"] });
    // Unknown fields are dropped, and an empty list isn't kept
    expect(validRecord({ kind: "user", id: "u1", deletedAt: at, teamsClosed: [], email: "x@example.com" })).toEqual({ kind: "user", id: "u1", deletedAt: at });
    expect(validRecord({ kind: "team", id: "t1", deletedAt: "2026-09-27T12:00:00Z" })).toEqual({ kind: "team", id: "t1", deletedAt: "2026-09-27T12:00:00Z" });
    for (const bad of [
      null,
      "user",
      { kind: "user", id: "u1" },
      { kind: "user", id: "u1", deletedAt: "yesterday" },
      { kind: "team", id: "t1", deletedAt: at, teamsClosed: ["t2"] },
      { kind: "user", id: "u1", deletedAt: at, teamsClosed: "t2" },
      { kind: "user", id: "u1", deletedAt: at, teamsClosed: ["bad id"] },
      { kind: "user", id: "u1", deletedAt: at, teamsClosed: Array.from({ length: 1001 }, (_, i) => `t${i}`) },
      { kind: "user", id: "bad id", deletedAt: at },
    ]) {
      expect(() => validRecord(bad)).toThrow();
    }
  });

  it("writes each record once, keeping the first, and passes on any other S3 failure", async () => {
    const bucket = fakeS3();
    const log = s3DeletionLog({ bucket: "b", s3: bucket.s3 });
    await log.record({ kind: "user", id: "u1", deletedAt: NOW.toISOString(), teamsClosed: ["t1"] });
    await log.record({ kind: "user", id: "u1", deletedAt: "2026-09-28T00:00:00.000Z" });
    expect(JSON.parse(bucket.objects.get("users/u1.json") as string)).toEqual({ kind: "user", id: "u1", deletedAt: NOW.toISOString(), teamsClosed: ["t1"] });
    bucket.state.putError = "AccessDenied";
    await expect(log.record({ kind: "team", id: "t1", deletedAt: NOW.toISOString() })).rejects.toMatchObject({ name: "AccessDenied" });
    // A bad record never reaches S3
    const before = bucket.calls.length;
    await expect(log.record({ kind: "team", id: "t 1", deletedAt: NOW.toISOString() })).rejects.toThrow("Invalid ID");
    expect(bucket.calls).toHaveLength(before);
  });

  it("needs the bucket and its region to build a Lambda's log", () => {
    expect(() => deletionLogFromEnv({})).toThrow("DELETIONS_BUCKET and DELETIONS_REGION must be set");
    expect(() => deletionLogFromEnv({ DELETIONS_BUCKET: "b" })).toThrow();
    expect(deletionLogFromEnv({ DELETIONS_BUCKET: "b", DELETIONS_REGION: REGION })).toHaveProperty("record");
  });

  it("reads every record across pages, and sets aside objects that aren't valid records or don't match their key", async () => {
    const bucket = fakeS3(2);
    const log = s3DeletionLog({ bucket: "b", s3: bucket.s3 });
    for (const id of ["u1", "u2", "u3"]) await log.record({ kind: "user", id, deletedAt: NOW.toISOString() });
    await log.record({ kind: "team", id: "t1", deletedAt: NOW.toISOString() });
    bucket.objects.set("teams/t2.json", "not json");
    bucket.objects.set("teams/t3.json", JSON.stringify({ kind: "team", id: "t4", deletedAt: NOW.toISOString() }));
    bucket.objects.set("users/u4.json", JSON.stringify({ kind: "team", id: "u4", deletedAt: NOW.toISOString() }));
    const { records, invalid } = await readDeletionRecords(bucket.s3, "b");
    expect(records.map((r) => `${r.kind}:${r.id}`)).toEqual(["user:u1", "user:u2", "user:u3", "team:t1"]);
    expect(invalid).toEqual(["users/u4.json", "teams/t2.json", "teams/t3.json"]);
    // A read that fails fails the whole listing: a missed record is a deletion not re-applied
    bucket.state.getError = "AccessDenied";
    await expect(readDeletionRecords(bucket.s3, "b")).rejects.toMatchObject({ name: "AccessDenied" });
  });

  it("treats an object with no body as invalid", async () => {
    const s3: S3Like = {
      send: async (command) => (command instanceof ListObjectsV2Command ? (command.input.Prefix === "users/" ? { Contents: [{ Key: "users/u1.json" }] } : {}) : {}),
    };
    expect(await readDeletionRecords(s3, "b")).toEqual({ records: [], invalid: ["users/u1.json"] });
  });
});

/** A Db whose low-level client answers with `send`. */
function rawDb(send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>, tableName = "fake"): Db {
  return dbFromConnection({ client: { send } as unknown as ReturnType<typeof connection>["client"], doc: {} as ReturnType<typeof connection>["doc"], tableName, region: REGION });
}

describe("checking the live table's settings", () => {
  const good = {
    DescribeTableCommand: {
      Table: {
        TableArn: "arn:table",
        TableStatus: "ACTIVE",
        GlobalSecondaryIndexes: ["GSI1", "GSI2", "GSI3"].map((IndexName) => ({ IndexName, IndexStatus: "ACTIVE" })),
        SSEDescription: { SSEType: "KMS", Status: "ENABLED" },
        StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
        DeletionProtectionEnabled: true,
      },
    },
    DescribeTimeToLiveCommand: { TimeToLiveDescription: { TimeToLiveStatus: "ENABLED", AttributeName: "expiresAt" } },
    DescribeContinuousBackupsCommand: { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "ENABLED" } } },
  };
  const tags = [
    { Key: "app", Value: "supply-checkout" },
    { Key: "managed-by", Value: "cdk" },
    { Key: "env", Value: "prod" },
    { Key: "component", Value: "data" },
    { Key: "layer", Value: "stateful" },
  ];
  const db = (answers: Record<string, unknown>) =>
    rawDb(async (command) => {
      if (command.constructor.name === "ListTagsOfResourceCommand") {
        // Two pages
        return command.input.NextToken ? { Tags: tags.slice(2) } : { Tags: [...tags.slice(0, 2), {}], NextToken: "2" };
      }
      return answers[command.constructor.name];
    });

  it("passes a table with everything the data stack gives it", async () => {
    const checks = await checkTableSettings(db(good), "prod");
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.map((c) => c.setting)).toEqual(["Status", "Indexes", "Encryption", "TTL", "Stream", "Point-in-time recovery", "Deletion protection", "Tags"]);
    expect(checks.find((c) => c.setting === "Tags")?.found).toBe("app=supply-checkout managed-by=cdk env=prod component=data layer=stateful");
  });

  it("fails a restored table: no TTL, stream, PITR, deletion protection or tags, and says what it found", async () => {
    const restored = {
      DescribeTableCommand: { Table: { TableArn: "arn:t", TableStatus: "ACTIVE", GlobalSecondaryIndexes: [{ IndexName: "GSI1", IndexStatus: "CREATING" }] } },
      DescribeTimeToLiveCommand: { TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" } },
      DescribeContinuousBackupsCommand: {},
    };
    const checks = await checkTableSettings(db(restored), "staging");
    expect(Object.fromEntries(checks.map((c) => [c.setting, [c.ok, c.found]]))).toEqual({
      Status: [true, "ACTIVE"],
      Indexes: [false, "GSI1:CREATING"],
      Encryption: [false, "AWS owned key"],
      TTL: [false, "DISABLED"],
      Stream: [false, "off"],
      "Point-in-time recovery": [false, "unknown"],
      "Deletion protection": [false, "off"],
      Tags: [false, "app=supply-checkout managed-by=cdk env=prod component=data layer=stateful"],
    });
    const empty = await checkTableSettings(db({ DescribeTableCommand: {}, DescribeTimeToLiveCommand: {}, DescribeContinuousBackupsCommand: {} }), "prod");
    expect(empty.filter((c) => c.ok).map((c) => c.setting)).toEqual(["Tags"]);
    expect(empty.find((c) => c.setting === "Indexes")?.found).toBe("none");
    expect(empty.find((c) => c.setting === "TTL")?.found).toBe("unknown");
    const wrongTtl = await checkTableSettings(db({ ...good, DescribeTimeToLiveCommand: { TimeToLiveDescription: { TimeToLiveStatus: "ENABLED", AttributeName: "ttl" } } }), "prod");
    expect(wrongTtl.find((c) => c.setting === "TTL")).toEqual({ setting: "TTL", ok: false, found: "ENABLED on ttl" });
  });
});

describe("copying in batches", () => {
  it("retries what DynamoDB leaves unprocessed, backing off, and gives up after eight tries", async () => {
    const item = (n: number) => ({ PK: { S: `P${n}` }, SK: { S: "S" } });
    const sleeps: number[] = [];
    let unprocessed = 2;
    const writes: number[] = [];
    const source = rawDb(async () => ({ Items: [item(1), item(2)] }), "src");
    const target = rawDb(async (command) => {
      if (command.constructor.name === "ScanCommand") return { Items: [] };
      const requests = (command.input.RequestItems as Record<string, unknown[]>).dst ?? [];
      writes.push(requests.length);
      return unprocessed-- > 0 ? { UnprocessedItems: { dst: requests.slice(-1) } } : {};
    }, "dst");
    expect(await copyTable(source, target, { apply: true, sleep: async (ms) => void sleeps.push(ms) })).toMatchObject({ put: 2 });
    expect(writes).toEqual([2, 1, 1]);
    expect(sleeps).toEqual([100, 200]);

    const stuck = rawDb(async (command) => (command.constructor.name === "ScanCommand" ? { Items: [] } : { UnprocessedItems: { dst: [{}] } }), "dst");
    await expect(copyTable(source, stuck, { apply: true, sleep: async () => {} })).rejects.toThrow("1 writes still unprocessed after 8 attempts");
  });

  it("refuses to copy a table onto itself", async () => {
    const db = rawDb(async () => ({}), "same");
    await expect(copyTable(db, db, { apply: false })).rejects.toThrow("the same table");
  });
});

describe("the restore CLI's arguments", () => {
  const unused: Deps = {
    callerAccount: () => Promise.reject(new Error("must not identify")),
    connect: () => {
      throw new Error("must not connect");
    },
    s3: () => {
      throw new Error("must not use S3");
    },
    userPoolId: () => Promise.reject(new Error("must not read SSM")),
    stillInPool: () => Promise.reject(new Error("must not ask Cognito")),
  };
  const run = async (args: string[], deps: Deps = unused, env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, (l) => out.push(l), (l) => err.push(l), deps, env);
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const live = "supply-checkout-prod-app";
  const restored = "supply-checkout-prod-app-restore-20260927";
  const aws = ["--region", "r", "--profile", "p"];

  it("prints the usage for --help", async () => {
    expect(await run(["--help"])).toEqual({ code: 0, out: USAGE, err: "" });
  });

  it.each([
    [[], /No mode given/],
    [["everything", ...aws], /Unknown mode: everything/],
    [["check", "extra", "--table", live, ...aws], /Unknown mode: check extra/],
    [["check", "--table", live, "--region", "r", "--force"], /Unknown option '--force'/],
    [["check", "--table", live, "--profile", "p"], /--region is required/],
    [["check", "--table", live, "--region", "r"], /--profile is required/],
    [["copy-back", "--from", restored, ...aws], /copy-back takes --from and --to/],
    [["copy-back", "--from", restored, "--to", live, "--table", live, ...aws], /copy-back takes --from and --to/],
    [["copy-back", "--from", live, "--to", live, ...aws], /--from and --to must be different tables/],
    [["copy-back", "--from", "supply-checkout-prod-app-copy", "--to", live, ...aws], /--from must be a restored table/],
    [["copy-back", "--from", restored, "--to", "supply-checkout-prod-app-restore-x", ...aws], /--to must be a live table/],
    [["copy-back", "--from", restored, "--to", "supply-checkout-staging-app", ...aws], /same environment's \(prod, staging\)/],
    [["check", ...aws], /check takes --table/],
    [["deletions", "--from", restored, ...aws], /deletions takes --table/],
    [["check", "--table", restored, ...aws], /--table must be a live table/],
    [["deletions", "--table", "other-table", ...aws], /--table must be a restored table/],
    [["deletions", "--table", live, ...aws], /--table is the live table: deletions runs on the restored table/],
    [["deletions", "--table", restored, "--user-pool-id", "r_pool", ...aws], /Unknown option '--user-pool-id'/],
    [["check", "--table", live, "--live", ...aws], /--live is only for deletions/],
    [["check", "--table", live, "--bucket", "b", ...aws], /--bucket is only for deletions/],
    [["deletions", "--table", "t", "--region", "r", "--endpoint", "http://127.0.0.1:9"], /--bucket is required with --endpoint/],
    [["check", "--table", live, "--apply", ...aws], /check doesn't write/],
  ])("refuses %j", async (args, message) => {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(message);
    expect(result.err).toContain(USAGE);
  });

  it("stops before reading when the profile's account can't be identified", async () => {
    const callerAccount = () => Promise.reject(Object.assign(new Error("The SSO session has expired"), { name: "CredentialsProviderError" }));
    expect(await run(["copy-back", "--from", restored, "--to", live, ...aws, "--apply"], { ...unused, callerAccount })).toEqual({
      code: 1,
      out: "",
      err: "Failed to identify the profile's account: CredentialsProviderError: The SSO session has expired",
    });
  });

  it("checks the live table's settings, naming the account first, and exits 1 when one is wrong", async () => {
    const tables: string[] = [];
    const deps: Deps = {
      ...unused,
      callerAccount: async () => "acct",
      connect: (options) => {
        tables.push(options.tableName as string);
        return rawDb(async (command) => (command.constructor.name === "DescribeTableCommand" ? { Table: { TableStatus: "ACTIVE" } } : {}));
      },
    };
    const result = await run(["check", "--table", live, ...aws], deps);
    expect(tables).toEqual([live]);
    expect(result.code).toBe(1);
    expect(result.out.split("\n")[0]).toBe(`check ${live} in r in account acct (profile p)`);
    expect(result.out).toContain("  ok     Status: ACTIVE");
    expect(result.out).toContain("  WRONG  Deletion protection: off");
    expect(result.out).toMatch(/7 settings are wrong/);
  });

  it("derives the records' bucket from the environment, region and account, and reports a failure without contents", async () => {
    const buckets: string[] = [];
    const deps: Deps = {
      ...unused,
      callerAccount: async () => "acct",
      s3: () => ({
        send: async (command) => {
          buckets.push(String((command as ListObjectsV2Command).input.Bucket));
          throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
        },
      }),
    };
    const result = await run(["deletions", "--table", restored, ...aws], deps);
    expect(buckets).toEqual(["supply-checkout-prod-deletions-r-acct"]);
    expect(result).toMatchObject({ code: 1, err: "Failed: AccessDenied: Access Denied" });
    expect(result.out).toBe(`deletions on ${restored} in r in account acct (profile p), from supply-checkout-prod-deletions-r-acct (dry run)`);
  });

  it("refuses to go on in an account other than SUPPLY_CHECKOUT_EXPECTED_ACCOUNT, before reading anything", async () => {
    const deps: Deps = { ...unused, callerAccount: async () => "acct" };
    expect(await run(["copy-back", "--from", restored, "--to", live, ...aws, "--apply"], deps, { SUPPLY_CHECKOUT_EXPECTED_ACCOUNT: "other" })).toEqual({
      code: 1,
      out: "",
      err: "The profile signs in to account acct, not SUPPLY_CHECKOUT_EXPECTED_ACCOUNT (other). Nothing was read or written.",
    });
  });

  it("runs on the live table only with --live, warning first, and leaves users still in the pool alone", async () => {
    const bucket = fakeS3();
    const log = s3DeletionLog({ bucket: "b", s3: bucket.s3 });
    await log.record({ kind: "user", id: "u-gone", deletedAt: NOW.toISOString() });
    await log.record({ kind: "user", id: "u-back", deletedAt: NOW.toISOString() });
    const asked: string[][] = [];
    const scans: unknown[] = [];
    const deps: Deps = {
      callerAccount: async () => "acct",
      s3: () => bucket.s3,
      userPoolId: async (_region, _credentials, envName) => `r_${envName}pool`,
      stillInPool: async (_region, _credentials, pool, ids) => {
        asked.push([pool, ...ids]);
        return new Set(["u-back"]);
      },
      connect: () =>
        fakeDb(async (command) => {
          scans.push(command.input);
          return { Items: [{ PK: "USER#u-gone", SK: "TEAM#t1" }, { PK: "USER#u-back", SK: "TEAM#t1" }] };
        }),
    };
    const result = await run(["deletions", "--table", live, "--live", ...aws], deps, { SUPPLY_CHECKOUT_EXPECTED_ACCOUNT: "acct" });
    // The environment's own pool, from SSM
    expect(asked).toEqual([["r_prodpool", "u-back", "u-gone"]]);
    expect(scans).toHaveLength(1);
    expect(result.out.split("\n").slice(0, 3)).toEqual([
      `deletions on ${live} in r in account acct (profile p), from supply-checkout-prod-deletions-r-acct (dry run)`,
      "WARNING: this is the live table. Deleting there skips the check a restored table gets before it's copied back.",
      "Checking recorded accounts against user pool r_prodpool",
    ]);
    expect(result.out).toContain("  accounts that outlived their record (still in the user pool, or joined or created a team after it), left alone: 1");
    expect(result.out).toContain("  accounts with rows to delete: 1 (dry run: would be)");
    expect(result.code).toBe(0);
  });

  it("refuses a user pool parameter that isn't a pool ID, before asking Cognito", async () => {
    const bucket = fakeS3();
    const deps: Deps = { ...unused, callerAccount: async () => "acct", s3: () => bucket.s3, userPoolId: async () => "not a pool" };
    expect(await run(["deletions", "--table", restored, ...aws], deps)).toMatchObject({ code: 1, err: "Failed: Error: /supply-checkout/prod/identity/user-pool-id isn't a user pool ID" });
  });

  it("asks Cognito for each recorded user by sub, and refuses an ID that could break the filter", async () => {
    const calls: unknown[] = [];
    const call = async (action: string, body: Record<string, unknown>) => {
      calls.push([action, body]);
      return { Users: body.Filter === 'sub = "u1"' ? [{ Username: "x" }] : [] };
    };
    expect(await usersInPool(call, "r_pool", ["u1", "u2"])).toEqual(new Set(["u1"]));
    expect(calls).toEqual([
      ["ListUsers", { UserPoolId: "r_pool", Filter: 'sub = "u1"', Limit: 1, AttributesToGet: ["sub"] }],
      ["ListUsers", { UserPoolId: "r_pool", Filter: 'sub = "u2"', Limit: 1, AttributesToGet: ["sub"] }],
    ]);
    expect(await usersInPool(async () => ({}), "r_pool", ["u3"])).toEqual(new Set());
    await expect(usersInPool(call, "r_pool", ['u" or sub = "x'])).rejects.toThrow("Invalid user ID");
  });

  it("formats its reports", () => {
    expect(formatDeletions({ users: 2, teams: 1, invalid: 1 }, { apply: true, teamsPurged: 2, itemsPurged: 9, membershipsRemoved: 1, userRowsDeleted: 3, blockedTeams: ["t9"], unconfirmedTeams: ["t8"], survivors: 1 })).toEqual([
      "Deletion records: 2 accounts, 1 teams",
      "  records that aren't valid, skipped (look at them in the bucket): 1",
      "  accounts that outlived their record (still in the user pool, or joined or created a team after it), left alone: 1",
      "  teams purged: 2 (9 items)",
      "  memberships removed: 1",
      "  user rows deleted: 3",
      "  teams where a deleted account is the last owner and others are still members, left for a person: 1",
      "    t9",
      "  teams a record says its deletion closed that the table doesn't bear out, left for a person: 1",
      "    t8",
      "Done.",
    ]);
    expect(formatDeletions({ users: 0, teams: 0, invalid: 0 }, { apply: false, teamsPurged: 0, itemsPurged: 0, membershipsRemoved: 0, userRowsDeleted: 0, blockedTeams: [], unconfirmedTeams: [], survivors: 0 })).toEqual([
      "Deletion records: 0 accounts, 0 teams",
      "  teams purged: 0 (dry run: would be)",
      "  memberships removed: 0 (dry run: would be)",
      "  accounts with rows to delete: 0 (dry run: would be)",
      "Dry run: nothing was written. Run again with --apply to write.",
    ]);
    expect(formatCopy({ apply: true, source: 3, target: 2, put: 1, deleted: 0, unchanged: 2 })).toEqual([
      "Items: 3 in the restored table, 2 in the live table",
      "  put: 1",
      "  deleted from the live table: 0",
      "  already the same: 2",
      "Done.",
    ]);
  });
});

/** Every item in the table, sorted by key. */
async function everything(db: Db) {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(new ScanCommand({ TableName: db.tableName, ConsistentRead: true, ExclusiveStartKey }));
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items.sort((a, b) => `${a.PK} ${a.SK}`.localeCompare(`${b.PK} ${b.SK}`));
}

async function partition(db: Db, pk: string) {
  const { Items } = await connection(db).doc.send(new QueryCommand({ TableName: db.tableName, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true }));
  return Items ?? [];
}

/** A team made the way the app makes one: the owner creates it, and each other member joins by invite. */
async function team(db: Db, owner: string, others: [string, MemberRole][] = [], name = "Echo Cleaning") {
  const { team: created, context } = await createTeam(db, { userId: owner, email: `${owner}@example.com` }, { name }, NOW);
  for (const [userId, role] of others) {
    const made = await createInvite(db, context, { email: `${userId}@example.com`, role }, NOW);
    await acceptInvite(db, { userId, verifiedEmail: `${userId}@example.com` }, made.invite, made.token, NOW);
  }
  await setDocument(db, context, "products", "0123", { code: "0123", name: "Gloves", price: 1 }, { expectedVersion: 0 });
  return { teamId: created.teamId, context };
}

describe.skipIf(!endpoint)("re-applying deletions on DynamoDB Local", () => {
  const table = useTable();

  it("deletes again what the records name, in a dry run first, leaves a person the teams it can't decide, and finds nothing the second time", async () => {
    const db = table.db;
    const [owner, deleted, deleted2, deleted3, stays, recordedOwner, recordedCrew, bystander] = Array.from({ length: 8 }, newUser);
    // A: the deleted user is a contributor beside an owner who stays: they leave it
    const a = await team(db, owner, [[deleted, "contributor"]]);
    // B: only the deleted user: purged, as their deletion closed it and the purge followed
    const b = await team(db, deleted);
    // C: a recorded team deletion: purged, its members' switcher rows too
    const c = await team(db, recordedOwner, [[recordedCrew, "viewer"]]);
    // D: in the deleted user's record as a team their deletion closed
    const d = await team(db, deleted, [], "Closed by deletion");
    // E: deleted2 is the only owner of an open team someone else is still in: for a person
    const e = await team(db, deleted2, [[stays, "viewer"]]);
    // F: deleted3 is the last owner of a closed team: they can leave it
    const f = await team(db, deleted3, [[stays, "contributor"]]);
    await closeTeam(db, f.context, { confirmName: "Echo Cleaning" }, NOW);
    // G: nobody deleted
    const g = await team(db, bystander);
    // The deleted user's other rows go, except the daily counters
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { PK: `USER#${deleted}`, SK: "VERIFIED_EMAIL", verifiedEmailHash: "a".repeat(64) } }));
    await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { PK: `USER#${deleted}`, SK: "LIMIT#TEAMS#2026-09-27", count: 2 } }));

    const at = NOW.toISOString();
    const records: DeletionRecord[] = [
      { kind: "user", id: deleted, deletedAt: at, teamsClosed: [d.teamId] },
      { kind: "user", id: deleted2, deletedAt: at },
      { kind: "user", id: deleted3, deletedAt: at },
      // Deleted before the recovery point: nothing of theirs is here
      { kind: "user", id: newUser(), deletedAt: at },
      { kind: "team", id: c.teamId, deletedAt: at },
      { kind: "team", id: newTeamId(), deletedAt: at },
    ];
    const plan = await planDeletions(db, records);
    expect(plan).toEqual({
      records: { users: 4, teams: 2 },
      teamsToPurge: [b.teamId, c.teamId, d.teamId].sort(),
      memberships: [
        { userId: deleted, teamId: a.teamId },
        { userId: deleted3, teamId: f.teamId },
      ].sort((x, y) => x.teamId.localeCompare(y.teamId)),
      // deleted2's rows wait for the person: their switcher row for E still goes with E's membership
      usersWithRows: [deleted, deleted3].sort(),
      blockedTeams: [e.teamId],
      blockedUsers: [deleted2],
      unconfirmedTeams: [],
      survivors: 0,
    });

    const before = await everything(db);
    expect(await applyDeletions(db, plan, { apply: false })).toEqual({ apply: false, teamsPurged: 3, itemsPurged: 0, membershipsRemoved: 2, userRowsDeleted: 2, blockedTeams: [e.teamId], unconfirmedTeams: [], survivors: 0 });
    expect(await everything(db)).toEqual(before);

    const later = new Date(NOW.getTime() + 60_000);
    const report = await applyDeletions(db, plan, { apply: true, now: later });
    expect(report).toMatchObject({ apply: true, teamsPurged: 3, membershipsRemoved: 2, blockedTeams: [e.teamId] });
    expect(report.itemsPurged).toBeGreaterThan(6);
    for (const t of [b, c, d]) expect(await partition(db, `TEAM#${t.teamId}`)).toEqual([]);
    for (const u of [recordedOwner, recordedCrew]) expect(await rawItem(db, `USER#${u}`, `TEAM#${c.teamId}`)).toBeUndefined();
    // A: out of it, the counts moved, the leaving audited as the account's deletion
    expect(await rawItem(db, `TEAM#${a.teamId}`, `MEMBER#${deleted}`)).toBeUndefined();
    expect(await rawItem(db, `TEAM#${a.teamId}`, "META")).toMatchObject({ members: 1, owners: 1 });
    const audits = (await partition(db, `TEAM#${a.teamId}`)).filter((i) => String(i.SK).startsWith("AUDIT#"));
    expect(audits).toContainEqual(expect.objectContaining({ action: "member.left", target: deleted, detail: { reason: "account_deleted" } }));
    // F: the last owner of a closed team left it
    expect(await rawItem(db, `TEAM#${f.teamId}`, "META")).toMatchObject({ members: 1, owners: 0 });
    // E: untouched, for a person
    expect(await rawItem(db, `TEAM#${e.teamId}`, `MEMBER#${deleted2}`)).toMatchObject({ role: "owner" });
    // G: untouched
    expect((await partition(db, `TEAM#${g.teamId}`)).length).toBeGreaterThan(2);
    // Only the daily counter is left of the deleted user
    expect((await partition(db, `USER#${deleted}`)).map((i) => i.SK)).toEqual(["LIMIT#TEAMS#2026-09-27"]);
    expect((await partition(db, `USER#${deleted3}`)).map((i) => i.SK)).toEqual(["LIMIT#TEAMS#2026-09-27"]);

    // Again: only the team for a person is left
    const again = await planDeletions(db, records);
    expect(again).toEqual({ records: { users: 4, teams: 2 }, teamsToPurge: [], memberships: [], usersWithRows: [], blockedTeams: [e.teamId], blockedUsers: [deleted2], unconfirmedTeams: [], survivors: 0 });
    expect(await rawItem(db, `USER#${deleted2}`, `TEAM#${e.teamId}`)).toBeDefined();
  });

  it("purges a team a record says its deletion closed only when the table bears it out, and reports the rest", async () => {
    const db = table.db;
    const [deleted, other, stranger] = [newUser(), newUser(), newUser()];
    // The user's own team, alone: purged
    const own = await team(db, deleted, [], "Own");
    // Closed, nobody left in it (the deletion had already left it): purged
    const emptied = await team(db, other, [], "Emptied");
    await closeTeam(db, emptied.context, { confirmName: "Emptied" }, NOW);
    const { removeMember } = await import("../src/data/index.js");
    await removeMember(db, await authorizeTeam(db, other, emptied.teamId), other, {}, NOW);
    // Someone else's open team, which the user isn't in: for a person, untouched
    const foreign = await team(db, stranger, [], "Foreign");
    // The user's team with a member who isn't deleted: for a person, and the user is held back
    const shared = await team(db, deleted, [[other, "viewer"]], "Shared");
    const records: DeletionRecord[] = [{ kind: "user", id: deleted, deletedAt: NOW.toISOString(), teamsClosed: [own.teamId, emptied.teamId, foreign.teamId, shared.teamId] }];
    const plan = await planDeletions(db, records);
    expect(plan).toMatchObject({
      teamsToPurge: [own.teamId, emptied.teamId].sort(),
      memberships: [],
      unconfirmedTeams: [foreign.teamId, shared.teamId].sort(),
      blockedUsers: [deleted],
      usersWithRows: [],
    });
    const report = await applyDeletions(db, plan, { apply: true, now: NOW });
    expect(report).toMatchObject({ teamsPurged: 2, unconfirmedTeams: [foreign.teamId, shared.teamId].sort() });
    expect(await rawItem(db, `TEAM#${foreign.teamId}`, "META")).toMatchObject({ name: "Foreign" });
    expect(await rawItem(db, `TEAM#${shared.teamId}`, `MEMBER#${deleted}`)).toBeDefined();
    expect(await rawItem(db, `USER#${deleted}`, `TEAM#${shared.teamId}`)).toBeDefined();
  });

  it("leaves alone a recorded user who outlived their record: still in Cognito, or joined or created a team after it", async () => {
    const db = table.db;
    const [owner, joinedLater, createdLater, inPool] = [newUser(), newUser(), newUser(), newUser()];
    const earlier = new Date(NOW.getTime() - 86400_000).toISOString();
    // Joined after the record's time (the team was made at NOW, the record says a day before)
    const t = await team(db, owner, [[joinedLater, "contributor"], [inPool, "viewer"]]);
    // Created a team after it
    const created = await team(db, createdLater, [], "Later");
    const records: DeletionRecord[] = [
      { kind: "user", id: joinedLater, deletedAt: earlier },
      { kind: "user", id: createdLater, deletedAt: earlier, teamsClosed: [created.teamId] },
      { kind: "user", id: inPool, deletedAt: NOW.toISOString() },
    ];
    // Without the Cognito check (local runs), the timestamps decide: the first two survived, the third is deleted
    expect(await planDeletions(db, records)).toMatchObject({ teamsToPurge: [], memberships: [{ userId: inPool, teamId: t.teamId }], survivors: 2 });
    // With it, the pool alone decides
    const plan = await planDeletions(db, records, { inPool: new Set([joinedLater, createdLater, inPool]) });
    expect(plan).toMatchObject({ teamsToPurge: [], memberships: [], usersWithRows: [], unconfirmedTeams: [], survivors: 3 });
    await applyDeletions(db, plan, { apply: true, now: NOW });
    for (const u of [joinedLater, inPool]) expect(await rawItem(db, `TEAM#${t.teamId}`, `MEMBER#${u}`)).toBeDefined();
    expect(await rawItem(db, `TEAM#${created.teamId}`, "META")).toBeDefined();
  });

  it("with the Cognito check, deletes a user the pool no longer has even if they came back after a first, failed deletion", async () => {
    const db = table.db;
    const [owner, returned] = [newUser(), newUser()];
    // The first deletion wrote its record a day ago and failed; the user came back, joined a team and
    // made one, then was deleted for real (If-None-Match kept the first record's time)
    const earlier = new Date(NOW.getTime() - 86400_000).toISOString();
    const joined = await team(db, owner, [[returned, "contributor"]], "Joined");
    const made = await team(db, returned, [], "Made");
    const records: DeletionRecord[] = [{ kind: "user", id: returned, deletedAt: earlier }];
    expect((await planDeletions(db, records)).survivors).toBe(1);
    const plan = await planDeletions(db, records, { inPool: new Set() });
    expect(plan).toMatchObject({ survivors: 0, teamsToPurge: [made.teamId], memberships: [{ userId: returned, teamId: joined.teamId }], usersWithRows: [returned] });
    await applyDeletions(db, plan, { apply: true, now: NOW });
    expect(await partition(db, `TEAM#${made.teamId}`)).toEqual([]);
    expect(await rawItem(db, `TEAM#${joined.teamId}`, `MEMBER#${returned}`)).toBeUndefined();
    expect((await partition(db, `USER#${returned}`)).filter((i) => !String(i.SK).startsWith("LIMIT#"))).toEqual([]);
  });

  it("treats a membership already gone, or an owner who left meanwhile, the way the app would", async () => {
    const db = table.db;
    const [owner, other, deleted] = [newUser(), newUser(), newUser()];
    const t = await team(db, owner, [[deleted, "owner"], [other, "viewer"]]);
    const gone = await team(db, owner, [[deleted, "viewer"]], "Gone");
    const records: DeletionRecord[] = [{ kind: "user", id: deleted, deletedAt: NOW.toISOString() }];
    const plan = await planDeletions(db, records);
    expect(plan.memberships).toHaveLength(2);
    // Between the plan and the write: the deleted user left one team, and the other owner left the other
    const leaver = await authorizeTeam(db, deleted, gone.teamId);
    const { removeMember } = await import("../src/data/index.js");
    await removeMember(db, leaver, deleted);
    await removeMember(db, t.context, owner);
    expect(plan.usersWithRows).toEqual([deleted]);
    const report = await applyDeletions(db, plan, { apply: true, now: NOW });
    expect(report).toMatchObject({ membershipsRemoved: 0, userRowsDeleted: 0, blockedTeams: [t.teamId] });
    expect(await rawItem(db, `TEAM#${t.teamId}`, `MEMBER#${deleted}`)).toMatchObject({ role: "owner" });
    // Held back for the person too: their switcher row still matches the membership
    expect(await rawItem(db, `USER#${deleted}`, `TEAM#${t.teamId}`)).toBeDefined();
  });

  it("skips a team whose META item went between the plan and the write", async () => {
    const db = table.db;
    const deleted = newUser();
    const t = await team(db, deleted, [], "Vanishing");
    const plan = { records: { users: 1, teams: 0 }, teamsToPurge: [t.teamId, newTeamId()], memberships: [], usersWithRows: [], blockedTeams: [], blockedUsers: [], unconfirmedTeams: [], survivors: 0 };
    await closeTeam(db, t.context, { confirmName: "Vanishing" }, NOW);
    // A closed team is purged too, keeping its first closure time
    expect(await applyDeletions(db, plan, { apply: true, now: new Date(NOW.getTime() + 1000) })).toMatchObject({ teamsPurged: 1 });
    expect(await partition(db, `TEAM#${t.teamId}`)).toEqual([]);
  });

  it("runs from the CLI against DynamoDB Local, reading the records from the bucket", async () => {
    const db = table.db;
    const deleted = newUser();
    const t = await team(db, deleted, [], "From the CLI");
    const bucket = fakeS3();
    await s3DeletionLog({ bucket: "records", s3: bucket.s3 }).record({ kind: "user", id: deleted, deletedAt: NOW.toISOString() });
    const deps: Deps = {
      callerAccount: () => Promise.reject(new Error("must not identify")),
      connect: (options) => (options.tableName === db.tableName ? db : (undefined as never)),
      s3: () => bucket.s3,
      userPoolId: () => Promise.reject(new Error("must not read SSM")),
      stillInPool: () => Promise.reject(new Error("must not ask Cognito")),
    };
    const out: string[] = [];
    const args = ["deletions", "--table", db.tableName, "--region", REGION, "--endpoint", endpoint as string, "--bucket", "records"];
    expect(await main(args, (l) => out.push(l), () => {}, deps)).toBe(0);
    expect(out[0]).toBe(`deletions on ${db.tableName} in ${REGION} at ${endpoint}, from records (dry run)`);
    expect(out).toContain("  teams purged: 1 (dry run: would be)");
    expect(await rawItem(db, `TEAM#${t.teamId}`, "META")).toBeDefined();
    out.length = 0;
    expect(await main([...args, "--apply"], (l) => out.push(l), () => {}, deps)).toBe(0);
    expect(out.at(-1)).toBe("Done.");
    expect(await partition(db, `TEAM#${t.teamId}`)).toEqual([]);
  });
});

describe.skipIf(!endpoint)("copying back on DynamoDB Local", () => {
  const source = useTable();
  const target = useTable();

  it("makes the live table's items the restored table's, every type exactly, in a dry run first, then finds nothing to do", async () => {
    const put = (db: Db, Item: Record<string, unknown>) => connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item }));
    // More than one write batch, with numbers, sets, binary, lists and maps
    for (let i = 0; i < 130; i++) await put(source.db, { PK: `TEAM#t${i % 7}`, SK: `ITEM#${String(i).padStart(3, "0")}`, n: i, price: 12.5 });
    const rich = { PK: "TEAM#rich", SK: "META", tags: new Set(["b", "a"]), counts: new Set([3, 1]), blob: new Uint8Array([1, 2, 3]), nested: { list: [1, "x", { deep: true }], empty: null }, GSI1PK: "TEAMS#CLOSED", GSI1SK: "2026-10-27#rich" };
    await put(source.db, rich);
    // The live table: some the same, some changed since, some the restore doesn't have
    for (let i = 0; i < 50; i++) await put(target.db, { PK: `TEAM#t${i % 7}`, SK: `ITEM#${String(i).padStart(3, "0")}`, n: i, price: 12.5 });
    await put(target.db, { PK: "TEAM#t0", SK: "ITEM#000", n: 999, price: 12.5 });
    await put(target.db, { ...rich, tags: new Set(["a", "b"]), counts: new Set([1, 3]) });
    for (let i = 0; i < 30; i++) await put(target.db, { PK: `TEAM#new${i}`, SK: "META", n: i });

    const dry = await copyTable(source.db, target.db, { apply: false });
    // The rich item's sets are the same in any order: unchanged
    expect(dry).toEqual({ apply: false, source: 131, target: 81, put: 81, deleted: 30, unchanged: 50 });
    expect(await everything(target.db)).toHaveLength(81);

    expect(await copyTable(source.db, target.db, { apply: true })).toEqual({ ...dry, apply: true });
    expect(await everything(target.db)).toEqual(await everything(source.db));
    expect(await rawItem(target.db, "TEAM#rich", "META")).toEqual(rich);
    expect(await copyTable(source.db, target.db, { apply: true })).toEqual({ apply: true, source: 131, target: 131, put: 0, deleted: 0, unchanged: 131 });
  });

  it("runs from the CLI against DynamoDB Local", async () => {
    const out: string[] = [];
    const deps: Deps = {
      callerAccount: () => Promise.reject(new Error("must not identify")),
      connect: (options) => (options.tableName === source.db.tableName ? source.db : target.db),
      s3: () => {
        throw new Error("must not use S3");
      },
      userPoolId: () => Promise.reject(new Error("must not read SSM")),
      stillInPool: () => Promise.reject(new Error("must not ask Cognito")),
    };
    const code = await main(["copy-back", "--from", source.db.tableName, "--to", target.db.tableName, "--region", REGION, "--endpoint", endpoint as string], (l) => out.push(l), () => {}, deps);
    expect(code).toBe(0);
    expect(out[0]).toBe(`copy-back from ${source.db.tableName} to ${target.db.tableName} in ${REGION} at ${endpoint} (dry run)`);
    expect(out).toContain("  already the same: 131");
  });
});
