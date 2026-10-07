// Where a project's item is through the sheets-to-projects rename
// (supply-checkout-005.6, docs/projects-rename-plan.md).
//
// Projects were called sheets. New projects are written under
// `PROJECT#<id>`, with `type: "project"`, in the date index partition
// `TEAM#<teamId>#PROJECTS`. Until the rename's backfill has moved every old
// item, a project can still be under `SHEET#<id>` (`type: "sheet"`, index
// partition `TEAM#<teamId>#SHEETS`). So, through the window:
//
// - A read of one project looks for `PROJECT#<id>` first, then `SHEET#<id>`,
//   both in the caller's team partition: the ID only ever goes through the
//   key builders, which refuse anything but letters, digits, _ and -, so no
//   spelling of it reaches another team's items.
// - A write to a project that exists goes back to the key it was read from,
//   on a condition the read decides (its version, usually). A write never
//   moves an item: the backfill does, in one transaction, so a write racing
//   it fails its condition and is read again from the new key.
// - A new project is always `PROJECT#`.
// - Lists read both prefixes (and both index partitions), and drop a
//   `SHEET#` item whose `PROJECT#` twin exists, which only a manual mix
//   could leave (the backfill never does).
//
// Server release 2 (plan section 3, step 5) removes the `SHEET#` half, with
// legacy-sheets.ts.

import { GetCommand, QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError } from "./errors.js";
import { date as checkDate, gsi1, keys, prefixes, teamPartition } from "./keys.js";
import { legacy } from "./legacy-sheets.js";
import type { Page } from "./query.js";
import { GSI1 } from "./schema.js";

type Item = Record<string, unknown>;

/** Where a project's item is: the new layout, or the old one the backfill hasn't moved yet. */
export type ProjectLayout = "project" | typeof legacy.sheetType;

/** The layout of a stored project item, by its sort key. */
export function layoutOf(item: Item | undefined): ProjectLayout {
  return typeof item?.SK === "string" && item.SK.startsWith(legacy.sheetPrefix) ? legacy.sheetType : "project";
}

/** The key of project `projectId`'s item in `layout`. */
export function projectKey(teamId: string, projectId: string, layout: ProjectLayout): { PK: string; SK: string } {
  return layout === legacy.sheetType ? legacy.sheetKey(teamId, projectId) : keys.project(teamId, projectId);
}

/**
 * The key a write to project `projectId` goes to: the item's own key when it
 * was read (`item`, from readProjectItem), otherwise the new layout's.
 */
export function projectKeyFor(teamId: string, projectId: string, item: Item | undefined): { PK: string; SK: string } {
  return projectKey(teamId, projectId, layoutOf(item));
}

/**
 * A project item's server-owned attributes in `layout`: its key, its date
 * index keys and its type. A project without a valid date sorts before every
 * dated one in the index (after them, newest first) rather than dropping out.
 */
export function projectAttributes(teamId: string, projectId: string, rawDate: unknown, layout: ProjectLayout): Item {
  let day = "";
  try {
    day = checkDate(rawDate);
  } catch {
    // no date, or not one: sorts first
  }
  const partition = layout === legacy.sheetType ? legacy.sheetsPartition(teamId) : gsi1.projectsPartition(teamId);
  return { ...projectKey(teamId, projectId, layout), GSI1PK: partition, GSI1SK: `${day}#${projectId}`, type: layout };
}

async function getItem(db: Db, key: Item): Promise<Item | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: key, ConsistentRead: true }));
  return Item;
}

/**
 * Project `projectId`'s item, strongly consistent, keys included: under
 * `PROJECT#` if it's there, otherwise under `SHEET#`, otherwise undefined.
 * Both reads are in the team's partition.
 */
export async function readProjectItem(db: Db, teamId: string, projectId: string): Promise<Item | undefined> {
  const [current, old] = await Promise.all([getItem(db, keys.project(teamId, projectId)), getItem(db, legacy.sheetKey(teamId, projectId))]);
  return current ?? old;
}

/** The project ID in a project item's sort key. */
function idOf(item: Item): string {
  const sk = String(item.SK);
  return sk.slice((sk.startsWith(legacy.sheetPrefix) ? legacy.sheetPrefix : prefixes.project).length);
}

