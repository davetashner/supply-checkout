// The owner's side of reports (supply-checkout-bmsh.3): list, read, link to a
// bead and dismiss, for `npm run feedback` (scripts/feedback.ts) and the
// owner's own AWS credentials only. Not exported from index.ts, so no Lambda
// bundle imports it (test/feedback-owner.test.ts checks), and none of it takes
// a TeamContext: a report is keyed by team ID plus its full report ID, never
// by its 8-character short ID (that is display only).
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
import { GSI1, GSI1PK } from "./schema.js";

const BEAD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * One page of the reports in `status` (default `new`), across every team,
 * oldest first, from GSI1's `FEEDBACK#STATUS#<status>` partition. Every
 * attribute comes back, the text included, and never an email (none is
 * stored). `limit` is the page size, 1 to 100; follow `cursor` for the rest.
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
      ExpressionAttributeValues: { ":pk": pk },
      Limit: limit,
    },
    { attribute: GSI1PK, value: pk },
    options.cursor,
  );
}

/** One report by team and full report ID, or undefined. A consistent read. */
export async function getFeedback(db: Db, teamId: string, reportId: string): Promise<FeedbackReport | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.feedback(teamId, reportId), ConsistentRead: true }));
  return Item?.type === "feedback" ? (stripReport(Item) as unknown as FeedbackReport) : undefined;
}

function stripReport(item: Record<string, unknown>): Record<string, unknown> {
  const { PK: _pk, SK: _sk, GSI1PK: _gpk, GSI1SK: _gsk, ...rest } = item;
  void _pk; void _sk; void _gpk; void _gsk;
  return rest;
}

/**
 * Moves a `new` report to `status`, setting `beadId`, and the status index
 * partition with it, on the condition that it's still `new`.
 * NotFoundError if there's no such report; ConflictError if it's no longer
 * new, unless it's already in exactly the state asked for.
 */
async function setStatus(db: Db, teamId: string, reportId: string, status: "triaged" | "dismissed", beadId: string, at: Date, reason = ""): Promise<FeedbackReport> {
  const key = keys.feedback(teamId, reportId);
  try {
    const { Attributes } = await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: key,
        UpdateExpression: `SET #status = :status, beadId = :bead, statusAt = :at, GSI1PK = :partition${reason ? ", dismissReason = :reason" : ""}`,
        ConditionExpression: "attribute_exists(PK) AND #type = :feedback AND #status = :from",
        ExpressionAttributeNames: { "#status": "status", "#type": "type" },
        ExpressionAttributeValues: { ":status": status, ":bead": beadId, ":at": at.toISOString(), ":partition": feedbackStatusPartition(status), ":feedback": "feedback", ":from": "new", ...(reason ? { ":reason": reason } : {}) },
        ReturnValues: "ALL_NEW",
      }),
    );
    return stripReport(Attributes as Record<string, unknown>) as unknown as FeedbackReport;
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== "ConditionalCheckFailedException") throw error;
  }
  const current = await getFeedback(db, teamId, reportId);
  if (!current) throw new NotFoundError("No such report");
  if (current.status === status && current.beadId === beadId) return current;
  throw new ConflictError(`This report is already ${current.status}${current.beadId ? ` (bead ${current.beadId})` : ""}`);
}

/** Records the bead a `new` report became: `triaged`, with `beadId`. Owner credentials only. */
export async function recordFeedbackBead(db: Db, teamId: string, reportId: string, beadId: string, at = new Date()): Promise<FeedbackReport> {
  if (typeof beadId !== "string" || !BEAD.test(beadId)) throw new InvalidInputError("Invalid bead ID");
  return await setStatus(db, teamId, reportId, "triaged", beadId, at);
}

/** The longest reason a dismissal keeps, in characters. */
export const DISMISS_REASON_MAX = 200;

/**
 * Dismisses a `new` report: `dismissed`, no bead, with the owner's short
 * `reason` kept as `dismissReason` (never the user's text: the CLI refuses a
 * reason that quotes the report). Owner credentials only.
 */
export async function dismissFeedback(db: Db, teamId: string, reportId: string, options: { readonly reason?: string; readonly at?: Date } = {}): Promise<FeedbackReport> {
  const reason = options.reason ?? "";
  if (typeof reason !== "string" || Array.from(reason).length > DISMISS_REASON_MAX || Array.from(reason).some((ch) => (ch.codePointAt(0) as number) < 0x20 || ch === "\u007f")) throw new InvalidInputError("Invalid reason");
  return await setStatus(db, teamId, reportId, "dismissed", "", options.at ?? new Date(), reason);
}
