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

/** Epoch seconds. DynamoDB deletes the item some time after it passes. */
export const TTL_ATTRIBUTE = "expiresAt";

/** The table's name in an environment. Global table replicas share one name. */
export function tableName(envName: string): string {
  return `supply-checkout-${envName}-app`;
}
