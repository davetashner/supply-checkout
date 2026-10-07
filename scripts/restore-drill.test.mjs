// node --test scripts/restore-drill.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRestoreTarget, canonical, defaultTarget, describeKey, guard, main, parseArgs, RefusedError, UsageError, validate } from "./restore-drill.mjs";

const LIVE = "supply-checkout-prod-app";
const TARGET = "supply-checkout-prod-app-restore-20261001-1200";
const KEY = "test-table-key";
const NOW = Date.parse("2026-10-01T12:00:30Z");
const INDEXES = [{ IndexName: "GSI1", IndexStatus: "ACTIVE" }, { IndexName: "GSI2", IndexStatus: "ACTIVE" }, { IndexName: "GSI3", IndexStatus: "ACTIVE" }];
const ITEMS = [
  { PK: { S: "TEAM#a" }, SK: { S: "META" }, name: { S: "Acme" } },
  { PK: { S: "TEAM#a" }, SK: { S: "PROJECT#1" }, qty: { N: "3" } },
  { PK: { S: "TEAM#b" }, SK: { S: "META" }, name: { S: "Bolt" } },
];

const keyOf = (item) => ({ PK: item.PK, SK: item.SK });
const flag = (args, name) => args[args.indexOf(name) + 1];

/** A fake AWS CLI: records each call and answers like the real one, for the live and restored tables. */
function harness({ answers = ["y"], liveItems = ITEMS, restoredItems = ITEMS, liveKey = KEY, restoredKey = KEY, pitr = "ENABLED", creatingPolls = 2, countPages = 1, restoredIndexes = INDEXES } = {}) {
  const calls = [];
  const logs = [];
  let now = NOW;
  let polls = 0;
  const asked = [];
  const run = async (cmd, args) => {
    assert.equal(cmd, "aws");
    calls.push(args);
    const [service, op] = args;
    const table = flag(args, "--table-name");
    const items = table === LIVE ? liveItems : restoredItems;
    if (service === "sts") return JSON.stringify({ Account: "test-account", Arn: "assumed-role/AWSReservedSSO_Admin_x/owner" });
    if (service === "ssm") return JSON.stringify({ Parameter: { Value: KEY } });
    if (op === "describe-continuous-backups") {
      return JSON.stringify({ ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: pitr, EarliestRestorableDateTime: "2026-09-01T00:00:00Z", LatestRestorableDateTime: "2026-10-01T11:59:00Z" } } });
    }
    if (op === "describe-table" && table === LIVE) {
      return JSON.stringify({ Table: { TableName: LIVE, TableStatus: "ACTIVE", ItemCount: 3, KeySchema: [{ AttributeName: "PK", KeyType: "HASH" }, { AttributeName: "SK", KeyType: "RANGE" }], SSEDescription: { KMSMasterKeyArn: liveKey }, GlobalSecondaryIndexes: INDEXES } });
    }
    if (op === "describe-table") {
      polls++;
      now += 60000;
      const status = polls > creatingPolls ? "ACTIVE" : "CREATING";
      return JSON.stringify({ Table: { TableName: table, TableStatus: status, ItemCount: 0, SSEDescription: { KMSMasterKeyArn: restoredKey }, GlobalSecondaryIndexes: restoredIndexes } });
    }
    if (op === "restore-table-to-point-in-time") return JSON.stringify({ TableDescription: { TableStatus: "CREATING" } });
    if (op === "scan" && flag(args, "--select") === "COUNT") {
      const segment = Number(flag(args, "--segment"));
      const total = Number(flag(args, "--total-segments"));
      const mine = items.filter((_, i) => i % total === segment);
      const page = args.includes("--exclusive-start-key") ? JSON.parse(flag(args, "--exclusive-start-key")).page : 0;
      const more = page + 1 < countPages;
      return JSON.stringify({ Count: page === 0 ? mine.length : 0, ...(more ? { LastEvaluatedKey: { page: page + 1 } } : {}) });
    }
    if (op === "scan") return JSON.stringify({ Items: items.map(keyOf) });
    if (op === "get-item") {
      const key = JSON.parse(flag(args, "--key"));
      const item = items.find((i) => canonical(keyOf(i)) === canonical(key));
      return JSON.stringify(item ? { Item: item } : {});
    }
    if (op === "delete-table") return JSON.stringify({ TableDescription: { TableStatus: "DELETING" } });
    throw new Error(`unexpected call ${args.join(" ")}`);
  };
  const deps = {
    env: {},
    log: (m) => logs.push(m),
    run,
    ask: async (q) => {
      asked.push(q);
      return answers.shift();
    },
    sleep: async () => {},
    now: () => now,
    random: (n) => (n > 1 ? 1 : 0),
  };
  return { deps, calls, logs, asked, output: () => logs.join("\n") };
}

