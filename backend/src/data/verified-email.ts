// The address a user last proved with a Cognito code (supply-checkout-ytr2).
//
// After POST /me/email/verify succeeds (Cognito's VerifyUserAttribute took the
// code), the account function writes this item in the caller's own `USER#`
// partition, with its existing session scoped to that partition. The pre
// token generation trigger then records a linked user's address in
// `custom:linked_email` only when it matches this item, so a verified-looking
// email that no code proved (a provider's rewrite whose downgrade failed, or
// one Cognito verified outside the API) is never recorded. It holds a SHA-256
// of the address, not the address: the trigger needs only equality, and so a
// role that reads it learns no email.
//
//   PK USER#<sub>   SK VERIFIED_EMAIL   verifiedEmailHash, verifiedAt, type

import { createHash } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys } from "./keys.js";

/**
 * The hash the item keeps: SHA-256 (hex) of the address trimmed and with A–Z
 * lowered, and nothing else folded, so only ASCII-case-identical addresses
 * match (the same rule as the trigger's recorded-address check).
 */
export function verifiedEmailHash(email: string): string {
  const address = email.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return createHash("sha256").update(address, "utf8").digest("hex");
}

/** Records `email` as the address the user just proved with a code, replacing any earlier one. */
export async function recordVerifiedEmail(db: Db, userId: string, email: string, now = new Date()): Promise<void> {
  if (!email.trim()) throw new Error("No address to record");
  await connection(db).doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: { ...keys.verifiedEmail(id(userId, "user ID")), type: "verifiedEmail", verifiedEmailHash: verifiedEmailHash(email), verifiedAt: now.toISOString() },
    }),
  );
}

/**
 * The hash of the address the user last proved, or undefined if they never
 * did. Reads only `verifiedEmailHash` (the trigger's role allows nothing
 * else), strongly consistent, and gives up after `timeoutMs`.
 */
export async function provenEmailHash(db: Db, userId: string, options: { timeoutMs?: number } = {}): Promise<string | undefined> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.verifiedEmail(id(userId, "user ID")),
      ProjectionExpression: "#hash",
      ExpressionAttributeNames: { "#hash": "verifiedEmailHash" },
      ConsistentRead: true,
    }),
    options.timeoutMs === undefined ? undefined : { abortSignal: AbortSignal.timeout(options.timeoutMs) },
  );
  const hash = Item?.verifiedEmailHash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
}
