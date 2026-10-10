// npm run backfill: one-off migrations of the app table (src/data/backfill.ts),
// for the owner to run after a deploy (docs/infrastructure.md, "Backfills").
// A dry run unless --apply is given. It prints counts, never emails, names or
// user IDs.
//
//   npm run backfill -- stray-ops-keys --table <table> --region <region> --profile <profile>
//   npm run backfill -- ops-index      --table <table> --region <region> --profile <profile> --apply
//   npm run backfill -- members        --table <table> --region <region> --profile <profile> --apply
//   npm run backfill -- notice-address --table <table> --region <region> --profile <profile> --apply
//   npm run backfill -- projects-rename --table <table> --region <region> --profile <profile> [--team <id>] [--reverse] [--limit <n>] [--export-to <path>] [--apply]
//
// notice-address lists the app user pool of the table's environment: its ID
// from SSM (/supply-checkout/<env>/identity/user-pool-id, the identity stack's
// output), and it refuses to go on unless that pool is in --region and
// Cognito names it supply-checkout-<env> (not the operator pool,
// supply-checkout-<env>-ops, or another environment's pool).
//
// --endpoint points it at DynamoDB Local instead (tests, local development).

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { createDb, type Db, type DbOptions } from "../src/data/index.js";
import { BACKFILL_MODES, type BackfillMode, type BackfillReport, type ExportedTeam, type NoticeAddressCandidate, type ProjectsRenameOptions, type ProjectsRenameReport, RENAME_MAX_ATTEMPTS, renameProjects, runBackfill } from "../src/data/backfill.js";
import { listPoolUsers, type PoolUser } from "../src/identity/cognito-admin.js";
import { noticeAddressOf } from "../src/identity/notice-address.js";
import { APP_TABLE, appPool, appPoolParameter, callerAccount, type Credentials, type FoundPool, opsPoolParameter, POOL_ID } from "./owner-aws.js";

export { APP_TABLE, appPoolParameter, type FoundPool, opsPoolParameter, POOL_ID };

export const USAGE = `Usage: npm run backfill -- <mode> --table supply-checkout-<env>-app --region <region> --profile <profile> [--apply]

Modes (run in this order after the deploy):
  stray-ops-keys  remove GSI3 keys from items that shouldn't have them
  ops-index       set GSI3 keys on team META items and owner MEMBER items made before the operators' index
  members         set the members count on team META items made before it existed

  notice-address  record the address an email change is told to, for every app pool user
                  whose verified address the API trusts and who has none (the table's env's app pool)

  projects-rename move SHEET# items to PROJECT# keys and rename sheetId on movements, then verify
                  (docs/infrastructure.md, "Projects rename"). Its options:
    --team <id>         one team (a Query); all teams (a key-only Scan) without it
    --reverse           PROJECT# back to SHEET#: the rollback
    --limit <n>         stop after n items (movements are left for a run without it)
    --export-to <path>  first write the team's SHEET#, PROJECT# and MOVE# items to a new file outside the repo
--expect-account <id> (any mode) stops before reading unless the profile signs in to that account.

Without --apply it's a dry run: it reads the table and writes nothing.
It prints the AWS account the profile signs in to before it reads or writes.
--endpoint <url> uses DynamoDB Local instead of AWS (then --profile isn't needed and any table name goes,
except for notice-address, which lists a real user pool and so needs --profile).`;

const RENAME = "projects-rename";
const MODES: readonly string[] = [...BACKFILL_MODES, RENAME];


