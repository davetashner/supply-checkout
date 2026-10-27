// What the daily returns digest (supply-checkout-phhw, ops/returns-digest-handler.ts)
// reads and writes. Like the lapsed-team job (team-lapse.ts) it acts without a
// TeamContext: it's a server process with no caller, and takes team IDs only
// from the table's own indexes. Its IAM policy allows only the DIGEST_*
// attribute lists in schema.ts, and every call here names only those.
//
// - listReturnedProjects: every team's projects returned (closed) in a time
//   window, from GSI2's `RETURNED#<day>` partitions (one Query per UTC day the
//   window touches), grouped by the team in the item's own key. No team
//   partition is read and nothing is scanned.
// - readDigestTeam: a team's META item, consistent: its name, billing fields
//   and closure.
// - listOwnerEmails (team-lapse.ts) lists the team's current owners.
// - ownerLanguage: the language an owner chose in the app, if they did.
// - claimDigest / releaseDigest: the right to email one owner one window's
//   digest, once.
//
// A team's digest holds only its own projects: a project is grouped by the
// team in its item's partition key, which the index key must repeat
// (otherwise the item is skipped), so nothing in a request or a stray
// attribute can put one team's project in another's digest.

import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { gsi2Returns, id, keys } from "./keys.js";
import { LANGUAGES, type Language } from "./preferences.js";
import { DIGEST_LANGUAGE_ATTRIBUTES, DIGEST_RETURN_ATTRIBUTES, DIGEST_TEAM_ATTRIBUTES, GSI2 } from "./schema.js";

/** How long the digest's own records are kept: longer than any retry of a window. */
export const DIGEST_RECORD_DAYS = 14;

const DAY_MS = 86_400_000;

/** One returned project, as the digest shows it. */
export interface ReturnedProject {
  readonly projectId: string;
  readonly client: string;
  /** The project's own date (YYYY-MM-DD), if it has one. */
  readonly date?: string;
  readonly closedAt: string;
  /** Who prepared it, when the app recorded a name. */
  readonly preparedBy?: string;
}

