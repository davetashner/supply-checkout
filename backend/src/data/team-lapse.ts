// What the lapsed-team job (supply-checkout-qdx, ops/team-lapse-handler.ts)
// reads and writes. Like the purge (team-purge.ts) it acts without a
// TeamContext: it's a server process with no caller, and takes team IDs only
// from the table's own index. Its IAM policy allows only the attribute lists
// in schema.ts (LAPSE_LIST_ATTRIBUTES, LAPSE_READ_ATTRIBUTES,
// LAPSE_CLOSE_ATTRIBUTES, LAPSE_OWNER_ATTRIBUTES, LAPSE_RECORD_ATTRIBUTES),
// and every call here names only those.
//
// - listLapseCandidates: every open team whose billing may have lapsed, or
//   is about to (an app trial ending within LAPSE_TRIAL_NOTICE_DAYS), from
//   GSI3's OPS#TEAMS partition. A hint: the job reads each one again.
// - readLapseTeam: a team's META item, consistent, as billingAccess needs it.
// - listOwnerEmails: a team's owners' addresses, from GSI3's owners partition.
// - claimLapseNotice: the right to email one owner one notice, once.
// - recordWarning / warnedAt: when the deletion warning went out.
// - closeLapsedTeam: closes the team for the purge, on the condition that
//   nothing about it changed since it was read.

import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { gsi1, id, keys, opsOwnersPartition } from "./keys.js";
import { liveComp, trialEnd } from "./model.js";
import { GSI3, LAPSE_LIST_ATTRIBUTES, LAPSE_OWNER_ATTRIBUTES, LAPSE_READ_ATTRIBUTES, OPS_TEAMS_PARTITION } from "./schema.js";

/** An app trial ending within this many days gets the trial-ending email (and is listed for it). */
export const LAPSE_TRIAL_NOTICE_DAYS = 3;

/** The deletion warning goes out at least this many days before a lapsed team is closed for deletion. */
export const LAPSE_WARNING_DAYS = 7;

/** How long the job's own records (LAPSE#) are kept: longer than any notice's date can matter. */
export const LAPSE_RECORD_DAYS = 120;

/**
 * How long after the job closes a lapsed team the purge deletes it
 * (`purgeAfter`): a day in which an operator (or an owner) can still reopen a
 * team closed by mistake, after "Lapsed-team closures held" or "high" fires.
 */
export const LAPSE_PURGE_DELAY_HOURS = 24;

/** `system:` closer of a lapsed team (`closedBy`): never a user ID. */
export const LAPSED_CLOSER = "system:lapsed";

const DAY_MS = 86_400_000;

/** Statuses whose team may have lapsed (billingAccess); anything else (active, a Stripe trial or not, incomplete, paused) is checked only while trialing. */
const LAPSING = ["past_due", "unpaid", "canceled", "incomplete_expired"];

/** Placeholders for every name: `status` is a reserved word. */
function projection(names: readonly string[]) {
  return { ProjectionExpression: names.map((_, i) => `#a${i}`).join(", "), ExpressionAttributeNames: Object.fromEntries(names.map((name, i) => [`#a${i}`, name])) };
}

/**
 * The open teams whose billing may have lapsed or is about to, from the
 * operators' index: not closed, no live comp, and `past_due`, `unpaid`,
 * `canceled` or `incomplete_expired`, or `trialing` with its trial (as the
 * index has it) ending within LAPSE_TRIAL_NOTICE_DAYS or over. A Stripe
 * trial is listed too; readLapseTeam tells it apart.
 */
export async function listLapseCandidates(db: Db, now: Date): Promise<string[]> {
  const out: string[] = [];
  const soon = now.getTime() + LAPSE_TRIAL_NOTICE_DAYS * DAY_MS;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  const p = projection(LAPSE_LIST_ATTRIBUTES);
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI3,
        KeyConditionExpression: `${Object.keys(p.ExpressionAttributeNames)[LAPSE_LIST_ATTRIBUTES.indexOf("GSI3PK")]} = :pk`,
        Select: "SPECIFIC_ATTRIBUTES",
        ExpressionAttributeValues: { ":pk": OPS_TEAMS_PARTITION },
        ...p,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const pk = String(item.PK);
      if (item.SK !== "META" || !pk.startsWith("TEAM#") || item.closedAt !== undefined || liveComp(item, now)) continue;
      const lapsing = LAPSING.includes(item.status as string) || (item.status === "trialing" && trialEnd(item) <= soon);
      if (!lapsing) continue;
      try {
        out.push(id(pk.slice("TEAM#".length), "team ID"));
      } catch {
        // Not a key this app wrote: leave it for a person to look at
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** A team as the lapsed-team job reads it (LAPSE_READ_ATTRIBUTES). */
export interface LapseTeam {
  readonly teamId: string;
  readonly name: string;
  readonly status?: string;
  readonly trialEndsAt?: string;
  readonly createdAt?: string;
  readonly closedAt?: string;
  readonly purging?: string;
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  readonly pastDueSince?: string;
  readonly subscriptionEndedAt?: string;
  readonly compPlan?: string;
  readonly compUntil?: string;
  readonly version: number;
}

/** The team's META item now (a consistent read), or undefined if it's gone. */
export async function readLapseTeam(db: Db, teamId: string): Promise<LapseTeam | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.team(id(teamId, "team ID")), ConsistentRead: true, ...projection(LAPSE_READ_ATTRIBUTES) }));
  if (!Item) return undefined;
  // A META item without a version (none this app writes) reads as -1, which no closure's condition matches: the job counts it
  const team: Record<string, unknown> = { teamId, name: typeof Item.name === "string" ? Item.name : "", version: typeof Item.version === "number" ? Item.version : -1 };
  for (const field of ["status", "trialEndsAt", "createdAt", "closedAt", "purging", "stripeCustomerId", "stripeSubscriptionId", "pastDueSince", "subscriptionEndedAt", "compPlan", "compUntil"] as const) {
    if (typeof Item[field] === "string") team[field] = Item[field];
  }
  return team as unknown as LapseTeam;
}

