// What the security notices need to remember (supply-checkout-8jc.28,
// supply-checkout-8jc.29), in the user's own `USER#<sub>` partition:
//
//   PK USER#<sub>  SK NOTICE#<kind>   noticeSentAt      when a notice of that kind last went out
//                                     (noticeFor)       for emailChanged: the address it was about (emailSeenHash)
//   PK USER#<sub>  SK NOTICE_ADDRESS  noticeAddress,    the address to tell of an email change: always one
//                                     noticeAddressAt   the account API trusted, normalized
//                                     noticeSeenHash    emailSeenHash of the Cognito address last accounted for
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
// written the first time it's seen (the post confirmation and pre token
// generation triggers, identity/notice-address.ts; GET /me; the notices
// function; or the owner's one-time backfill, supply-checkout-8jc.31), never
// for an account being deleted (the DELETING mark is checked in the same
// transaction), and moved on only by the notices function, after it has told
// the old one (moveNoticeAddress). So the old address is known even if the
// change finished before its CloudTrail event arrived, and a /me from the new
// address can't overwrite it. Whether the email changed is decided on
// noticeSeenHash, a hash of Cognito's own address only trimmed and lowered,
// so an address the app can't normalize (too long, say) or one NFKC would
// fold into the recorded one still counts as a change.
//
// Only SECURITY_NOTICE_ATTRIBUTES are named, and nothing is returned, which is
// all the notices function's IAM policy allows. Deleting an account deletes
// these rows with the rest of the partition (deleteUserRows).

import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys } from "./keys.js";

/** How long after one notice of a kind another of that kind isn't sent: longer than CloudTrail usually takes to reach EventBridge. */
export const NOTICE_DEDUPE_MS = 15 * 60_000;

/**
 * How long a claim on an email change notice holds: just over the function's
 * 30-second timeout, while one attempt sends. What stops a second notice once
 * it's sent is the record moving on, so a claim left by an attempt that died
 * has lapsed by Lambda's retry (about a minute later), which sends it.
 */
export const EMAIL_CHANGE_CLAIM_MS = 45_000;

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

/** A hash of an address as Cognito holds it, only trimmed and lowered: what "the email changed" compares. */
export function emailSeenHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

export interface NoticeAddressRecord {
  /** The address to tell of an email change. */
  readonly address: string;
  /** emailSeenHash of the Cognito address last accounted for. */
  readonly seen: string;
}

/** The recorded address, if any (strongly consistent). */
export async function noticeAddress(db: Db, userId: string): Promise<NoticeAddressRecord | undefined> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.noticeAddress(id(userId, "user ID")),
      ProjectionExpression: "#address, #seen",
      ExpressionAttributeNames: { "#address": "noticeAddress", "#seen": "noticeSeenHash" },
      ConsistentRead: true,
    }),
  );
  const address = Item?.noticeAddress;
  if (typeof address !== "string" || !address) return undefined;
  const seen = Item?.noticeSeenHash;
  return { address, seen: typeof seen === "string" && seen ? seen : emailSeenHash(address) };
}

/** For a caller with a deadline (the user pool's triggers): each request gives up after `timeoutMs`. */
export interface NoticeCallOptions {
  readonly timeoutMs?: number;
}

const sendOptions = (options: NoticeCallOptions) => (options.timeoutMs === undefined ? undefined : { abortSignal: AbortSignal.timeout(options.timeoutMs) });

/**
 * Whether an address is recorded (strongly consistent), reading only when it
 * was recorded (NOTICE_ADDRESS_CHECK_ATTRIBUTES), never the address itself:
 * what the user pool's triggers check before they record one
 * (supply-checkout-8jc.31). recordNoticeAddress sets the time with the
 * address, and nothing else writes the item.
 */
export async function hasNoticeAddress(db: Db, userId: string, options: NoticeCallOptions = {}): Promise<boolean> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.noticeAddress(id(userId, "user ID")),
      ProjectionExpression: "#at",
      ExpressionAttributeNames: { "#at": "noticeAddressAt" },
      ConsistentRead: true,
    }),
    sendOptions(options),
  );
  return typeof Item?.noticeAddressAt === "string";
}

/**
 * Records `email` (normalized, one the account API trusts) as the address to
 * tell, and `seen` as the Cognito address it came from, if none is recorded
 * yet and the account isn't being deleted. True if it was written.
 */
