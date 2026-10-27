// What the emails to a report's sender (supply-checkout-7id1 and
// supply-checkout-c8vj.1: received, being looked at, fixed;
// email/report-fixed-handler.ts) read and write. Like the returns digest
// (returns-digest.ts) it acts without a TeamContext: a server process with no
// caller, taking team IDs only from the table's own index and the keys of the
// items it reads. Its role's policy allows only the REPORT_FIXED_* attribute
// lists in schema.ts, and every call here names only those.
//
// - listFixedReports: GSI1's `FEEDBACK#STATUS#new`, `#triaged` and `#resolved`
//   partitions, only reports whose sender ticked contact OK, that no run has
//   marked for that stage (`notified<Stage>At`), and whose stage began (created,
//   triaged, resolved) within REPORT_FIXED_MAX_AGE_DAYS. Each is re-checked
//   against its own keys and shape; an item that fails is left out. A report
//   is listed only at its current stage, so one that moved on between runs is
//   sent only the latest stage's email. A dismissed report is never listed.
// - readFixedTeam / isReportTeamMember: the team's closure and purge marks,
//   and whether the sender is still on the team.
// - claimFixedNotice / releaseFixedNotice / recordFixedRefused: the once-only
//   mark of one stage on the report itself. Claimed before sending by a
//   conditional write (still in that stage's status, contact OK, no mark yet), so a retried or overlapping run
//   never sends twice; a send that fails gives it back.
//
// The sender's email is never read here or stored: the handler looks it up in
// the app pool when it sends.

import { GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { FEEDBACK_RELEASE } from "./feedback.js";
import { feedbackStatusPartition, id, keys } from "./keys.js";
import { GSI1, GSI1PK, GSI1SK, REPORT_FIXED_READ_ATTRIBUTES, REPORT_FIXED_TEAM_ATTRIBUTES } from "./schema.js";

/** The stages of a report's mail, in order: when the stage began is the attribute `since`, and the report is in `status` while it lasts. */
export const FIXED_STAGES = {
  received: { status: "new", since: "createdAt", mark: "notifiedReceivedAt", outcome: "notifiedReceivedOutcome" },
  triaged: { status: "triaged", since: "statusAt", mark: "notifiedTriagedAt", outcome: "notifiedTriagedOutcome" },
  resolved: { status: "resolved", since: "resolvedAt", mark: "notifiedResolvedAt", outcome: "notifiedResolvedOutcome" },
} as const;
export type FixedStage = keyof typeof FIXED_STAGES;

/** A report that is too old for a stage's email (REPORT_FIXED_MAX_AGE_DAYS since the stage began) is not told: a stale "it's fixed" is odd. It bounds the `new` read (that partition sorts by createdAt, so the query starts at the cutoff). The `triaged` and `resolved` partitions sort by createdAt, not by when the stage began, so they are read whole, every run: bounded by the 2-year report TTL and the 5-reports-per-user-per-day cap, not by this age. */
export const REPORT_FIXED_MAX_AGE_DAYS = 14;

/** What the mark records: told (`sent`), SES refused the address (`refused`), or no one to tell (`skipped`). */
export type FixedOutcome = "sent" | "refused" | "skipped";

/** A report to tell its sender about, at the stage it is in now. */
export interface FixedReport {
  readonly stage: FixedStage;
  readonly teamId: string;
  readonly reportId: string;
  /** The sender's Cognito sub. */
  readonly userId: string;
  readonly message: string;
  /** The release the fix is in: set (and well formed) for `resolved`, empty otherwise. */
  readonly release: string;
}

type Ref = Pick<FixedReport, "stage" | "teamId" | "reportId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const conditionFailed = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";

/** Placeholders for every attribute name: `status` and others are reserved words. */
function projection(names: readonly string[]) {
  return { ProjectionExpression: names.map((_, i) => `#p${i}`).join(", "), ExpressionAttributeNames: Object.fromEntries(names.map((name, i) => [`#p${i}`, name])) };
}

/** The report an index item describes at `stage`, or undefined if a mail may not be sent for it (shape, ids, release, times, keys that disagree). */
function fixedReport(item: Record<string, unknown>, stage: FixedStage, cutoff: string): FixedReport | undefined {
  const { PK, SK, teamId, reportId, userId, message, release } = item;
  const def = FIXED_STAGES[stage];
  if (item.type !== "feedback" || item.status !== def.status || item.contactOk !== true || item[def.mark] !== undefined) return undefined;
  if (typeof PK !== "string" || typeof SK !== "string" || typeof teamId !== "string" || typeof reportId !== "string" || typeof userId !== "string") return undefined;
  try {
    id(teamId, "team ID");
    id(reportId, "report ID");
  } catch {
    return undefined;
  }
  // The keys name this very report, and the sender is a Cognito sub
  if (PK !== `FEEDBACK#${teamId}` || SK !== `REPORT#${reportId}` || !UUID.test(userId)) return undefined;
  const since = item[def.since];
  if (typeof since !== "string" || !ISO.test(since) || since < cutoff) return undefined;
  if (stage === "resolved" && (typeof release !== "string" || !FEEDBACK_RELEASE.test(release))) return undefined;
  return { stage, teamId, reportId, userId, message: typeof message === "string" ? message : "", release: stage === "resolved" ? (release as string) : "" };
}

/**
 * The reports to tell, across the stages (received first, then triaged, then
 * resolved; oldest first within one). The caller applies its per-run limit,
 * counting only the reports it acts on. An item whose shape, keys,
 * times or release is not right is left out and counted in `invalid` (the
 * handler logs the count).
 */
export async function listFixedReports(db: Db, now: Date): Promise<{ readonly reports: FixedReport[]; readonly invalid: number }> {
  const cutoff = new Date(now.getTime() - REPORT_FIXED_MAX_AGE_DAYS * 86_400_000).toISOString();
  const p = projection(REPORT_FIXED_READ_ATTRIBUTES);
  const n = (attribute: (typeof REPORT_FIXED_READ_ATTRIBUTES)[number]) => `#p${REPORT_FIXED_READ_ATTRIBUTES.indexOf(attribute)}`;
  const reports: FixedReport[] = [];
  let invalid = 0;
  for (const stage of Object.keys(FIXED_STAGES) as FixedStage[]) {
    const def = FIXED_STAGES[stage];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await connection(db).doc.send(
        new QueryCommand({
          TableName: db.tableName,
          IndexName: GSI1,
          // `new` sorts by createdAt, which is when its stage began: start at the cutoff. The others sort by createdAt, not their own stage time
          KeyConditionExpression: stage === "received" ? `${GSI1PK} = :pk AND ${GSI1SK} BETWEEN :from AND :to` : `${GSI1PK} = :pk`,
          // Cheaply, in the index: only reports whose sender asked to hear, that no run has marked for this stage, whose stage began lately
          FilterExpression: `${n("contactOk")} = :yes AND attribute_not_exists(${n(def.mark)}) AND ${n(def.since)} >= :cutoff`,
          Select: "SPECIFIC_ATTRIBUTES",
          ...p,
          ExpressionAttributeValues: { ":pk": feedbackStatusPartition(def.status), ":yes": true, ":cutoff": cutoff, ...(stage === "received" ? { ":from": cutoff, ":to": `${now.toISOString()}~` } : {}) },
          ExclusiveStartKey,
        }),
      );
      for (const item of page.Items ?? []) {
        const report = fixedReport(item, stage, cutoff);
        if (report) reports.push(report);
        else invalid++;
      }
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  return { reports, invalid };
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

/** The stage's own attribute names in an update, with placeholders (DynamoDB refuses a name no expression uses). */
const stageNames = (stage: FixedStage) => ({ "#pk": "PK", "#type": "type", "#at": FIXED_STAGES[stage].mark, "#outcome": FIXED_STAGES[stage].outcome });

/**
 * Marks the stage's email told (or, for `skipped`, as one nobody can be told)
 * as of `now`, if the report is still in that stage's status, its sender ticked
 * contact OK and the stage has no mark: true the first time, false after.
 * Claimed before sending, so a retried or overlapping run never sends twice; a
 * send that fails gives it back (releaseFixedNotice).
 */
export async function claimFixedNotice(db: Db, report: Ref, outcome: "sent" | "skipped", now: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.feedback(report.teamId, report.reportId),
        UpdateExpression: "SET #at = :at, #outcome = :outcome",
        ConditionExpression: "attribute_exists(#pk) AND #type = :feedback AND #status = :status AND #contact = :yes AND attribute_not_exists(#at)",
        ExpressionAttributeNames: { ...stageNames(report.stage), "#status": "status", "#contact": "contactOk" },
        ExpressionAttributeValues: { ":at": now.toISOString(), ":outcome": outcome, ":feedback": "feedback", ":status": FIXED_STAGES[report.stage].status, ":yes": true },
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
export async function releaseFixedNotice(db: Db, report: Ref, claimedAt: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.feedback(report.teamId, report.reportId),
        UpdateExpression: "REMOVE #at, #outcome",
        ConditionExpression: "attribute_exists(#pk) AND #type = :feedback AND #at = :at AND #outcome = :sent",
        ExpressionAttributeNames: stageNames(report.stage),
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
export async function recordFixedRefused(db: Db, report: Ref, claimedAt: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.feedback(report.teamId, report.reportId),
        UpdateExpression: "SET #outcome = :refused",
        ConditionExpression: "attribute_exists(#pk) AND #type = :feedback AND #at = :at AND #outcome = :sent",
        ExpressionAttributeNames: stageNames(report.stage),
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
