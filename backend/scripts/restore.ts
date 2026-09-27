// npm run restore: putting a restored table back into service
// (docs/backups.md, "Put a restored table back into service";
// src/data/restore.ts). For the owner to run, never a Lambda. The writing
// modes are a dry run unless --apply is given. It prints counts, settings and,
// for teams a person has to look at, team IDs: never emails, names, user IDs
// or item contents.
//
//   npm run restore -- deletions --table supply-checkout-prod-app-restore-<date> --region <region> --profile <profile> [--records-profile <backup account profile>] [--apply]
//   npm run restore -- copy-back --from supply-checkout-prod-app-restore-<date> --to supply-checkout-prod-app --region <region> --profile <profile> [--apply]
//   npm run restore -- check     --table supply-checkout-prod-app --region <region> --profile <profile>
//
// --endpoint points it at DynamoDB Local instead (tests, local development).

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { createDb, type Db, type DbOptions } from "../src/data/index.js";
import { applyDeletions, checkTableSettings, copyTable, type CopyReport, type DeletionReport, planDeletions } from "../src/data/restore.js";
import { deletionsBucketName, deletionsReplicaBucketName } from "../src/deletions/names.js";
import { cognitoRequest } from "../src/identity/cognito-admin.js";
import { readDeletionRecords, type S3Like } from "../src/deletions/records.js";

export const USAGE = `Usage: npm run restore -- <mode> [options] --region <region> --profile <profile> [--apply]

Modes, in the order the runbook uses them (docs/backups.md):
  deletions  --table <restored table>   delete again, from the restored table, every account and team
                                         the deletion records name. Recorded users still in the environment's
                                         user pool (read from /supply-checkout/<env>/identity/user-pool-id)
                                         are left alone.
                                         --bucket names the records' bucket (by default this environment's,
                                         in the profile's account). --records-profile <profile> reads the
                                         records with another profile: the backup account's, where they're
                                         replicated (by default its copy, supply-checkout-<env>-deletions-copy-
                                         <region>-<backup account>), for a restore after losing the workload
                                         account. --live allows the live table instead, which the runbook never needs
  copy-back  --from <restored table> --to <live table>
                                         make the live table's items the same as the restored table's
  check      --table <live table>       check the table has TTL, the stream, PITR, deletion protection,
                                         KMS encryption, its indexes and its tags; exits 1 if not

Tables: the live table is supply-checkout-<env>-app, a restored one supply-checkout-<env>-app-restore-<suffix>,
and copy-back only goes from an environment's restored table to its own live table.
Without --apply, deletions and copy-back are dry runs: they read and write nothing.
It prints the AWS account the profile signs in to before it reads or writes, and refuses to go on
if SUPPLY_CHECKOUT_EXPECTED_ACCOUNT is set (in your shell, never committed) to another account.
--endpoint <url> uses DynamoDB Local instead of AWS (then --profile isn't needed and any table name goes).`;

/** The live table (tableName in src/data/schema.ts) and a restored one (the restore role's pattern, docs/backups.md). */
export const LIVE_TABLE = /^supply-checkout-([a-z0-9-]+)-app$/;
export const RESTORED_TABLE = /^supply-checkout-([a-z0-9-]+)-app-restore-[a-z0-9-]+$/;

const MODES = ["deletions", "copy-back", "check"] as const;
type Mode = (typeof MODES)[number];

type Credentials = ReturnType<typeof defaultProvider>;

export interface Deps {
  /** The account the credentials belong to (STS GetCallerIdentity). */
  readonly callerAccount: (region: string, credentials: Credentials) => Promise<string>;
  /** A table handle (createDb). */
  readonly connect: (options: DbOptions) => Db;
  /** An S3 client for the deletion records. */
  readonly s3: (region: string, credentials: Credentials | undefined) => S3Like;
  /** The environment's user pool ID, from its SSM parameter (identity stack). */
  readonly userPoolId: (region: string, credentials: Credentials, envName: string) => Promise<string>;
  /** Which of `userIds` the user pool still has (Cognito ListUsers by `sub`). */
  readonly stillInPool: (region: string, credentials: Credentials, userPoolId: string, userIds: readonly string[]) => Promise<Set<string>>;
}

/** ListUsers with `sub = "<id>"`, one ID at a time. IDs are checked first, so none can break out of the filter. */
export async function usersInPool(call: (action: string, body: Record<string, unknown>) => Promise<unknown>, userPoolId: string, userIds: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const userId of userIds) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error("Invalid user ID in a deletion record");
    const answer = (await call("ListUsers", { UserPoolId: userPoolId, Filter: `sub = "${userId}"`, Limit: 1, AttributesToGet: ["sub"] })) as { Users?: unknown[] };
    if (Array.isArray(answer.Users) && answer.Users.length) found.add(userId);
  }
  return found;
}

