// Receipt reads per team per month (ADR 0005, ADR 0008): one atomic counter
// item per month, checked against the plan's limit in the same write.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError, LimitReachedError } from "./errors.js";
import { keys, month } from "./keys.js";
import { type TeamContext, readable, writable } from "./team-context.js";

/** The UTC month, YYYY-MM, that usage counts against. */
export function usageMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** Receipts read so far in `m` (YYYY-MM). */
export async function getReceiptUsage(db: Db, ctx: TeamContext, m: string): Promise<number> {
  readable(ctx);
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.usage(ctx.teamId, m), ConsistentRead: true }));
  return (Item?.receipts as number | undefined) ?? 0;
}

/**
 * Counts one receipt read, unless the team has already used `limit` this month.
 * Returns the new count; throws LimitReachedError at the limit. Atomic, so two
 * reads at once can't both take the last one.
 */
export async function recordReceiptRead(db: Db, ctx: TeamContext, m: string, limit: number): Promise<number> {
  writable(db, ctx);
  if (!Number.isInteger(limit) || limit < 0) throw new InvalidInputError("Invalid limit");
  try {
    const { Attributes } = await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.usage(ctx.teamId, month(m)),
        UpdateExpression: "SET #type = :type, #month = :month ADD receipts :one",
        ConditionExpression: "attribute_not_exists(receipts) OR receipts < :limit",
        ExpressionAttributeNames: { "#type": "type", "#month": "month" },
        ExpressionAttributeValues: { ":type": "usage", ":month": m, ":one": 1, ":limit": limit },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    return Attributes?.receipts as number;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
      throw new LimitReachedError(`This team has read all ${limit} receipts included this month`);
    }
    throw error;
  }
}
