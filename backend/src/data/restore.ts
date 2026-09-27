// Putting a restored table back into service (docs/backups.md, "Put a restored
// table back into service"), run by the owner with scripts/restore.ts. Not
// exported from index.ts: no Lambda runs these, and no Lambda role may Scan
// the table.
//
// - Re-applying deletions (supply-checkout-0ic7). A restore brings back every
//   account and team deleted since the recovery point. The deletion records
//   (deletions/records.ts) name them; planDeletions finds what of them the
//   restored table holds and applyDeletions deletes it again, the way the
//   app did the first time:
//     - a recorded team, or a team a deleted user's deletion closed (when the
//       table bears that out, see planDeletions), is purged (team-purge.ts),
//       after its META item is marked closed and due;
//     - a team whose only members are deleted users is purged too: that's
//       what the account deletion did (it closed the team, and the purge
//       followed);
//     - otherwise a deleted user leaves each team they're in (removeMember,
//       audited as `account_deleted`), and the rest of their USER# partition
//       goes (deleteUserRows);
//     - a deleted user who is the last owner of an open team with other
//       members (the restore is from before an ownership change) is left for
//       a person to decide: the plan names the team;
//     - a recorded user who outlived their record (a deletion that failed
//       after writing it) is left alone.
//   Every step is idempotent and conditioned the same way the app's are, so
//   running it again finishes what a stopped run started.
// - Copying back. The live table keeps its name, keys, indexes, TTL, stream,
//   PITR, deletion protection, tags and its stack; only its items are
//   replaced. copyTable makes the target's items equal the source's: it puts
//   every source item that differs and deletes every target item the source
//   doesn't have. It uses the low-level client, so every attribute's type
//   (numbers, sets, binary) is copied exactly.
//
// A dry run reads the same items and writes nothing. Reports hold counts and,
// for teams a person has to look at, team IDs: never emails, names or item
// contents.

import { createHash } from "node:crypto";
import {
  type AttributeValue,
  BatchWriteItemCommand,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  ListTagsOfResourceCommand,
  ScanCommand as RawScanCommand,
  type WriteRequest,
} from "@aws-sdk/client-dynamodb";
import { ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DeletionRecord } from "../deletions/records.js";
import { deleteUserRows } from "./accounts.js";
import { type Db, connection } from "./client.js";
import { ForbiddenError, LastOwnerError } from "./errors.js";
import { gsi1, keys, prefixes } from "./keys.js";
import { authorizeTeam } from "./team-context.js";
import { purgeTeam } from "./team-purge.js";
import { removeMember } from "./teams.js";
import { GSI1, GSI2, GSI3, TTL_ATTRIBUTE } from "./schema.js";

const TEAM = "TEAM#";
const USER = "USER#";
const META = "META";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Rows deleteUserRows leaves: the deletion mark and the daily counters, which expire by TTL. */
const KEPT_USER_ROWS = (sk: string) => sk === "DELETING" || sk.startsWith("LIMIT#");

export interface DeletionPlan {
  /** Records read: deleted users and deleted teams. */
  readonly records: { readonly users: number; readonly teams: number };
  /** Teams to purge: recorded, closed by a user's deletion, or left with only deleted members. */
  readonly teamsToPurge: readonly string[];
  /** A deleted user's membership to remove. */
  readonly memberships: readonly { readonly userId: string; readonly teamId: string }[];
  /** Deleted users with rows left in their USER# partition. */
  readonly usersWithRows: readonly string[];
  /** Teams where a deleted user is the last owner of an open team with other members: for a person. */
  readonly blockedTeams: readonly string[];
  /** The deleted users in those teams. Their USER# rows stay until a person has decided (the team-switcher row goes with the membership). */
  readonly blockedUsers: readonly string[];
  /** Teams a user record says its deletion closed that the table doesn't bear out (other members, or not the user's): for a person. */
  readonly unconfirmedTeams: readonly string[];
  /** Recorded users who outlived their record (still in the user pool; without that check, joined or created a team after it): left alone. Counted, never named. */
  readonly survivors: number;
}