const defaultDeps: Deps = {
  connect: createDb,
  s3: (region, credentials) => new S3Client({ region, ...(credentials ? { credentials } : {}) }),
  async userPoolId(region, credentials, envName) {
    const ssm = new SSMClient({ region, credentials });
    try {
      const { Parameter } = await ssm.send(new GetParameterCommand({ Name: `/supply-checkout/${envName}/identity/user-pool-id` }));
      if (!Parameter?.Value) throw new Error("The user pool ID parameter is empty");
      return Parameter.Value;
    } finally {
      ssm.destroy();
    }
  },
  stillInPool: (region, credentials, userPoolId, userIds) => usersInPool(cognitoRequest({ region, credentials, timeoutMs: 10_000 }), userPoolId, userIds),
  async callerAccount(region, credentials) {
    const sts = new STSClient({ region, credentials });
    try {
      const { Account } = await sts.send(new GetCallerIdentityCommand({}));
      if (!Account) throw new Error("STS returned no account");
      return Account;
    } finally {
      sts.destroy();
    }
  },
};

const dryRun = (apply: boolean) => (apply ? "" : " (dry run: would be)");
const closing = (apply: boolean) => (apply ? "Done." : "Dry run: nothing was written. Run again with --apply to write.");

export function formatDeletions(records: { users: number; teams: number; invalid: number }, report: DeletionReport): string[] {
  const lines = [`Deletion records: ${records.users} accounts, ${records.teams} teams`];
  if (records.invalid) lines.push(`  records that aren't valid, skipped (look at them in the bucket): ${records.invalid}`);
  if (report.survivors) lines.push(`  accounts that outlived their record (still in the user pool, or joined or created a team after it), left alone: ${report.survivors}`);
  lines.push(`  teams purged: ${report.teamsPurged}${dryRun(report.apply)}${report.apply ? ` (${report.itemsPurged} items)` : ""}`);
  lines.push(`  memberships removed: ${report.membershipsRemoved}${dryRun(report.apply)}`);
  lines.push(`  ${report.apply ? "user rows deleted" : "accounts with rows to delete"}: ${report.userRowsDeleted}${dryRun(report.apply)}`);
  if (report.blockedTeams.length) {
    lines.push(`  teams where a deleted account is the last owner and others are still members, left for a person: ${report.blockedTeams.length}`);
    for (const teamId of report.blockedTeams) lines.push(`    ${teamId}`);
  }
  if (report.unconfirmedTeams.length) {
    lines.push(`  teams a record says its deletion closed that the table doesn't bear out, left for a person: ${report.unconfirmedTeams.length}`);
    for (const teamId of report.unconfirmedTeams) lines.push(`    ${teamId}`);
  }
  lines.push(closing(report.apply));
  return lines;
}

export function formatCopy(report: CopyReport): string[] {
  return [
    `Items: ${report.source} in the restored table, ${report.target} in the live table`,
    `  put: ${report.put}${dryRun(report.apply)}`,
    `  deleted from the live table: ${report.deleted}${dryRun(report.apply)}`,
    `  already the same: ${report.unchanged}`,
    closing(report.apply),
  ];
}