export interface Deps {
  /** The account the credentials belong to (STS GetCallerIdentity). */
  readonly callerAccount: (region: string, credentials: Credentials) => Promise<string>;
  /** The table handle (createDb). */
  readonly connect: (options: DbOptions) => Db;
  /** The app pool's ID (from SSM) and the name Cognito gives it (DescribeUserPool); appPool below unless given. */
  readonly appPool?: (region: string, envName: string, credentials: Credentials | undefined) => Promise<FoundPool>;
  /** Every user in the pool (ListUsers); listUsers below unless given. */
  readonly listUsers?: (region: string, userPoolId: string, credentials: Credentials | undefined) => AsyncIterable<PoolUser>;
  /** projects-rename: its options beyond the CLI's (tests: no pauses, a short index wait). */
  readonly renameOptions?: Partial<ProjectsRenameOptions>;
  /** The git checkouts an export may not be written into; repoRoots below unless given. */
  readonly repoRoots?: () => string[];
}

/** A path as the filesystem spells it: symlinks resolved and, on a case-insensitive disk, its real case. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** The main checkout of the repo a folder is in (the parent of git's common dir), so a worktree's main checkout counts too. */
function mainCheckout(dir: string): string | undefined {
  // Without the variables that would point git at another repository than the folder's own
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"].includes(name)));
  const git = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf8", timeout: 5_000, env });
  const common = git.status === 0 ? git.stdout.trim() : "";
  return common ? dirname(common) : undefined;
}

/** The checkouts an export must stay out of: the current folder's and this script's, and their main checkouts. */
function repoRoots(): string[] {
  const dirs = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  return dirs.map(mainCheckout).filter((r): r is string => r !== undefined);
}

/**
 * Where an export may go: a new file, in a folder that exists, outside every
 * checkout (the file holds client names and prices, and the repo is public).
 * Refused under any of `roots`, and under any folder with a .git entry (a
 * checkout, or a worktree inside one), compared as the filesystem spells it.
 * Returns the resolved path, or why not.
 */
export function exportPath(path: string, roots: readonly string[]): { path: string } | { problem: string } {
  const absolute = resolve(path);
  let folder: string;
  try {
    folder = realpathSync.native(dirname(absolute));
  } catch {
    return { problem: `--export-to's folder doesn't exist: ${dirname(absolute)}` };
  }
  const target = join(folder, basename(absolute));
  const inside = (root: string) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
  const refused = (root: string) => ({ problem: `--export-to must be outside the repo (${root}): the export holds client names and prices` });
  for (const root of roots.map(canonical)) if (inside(root)) return refused(root);
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return refused(dir);
    if (dirname(dir) === dir) break;
  }
  if (existsSync(target)) return { problem: `--export-to names a file that exists; give a new one: ${target}` };
  return { path: target };
}

/** Sets and binary as JSON can't hold them, so the export keeps every attribute. */
function exportReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Set) return { $set: [...value] };
  if (value instanceof Uint8Array) return { $b64: Buffer.from(value).toString("base64") };
  return value;
}

/** Writes the export: owner-only, and never over an existing file. */
function writeExport(path: string, table: string, region: string, reverse: boolean) {
  return async (teams: readonly ExportedTeam[]) => {
    const body = { exportedAt: new Date().toISOString(), table, region, mode: RENAME, direction: reverse ? "reverse" : "forward", teams };
    writeFileSync(path, `${JSON.stringify(body, exportReplacer, 2)}\n`, { flag: "wx", mode: 0o600 });
  };
}

