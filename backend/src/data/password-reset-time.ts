// When a user's password was last reset (supply-checkout-6uw.33), in their own
// `USER#<sub>` partition:
//
//   PK USER#<sub>  SK PASSWORD_RESET  passwordResetAt  ISO time: no earlier than the reset
//
// Cognito's ConfirmForgotPassword doesn't end the sessions from before it.
// The post confirmation trigger signs the account out everywhere
// (AdminUserGlobalSignOut), but that revokes refresh tokens only: an access
// token from before keeps passing API Gateway's JWT authorizer for up to an
// hour, and a Managed Login session cookie from before can get new tokens
// without the password. Those tokens keep the session's `auth_time`, when it
// signed in. So the trigger records the reset's time here, and every API route
// the app's tokens reach refuses a token whose `auth_time` is earlier
// (api/session-reset.ts).
//
// Only the trigger writes it, with the time it ran (after Cognito changed the
// password), and the time only ever moves later (recordPasswordReset's
// condition), so a retried or slow trigger can't move it back. Deleting the
// account removes it with the user's other rows.
//
// Only PASSWORD_RESET_RECORD_ATTRIBUTES are named, and nothing is returned,
// which is all the trigger's and the readers' IAM policies allow. IAM can't
// limit the sort key, so as defence in depth the key is checked to be
// PASSWORD_RESET before any call (recordKey), and the update's condition also
// names it: it never creates or touches any other item.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys } from "./keys.js";
import { PASSWORD_RESET_SK, PK, SK } from "./schema.js";

/** For a caller with a deadline (the post confirmation trigger): each request gives up after `timeoutMs`. */
export interface PasswordResetCallOptions {
  readonly timeoutMs?: number;
}

const sendOptions = (options: PasswordResetCallOptions) => (options.timeoutMs === undefined ? undefined : { abortSignal: AbortSignal.timeout(options.timeoutMs) });

/** The record's key, checked to be PASSWORD_RESET in the user's own partition. */
function recordKey(userId: string) {
  const key = keys.passwordReset(id(userId, "user ID"));
  if (key.SK !== PASSWORD_RESET_SK || key.PK !== `USER#${userId}`) throw new Error("Not the password reset record");
  return key;
}

/** Records that the user's password was reset at `at`, unless a later time is recorded. True if it was written. */
export async function recordPasswordReset(db: Db, userId: string, at: Date, options: PasswordResetCallOptions = {}): Promise<boolean> {
  if (!Number.isFinite(at.getTime())) throw new Error("Not a time");
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: recordKey(userId),
        UpdateExpression: "SET #at = :at",
        ConditionExpression: "(attribute_not_exists(#pk) OR #sk = :sk) AND (attribute_not_exists(#at) OR #at < :at)",
        ExpressionAttributeNames: { "#pk": PK, "#sk": SK, "#at": "passwordResetAt" },
        ExpressionAttributeValues: { ":sk": PASSWORD_RESET_SK, ":at": at.toISOString() },
      }),
      sendOptions(options),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** When the user's password was last reset, in milliseconds, if it's recorded (strongly consistent). */
export async function passwordResetAt(db: Db, userId: string): Promise<number | undefined> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: recordKey(userId),
      ProjectionExpression: "#at",
      ExpressionAttributeNames: { "#at": "passwordResetAt" },
      ConsistentRead: true,
    }),
  );
  const at = typeof Item?.passwordResetAt === "string" ? Date.parse(Item.passwordResetAt) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
}
