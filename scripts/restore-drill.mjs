#!/usr/bin/env node
// The prod restore drill (supply-checkout-8x1, docs/backups.md "Restore drill"): restores the
// live table from point-in-time recovery into a NEW table, times it, compares it with the live
// table, prints a short report and deletes the restored table. For the owner to run with an
// SSO administrator profile, never a Lambda. It uses the AWS CLI v2.
//
//   npm run restore-drill                      dry run: prints every AWS call, runs nothing
//   npm run restore-drill -- --apply           runs the drill, then asks before deleting the restored table
//   npm run restore-drill -- --apply --keep    keeps the restored table (to go on with npm run restore)
//
// The live table is only ever read: describe-table, describe-continuous-backups, a
// Select=COUNT scan, and get-item for the spot checks. Every call goes through guard(),
// which refuses any call that isn't one of those on the live table, and any table it would
// create or delete whose name isn't supply-checkout-<env>-app-restore-<suffix>.
//
// It prints counts, times and settings, never item contents or keys: a spot check that
// differs is shown by its key's item type and a short hash.
import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Where the table is: the primary region. Keep in step with DEFAULT_REGIONS[0] in
// infra/lib/config.ts (scripts can't import the TypeScript config).
const DEFAULT_REGION = "us-east-1";
const DEFAULT_PROFILE = "supply-prod";
const ENV = /^[a-z][a-z0-9-]{0,20}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REGION = /^[a-z]+(?:-[a-z]+)+-\d+$/;
/** A restored table's suffix: what the restore tool accepts (RESTORED_TABLE in backend/scripts/restore.ts). */
const SUFFIX = /^[a-z0-9-]+$/;

/** The live table (tableName in backend/src/data/schema.ts). */
export const liveTableName = (envName) => `supply-checkout-${envName}-app`;
/** Restored tables' prefix (restoreTablePrefix in infra/lib/backup.ts): the restore role's pattern. */
export const restorePrefix = (envName) => `${liveTableName(envName)}-restore-`;

export class UsageError extends Error {}
export class RefusedError extends Error {}

/**
 * Throws unless `name` is a restored table of `envName`: it starts with the restore prefix,
 * has a suffix after it, and isn't the live table. Everything this script creates or
 * deletes goes through here.
 */
export function assertRestoreTarget(name, envName) {
  const live = liveTableName(envName);
  const prefix = restorePrefix(envName);
  if (typeof name !== "string" || name === live) throw new RefusedError(`Refusing: ${name} is the live table. The drill only creates and deletes tables named ${prefix}<suffix>.`);
  if (!name.startsWith(prefix) || !SUFFIX.test(name.slice(prefix.length))) {
    throw new RefusedError(`Refusing: ${name} isn't a restored table. The drill only creates and deletes tables named ${prefix}<suffix> (lowercase letters, digits and hyphens).`);
  }
  if (name.length > 255) throw new RefusedError(`Refusing: ${name} is longer than DynamoDB allows.`);
  return name;
}

/** The default target: supply-checkout-<env>-app-restore-<yyyymmdd-hhmm>, in UTC. */
export function defaultTarget(envName, now) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  return `${restorePrefix(envName)}${stamp}`;
}

/** What the drill may do to the live table: read it, and restore from it. */
const LIVE_READS = new Set(["describe-table", "describe-continuous-backups", "scan", "get-item"]);
/** What it may do to a restored table. */
const RESTORED_OPS = new Set(["describe-table", "scan", "get-item", "delete-table"]);

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
}

/**
 * Checks one AWS CLI call before it's run or shown. Only the dynamodb calls listed here, the
 * SSM read of the table key and STS's caller identity are allowed at all.
 */
export function guard(args, envName) {
  const [service, op] = args;
  if (service === "sts" && op === "get-caller-identity") return;
  if (service === "ssm" && op === "get-parameter" && flagValue(args, "--name") === `/supply-checkout/${envName}/data/table-key-arn`) return;
  if (service !== "dynamodb") throw new RefusedError(`Refusing: the drill doesn't call ${service} ${op}.`);
  const live = liveTableName(envName);
  if (op === "restore-table-to-point-in-time") {
    if (flagValue(args, "--source-table-name") !== live) throw new RefusedError(`Refusing: the drill only restores from ${live}.`);
    assertRestoreTarget(flagValue(args, "--target-table-name"), envName);
    return;
  }
  const table = flagValue(args, "--table-name");
  if (table === live) {
    if (!LIVE_READS.has(op)) throw new RefusedError(`Refusing: ${op} on the live table. The drill only reads it.`);
    return;
  }
  if (!RESTORED_OPS.has(op)) throw new RefusedError(`Refusing: the drill doesn't call dynamodb ${op}.`);
  assertRestoreTarget(table, envName);
}