/** How many twin checks (GetItem) are in flight at once. */
const TWIN_CHECKS_AT_ONCE = 25;

/**
 * The IDs among `ids` that also have a `PROJECT#` item: one consistent,
 * keys-only GetItem each in the team's partition, so the cost is bounded by
 * the page, not the team. Runs only for a page with `SHEET#` items (the
 * rename's window, until the backfill), and never after it.
 */
async function withProjectItem(db: Db, teamId: string, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += TWIN_CHECKS_AT_ONCE) {
    await Promise.all(
      ids.slice(i, i + TWIN_CHECKS_AT_ONCE).map(async (id) => {
        const { Item } = await connection(db).doc.send(
          new GetCommand({ TableName: db.tableName, Key: keys.project(teamId, id), ProjectionExpression: "#sk", ExpressionAttributeNames: { "#sk": "SK" }, ConsistentRead: true }),
        );
        if (Item) found.add(id);
      }),
    );
  }
  return found;
}

/**
 * `items` without the `SHEET#` ones whose `PROJECT#` twin exists. A twin in
 * `items` needs no read; `complete` says `items` holds every `PROJECT#` item
 * in the team, so nothing else does either.
 */
async function withoutTwins(db: Db, teamId: string, items: Item[], complete = false): Promise<Item[]> {
  const old = items.filter((item) => layoutOf(item) === legacy.sheetType).map(idOf);
  if (old.length === 0) return items;
  const here = new Set(items.filter((item) => layoutOf(item) === "project").map(idOf));
  const moved = complete ? here : new Set([...here, ...(await withProjectItem(db, teamId, old.filter((id) => !here.has(id))))]);
  return items.filter((item) => layoutOf(item) === "project" || !moved.has(idOf(item)));
}

