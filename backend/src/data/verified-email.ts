// The address a user proved with a Cognito code (supply-checkout-ytr2,
// supply-checkout-cjw7).
//
// Two items in the user's own `USER#` partition, written by the account
// function with its session scoped to that partition:
//
//   PK USER#<sub>  SK EMAIL_CODE_SENT  sentEmailHash, sentAt, expiresAt (TTL)
//   PK USER#<sub>  SK VERIFIED_EMAIL   verifiedEmailHash, verifiedAt
//
// POST /me/email/code writes EMAIL_CODE_SENT once Cognito has sent the code,
// if GetUser shows the same address before and after the send: the address
// the code went to. POST /me/email/verify records VERIFIED_EMAIL only for that
// address (the current email before and after Cognito took the code must be
// it, and the code no older than CODE_SENT_TTL_MS), and deletes
// EMAIL_CODE_SENT in the same transaction, so a code proves one address once.
// So a code sent to one address can't prove another, even if Cognito were to
// accept it after a provider rewrote the email.
//
// The pre token generation trigger records a linked user's address in
// `custom:linked_email` only when it matches VERIFIED_EMAIL and the proof is
// less than VERIFIED_EMAIL_TTL_MS old (the app refreshes its tokens right
// after the code), so an old proof can't be replayed for an address that
// comes back later. Both hold a SHA-256 of the address, not the address: only
// equality is needed, and so a role that reads them learns no email.

import { createHash } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys } from "./keys.js";

/** How long a code sent through the API may be used to prove its address (Cognito's codes last 24 hours). */
export const CODE_SENT_TTL_MS = 24 * 60 * 60 * 1000;
/** How long after a proof the trigger will still record its address. */
export const VERIFIED_EMAIL_TTL_MS = 60 * 60 * 1000;

const HASH = /^[0-9a-f]{64}$/;
/** Clock skew allowed between the function that wrote a time and the one reading it. */
const SKEW_MS = 60_000;

/**
 * The hash both items keep: SHA-256 (hex) of the address trimmed and with A–Z
 * lowered, and nothing else folded, so only ASCII-case-identical addresses
 * match (the same rule as the trigger's recorded-address check).
 */
export function verifiedEmailHash(email: string): string {
  const address = email.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return createHash("sha256").update(address, "utf8").digest("hex");
}

const address = (email: string) => {
  if (!email.trim()) throw new Error("No address to record");
  return email;
};

/** Records that a verification code was just sent to `email`, replacing any earlier record. */
export async function recordCodeSent(db: Db, userId: string, email: string, now = new Date()): Promise<void> {
  await connection(db).doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: {
        ...keys.emailCodeSent(id(userId, "user ID")),
        type: "emailCodeSent",
        sentEmailHash: verifiedEmailHash(address(email)),
        sentAt: now.toISOString(),
        expiresAt: Math.floor((now.getTime() + 2 * CODE_SENT_TTL_MS) / 1000),
      },
    }),
  );
}

/** The hash of the address the user's last code went to, if that was less than CODE_SENT_TTL_MS ago. */
export async function codeSentHash(db: Db, userId: string, now = new Date()): Promise<string | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.emailCodeSent(id(userId, "user ID")), ConsistentRead: true }));
  const hash = Item?.sentEmailHash;
  const age = now.getTime() - Date.parse(String(Item?.sentAt));
  return typeof hash === "string" && HASH.test(hash) && age >= -SKEW_MS && age <= CODE_SENT_TTL_MS ? hash : undefined;
}

/** Forgets the address the last code went to (its code was used). */
export async function clearCodeSent(db: Db, userId: string): Promise<void> {
  await connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: keys.emailCodeSent(id(userId, "user ID")) }));
}

/**
 * Records `email` as the address the user just proved with a code, replacing
 * any earlier one, and deletes EMAIL_CODE_SENT in the same transaction, on the
 * condition that it's still for this address. False when it isn't (a new code
 * was sent meanwhile), and nothing is written.
 */
export async function recordVerifiedEmail(db: Db, userId: string, email: string, now = new Date()): Promise<boolean> {
  const user = id(userId, "user ID");
  const hash = verifiedEmailHash(address(email));
  try {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: db.tableName, Item: { ...keys.verifiedEmail(user), type: "verifiedEmail", verifiedEmailHash: hash, verifiedAt: now.toISOString() } } },
          {
            Delete: {
              TableName: db.tableName,
              Key: keys.emailCodeSent(user),
              ConditionExpression: "#hash = :hash",
              ExpressionAttributeNames: { "#hash": "sentEmailHash" },
              ExpressionAttributeValues: { ":hash": hash },
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "TransactionCanceledException") return false;
    throw error;
  }
}

/**
 * The hash of the address the user proved, if they did so less than
 * VERIFIED_EMAIL_TTL_MS ago; otherwise undefined. Reads only the hash and the
 * time (the trigger's role allows nothing else), strongly consistent, and
 * gives up after `timeoutMs`.
 */
export async function provenEmailHash(db: Db, userId: string, options: { timeoutMs?: number; now?: () => number } = {}): Promise<string | undefined> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.verifiedEmail(id(userId, "user ID")),
      ProjectionExpression: "#hash, #at",
      ExpressionAttributeNames: { "#hash": "verifiedEmailHash", "#at": "verifiedAt" },
      ConsistentRead: true,
    }),
    options.timeoutMs === undefined ? undefined : { abortSignal: AbortSignal.timeout(options.timeoutMs) },
  );
  const hash = Item?.verifiedEmailHash;
  const age = (options.now ?? Date.now)() - Date.parse(String(Item?.verifiedAt));
  return typeof hash === "string" && HASH.test(hash) && age >= -SKEW_MS && age <= VERIFIED_EMAIL_TTL_MS ? hash : undefined;
}
