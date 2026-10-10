// The owner's side of reports (supply-checkout-bmsh.3): list, read, link to a
// bead and dismiss. One implementation for two callers:
//
// - `npm run feedback` (scripts/feedback.ts), with the owner's own AWS
//   credentials, which calls these functions directly;
// - the operator page's /ops/feedback routes (supply-checkout-3sv.26), through
//   feedback-ops.ts, which audits each call and runs it on the
//   operator-access role. That role may read only FEEDBACK_READ_ATTRIBUTES of
//   reports and update only FEEDBACK_STATUS_ATTRIBUTES, so every read here
//   names its attributes (a projection) and no update asks for the item back.
//
// Not exported from index.ts: only feedback-ops.ts imports it among the
// Lambda sources (test/feedback-owner.test.ts checks). None of it takes a
// TeamContext: a report is keyed by team ID plus its full report ID, never by
// its 8-character short ID (that is display only).
//
// A report moves once: `new` to `triaged` (with its bead) or to `dismissed`.
// Both updates carry a status precondition, so dismissing a triaged report
// can't clear its bead and triaging again can't replace it. A repeat of the
// same change (the same bead, or dismissing a dismissed report) answers with
// the report as it is, so a retry after a lost answer is safe; anything else
// is a ConflictError naming the status, never the report's text.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, InvalidInputError, NotFoundError } from "./errors.js";
import { FEEDBACK_STATUSES, type FeedbackReport, type FeedbackStatus } from "./feedback.js";
import { feedbackStatusPartition, keys } from "./keys.js";
import { type Page, queryPage } from "./query.js";
import { FEEDBACK_READ_ATTRIBUTES, GSI1, GSI1PK, GSI1SK, PK, SK } from "./schema.js";

/** A bead ID of this project, as `bd` names them (`supply-checkout-3sv.26`): what a report may be triaged into. */
export const BEAD_ID = /^supply-checkout-[a-z0-9.]{1,48}$/;

/** The report's own attributes, without its keys: what every read names (the operator-access role requires a projection). */
const REPORT_ATTRIBUTES = FEEDBACK_READ_ATTRIBUTES.filter((name) => name !== PK && name !== SK && name !== GSI1PK && name !== GSI1SK);
const projection = {
  ProjectionExpression: REPORT_ATTRIBUTES.map((_, i) => `#r${i}`).join(", "),
  ExpressionAttributeNames: Object.fromEntries(REPORT_ATTRIBUTES.map((name, i) => [`#r${i}`, name])),
};

/**
 * One page of the reports in `status` (default `new`), across every team,
 * oldest first, from GSI1's `FEEDBACK#STATUS#<status>` partition. The
 * report's attributes come back (FEEDBACK_READ_ATTRIBUTES), the text
 * included, and never an email (none is stored). `limit` is the page size, 1 to 100; follow `cursor` for the rest.
 */
export async function listFeedback(db: Db, options: { readonly status?: FeedbackStatus; readonly limit?: number; readonly cursor?: string } = {}): Promise<Page<FeedbackReport>> {
  const status = options.status ?? "new";
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) throw new InvalidInputError("Invalid report status");
  const limit = options.limit;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new InvalidInputError("Invalid limit");
  const pk = feedbackStatusPartition(status);
  return queryPage<FeedbackReport>(
    db,
    {
      IndexName: GSI1,
      KeyConditionExpression: `${GSI1PK} = :pk`,
      Select: "SPECIFIC_ATTRIBUTES",
      ...projection,
      ExpressionAttributeValues: { ":pk": pk },
      Limit: limit,
    },
    { attribute: GSI1PK, value: pk },
    options.cursor,
  );
}

/** One report by team and full report ID, or undefined. A consistent read. */
export async function getFeedback(db: Db, teamId: string, reportId: string): Promise<FeedbackReport | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.feedback(teamId, reportId), ConsistentRead: true, ...projection }));
  return Item?.type === "feedback" ? (stripReport(Item) as unknown as FeedbackReport) : undefined;
}

function stripReport(item: Record<string, unknown>): Record<string, unknown> {
  const { PK: _pk, SK: _sk, GSI1PK: _gpk, GSI1SK: _gsk, ...rest } = item;
  void _pk; void _sk; void _gpk; void _gsk;
  return rest;
}

/** One status change, as an UpdateItem's parts: the CLI sends it alone, the ops routes in a transaction with their audit. */
export interface FeedbackStatusUpdate {
  readonly Key: Record<string, string>;
  readonly UpdateExpression: string;
  readonly ConditionExpression: string;
  readonly ExpressionAttributeNames: Record<string, string>;
  readonly ExpressionAttributeValues: Record<string, unknown>;
}

/** What a status change asks for: `triaged` with its bead, or `dismissed` with an optional reason. */
export interface FeedbackStatusChange {
  readonly status: "triaged" | "dismissed";
  readonly beadId: string;
  readonly reason: string;
}

/**
 * Applies `update`: true if it was applied, false if its condition failed.
 * The CLI's sends it on its own; feedback-ops.ts sends it with its audit.
 */
export type ApplyFeedbackUpdate = (update: FeedbackStatusUpdate) => Promise<boolean>;

const applyAlone =
  (db: Db): ApplyFeedbackUpdate =>
  async (update) => {
    try {
      // Nothing asked back: the operator-access role may name only the status attributes
      await connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, ...update, ReturnValues: "NONE" }));
      return true;
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  };