/** Every project in the team, strongly consistent, keys included, in no particular order. */
export async function listProjectItems(db: Db, teamId: string): Promise<Item[]> {
  const pk = teamPartition(teamId);
  const out: Item[] = [];
  for (const prefix of [prefixes.project, legacy.sheetPrefix]) {
    let ExclusiveStartKey: Item | undefined;
    do {
      const page: QueryCommandOutput = await connection(db).doc.send(
        new QueryCommand({
          TableName: db.tableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ConsistentRead: true,
          ExclusiveStartKey,
        }),
      );
      out.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }
  // Every PROJECT# item is in `out`, so no reads are needed to find twins
  return withoutTwins(db, teamId, out, true);
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

const keyOf = (item: Item, index: boolean): Item =>
  index ? { PK: item.PK, SK: item.SK, GSI1PK: item.GSI1PK, GSI1SK: item.GSI1SK } : { PK: item.PK, SK: item.SK };

/**
 * A page of the team's projects in ID order, strongly consistent, keys
 * included: every `PROJECT#` item, then every `SHEET#` one. The cursor is the
 * last item's key, so it says which of the two a next page continues.
 */
export async function projectItemsPage(db: Db, teamId: string, options: { readonly limit?: number; readonly cursor?: string }): Promise<Page<Item>> {
  const pk = teamPartition(teamId);
  const { limit } = options;
  let start: Item | undefined;
  let phase = 0;
  if (options.cursor !== undefined) {
    const raw = decode(options.cursor);
    phase = isMap(raw) && typeof raw.SK === "string" && raw.SK.startsWith(legacy.sheetPrefix) ? 1 : 0;
    start = startKey(raw, teamId, phase ? legacy.sheetPrefix : prefixes.project);
  }
  const items: Item[] = [];
  let cursor: string | undefined;
  for (; phase < 2; phase++) {
    const left = limit === undefined ? undefined : limit - items.length;
    const page: QueryCommandOutput = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": phase ? legacy.sheetPrefix : prefixes.project },
        ConsistentRead: true,
        Limit: left,
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(page.Items ?? []));
    start = undefined;
    if (page.LastEvaluatedKey) {
      cursor = encode(page.LastEvaluatedKey);
      break;
    }
    // A full page that ended the `PROJECT#` items: the next page starts after its last one, and finds the `SHEET#` ones
    if (limit !== undefined && items.length >= limit && phase === 0) {
      cursor = encode(keyOf(items[items.length - 1] as Item, false));
      break;
    }
  }
  return { items: await withoutTwins(db, teamId, items), ...(cursor ? { cursor } : {}) };
}

/** Where a date listing is in one index partition: a start key, at its start (null), or finished ("done"). */
type Position = Item | null | "done";

/**
 * A page of the team's projects in date order through GSI1 (eventually
 * consistent), keys included: the `TEAM#<t>#PROJECTS` and `TEAM#<t>#SHEETS`
 * index partitions merged, by `<date>#<id>`. Optionally within a date range.
 * The cursor holds where each partition is.
 */
export async function projectItemsByDatePage(
  db: Db,
  teamId: string,
  options: { readonly from?: string; readonly to?: string; readonly forward: boolean; readonly limit?: number; readonly cursor?: string },
): Promise<Page<Item>> {
  const partitions = [gsi1.projectsPartition(teamId), legacy.sheetsPartition(teamId)] as const;
  const skPrefixes = [prefixes.project, legacy.sheetPrefix] as const;
  let positions: Position[] = [null, null];
  if (options.cursor !== undefined) {
    const raw = decode(options.cursor);
    if (!isMap(raw) || !Array.isArray(raw.at) || raw.at.length !== 2 || Object.keys(raw).length !== 1) throw new InvalidInputError("Invalid cursor");
    positions = raw.at.map((p: unknown, n: number): Position => (p === "done" || p === null ? p : startKey(p, teamId, skPrefixes[n] as string, partitions[n])));
  }
  const values: Item = {};
  let range = "";
  if (options.from !== undefined || options.to !== undefined) {
    // `<date>#<id>` sorts between `<from>#` and `<to>#~` for every ID
    values[":from"] = `${checkDate(options.from ?? "0000-01-01")}#`;
    values[":to"] = `${checkDate(options.to ?? "9999-12-31")}#~`;
    range = " AND GSI1SK BETWEEN :from AND :to";
  }
  const fetched = await Promise.all(
    positions.map(async (position, n) => {
      if (position === "done") return { items: [] as Item[], more: false };
      const page: QueryCommandOutput = await connection(db).doc.send(
        new QueryCommand({
          TableName: db.tableName,
          IndexName: GSI1,
          KeyConditionExpression: `GSI1PK = :pk${range}`,
          ExpressionAttributeValues: { ...values, ":pk": partitions[n] },
          ScanIndexForward: options.forward,
          Limit: options.limit,
          ExclusiveStartKey: position ?? undefined,
        }),
      );
      return { items: page.Items ?? [], more: page.LastEvaluatedKey !== undefined };
    }),
  );
  // `<date>#<id>`, then the partition, so the order is total
  const order = (a: { item: Item; n: number }, b: { item: Item; n: number }) => {
    const x = `${String(a.item.GSI1SK)}\u0000${a.n}`;
    const y = `${String(b.item.GSI1SK)}\u0000${b.n}`;
    return (x < y ? -1 : x > y ? 1 : 0) * (options.forward ? 1 : -1);
  };
  const merged = fetched.flatMap((f, n) => f.items.map((item) => ({ item, n }))).sort(order);
  // Only what sorts before every partition's unread items can go on this page
  const frontiers = fetched.flatMap((f, n) => (f.more && f.items.length ? [{ item: f.items[f.items.length - 1] as Item, n }] : []));
  const taken: { item: Item; n: number }[] = [];
  for (const entry of merged) {
    if (options.limit !== undefined && taken.length >= options.limit) break;
    if (frontiers.some((f) => order(entry, f) > 0)) break;
    taken.push(entry);
  }
  const next: Position[] = positions.map((position, n) => {
    if (position === "done") return "done";
    const mine = taken.filter((t) => t.n === n);
    const all = mine.length === (fetched[n] as { items: Item[] }).items.length;
    if (all && !(fetched[n] as { more: boolean }).more) return "done";
    return mine.length ? keyOf((mine[mine.length - 1] as { item: Item }).item, true) : position;
  });
  const items = await withoutTwins(db, teamId, taken.map((t) => t.item));
  return { items, ...(next.every((p) => p === "done") ? {} : { cursor: encode({ at: next }) }) };
}
