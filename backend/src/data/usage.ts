// Receipt reads per team per month (ADR 0005, ADR 0008): one atomic counter
// item per month, checked against the plan's limit in the same write.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError, LimitReachedError } from "./errors.js";
import { keys, month } from "./keys.js";
import { type TeamContext, readable, writable } from "./team-context.js";

/**
 * Receipts a team may read each month: the provisional limit from ADR 0009's
 * starting proposal (supply-checkout-akz), the same for every plan until the
 * tiers are decided. Per-plan limits and per-user rate limits are
 * supply-checkout-wxx.
 */
export const RECEIPTS_PER_TEAM_PER_MONTH = 200;

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
 *
 * It names only the keys and `receipts` (RECEIPT_USAGE_ATTRIBUTES): the month
 * is in the sort key, so the receipts function's role, which may update only
 * those attributes, can't rewrite any other field of any item in the team's
 * partition (an item's `type`, say).
 */
export async function recordReceiptRead(db: Db, ctx: TeamContext, m: string, limit: number): Promise<number> {
  writable(db, ctx);
  if (!Number.isInteger(limit) || limit < 0) throw new InvalidInputError("Invalid limit");
  try {
    const { Attributes } = await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.usage(ctx.teamId, month(m)),
        UpdateExpression: "ADD receipts :one",
        ConditionExpression: "attribute_not_exists(receipts) OR receipts < :limit",
        ExpressionAttributeValues: { ":one": 1, ":limit": limit },
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