export async function recordNoticeAddress(db: Db, userId: string, email: string, seen: string, now = new Date(), options: NoticeCallOptions = {}): Promise<boolean> {
  if (!email || !seen) throw new Error("No address to record");
  const user = id(userId, "user ID");
  try {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: db.tableName,
              Key: keys.noticeAddress(user),
              UpdateExpression: "SET #address = :address, #at = :at, #seen = :seen",
              ConditionExpression: "attribute_not_exists(#address)",
              ExpressionAttributeNames: { "#address": "noticeAddress", "#at": "noticeAddressAt", "#seen": "noticeSeenHash" },
              ExpressionAttributeValues: { ":address": email, ":at": now.toISOString(), ":seen": seen },
            },
          },
          // Not for an account being deleted: its rows are going, and this one holds an address
          { ConditionCheck: { TableName: db.tableName, Key: keys.accountDeletion(user), ConditionExpression: "attribute_not_exists(PK)" } },
        ],
      }),
      sendOptions(options),
    );
    return true;
  } catch (error) {
    // Not recorded only when a condition said so (an address there, or the DELETING mark); a
    // conflict, throttle or validation error is thrown, so the caller counts and retries it
    const cancelled = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
    const codes = cancelled?.name === "TransactionCanceledException" ? (cancelled.CancellationReasons ?? []).map((r) => r?.Code) : [];
    if (codes.includes("ConditionalCheckFailed") && codes.every((code) => code === "ConditionalCheckFailed" || code === "None")) return false;
    throw error;
  }
}

/**
 * Moves the record on to the Cognito address `seen` (and to `address`, the
 * address to tell next), if it's still at `from`. True if it moved; false,
 * and nothing written, if another event moved it first.
 */
export async function moveNoticeAddress(db: Db, userId: string, from: string, seen: string, address: string, now = new Date()): Promise<boolean> {
  if (!from || !seen || !address) throw new Error("No address to move");
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.noticeAddress(id(userId, "user ID")),
        UpdateExpression: "SET #address = :address, #seen = :seen, #at = :at",
        ConditionExpression: "#seen = :from",
        ExpressionAttributeNames: { "#address": "noticeAddress", "#seen": "noticeSeenHash", "#at": "noticeAddressAt" },
        ExpressionAttributeValues: { ":from": from, ":seen": seen, ":address": address, ":at": now.toISOString() },
      }),
    );
    return true;
  } catch (error) {
    if (failedCondition(error)) return false;
    throw error;
  }
}

/**
 * Claims the email change notice about the Cognito address `seen`: true
 * unless another attempt claimed it less than EMAIL_CHANGE_CLAIM_MS ago.
 */
export async function claimEmailChangeNotice(db: Db, userId: string, seen: string, now = new Date()): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.noticeSent(id(userId, "user ID"), "emailChanged"),
        UpdateExpression: "SET #at = :at, #for = :for",
        ConditionExpression: "attribute_not_exists(#at) OR #at < :cutoff OR #for <> :for",
        ExpressionAttributeNames: { "#at": "noticeSentAt", "#for": "noticeFor" },
        ExpressionAttributeValues: { ":at": now.toISOString(), ":for": seen, ":cutoff": new Date(now.getTime() - EMAIL_CHANGE_CLAIM_MS).toISOString() },
      }),
    );
    return true;
  } catch (error) {
    if (failedCondition(error)) return false;
    throw error;
  }
}

/** When the email change notice was last claimed, if it was (strongly consistent). */
export async function emailChangeClaimedAt(db: Db, userId: string): Promise<Date | undefined> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.noticeSent(id(userId, "user ID"), "emailChanged"),
      ProjectionExpression: "#at",
      ExpressionAttributeNames: { "#at": "noticeSentAt" },
      ConsistentRead: true,
    }),
  );
  const at = Date.parse(String(Item?.noticeSentAt));
  return Number.isFinite(at) ? new Date(at) : undefined;
}

/** Gives up a claim on the email change notice about `seen` that couldn't be sent, so a retry can send it. */
export async function releaseEmailChangeNotice(db: Db, userId: string, seen: string): Promise<void> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.noticeSent(id(userId, "user ID"), "emailChanged"),
        UpdateExpression: "REMOVE #at, #for",
        ConditionExpression: "#for = :for",
        ExpressionAttributeNames: { "#at": "noticeSentAt", "#for": "noticeFor" },
        ExpressionAttributeValues: { ":for": seen },
      }),
    );
  } catch (error) {
    if (!failedCondition(error)) throw error;
  }
}
