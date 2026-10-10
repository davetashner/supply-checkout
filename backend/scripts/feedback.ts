// npm run feedback: triage the reports from the app's Report an issue form
// into beads (supply-checkout-bmsh.3; docs/infrastructure.md, "Triaging
// reports"). For the owner, with their own AWS credentials: no route or
// Lambda reaches reports for reading.
//
//   npm run feedback -- list    [--status new|triaged|dismissed] [--limit n] [--cursor c] <where>
//   npm run feedback -- show    [<teamId>] <reportId> [--team <teamId>] <where>
//   npm run feedback -- bead    [<teamId>] <reportId> --title "<scrubbed>" [--summary "<scrubbed>"] [--type bug|task|feature] [--priority 0-4] <where>
//   npm run feedback -- record  [<teamId>] <reportId> --bead <beadId> <where>
//   npm run feedback -- dismiss [<teamId>] <reportId> --reason "<short reason>" <where>
//
//   <where> = --table supply-checkout-<env>-app --region <region> --profile <profile> [--expect-account <id>]
//             (or --endpoint <url> for DynamoDB Local)
//
// A report is keyed by its team ID and full 32-character report ID. The
// 8-character short ID that `list` shows (and a bead's notes name) is for
// display: it's accepted for a report only when exactly one report has it
// (within --team or the team ID given), and an ambiguous one is refused with
// the candidates listed.
//
// Report text is shown on the terminal only (`list`, `show`). It is never
// written to a file, a bead or a log, and no error message contains it. A bead
// is made from a title and summary the owner scrubs and types: the CLI refuses
// to create one if they hold an email address, an AWS account ID, an SSO URL,
// anything scripts/check-public-safety.mjs would refuse, or the report's own
// words (docs: "Triaging reports").
//
// Not imported by any Lambda; src/data/feedback-owner.ts, which it uses, isn't
// exported from src/data/index.ts.

import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { ConflictError, createDb, type Db, type DbOptions, FEEDBACK_STATUSES, type FeedbackReport, type FeedbackStatus } from "../src/data/index.js";
import { DISMISS_REASON_MAX, dismissFeedback, getFeedback, listFeedback, recordFeedbackBead } from "../src/data/feedback-owner.js";
import { findUserBySub, type PoolUser } from "../src/identity/cognito-admin.js";
import { noticeAddressOf } from "../src/identity/notice-address.js";
import { publicSafetyFindings } from "../../scripts/public-safety-rules.mjs";
import { APP_TABLE, appPool, appPoolProblem, callerAccount, type Credentials, type FoundPool } from "./owner-aws.js";

export const USAGE = `Usage: npm run feedback -- <command> [arguments] --table supply-checkout-<env>-app --region <region> --profile <profile>

Commands:
  list [--status new|triaged|dismissed] [--limit n] [--cursor c]
        One line per report, oldest first: short ID, date, category, team ID, role, app build, the first 60 characters.
  show [<teamId>] <reportId> [--team <teamId>]
        The whole report. With "contact OK" ticked, also the user's verified email (looked up in the app pool).
  bead [<teamId>] <reportId> --title "<scrubbed title>" [--summary "<scrubbed text>"] [--type bug|task|feature] [--priority 0-4]
        Creates a bead (bd create) from text you wrote, then marks the report triaged with the bead's ID.
        Refused if the text has an email address, an AWS account ID, an SSO URL, anything check-public-safety refuses,
        or the report's own words. Already triaged: shows the bead and does nothing.
  record [<teamId>] <reportId> --bead <beadId>
        Marks a new report triaged with a bead you made yourself (or when "bead" made it but couldn't record it).
  dismiss [<teamId>] <reportId> --reason "<short reason, at most ${DISMISS_REASON_MAX} characters>"
        Marks a new report dismissed.

<reportId> is the 32-character ID, or the 8-character short ID when exactly one report has it.
--expect-account <id> stops before reading unless the profile signs in to that account.
--endpoint <url> uses DynamoDB Local instead of AWS (then --profile isn't needed and any table name goes;
the email lookup isn't available).`;