export interface DeletionReport {
  readonly apply: boolean;
  readonly teamsPurged: number;
  readonly itemsPurged: number;
  readonly membershipsRemoved: number;
  readonly userRowsDeleted: number;
  /** Teams left for a person: in the plan, or refused at write time (the last owner). */
  readonly blockedTeams: readonly string[];
  /** Teams a user record names as closed by its deletion that the table doesn't bear out. */
  readonly unconfirmedTeams: readonly string[];
  /** Recorded users left alone because they outlived their record. */
  readonly survivors: number;
}

type Item = Record<string, unknown>;

async function* scan(db: Db, input: { FilterExpression: string; ProjectionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> }) {
  let ExclusiveStartKey: Item | undefined;
  do {
    const page = await connection(db).doc.send(new ScanCommand({ TableName: db.tableName, ConsistentRead: true, ExclusiveStartKey, ...input }));
    yield* (page.Items ?? []) as Item[];
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

/**
 * What of the recorded deletions the table still holds, and what re-applying
 * them will do. Reads only.
 *
 * A record is permanent (Object Lock), so the plan trusts it only as far as the
 * table agrees with it:
 * - A user who outlived their record is a survivor and is left alone
 *   entirely. That happens when a deletion wrote its record and then failed,
 *   and the user never retried. With the owner's Cognito check (`inPool`, the
 *   recorded users the user pool still has), that alone decides: a user the
 *   pool no longer has is deleted, whatever their timestamps say, since a
 *   user whose first deletion failed may have come back and been deleted for
 *   real later (the record keeps the first time). Without it (local runs),
 *   the table decides: a member since after the record's time (`joinedAt`),
 *   or a member of a team created after it.
 * - A team a user record says its deletion closed is purged only if every
 *   member it has is a deleted user and either the recording user is one of
 *   them or the team is closed. Anything else is left for a person
 *   (`unconfirmedTeams`), with the deleted users in it held back.
 * Team records are trusted as they are: the purge writes one only after it has
 * marked a closed, due team `purging`.
 */
export async function planDeletions(db: Db, records: readonly DeletionRecord[], options: { readonly inPool?: ReadonlySet<string> } = {}): Promise<DeletionPlan> {
  const userRecords = new Map(records.filter((r) => r.kind === "user").map((r) => [r.id, r]));
  const recordedTeams = new Set(records.filter((r) => r.kind === "team").map((r) => r.id));

  // One scan for the three kinds of item this needs: team META items, every MEMBER item, and deleted users' rows
  const teams = new Map<string, { closed: boolean; createdAt?: string }>();
  const members = new Map<string, Map<string, { role: string; joinedAt?: string }>>();
  const userRows = new Set<string>();
  for await (const item of scan(db, {
    FilterExpression: "SK = :meta OR begins_with(SK, :member) OR begins_with(PK, :user)",
    ProjectionExpression: "PK, SK, #role, closedAt, createdAt, joinedAt",
    ExpressionAttributeNames: { "#role": "role" },
    ExpressionAttributeValues: { ":meta": META, ":member": prefixes.member, ":user": USER },
  })) {
    const pk = String(item.PK);
    const sk = String(item.SK);
    if (pk.startsWith(USER)) {
      const userId = pk.slice(USER.length);
      if (userRecords.has(userId) && !KEPT_USER_ROWS(sk)) userRows.add(userId);
      continue;
    }
    if (!pk.startsWith(TEAM)) continue;
    const teamId = pk.slice(TEAM.length);
    if (!ID.test(teamId)) continue;
    const text = (v: unknown) => (typeof v === "string" ? v : undefined);
    if (sk === META) teams.set(teamId, { closed: typeof item.closedAt === "string", createdAt: text(item.createdAt) });
    else if (sk.startsWith(prefixes.member)) {
      const userId = sk.slice(prefixes.member.length);
      if (!members.has(teamId)) members.set(teamId, new Map());
      members.get(teamId)?.set(userId, { role: String(item.role), joinedAt: text(item.joinedAt) });
    }
  }

  // Survivors: records the table (or Cognito) contradicts
  const survivors = new Set([...userRecords.keys()].filter((u) => options.inPool?.has(u)));
  for (const [teamId, roster] of options.inPool ? [] : members) {
    for (const [userId, m] of roster) {
      const deletedAt = userRecords.get(userId)?.deletedAt;
      if (!deletedAt) continue;
      const created = teams.get(teamId)?.createdAt;
      if ((m.joinedAt && m.joinedAt > deletedAt) || (created && created > deletedAt)) survivors.add(userId);
    }
  }
  const deleted = new Set([...userRecords.keys()].filter((u) => !survivors.has(u)));

  const purge = new Set([...recordedTeams].filter((t) => teams.has(t)));
  const unconfirmed = new Set<string>();
  for (const userId of deleted) {
    for (const teamId of userRecords.get(userId)?.teamsClosed ?? []) {
      const team = teams.get(teamId);
      if (!team || purge.has(teamId)) continue;
      const roster = members.get(teamId) ?? new Map();
      const onlyDeleted = [...roster.keys()].every((u) => deleted.has(u));
      if (onlyDeleted && (roster.has(userId) || team.closed)) purge.add(teamId);
      else unconfirmed.add(teamId);
    }
  }
  const memberships: { userId: string; teamId: string }[] = [];
  const blocked = new Set<string>();
  const blockedUsers = new Set<string>();
  for (const [teamId, roster] of members) {
    const team = teams.get(teamId);
    if (!team || purge.has(teamId)) continue;
    const gone = [...roster.keys()].filter((u) => deleted.has(u));
    if (!gone.length) continue;
    if (unconfirmed.has(teamId)) {
      for (const u of gone) blockedUsers.add(u);
      continue;
    }
    const staying = [...roster].filter(([u]) => !deleted.has(u));
    if (!staying.length) {
      purge.add(teamId);
      continue;
    }
    // An open team can't lose its last owner (removeMember); a closed one can
    const ownerStays = staying.some(([, m]) => m.role === "owner");
    if (!team.closed && !ownerStays && gone.some((u) => roster.get(u)?.role === "owner")) {
      blocked.add(teamId);
      for (const u of gone) blockedUsers.add(u);
      continue;
    }
    for (const userId of gone) memberships.push({ userId, teamId });
  }
  return {
    records: { users: userRecords.size, teams: recordedTeams.size },
    teamsToPurge: [...purge].sort(),
    memberships: memberships.sort((a, b) => a.teamId.localeCompare(b.teamId) || a.userId.localeCompare(b.userId)),
    usersWithRows: [...userRows].filter((u) => deleted.has(u) && !blockedUsers.has(u)).sort(),
    blockedTeams: [...blocked].sort(),
    blockedUsers: [...blockedUsers].sort(),
    unconfirmedTeams: [...unconfirmed].sort(),
    survivors: survivors.size,
  };
}

const errorName = (error: unknown) => (error as { name?: string } | null)?.name;

/**
 * Marks the team closed and due now, and puts it in the closed-teams index, so
 * purgeTeam (and, if this run stops, the scheduled purge once the table is
 * live) deletes it. False when the team is already gone.
 */
async function markDue(db: Db, teamId: string, now: Date): Promise<boolean> {
  const due = now.toISOString();
  const index = gsi1.closedTeam(due, teamId);
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.team(teamId),
        UpdateExpression: "SET closedAt = if_not_exists(closedAt, :at), purgeAfter = :at, GSI1PK = :gpk, GSI1SK = :gsk",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":at": due, ":gpk": index.GSI1PK, ":gsk": index.GSI1SK },
      }),
    );
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** Carries out the plan. With `apply: false`, reports what the plan would do and writes nothing. */
export async function applyDeletions(db: Db, plan: DeletionPlan, options: { readonly apply: boolean; readonly now?: Date }): Promise<DeletionReport> {
  const blocked = new Set(plan.blockedTeams);
  if (!options.apply) {
    return { apply: false, teamsPurged: plan.teamsToPurge.length, itemsPurged: 0, membershipsRemoved: plan.memberships.length, userRowsDeleted: plan.usersWithRows.length, blockedTeams: [...blocked], unconfirmedTeams: plan.unconfirmedTeams, survivors: plan.survivors };
  }
  const now = options.now ?? new Date();
  let teamsPurged = 0;
  let itemsPurged = 0;
  for (const teamId of plan.teamsToPurge) {
    if (!(await markDue(db, teamId, now))) continue;
    const result = await purgeTeam(db, teamId, now);
    if (result.skipped) continue;
    teamsPurged++;
    itemsPurged += result.deleted;
  }
  let membershipsRemoved = 0;
  const heldBack = new Set(plan.blockedUsers);
  for (const { userId, teamId } of plan.memberships) {
    try {
      const ctx = await authorizeTeam(db, userId, teamId);
      await removeMember(db, ctx, userId, { reason: "account_deleted" }, now);
      membershipsRemoved++;
    } catch (error) {
      // Already gone (a run before this one)
      if (error instanceof ForbiddenError) continue;
      // The team's other owner went meanwhile: for a person
      if (error instanceof LastOwnerError) {
        blocked.add(teamId);
        heldBack.add(userId);
        continue;
      }
      throw error;
    }
  }
  let userRowsDeleted = 0;
  for (const userId of plan.usersWithRows) if (!heldBack.has(userId)) userRowsDeleted += await deleteUserRows(db, userId);
  return { apply: true, teamsPurged, itemsPurged, membershipsRemoved, userRowsDeleted, blockedTeams: [...blocked].sort(), unconfirmedTeams: plan.unconfirmedTeams, survivors: plan.survivors };
}

