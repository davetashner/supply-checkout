// One-off migrations of items written before a change, run by the owner with
// scripts/backfill.ts (docs/infrastructure.md, "Backfills"). Not exported from
// index.ts: no Lambda runs these, and no Lambda role may Scan the table.
//
// - members: a team made before PR #93 has no `members` count on its META
//   item, so the join-during-deletion guard (teamCounts) can't protect it
//   until its next membership change. This counts its MEMBER items and sets
//   it, on the condition that it's still absent.
// - ops-index: a team made before PR #99 has no GSI3 keys, so the ops routes
//   don't list it. This sets them on its META item and its owners' MEMBER
//   items, on the condition that they're still absent (and, for a member,
//   that they're still an owner).
// - stray-ops-keys: an item with GSI3 keys it shouldn't have (a forged
//   document field from before documents refused them, or a non-owner's
//   MEMBER item) would put values in the operators' index. This removes them,
//   on the condition that they're still the values it read.
//
// - notice-address: an account that hasn't loaded the app (GET /me) since
//   PR #278 has no NOTICE_ADDRESS, so its first email change is recorded but
//   nobody is told (supply-checkout-8jc.31). This records the address for
//   every user in the app pool the account API would trust (the script lists
//   the pool and decides that, identity/notice-address.ts), with
//   recordNoticeAddress: never over one already recorded, never for an
//   account being deleted. It reads only whether one is recorded, never the
//   address.
//
// Every write is conditioned on the item still existing, so a team the purge
// deleted in the meantime is never re-created as a stub. Closed teams stay in
// the index until the purge deletes them, as a team made today does.
//
// - projects-rename (projects-rename.ts, supply-checkout-005.6.2): moves
//   sheet items to project keys and renames the sheet attributes on
//   movements, with --reverse for a rollback, and verifies afterwards. It has
//   options of its own, so the CLI runs it with renameProjects, not
//   runBackfill.
//
// A dry run reads the same items and writes nothing. The reports hold counts
// and, for strays, only the item's partition type and team ID: never emails,
// names or user IDs.

import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { gsi3, keys, prefixes } from "./keys.js";
import { GSI3PK, GSI3SK, OPERATOR_AUDIT_PREFIX, OPS_AUDIT_INDEX_PREFIX } from "./schema.js";
import { hasNoticeAddress, recordNoticeAddress } from "./security-notices.js";

export { MAX_ATTEMPTS as RENAME_MAX_ATTEMPTS, renameProjects, type ExportedTeam, type ProjectsRenameOptions, type ProjectsRenameReport } from "./projects-rename.js";

export const BACKFILL_MODES = ["members", "ops-index", "stray-ops-keys", "notice-address"] as const;
export type BackfillMode = (typeof BACKFILL_MODES)[number];

export interface BackfillOptions {
  /** Write the changes. Without it, a dry run: read everything, write nothing. */
  readonly apply: boolean;
}

/** One app pool user whose address the account API trusts: their sub, the address (normalized) and the hash of Cognito's own address. */
export interface NoticeAddressCandidate {
  readonly userId: string;
  readonly address: string;
  readonly seen: string;
}

/** What modes that don't scan the table read instead. */
export interface BackfillSources {
  /** notice-address: every user in the app pool, undefined for one with no address the API trusts. */
  readonly accounts?: AsyncIterable<NoticeAddressCandidate | undefined>;
}

export interface BackfillReport {
  readonly mode: BackfillMode;
  readonly apply: boolean;
  /** Items the scan found that need the change. */
  readonly found: number;
  /** Items changed (or, in a dry run, that would be). */
  readonly changed: number;
  /** Items whose condition failed at write time: something else set (or removed) the value first. */
  readonly raced: number;
  /** Items whose keys aren't valid IDs, left alone. */
  readonly invalid: number;
  /** For stray-ops-keys: how many strays of each kind, e.g. `TEAM# SHEET`, with the team ID where there is one. */
  readonly strays?: readonly string[];
  /** For notice-address: the users listed, and those left alone before any write. */
  readonly accounts?: { readonly listed: number; readonly untrusted: number; readonly present: number; readonly deleting: number };
}

const TEAM = "TEAM#";
const META = "META";
const AUDIT = "AUDIT#";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

type Item = Record<string, unknown>;