export const USAGE = `Usage: npm run restore-drill -- [--apply] [options]

Restores ${liveTableName("<env>")} from point-in-time recovery to a new table, waits for it,
compares it with the live table and deletes it (after asking). Without --apply it's a dry run:
it prints the AWS calls and runs nothing.

Options:
  --apply              run the drill (otherwise a dry run)
  --keep               keep the restored table afterwards (don't ask to delete it)
  --env <env>          default prod
  --profile <profile>  default ${DEFAULT_PROFILE}
  --region <region>    default ${DEFAULT_REGION}
  --target <name>      the new table (default ${restorePrefix("<env>")}<yyyymmdd-hhmm>, UTC);
                       must start with ${restorePrefix("<env>")}
  --minutes-back <n>   restore to the latest restorable time minus n minutes (default 5)
  --samples <n>        keys to spot-check between the tables (default 20, at most 200)
  --segments <n>       parallel scan segments for the item counts (default 4, at most 16)
  --max-pages <n>      pages each segment's count may read (default 200); a count that hits it is marked partial
  --timeout <minutes>  give up waiting for the restore after this long (default 180)

It prints the AWS account the profile signs in to, and refuses to go on if
SUPPLY_CHECKOUT_EXPECTED_ACCOUNT is set (in your shell, never committed) to another account.`;

const VALUE_FLAGS = new Set(["env", "profile", "region", "target", "minutes-back", "samples", "segments", "max-pages", "timeout"]);
const BOOLEAN_FLAGS = new Set(["apply", "keep", "dry-run", "help"]);

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else throw new UsageError(`Unknown option: --${name}`);
  }
  return flags;
}

function integer(flags, name, fallback, min, max) {
  if (flags[name] === undefined) return fallback;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function validate(flags, env, now) {
  if (flags.apply && flags["dry-run"]) throw new UsageError("--apply and --dry-run can't be used together");
  const envName = flags.env ?? "prod";
  if (!ENV.test(envName)) throw new UsageError(`Invalid --env: ${envName}`);
  const profile = flags.profile ?? DEFAULT_PROFILE;
  if (!PROFILE.test(profile)) throw new UsageError(`Invalid --profile: ${profile}`);
  const region = flags.region ?? DEFAULT_REGION;
  if (!REGION.test(region)) throw new UsageError(`Invalid --region: ${region}`);
  const target = flags.target ?? defaultTarget(envName, now);
  assertRestoreTarget(target, envName);
  return {
    apply: Boolean(flags.apply),
    keep: Boolean(flags.keep),
    envName,
    profile,
    region,
    live: liveTableName(envName),
    target,
    minutesBack: integer(flags, "minutes-back", 5, 1, 60 * 24),
    samples: integer(flags, "samples", 20, 0, 200),
    segments: integer(flags, "segments", 4, 1, 16),
    maxPages: integer(flags, "max-pages", 200, 1, 100000),
    timeoutMinutes: integer(flags, "timeout", 180, 1, 24 * 60),
    expectedAccount: env.SUPPLY_CHECKOUT_EXPECTED_ACCOUNT || undefined,
  };
}

function shellWord(word) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}

/** Sorted-key JSON, so two items with the same attributes compare equal whatever their order. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** How a key is shown: its item type (the text before the first #) and a short hash, never the IDs in it. */
export function describeKey(key) {
  const kind = Object.keys(key)
    .sort()
    .map((name) => String(Object.values(key[name])[0]).split("#")[0])
    .join("/");
  return `${kind} ${createHash("sha256").update(canonical(key)).digest("hex").slice(0, 10)}`;
}

function minutes(ms) {
  return `${(ms / 60000).toFixed(1)} min`;
}

class Aws {
  constructor(settings, deps) {
    this.settings = settings;
    this.deps = deps;
  }

  argv(args) {
    return [...args, "--profile", this.settings.profile, "--region", this.settings.region, "--output", "json"];
  }