/** A team's owners and their addresses, from the operators' index (eventually consistent). */
export async function listOwnerEmails(db: Db, teamId: string): Promise<{ readonly userId: string; readonly email?: string }[]> {
  const out: { userId: string; email?: string }[] = [];
  const p = projection(LAPSE_OWNER_ATTRIBUTES);
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI3,
        KeyConditionExpression: `${Object.keys(p.ExpressionAttributeNames)[LAPSE_OWNER_ATTRIBUTES.indexOf("GSI3PK")]} = :pk`,
        Select: "SPECIFIC_ATTRIBUTES",
        ExpressionAttributeValues: { ":pk": opsOwnersPartition(id(teamId, "team ID")) },
        ...p,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = String(item.SK);
      if (item.PK !== `TEAM#${teamId}` || !sk.startsWith("MEMBER#")) continue;
      out.push({ userId: sk.slice("MEMBER#".length), ...(typeof item.email === "string" ? { email: item.email } : {}) });
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const expiresAt = (now: Date) => Math.floor(now.getTime() / 1000) + LAPSE_RECORD_DAYS * 86_400;

const conditionFailed = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";

/**
 * Claims the right to email one owner one notice (`kind`) for one date
 * (`anchor`): true the first time, false after. Claimed before sending, so a
 * failure after it means no email rather than two.
 */
export async function claimLapseNotice(db: Db, teamId: string, kind: string, anchor: string, userId: string, now: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: { ...keys.lapseNotice(teamId, kind, anchor, userId), type: "lapseNotice", sentAt: now.toISOString(), expiresAt: expiresAt(now) },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true;
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }
}

/** When the deletion warning for `deleteAfter` went out (ISO 8601), if it has. */
export async function warnedAt(db: Db, teamId: string, deleteAfter: string): Promise<string | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.lapseWarned(teamId, deleteAfter), ConsistentRead: true, ProjectionExpression: "sentAt" }));
  return typeof Item?.sentAt === "string" ? Item.sentAt : undefined;
}

/**
 * Records that the deletion warning for `deleteAfter` goes out now, unless it
 * already did: returns when it did (the first time's, whichever run wrote it).
 */
export async function recordWarning(db: Db, teamId: string, deleteAfter: string, now: Date): Promise<string> {
  try {
    await connection(db).doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: { ...keys.lapseWarned(teamId, deleteAfter), type: "lapseWarning", sentAt: now.toISOString(), expiresAt: expiresAt(now) },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return now.toISOString();
  } catch (error) {
    if (!conditionFailed(error)) throw error;
    const at = await warnedAt(db, teamId, deleteAfter);
    if (!at) throw error;
    return at;
  }
}

/**
 * Closes a lapsed team so the hourly purge deletes it (team-purge.ts): sets
 * `closedAt` to now, `purgeAfter` LAPSE_PURGE_DELAY_HOURS later, `closedBy`
 * to LAPSED_CLOSER, and puts it in the closed-teams index, as closeTeam does,
 * with the version moved. Until the purge starts, it can be reopened as an
 * owner's closure can.
 * Conditioned on the team being there, not closed or being purged, and its
 * version being the one read (`team.version`: a Stripe event, a customer
 * linked at Checkout, a comp, an owner's change or a closure since then
 * moves it); otherwise nothing is closed (false), and the next run decides
 * again. Its invites go with the purge; nobody can accept
 * them meanwhile (a closed team takes nobody).
 */
export async function closeLapsedTeam(db: Db, team: Pick<LapseTeam, "teamId" | "version">, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const purgeAfter = new Date(now.getTime() + LAPSE_PURGE_DELAY_HOURS * 3_600_000).toISOString();
  const index = gsi1.closedTeam(purgeAfter, team.teamId);
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.team(id(team.teamId, "team ID")),
        UpdateExpression: "SET closedAt = :at, closedBy = :by, purgeAfter = :purge, GSI1PK = :gpk, GSI1SK = :gsk, #version = #version + :one",
        ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(closedAt) AND attribute_not_exists(purging) AND #version = :version",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":at": at, ":purge": purgeAfter, ":by": LAPSED_CLOSER, ":gpk": index.GSI1PK, ":gsk": index.GSI1SK, ":one": 1, ":version": team.version },
      }),
    );
    return true;
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }
}