/** The bead ID, checked: InvalidInputError unless it's a bead ID. */
export function feedbackBeadId(value: unknown): string {
  if (typeof value !== "string" || !BEAD_ID.test(value)) throw new InvalidInputError("Invalid bead ID");
  return value;
}

/** A dismissal's reason, checked: at most DISMISS_REASON_MAX characters on one line, or empty. */
export function feedbackDismissReason(value: unknown): string {
  const reason = value ?? "";
  if (typeof reason !== "string" || Array.from(reason).length > DISMISS_REASON_MAX || Array.from(reason).some((ch) => (ch.codePointAt(0) as number) < 0x20 || ch === "\u007f")) throw new InvalidInputError("Invalid reason");
  return reason;
}

/**
 * Moves a `new` report to `change.status`, setting `beadId`, and the status
 * index partition with it, on the condition that it's still `new`. Then reads
 * it back. `replayed` when it was already in exactly the state asked for (a
 * repeat), in which case nothing was changed. NotFoundError if there's no
 * such report; ConflictError if it's no longer new for another change.
 */
export async function changeFeedbackStatus(
  db: Db,
  teamId: string,
  reportId: string,
  change: FeedbackStatusChange,
  at: Date,
  apply: ApplyFeedbackUpdate = applyAlone(db),
): Promise<{ readonly report: FeedbackReport; readonly replayed: boolean }> {
  const { status, beadId, reason } = change;
  const applied = await apply({
    Key: keys.feedback(teamId, reportId),
    UpdateExpression: `SET #status = :status, #bead = :bead, #at = :at, #gsi1pk = :partition${reason ? ", #reason = :reason" : ""}`,
    ConditionExpression: "attribute_exists(#pk) AND #type = :feedback AND #status = :from",
    ExpressionAttributeNames: { "#pk": PK, "#status": "status", "#type": "type", "#bead": "beadId", "#at": "statusAt", "#gsi1pk": GSI1PK, ...(reason ? { "#reason": "dismissReason" } : {}) },
    ExpressionAttributeValues: { ":status": status, ":bead": beadId, ":at": at.toISOString(), ":partition": feedbackStatusPartition(status), ":feedback": "feedback", ":from": "new", ...(reason ? { ":reason": reason } : {}) },
  });
  const current = await getFeedback(db, teamId, reportId);
  if (!current) throw new NotFoundError("No such report");
  if (applied) return { report: current, replayed: false };
  if (current.status === status && current.beadId === beadId) return { report: current, replayed: true };
  throw new ConflictError(`This report is already ${current.status}${current.beadId ? ` (bead ${current.beadId})` : ""}`);
}

/** Records the bead a `new` report became: `triaged`, with `beadId`. */
export async function recordFeedbackBead(db: Db, teamId: string, reportId: string, beadId: string, at = new Date()): Promise<FeedbackReport> {
  const bead = feedbackBeadId(beadId);
  return (await changeFeedbackStatus(db, teamId, reportId, { status: "triaged", beadId: bead, reason: "" }, at)).report;
}

/** The longest reason a dismissal keeps, in characters. */
export const DISMISS_REASON_MAX = 200;

/**
 * Dismisses a `new` report: `dismissed`, no bead, with the owner's short
 * `reason` kept as `dismissReason` (never the user's text: the CLI refuses a
 * reason that quotes the report, and so does the ops route, with
 * dismissReasonProblem).
 */
export async function dismissFeedback(db: Db, teamId: string, reportId: string, options: { readonly reason?: string; readonly at?: Date } = {}): Promise<FeedbackReport> {
  const reason = feedbackDismissReason(options.reason);
  return (await changeFeedbackStatus(db, teamId, reportId, { status: "dismissed", beadId: "", reason }, options.at ?? new Date())).report;
}

// ----- The report's own words, which a dismissal's reason must not hold -----

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
/** A run this long from the report counts as quoting it. */
export const VERBATIM_RUN = 100;
/** A whole message (or expected text) this long or longer, found anywhere, counts as quoting it. */
const WHOLE_MESSAGE_MIN = 12;

/** `text` as the checks see it: NFKC-normalized (a fullwidth `＠` is `@`) and with format characters (zero-width, bidi) removed. */
export const scrub = (text: string) => text.normalize("NFKC").replace(/\p{Cf}/gu, "");

const normalize = (text: string) => scrub(text).toLowerCase().replace(/\s+/g, " ").trim();

/** Whether `text` has an email address (after scrub). */
export const hasEmail = (text: string) => EMAIL.test(scrub(text));

/** Whether `text` names the report's team, user or report ID (any case). */
export function namesReportIds(text: string, report: Pick<FeedbackReport, "teamId" | "userId" | "reportId">): boolean {
  const lower = scrub(text).toLowerCase();
  return [report.teamId, report.userId, report.reportId].some((value) => value !== "" && lower.includes(value.toLowerCase()));
}

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

/**
 * Why a dismissal's `reason` can't be kept on `report`, or undefined: it
 * holds an email address, the report's own words or its IDs. The reason is the
 * operator's, never the user's. Names a rule, never the text.
 */
export function dismissReasonProblem(reason: string, report: Pick<FeedbackReport, "message" | "expected" | "teamId" | "userId" | "reportId">): string | undefined {
  if (hasEmail(reason)) return "The reason can't hold an email address";
  if (quotesReport(reason, report) || namesReportIds(reason, report)) return "The reason can't hold the report's own words or IDs";
  return undefined;
}