const COMMANDS = ["list", "show", "bead", "record", "dismiss"] as const;
type Command = (typeof COMMANDS)[number];

const TEAM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FULL_ID = /^[0-9a-f]{32}$/;
const SHORT_ID = /^[0-9a-f]{8}$/;
/** A bead of this project, as `bd` prints it. */
const BEAD_ID = /^supply-checkout-[a-z0-9.]+$/;
/** Where --endpoint may point: this machine, over http. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The longest bead title, and summary, the CLI takes, in characters. */
export const TITLE_MAX = 200;
export const SUMMARY_MAX = 1000;
const PREVIEW = 60;
/** A run of this many characters of the report in a bead's text is the report's own words. */
export const VERBATIM_RUN = 100;
/** A whole report at least this long, inside a bead's text, is the report's own words too (shorter ones only when the text equals them). */
const WHOLE_MESSAGE_MIN = 12;

const BEAD_TYPES = ["bug", "task", "feature"] as const;
type BeadType = (typeof BEAD_TYPES)[number];
const CATEGORY_TYPE: Readonly<Record<string, BeadType>> = { bug: "bug", idea: "feature", question: "task" };

/** What `bd create` is asked for. */
export interface BeadRequest {
  readonly title: string;
  readonly type: BeadType;
  readonly priority: number;
  readonly labels: readonly string[];
  readonly notes: string;
  readonly description: string;
}

export interface Deps {
  /** The account the credentials belong to (STS GetCallerIdentity); callerAccount unless given. */
  readonly callerAccount?: (region: string, credentials: Credentials) => Promise<string>;
  /** The table handle (createDb). */
  readonly connect?: (options: DbOptions) => Db;
  /** The app pool's ID (SSM) and Cognito's name for it; appPool unless given. */
  readonly appPool?: (region: string, envName: string, credentials: Credentials | undefined) => Promise<FoundPool>;
  /** The pool user with a sub; findUserBySub unless given. */
  readonly findUser?: (region: string, userPoolId: string, sub: string, credentials: Credentials | undefined) => Promise<PoolUser | undefined>;
  /** Creates the bead and returns its ID; `bd create` unless given. Throws a plain Error naming why. */
  readonly createBead?: (request: BeadRequest) => string;
  /** Runs `bd` with an argument array; spawnSync (no shell) unless given. For bd create and bd show. */
  readonly runBd?: (args: readonly string[]) => { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error?: Error };
  readonly now?: () => Date;
}

// ----- Refusing text that mustn't reach a bead -----

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const ACCOUNT_ID = /(?<![0-9])[0-9]{12}(?![0-9])/;
const SSO_URL = /awsapps\.com|identitycenter\.amazonaws\.com|\/start\/?#|sso\.[a-z0-9-]+\.amazonaws\.com/i;

/** `text` as the checks see it: NFKC-normalized (a fullwidth `＠` is `@`) and with format characters (zero-width, bidi) removed. */
export const scrub = (text: string) => text.normalize("NFKC").replace(/\p{Cf}/gu, "");

const HEX32 = /[0-9a-f]{32}/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Why `text` can't go into a public bead: names a rule, never the text. */
export function unsafeText(raw: string): string | undefined {
  const text = scrub(raw);
  // Any address, even ones check-public-safety allows (the product's own): a bead is no place for one
  if (EMAIL.test(text)) return "an email address";
  // Digits split by spaces, dots or hyphens count too
  if (ACCOUNT_ID.test(text) || ACCOUNT_ID.test(text.replace(/(?<=[0-9])[ .-](?=[0-9])/g, ""))) return "a 12-digit number (an AWS account ID?)";
  if (SSO_URL.test(text)) return "an SSO URL";
  if (HEX32.test(text) || UUID.test(text)) return "an ID (32 hex digits or a UUID)";
  const found = publicSafetyFindings(text)[0];
  if (found) return `something check-public-safety refuses (${found.name})`;
  return undefined;
}