/** The projects-rename report: counts and check names only. */
export function formatRenameReport(r: ProjectsRenameReport): string[] {
  const wouldBe = r.apply ? "" : " (dry run: would be)";
  const lines = [`${r.from} to ${r.to}, teams: ${r.teams}`];
  if (r.teamMissing) lines.push("No team META item for --team: check the team ID");
  if (r.skippedTeams) lines.push(`Teams left alone (no META item, closed or being purged): ${r.skippedTeams}`);
  if (r.invalidTeams) lines.push(`Team partitions whose ID isn't a valid ID, left alone: ${r.invalidTeams}`);
  if (r.exported !== undefined) lines.push(`Exported ${r.exported} items to the file first`);
  lines.push(`Items under ${r.from}: ${r.found} (about ${r.bytes} bytes; the largest about ${r.largest})`);
  lines.push(`  moved: ${r.moved}${wouldBe}`);
  if (r.duplicates) lines.push(`  an equal ${r.to} copy already there, old item removed: ${r.duplicates}${wouldBe}`);
  if (r.conflicts) lines.push(`  conflicts: a different ${r.to} copy exists, both left alone: ${r.conflicts}`);
  if (r.gone) lines.push(`  gone before it was read, left alone: ${r.gone}`);
  if (r.failed) lines.push(`  still changing after ${RENAME_MAX_ATTEMPTS} tries, left alone: ${r.failed}`);
  if (r.retries) lines.push(`  retried after someone changed it: ${r.retries}`);
  if (r.invalid) lines.push(`  keys that aren't valid IDs, left alone: ${r.invalid}`);
  if (r.leftByLimit) lines.push(`  not read (--limit): ${r.leftByLimit}`);
  const m = r.movements;
  if (m.skipped) lines.push("Movements: left for a run without --limit");
  else {
    lines.push(`Movements with old attribute names: ${m.found}`);
    lines.push(`  renamed: ${m.renamed}${wouldBe}`);
    if (m.conflicts) lines.push(`  already have the new names too, left alone: ${m.conflicts}`);
    if (m.raced) lines.push(`  changed by something else first, left alone: ${m.raced}`);
  }
  if (!r.verification) {
    lines.push("Dry run: nothing was written. Run again with --apply to write.");
    return lines;
  }
  lines.push("Verification:");
  for (const c of r.verification.checks) lines.push(`  ${c.ok ? "ok" : "FAILED"}: ${c.check}`);
  lines.push(
    r.verification.ok && !r.conflicts && !r.failed && !r.leftByLimit && !r.invalid && !r.invalidTeams && !r.teamMissing && !r.skippedTeams
      ? "Done."
      : "Not done: see above. Run it again (it skips what's moved), or roll back with --reverse.",
  );
  return lines;
}

/** Every user in the app pool, with the profile's credentials (the owner's: no Lambda role may list the pool for this). */
const listUsers = (region: string, userPoolId: string, credentials: Credentials | undefined) =>
  listPoolUsers({ region, userPoolId, timeoutMs: 10_000, ...(credentials ? { credentials } : {}) });