/** Every call that names the live table: only reads, or the restore that reads it as the source. */
function assertLiveOnlyRead(calls) {
  for (const args of calls) {
    if (flag(args, "--table-name") === LIVE) assert.ok(["describe-table", "describe-continuous-backups", "scan", "get-item"].includes(args[1]), `${args[1]} on the live table`);
    if (args[1] === "restore-table-to-point-in-time") assert.notEqual(flag(args, "--target-table-name"), LIVE);
    if (args[1] === "delete-table") assert.notEqual(flag(args, "--table-name"), LIVE);
  }
}

test("assertRestoreTarget accepts only the environment's restored tables", () => {
  assert.equal(assertRestoreTarget(TARGET, "prod"), TARGET);
  assert.equal(assertRestoreTarget("supply-checkout-prod-app-restore-pitr-20261001", "prod"), "supply-checkout-prod-app-restore-pitr-20261001");
  for (const name of [
    LIVE,
    "supply-checkout-prod-app-restore-",
    "supply-checkout-prod-app-restore",
    "supply-checkout-prod-app-restored-1",
    "supply-checkout-prod-app-copy",
    "supply-checkout-staging-app-restore-20261001-1200",
    "supply-checkout-prod-app-restore-ABC",
    "supply-checkout-prod-app-restore-a_b",
    "x-supply-checkout-prod-app-restore-1",
    `supply-checkout-prod-app-restore-${"a".repeat(240)}`,
    "",
    undefined,
  ]) {
    assert.throws(() => assertRestoreTarget(name, "prod"), RefusedError, String(name));
  }
});

test("guard allows reads of the live table and nothing else on it", () => {
  for (const op of ["describe-table", "describe-continuous-backups", "scan", "get-item"]) guard(["dynamodb", op, "--table-name", LIVE], "prod");
  for (const op of ["delete-table", "put-item", "update-item", "delete-item", "update-table", "batch-write-item", "update-continuous-backups"]) {
    assert.throws(() => guard(["dynamodb", op, "--table-name", LIVE], "prod"), RefusedError, op);
  }
  guard(["dynamodb", "restore-table-to-point-in-time", "--source-table-name", LIVE, "--target-table-name", TARGET], "prod");
  assert.throws(() => guard(["dynamodb", "restore-table-to-point-in-time", "--source-table-name", LIVE, "--target-table-name", LIVE], "prod"), RefusedError);
  assert.throws(() => guard(["dynamodb", "restore-table-to-point-in-time", "--source-table-name", TARGET, "--target-table-name", `${TARGET}-2`], "prod"), RefusedError);
  guard(["dynamodb", "delete-table", "--table-name", TARGET], "prod");
  assert.throws(() => guard(["dynamodb", "delete-table", "--table-name", "supply-checkout-prod-other"], "prod"), RefusedError);
  assert.throws(() => guard(["dynamodb", "delete-table"], "prod"), RefusedError);
  assert.throws(() => guard(["dynamodb", "put-item", "--table-name", TARGET], "prod"), RefusedError);
  assert.throws(() => guard(["dynamodb", "describe-table", "--table-name", "someone-elses-table"], "prod"), RefusedError);
  assert.throws(() => guard(["s3", "rm", "s3://bucket"], "prod"), RefusedError);
  assert.throws(() => guard(["ssm", "get-parameter", "--name", "/other"], "prod"), RefusedError);
  guard(["ssm", "get-parameter", "--name", "/supply-checkout/prod/data/table-key-arn"], "prod");
  guard(["sts", "get-caller-identity"], "prod");
});