/** Whether `text` names the report's team, user or report ID (any case). */
export function namesReportIds(text: string, report: Pick<FeedbackReport, "teamId" | "userId" | "reportId">): boolean {
  const lower = scrub(text).toLowerCase();
  return [report.teamId, report.userId, report.reportId].some((value) => value !== "" && lower.includes(value.toLowerCase()));
}

const normalize = (text: string) => scrub(text).toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Whether `text` holds the report's own words: equal to its message or
 * expected text, all of one of 12 or more characters (case and spacing
 * ignored), or a run of 100 characters. A guardrail against accident: a
 * paraphrase gets through.
 */
export function quotesReport(text: string, report: Pick<FeedbackReport, "message" | "expected">): boolean {
  const candidate = normalize(text);
  if (!candidate) return false;
  for (const source of [report.message, report.expected].map(normalize)) {
    if (!source) continue;
    if (candidate === source) return true;
    if (source.length >= WHOLE_MESSAGE_MIN && candidate.includes(source)) return true;
    for (let i = 0; i + VERBATIM_RUN <= candidate.length; i++) {
      if (source.includes(candidate.slice(i, i + VERBATIM_RUN))) return true;
    }
  }
  return false;
}

/** The title and summary as one text two ways (joined with a space and with nothing), so a quote can't be split across them. */
const joined = (title: string, summary: string) => (summary ? [`${title} ${summary}`, `${title}${summary}`] : []);

// ----- Output -----

/** `text` with each control character (and line or paragraph separator) a space; newlines kept only with `keepNewlines`. */
function clean(text: string, keepNewlines: boolean): string {
  return Array.from(text.replace(/\r\n?/g, "\n"), (ch) => {
    const c = ch.codePointAt(0) as number;
    const control = c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029;
    return control && !(keepNewlines && c === 0x0a) ? " " : ch;
  }).join("");
}

const oneLine = (text: string) => clean(text, false).replace(/\s+/g, " ").trim();
/** Text for the terminal with control characters (an escape sequence) removed, newlines kept. */
const forTerminal = (text: string) => clean(text, true);

function preview(text: string): string {
  const flat = oneLine(text);
  const chars = Array.from(flat);
  return chars.length > PREVIEW ? `${chars.slice(0, PREVIEW).join("")}…` : flat;
}

const shortOf = (r: Pick<FeedbackReport, "reportId" | "shortId">) => r.shortId || r.reportId.slice(0, 8);

export function listLine(r: FeedbackReport): string {
  return [shortOf(r), r.createdAt.slice(0, 10), r.category, r.teamId, r.role, r.context?.build ?? "-", preview(r.message)].join("  ");
}

export function showReport(r: FeedbackReport, email?: { readonly line: string }): string[] {
  const lines = [
    `Report ${r.reportId} (short ${shortOf(r)})`,
    `Team: ${r.teamId}`,
    `Status: ${r.status}${r.beadId ? ` (bead ${r.beadId})` : ""}${r.dismissReason ? ` (reason: ${oneLine(r.dismissReason)})` : ""}`,
    `Sent: ${r.createdAt}`,
    `Category: ${r.category}`,
    `Role: ${r.role}`,
    `App build: ${r.context?.build ?? "-"}  Screen: ${r.context?.screen ?? "-"}  Browser: ${r.context?.browser ?? "-"}`,
    `Contact OK: ${r.contactOk ? "yes" : "no"}`,
  ];
  if (r.contactOk && email) lines.push(email.line);
  lines.push("", "What happened:", forTerminal(r.message));
  if (r.expected) lines.push("", "What was expected:", forTerminal(r.expected));
  return lines;
}

// ----- bd -----

type RunBd = NonNullable<Deps["runBd"]>;
const spawnBd: RunBd = (args) => {
  const run = spawnSync("bd", [...args], { encoding: "utf8", timeout: 60_000, shell: false });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", ...(run.error ? { error: run.error } : {}) };
};

/**
 * The bead ID `bd create --silent` printed: its last non-empty line, which
 * must be a bead ID of this project. A warning line is never taken for one;
 * anything else is an error that shows what bd printed (no report text is in it).
 */
