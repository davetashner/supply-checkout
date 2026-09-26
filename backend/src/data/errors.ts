// Errors the data layer throws. The API maps them to HTTP status codes.

/** The caller isn't a member of the team, or their role doesn't allow this. (403) */
export class ForbiddenError extends Error {
  override readonly name = "ForbiddenError";
}

/** A version check or an existence check failed: someone else changed it first. (409) */
export class ConflictError extends Error {
  override readonly name = "ConflictError";
}

/** The team has used its monthly allowance. (429) */
export class LimitReachedError extends Error {
  override readonly name = "LimitReachedError";
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