  show(args) {
    this.deps.log(`  aws ${this.argv(args).map(shellWord).join(" ")}`);
  }

  /** Runs one call (guarded first) and returns its parsed JSON answer. In a dry run, shows it and returns undefined. */
  async call(args) {
    guard(args, this.settings.envName);
    if (!this.settings.apply) {
      this.show(args);
      return undefined;
    }
    const out = String((await this.deps.run("aws", this.argv(args))) ?? "").trim();
    return out ? JSON.parse(out) : {};
  }
}

/** Counts a table with a parallel Select=COUNT scan, each segment reading at most maxPages pages. */
async function countItems(aws, table, settings) {
  const { segments, maxPages } = settings;
  const one = async (segment) => {
    let count = 0;
    let start;
    for (let page = 0; page < maxPages; page++) {
      const args = ["dynamodb", "scan", "--table-name", table, "--select", "COUNT", "--segment", String(segment), "--total-segments", String(segments), "--no-paginate"];
      if (start) args.push("--exclusive-start-key", JSON.stringify(start));
      const answer = await aws.call(args);
      count += answer.Count ?? 0;
      start = answer.LastEvaluatedKey;
      if (!start) return { count, partial: false };
    }
    return { count, partial: true };
  };
  const results = await Promise.all(Array.from({ length: segments }, (_, s) => one(s)));
  return { count: results.reduce((sum, r) => sum + r.count, 0), partial: results.some((r) => r.partial) };
}

/** Picks up to `n` distinct keys from the restored table, from random scan segments. */
async function sampleKeys(aws, table, keyNames, n, approxCount, deps) {
  const keys = new Map();
  if (n === 0 || approxCount === 0) return [];
  const total = Math.max(1, Math.min(1000000, Math.floor(approxCount / 2)));
  const names = Object.fromEntries(keyNames.map((k, i) => [`#k${i}`, k]));
  for (let attempt = 0; attempt < n * 10 && keys.size < n; attempt++) {
    const segment = total === 1 ? 0 : deps.random(total);
    const answer = await aws.call([
      "dynamodb", "scan", "--table-name", table, "--segment", String(segment), "--total-segments", String(total),
      "--projection-expression", Object.keys(names).join(", "), "--expression-attribute-names", JSON.stringify(names),
      "--limit", String(total === 1 ? n : 5), "--no-paginate",
    ]);
    const items = answer.Items ?? [];
    // A tiny table is one segment: take what its first page has
    if (total === 1) {
      for (const key of items.slice(0, n)) keys.set(canonical(key), key);
      break;
    }
    if (items.length > 0) {
      const key = items[deps.random(items.length)];
      keys.set(canonical(key), key);
    }
  }
  return [...keys.values()];
}

async function getItem(aws, table, key) {
  const answer = await aws.call(["dynamodb", "get-item", "--table-name", table, "--key", JSON.stringify(key), "--consistent-read"]);
  return answer.Item;
}

async function waitForActive(aws, settings, deps) {
  const deadline = deps.now() + settings.timeoutMinutes * 60000;
  for (;;) {
    const { Table: table } = await aws.call(["dynamodb", "describe-table", "--table-name", settings.target]);
    const indexes = table.GlobalSecondaryIndexes ?? [];
    if (table.TableStatus === "ACTIVE" && indexes.every((i) => i.IndexStatus === "ACTIVE")) return table;
    if (deps.now() > deadline) throw new Error(`${settings.target} isn't ACTIVE after ${settings.timeoutMinutes} minutes (status ${table.TableStatus}). Check it in the console; delete it with: aws dynamodb delete-table --table-name ${settings.target} --profile ${settings.profile} --region ${settings.region}`);
    await deps.sleep(15000);
  }
}

