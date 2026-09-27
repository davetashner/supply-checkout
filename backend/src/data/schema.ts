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
 * deletes), the META item's closure fields (with `purging`, the mark it sets
 * before deleting anything) and Stripe customer, and the Stripe link's team. Its IAM policy allows exactly these (dynamodb:Attributes), so it
 * deletes whole items without reading documents, emails or names.
 */
export const TEAM_PURGE_ATTRIBUTES = [PK, SK, GSI1PK, GSI1SK, "closedAt", "purgeAfter", "purging", "stripeCustomerId", "teamId"] as const;

/**
 * The only attributes the team purge's one update may name: the META item's
 * key, `purgeAfter` (its condition: a team has it exactly while it's closed,
 * since closeTeam sets it with `closedAt` and reopenTeam removes both in one
 * transaction), and the `purging` mark it sets. Its IAM policy allows
 * UpdateItem with exactly these, so a buggy update can't close or reopen a
 * team: `closedAt` isn't among them.
 */
export const TEAM_PURGE_MARK_ATTRIBUTES = [PK, SK, "purgeAfter", "purging"] as const;

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
 * status, closure and comp (closed teams get nothing; a live comp keeps an
 * ended team's notices going, ADR 0015). Its IAM policy allows exactly these (dynamodb:Attributes), so it
 * can't read documents, emails or anything else in a team's partition.
 */
export const LIVE_AUDIENCE_ATTRIBUTES = [PK, SK, "userId", "role", "status", "closedAt", "compPlan", "compUntil"] as const;

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
 * The operators' index (ADR 0015), sparse, with an INCLUDE projection of only
 * OPS_INDEX_ATTRIBUTES. It serves the ops function, whose role may query it
 * but has no read access to any TEAM# partition, so an operator can list teams
 * and read their account records without being able to read sheets or
 * inventory:
 *
 * - Every team: GSI3PK `OPS#TEAMS` (OPS_TEAMS_PARTITION), GSI3SK
 *   `<teamId>`, on the team's META item, so one team is a direct lookup.
 * - A team's owners: GSI3PK `OPS#OWNERS#<teamId>`, GSI3SK `<userId>`, on each
 *   owner's MEMBER item, and only while they're an owner.
 * - The operator audit trail by month: GSI3PK `OPS#AUDIT#<yyyy-mm>`, GSI3SK
 *   `<ts>#<eventId>`, on each operator audit item (`OPAUDIT#` partitions).
 *
 * Nothing else (sheets, products, movements, invites, imports) ever has
 * GSI3PK, so it isn't in the index: documents and imports refuse every
 * GSI<n>PK and GSI<n>SK field (isReservedField in documents.ts).
 */
export const GSI3 = "GSI3";
export const GSI3PK = "GSI3PK";
export const GSI3SK = "GSI3SK";

/** The GSI3 partition that lists every team. */
export const OPS_TEAMS_PARTITION = "OPS#TEAMS";
/** The GSI3 partition prefix of a team's owners: `OPS#OWNERS#<teamId>`. */
export const OPS_OWNERS_PREFIX = "OPS#OWNERS#";
/** The GSI3 partition prefix of the operator audit by month: `OPS#AUDIT#<yyyy-mm>`. */
export const OPS_AUDIT_INDEX_PREFIX = "OPS#AUDIT#";
/** The table partition prefix of the operator audit: `OPAUDIT#<teamId>`, or `OPAUDIT#PLATFORM` for platform actions. */
export const OPERATOR_AUDIT_PREFIX = "OPAUDIT#";

/**
 * A comp (ADR 0015): a plan an operator grants a team for a while, whatever
 * Stripe says. Separate from `plan` and `status`, which only the billing code
 * writes (ADR 0009).
 */
export const COMP_FIELDS = ["compPlan", "compSeats", "compUntil", "compReason", "compBy", "compAt"] as const;

/**
 * The only attributes the operator-access role may name when it updates an
 * item in a team's partition (dynamodb:Attributes): the keys, `type` and
 * `version` (the comp's condition), and the comp fields. So it can't change a
 * team's name, plan, status or anything else, or touch a sheet's content.
 */
export const COMP_ATTRIBUTES = [PK, SK, "type", "version", ...COMP_FIELDS] as const;

/**
 * The only attributes the operator-access role may name when it takes a
 * stuck import out of GSI1's committing-imports partition (dynamodb:Attributes):
 * the table and GSI1 keys. The update's condition (GSI1PK is that partition)
 * keeps it to an import job; IAM can't limit the sort key.
 */
export const IMPORT_INDEX_ATTRIBUTES = [PK, SK, GSI1PK, GSI1SK] as const;

/**
 * The only attributes the operator-reopen role (supply-checkout-6uw.6), which
 * the operator reopen function assumes tagged with one team, may name in
 * that team's partition, reading or updating (dynamodb:Attributes):
 * the keys, `type`, `version`, `owners` and the purge's `purging` mark (its
 * read and condition), and the closure fields it removes. Not the operator-access role: with `closedAt`
 * and `purgeAfter` it could close a team and have the purge delete it. The
 * reopen function takes no expressions from its caller and only ever removes
 * them, so the ops function can reopen a team but never close one.
 */
export const REOPEN_ATTRIBUTES = [PK, SK, "type", "version", "owners", "closedAt", "closedBy", "purgeAfter", "purging", GSI1PK, GSI1SK] as const;

/**
 * What an operator audit item holds. Owners read their own team's items
 * through the data function (OWNER_OPERATOR_AUDIT_ATTRIBUTES); operators read
 * them all through the ops function.
 */
export const OPERATOR_AUDIT_FIELDS = ["type", "eventId", "ts", "teamId", "operatorSub", "action", "target", "reason", "before", "after", "idempotencyKey"] as const;

/**
 * The only attributes the data-access role may read from its team's operator
 * audit (dynamodb:Attributes, with Select SPECIFIC_ATTRIBUTES): what happened
 * and why, never the operator's identity. Owners see the actor as "Supply
 * Checkout support" (ADR 0015).
 */
export const OWNER_OPERATOR_AUDIT_ATTRIBUTES = [PK, SK, "eventId", "ts", "action", "reason", "before", "after"] as const;

/**
 * The non-key attributes GSI3 projects (DynamoDB allows 20 per index; this
 * is all 20). Items' table keys always come along, so a team's ID is in its
 * PK, an owner's user ID in their SK, and an audit event's time and ID in
 * its SK:
 *
 * - A team's account record: never its `homeRegion` or anything about its data.
 *   `closedAt` (a closed team is read-only until the purge deletes it, and
 *   can't be comped) rather than the member count, for want of room.
 * - An owner's email and join date.
 * - An operator audit event's action and operator, for the month's summary.
 *   The reason and the before and after values are read per team, from the
 *   table (`OPAUDIT#<teamId>`).
 */
export const OPS_INDEX_ATTRIBUTES = [
  "name",
  "plan",
  "seats",
  "status",
  "trialEndsAt",
  "owners",
  "closedAt",
  "createdAt",
  "stripeCustomerId",
  "version",
  ...COMP_FIELDS,
  "email",
  "joinedAt",
  "action",
  "operatorSub",
] as const;

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
