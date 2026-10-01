// Errors the data layer throws. The API maps them to HTTP status codes.

/** The caller isn't a member of the team, or their role doesn't allow this. (403) */
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
}

/**
 * The team was closed (closeTeam): it's read-only until the purge deletes it.
 * (403, reason `team_closed`)
 */
export class TeamClosedError extends Error {
  override readonly name = "TeamClosedError";
}

/**
 * The team's subscription has ended (canceled, unpaid, or its first payment
 * never went through) and it has no live comp: it's read-only until an owner
 * subscribes again (ADR 0009). (403, reason `subscription_ended`)
 */
export class SubscriptionEndedError extends Error {
  override readonly name = "SubscriptionEndedError";
}

/** A version check or an existence check failed: someone else changed it first. (409) */
export class ConflictError extends Error {
  override readonly name: string = "ConflictError";
}

/**
 * A closed team is too close to its purge to reopen (reopenTeam,
 * REOPEN_CUTOFF_MINUTES): the scheduled purge may already be deleting it.
 * (409, reason `team_deleting`)
 */
export class TeamDeletingError extends ConflictError {
  override readonly name = "TeamDeletingError";
}

/**
 * A count or uncount sent with `expectedStock` (adjustStockCommand) found the
 * item's stock already changed from it: someone else moved it while the form
 * was open. (409, reason `stock_changed`)
 */
export class StockChangedError extends ConflictError {
  override readonly name = "StockChangedError";
}

/**
 * Finished Return on a sheet that still has company equipment out (ADR 0017,
 * section 3): every piece must be back, still at the job (the sheet stays
 * open) or lost or broken first. (409, reason `equipment_out`)
 */
export class EquipmentOutError extends ConflictError {
  override readonly name = "EquipmentOutError";
}

/** The change would leave the team without an owner. (409) */
export class LastOwnerError extends ConflictError {
  override readonly name = "LastOwnerError";
}

/** The team has used its monthly allowance. (429) */
export class LimitReachedError extends Error {
  override readonly name: string = "LimitReachedError";
}

/** The team has as many members as it may (memberCap), counting pending invites when inviting. (429, reason `team_full`) */
export class TeamFullError extends LimitReachedError {
  override readonly name = "TeamFullError";
}

/** The document doesn't exist, for an operation that needs it to. (404) */
export class NotFoundError extends Error {
  override readonly name = "NotFoundError";
}

/** The item would be bigger than DynamoDB's 400 KB item limit allows. (413) */
export class TooLargeError extends Error {
  override readonly name = "TooLargeError";
}

/** A key or field the caller supplied is malformed. (400) */
export class InvalidInputError extends Error {
  override readonly name = "InvalidInputError";
}

/**
 * DynamoDB's messages for an item over its 400 KB limit: a put's (a PutItem,
 * or a Put in a transaction) and an update's. Matched from the start of the
 * message, so a suffix DynamoDB adds later still matches but another message
 * that merely mentions a size doesn't.
 */
export const ITEM_TOO_LARGE_MESSAGES: readonly string[] = ["Item size has exceeded the maximum allowed size", "Item size to update has exceeded the maximum allowed size"];

/** True if `message` starts with one of `messages` (DynamoDB's own words). */
export function startsWithAny(message: unknown, messages: readonly string[]): boolean {
  const text = typeof message === "string" ? message.trim() : "";
  return messages.some((m) => text.startsWith(m));
}

/**
 * True when DynamoDB refused a write because an item would pass its 400 KB
 * limit: a ValidationException with one of ITEM_TOO_LARGE_MESSAGES, or a
 * transaction cancelled with a ValidationError reason carrying one. Any other
 * ValidationException is a bug, and surfaces as one (500).
 */
export function isItemTooLarge(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown; CancellationReasons?: { Code?: string; Message?: string }[] } | null;
  if (e?.name === "ValidationException") return startsWithAny(e.message, ITEM_TOO_LARGE_MESSAGES);
  if (e?.name !== "TransactionCanceledException") return false;
  return (e.CancellationReasons ?? []).some((r) => r?.Code === "ValidationError" && startsWithAny(r.Message, ITEM_TOO_LARGE_MESSAGES));
}

/**
 * True when DynamoDB cancelled a transaction because an item in it would pass
 * its 400 KB limit (see isItemTooLarge).
 */
export function isCancelledAsTooLarge(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "TransactionCanceledException" && isItemTooLarge(error);
}

/** Maps DynamoDB's condition failures to ConflictError and rethrows anything else. */
export function conflictOnConditionFailure(message: string): (error: unknown) => never {
  return (error: unknown) => {
    const name = (error as { name?: string } | null)?.name;
    if (name === "ConditionalCheckFailedException") throw new ConflictError(message);
    if (name === "TransactionCanceledException") {
      const reasons = (error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
      // TransactionConflict: another transaction on the same items won the race
      if (reasons.some((r) => r.Code === "ConditionalCheckFailed" || r.Code === "TransactionConflict")) {
        throw new ConflictError(message);
      }
    }
    throw error;
  };
}
