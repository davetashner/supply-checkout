// What the "your report is fixed" email (supply-checkout-7id1,
// email/report-fixed-handler.ts) reads and writes. Like the returns digest
// (returns-digest.ts) it acts without a TeamContext: a server process with no
// caller, taking team IDs only from the table's own index and the keys of the
// items it reads. Its role's policy allows only the REPORT_FIXED_* attribute
// lists in schema.ts, and every call here names only those.
//
// - listFixedReports: the `FEEDBACK#STATUS#resolved` partition of GSI1, only
//   reports whose sender ticked contact OK, that no run has marked
//   (`notifiedAt`), resolved within REPORT_FIXED_MAX_AGE_DAYS. Each is
//   re-checked against its own keys and shape; an item that fails is left out.
// - readFixedTeam / isReportTeamMember: the team's closure and purge marks,
//   and whether the sender is still on the team.
// - claimFixedNotice / releaseFixedNotice / recordFixedRefused: the once-only
//   mark on the report itself. Claimed before sending by a conditional write
//   (still resolved, contact OK, no mark yet), so a retried or overlapping run
//   never sends twice; a send that fails gives it back.
//
// The sender's email is never read here or stored: the handler looks it up in
// the app pool when it sends.

import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { FEEDBACK_RELEASE } from "./feedback.js";
import { feedbackStatusPartition, id, keys } from "./keys.js";
import { GSI1, GSI1PK, REPORT_FIXED_READ_ATTRIBUTES, REPORT_FIXED_TEAM_ATTRIBUTES } from "./schema.js";

/** A report resolved longer ago than this is not told it's fixed (a stale "it's fixed" email is odd, and a report nobody can reach is not re-read for ever). */
export const REPORT_FIXED_MAX_AGE_DAYS = 14;

/** What the mark records: told (`sent`), SES refused the address (`refused`), or no one to tell (`skipped`). */
export type FixedOutcome = "sent" | "refused" | "skipped";

/** A resolved report to tell its sender about. */
export interface FixedReport {
  readonly teamId: string;
  readonly reportId: string;
  /** The sender's Cognito sub. */
  readonly userId: string;
  readonly message: string;
  readonly release: string;
  readonly resolvedAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const conditionFailed = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";

/** Placeholders for every attribute name: `status` and others are reserved words. */
function projection(names: readonly string[]) {
  return { ProjectionExpression: names.map((_, i) => `#p${i}`).join(", "), ExpressionAttributeNames: Object.fromEntries(names.map((name, i) => [`#p${i}`, name])) };
}

/** The report an index item describes, or undefined if it isn't one a mail may be sent for (shape, ids, release, keys that disagree). */
function fixedReport(item: Record<string, unknown>, cutoff: string): FixedReport | undefined {
  const { PK, SK, teamId, reportId, userId, message, release, resolvedAt } = item;
  if (item.type !== "feedback" || item.status !== "resolved" || item.contactOk !== true || item.notifiedAt !== undefined) return undefined;
  if (typeof PK !== "string" || typeof SK !== "string" || typeof teamId !== "string" || typeof reportId !== "string" || typeof userId !== "string") return undefined;
  try {
    id(teamId, "team ID");
    id(reportId, "report ID");
  } catch {
    return undefined;
  }
  // The keys name this very report, and the sender is a Cognito sub
  if (PK !== `FEEDBACK#${teamId}` || SK !== `REPORT#${reportId}` || !UUID.test(userId)) return undefined;
  if (typeof resolvedAt !== "string" || !ISO.test(resolvedAt) || resolvedAt < cutoff) return undefined;
  if (typeof release !== "string" || !FEEDBACK_RELEASE.test(release)) return undefined;
  return { teamId, reportId, userId, message: typeof message === "string" ? message : "", release, resolvedAt };
}

/**
 * Up to `limit` resolved reports not yet told, oldest first, resolved no more than
 * REPORT_FIXED_MAX_AGE_DAYS before `now`. An item whose shape, keys or release
 * is not right is left out and counted in `invalid` (the handler logs the count).
 */
export async function listFixedReports(db: Db, now: Date, limit: number): Promise<{ readonly reports: FixedReport[]; readonly invalid: number }> {
  const cutoff = new Date(now.getTime() - REPORT_FIXED_MAX_AGE_DAYS * 86_400_000).toISOString();
  const p = projection(REPORT_FIXED_READ_ATTRIBUTES);
  const n = (attribute: (typeof REPORT_FIXED_READ_ATTRIBUTES)[number]) => `#p${REPORT_FIXED_READ_ATTRIBUTES.indexOf(attribute)}`;
  const reports: FixedReport[] = [];
  let invalid = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI1,
        KeyConditionExpression: `${GSI1PK} = :pk`,
        // Cheaply, in the index: only reports whose sender asked to hear, that no run has marked, resolved lately
        FilterExpression: `${n("contactOk")} = :yes AND attribute_not_exists(${n("notifiedAt")}) AND ${n("resolvedAt")} >= :cutoff`,
        Select: "SPECIFIC_ATTRIBUTES",
        ...p,
        ExpressionAttributeValues: { ":pk": feedbackStatusPartition("resolved"), ":yes": true, ":cutoff": cutoff },
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const report = fixedReport(item, cutoff);
      if (report) reports.push(report);
      else invalid++;
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey && reports.length < limit);
  return { reports: reports.slice(0, limit), invalid };
}

