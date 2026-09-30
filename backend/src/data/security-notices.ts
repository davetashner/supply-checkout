// What the security notices need to remember (supply-checkout-8jc.28,
// supply-checkout-8jc.29), in the user's own `USER#<sub>` partition:
//
//   PK USER#<sub>  SK NOTICE#<kind>   noticeSentAt      when a notice of that kind last went out
//   PK USER#<sub>  SK NOTICE_ADDRESS  noticeAddress,    the verified address the account had
//                                     noticeAddressAt
//
// A change made through the account API (POST /me/password, POST
// /me/mfa/totp/verify) is emailed at once, and the same change reaches the
// security notices function later through CloudTrail. The account function
// marks the kind sent (markNoticeSent) as soon as Cognito has made the change,
// and the function sends only if it can claim the kind (claimNotice): no
// notice of that kind in the last NOTICE_DEDUPE_MS. The claim also keeps the
// two CloudTrail events of one change (VerifySoftwareToken, then
// SetUserMFAPreference) to one email.
//
// NOTICE_ADDRESS is the account's verified address before an email change,
// written the first time it's seen (GET /me, or the notices function), and
// moved to a new address only by the notices function, in the same
// conditional write that decides to tell the old one (moveNoticeAddress). So
// the old address is known even if the change finished before its CloudTrail
// event arrived, and a /me from the new address can't overwrite it.
//
// Only SECURITY_NOTICE_ATTRIBUTES are named, and nothing is returned, which is
// all the notices function's IAM policy allows. Deleting an account deletes
// these rows with the rest of the partition (deleteUserRows).

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys } from "./keys.js";

/** How long after one notice of a kind another of that kind isn't sent: longer than CloudTrail usually takes to reach EventBridge. */
export const NOTICE_DEDUPE_MS = 15 * 60_000;

const failedCondition = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";

/** Records that a notice of `kind` just went out (or is about to), whether or not one did recently. */
export async function markNoticeSent(db: Db, userId: string, kind: string, now = new Date()): Promise<void> {
  await connection(db).doc.send(
    new UpdateCommand({
      TableName: db.tableName,
      Key: keys.noticeSent(id(userId, "user ID"), kind),
      UpdateExpression: "SET #at = :at",
      ExpressionAttributeNames: { "#at": "noticeSentAt" },
      ExpressionAttributeValues: { ":at": now.toISOString() },
    }),
  );
}

/**
 * Claims a notice of `kind`: true, and it's recorded as sent, unless one went
 * out less than NOTICE_DEDUPE_MS ago (false, nothing written).
 */
export async function claimNotice(db: Db, userId: string, kind: string, now = new Date()): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.noticeSent(id(userId, "user ID"), kind),
        UpdateExpression: "SET #at = :at",
        ConditionExpression: "attribute_not_exists(#at) OR #at < :cutoff",
        ExpressionAttributeNames: { "#at": "noticeSentAt" },
        ExpressionAttributeValues: { ":at": now.toISOString(), ":cutoff": new Date(now.getTime() - NOTICE_DEDUPE_MS).toISOString() },
      }),
    );
    return true;
  } catch (error) {
    if (failedCondition(error)) return false;
    throw error;
  }
}

/** The verified address recorded for the account, if any (strongly consistent). */
export async function noticeAddress(db: Db, userId: string): Promise<string | undefined> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.noticeAddress(id(userId, "user ID")),
      ProjectionExpression: "#address",
      ExpressionAttributeNames: { "#address": "noticeAddress" },
      ConsistentRead: true,
    }),
  );
  const address = Item?.noticeAddress;
  return typeof address === "string" && address ? address : undefined;
}

/** Records `email` as the account's address if none is recorded yet. True if it was written. */
export async function recordNoticeAddress(db: Db, userId: string, email: string, now = new Date()): Promise<boolean> {
  if (!email) throw new Error("No address to record");
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.noticeAddress(id(userId, "user ID")),
        UpdateExpression: "SET #address = :address, #at = :at",
        ConditionExpression: "attribute_not_exists(#address)",
        ExpressionAttributeNames: { "#address": "noticeAddress", "#at": "noticeAddressAt" },
        ExpressionAttributeValues: { ":address": email, ":at": now.toISOString() },
      }),
    );
    return true;
  } catch (error) {
    if (failedCondition(error)) return false;
    throw error;
  }
}

/**
 * Moves the recorded address from `from` to `to`, if it's still `from`. True
 * if it moved: the caller is then the one to tell `from` (so two events for
 * one change tell it once). False, and nothing written, otherwise.
 */
export async function moveNoticeAddress(db: Db, userId: string, from: string, to: string, now = new Date()): Promise<boolean> {
  if (!from || !to) throw new Error("No address to move");
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.noticeAddress(id(userId, "user ID")),
        UpdateExpression: "SET #address = :to, #at = :at",
        ConditionExpression: "#address = :from",
        ExpressionAttributeNames: { "#address": "noticeAddress", "#at": "noticeAddressAt" },
        ExpressionAttributeValues: { ":from": from, ":to": to, ":at": now.toISOString() },
      }),
    );
    return true;
  } catch (error) {
    if (failedCondition(error)) return false;
    throw error;
  }
}
