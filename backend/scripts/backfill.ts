// npm run backfill: one-off migrations of the app table (src/data/backfill.ts),
// for the owner to run after a deploy (docs/infrastructure.md, "Backfills").
// A dry run unless --apply is given. It prints counts, never emails, names or
// user IDs.
//
//   npm run backfill -- stray-ops-keys --table <table> --region <region> --profile <profile>
//   npm run backfill -- ops-index      --table <table> --region <region> --profile <profile> --apply
//   npm run backfill -- members        --table <table> --region <region> --profile <profile> --apply
//   npm run backfill -- notice-address --table <table> --region <region> --profile <profile> --user-pool <app pool ID> --apply
//
// --endpoint points it at DynamoDB Local instead (tests, local development).

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { createDb, type Db, type DbOptions } from "../src/data/index.js";
import { BACKFILL_MODES, type BackfillMode, type BackfillReport, type NoticeAddressCandidate, runBackfill } from "../src/data/backfill.js";
import { listPoolUsers, type PoolUser } from "../src/identity/cognito-admin.js";
import { noticeAddressOf } from "../src/identity/notice-address.js";

export const USAGE = `Usage: npm run backfill -- <mode> --table supply-checkout-<env>-app --region <region> --profile <profile> [--apply]

Modes (run in this order after the deploy):
  stray-ops-keys  remove GSI3 keys from items that shouldn't have them
  ops-index       set GSI3 keys on team META items and owner MEMBER items made before the operators' index
  members         set the members count on team META items made before it existed

  notice-address  record the address an email change is told to, for every app pool user
                  whose verified address the API trusts and who has none (needs --user-pool)

Without --apply it's a dry run: it reads the table and writes nothing.
It prints the AWS account the profile signs in to before it reads or writes.
--user-pool <ID> is the app user pool (notice-address only): /supply-checkout/<env>/identity/user-pool-id in SSM.
--endpoint <url> uses DynamoDB Local instead of AWS (then --profile isn't needed and any table name goes).`;

/** An app table's name (tableName in src/data/schema.ts), so a typo can't point the backfill at another table. */
export const APP_TABLE = /^supply-checkout-[a-z0-9-]+-app$/;

/** A user pool ID, `<region>_<id>`: the region is the first group. */
export const POOL_ID = /^([a-z]+(?:-[a-z]+)+-\d+)_[A-Za-z0-9]{1,64}$/;

type Credentials = ReturnType<typeof defaultProvider>;

export interface Deps {
  /** The account the credentials belong to (STS GetCallerIdentity). */
  readonly callerAccount: (region: string, credentials: Credentials) => Promise<string>;
  /** The table handle (createDb). */
  readonly connect: (options: DbOptions) => Db;
  /** Every user in the pool (ListUsers); listUsers below unless given. */
  readonly listUsers?: (region: string, userPoolId: string, credentials: Credentials | undefined) => AsyncIterable<PoolUser>;
}

/** Every user in the app pool, with the profile's credentials (the owner's: no Lambda role may list the pool for this). */
const listUsers = (region: string, userPoolId: string, credentials: Credentials | undefined) =>
  listPoolUsers({ region, userPoolId, timeoutMs: 10_000, ...(credentials ? { credentials } : {}) });

