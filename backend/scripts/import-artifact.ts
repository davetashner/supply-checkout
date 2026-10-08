// npm run import-artifact: the one-time import of a claude.ai artifact's data
// into a team (src/data/artifact-import.ts; docs/backend.md, "Importing
// artifact data"). For the owner to run, never a Lambda. A dry run unless
// --apply is given. It prints counts, sums, product keys and project IDs: never
// names, clients, emails or user IDs.
//
//   npm run import-artifact -- --file export.json --team <teamId> --owner <userId> \
//     --table supply-checkout-prod-app --region <region> --profile supply-prod [--apply]
//
// --endpoint points it at DynamoDB Local instead (tests, local development).

import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { authorizeTeam, createDb, type Db, type DbOptions } from "../src/data/index.js";
import {
  applyArtifactImport,
  type ImportIssue,
  MAX_EXPORT_BYTES,
  MAX_ISSUES,
  parseArtifactExport,
  planArtifactImport,
  verifyArtifactImport,
} from "../src/data/artifact-import.js";

export const USAGE = `Usage: npm run import-artifact -- --file <export.json> --team <teamId> --owner <userId>
         --table supply-checkout-<env>-app --region <region> --profile <profile> [--apply]

Imports a claude.ai artifact's "Everything (JSON)" export (Export in the artifact) into a team:
its items (with their stock counts) and its projects, with the same keys and IDs.
--owner is the user ID of one of the team's owners (npm run ops -- team <teamId> lists them);
the import runs as them and is refused unless they are an owner and the team is open.

Without --apply it's a dry run: it checks the whole file and the team, and writes nothing.
Run it again after it stops part-way: it skips what's already there and finishes the rest.
It prints the AWS account the profile signs in to before it reads or writes, and refuses to go on
if SUPPLY_CHECKOUT_EXPECTED_ACCOUNT is set (in your shell, never committed) to another account.
--endpoint <url> uses DynamoDB Local instead of AWS (then --profile isn't needed and any table name goes).`;

/** An app table's name (tableName in src/data/schema.ts), so a typo can't point the import at another table. */
export const APP_TABLE = /^supply-checkout-[a-z0-9-]+-app$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

type Credentials = ReturnType<typeof defaultProvider>;

export interface Deps {
  /** The account the credentials belong to (STS GetCallerIdentity). */
  readonly callerAccount: (region: string, credentials: Credentials) => Promise<string>;
  /** The table handle (createDb). */
  readonly connect: (options: DbOptions) => Db;
  /** The export file's text. */
  readonly readExport: (path: string) => Promise<string>;
}

/** The export's text. One open file, sized before it's read: a huge file is refused without loading it. */
export async function readExportFile(path: string, maxBytes = MAX_EXPORT_BYTES): Promise<string> {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > maxBytes) throw new Error(`The file is larger than ${maxBytes / 1_000_000} MB`);
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

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
  readExport: readExportFile,
};

const dollars = (c: number) => (c / 100).toFixed(2);

function issues(title: string, list: readonly ImportIssue[], out: (line: string) => void): void {
  out(`${title}: ${list.length}`);
  for (const issue of list.slice(0, MAX_ISSUES)) out(`  ${issue.at}: ${issue.message}`);
  if (list.length > MAX_ISSUES) out(`  … and ${list.length - MAX_ISSUES} more`);
}