test("validate: defaults, a dated target, and refuses the live table as --target", () => {
  const s = validate({}, {}, new Date(NOW));
  assert.deepEqual([s.apply, s.envName, s.profile, s.region, s.target, s.minutesBack, s.samples], [false, "prod", "supply-prod", "us-east-1", TARGET, 5, 20]);
  assert.equal(defaultTarget("staging", new Date(NOW)), "supply-checkout-staging-app-restore-20261001-1200");
  assert.throws(() => validate({ target: LIVE }, {}, new Date(NOW)), RefusedError);
  assert.throws(() => validate({ target: "supply-checkout-prod-app-backup" }, {}, new Date(NOW)), RefusedError);
  assert.throws(() => validate({ apply: true, "dry-run": true }, {}, new Date(NOW)), UsageError);
  assert.throws(() => validate({ samples: "1000" }, {}, new Date(NOW)), UsageError);
  assert.throws(() => validate({ env: "Prod" }, {}, new Date(NOW)), UsageError);
  assert.throws(() => validate({ profile: "bad profile" }, {}, new Date(NOW)), UsageError);
  assert.throws(() => validate({ region: "nowhere" }, {}, new Date(NOW)), UsageError);
  assert.equal(validate({ samples: "0", "max-pages": "3" }, { SUPPLY_CHECKOUT_EXPECTED_ACCOUNT: "1" }, new Date(NOW)).expectedAccount, "1");
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["--apply", "--samples=5", "--profile", "p"]), { apply: true, samples: "5", profile: "p" });
  assert.throws(() => parseArgs(["restore"]), UsageError);
  assert.throws(() => parseArgs(["--bogus"]), UsageError);
  assert.throws(() => parseArgs(["--apply=yes"]), UsageError);
  assert.throws(() => parseArgs(["--profile"]), UsageError);
  assert.throws(() => parseArgs(["--profile", "--apply"]), UsageError);
});

test("the default is a dry run that runs nothing and shows every call", async () => {
  const h = harness();
  assert.equal(await main([], h.deps), 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.asked.length, 0);
  const out = h.output();
  assert.match(out, /Dry run/);
  assert.match(out, /restore-table-to-point-in-time --source-table-name supply-checkout-prod-app --target-table-name supply-checkout-prod-app-restore-20261001-1200/);
  assert.match(out, /SSEType=KMS,KMSMasterKeyId=<table key ARN>/);
  assert.match(out, /--profile supply-prod --region us-east-1/);
  assert.match(out, /delete-table --table-name supply-checkout-prod-app-restore-20261001-1200/);
  assert.doesNotMatch(out, /delete-table --table-name supply-checkout-prod-app /);

  const kept = harness();
  await main(["--keep", "--samples", "0"], kept.deps);
  assert.doesNotMatch(kept.output(), /delete-table/);
  assert.doesNotMatch(kept.output(), /get-item/);
});

test("--help prints the usage", async () => {
  const h = harness();
  assert.equal(await main(["--help"], h.deps), 0);
  assert.match(h.output(), /Usage: npm run restore-drill/);
});

