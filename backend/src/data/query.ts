import { QueryCommand, type QueryCommandInput } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError } from "./errors.js";
import { strip } from "./keys.js";

/** Every item under a partition whose sort key starts with `prefix`, following pages. */
export async function queryAll<T>(db: Db, pk: string, prefix: string): Promise<T[]> {
  const out: T[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) out.push(strip<T>(item) as T);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

export interface Page<T> {
  readonly items: T[];
  /** Pass back to get the next page; absent on the last page. */
  readonly cursor?: string;
}

/**
 * One page of a query. The cursor is opaque to clients, and a cursor from
 * another partition is rejected, so it can't be used to read another team.
 */
export async function queryPage<T>(
  db: Db,
  input: Omit<QueryCommandInput, "TableName" | "ExclusiveStartKey">,
  partition: { readonly attribute: string; readonly value: string },
  cursor: string | undefined,
  options: { readonly keepKeys?: boolean } = {},
): Promise<Page<T>> {
  const page = await connection(db).doc.send(
    new QueryCommand({ ...input, TableName: db.tableName, ExclusiveStartKey: decodeCursor(cursor, partition) }),
  );
  return {
    items: (page.Items ?? []).map((item) => (options.keepKeys ? item : strip<T>(item)) as T),
    cursor: page.LastEvaluatedKey ? Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString("base64url") : undefined,
  };
}

function decodeCursor(
  cursor: string | undefined,
  partition: { readonly attribute: string; readonly value: string },
): Record<string, unknown> | undefined {
  if (cursor === undefined) return undefined;
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidInputError("Invalid cursor");
  }
  if (
    typeof key !== "object" || key === null || Array.isArray(key) ||
    (key as Record<string, unknown>)[partition.attribute] !== partition.value ||
    !Object.values(key).every((v) => typeof v === "string")
  ) {
    throw new InvalidInputError("Invalid cursor");
  }
  return key as Record<string, unknown>;
}

/** `SET a = :a, ..., version = version + 1` with a version check. */
export function versionedSet(fields: Record<string, unknown>, expectedVersion: number) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new InvalidInputError("Invalid version");
  const names: Record<string, string> = { "#version": "version" };
  const values: Record<string, unknown> = { ":expected": expectedVersion, ":one": 1 };
  const sets = ["#version = #version + :one"];
  Object.entries(fields).forEach(([field, value], i) => {
    names[`#f${i}`] = field;
    values[`:f${i}`] = value;
    sets.push(`#f${i} = :f${i}`);
  });
  return {
    UpdateExpression: `SET ${sets.join(", ")}`,
    ConditionExpression: "attribute_exists(PK) AND #version = :expected",
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}
