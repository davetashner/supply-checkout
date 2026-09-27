// Deleting a user's account (ADR 0007): the rows in the user's own `USER#`
// partition. The account handler (api/account-handler.ts) runs the whole
// deletion; each step is idempotent, so a retry after a partial failure
// carries on where it stopped:
//
// 1. startAccountDeletion marks the user (keys.accountDeletion). From then on
//    createTeam and acceptInvite refuse them, in the same transaction as the
//    membership they'd add, so the teams listed next are all there are.
// 2. For each team: leave it (removeMember, which moves the counts and
//    audits it), or close it first when the user is its only member
//    (closeTeam). A user who is the last owner of a team with other members
//    is refused before anything changes, and cancelAccountDeletion takes the
//    mark away again.
// 3. Every invite addressed to their verified email is deleted
//    (deleteInviteForEmail).
// 4. deleteUserRows deletes what's left in the partition (stale team-switcher
//    rows), except the daily rate-limit counters (`LIMIT#…`), which expire by
//    their TTL, so deleting an account can't reset a daily limit.
// 5. The Cognito user is deleted last, with the user's own access token.
//
// The mark stays until its TTL: by then the Cognito user is gone, and its
// `sub` is never issued again.

import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys } from "./keys.js";

const DAY_SECONDS = 24 * 60 * 60;

/** How long the deletion mark lasts: long enough for any retry. */
export const ACCOUNT_DELETION_MARK_DAYS = 30;

/** Marks the user's account as being deleted. Marking it again keeps the first mark. */
export async function startAccountDeletion(db: Db, userId: string, now = new Date()): Promise<void> {
  const key = keys.accountDeletion(id(userId, "user ID"));
  try {
    await connection(db).doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: { ...key, type: "accountDeletion", userId, startedAt: now.toISOString(), expiresAt: Math.floor(now.getTime() / 1000) + ACCOUNT_DELETION_MARK_DAYS * DAY_SECONDS },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== "ConditionalCheckFailedException") throw error;
  }
}

/** Takes the mark away: the deletion was refused before it changed anything. */
export async function cancelAccountDeletion(db: Db, userId: string): Promise<void> {
  await connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: keys.accountDeletion(id(userId, "user ID")) }));
}

/** Rate-limit counters (`LIMIT#TEAMS#<day>`, `LIMIT#EMAILCODES#<day>`, …): left to their TTL. */
const LIMIT_PREFIX = "LIMIT#";

/**
 * Deletes every item in the user's own partition except the deletion mark and
 * the rate-limit counters (they hold no personal data, expire within days, and
 * deleting them would let a delete-and-recreate reset a daily limit), and
 * returns how many. Call it after the user has left every team, so the only
 * team-switcher rows left are stale ones.
 */
export async function deleteUserRows(db: Db, userId: string): Promise<number> {
  const mark = keys.accountDeletion(id(userId, "user ID"));
  const rows: { PK: string; SK: string }[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": mark.PK },
        ProjectionExpression: "PK, SK",
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = String(item.SK);
      if (sk !== mark.SK && !sk.startsWith(LIMIT_PREFIX)) rows.push({ PK: item.PK as string, SK: sk });
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  for (const key of rows) await connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: key }));
  return rows.length;
}