/** Runs the CLI. Returns the exit code: 0 done (or a clean dry run), 1 failed or refused, 2 bad arguments. */
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
      options: {
        file: { type: "string" },
        team: { type: "string" },
        owner: { type: "string" },
        table: { type: "string" },
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
  const { values } = parsed;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  if (!values.file || !values.team || !values.owner || !values.table || !values.region) {
    err(`--file, --team, --owner, --table and --region are required\n\n${USAGE}`);
    return 2;
  }
  if (!ID.test(values.team) || !ID.test(values.owner)) {
    err(`--team and --owner must be IDs (letters, digits, _ and -)\n\n${USAGE}`);
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

  // The file first: a bad file needs no AWS session
  let parsedExport;
  try {
    parsedExport = parseArtifactExport(await deps.readExport(values.file));
  } catch (e) {
    err(`Can't read the export: ${(e as Error).message}`);
    return 1;
  }

  const credentials = values.profile && !values.endpoint ? defaultProvider({ profile: values.profile }) : undefined;
  let where = `at ${values.endpoint}`;
  if (credentials) {
    let account: string;
    try {
      account = await deps.callerAccount(values.region, credentials);
    } catch (e) {
      err(`Failed to identify the profile's account: ${(e as Error).name}: ${(e as Error).message}`);
      return 1;
    }
    const expected = env.SUPPLY_CHECKOUT_EXPECTED_ACCOUNT;
    if (expected && expected !== account) {
      err(`The profile signs in to account ${account}, not SUPPLY_CHECKOUT_EXPECTED_ACCOUNT (${expected}). Nothing was read or written.`);
      return 1;
    }
    where = `in account ${account} (profile ${values.profile})`;
  }
  const db = deps.connect({ tableName: values.table, region: values.region, endpoint: values.endpoint, env: {}, ...(credentials ? { credentials } : {}) });
  out(`import into team ${values.team} on ${values.table} in ${values.region} ${where}${values.apply ? "" : " (dry run)"}`);

  const p = parsedExport;
  const stock = p.products.reduce((sum, x) => sum + (x.stock ?? 0), 0);
  const charge = [...p.totals.values()].reduce((sum, t) => sum + t.chargeCents, 0);
  out(`Export${p.exportedAt ? ` of ${p.exportedAt}` : ""}: ${p.products.length} items (${p.products.filter((x) => x.stock !== undefined).length} counted, ${stock} eaches in storage), ${p.projects.length} projects (charges ${dollars(charge)})`);
  if (p.projectsWithoutTotals) out(`  projects without exported totals (only their lines were checked): ${p.projectsWithoutTotals}`);
  if (p.droppedCreatedBy) out(`  projects whose claude.ai user ID is replaced by the name the artifact showed: ${p.droppedCreatedBy}`);
  if (p.droppedTakenBy) out(`  equipment lines whose taker (a claude.ai user ID) is left out, keeping when it was taken: ${p.droppedTakenBy}`);
  if (p.droppedPriceSetBy) out(`  lines bought for the client whose price typer (a claude.ai user ID) is left out, keeping when it was typed: ${p.droppedPriceSetBy}`);
  const ignored = Object.entries(p.ignoredFields);
  if (ignored.length) out(`  fields left out: ${ignored.map(([f, n]) => `${f} (${n})`).join(", ")}`);
  if (p.warnings.length) issues("Warnings (imported as they are)", p.warnings, out);
  if (p.errors.length) {
    issues("Problems in the export", p.errors, err);
    err("Nothing was written. Fix these in the artifact, export again, and run the import again.");
    return 1;
  }

  try {
    const ctx = await authorizeTeam(db, values.owner, values.team);
    const plan = await planArtifactImport(db, ctx, p);
    out(`Items: ${plan.products.length} to add, ${plan.productsPresent} already in the team`);
    out(`Projects: ${plan.projects.length} to add, ${plan.projectsPresent} already in the team`);
    if (plan.conflicts.length) {
      issues("Conflicts with the team's data", plan.conflicts, err);
      err("Nothing was written. These items or projects are in the team already with other values.");
      return 1;
    }
    if (!values.apply) {
      out("Dry run: nothing was written. Run again with --apply to import.");
      return 0;
    }
    const result = await applyArtifactImport(db, ctx, plan);
    out(`Added ${result.productsCreated} items (${result.movements} stock counts recorded as import movements, operation ${result.operationId}) and ${result.projectsCreated} projects`);
    if (result.alreadyThere) out(`  added by another run first, with the same values: ${result.alreadyThere}`);
    if (result.adhocOpen) out(`The open General Use project is ${result.adhocOpen}: quick takes go on it`);
    const check = await verifyArtifactImport(db, ctx, p);
    out(`Stock: ${check.stockAfter} eaches in the team for the ${check.productsChecked} items, ${check.stockBefore} in the export`);
    out(`Project charges: ${dollars(check.chargeAfterCents)} in the team for the ${check.projectsChecked} projects, ${dollars(check.chargeBeforeCents)} in the export`);
    if (check.mismatches.length) {
      issues("Differences after the import", check.mismatches, err);
      return 1;
    }
    out("Done: every stock count and project total matches the export.");
    return 0;
  } catch (e) {
    // Error names and the data layer's messages (keys and IDs at most): no item contents
    err(`Failed: ${(e as Error).name}: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