export interface CopyReport {
  readonly apply: boolean;
  /** Items in the source and, before the copy, in the target. */
  readonly source: number;
  readonly target: number;
  /** Source items the target didn't have, or had with different attributes: put. */
  readonly put: number;
  /** Target items the source doesn't have: deleted. */
  readonly deleted: number;
  /** Items already the same in both. */
  readonly unchanged: number;
}

/** The same JSON for the same item, whatever the attribute order or set order. */
function canonical(value: unknown, isSet = false): unknown {
  if (value instanceof Uint8Array) return { $b: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) {
    const items = value.map((v) => canonical(v));
    return isSet ? items.map((v) => JSON.stringify(v)).sort() : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Item)[k], k === "SS" || k === "NS" || k === "BS")]),
    );
  }
  return value;
}

const fingerprint = (item: Record<string, AttributeValue>) => createHash("sha256").update(JSON.stringify(canonical(item))).digest("base64");
const keyOf = (item: Record<string, AttributeValue>) => JSON.stringify([item.PK?.S, item.SK?.S]);

async function* rawScan(db: Db): AsyncGenerator<Record<string, AttributeValue>> {
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const page = await connection(db).client.send(new RawScanCommand({ TableName: db.tableName, ConsistentRead: true, ExclusiveStartKey }));
    yield* page.Items ?? [];
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

const BATCH = 25;
const MAX_ATTEMPTS = 8;

/** Writes the requests in batches of 25, retrying what DynamoDB leaves unprocessed, with backoff. */
async function batchWrite(db: Db, requests: WriteRequest[], sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < requests.length; i += BATCH) {
    let pending = requests.slice(i, i + BATCH);
    for (let attempt = 1; pending.length; attempt++) {
      if (attempt > MAX_ATTEMPTS) throw new Error(`${pending.length} writes still unprocessed after ${MAX_ATTEMPTS} attempts`);
      const result = await connection(db).client.send(new BatchWriteItemCommand({ RequestItems: { [db.tableName]: pending } }));
      pending = result.UnprocessedItems?.[db.tableName] ?? [];
      if (pending.length) await sleep(Math.min(2 ** attempt * 50, 5000));
    }
  }
}