const defaultDeps: Deps = {
  connect: createDb,
  callerAccount,
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
        apply: { type: "boolean", default: false },
        team: { type: "string" },
        reverse: { type: "boolean", default: false },
        limit: { type: "string" },
        "export-to": { type: "string" },
        "expect-account": { type: "string" },
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
  if (!MODES.includes(mode as string) || extra.length) {
    err(`${mode ? `Unknown mode: ${[mode, ...extra].join(" ")}` : "No mode given"}\n\n${USAGE}`);
    return 2;
  }
  if (!values.table || !values.region) {
    err(`--table and --region are required\n\n${USAGE}`);
    return 2;
  }
  const renameFlags = values.team !== undefined || values.reverse || values.limit !== undefined || values["export-to"] !== undefined;
  if (mode !== RENAME && renameFlags) {
    err(`--team, --reverse, --limit and --export-to are for ${RENAME} only\n\n${USAGE}`);
    return 2;
  }
  if (values.team !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(values.team)) {
    err(`--team must be a team ID\n\n${USAGE}`);
    return 2;
  }
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = /^[1-9]\d{0,8}$/.test(values.limit) ? Number(values.limit) : NaN;
    if (Number.isNaN(limit)) {
      err(`--limit must be a whole number from 1\n\n${USAGE}`);
      return 2;
    }
  }
  let exportFile: string | undefined;
  if (values["export-to"] !== undefined) {
    const found = exportPath(values["export-to"], (deps.repoRoots ?? repoRoots)());
    if ("problem" in found) {
      err(`${found.problem}\n\n${USAGE}`);
      return 2;
    }
    exportFile = found.path;
  }

  // notice-address finds its pool from the table's environment, so it needs an app table's name even with --endpoint
  const envName = APP_TABLE.exec(values.table)?.[1];
  if (mode === "notice-address" && !envName) {
    err(`--table must be an app table, supply-checkout-<env>-app, for notice-address: ${values.table}\n\n${USAGE}`);
    return 2;
  }
  // With --endpoint there's no profile and no account line, so the pool lookup and listing would
  // sign with whatever ambient credentials there are (a real pool) and send addresses to that
  // endpoint. Only tests, which stand in for both, may do it.
  if (mode === "notice-address" && values.endpoint && !(deps.appPool && deps.listUsers)) {
    err(`notice-address lists a real user pool, so it can't run against --endpoint; use --profile\n\n${USAGE}`);
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

  const expectAccount = values["expect-account"];
  if (expectAccount !== undefined && (!/^\d{12}$/.test(expectAccount) || values.endpoint)) {
    err(`--expect-account takes a 12-digit account ID, and needs --profile (not --endpoint)\n\n${USAGE}`);
    return 2;
  }

  const credentials = values.profile && !values.endpoint ? defaultProvider({ profile: values.profile }) : undefined;
  let where = `at ${values.endpoint}`;
  if (credentials) {
    try {
      // Before anything is read or written, so the owner sees which account this is
      const account = await deps.callerAccount(values.region, credentials);
      if (expectAccount !== undefined && account !== expectAccount) {
        err(`The profile signs in to account ${account}, not ${expectAccount} (--expect-account): nothing was read or written`);
        return 1;
      }
      where = `in account ${account} (profile ${values.profile})`;
    } catch (e) {
      err(`Failed to identify the profile's account: ${(e as Error).name}: ${(e as Error).message}`);
      return 1;
    }
  }
  let pool: string | undefined;
  if (mode === "notice-address" && envName) {
    // Before anything is read or written: the table's environment's app pool, in this region, and no other
    const expected = `supply-checkout-${envName}`;
    let found: FoundPool;
    try {
      found = await (deps.appPool ?? appPool)(values.region, envName, credentials);
    } catch (e) {
      err(`Failed to find the app pool (${appPoolParameter(envName)}): ${(e as Error).name}: ${(e as Error).message}`);
      return 1;
    }
    // Defence in depth: the name check below refuses the operator pool too, by its name
    if (found.name.endsWith("-ops") || (found.opsId !== "" && found.id === found.opsId)) {
      err(`${appPoolParameter(envName)} names the operator pool (${found.id}): nothing was read or written`);
      return 1;
    }
    const poolRegion = POOL_ID.exec(found.id)?.[1];
    if (!poolRegion || poolRegion !== values.region || found.name !== expected) {
      err(`${appPoolParameter(envName)} must name the pool ${expected} in ${values.region}, not ${found.name || "an unnamed pool"} (${found.id || "no ID"}): nothing was read or written`);
      return 1;
    }
    pool = found.id;
  }
  const db = deps.connect({ tableName: values.table, region: values.region, endpoint: values.endpoint, env: {}, ...(credentials ? { credentials } : {}) });
  out(`${mode} on ${values.table}${pool ? ` and pool ${pool}` : ""} in ${values.region} ${where}${values.apply ? "" : " (dry run)"}`);
  if (mode === RENAME) {
    try {
      const report = await renameProjects(db, {
        apply: values.apply,
        reverse: values.reverse,
        ...(values.team !== undefined ? { team: values.team } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(exportFile ? { exportTo: writeExport(exportFile, values.table, values.region, values.reverse) } : {}),
        ...deps.renameOptions,
      });
      const lines = formatRenameReport(report);
      for (const line of lines) out(line);
      // A failed check or anything left after an apply: non-zero, so a script running it stops
      return report.verification && lines.at(-1) !== "Done." ? 1 : 0;
    } catch (e) {
      err(`Failed: ${(e as Error).name}: ${(e as Error).message}`);
      return 1;
    }
  }
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
