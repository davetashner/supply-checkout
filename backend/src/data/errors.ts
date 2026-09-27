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

/** A version check or an existence check failed: someone else changed it first. (409) */
export class ConflictError extends Error {
  override readonly name: string = "ConflictError";
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