/**
 * Makes the target's items the same as the source's: puts each source item
 * the target lacks or has differently, and deletes each target item the
 * source lacks. The tables must have the app table's keys. Run it again and
 * it finds nothing to do.
 */
export async function copyTable(
  source: Db,
  target: Db,
  options: { readonly apply: boolean; readonly sleep?: (ms: number) => Promise<void> },
): Promise<CopyReport> {
  if (source.tableName === target.tableName) throw new Error("The source and target are the same table");
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  // The target's items by key, as fingerprints: small enough to hold for any table this size
  const existing = new Map<string, { key: Record<string, AttributeValue>; print: string }>();
  for await (const item of rawScan(target)) existing.set(keyOf(item), { key: { PK: item.PK as AttributeValue, SK: item.SK as AttributeValue }, print: fingerprint(item) });
  const targetCount = existing.size;
  let sourceCount = 0;
  let put = 0;
  let unchanged = 0;
  let batch: WriteRequest[] = [];
  const flush = async () => {
    if (options.apply && batch.length) await batchWrite(target, batch, sleep);
    batch = [];
  };
  for await (const item of rawScan(source)) {
    sourceCount++;
    const key = keyOf(item);
    const found = existing.get(key);
    existing.delete(key);
    if (found?.print === fingerprint(item)) {
      unchanged++;
      continue;
    }
    put++;
    batch.push({ PutRequest: { Item: item } });
    if (batch.length >= BATCH * 4) await flush();
  }
  await flush();
  for (const { key } of existing.values()) batch.push({ DeleteRequest: { Key: key } });
  await flush();
  return { apply: options.apply, source: sourceCount, target: targetCount, put, deleted: existing.size, unchanged };
}