/** Runs the CLI. Returns the exit code: 0 done, 1 failed (or, for check, a setting is wrong), 2 bad arguments. */
export async function main(
  argv: string[],
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
  deps: Deps = defaultDeps,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        table: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        bucket: { type: "string" },
        "records-profile": { type: "string" },
        live: { type: "boolean", default: false },
        region: { type: "string" },
        profile: { type: "string" },
        endpoint: { type: "string" },
        apply: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const bad = (message: string) => {
    err(`${message}\n\n${USAGE}`);
    return 2;
  };
  const [mode, ...extra] = positionals;
  if (!MODES.includes(mode as Mode) || extra.length) return bad(mode ? `Unknown mode: ${[mode, ...extra].join(" ")}` : "No mode given");
  if (!values.region) return bad("--region is required");
  if (!values.endpoint && !values.profile) return bad("--profile is required (or --endpoint for DynamoDB Local)");
  const local = Boolean(values.endpoint);

  // Which tables, checked before anything connects
  let envName: string | undefined;
  if (mode === "copy-back") {
    if (!values.from || !values.to || values.table) return bad("copy-back takes --from and --to");
    if (values.from === values.to) return bad("--from and --to must be different tables");
    if (!local) {
      const from = RESTORED_TABLE.exec(values.from);
      const to = LIVE_TABLE.exec(values.to);
      if (!from) return bad(`--from must be a restored table, supply-checkout-<env>-app-restore-<suffix>: ${values.from}`);
      if (!to) return bad(`--to must be a live table, supply-checkout-<env>-app: ${values.to}`);
      if (from[1] !== to[1]) return bad(`--from and --to must be the same environment's (${from[1]}, ${to[1]})`);
    }
  } else {
    if (!values.table || values.from || values.to) return bad(`${mode} takes --table`);
    const match = mode === "check" ? LIVE_TABLE.exec(values.table) : (RESTORED_TABLE.exec(values.table) ?? (values.live ? LIVE_TABLE.exec(values.table) : null));
    if (!local && !match) {
      if (mode === "check") return bad(`--table must be a live table, supply-checkout-<env>-app: ${values.table}`);
      return bad(LIVE_TABLE.test(values.table) ? `--table is the live table: deletions runs on the restored table before it's copied back (--live to run it on the live table anyway)` : `--table must be a restored table, supply-checkout-<env>-app-restore-<suffix>: ${values.table}`);
    }
    envName = match?.[1];
  }
  const recordsProfile = values["records-profile"];
  if (values.bucket !== undefined && mode !== "deletions") return bad("--bucket is only for deletions");
  if (recordsProfile !== undefined && mode !== "deletions") return bad("--records-profile is only for deletions");
  if (recordsProfile !== undefined && local) return bad("--records-profile is for AWS, not --endpoint");
  if (values.live && mode !== "deletions") return bad("--live is only for deletions");
  if (mode === "deletions" && local && !values.bucket) return bad("--bucket is required with --endpoint");
  if (mode === "check" && values.apply) return bad("check doesn't write: leave out --apply");

  const credentials = values.profile && !local ? defaultProvider({ profile: values.profile }) : undefined;
  const recordsCredentials = recordsProfile ? defaultProvider({ profile: recordsProfile }) : credentials;
  let where = `at ${values.endpoint}`;
  let account: string | undefined;
  if (credentials) {
    try {
      // Before anything is read or written, so the owner sees which account this is
      account = await deps.callerAccount(values.region, credentials);
      where = `in account ${account} (profile ${values.profile})`;
    } catch (e) {
      err(`Failed to identify the profile's account: ${(e as Error).name}: ${(e as Error).message}`);
      return 1;
    }
    const expected = env.SUPPLY_CHECKOUT_EXPECTED_ACCOUNT;
    if (expected && expected !== account) {
      err(`The profile signs in to account ${account}, not SUPPLY_CHECKOUT_EXPECTED_ACCOUNT (${expected}). Nothing was read or written.`);
      return 1;
    }
  }
  const connect = (tableName: string) => deps.connect({ tableName, region: values.region, endpoint: values.endpoint, env: {}, ...(credentials ? { credentials } : {}) });
  const suffix = mode === "check" || values.apply ? "" : " (dry run)";
  try {
    if (mode === "copy-back") {
      out(`copy-back from ${values.from} to ${values.to} in ${values.region} ${where}${suffix}`);
      for (const line of formatCopy(await copyTable(connect(values.from as string), connect(values.to as string), { apply: values.apply }))) out(line);
      return 0;
    }
    const table = values.table as string;
    if (mode === "check") {
      out(`check ${table} in ${values.region} ${where}`);
      const checks = await checkTableSettings(connect(table), envName ?? "");
      for (const c of checks) out(`  ${c.ok ? "ok     " : "WRONG  "}${c.setting}: ${c.found}`);
      const wrong = checks.filter((c) => !c.ok).length;
      out(wrong ? `${wrong} settings are wrong: see "Put a restored table back into service" in docs/backups.md.` : "Every setting is right.");
      return wrong ? 1 : 0;
    }
    let bucket = values.bucket ?? deletionsBucketName(envName as string, values.region, account as string);
    let from = bucket;
    if (recordsProfile) {
      // The backup account's replica (or --bucket), read with that account's profile
      const recordsAccount = await deps.callerAccount(values.region, recordsCredentials as Credentials);
      bucket = values.bucket ?? deletionsReplicaBucketName(envName as string, values.region, recordsAccount);
      from = `${bucket} in account ${recordsAccount} (profile ${recordsProfile})`;
    }
    out(`deletions on ${table} in ${values.region} ${where}, from ${from}${suffix}`);
    if (values.live) out("WARNING: this is the live table. Deleting there skips the check a restored table gets before it's copied back.");
    const { records, invalid } = await readDeletionRecords(deps.s3(values.region, recordsCredentials), bucket);
    const userIds = records.filter((r) => r.kind === "user").map((r) => r.id);
    let inPool: Set<string> | undefined;
    if (credentials) {
      // The environment's own pool, never one given on the command line: a wrong pool would pass everyone
      const pool = await deps.userPoolId(values.region, credentials, envName as string);
      if (!/^[\w-]+_[0-9a-zA-Z]+$/.test(pool)) throw new Error(`/supply-checkout/${envName}/identity/user-pool-id isn't a user pool ID`);
      out(`Checking recorded accounts against user pool ${pool}`);
      inPool = await deps.stillInPool(values.region, credentials, pool, userIds);
    } else out("No user pool check (--endpoint): accounts that outlived their record are found from the table's timestamps");
    const db = connect(table);
    const plan = await planDeletions(db, records, { inPool });
    const report = await applyDeletions(db, plan, { apply: values.apply });
    for (const line of formatDeletions({ ...plan.records, invalid: invalid.length }, report)) out(line);
    return report.blockedTeams.length || report.unconfirmedTeams.length ? 1 : 0;
  } catch (e) {
    // The SDK's error name and message: no item contents
    err(`Failed: ${(e as Error).name}: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