function dryRun(aws, settings, deps) {
  const { live, target, envName } = settings;
  deps.log(`Dry run: the drill would restore ${live} to ${target} (nothing is run; --apply runs it):`);
  for (const args of [
    ["sts", "get-caller-identity"],
    ["ssm", "get-parameter", "--name", `/supply-checkout/${envName}/data/table-key-arn`],
    ["dynamodb", "describe-table", "--table-name", live],
    ["dynamodb", "describe-continuous-backups", "--table-name", live],
    ["dynamodb", "restore-table-to-point-in-time", "--source-table-name", live, "--target-table-name", target, "--restore-date-time", `<latest restorable time - ${settings.minutesBack} min>`,
      "--sse-specification-override", "Enabled=true,SSEType=KMS,KMSMasterKeyId=<table key ARN>"],
    ["dynamodb", "describe-table", "--table-name", target],
  ]) {
    guard(args, envName);
    aws.show(args);
  }
  deps.log("    (every 15 seconds until the table and its indexes are ACTIVE)");
  for (const table of [live, target]) {
    const args = ["dynamodb", "scan", "--table-name", table, "--select", "COUNT", "--segment", "<0.." + (settings.segments - 1) + ">", "--total-segments", String(settings.segments), "--no-paginate"];
    aws.show(args);
  }
  deps.log(`    (in parallel, at most ${settings.maxPages} pages a segment)`);
  if (settings.samples > 0) {
    aws.show(["dynamodb", "scan", "--table-name", target, "--segment", "<random>", "--total-segments", "<n>", "--projection-expression", "<key attributes>", "--limit", "5", "--no-paginate"]);
    for (const table of [live, target]) aws.show(["dynamodb", "get-item", "--table-name", table, "--key", "<sampled key>", "--consistent-read"]);
    deps.log(`    (for ${settings.samples} random keys)`);
  }
  if (!settings.keep) {
    const args = ["dynamodb", "delete-table", "--table-name", target];
    guard(args, envName);
    aws.show(args);
    deps.log("    (after you answer y)");
  }
}