export function parseCreated(stdout: string): string {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  if (!BEAD_ID.test(last)) {
    throw new Error(`bd create printed something that isn't a bead ID, so nothing was recorded. A bead may have been made: check bd list. bd printed: ${oneLine(stdout).slice(0, 300)}`);
  }
  return last;
}

/** `bd create`, spawned with an argument array (no shell). Returns the new bead's ID. */
function bdCreate(request: BeadRequest, run: RunBd): string {
  const args = [
    "create",
    `--title=${request.title}`,
    `--type=${request.type}`,
    `--priority=${request.priority}`,
    `--labels=${request.labels.join(",")}`,
    `--notes=${request.notes}`,
    ...(request.description ? [`--description=${request.description}`] : []),
    "--silent",
  ];
  const done = run(args);
  if (done.error) throw new Error(`No bead was created: bd couldn't run: ${done.error.message}`);
  if (done.status !== 0) throw new Error(`No bead was created: bd create failed (exit ${done.status}): ${oneLine(done.stderr).slice(0, 300)}`);
  return parseCreated(done.stdout);
}

/** Whether `bd show <id> --json` finds exactly that bead. */
function beadExists(id: string, run: RunBd): boolean {
  const done = run(["show", id, "--json"]);
  if (done.error || done.status !== 0) return false;
  try {
    const parsed: unknown = JSON.parse(done.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.some((b) => typeof b === "object" && b !== null && (b as { id?: unknown }).id === id);
  } catch {
    return false;
  }
}

// ----- Finding a report -----

type Found = { readonly report: FeedbackReport } | { readonly problem: string; readonly candidates?: readonly FeedbackReport[] };

/** Every report, any status, across teams (the status index's three partitions, followed to the end). */
async function* allReports(db: Db): AsyncGenerator<FeedbackReport> {
  for (const status of FEEDBACK_STATUSES) {
    let cursor: string | undefined;
    do {
      const page = await listFeedback(db, { status, limit: 100, cursor });
      yield* page.items;
      cursor = page.cursor;
    } while (cursor);
  }
}

/**
 * The report `reportId` names, in `teamId` if given. A full ID with a team is
 * one read; otherwise the status index is searched, and a short ID that more
 * than one report has (or that no report has) is refused.
 */
export async function findReport(db: Db, teamId: string | undefined, reportId: string): Promise<Found> {
  if (teamId !== undefined && FULL_ID.test(reportId)) {
    const report = await getFeedback(db, teamId, reportId);
    return report ? { report } : { problem: "No such report" };
  }
  const matches: FeedbackReport[] = [];
  for await (const r of allReports(db)) {
    if (teamId !== undefined && r.teamId !== teamId) continue;
    if (FULL_ID.test(reportId) ? r.reportId === reportId : shortOf(r) === reportId) matches.push(r);
  }
  if (matches.length === 1) return { report: matches[0] as FeedbackReport };
  if (matches.length === 0) return { problem: "No such report" };
  return { problem: `${matches.length} reports have the short ID ${reportId}: give the team ID and the full report ID of one`, candidates: matches };
}

// ----- The CLI -----

function parseOptions(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      table: { type: "string" },
      region: { type: "string" },
      profile: { type: "string" },
      endpoint: { type: "string" },
      "expect-account": { type: "string" },
      status: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      team: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      type: { type: "string" },
      priority: { type: "string" },
      reason: { type: "string" },
      bead: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
}

/** The command's own words for how to run it again, for the failure that leaves a bead unrecorded. */
function recordCommand(values: Record<string, string | boolean | undefined>, teamId: string, reportId: string, beadId: string): string {
  const where = values.endpoint ? `--table ${values.table} --region ${values.region} --endpoint ${values.endpoint}` : `--table ${values.table} --region ${values.region} --profile ${values.profile}`;
  return `npm run feedback -- record ${teamId} ${reportId} --bead ${beadId} ${where}`;
}

/** Runs the CLI. Returns the exit code: 0 done, 1 failed, 2 bad arguments. */
export async function main(
  argv: string[],
  out: (line: string) => void = console.log,
  err: (line: string) => void = console.error,
  deps: Deps = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseOptions(argv);
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
  const [command, ...args] = positionals;
  if (!COMMANDS.includes(command as Command)) return bad(command ? `Unknown command: ${command}` : "No command given");
  const cmd = command as Command;

  // The report named by the arguments: [<teamId>] <reportId>
  let teamId = values.team;
  let reportId: string | undefined;
  if (cmd === "list") {
    if (args.length) return bad("list takes no arguments");
  } else {
    if (args.length < 1 || args.length > 2) return bad(`${cmd} takes [<teamId>] <reportId>`);
    if (args.length === 2) {
      if (values.team !== undefined && values.team !== args[0]) return bad("--team names another team than the team ID given");
      teamId = args[0];
    }
    reportId = args.at(-1);
    if (teamId !== undefined && !TEAM_ID.test(teamId)) return bad("The team ID isn't a team ID");
    if (!reportId || !(FULL_ID.test(reportId) || SHORT_ID.test(reportId))) return bad("The report ID must be the 32-character ID, or the 8-character short ID");
  }

  // Options for each command
  const only = (names: string[], allowed: string[]) => names.find((n) => !allowed.includes(n) && (values as Record<string, unknown>)[n] !== undefined);
  const OWN: Record<Command, string[]> = {
    list: ["status", "limit", "cursor"],
    show: ["team"],
    bead: ["team", "title", "summary", "type", "priority"],
    record: ["team", "bead"],
    dismiss: ["team", "reason"],
  };
  const stray = only(["status", "limit", "cursor", "team", "title", "summary", "type", "priority", "reason", "bead"], OWN[cmd]);
  if (stray) return bad(`--${stray} isn't an option of ${cmd}`);

  let status: FeedbackStatus = "new";
  let limit: number | undefined;
  if (cmd === "list") {
    if (values.status !== undefined) {
      if (!(FEEDBACK_STATUSES as readonly string[]).includes(values.status)) return bad("--status must be new, triaged or dismissed");
      status = values.status as FeedbackStatus;
    }
    limit = 25;
    if (values.limit !== undefined) {
      limit = /^[1-9]\d{0,2}$/.test(values.limit) ? Number(values.limit) : NaN;
      if (Number.isNaN(limit) || limit > 100) return bad("--limit must be a whole number from 1 to 100");
    }
  }

  // bead: the text, checked before anything is read, and again against the report
  let title = "";
  let summary = "";
  let beadType: BeadType | undefined;
  let priority = 2;
  if (cmd === "bead") {
    title = oneLine(scrub(values.title ?? ""));
    summary = clean(scrub(values.summary ?? ""), true).trim();
    if (!title) return bad("--title is required");
    if (Array.from(title).length > TITLE_MAX) return bad(`--title can be at most ${TITLE_MAX} characters`);
    if (Array.from(summary).length > SUMMARY_MAX) return bad(`--summary can be at most ${SUMMARY_MAX} characters`);
    if (values.type !== undefined) {
      if (!(BEAD_TYPES as readonly string[]).includes(values.type)) return bad("--type must be bug, task or feature");
      beadType = values.type as BeadType;
    }
    if (values.priority !== undefined) {
      if (!/^[0-4]$/.test(values.priority)) return bad("--priority must be 0 to 4");
      priority = Number(values.priority);
    }
    for (const [name, texts] of [["--title", [title]], ["--summary", [summary]], ["--title and --summary together", joined(title, summary)]] as const) {
      const why = texts.map(unsafeText).find((w) => w !== undefined);
      if (why) return bad(`Refused: ${name} has ${why}. Nothing was read, created or changed.`);
    }
  }
  let beadId = "";
  if (cmd === "record") {
    if (!values.bead || !BEAD_ID.test(values.bead)) return bad("--bead must be a bead ID of this project (supply-checkout-...)");
    beadId = values.bead;
    if (!beadExists(beadId, deps.runBd ?? spawnBd)) {
      err(`Refused: bd can't show a bead ${beadId}: nothing was read or changed`);
      return 1;
    }
  }
  let reason = "";
  if (cmd === "dismiss") {
    reason = oneLine(scrub(values.reason ?? ""));
    if (!reason) return bad("--reason is required");
    if (Array.from(reason).length > DISMISS_REASON_MAX) return bad(`--reason can be at most ${DISMISS_REASON_MAX} characters`);
    const why = unsafeText(reason);
    if (why) return bad(`Refused: --reason has ${why}. Nothing was read or changed.`);
  }

  // Where
  if (!values.table || !values.region) return bad("--table and --region are required");
  if (values.endpoint !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(values.endpoint);
    } catch {
      url = undefined;
    }
    if (!url || url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname) || url.username || url.password) {
      return bad("--endpoint must be an http URL on localhost, 127.0.0.1 or [::1]");
    }
  }
  if (!values.endpoint && !values.profile) return bad("--profile is required (or --endpoint for DynamoDB Local)");
  if (!values.endpoint && !APP_TABLE.test(values.table)) return bad(`--table must be an app table, supply-checkout-<env>-app: ${values.table}`);
  const expectAccount = values["expect-account"];
  if (expectAccount !== undefined && (!/^\d{12}$/.test(expectAccount) || values.endpoint)) return bad("--expect-account takes a 12-digit account ID, and needs --profile (not --endpoint)");
  const region = values.region;
  const table = values.table;

  const credentials = values.profile && !values.endpoint ? defaultProvider({ profile: values.profile }) : undefined;
  let where = `at ${values.endpoint}`;
  if (credentials) {
    try {
      // Before anything is read or written, so the owner sees which account this is
      const account = await (deps.callerAccount ?? callerAccount)(region, credentials);
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
  const db = (deps.connect ?? createDb)({ tableName: table, region, endpoint: values.endpoint, env: {}, ...(credentials ? { credentials } : {}) });
  out(`feedback ${cmd} on ${table} in ${region} ${where}`);

  try {
    if (cmd === "list") {
      const page = await listFeedback(db, { status, limit, cursor: values.cursor });
      for (const r of page.items) out(listLine(r));
      out(`${page.items.length} ${status} report${page.items.length === 1 ? "" : "s"}, oldest first`);
      if (page.cursor) out(`More: --cursor ${page.cursor}`);
      return 0;
    }

    const found = await findReport(db, teamId, reportId as string);
    if ("problem" in found) {
      err(found.problem);
      for (const c of found.candidates ?? []) err(`  ${shortOf(c)}  ${c.createdAt.slice(0, 10)}  ${c.category}  ${c.status}  team ${c.teamId}  report ${c.reportId}`);
      return 1;
    }
    const report = found.report;

    if (cmd === "show") {
      let email: { line: string } | undefined;
      if (report.contactOk) email = { line: await emailLine(report, table, region, values.endpoint, credentials, deps) };
      for (const line of showReport(report, email)) out(line);
      return 0;
    }

    if (cmd === "bead") {
      if (report.status === "triaged") {
        out(`Report ${shortOf(report)} is already triaged: bead ${report.beadId}. Nothing was done.`);
        return 0;
      }
      if (report.status !== "new") {
        err(`Report ${shortOf(report)} is ${report.status}, not new: no bead was created`);
        return 1;
      }
      for (const [name, texts] of [["--title", [title]], ["--summary", [summary]], ["--title and --summary together", joined(title, summary)]] as const) {
        if (texts.some((text) => quotesReport(text, report))) {
          err(`Refused: ${name} holds the report's own words. Write it in your own words. No bead was created.`);
          return 1;
        }
      }
      if (namesReportIds(`${title}\n${summary}`, report)) {
        err("Refused: the text names the report's team, user or report ID. No bead was created.");
        return 1;
      }
      const type = beadType ?? CATEGORY_TYPE[report.category] ?? "task";
      const label = CATEGORY_TYPE[report.category] ?? "task";
      let id: string;
      try {
        const request = { title, type, priority, labels: [label, "client"], notes: `Report ${shortOf(report)}`, description: summary };
        id = deps.createBead ? deps.createBead(request) : bdCreate(request, deps.runBd ?? spawnBd);
      } catch (e) {
        err((e as Error).message);
        return 1;
      }
      try {
        await recordFeedbackBead(db, report.teamId, report.reportId, id, (deps.now ?? (() => new Date()))());
      } catch (e) {
        if (e instanceof ConflictError) {
          // Someone triaged or dismissed it between our read and the write: the retry would fail the same way
          const now = await getFeedback(db, report.teamId, report.reportId).catch(() => undefined);
          err(
            now?.status === "triaged" && now.beadId
              ? `Report ${shortOf(report)} is already triaged with bead ${now.beadId}; bead ${id} you just made is a duplicate: close it.`
              : `Report ${shortOf(report)} is ${now?.status ?? "no longer new"} now; bead ${id} you just made isn't linked to it: close it, or link it with the record command if it's still wanted.`,
          );
          return 1;
        }
        err(`Bead ${id} was created, but the report wasn't marked triaged (${(e as Error).name}). Record it with:`);
        err(`  ${recordCommand(values, report.teamId, report.reportId, id)}`);
        return 1;
      }
      out(`Created bead ${id} for report ${shortOf(report)}; the report is triaged.`);
      return 0;
    }

    if (cmd === "record") {
      const done = await recordFeedbackBead(db, report.teamId, report.reportId, beadId, (deps.now ?? (() => new Date()))());
      out(`Report ${shortOf(done)} is triaged with bead ${done.beadId}.`);
      return 0;
    }

    // dismiss: the reason is the owner's, kept on the report; it must not quote the report either
    if (quotesReport(reason, report) || namesReportIds(reason, report)) {
      err("Refused: --reason holds the report's own words or IDs. Nothing was changed.");
      return 1;
    }
    const done = await dismissFeedback(db, report.teamId, report.reportId, { reason, at: (deps.now ?? (() => new Date()))() });
    out(`Report ${shortOf(done)} is dismissed.`);
    return 0;
  } catch (e) {
    // Our own errors and the SDK's: names and messages that never hold a report's text
    err(`Failed: ${(e as Error).name}: ${(e as Error).message}`);
    return 1;
  }
}

/** The "Email:" line of `show` for a report with contact OK: the user's verified address, or why not and the user ID. */
async function emailLine(
  report: FeedbackReport,
  table: string,
  region: string,
  endpoint: string | undefined,
  credentials: Credentials | undefined,
  deps: Deps,
): Promise<string> {
  const byHand = `User ID: ${report.userId} (look them up in the app user pool)`;
  const envName = APP_TABLE.exec(table)?.[1];
  // With --endpoint there's no profile, so a lookup would sign with whatever ambient credentials there are
  if (endpoint && !(deps.appPool && deps.findUser)) return `Email: not looked up with --endpoint. ${byHand}`;
  if (!envName) return `Email: not looked up (the table isn't an app table). ${byHand}`;
  try {
    const found = await (deps.appPool ?? appPool)(region, envName, credentials);
    const problem = appPoolProblem(found, envName, region);
    if (problem) return `Email: not looked up (${problem}). ${byHand}`;
    const user = await (deps.findUser ?? ((r, pool, sub, c) => findUserBySub({ region: r, userPoolId: pool, sub, timeoutMs: 10_000, ...(c ? { credentials: c } : {}) })))(region, found.id, report.userId, credentials);
    const address = user ? noticeAddressOf(user.username, user.attributes)?.address : undefined;
    if (!user) return `Email: no such user in the app pool (the account may be deleted). ${byHand}`;
    if (!address) return `Email: the account has no verified address the API trusts. ${byHand}`;
    return `Email (verified): ${address}`;
  } catch (e) {
    return `Email: lookup failed (${(e as Error).message}). ${byHand}`;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