test("--apply restores, waits, compares, reports, and deletes the restored table on y", async () => {
  const h = harness();
  assert.equal(await main(["--apply"], h.deps), 0);
  assertLiveOnlyRead(h.calls);
  const restore = h.calls.find((a) => a[1] === "restore-table-to-point-in-time");
  assert.equal(flag(restore, "--source-table-name"), LIVE);
  assert.equal(flag(restore, "--target-table-name"), TARGET);
  assert.equal(flag(restore, "--restore-date-time"), "2026-10-01T11:54:00.000Z");
  assert.equal(flag(restore, "--sse-specification-override"), `Enabled=true,SSEType=KMS,KMSMasterKeyId=${KEY}`);
  assert.equal(flag(restore, "--profile"), "supply-prod");
  const deletes = h.calls.filter((a) => a[1] === "delete-table");
  assert.deepEqual(deletes.map((a) => flag(a, "--table-name")), [TARGET]);
  assert.equal(h.calls.indexOf(deletes[0]), h.calls.length - 1, "deletes last");
  assert.match(h.asked[0], /Delete the restored table supply-checkout-prod-app-restore-20261001-1200\? \[y\/N\]/);
  const out = h.output();
  assert.match(out, /Time to restore\s+3\.0 min/);
  assert.match(out, /Items, scanned\s+live 3, restored 3, difference 0/);
  assert.match(out, /Spot checks\s+3 keys: 3 the same, 0 differ, 0 not in live/);
  assert.match(out, /KMS key\s+the table key/);
  assert.match(out, /GSI1, GSI2, GSI3 \(same as live\)/);
  assert.doesNotMatch(out, /Acme|Bolt|TEAM#a|TEAM#b/, "no item contents or keys");
});

test("the restored table is kept unless the answer is y, and with --keep nobody is asked", async () => {
  for (const answer of ["", "n", "no", undefined]) {
    const h = harness({ answers: [answer] });
    assert.equal(await main(["--apply"], h.deps), 0);
    assert.equal(h.calls.filter((a) => a[1] === "delete-table").length, 0);
    assert.match(h.output(), /Kept supply-checkout-prod-app-restore-20261001-1200\. Delete it the same day/);
  }
  const keep = harness();
  await main(["--apply", "--keep"], keep.deps);
  assert.equal(keep.asked.length, 0);
  assert.equal(keep.calls.filter((a) => a[1] === "delete-table").length, 0);
});

test("differences are reported by item type and hash, never contents", async () => {
  const live = [{ ...ITEMS[0], name: { S: "Acme Ltd" } }, ITEMS[1]];
  const h = harness({ liveItems: live, answers: ["yes"] });
  assert.equal(await main(["--apply"], h.deps), 0);
  const out = h.output();
  assert.match(out, /3 keys: 1 the same, 1 differ, 1 not in live/);
  assert.match(out, new RegExp(`differs: ${describeKey(keyOf(ITEMS[0]))}`));
  assert.match(out, /differs: TEAM\/META [0-9a-f]{10}/);
  assert.match(out, /Items, scanned\s+live 2, restored 3, difference -1/);
  assert.doesNotMatch(out, /Acme|Bolt|TEAM#/);
  assertLiveOnlyRead(h.calls);
});

test("a count that hits the page limit is marked partial", async () => {
  const h = harness({ countPages: 5, answers: ["n"] });
  await main(["--apply", "--max-pages", "2", "--segments", "2", "--samples", "0"], h.deps);
  assert.match(h.output(), /live 3 \(partial: page limit hit\), restored 3 \(partial: page limit hit\)/);
  const counts = h.calls.filter((a) => a[1] === "scan" && flag(a, "--select") === "COUNT");
  assert.equal(counts.length, 2 * 2 * 2, "2 tables x 2 segments x 2 pages");
  assert.equal(h.calls.filter((a) => a[1] === "get-item").length, 0);
});

test("a restored table with another key or missing indexes exits 1", async () => {
  const h = harness({ restoredKey: "arn:other", restoredIndexes: [{ IndexName: "GSI1", IndexStatus: "ACTIVE" }], answers: ["n"] });
  assert.equal(await main(["--apply"], h.deps), 1);
  assert.match(h.output(), /NOT the table key/);
  assert.match(h.output(), /GSI1 \(live has GSI1, GSI2, GSI3\)/);
});

test("refuses before restoring when the key, PITR or account is wrong", async () => {
  const wrongKey = harness({ liveKey: "arn:other" });
  await assert.rejects(main(["--apply"], wrongKey.deps), /KMS key isn't the one/);
  assert.equal(wrongKey.calls.filter((a) => a[1] === "restore-table-to-point-in-time").length, 0);

  const noPitr = harness({ pitr: "DISABLED" });
  await assert.rejects(main(["--apply"], noPitr.deps), /Point-in-time recovery isn't on/);

  const account = harness();
  account.deps.env = { SUPPLY_CHECKOUT_EXPECTED_ACCOUNT: "other-account" };
  await assert.rejects(main(["--apply"], account.deps), RefusedError);
  assert.equal(account.calls.length, 1);

  const live = harness();
  await assert.rejects(main(["--apply", "--target", LIVE], live.deps), RefusedError);
  assert.equal(live.calls.length, 0);
});

test("gives up waiting after --timeout and leaves the delete command", async () => {
  const h = harness({ creatingPolls: 1000 });
  await assert.rejects(main(["--apply", "--timeout", "3"], h.deps), /isn't ACTIVE after 3 minutes.*delete-table --table-name supply-checkout-prod-app-restore-20261001-1200/s);
  assert.equal(h.calls.filter((a) => a[1] === "delete-table").length, 0);
});