export interface SettingCheck {
  readonly setting: string;
  readonly ok: boolean;
  /** What the table has, in a few words. */
  readonly found: string;
}

/**
 * The live table's settings a table must have to serve the app (the data
 * stack's): active, the three indexes, KMS encryption, TTL on `expiresAt`,
 * the stream with new and old images (the live-update publisher reads it),
 * point-in-time recovery, deletion protection, and the stack's tags. A
 * restored table has none of TTL, the stream, PITR, deletion protection or
 * tags: that's why the runbook copies back into the live table instead.
 */
export async function checkTableSettings(db: Db, envName: string): Promise<SettingCheck[]> {
  const { client } = connection(db);
  const TableName = db.tableName;
  const { Table: t } = await client.send(new DescribeTableCommand({ TableName }));
  const ttl = (await client.send(new DescribeTimeToLiveCommand({ TableName }))).TimeToLiveDescription;
  const pitr = (await client.send(new DescribeContinuousBackupsCommand({ TableName }))).ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
  const tags: Record<string, string> = {};
  let NextToken: string | undefined;
  do {
    const page = await client.send(new ListTagsOfResourceCommand({ ResourceArn: t?.TableArn, NextToken }));
    for (const { Key, Value } of page.Tags ?? []) if (Key) tags[Key] = Value ?? "";
    NextToken = page.NextToken;
  } while (NextToken);
  const indexes = (t?.GlobalSecondaryIndexes ?? []).map((i) => `${i.IndexName}:${i.IndexStatus}`);
  const wantedTags = { app: "supply-checkout", "managed-by": "cdk", env: envName, component: "data", layer: "stateful" };
  const check = (setting: string, ok: boolean, found: string): SettingCheck => ({ setting, ok, found });
  return [
    check("Status", t?.TableStatus === "ACTIVE", String(t?.TableStatus)),
    check("Indexes", [GSI1, GSI2, GSI3].every((name) => indexes.includes(`${name}:ACTIVE`)), indexes.join(", ") || "none"),
    check("Encryption", t?.SSEDescription?.SSEType === "KMS" && t.SSEDescription.Status === "ENABLED", `${t?.SSEDescription?.SSEType ?? "AWS owned key"} ${t?.SSEDescription?.Status ?? ""}`.trim()),
    check("TTL", ttl?.TimeToLiveStatus === "ENABLED" && ttl.AttributeName === TTL_ATTRIBUTE, `${ttl?.TimeToLiveStatus ?? "unknown"}${ttl?.AttributeName ? ` on ${ttl.AttributeName}` : ""}`),
    check("Stream", t?.StreamSpecification?.StreamEnabled === true && t.StreamSpecification.StreamViewType === "NEW_AND_OLD_IMAGES", t?.StreamSpecification?.StreamEnabled ? `${t.StreamSpecification.StreamViewType}` : "off"),
    check("Point-in-time recovery", pitr?.PointInTimeRecoveryStatus === "ENABLED", pitr?.PointInTimeRecoveryStatus ?? "unknown"),
    check("Deletion protection", t?.DeletionProtectionEnabled === true, t?.DeletionProtectionEnabled ? "on" : "off"),
    check(
      "Tags",
      Object.entries(wantedTags).every(([k, v]) => tags[k] === v),
      Object.entries(wantedTags)
        .map(([k]) => `${k}=${tags[k] ?? "missing"}`)
        .join(" "),
    ),
  ];
}
