// Where a project's item is (ADR 0005, supply-checkout-005.6).
//
// A project is `PROJECT#<id>` in the team's partition, with `type: "project"`,
// in the date index partition `TEAM#<teamId>#PROJECTS`. The ID only ever goes
// through the key builders, which refuse anything but letters, digits, _ and
// -, so no spelling of it reaches another team's items. Nothing reads the
// `SHEET#` items the rename moved (they're only named by projects-rename.ts).

import { GetCommand, QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError } from "./errors.js";
import { dateFormat, gsi1, keys, prefixes, teamPartition } from "./keys.js";
import type { Page } from "./query.js";
import { GSI1 } from "./schema.js";

type Item = Record<string, unknown>;

/** The key of project `projectId`'s item. */
export function projectKey(teamId: string, projectId: string): { PK: string; SK: string } {
  return keys.project(teamId, projectId);
}

/**
 * A project item's server-owned attributes: its key, its date index keys and
 * its type. A project without a valid date sorts before every dated one in
 * the index (after them, newest first) rather than dropping out.
 */
export function projectAttributes(teamId: string, projectId: string, rawDate: unknown): Item {
  let day = "";
  try {
    day = dateFormat(rawDate);
  } catch {
    // no date, or not one: sorts first
  }
  return { ...keys.project(teamId, projectId), GSI1PK: gsi1.projectsPartition(teamId), GSI1SK: `${day}#${projectId}`, type: "project" };
}

async function getItem(db: Db, key: Item): Promise<Item | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: key, ConsistentRead: true }));
  return Item;
}

/** Project `projectId`'s item, strongly consistent, keys included, or undefined. */
export async function readProjectItem(db: Db, teamId: string, projectId: string): Promise<Item | undefined> {
  return getItem(db, keys.project(teamId, projectId));
}

/** Every project in the team, strongly consistent, keys included, in no particular order. */
export async function listProjectItems(db: Db, teamId: string): Promise<Item[]> {
  const pk = teamPartition(teamId);
  const out: Item[] = [];
  let ExclusiveStartKey: Item | undefined;
  do {
    const page: QueryCommandOutput = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefixes.project },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    out.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidInputError("Invalid cursor");
  }
}

const isMap = (v: unknown): v is Item => typeof v === "object" && v !== null && !Array.isArray(v);

/** A start key from a cursor: its own attributes only, all strings, in the team's partition, with a sort key under `prefix`. */
function startKey(raw: unknown, teamId: string, prefix: string, index?: string): Item {
  const names = index ? ["PK", "SK", "GSI1PK", "GSI1SK"] : ["PK", "SK"];
  if (
    !isMap(raw) ||
    Object.keys(raw).length !== names.length ||
    !names.every((n) => typeof raw[n] === "string") ||
    raw.PK !== teamPartition(teamId) ||
    !(raw.SK as string).startsWith(prefix) ||
    (index !== undefined && raw.GSI1PK !== index)
  ) {
    throw new InvalidInputError("Invalid cursor");
  }
  return raw;
}

/** A filter on a project listing, applied after the read (DynamoDB's FilterExpression). */
export interface ProjectFilter {
  readonly expression: string;
  readonly names: Record<string, string>;
  readonly values: Record<string, unknown>;
}

/**
 * How many reads (up to 1 MB each) a filtered page makes while nothing it has
 * read matches, so a client isn't sent page after empty page. A page with any
 * match stops at its read, so it's never bigger than an unfiltered one.
 */
export const FILTERED_READS_PER_PAGE = 10;

/**
 * A page of the team's projects in ID order, strongly consistent, keys
 * included. The cursor is the last item's key.
 * With a filter (and no limit: `limit` would count the items read, not the
 * ones that match), only the items that match come back. A page reads on
 * while none has matched, up to FILTERED_READS_PER_PAGE reads, so it may still
 * be empty with a cursor.
 */
export async function projectItemsPage(
  db: Db,
  teamId: string,
  options: { readonly limit?: number; readonly cursor?: string; readonly filter?: ProjectFilter },
): Promise<Page<Item>> {
  const pk = teamPartition(teamId);
  const { limit, filter } = options;
  if (filter && limit !== undefined) throw new InvalidInputError("A filtered list takes no limit");
  let start: Item | undefined = options.cursor === undefined ? undefined : startKey(decode(options.cursor), teamId, prefixes.project);
  const items: Item[] = [];
  let reads = 0;
  do {
    const page: QueryCommandOutput = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ...filter?.values, ":pk": pk, ":prefix": prefixes.project },
        ...(filter ? { FilterExpression: filter.expression, ExpressionAttributeNames: filter.names } : {}),
        ConsistentRead: true,
        Limit: limit,
        ExclusiveStartKey: start,
      }),
    );
    reads++;
    items.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
    // A filter that has matched nothing yet reads on, so a client isn't sent page after empty page
  } while (start && filter && items.length === 0 && reads < FILTERED_READS_PER_PAGE);
  return { items, ...(start ? { cursor: encode(start) } : {}) };
}

/**
 * A page of the team's projects in date order through GSI1 (eventually
 * consistent), keys included, by `<date>#<id>`. Optionally within a date
 * range. The cursor is the last item's key.
 */
export async function projectItemsByDatePage(
  db: Db,
  teamId: string,
  options: { readonly from?: string; readonly to?: string; readonly forward: boolean; readonly limit?: number; readonly cursor?: string },
): Promise<Page<Item>> {
  const partition = gsi1.projectsPartition(teamId);
  const start = options.cursor === undefined ? undefined : startKey(decode(options.cursor), teamId, prefixes.project, partition);
  const values: Item = {};
  let range = "";
  if (options.from !== undefined || options.to !== undefined) {
    // `<date>#<id>` sorts between `<from>#` and `<to>#~` for every ID
    values[":from"] = `${dateFormat(options.from ?? "0000-01-01")}#`;
    values[":to"] = `${dateFormat(options.to ?? "9999-12-31")}#~`;
    range = " AND GSI1SK BETWEEN :from AND :to";
  }
  const page: QueryCommandOutput = await connection(db).doc.send(
    new QueryCommand({
      TableName: db.tableName,
      IndexName: GSI1,
      KeyConditionExpression: `GSI1PK = :pk${range}`,
      ExpressionAttributeValues: { ...values, ":pk": partition },
      ScanIndexForward: options.forward,
      Limit: options.limit,
      ExclusiveStartKey: start,
    }),
  );
  return { items: page.Items ?? [], ...(page.LastEvaluatedKey ? { cursor: encode(page.LastEvaluatedKey) } : {}) };
}