const defaultDeps: Deps = {
  connect: createDb,
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

const DESCRIPTIONS: Record<BackfillMode, { found: string; change: string }> = {
  "stray-ops-keys": { found: "Items with GSI3 keys they shouldn't have", change: "keys removed" },
  "ops-index": { found: "Team META and owner MEMBER items without GSI3 keys", change: "keys set" },
  members: { found: "Teams without a members count", change: "count set" },
  "notice-address": { found: "Accounts with a trusted verified address and no notice address", change: "address recorded" },
};

/** Each pool user as the backfill sees them: the address the API trusts (never printed), or undefined. */
async function* candidates(users: AsyncIterable<PoolUser>): AsyncGenerator<NoticeAddressCandidate | undefined> {
  for await (const user of users) yield noticeAddressOf(user.username, user.attributes);
}

export function formatReport(report: BackfillReport): string[] {
  const d = DESCRIPTIONS[report.mode];
  const lines: string[] = [];
  if (report.accounts) {
    const a = report.accounts;
    lines.push(`App pool users: ${a.listed}`);
    lines.push(`  no verified address the API trusts, left alone: ${a.untrusted}`);
    lines.push(`  address already recorded, left alone: ${a.present}`);
    if (a.deleting) lines.push(`  being deleted, left alone: ${a.deleting}`);
  }
  lines.push(`${d.found}: ${report.found}`);
  lines.push(`  ${d.change}: ${report.changed}${report.apply ? "" : " (dry run: would be)"}`);
  if (report.raced) lines.push(`  changed by something else first, left alone: ${report.raced}`);
  if (report.invalid) lines.push(`  keys that aren't valid IDs, left alone: ${report.invalid}`);
  for (const kind of report.strays ?? []) lines.push(`  ${kind}`);
  lines.push(report.apply ? "Done." : "Dry run: nothing was written. Run again with --apply to write.");
  return lines;
}

/** Runs the CLI. Returns the exit code: 0 done, 1 failed, 2 bad arguments. */
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
        region: { type: "string" },
        profile: { type: "string" },
        endpoint: { type: "string" },
        "user-pool": { type: "string" },
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
  const [mode, ...extra] = positionals;
  if (!BACKFILL_MODES.includes(mode as BackfillMode) || extra.length) {
    err(`${mode ? `Unknown mode: ${[mode, ...extra].join(" ")}` : "No mode given"}\n\n${USAGE}`);
    return 2;
  }
  if (!values.table || !values.region) {
    err(`--table and --region are required\n\n${USAGE}`);
    return 2;
  }

  const pool = values["user-pool"];
  if (mode === "notice-address") {
    const poolRegion = pool === undefined ? undefined : POOL_ID.exec(pool)?.[1];
    if (!poolRegion) {
      err(`--user-pool must be the app user pool's ID, <region>_<id>, for notice-address\n\n${USAGE}`);
      return 2;
    }
    if (poolRegion !== values.region) {
      err(`--user-pool is in ${poolRegion}, not --region ${values.region}\n\n${USAGE}`);
      return 2;
    }
  } else if (pool !== undefined) {
    err(`--user-pool is for notice-address only\n\n${USAGE}`);
    return 2;
  }

  if (!values.endpoint && !values.profile) {
    err(`--profile is required (or --endpoint for DynamoDB Local)\n\n${USAGE}`);
    return 2;
  }
  if (!values.endpoint && !APP_TABLE.test(values.table)) {
    err(`--table must be an app table, supply-checkout-<env>-app: ${values.table}\n\n${USAGE}`);
    return 2;
  }

  const credentials = values.profile && !values.endpoint ? defaultProvider({ profile: values.profile }) : undefined;
  let where = `at ${values.endpoint}`;
  if (credentials) {
    try {
      // Before anything is read or written, so the owner sees which account this is
      where = `in account ${await deps.callerAccount(values.region, credentials)} (profile ${values.profile})`;
    } catch (e) {
      err(`Failed to identify the profile's account: ${(e as Error).name}: ${(e as Error).message}`);
      return 1;
    }
  }
  const db = deps.connect({ tableName: values.table, region: values.region, endpoint: values.endpoint, env: {}, ...(credentials ? { credentials } : {}) });
  out(`${mode} on ${values.table}${pool ? ` and pool ${pool}` : ""} in ${values.region} ${where}${values.apply ? "" : " (dry run)"}`);
  try {
    const sources = pool ? { accounts: candidates((deps.listUsers ?? listUsers)(values.region, pool, credentials)) } : {};
    const report = await runBackfill(db, mode as BackfillMode, { apply: values.apply }, sources);
    for (const line of formatReport(report)) out(line);
    return 0;
  } catch (e) {
    // The SDK's error name and message: no item contents
    err(`Failed: ${(e as Error).name}: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