/** Placeholders for every name: `status` and `date` are reserved words. */
function projection(names: readonly string[]) {
  return { ProjectionExpression: names.map((_, i) => `#a${i}`).join(", "), ExpressionAttributeNames: Object.fromEntries(names.map((name, i) => [`#a${i}`, name])) };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The projects returned from `from` (included) to `to` (excluded), by team
 * ID. Each is re-checked against what the index says: closed, a `closedAt` in
 * the window, and keys that agree with each other. An item that fails any of
 * that is left out (the index is eventually consistent, and a stray attribute
 * must not widen what a digest holds).
 */
export async function listReturnedProjects(db: Db, from: Date, to: Date): Promise<Map<string, ReturnedProject[]>> {
  const out = new Map<string, ReturnedProject[]>();
  if (!(from.getTime() < to.getTime())) return out;
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const p = projection(DIGEST_RETURN_ATTRIBUTES);
  const name = (attribute: string) => Object.keys(p.ExpressionAttributeNames)[DIGEST_RETURN_ATTRIBUTES.indexOf(attribute as (typeof DIGEST_RETURN_ATTRIBUTES)[number])] as string;
  // Each UTC day from the window's first instant to its last
  const lastDay = new Date(to.getTime() - 1).toISOString().slice(0, 10);
  for (let day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); day.toISOString().slice(0, 10) <= lastDay; day = new Date(day.getTime() + DAY_MS)) {
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await connection(db).doc.send(
        new QueryCommand({
          TableName: db.tableName,
          IndexName: GSI2,
          KeyConditionExpression: `${name("GSI2PK")} = :pk AND ${name("GSI2SK")} BETWEEN :from AND :to`,
          Select: "SPECIFIC_ATTRIBUTES",
          ExpressionAttributeValues: { ":pk": gsi2Returns.day(day.toISOString().slice(0, 10)), ":from": fromIso, ":to": toIso },
          ...p,
          ExclusiveStartKey,
        }),
      );
      for (const item of page.Items ?? []) collect(out, item, fromIso, toIso);
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  return out;
}

function collect(out: Map<string, ReturnedProject[]>, item: Record<string, unknown>, fromIso: string, toIso: string): void {
  const { PK, SK, GSI2SK, closedAt } = item;
  if (typeof PK !== "string" || !PK.startsWith("TEAM#") || typeof SK !== "string" || !SK.startsWith("PROJECT#")) return;
  const teamId = PK.slice("TEAM#".length);
  const projectId = SK.slice("PROJECT#".length);
  try {
    id(teamId, "team ID");
    id(projectId, "project ID");
  } catch {
    return;
  }
  if (item.status !== "closed" || typeof closedAt !== "string" || !ISO.test(closedAt) || closedAt < fromIso || closedAt >= toIso) return;
  // The index key must name this very item
  if (GSI2SK !== `${closedAt}#${teamId}#${projectId}`) return;
  const date = typeof item.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : undefined;
  const project: ReturnedProject = {
    projectId,
    client: typeof item.client === "string" ? item.client : "",
    ...(date ? { date } : {}),
    closedAt,
    ...(typeof item.createdByName === "string" && item.createdByName.trim() ? { preparedBy: item.createdByName } : {}),
  };
  const list = out.get(teamId);
  if (list) list.push(project);
  else out.set(teamId, [project]);
}

/** A team as the digest reads it (DIGEST_TEAM_ATTRIBUTES). */
export interface DigestTeam {
  readonly teamId: string;
  readonly name: string;
  readonly status?: string;
  readonly trialEndsAt?: string;
  readonly createdAt?: string;
  readonly closedAt?: string;
  readonly purging?: string;
  readonly stripeSubscriptionId?: string;
  readonly pastDueSince?: string;
  readonly subscriptionEndedAt?: string;
  readonly compPlan?: string;
  readonly compUntil?: string;
  /** A test team (test-accounts.ts): only tags the digest's metrics. */
  readonly test?: true;
}

/** The team's META item now (a consistent read), or undefined if it's gone. */
export async function readDigestTeam(db: Db, teamId: string): Promise<DigestTeam | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.team(id(teamId, "team ID")), ConsistentRead: true, ...projection(DIGEST_TEAM_ATTRIBUTES) }));
  if (!Item) return undefined;
  const team: Record<string, unknown> = { teamId, name: typeof Item.name === "string" ? Item.name : "" };
  for (const field of ["status", "trialEndsAt", "createdAt", "closedAt", "purging", "stripeSubscriptionId", "pastDueSince", "subscriptionEndedAt", "compPlan", "compUntil"] as const) {
    if (typeof Item[field] === "string") team[field] = Item[field];
  }
  if (Item.test === true) team.test = true;
  return team as unknown as DigestTeam;
}

/** The language a user chose in the app (their preferences), or undefined if they never did or it can't be read as one. */
export async function ownerLanguage(db: Db, userId: string): Promise<Language | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.preferences(id(userId, "user ID")), ...projection(DIGEST_LANGUAGE_ATTRIBUTES) }));
  const language = Item?.language;
  return typeof language === "string" && (LANGUAGES as readonly string[]).includes(language) ? (language as Language) : undefined;
}

const conditionFailed = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";

/**
 * Claims the right to email one owner of one team the digest for the window
 * ending at `windowEnd`: true the first time, false after. Claimed before
 * sending, so a retried or overlapping run never sends it twice; a send that
 * fails gives the claim back (releaseDigest).
 */
export async function claimDigest(db: Db, teamId: string, windowEnd: Date, userId: string, now: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          ...keys.digestSent(teamId, windowEnd.toISOString(), userId),
          type: "returnsDigest",
          sentAt: now.toISOString(),
          expiresAt: Math.floor(now.getTime() / 1000) + DIGEST_RECORD_DAYS * 86_400,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true;
  } catch (error) {
    if (conditionFailed(error)) return false;
    throw error;
  }
}

/** Gives a claim back after a send that didn't go, so the next try can send it. */
export async function releaseDigest(db: Db, teamId: string, windowEnd: Date, userId: string): Promise<void> {
  await connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: keys.digestSent(teamId, windowEnd.toISOString(), userId) }));
}
