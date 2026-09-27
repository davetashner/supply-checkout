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
 * - Imports still committing, across every team, for the stuck-import check:
 *   GSI1PK `IMPORTS#COMMITTING` (COMMITTING_IMPORTS_PARTITION), GSI1SK
 *   `<createdAt>#<importId>`. An import job has them only while it's
 *   committing; the commit that finishes it removes them.
 * - Closed teams waiting to be deleted, across every team, for the scheduled
 *   purge: GSI1PK `TEAMS#CLOSED` (CLOSED_TEAMS_PARTITION), GSI1SK
 *   `<purgeAfter>#<teamId>`. Only a closed team's META item has them
 *   (closeTeam), and the purge deletes that item last.
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

/** The GSI1 partition of every import still committing (see GSI1). */
export const COMMITTING_IMPORTS_PARTITION = "IMPORTS#COMMITTING";

/** The GSI1 partition of every closed team, in the order they're due to be deleted (see GSI1). */
export const CLOSED_TEAMS_PARTITION = "TEAMS#CLOSED";

/**
 * The only attributes the team purge may name (ADR 0005): the table and GSI1
 * keys (a MEMBER item's sort key names the member, whose team-switcher row it
 * deletes), the META item's closure fields and Stripe customer, and the
 * Stripe link's team. Its IAM policy allows exactly these (dynamodb:Attributes), so it
 * deletes whole items without reading documents, emails or names.
 */
export const TEAM_PURGE_ATTRIBUTES = [PK, SK, GSI1PK, GSI1SK, "closedAt", "purgeAfter", "stripeCustomerId", "teamId"] as const;

/**
 * The only attributes the stuck-import check may name or read (ADR 0005): the
 * table and GSI1 keys (the team is in PK, the import in SK, the start time in
 * GSI1SK) and the job's progress. Its IAM policy allows exactly these
 * (dynamodb:Attributes), on COMMITTING_IMPORTS_PARTITION of GSI1 only, so it
 * can't read a team's data, a job's plan or who started it.
 */
export const STUCK_IMPORT_ATTRIBUTES = [PK, SK, GSI1PK, GSI1SK, "committed", "total"] as const;

/** Epoch seconds. DynamoDB deletes the item some time after it passes. */
export const TTL_ATTRIBUTE = "expiresAt";

/** The table's name in an environment. Global table replicas share one name. */
export function tableName(envName: string): string {
  return `supply-checkout-${envName}-app`;
}

/**
 * The only attributes the live-updates stream consumer may read (ADR 0016):
 * the keys, a MEMBER item's user ID and role, and the META item's billing
 * status and closure. Its IAM policy allows exactly these (dynamodb:Attributes), so it
 * can't read documents, emails or anything else in a team's partition.
 */
export const LIVE_AUDIENCE_ATTRIBUTES = [PK, SK, "userId", "role", "status", "closedAt"] as const;

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

/**
 * The sort key of the item in a user's own `USER#<sub>` partition that holds
 * the address they last proved with a Cognito code through the account API
 * (POST /me/email/verify, supply-checkout-ytr2): see verified-email.ts. Not a
 * `LIMIT#` key, so deleting an account removes it with the user's other rows.
 */
export const VERIFIED_EMAIL_SK = "VERIFIED_EMAIL";

/**
 * The only attributes the pre token generation trigger may name or read: the
 * keys, the proven address's hash and when it was proven (the trigger honours
 * a proof only for VERIFIED_EMAIL_TTL_MS). Its IAM policy allows exactly these
 * (dynamodb:Attributes), with GetItem only, in `USER#` partitions only, so it
 * can't read a user's teams, names or emails. No other item has
 * `verifiedEmailHash` or `verifiedAt`.
 */
export const VERIFIED_EMAIL_ATTRIBUTES = [PK, SK, "verifiedEmailHash", "verifiedAt"] as const;

/**
 * The sort key of the item in a user's own partition that holds the address
 * the last verification code was sent to (POST /me/email/code): its hash and
 * when. The verify route records a proof only for that address (see
 * verified-email.ts). Not a `LIMIT#` key, so deleting an account removes it.
 */
export const EMAIL_CODE_SENT_SK = "EMAIL_CODE_SENT";