/** Every item matching the filter, strongly consistent, with only the projected attributes. */
async function* scan(db: Db, input: { FilterExpression: string; ProjectionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> }) {
  let ExclusiveStartKey: Item | undefined;
  do {
    const page = await connection(db).doc.send(new ScanCommand({ TableName: db.tableName, ConsistentRead: true, ExclusiveStartKey, ...input }));
    yield* (page.Items ?? []) as Item[];
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

/** A conditional update: true when written, false when its condition failed. */
async function conditionalUpdate(db: Db, input: Omit<ConstructorParameters<typeof UpdateCommand>[0], "TableName">): Promise<boolean> {
  try {
    await connection(db).doc.send(new UpdateCommand({ TableName: db.tableName, ...input }));
    return true;
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** The ID after a prefix, or undefined if it isn't a valid ID. */
function idAfter(value: unknown, prefix: string): string | undefined {
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  const rest = value.slice(prefix.length);
  return ID.test(rest) ? rest : undefined;
}

/** Counts a team's MEMBER items, strongly consistent, reading only their keys. */
async function countMembers(db: Db, pk: string): Promise<number> {
  let count = 0;
  let ExclusiveStartKey: Item | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefixes.member },
        ProjectionExpression: "PK, SK",
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    count += page.Items?.length ?? 0;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

/** Sets `members` on every team META item that lacks it, from its MEMBER items. */
export async function backfillMemberCounts(db: Db, { apply }: BackfillOptions): Promise<BackfillReport> {
  let found = 0, changed = 0, raced = 0, invalid = 0;
  const teams = scan(db, {
    // MEMBERS is a DynamoDB reserved word
    FilterExpression: "SK = :meta AND begins_with(PK, :team) AND attribute_not_exists(#members)",
    ProjectionExpression: "PK, SK",
    ExpressionAttributeNames: { "#members": "members" },
    ExpressionAttributeValues: { ":meta": META, ":team": TEAM },
  });
  for await (const item of teams) {
    found++;
    if (!idAfter(item.PK, TEAM)) {
      invalid++;
      continue;
    }
    const members = await countMembers(db, item.PK as string);
    if (!apply) {
      changed++;
      continue;
    }
    // A membership change that commits after the count sets `members` itself
    // (teamCounts), so this condition fails rather than leave a wrong count.
    const written = await conditionalUpdate(db, {
      Key: { PK: item.PK, SK: META },
      UpdateExpression: "SET #members = :members",
      ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(#members)",
      ExpressionAttributeNames: { "#members": "members" },
      ExpressionAttributeValues: { ":members": members },
    });
    if (written) changed++;
    else raced++;
  }
  return { mode: "members", apply, found, changed, raced, invalid };
}

/** Sets GSI3 keys on every team META item and owner MEMBER item that lacks them. */
export async function backfillOpsIndex(db: Db, { apply }: BackfillOptions): Promise<BackfillReport> {
  let found = 0, changed = 0, raced = 0, invalid = 0;
  const items = scan(db, {
    // ROLE is a DynamoDB reserved word
    FilterExpression:
      "begins_with(PK, :team) AND attribute_not_exists(GSI3PK) AND attribute_not_exists(GSI3SK) AND (SK = :meta OR (begins_with(SK, :member) AND #role = :owner))",
    ProjectionExpression: "PK, SK, #role",
    ExpressionAttributeNames: { "#role": "role" },
    ExpressionAttributeValues: { ":team": TEAM, ":meta": META, ":member": prefixes.member, ":owner": "owner" },
  });
  for await (const item of items) {
    found++;
    const teamId = idAfter(item.PK, TEAM);
    const userId = item.SK === META ? undefined : idAfter(item.SK, prefixes.member);
    if (!teamId || (item.SK !== META && !userId)) {
      invalid++;
      continue;
    }
    if (!apply) {
      changed++;
      continue;
    }
    const owner = userId !== undefined;
    const index = owner ? gsi3.owner(teamId, userId) : gsi3.team(teamId);
    // Never over a newer value; and a member demoted since the scan stays out.
    const written = await conditionalUpdate(db, {
      Key: { PK: item.PK, SK: item.SK },
      UpdateExpression: "SET GSI3PK = :gpk, GSI3SK = :gsk",
      ConditionExpression: `attribute_exists(PK) AND attribute_not_exists(GSI3PK) AND attribute_not_exists(GSI3SK)${owner ? " AND #role = :owner" : ""}`,
      ...(owner ? { ExpressionAttributeNames: { "#role": "role" } } : {}),
      ExpressionAttributeValues: { ":gpk": index.GSI3PK, ":gsk": index.GSI3SK, ...(owner ? { ":owner": "owner" } : {}) },
    });
    if (written) changed++;
    else raced++;
  }
  return { mode: "ops-index", apply, found, changed, raced, invalid };
}

/**
 * The GSI3 keys an item should have (schema.ts), or undefined for none: a
 * team's META item, an owner's MEMBER item and an operator audit event.
 */
export function expectedOpsKeys(item: Item): { GSI3PK: string; GSI3SK: string } | undefined {
  const teamId = idAfter(item.PK, TEAM);
  if (teamId && item.SK === META) return gsi3.team(teamId);
  const userId = idAfter(item.SK, prefixes.member);
  if (teamId && userId && item.role === "owner") return gsi3.owner(teamId, userId);
  if (idAfter(item.PK, OPERATOR_AUDIT_PREFIX) && typeof item.SK === "string" && item.SK.startsWith(AUDIT)) {
    // SK `AUDIT#<ts>#<eventId>`: GSI3SK `<ts>#<eventId>`, GSI3PK by the ts's month
    const sk = item.SK.slice(AUDIT.length);
    return { GSI3PK: `${OPS_AUDIT_INDEX_PREFIX}${sk.slice(0, 7)}`, GSI3SK: sk };
  }
  return undefined;
}

/** What a stray is, for the report: the partition and sort-key types, with the team ID when there is one. */
function strayKind(item: Item): string {
  const type = (key: unknown) => (typeof key === "string" ? (/^[A-Z]+#?/.exec(key)?.[0] ?? "other") : "other");
  const teamId = idAfter(item.PK, TEAM) ?? idAfter(item.PK, OPERATOR_AUDIT_PREFIX);
  const partition = teamId ? `${type(item.PK)}${teamId}` : type(item.PK);
  return `${partition} ${type(item.SK).replace(/#$/, "")}`;
}

/** Removes GSI3 keys from every item that shouldn't have them, or has other values than it should. */
export async function stripStrayOpsKeys(db: Db, { apply }: BackfillOptions): Promise<BackfillReport> {
  let found = 0, changed = 0, raced = 0;
  const strays: string[] = [];
  const items = scan(db, {
    FilterExpression: "attribute_exists(GSI3PK) OR attribute_exists(GSI3SK)",
    ProjectionExpression: "PK, SK, GSI3PK, GSI3SK, #role",
    ExpressionAttributeNames: { "#role": "role" },
  });
  for await (const item of items) {
    const expected = expectedOpsKeys(item);
    if (expected && item.GSI3PK === expected.GSI3PK && item.GSI3SK === expected.GSI3SK) continue;
    found++;
    strays.push(strayKind(item));
    if (!apply) {
      changed++;
      continue;
    }
    // Only the values read: a write since (a promotion, say) is left alone
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const conditions = ["attribute_exists(PK)"];
    for (const [attr, placeholder] of [[GSI3PK, ":gpk"], [GSI3SK, ":gsk"]] as const) {
      if (item[attr] === undefined) conditions.push(`attribute_not_exists(${attr})`);
      else {
        conditions.push(`${attr} = ${placeholder}`);
        values[placeholder] = item[attr];
      }
    }
    if (typeof item.SK === "string" && item.SK.startsWith(prefixes.member) && item.role !== "owner") {
      conditions.push("(attribute_not_exists(#role) OR #role <> :owner)");
      names["#role"] = "role";
      values[":owner"] = "owner";
    }
    const written = await conditionalUpdate(db, {
      Key: { PK: item.PK, SK: item.SK },
      UpdateExpression: "REMOVE GSI3PK, GSI3SK",
      ConditionExpression: conditions.join(" AND "),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
    });
    if (written) changed++;
    else raced++;
  }
  const counts = new Map<string, number>();
  for (const kind of strays) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const summary = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([kind, n]) => `${kind}: ${n}`);
  return { mode: "stray-ops-keys", apply, found, changed, raced, invalid: 0, strays: summary };
}

/** Whether the account is being deleted (its DELETING mark), reading only the keys. */
async function beingDeleted(db: Db, userId: string): Promise<boolean> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.accountDeletion(userId), ProjectionExpression: "PK", ConsistentRead: true }));
  return Item !== undefined;
}

/**
 * Records the notice address of every listed account that has none, unless
 * it's being deleted. recordNoticeAddress's conditions decide at write time:
 * an address recorded meanwhile (by GET /me, a trigger or the notices
 * function) or a deletion started meanwhile leaves it alone (`raced`).
 */
export async function backfillNoticeAddresses(db: Db, accounts: AsyncIterable<NoticeAddressCandidate | undefined>, { apply }: BackfillOptions, now = () => new Date()): Promise<BackfillReport> {
  let found = 0, changed = 0, raced = 0, invalid = 0, listed = 0, untrusted = 0, present = 0, deleting = 0;
  for await (const account of accounts) {
    listed++;
    if (!account) {
      untrusted++;
      continue;
    }
    if (!ID.test(account.userId) || !account.address || !account.seen) {
      invalid++;
      continue;
    }
    if (await hasNoticeAddress(db, account.userId)) {
      present++;
      continue;
    }
    if (await beingDeleted(db, account.userId)) {
      deleting++;
      continue;
    }
    found++;
    if (!apply) {
      changed++;
      continue;
    }
    if (await recordNoticeAddress(db, account.userId, account.address, account.seen, now())) changed++;
    else raced++;
  }
  return { mode: "notice-address", apply, found, changed, raced, invalid, accounts: { listed, untrusted, present, deleting } };
}

/** Runs one mode. */
export function runBackfill(db: Db, mode: BackfillMode, options: BackfillOptions, sources: BackfillSources = {}): Promise<BackfillReport> {
  switch (mode) {
    case "members":
      return backfillMemberCounts(db, options);
    case "ops-index":
      return backfillOpsIndex(db, options);
    case "stray-ops-keys":
      return stripStrayOpsKeys(db, options);
    case "notice-address":
      if (!sources.accounts) return Promise.reject(new Error("notice-address needs the app pool's users"));
      return backfillNoticeAddresses(db, sources.accounts, options);
  }
}