/** Runs the drill. `deps` holds every side effect ({ env, run, log, ask, sleep, now, random }), so tests can fake them. */
export async function main(argv, deps) {
  const flags = parseArgs(argv);
  if (flags.help) {
    deps.log(USAGE);
    return 0;
  }
  const settings = validate(flags, deps.env, new Date(deps.now()));
  const aws = new Aws(settings, deps);
  if (!settings.apply) {
    dryRun(aws, settings, deps);
    return 0;
  }
  const { live, target, envName } = settings;

  const { Account: account, Arn: arn } = await aws.call(["sts", "get-caller-identity"]);
  deps.log(`Signed in to account ${account} as ${String(arn).split("/").slice(-2, -1)[0] ?? "?"} (${settings.profile}, ${settings.region}).`);
  if (settings.expectedAccount && settings.expectedAccount !== account) throw new RefusedError(`Refusing: SUPPLY_CHECKOUT_EXPECTED_ACCOUNT is another account.`);

  const { Parameter: parameter } = await aws.call(["ssm", "get-parameter", "--name", `/supply-checkout/${envName}/data/table-key-arn`]);
  const keyArn = parameter.Value;
  const { Table: liveTable } = await aws.call(["dynamodb", "describe-table", "--table-name", live]);
  const liveKey = liveTable.SSEDescription?.KMSMasterKeyArn;
  if (liveKey !== keyArn) throw new Error(`The live table's KMS key isn't the one in /supply-checkout/${envName}/data/table-key-arn. Check the data stack before restoring.`);
  const backups = (await aws.call(["dynamodb", "describe-continuous-backups", "--table-name", live])).ContinuousBackupsDescription;
  const pitr = backups?.PointInTimeRecoveryDescription;
  if (pitr?.PointInTimeRecoveryStatus !== "ENABLED") throw new Error(`Point-in-time recovery isn't on for ${live}.`);
  const latest = Date.parse(pitr.LatestRestorableDateTime);
  const earliest = Date.parse(pitr.EarliestRestorableDateTime);
  const restorePoint = new Date(Math.max(earliest, latest - settings.minutesBack * 60000)).toISOString();
  deps.log(`PITR: restorable from ${new Date(earliest).toISOString()} to ${new Date(latest).toISOString()}. Restoring to ${restorePoint}.`);

  const started = deps.now();
  deps.log(`Restoring ${live} to ${target} (started ${new Date(started).toISOString()})...`);
  await aws.call([
    "dynamodb", "restore-table-to-point-in-time", "--source-table-name", live, "--target-table-name", target, "--restore-date-time", restorePoint,
    "--sse-specification-override", `Enabled=true,SSEType=KMS,KMSMasterKeyId=${keyArn}`,
  ]);
  const restored = await waitForActive(aws, settings, deps);
  const active = deps.now();
  deps.log(`ACTIVE at ${new Date(active).toISOString()}.`);

  const liveIndexes = (liveTable.GlobalSecondaryIndexes ?? []).map((i) => i.IndexName).sort();
  const restoredIndexes = (restored.GlobalSecondaryIndexes ?? []).map((i) => i.IndexName).sort();
  const keyNames = (liveTable.KeySchema ?? []).map((k) => k.AttributeName);

  deps.log("Counting items in both tables (Select=COUNT, read-only on the live table)...");
  const [liveCount, restoredCount] = await Promise.all([countItems(aws, live, settings), countItems(aws, target, settings)]);

  deps.log(`Spot-checking ${settings.samples} keys...`);
  const keys = await sampleKeys(aws, target, keyNames, settings.samples, restoredCount.count, deps);
  const checks = { same: 0, differs: [], missingLive: [] };
  for (const key of keys) {
    const [fromLive, fromRestored] = await Promise.all([getItem(aws, live, key), getItem(aws, target, key)]);
    if (!fromLive) checks.missingLive.push(describeKey(key));
    else if (!fromRestored || canonical(fromLive) !== canonical(fromRestored)) checks.differs.push(describeKey(key));
    else checks.same++;
  }

  const sameKey = restored.SSEDescription?.KMSMasterKeyArn === keyArn;
  const sameIndexes = canonical(liveIndexes) === canonical(restoredIndexes);
  const partial = (c) => (c.partial ? " (partial: page limit hit)" : "");
  deps.log(
    [
      "",
      "Restore drill report (record these on supply-checkout-8x1 and in the drill log)",
      `  Date (UTC)            ${new Date(started).toISOString().slice(0, 10)}`,
      `  Recovery point (UTC)  ${restorePoint}`,
      `  Restored table        ${target}`,
      `  Time to restore       ${minutes(active - started)} (restore call to ACTIVE)`,
      `  KMS key               ${sameKey ? "the table key, as the live table" : "NOT the table key"}`,
      `  Indexes               ${restoredIndexes.join(", ") || "none"}${sameIndexes ? " (same as live)" : ` (live has ${liveIndexes.join(", ") || "none"})`}`,
      `  Items, approximate    live ${liveTable.ItemCount ?? "?"}, restored ${restored.ItemCount ?? "?"} (DescribeTable, updated about every 6 hours)`,
      `  Items, scanned        live ${liveCount.count}${partial(liveCount)}, restored ${restoredCount.count}${partial(restoredCount)}, difference ${liveCount.count - restoredCount.count}`,
      `  Spot checks           ${keys.length} keys: ${checks.same} the same, ${checks.differs.length} differ, ${checks.missingLive.length} not in live`,
      ...[...checks.differs.map((k) => `    differs: ${k}`), ...checks.missingLive.map((k) => `    not in live: ${k}`)],
      "  Items written or deleted since the recovery point differ or are missing from live; that's expected.",
      "  Anything else (a different key or indexes, a large count difference, many differences) needs explaining.",
      "",
    ].join("\n"),
  );
  const ok = sameKey && sameIndexes;

  if (settings.keep) {
    deps.log(`Kept ${target}. Delete it the same day: aws dynamodb delete-table --table-name ${target} --profile ${settings.profile} --region ${settings.region}`);
    return ok ? 0 : 1;
  }
  const answer = String((await deps.ask(`Delete the restored table ${target}? [y/N] `)) ?? "").trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    deps.log(`Kept ${target}. Delete it the same day: aws dynamodb delete-table --table-name ${target} --profile ${settings.profile} --region ${settings.region}`);
    return ok ? 0 : 1;
  }
  await aws.call(["dynamodb", "delete-table", "--table-name", assertRestoreTarget(target, envName)]);
  deps.log(`Deleting ${target}. It's gone in a minute or two.`);
  return ok ? 0 : 1;
}

/* c8 ignore start -- the real process wiring; main() is tested with fakes */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const exec = promisify(execFile);
  const deps = {
    env: process.env,
    log: (m) => console.log(m),
    run: async (cmd, args) => (await exec(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout,
    ask: async (question) => {
      if (!process.stdin.isTTY) return "";
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    random: (n) => randomInt(n),
  };
  main(process.argv.slice(2), deps).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : error.message);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}
/* c8 ignore stop */
