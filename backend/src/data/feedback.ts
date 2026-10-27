// Reports from the app's "Report an issue" form (supply-checkout-bmsh.1). A
// signed-in member of a team, in any role, tells us something is wrong or
// missing; the owner triages reports into beads (the triage CLI,
// supply-checkout-bmsh.3). Report text is private: it never reaches a log, a
// metric, a bead or the public repo.
//
// One private item per report, in the team's reports partition, not in the
// team's own partition (see FEEDBACK_PREFIX in schema.ts for why):
//
//   PK FEEDBACK#<teamId>  SK REPORT#<reportId>
//        GSI1PK FEEDBACK#STATUS#<status>  GSI1SK <createdAt>#<reportId>
//        reportId, shortId, teamId, userId, role, createdAt, category,
//        message, expected, contactOk, context, status, beadId, expiresAt
//   PK USER#<userId>      SK LIMIT#FEEDBACK#<day>   count  (FEEDBACK_PER_USER_PER_DAY)
//
// The user's email is never stored; for a report with `contactOk` the triage
// CLI looks the user up by `userId`. The team's data-access role has no access
// to the partition, so no data route lists, fetches or changes a report.
//
// What writes it: sendFeedback, from the account function's route, on a
// session tagged with the path's team after the membership check (its role may
// only PutItem into FEEDBACK#<that team>). What reads and updates it:
// listFeedback, getFeedback, recordFeedbackBead and dismissFeedback in
// feedback-owner.ts, for the owner's own credentials only (they take no
// TeamContext and no route calls them). That module is not exported from
// index.ts, so no Lambda bundle can import it (test/feedback-owner.test.ts
// checks). The team purge deletes the partition with the team (purgeTeam), and
// the items expire (TTL) after FEEDBACK_RETENTION_DAYS.
//
// A retried send stores one report: its ID comes from the team, the user and
// the request's Idempotency-Key, and the put is conditional on its absence.

