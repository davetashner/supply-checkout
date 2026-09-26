// The shape of the `app` table (ADR 0005). This file has no imports, so the CDK
// app in infra/ imports it too: the table it deploys and the table this module
// reads can't drift apart.

/** Key attribute names. Every item has PK and SK; some also have GSI1PK and GSI1SK. */
export const PK = "PK";
export const SK = "SK";

/**
 * One overloaded global secondary index, projecting all attributes. It serves:
 *
 * - Sheets by date: GSI1PK `TEAM#<teamId>#SHEETS`, GSI1SK `<date>#<sheetId>`.
 * - Invites by hashed token: GSI1PK `INVITE#<tokenHash>`, GSI1SK `INVITE`.
 */
export const GSI1 = "GSI1";
export const GSI1PK = "GSI1PK";
export const GSI1SK = "GSI1SK";

/**
 * Invites by the invitee's email, for the "pending invites" list at first
 * sign-in: GSI2PK `INVITEE#<sha256 of the lowercased email>`, GSI2SK
 * `INVITE#<inviteId>`. Only invite items have it (a sparse index).
 */
export const GSI2 = "GSI2";
export const GSI2PK = "GSI2PK";
export const GSI2SK = "GSI2SK";

/** Epoch seconds. DynamoDB deletes the item some time after it passes. */
export const TTL_ATTRIBUTE = "expiresAt";

/** The table's name in an environment. Global table replicas share one name. */
export function tableName(envName: string): string {
  return `supply-checkout-${envName}-app`;
}

/**
 * The only attributes the live-updates stream consumer may read (ADR 0016):
 * the keys, a MEMBER item's user ID and role, and the META item's billing
 * status. Its IAM policy allows exactly these (dynamodb:Attributes), so it
 * can't read documents, emails or anything else in a team's partition.
 */
export const LIVE_AUDIENCE_ATTRIBUTES = [PK, SK, "userId", "role", "status"] as const;

/**
 * The only attributes a request may name in another member's `USER#`
 * partition: the keys and `role`. When an owner changes a member's role or
 * removes them, the member's team-switcher row is updated (`role`, on the
 * condition that the row exists) or deleted. The account-access role allows
 * exactly these there (dynamodb:Attributes), so that session can't write any
 * other attribute, or read one back.
 */
export const MEMBER_ROW_ATTRIBUTES = [PK, SK, "role"] as const;

/**
 * The partition prefix of the per-invitee invite counters:
 * `INVITELIMIT#<sha256 of the email>`, sort key `LIMIT#INVITES#<day>`. When an
 * owner invites someone, the account function's session is tagged with the
 * invitee's hash, and that tag reaches only this partition, only with
 * UpdateItem, and only these attributes (INVITE_LIMIT_ATTRIBUTES).
 */
export const INVITE_LIMIT_PREFIX = "INVITELIMIT#";

/** The only attributes a request may name in an `INVITELIMIT#` partition: the keys, the count, its item type and its expiry. */
export const INVITE_LIMIT_ATTRIBUTES = [PK, SK, "count", "type", "expiresAt"] as const;
