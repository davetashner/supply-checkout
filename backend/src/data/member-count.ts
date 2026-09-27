// A team's member count, as the membership changes read it before they write
// (acceptInvite, removeMember). The write itself is teamCounts (model.ts), in
// the same transaction as the MEMBER item; this only gathers what it needs.

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { keys, prefixes, teamPartition } from "./keys.js";
import { isClosed, memberCap } from "./model.js";

export interface MemberCount {
  /** How many members the team has now. */
  readonly members: number;
  /** memberCap for the team as it is now. */
  readonly cap: number;
  /** How many owners the team's count says it has. */
  readonly owners: number;
  /** The team was closed (closeTeam). */
  readonly closed: boolean;
  /**
   * Set when the team has no `members` attribute yet (made before the
   * count): the MEMBER items just counted, for teamCounts' `counted`.
   */
  readonly counted?: number;
}

/** Counts the team's MEMBER items, strongly consistent, reading only their keys. */
async function countMemberItems(db: Db, teamId: string): Promise<number> {
  let count = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": teamPartition(teamId), ":prefix": prefixes.member },
        ProjectionExpression: "PK, SK",
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    count += page.Items?.length ?? 0;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

/** The team's member count and cap, or undefined when the team doesn't exist. */
export async function memberCount(db: Db, teamId: string, now = new Date()): Promise<MemberCount | undefined> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.team(teamId),
      ConsistentRead: true,
      // MEMBERS and STATUS are DynamoDB reserved words
      ProjectionExpression: "#members, owners, #status, seats, closedAt, compPlan, compUntil",
      ExpressionAttributeNames: { "#members": "members", "#status": "status" },
    }),
  );
  if (!Item) return undefined;
  const cap = memberCap(Item, now);
  const owners = typeof Item.owners === "number" ? Item.owners : 0;
  const closed = isClosed(Item);
  if (typeof Item.members === "number") return { members: Item.members, cap, owners, closed };
  const counted = await countMemberItems(db, teamId);
  return { members: counted, cap, owners, closed, counted };
}