import { createHash } from "node:crypto";
import { QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { withoutHiddenCharacters } from "../text/hidden-characters.js";
import { type Db, connection } from "./client.js";
import { ConflictError, ForbiddenError, InvalidInputError, LimitReachedError, TeamDeletingError } from "./errors.js";
import { feedbackPartition, feedbackStatusPartition, id, keys } from "./keys.js";
import { FEEDBACK_OWN_ATTRIBUTES, FEEDBACK_RETENTION_DAYS, TTL_ATTRIBUTE } from "./schema.js";
import { type TeamContext, writable } from "./team-context.js";

export { FEEDBACK_RETENTION_DAYS } from "./schema.js";

export const FEEDBACK_CATEGORIES = ["bug", "idea", "question"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** Where in the app the report was sent from. The web app maps its own views onto these; any other value is stored as `other`. */
export const FEEDBACK_SCREENS = ["projects", "project", "prices", "scan", "receipt", "team", "members", "billing", "account", "sign-in", "other"] as const;

/** Browser families. Anything else is stored as `other`. */
export const FEEDBACK_BROWSERS = ["chrome", "safari", "firefox", "edge", "samsung", "opera", "other"] as const;

/**
 * The statuses a report has: `new` until the owner turns it into a bead
 * (`triaged`, with `beadId`) or dismisses it. A triaged report becomes
 * `resolved` (with `resolvedAt` and `release`) once its fix is live in prod.
 */
export const FEEDBACK_STATUSES = ["new", "triaged", "dismissed", "resolved"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Reports one user may send per UTC day, from all their teams together. */
export const FEEDBACK_PER_USER_PER_DAY = 5;
/** The longest report text, "what happened", in characters. */
export const FEEDBACK_MESSAGE_MAX = 2000;
/** The longest "what you expected", in characters. */
export const FEEDBACK_EXPECTED_MAX = 1000;
/** The largest request body the route takes, in bytes. Text outside ASCII counts by its UTF-8 size. */
export const FEEDBACK_BODY_BYTES = 4096;

const DAY_SECONDS = 24 * 60 * 60;
/** An app build ID: a version, with an optional build suffix (`1.11.1`, `1.11.1+3f2a9c1`). */
const BUILD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;
/** What a retried or racing send is told when it's over the day's limit (the same for every caller). */
const TOO_MANY = `You can send ${FEEDBACK_PER_USER_PER_DAY} reports a day. Try again tomorrow.`;

/** The daily limit, as the API answers it (429). */
export class FeedbackLimitError extends LimitReachedError {
  override readonly name = "FeedbackLimitError";
}

export interface FeedbackContext {
  readonly build?: string;
  readonly screen?: string;
  readonly browser?: string;
}

/** A report's fields as the caller sent them, validated and cleaned. */
export interface FeedbackInput {
  readonly category: FeedbackCategory;
  readonly message: string;
  readonly expected: string;
  readonly contactOk: boolean;
  readonly context: FeedbackContext;
}

/** The fields a request body may carry. Nothing server-owned (team, user, role, status, IDs, times) is among them. */
export const FEEDBACK_FIELDS = ["category", "message", "expected", "contactOk", "context"] as const;
const CONTEXT_FIELDS = ["build", "screen", "browser"] as const;

/**
 * Text as stored: line endings made `\n`, control, bidi and other hidden
 * characters removed (a tab becomes a space), each line's ends trimmed, and the whole
 * trimmed. Its length is in characters, not UTF-16 units. Errors name the
 * field, never the text.
 */
function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new InvalidInputError(`${field} must be text`);
  const lines = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const cleaned = lines.map((line) => withoutHiddenCharacters(line).trim()).join("\n").trim();
  const length = Array.from(cleaned).length;
  if (length < min) throw new InvalidInputError(`${field} is required`);
  if (length > max) throw new InvalidInputError(`${field} can be at most ${max} characters`);
  return cleaned;
}

/** A report's input, from a request body that has already been limited to FEEDBACK_FIELDS. InvalidInputError otherwise. */
export function feedbackInput(body: Record<string, unknown>): FeedbackInput {
  for (const field of Object.keys(body)) if (!(FEEDBACK_FIELDS as readonly string[]).includes(field)) throw new InvalidInputError("Unexpected field");
  const { category, contactOk } = body;
  if (typeof category !== "string" || !(FEEDBACK_CATEGORIES as readonly string[]).includes(category)) throw new InvalidInputError("category must be bug, idea or question");
  if (contactOk !== undefined && typeof contactOk !== "boolean") throw new InvalidInputError("contactOk must be true or false");
  return {
    category: category as FeedbackCategory,
    message: text(body.message, "message", 1, FEEDBACK_MESSAGE_MAX),
    expected: body.expected === undefined || body.expected === null ? "" : text(body.expected, "expected", 0, FEEDBACK_EXPECTED_MAX),
    contactOk: contactOk === true,
    context: feedbackContext(body.context),
  };
}

function feedbackContext(value: unknown): FeedbackContext {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new InvalidInputError("context must be an object");
  const raw = value as Record<string, unknown>;
  for (const field of Object.keys(raw)) if (!(CONTEXT_FIELDS as readonly string[]).includes(field)) throw new InvalidInputError("Unexpected context field");
  for (const field of CONTEXT_FIELDS) if (raw[field] !== undefined && typeof raw[field] !== "string") throw new InvalidInputError(`context.${field} must be text`);
  const out: { build?: string; screen?: string; browser?: string } = {};
  if (raw.build !== undefined) {
    if (!BUILD.test(raw.build as string)) throw new InvalidInputError("context.build isn't a build ID");
    out.build = raw.build as string;
  }
  // A newer app may name a screen or browser this version doesn't know: kept as `other`, not refused
  if (raw.screen !== undefined) out.screen = (FEEDBACK_SCREENS as readonly string[]).includes(raw.screen as string) ? (raw.screen as string) : "other";
  if (raw.browser !== undefined) out.browser = (FEEDBACK_BROWSERS as readonly string[]).includes(raw.browser as string) ? (raw.browser as string) : "other";
  return out;
}

/** The report's ID for a team, user and Idempotency-Key: one report per attempt. 32 hex characters. */
export function feedbackIdFor(teamId: string, userId: string, requestKey: string): string {
  if (typeof requestKey !== "string" || !REQUEST_KEY.test(requestKey)) throw new InvalidInputError("Invalid idempotency key");
  return createHash("sha256").update(`feedback\n${id(teamId, "team ID")}\n${id(userId, "user ID")}\n${requestKey}`, "utf8").digest("hex").slice(0, 32);
}

/** The first 8 characters of a report's ID: what the triage CLI shows, and a bead names, instead of the ID. */
export const shortFeedbackId = (reportId: string): string => id(reportId, "report ID").slice(0, 8);

/** A report as stored (without its keys). */
export interface FeedbackReport {
  readonly type: "feedback";
  readonly reportId: string;
  readonly shortId: string;
  readonly teamId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: string;
  readonly category: FeedbackCategory;
  readonly message: string;
  readonly expected: string;
  readonly contactOk: boolean;
  readonly context: FeedbackContext;
  readonly status: FeedbackStatus;
  /** Empty until the report is turned into a bead. */
  readonly beadId: string;
  /** Set when the owner triages it: when its status last changed. */
  readonly statusAt?: string;
  /** Set when the owner dismisses it: the owner's own short reason, never the user's text. */
  readonly dismissReason?: string;
  /** Set when the owner resolves it (server time, ISO): the fix is live. The same instant as `statusAt`. */
  readonly resolvedAt?: string;
  /** Set with `resolvedAt`: the release (`1.22.0`) the fix went out in. */
  readonly release?: string;
  readonly expiresAt: number;
}

/** The transaction item that refuses an account that's being deleted. */
const accountNotDeleting = (userId: string, tableName: string) => ({ ConditionCheck: { TableName: tableName, Key: keys.accountDeletion(userId), ConditionExpression: "attribute_not_exists(PK)" } });

/**
 * Stores a member's report, in one transaction with the user's counter for the
 * UTC day (FEEDBACK_PER_USER_PER_DAY, FeedbackLimitError, the same message for
 * every caller), a check that the team is still there and isn't being purged
 * (so a report is never written after the purge listed the team's partition),
 * and a check that the user's account isn't being deleted.
 *
 * Any role may report, and a closed team's members may too (or one that's
 * read-only for billing): the report is the user's note to us, not the team's
 * data, and "my team was closed" is just when they need to. A team marked
 * `purging` refuses it.
 *
 * `requestKey` is the request's Idempotency-Key: a retry of the same send
 * finds its report stored, counts nothing, and returns it with `created`
 * false. The report carries the context's team, user and role, never from the
 * input; `input` comes from feedbackInput.
 */
export async function sendFeedback(
  db: Db,
  ctx: TeamContext,
  input: FeedbackInput,
  requestKey: string,
  now = new Date(),
): Promise<{ readonly reportId: string; readonly shortId: string; readonly created: boolean }> {
  writable(db, ctx, "viewer", { whileClosed: true });
  if (ctx.role === "system") throw new ForbiddenError("Only a member can send a report");
  const reportId = feedbackIdFor(ctx.teamId, ctx.userId, requestKey);
  const shortId = shortFeedbackId(reportId);
  const epoch = Math.floor(now.getTime() / 1000);
  const createdAt = now.toISOString();
  const status: FeedbackStatus = "new";
  const report: FeedbackReport = {
    type: "feedback",
    reportId,
    shortId,
    teamId: ctx.teamId,
    userId: ctx.userId,
    role: ctx.role,
    createdAt,
    category: input.category,
    message: input.message,
    expected: input.expected,
    contactOk: input.contactOk,
    context: input.context,
    status,
    beadId: "",
    expiresAt: epoch + FEEDBACK_RETENTION_DAYS * DAY_SECONDS,
  };
  const items = [
    {
      Put: {
        TableName: db.tableName,
        Item: { ...keys.feedback(ctx.teamId, reportId), GSI1PK: feedbackStatusPartition(status), GSI1SK: `${createdAt}#${reportId}`, ...report },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    },
    {
      Update: {
        TableName: db.tableName,
        Key: keys.feedbackSent(ctx.userId, createdAt.slice(0, 10)),
        UpdateExpression: "ADD #count :one SET #type = :type, #expires = :expires",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
        ExpressionAttributeNames: { "#count": "count", "#type": "type", "#expires": TTL_ATTRIBUTE },
        ExpressionAttributeValues: { ":one": 1, ":max": FEEDBACK_PER_USER_PER_DAY, ":type": "feedbackSent", ":expires": epoch + 2 * DAY_SECONDS },
      },
    },
    { ConditionCheck: { TableName: db.tableName, Key: keys.team(ctx.teamId), ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(purging)" } },
    accountNotDeleting(ctx.userId, db.tableName),
  ];
  try {
    await connection(db).doc.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") throw error;
    const codes = ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r?.Code);
    const failed = (i: number) => codes[i] === "ConditionalCheckFailed";
    // Already stored for this key: a retry. Checked first, so a retry at the limit still succeeds
    if (failed(0)) return { reportId, shortId, created: false };
    if (failed(1)) throw new FeedbackLimitError(TOO_MANY);
    if (failed(2)) throw new TeamDeletingError("This team is being deleted, so it can't take reports.");
    if (failed(3)) throw new ConflictError("Your account is being deleted");
    throw error;
  }
  return { reportId, shortId, created: true };
}

/** What a person sees of a report's status. `dismissed` is `not_planned`, with no reason. */
export type OwnFeedbackStatus = "received" | "looking" | "fixed" | "not_planned";

/** One of the caller's own reports, as "Your reports" shows it. No user, contact choice, bead or dismissal reason. */
export interface OwnFeedback {
  readonly id: string;
  readonly shortId: string;
  readonly createdAt: string;
  readonly category: FeedbackCategory;
  /** The first line of what they wrote, cut to FEEDBACK_SUMMARY_MAX characters. */
  readonly summary: string;
  readonly status: OwnFeedbackStatus;
  /** With `fixed`: the release the fix went out in, when it's recorded. */
  readonly release?: string;
  readonly resolvedAt?: string;
}

/** The most reports one answer carries (the newest). */
export const FEEDBACK_MINE_MAX = 50;
/** The longest summary, in characters. */
export const FEEDBACK_SUMMARY_MAX = 140;
/** Items read per page of the team's reports partition, and the most pages read: 2000 reports at most. */
const MINE_PAGE_ITEMS = 100;
const MINE_PAGE_LIMIT = 20;

const OWN_STATUS: Record<string, OwnFeedbackStatus> = { new: "received", triaged: "looking", resolved: "fixed", dismissed: "not_planned" };

/**
 * The caller's own reports in the team, newest first, at most FEEDBACK_MINE_MAX
 * (`more` when there are others). Any role may read them, a closed team's
 * members too; membership is checked by the caller (`ctx` is from
 * authorizeTeam, so someone who left the team never gets here).
 *
 * Reports sit in one partition per team under a random sort key, so the
 * only way to find a person's own is to read the team's partition and filter
 * on `userId` (the caller's own, `ctx.userId` from the verified token, never
 * a value from the request). The read is capped at MINE_PAGE_LIMIT pages of
 * MINE_PAGE_ITEMS and asks only for the projected attributes; at the cap
 * (`more` is true) the newest of those read are shown. Reports expire after
 * two years and a person sends at most FEEDBACK_PER_USER_PER_DAY a day.
 */
export async function listOwnFeedback(db: Db, ctx: TeamContext): Promise<{ readonly reports: OwnFeedback[]; readonly more: boolean }> {
  if (ctx.role === "system") throw new ForbiddenError("Only a member can read their reports");
  const found: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        FilterExpression: "#userId = :user AND #type = :type",
        ProjectionExpression: FEEDBACK_OWN_ATTRIBUTES.map((a) => `#${a}`).join(", "),
        Select: "SPECIFIC_ATTRIBUTES",
        ExpressionAttributeNames: Object.fromEntries(FEEDBACK_OWN_ATTRIBUTES.map((a) => [`#${a}`, a])),
        ExpressionAttributeValues: { ":pk": feedbackPartition(ctx.teamId), ":prefix": "REPORT#", ":user": ctx.userId, ":type": "feedback" },
        ConsistentRead: true,
        Limit: MINE_PAGE_ITEMS,
        ExclusiveStartKey,
      }),
    );
    found.push(...(page.Items as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
    pages += 1;
  } while (ExclusiveStartKey && pages < MINE_PAGE_LIMIT);
  const newest = found
    // Belt and braces: the filter did this, and a bug in it must not show another person's report
    .filter((item) => item.userId === ctx.userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { reports: newest.slice(0, FEEDBACK_MINE_MAX).map(ownFeedback), more: newest.length > FEEDBACK_MINE_MAX || ExclusiveStartKey !== undefined };
}

function ownFeedback(item: Record<string, unknown>): OwnFeedback {
  const status = OWN_STATUS[String(item.status)] ?? "received";
  const firstLine = String(item.message).split("\n", 1)[0] as string;
  const chars = Array.from(firstLine);
  return {
    id: String(item.reportId),
    shortId: String(item.shortId),
    createdAt: String(item.createdAt),
    category: item.category as FeedbackCategory,
    summary: chars.length > FEEDBACK_SUMMARY_MAX ? `${chars.slice(0, FEEDBACK_SUMMARY_MAX - 1).join("")}…` : firstLine,
    status,
    ...(status === "fixed" && typeof item.release === "string" && item.release ? { release: item.release } : {}),
    ...(status === "fixed" && typeof item.resolvedAt === "string" && item.resolvedAt ? { resolvedAt: item.resolvedAt } : {}),
  };
}
