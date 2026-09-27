// Who gets a team's live-update notices (ADR 0016): the stream consumer
// publishes each change to the channel of every user this returns.
//
// Like authorizeTeam, it reads a team's membership by team ID without a
// TeamContext: the consumer is a server process acting on a stream record,
// with no caller. It reads only what it needs, and the consumer's IAM policy
// allows only LIVE_AUDIENCE_ATTRIBUTES (schema.ts, through
// dynamodb:Attributes), so the consumer can't read documents, emails or
// anything else:
//
// - META: the subscription status and closure. A team that doesn't exist,
//   has ended (hasEnded) or was closed (isClosed) has no audience.
// - MEMBER#<user>: the user ID and role. A MEMBER item with a missing or
//   unknown role counts as no membership, as in authorizeTeam.

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys, prefixes, teamPartition } from "./keys.js";
import { hasEnded, isClosed, isMemberRole } from "./model.js";

function validUser(value: unknown): string | undefined {
  try {
    return id(value, "user ID");
  } catch {
    return undefined;
  }
}

/**
 * The user IDs of the team's current members, or none if the team doesn't
 * exist, its subscription has ended or an owner closed it. Strongly consistent, so a member
 * removed before the call is never in the answer.
 */
export async function liveUpdateRecipients(db: Db, teamId: string): Promise<string[]> {
  const pk = teamPartition(id(teamId, "team ID"));
  const { doc } = connection(db);
  const { Item: meta } = await doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.team(teamId),
      ProjectionExpression: "#status, closedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ConsistentRead: true,
    }),
  );
  if (!meta || hasEnded(meta.status) || isClosed(meta)) return [];

  const users: string[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        Select: "SPECIFIC_ATTRIBUTES",
        ProjectionExpression: "#user, #role",
        ExpressionAttributeNames: { "#user": "userId", "#role": "role" },
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefixes.member },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const user = validUser(item.userId);
      if (user && isMemberRole(item.role)) users.push(user);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return users;
}
