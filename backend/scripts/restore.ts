// npm run restore: putting a restored table back into service
// (docs/backups.md, "Put a restored table back into service";
// src/data/restore.ts). For the owner to run, never a Lambda. The writing
// modes are a dry run unless --apply is given. It prints counts, settings and,
// for teams a person has to look at, team IDs: never emails, names, user IDs
// or item contents.
//
//   npm run restore -- deletions --table supply-checkout-prod-app-restore-<date> --region <region> --profile <profile> [--apply]
//   npm run restore -- copy-back --from supply-checkout-prod-app-restore-<date> --to supply-checkout-prod-app --region <region> --profile <profile> [--apply]
//   npm run restore -- check     --table supply-checkout-prod-app --region <region> --profile <profile>
//
// --endpoint points it at DynamoDB Local instead (tests, local development).

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { createDb, type Db, type DbOptions } from "../src/data/index.js";
import { applyDeletions, checkTableSettings, copyTable, type CopyReport, type DeletionReport, planDeletions } from "../src/data/restore.js";
import { deletionsBucketName } from "../src/deletions/names.js";
import { readDeletionRecords, type S3Like } from "../src/deletions/records.js";

export const USAGE = `Usage: npm run restore -- <mode> [options] --region <region> --profile <profile> [--apply]

Modes, in the order the runbook uses them (docs/backups.md):
  deletions  --table <restored table>   delete again, from the restored table, every account and team
                                         the deletion records name (--bucket to name the records' bucket;
                                         by default it's this environment's, in the profile's account)
  copy-back  --from <restored table> --to <live table>
                                         make the live table's items the same as the restored table's
  check      --table <live table>       check the table has TTL, the stream, PITR, deletion protection,
                                         KMS encryption, its indexes and its tags; exits 1 if not

Tables: the live table is supply-checkout-<env>-app, a restored one supply-checkout-<env>-app-restore-<suffix>,
and copy-back only goes from an environment's restored table to its own live table.
Without --apply, deletions and copy-back are dry runs: they read and write nothing.
It prints the AWS account the profile signs in to before it reads or writes.
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
}

const defaultDeps: Deps = {
  connect: createDb,
  s3: (region, credentials) => new S3Client({ region, ...(credentials ? { credentials } : {}) }),
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
  lines.push(`  teams purged: ${report.teamsPurged}${dryRun(report.apply)}${report.apply ? ` (${report.itemsPurged} items)` : ""}`);
  lines.push(`  memberships removed: ${report.membershipsRemoved}${dryRun(report.apply)}`);
  lines.push(`  ${report.apply ? "user rows deleted" : "accounts with rows to delete"}: ${report.userRowsDeleted}${dryRun(report.apply)}`);
  if (report.blockedTeams.length) {
    lines.push(`  teams where a deleted account is the last owner and others are still members, left for a person: ${report.blockedTeams.length}`);
    for (const teamId of report.blockedTeams) lines.push(`    ${teamId}`);
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
    const match = mode === "check" ? LIVE_TABLE.exec(values.table) : (RESTORED_TABLE.exec(values.table) ?? LIVE_TABLE.exec(values.table));
    if (!local && !match) return bad(mode === "check" ? `--table must be a live table, supply-checkout-<env>-app: ${values.table}` : `--table must be an app table, restored or live: ${values.table}`);
    envName = match?.[1];
  }
  if (values.bucket !== undefined && mode !== "deletions") return bad("--bucket is only for deletions");
  if (mode === "deletions" && local && !values.bucket) return bad("--bucket is required with --endpoint");
  if (mode === "check" && values.apply) return bad("check doesn't write: leave out --apply");

  const credentials = values.profile && !local ? defaultProvider({ profile: values.profile }) : undefined;
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
    const bucket = values.bucket ?? deletionsBucketName(envName as string, values.region, account as string);
    out(`deletions on ${table} in ${values.region} ${where}, from ${bucket}${suffix}`);
    const { records, invalid } = await readDeletionRecords(deps.s3(values.region, credentials), bucket);
    const db = connect(table);
    const plan = await planDeletions(db, records);
    const report = await applyDeletions(db, plan, { apply: values.apply });
    for (const line of formatDeletions({ ...plan.records, invalid: invalid.length }, report)) out(line);
    return report.blockedTeams.length ? 1 : 0;
  } catch (e) {
    // The SDK's error name and message: no item contents
    err(`Failed: ${(e as Error).name}: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