/** A team as the email needs it: whether it's closed (it may be reopened) or purging (it's going). Undefined if the team item is gone. */
export async function readFixedTeam(db: Db, teamId: string): Promise<{ readonly closed: boolean; readonly purging: boolean } | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.team(id(teamId, "team ID")), ConsistentRead: true, ...projection(REPORT_FIXED_TEAM_ATTRIBUTES) }));
  if (!Item) return undefined;
  return { closed: typeof Item.closedAt === "string", purging: typeof Item.purging === "string" };
}

/** Whether the user is a member of the team now (a consistent read of the MEMBER item's keys). */
export async function isReportTeamMember(db: Db, teamId: string, userId: string): Promise<boolean> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.member(teamId, userId), ConsistentRead: true, ...projection(REPORT_FIXED_TEAM_ATTRIBUTES.slice(0, 2)) }));
  return Item !== undefined;
}

const markNames = { "#pk": "PK", "#type": "type", "#status": "status", "#contact": "contactOk", "#at": "notifiedAt", "#outcome": "notifyOutcome" };

/** The names of an update on the mark alone (DynamoDB refuses a name no expression uses). */
const ownMarkNames = { "#pk": "PK", "#type": "type", "#at": "notifiedAt", "#outcome": "notifyOutcome" };

/**
 * Marks the report told (or, for `skipped`, as one nobody can be told about)
 * as of `now`, if it is still a resolved report whose sender ticked contact OK
 * and has no mark: true the first time, false after. Claimed before sending, so a
 * retried or overlapping run never sends twice; a send that fails gives it
 * back (releaseFixedNotice).
 */
export async function claimFixedNotice(db: Db, report: Pick<FixedReport, "teamId" | "reportId">, outcome: "sent" | "skipped", now: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.feedback(report.teamId, report.reportId),
        UpdateExpression: "SET #at = :at, #outcome = :outcome",
        ConditionExpression: "attribute_exists(#pk) AND #type = :feedback AND #status = :resolved AND #contact = :yes AND attribute_not_exists(#at)",
        ExpressionAttributeNames: markNames,
        ExpressionAttributeValues: { ":at": now.toISOString(), ":outcome": outcome, ":feedback": "feedback", ":resolved": "resolved", ":yes": true },
        ReturnValues: "NONE",
      }),
    );
    return true;
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }
}

/** Gives a claim made at `claimedAt` back after a send that didn't go, so the next run sends it. Only while the mark is still that claim. */
export async function releaseFixedNotice(db: Db, report: Pick<FixedReport, "teamId" | "reportId">, claimedAt: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.feedback(report.teamId, report.reportId),
        UpdateExpression: "REMOVE #at, #outcome",
        ConditionExpression: "attribute_exists(#pk) AND #type = :feedback AND #at = :at AND #outcome = :sent",
        ExpressionAttributeNames: ownMarkNames,
        ExpressionAttributeValues: { ":at": claimedAt.toISOString(), ":feedback": "feedback", ":sent": "sent" },
        ReturnValues: "NONE",
      }),
    );
    return true;
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }
}

/** Records that SES refused the address a claimed report was to be sent to (the claim stays: trying again won't change SES's mind). */
export async function recordFixedRefused(db: Db, report: Pick<FixedReport, "teamId" | "reportId">, claimedAt: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.feedback(report.teamId, report.reportId),
        UpdateExpression: "SET #outcome = :refused",
        ConditionExpression: "attribute_exists(#pk) AND #type = :feedback AND #at = :at AND #outcome = :sent",
        ExpressionAttributeNames: ownMarkNames,
        ExpressionAttributeValues: { ":refused": "refused", ":at": claimedAt.toISOString(), ":feedback": "feedback", ":sent": "sent" },
        ReturnValues: "NONE",
      }),
    );
    return true;
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }
}
