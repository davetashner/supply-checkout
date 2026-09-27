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
 * status and comp (a live comp keeps an ended team's notices going, ADR 0015). Its IAM policy allows exactly these (dynamodb:Attributes), so it
 * can't read documents, emails or anything else in a team's partition.
 */
export const LIVE_AUDIENCE_ATTRIBUTES = [PK, SK, "userId", "role", "status", "compPlan", "compUntil"] as const;

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
 *   `<createdAt>#<teamId>`, on the team's META item.
 * - A team's owners: GSI3PK `OPS#OWNERS#<teamId>`, GSI3SK `<userId>`, on each
 *   owner's MEMBER item, and only while they're an owner.
 * - The operator audit trail by month: GSI3PK `OPS#AUDIT#<yyyy-mm>`, GSI3SK
 *   `<ts>#<eventId>`, on each operator audit item (`OPAUDIT#` partitions).
 *
 * Nothing else (sheets, products, movements, invites, imports) ever has
 * GSI3PK, so it isn't in the index.
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
  "members",
  "createdAt",
  "stripeCustomerId",
  "version",
  ...COMP_FIELDS,
  "email",
  "joinedAt",
  "action",
  "operatorSub",
] as const;
