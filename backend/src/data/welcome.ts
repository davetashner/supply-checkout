// The once-only welcome email (supply-checkout-6uw.25), in the user's own
// `USER#<sub>` partition:
//
//   PK USER#<sub>  SK WELCOME  welcomeSentAt  when the welcome email function claimed it and sent
//
// The welcome email function (email/welcome-handler.ts) claims the record
// before it sends: a conditional write that succeeds only if no welcome was
// claimed and the account isn't being deleted (the DELETING mark, checked in
// the same transaction). So a retried trigger, a second trigger for the same
// account, or Lambda trying the function again, never sends a second one. If
// SES refuses the message, the function gives its claim up (releaseWelcome,
// only while it's still the one it made) and Lambda tries again. If the
// function dies between claiming and sending, the claim stays and no welcome
// goes out: at most one, never two.
//
// It also reads, to word the email, whether the account is already in a team
// (hasTeam: the keys of its `TEAM#` rows) and whether a live invite is waiting
// for its verified address (hasLiveInvite: GSI2, the invite's type, address
// and expiry only). Only the attributes in WELCOME_*_ATTRIBUTES are named,
// which is all the function's IAM policy allows. Deleting an account deletes
// the record with the rest of the partition (deleteUserRows).

import { QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, inviteePartition, keys } from "./keys.js";
import { hashEmail, normalizeEmail } from "./model.js";
import { GSI2 } from "./schema.js";

/** What claiming came to: `claimed` (send it), `sent` (a welcome was claimed before), or `deleting` (the account is being deleted). */
export type WelcomeClaim = "claimed" | "sent" | "deleting";

/**
 * Claims the account's welcome email, as of `now`, unless one was claimed
 * before or the account is being deleted. Throws what DynamoDB throws
 * otherwise (a throttle, a conflict), so the caller can try again.
 */
export async function claimWelcome(db: Db, userId: string, now: Date): Promise<WelcomeClaim> {
  const user = id(userId, "user ID");
  try {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: db.tableName,
              Key: keys.welcome(user),
              UpdateExpression: "SET #at = :at",
              ConditionExpression: "attribute_not_exists(#at)",
              ExpressionAttributeNames: { "#at": "welcomeSentAt" },
              ExpressionAttributeValues: { ":at": now.toISOString() },
            },
          },
          // Not for an account being deleted: its rows are going, and so is its sign-in
          { ConditionCheck: { TableName: db.tableName, Key: keys.accountDeletion(user), ConditionExpression: "attribute_not_exists(PK)" } },
        ],
      }),
    );
    return "claimed";
  } catch (error) {
    const cancelled = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
    if (cancelled?.name !== "TransactionCanceledException") throw error;
    const [welcome, deleting] = (cancelled.CancellationReasons ?? []).map((r) => r?.Code);
    // The DELETING mark first: a deleted account gets nothing, whatever else
    if (deleting === "ConditionalCheckFailed") return "deleting";
    if (welcome === "ConditionalCheckFailed") return "sent";
    throw error;
  }
}

/**
 * Gives up a claim made at `claimedAt` (claimWelcome's `now`), so a later try
 * can send. Only while the record still holds that claim; true if it did.
 * Leaves the item's keys (removed with the account, like its other rows).
 */
export async function releaseWelcome(db: Db, userId: string, claimedAt: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.welcome(id(userId, "user ID")),
        UpdateExpression: "REMOVE #at",
        ConditionExpression: "#at = :at",
        ExpressionAttributeNames: { "#at": "welcomeSentAt" },
        ExpressionAttributeValues: { ":at": claimedAt.toISOString() },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** Whether the user is in at least one team: their own `TEAM#` rows, reading only the keys of one. */
export async function hasTeam(db: Db, userId: string): Promise<boolean> {
  const { Items } = await connection(db).doc.send(
    new QueryCommand({
      TableName: db.tableName,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": keys.welcome(userId).PK, ":prefix": "TEAM#" },
      ProjectionExpression: "PK, SK",
      // Explicit, so the role's dynamodb:Select condition can require it
      Select: "SPECIFIC_ATTRIBUTES",
      Limit: 1,
    }),
  );
  return (Items?.length ?? 0) > 0;
}

/**
 * Whether a live invite is waiting for this verified address, from any team
 * (GSI2, as listInvitesForEmail reads it, but only the invite's type, address
 * and expiry). Pass only an address Cognito has verified.
 */
export async function hasLiveInvite(db: Db, verifiedEmail: string, now: Date): Promise<boolean> {
  const email = normalizeEmail(verifiedEmail);
  const pk = inviteePartition(hashEmail(email));
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI2,
        KeyConditionExpression: "GSI2PK = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ProjectionExpression: "PK, SK, GSI2PK, GSI2SK, #type, email, expiresAt",
        ExpressionAttributeNames: { "#type": "type" },
        Select: "SPECIFIC_ATTRIBUTES",
        ExclusiveStartKey,
      }),
    );
    // TTL deletion can lag by days, so check expiry here too; and the address itself, not only its hash
    const live = (page.Items ?? []).some((i) => i.type === "invite" && i.email === email && typeof i.expiresAt === "number" && i.expiresAt > now.getTime() / 1000);
    if (live) return true;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return false;
}
