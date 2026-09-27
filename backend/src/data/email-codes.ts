// The per-user daily limit on email verification codes (POST /me/email/code).
// Cognito limits codes per user too, and API Gateway throttles the route for
// everyone; this counter, in the user's own partition, keeps one user from
// using up that shared throttle day after day. It counts requests, whether
// or not Cognito then sends the code.

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { LimitReachedError } from "./errors.js";
import { id, keys } from "./keys.js";

/** Verification codes one user may ask for per UTC day. */
export const EMAIL_CODES_PER_USER_PER_DAY = 10;

const DAY_SECONDS = 24 * 60 * 60;

/** Counts one code for the user today, or throws LimitReachedError when they've had EMAIL_CODES_PER_USER_PER_DAY. */
export async function countEmailCode(db: Db, userId: string, now = new Date()): Promise<void> {
  const epoch = Math.floor(now.getTime() / 1000);
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.emailCodes(id(userId, "user ID"), now.toISOString().slice(0, 10)),
        UpdateExpression: "ADD #count :one SET #type = :type, expiresAt = :expires",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
        ExpressionAttributeNames: { "#count": "count", "#type": "type" },
        ExpressionAttributeValues: { ":one": 1, ":max": EMAIL_CODES_PER_USER_PER_DAY, ":type": "emailCodes", ":expires": epoch + 2 * DAY_SECONDS },
      }),
    );
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") {
      throw new LimitReachedError(`You can ask for up to ${EMAIL_CODES_PER_USER_PER_DAY} codes a day; try again tomorrow`);
    }
    throw error;
  }
}
