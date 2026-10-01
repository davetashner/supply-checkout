// When two-step sign-in (an authenticator app, TOTP) was last turned on for a
// user (supply-checkout-8jc.14), in their own `USER#<sub>` partition:
//
//   PK USER#<sub>  SK TOTP_ON  totpOnAt  ISO time: no earlier than TOTP was last turned on
//
// The billing routes refuse an access token whose `auth_time` isn't later
// than it, so a session that began before TOTP was on (a token, or Managed
// Login's session cookie, from before) can't reach billing however TOTP was
// turned on. Who writes it, always with a time no earlier than the change:
//
// - the account API, once POST /me/mfa/totp/verify has turned TOTP on (the
//   time it did);
// - the security notices function, from CloudTrail's record of a
//   VerifySoftwareToken or SetUserMFAPreference call made any way, directly
//   against Cognito too (the event's time);
// - the billing function, for a user with TOTP on and no record (on since
//   before this was recorded, or a CloudTrail event not processed yet): the
//   time it found none.
//
// The time only ever moves later (recordTotpOn's condition), so an event that
// arrives late, or is replayed, can't move it back. When CloudTrail shows TOTP
// was turned off, the record is removed if it's older than that event
// (clearTotpOn), so turning it on again directly can't be passed by a session
// from in between before its own event arrives: with no record, billing
// records one now and refuses.
//
// Only TOTP_RECORD_ATTRIBUTES are named, and nothing is returned, which is all
// the billing-access role's and the notices function's IAM policies allow.
// IAM can't limit the sort key, so as defence in depth the key is checked to
// be TOTP_ON before any call (recordKey), and each update's condition also
// names it: neither ever creates or touches any other item.

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys } from "./keys.js";
import { PK, SK, TOTP_ON_SK } from "./schema.js";

const failedCondition = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";

/** The record's key, checked to be TOTP_ON in the user's own partition. */
function recordKey(userId: string) {
  const key = keys.totpOn(id(userId, "user ID"));
  if (key.SK !== TOTP_ON_SK || key.PK !== `USER#${userId}`) throw new Error("Not the two-step sign-in record");
  return key;
}

/** Names and values for the condition that the item is the TOTP_ON record (or, for a new one, none yet). */
const recordOnly = { names: { "#pk": PK, "#sk": SK }, values: { ":sk": TOTP_ON_SK } };

const iso = (at: Date) => {
  if (!Number.isFinite(at.getTime())) throw new Error("Not a time");
  return at.toISOString();
};

/** Records that TOTP was turned on at `at`, unless a later time is recorded. True if it was written. */
export async function recordTotpOn(db: Db, userId: string, at: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: recordKey(userId),
        UpdateExpression: "SET #at = :at",
        ConditionExpression: "(attribute_not_exists(#pk) OR #sk = :sk) AND (attribute_not_exists(#at) OR #at < :at)",
        ExpressionAttributeNames: { ...recordOnly.names, "#at": "totpOnAt" },
        ExpressionAttributeValues: { ...recordOnly.values, ":at": iso(at) },
      }),
    );
    return true;
  } catch (error) {
    if (failedCondition(error)) return false;
    throw error;
  }
}

/** Removes the record if it's older than `offAt`, when TOTP was seen turned off. True if it was removed. */
export async function clearTotpOn(db: Db, userId: string, offAt: Date): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: recordKey(userId),
        UpdateExpression: "REMOVE #at",
        ConditionExpression: "#sk = :sk AND #at < :at",
        ExpressionAttributeNames: { "#sk": SK, "#at": "totpOnAt" },
        ExpressionAttributeValues: { ...recordOnly.values, ":at": iso(offAt) },
      }),
    );
    return true;
  } catch (error) {
    if (failedCondition(error)) return false;
    throw error;
  }
}

/** When TOTP was last turned on, in milliseconds, if it's recorded (strongly consistent). */
export async function totpOnAt(db: Db, userId: string): Promise<number | undefined> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: recordKey(userId),
      ProjectionExpression: "#at",
      ExpressionAttributeNames: { "#at": "totpOnAt" },
      ConsistentRead: true,
    }),
  );
  const at = typeof Item?.totpOnAt === "string" ? Date.parse(Item.totpOnAt) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
}
