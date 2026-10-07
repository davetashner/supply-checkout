// The projects-rename backfill (docs/projects-rename-plan.md, section 2;
// bead supply-checkout-005.6.2): moves every sheet item to its project key,
// and renames the sheet attributes on movement items. Run by the owner with
// scripts/backfill.ts (docs/infrastructure.md, "Backfills"), never by a
// Lambda. `reverse` is the same code with the names swapped, for a rollback.
//
// The prefixes are literal strings here, not the shared helpers in keys.ts:
// those are being renamed, and this has to keep naming both spellings.
//
// - A sheet item (`SK=SHEET#<id>`, `GSI1PK=TEAM#<t>#SHEETS` as documents.ts
//   builds it by hand, `type: "sheet"`) is copied to `SK=PROJECT#<id>`,
//   `GSI1PK=TEAM#<t>#PROJECTS`, `type: "project"`, every other attribute
//   (version included) unchanged, and the old one deleted, in one
//   transaction: the Put on the condition that the new key is free, the
//   Delete on the condition that the version is still the one read. A
//   transaction that fails (someone edited the sheet meanwhile) is retried
//   on a fresh read, up to MAX_ATTEMPTS times, then reported and skipped.
// - A project copy that already exists is never overwritten: if it equals
//   the old item except for the renamed attributes, the old one is deleted
//   (same version condition); otherwise it's reported as a conflict and both
//   are left alone.
// - A movement (`SK=MOVE#...`) has `sheetId` (and `fromSheetId`) renamed to
//   `projectId` (and `fromProjectId`), on the condition that the old name is
//   still there and the new one isn't.
//
// - A team whose META item is missing, or that is closed (`purgeAfter`) or
//   being purged (`purging`), is left alone and counted, and every move's
//   transaction checks that again, so no copy outlives a purge.
//
// With apply, it verifies afterwards and reports `ok` only when every check
// holds. Reports hold counts and check names only: never team IDs, sheet IDs,
// emails, names or item contents. Writes are sequential, about
// WRITES_PER_SECOND, so the pilot's use and the stream's consumer aren't
// flooded.

import { createHash } from "node:crypto";
import { GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection, storable } from "./client.js";
import { GSI1 } from "./schema.js";

/** Attempts per sheet before it's reported and skipped. */
export const MAX_ATTEMPTS = 5;
/** Writes a second, about: a transaction of a Put and a Delete is two. */
export const WRITES_PER_SECOND = 25;
/** How long the verification waits for GSI1 (eventually consistent) to settle. */
export const INDEX_WAIT_MS = 60_000;

const TEAM = "TEAM#";
const MOVE = "MOVE#";
const PRODUCT = "PRODUCT#";
const ID = /^[A-Za-z0-9_-]{1,128}$/;

type Item = Record<string, unknown>;

/** One spelling: the sort-key prefix, the date index's partition suffix, the type, and the movement attributes. */
export interface Spelling {
  readonly sk: string;
  readonly index: string;
  readonly type: string;
  readonly ref: string;
  readonly fromRef: string;
}

export const SHEETS: Spelling = { sk: "SHEET#", index: "#SHEETS", type: "sheet", ref: "sheetId", fromRef: "fromSheetId" };
export const PROJECTS: Spelling = { sk: "PROJECT#", index: "#PROJECTS", type: "project", ref: "projectId", fromRef: "fromProjectId" };

export interface ProjectsRenameOptions {
  readonly apply: boolean;
  /** One team (a Query of its partition); all teams (a key-only Scan) without it. */
  readonly team?: string;
  /** Projects back to sheets: the rollback. */
  readonly reverse?: boolean;
  /** Stop after this many sheets; movements are then left for a full run. */
  readonly limit?: number;
  /** Given the items before anything is written: each team's items under the old prefix and its movements. */
  readonly exportTo?: (teams: readonly ExportedTeam[]) => Promise<void>;
  /** Writes a second (WRITES_PER_SECOND); tests pass Infinity. */
  readonly writesPerSecond?: number;
  /** How long to wait for GSI1 (INDEX_WAIT_MS). */
  readonly indexWaitMs?: number;
  /** Waits; tests may stand in for it. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ExportedTeam {
  readonly teamId: string;
  readonly items: readonly Item[];
}

/** One verification check: its name and whether it held. No IDs. */
export interface RenameCheck {
  readonly check: string;
  readonly ok: boolean;
}

export interface ProjectsRenameReport {
  readonly apply: boolean;
  readonly from: string;
  readonly to: string;
  /** Teams with something to do (or the one team asked for). */
  readonly teams: number;
  /** Items under the old prefix. */
  readonly found: number;
  /** Moved (or, in a dry run, that would be). */
  readonly moved: number;
  /** Old items whose new copy already existed and was equal: deleted (or would be). */
  readonly duplicates: number;
  /** Old items whose new copy already exists and differs: both left alone. */
  readonly conflicts: number;
  /** Old items gone by the time they were read (deleted or moved by someone else). */
  readonly gone: number;
  /** Old items still changing after MAX_ATTEMPTS: left alone. */
  readonly failed: number;
  /** Transactions retried after a conflict. */
  readonly retries: number;
  /** Old items whose ID isn't a valid ID: left alone. */
  readonly invalid: number;
  /** Team partitions whose ID isn't a valid ID (the all-teams scan): left alone. */
  readonly invalidTeams: number;
  /** --team named a team with no META item: probably a typo. */
  readonly teamMissing: boolean;
  /** Teams left alone because their META item is missing or they're closed or being purged (`purgeAfter`, `purging`). */
  readonly skippedTeams: number;
  /** Old items not read because of the limit. */
  readonly leftByLimit: number;
  /** About how many bytes the old items hold, and the largest one (DynamoDB's limit is 400 KB). */
  readonly bytes: number;
  readonly largest: number;
  readonly movements: { readonly found: number; readonly renamed: number; readonly conflicts: number; readonly raced: number; readonly skipped: boolean };
  /** Items given to exportTo, if it was. */
  readonly exported?: number;
  /** With apply: every check, and whether all held. */
  readonly verification?: { readonly ok: boolean; readonly checks: readonly RenameCheck[] };
}

interface Writes {
  /** Waits long enough for this many writes to keep to the rate. */
  readonly pause: (writes: number) => Promise<void>;
}

function pacer(sleep: (ms: number) => Promise<void>, perSecond: number): Writes {
  const gap = perSecond > 0 && Number.isFinite(perSecond) ? 1000 / perSecond : 0;
  return { pause: async (writes) => (gap ? sleep(gap * writes) : undefined) };
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function* query(db: Db, input: Omit<ConstructorParameters<typeof QueryCommand>[0], "TableName" | "ExclusiveStartKey">) {
  let ExclusiveStartKey: Item | undefined;
  do {
    const page = await connection(db).doc.send(new QueryCommand({ TableName: db.tableName, ExclusiveStartKey, ...input }));
    yield* (page.Items ?? []) as Item[];
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
}

async function all(items: AsyncIterable<Item>): Promise<Item[]> {
  const list: Item[] = [];
  for await (const item of items) list.push(item);
  return list;
}

/** Items in a team's partition under a sort-key prefix, strongly consistent. */
const underPrefix = (db: Db, pk: string, prefix: string, projection?: string) =>
  all(
    query(db, {
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ConsistentRead: true,
      ...(projection ? { ProjectionExpression: projection } : {}),
    }),
  );

/** A team's movements that still carry either old attribute. */
const oldMovements = (db: Db, pk: string, from: Spelling, to: Spelling) =>
  all(
    query(db, {
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      FilterExpression: "attribute_exists(#ref) OR attribute_exists(#fromRef)",
      ProjectionExpression: "PK, SK, #ref, #fromRef, #toRef, #toFromRef",
      ExpressionAttributeNames: { "#ref": from.ref, "#fromRef": from.fromRef, "#toRef": to.ref, "#toFromRef": to.fromRef },
      ExpressionAttributeValues: { ":pk": pk, ":prefix": MOVE },
      ConsistentRead: true,
    }),
  );

/** How many items GSI1 has in one partition. */
async function indexCount(db: Db, partition: string): Promise<number> {
  let count = 0;
  let ExclusiveStartKey: Item | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({ TableName: db.tableName, IndexName: GSI1, KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": partition }, Select: "COUNT", ExclusiveStartKey }),
    );
    count += page.Count ?? 0;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

/** Every team that has an item under the old prefix or a movement with an old attribute: a Scan of keys only. */
async function teamsToRename(db: Db, from: Spelling): Promise<{ teams: string[]; invalid: number }> {
  const teams = new Set<string>();
  const bad = new Set<string>();
  let ExclusiveStartKey: Item | undefined;
  do {
    const page = await connection(db).doc.send(
      new ScanCommand({
        TableName: db.tableName,
        ConsistentRead: true,
        ExclusiveStartKey,
        FilterExpression: "begins_with(PK, :team) AND (begins_with(SK, :sk) OR (begins_with(SK, :move) AND (attribute_exists(#ref) OR attribute_exists(#fromRef))))",
        ProjectionExpression: "PK, SK",
        ExpressionAttributeNames: { "#ref": from.ref, "#fromRef": from.fromRef },
        ExpressionAttributeValues: { ":team": TEAM, ":sk": from.sk, ":move": MOVE },
      }),
    );
    for (const item of page.Items ?? []) {
      const teamId = String(item.PK).slice(TEAM.length);
      if (ID.test(teamId)) teams.add(teamId);
      else bad.add(String(item.PK));
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { teams: [...teams].sort(), invalid: bad.size };
}

/** A value in a canonical form for hashing: maps by sorted key, sets sorted, binary as base64. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Set) return { $set: [...value].map(canonical).map((v) => JSON.stringify(v)).sort() };
  if (value instanceof Uint8Array) return { $b64: Buffer.from(value).toString("base64") };
  if (value instanceof Map) return canonical(Object.fromEntries(value));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Item)[k])]),
    );
  }
  return value;
}

/** The attributes the rename changes: left out of the comparison. */
const RENAMED = new Set(["SK", "GSI1PK", "type"]);

/** A stable hash of an item's attributes, the renamed ones left out. */
export function renameHash(item: Item): string {
  const kept = Object.fromEntries(Object.entries(item).filter(([k]) => !RENAMED.has(k)));
  return createHash("sha256").update(JSON.stringify(canonical(kept))).digest("hex");
}

/** About how many bytes DynamoDB counts for an item: names plus values. */
export function itemBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (typeof value === "number") return Math.ceil(String(Math.abs(value)).replace(/[.-]/g, "").length / 2) + 1;
  if (typeof value === "boolean" || value === null || value === undefined) return 1;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof Set) return [...value].reduce((n: number, v) => n + itemBytes(v), 0);
  if (Array.isArray(value)) return 3 + value.reduce((n: number, v) => n + 1 + itemBytes(v), 0);
  if (typeof value === "object") return 3 + Object.entries(value as Item).reduce((n, [k, v]) => n + 1 + Buffer.byteLength(k) + itemBytes(v), 0);
  return 0;
}

/** A project's totals as src/sheet-math.js `totals` adds them (the charge in whole cents), as artifact-import checks them. */
export interface ProjectTotals {
  readonly out: number;
  readonly ret: number;
  readonly used: number;
  readonly chargeCents: number;
  readonly valueCents: number;
  readonly count: number;
  readonly equipmentOut: number;
}

const int = (v: unknown) => Math.max(0, Math.floor(Number(v) || 0));
const cents = (n: number) => Math.round(Number((n * 100).toPrecision(12)));
const round2 = (n: unknown) => cents(Number(n) || 0) / 100;

/** sheet-math.js's `totals`, on a stored item's `items` map. */
export function projectTotals(item: Item): ProjectTotals {
  let out = 0, ret = 0, used = 0, chargeCents = 0, valueCents = 0, count = 0, equipmentOut = 0;
  const lines = item.items && typeof item.items === "object" && !Array.isArray(item.items) ? Object.values(item.items as Item) : [];
  for (const raw of lines) {
    const l = (raw && typeof raw === "object" ? raw : {}) as Item;
    const o = int(l.out), r = Math.min(int(l.returned), o);
    if (l.kind === "equipment") {
      const lost = Math.min(int(l.lost), o - r);
      equipmentOut += o - r - lost;
      const lc = cents(Math.max(0, Number(l.lostCharge) || 0));
      if (lc > 0) {
        used += lost;
        chargeCents += lc;
      }
      continue;
    }
    const p = round2(l.price);
    out += o;
    ret += r;
    used += o - r;
    chargeCents += cents((o - r) * p);
    valueCents += cents(o * p);
    count++;
  }
  return { out, ret, used, chargeCents, valueCents, count, equipmentOut };
}

const sameTotals = (a: ProjectTotals, b: ProjectTotals) => JSON.stringify(a) === JSON.stringify(b);

/** The item at its new key: SK, GSI1PK and type renamed, everything else (GSI1SK included) as read. */
export function renamedItem(item: Item, teamId: string, docId: string, to: Spelling): Item {
  return { ...item, SK: `${to.sk}${docId}`, GSI1PK: `${TEAM}${teamId}${to.index}`, type: to.type };
}

/** The condition that an item is still the version read. */
function sameVersion(item: Item) {
  return typeof item.version === "number"
    ? { ConditionExpression: "#version = :seen", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":seen": item.version } }
    : { ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(#version)", ExpressionAttributeNames: { "#version": "version" } };
}

/** The team still exists and isn't closed or being purged: a copy must never outlive a purge (team-purge.ts). */
const LIVE_TEAM = "attribute_exists(PK) AND attribute_not_exists(purging) AND attribute_not_exists(purgeAfter)";

/** Whether a team META item is one to rename: present, not closed (`purgeAfter`) and not being purged (`purging`). */
export const liveTeam = (meta: Item | undefined): boolean => meta !== undefined && meta.purging === undefined && meta.purgeAfter === undefined;

/** The transaction item that holds the team to LIVE_TEAM. */
const teamCheck = (db: Db, pk: string) => ({ ConditionCheck: { TableName: db.tableName, Key: { PK: pk, SK: "META" }, ConditionExpression: LIVE_TEAM } });

const isConditionFailure = (e: unknown) => {
  const name = (e as { name?: string } | null)?.name;
  return name === "TransactionCanceledException" || name === "ConditionalCheckFailedException";
};

type Outcome = { kind: "moved" | "duplicate"; hash: string; totals: ProjectTotals; docId: string } | { kind: "conflict" | "gone" | "failed" };

async function get(db: Db, Key: Item): Promise<Item | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key, ConsistentRead: true }));
  return Item as Item | undefined;
}

/** Moves one item, retrying on a fresh read when it changes underneath. */
async function moveOne(db: Db, teamId: string, docId: string, from: Spelling, to: Spelling, writes: Writes, retried: () => void): Promise<Outcome> {
  const pk = `${TEAM}${teamId}`;
  const oldKey = { PK: pk, SK: `${from.sk}${docId}` };
  const newKey = { PK: pk, SK: `${to.sk}${docId}` };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) retried();
    const old = await get(db, oldKey);
    if (!old) return { kind: "gone" };
    const hash = renameHash(old);
    const totals = projectTotals(old);
    const existing = await get(db, newKey);
    try {
      if (existing) {
        if (renameHash(existing) !== hash) return { kind: "conflict" };
        // Only while the copy is still the one compared, so a copy deleted meanwhile can't lose both
        await connection(db).doc.send(
          new TransactWriteCommand({
            TransactItems: [
              { ConditionCheck: { TableName: db.tableName, Key: newKey, ...sameVersion(existing) } },
              teamCheck(db, pk),
              { Delete: { TableName: db.tableName, Key: oldKey, ...sameVersion(old) } },
            ],
          }),
        );
        await writes.pause(1);
        return { kind: "duplicate", hash, totals, docId };
      }
      await connection(db).doc.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: db.tableName, Item: storable(renamedItem(old, teamId, docId, to)), ConditionExpression: "attribute_not_exists(PK)" } },
            teamCheck(db, pk),
            { Delete: { TableName: db.tableName, Key: oldKey, ...sameVersion(old) } },
          ],
        }),
      );
      await writes.pause(2);
      return { kind: "moved", hash, totals, docId };
    } catch (e) {
      if (!isConditionFailure(e)) throw e;
      await writes.pause(1);
    }
  }
  return { kind: "failed" };
}

/** What one team holds before the run. */
interface Survey {
  readonly teamId: string;
  readonly olds: Item[];
  readonly newIds: Set<string>;
  readonly movements: Item[];
  readonly stock: Map<string, unknown>;
}

async function survey(db: Db, teamId: string, from: Spelling, to: Spelling): Promise<Survey> {
  const pk = `${TEAM}${teamId}`;
  const [olds, news, movements, products] = await Promise.all([
    underPrefix(db, pk, from.sk),
    underPrefix(db, pk, to.sk, "SK"),
    oldMovements(db, pk, from, to),
    underPrefix(db, pk, PRODUCT, "SK, stock"),
  ]);
  return {
    teamId,
    olds,
    newIds: new Set(news.map((n) => String(n.SK).slice(to.sk.length))),
    movements,
    stock: new Map(products.map((p) => [String(p.SK), p.stock])),
  };
}

/** Renames the movement attributes on one movement, unless it already has the new ones. */
async function renameMovement(db: Db, movement: Item, from: Spelling, to: Spelling, apply: boolean): Promise<"renamed" | "conflict" | "raced"> {
  const pairs = ([[from.ref, to.ref], [from.fromRef, to.fromRef]] as const).filter(([old]) => movement[old] !== undefined);
  if (pairs.some(([, renamed]) => movement[renamed] !== undefined)) return "conflict";
  if (!apply) return "renamed";
  const names: Record<string, string> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  const conditions: string[] = [];
  pairs.forEach(([old, renamed], i) => {
    names[`#o${i}`] = old;
    names[`#n${i}`] = renamed;
    sets.push(`#n${i} = #o${i}`);
    removes.push(`#o${i}`);
    conditions.push(`attribute_exists(#o${i}) AND attribute_not_exists(#n${i})`);
  });
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: { PK: movement.PK, SK: movement.SK },
        UpdateExpression: `SET ${sets.join(", ")} REMOVE ${removes.join(", ")}`,
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
      }),
    );
    return "renamed";
  } catch (e) {
    if ((e as { name?: string }).name === "ConditionalCheckFailedException") return "raced";
    throw e;
  }
}

/** Runs the rename (or, with reverse, the rollback). */
export async function renameProjects(db: Db, options: ProjectsRenameOptions): Promise<ProjectsRenameReport> {
  const { apply } = options;
  const from = options.reverse ? PROJECTS : SHEETS;
  const to = options.reverse ? SHEETS : PROJECTS;
  const sleep = options.sleep ?? realSleep;
  const writes = pacer(sleep, options.writesPerSecond ?? WRITES_PER_SECOND);
  if (options.team !== undefined && !ID.test(options.team)) throw new Error("Invalid team ID");
  if (options.limit !== undefined && !(Number.isInteger(options.limit) && options.limit > 0)) throw new Error("Invalid limit");

  let teamIds: string[];
  let invalidTeams = 0;
  let teamMissing = false;
  if (options.team !== undefined) {
    teamIds = [options.team];
    // A typo would otherwise find nothing and look like success
    teamMissing = !(await get(db, { PK: `${TEAM}${options.team}`, SK: "META" }));
  } else ({ teams: teamIds, invalid: invalidTeams } = await teamsToRename(db, from));
  const surveys: Survey[] = [];
  let skippedTeams = 0;
  for (const teamId of teamIds) {
    // A closed or purging team is left alone, so no copy outlives its purge
    if (!liveTeam(await get(db, { PK: `${TEAM}${teamId}`, SK: "META" }))) {
      skippedTeams++;
      continue;
    }
    surveys.push(await survey(db, teamId, from, to));
  }

  let exported: number | undefined;
  if (options.exportTo) {
    const teams: ExportedTeam[] = [];
    for (const s of surveys) {
      const pk = `${TEAM}${s.teamId}`;
      teams.push({ teamId: s.teamId, items: [...s.olds, ...(await underPrefix(db, pk, to.sk)), ...(await underPrefix(db, pk, MOVE))] });
    }
    await options.exportTo(teams);
    exported = teams.reduce((n, t) => n + t.items.length, 0);
  }

  let found = 0, moved = 0, duplicates = 0, conflicts = 0, gone = 0, failed = 0, retries = 0, invalid = 0, leftByLimit = 0, bytes = 0, largest = 0;
  const movements = { found: 0, renamed: 0, conflicts: 0, raced: 0, skipped: false };
  const done: { survey: Survey; outcomes: Extract<Outcome, { hash: string }>[] }[] = [];
  let budget = options.limit ?? Infinity;

  for (const s of surveys) {
    const outcomes: Extract<Outcome, { hash: string }>[] = [];
    for (const old of s.olds) {
      found++;
      const size = itemBytes(old);
      bytes += size;
      largest = Math.max(largest, size);
      const docId = String(old.SK).slice(from.sk.length);
      if (!ID.test(docId)) {
        invalid++;
        continue;
      }
      if (budget <= 0) {
        leftByLimit++;
        continue;
      }
      budget--;
      if (!apply) {
        if (!s.newIds.has(docId)) moved++;
        else {
          const existing = await get(db, { PK: old.PK, SK: `${to.sk}${docId}` });
          if (existing && renameHash(existing) === renameHash(old)) duplicates++;
          else if (existing) conflicts++;
          else moved++;
        }
        continue;
      }
      const outcome = await moveOne(db, s.teamId, docId, from, to, writes, () => retries++);
      if (outcome.kind === "moved") moved++;
      else if (outcome.kind === "duplicate") duplicates++;
      else if (outcome.kind === "conflict") conflicts++;
      else if (outcome.kind === "gone") gone++;
      else failed++;
      if ("hash" in outcome) outcomes.push(outcome);
    }
    done.push({ survey: s, outcomes });
  }

  // A limited run leaves movements for the full run, so it touches no more than asked
  if (leftByLimit) movements.skipped = true;
  else {
    for (const s of surveys) {
      for (const movement of s.movements) {
        movements.found++;
        const result = await renameMovement(db, movement, from, to, apply);
        if (result === "renamed") movements.renamed++;
        else if (result === "conflict") movements.conflicts++;
        else movements.raced++;
        if (apply && result !== "conflict") await writes.pause(1);
      }
    }
  }

  const report = { apply, from: from.sk, to: to.sk, teams: surveys.length, invalidTeams, teamMissing, skippedTeams, found, moved, duplicates, conflicts, gone, failed, retries, invalid, leftByLimit, bytes, largest, movements, ...(exported === undefined ? {} : { exported }) };
  if (!apply) return report;
  return { ...report, verification: await verify(db, done, from, to, options.indexWaitMs ?? INDEX_WAIT_MS, sleep) };
}

/** The checks after an apply (plan section 2, "Verification"), over every team the run read. */
async function verify(db: Db, done: { survey: Survey; outcomes: Extract<Outcome, { hash: string }>[] }[], from: Spelling, to: Spelling, indexWaitMs: number, sleep: (ms: number) => Promise<void>) {
  let oldLeft = 0, countsEqual = true, hashesEqual = true, totalsEqual = true, stockEqual = true, movementsLeft = 0;
  const expected: { teamId: string; count: number }[] = [];
  for (const { survey: s, outcomes } of done) {
    const pk = `${TEAM}${s.teamId}`;
    const [olds, news, products, moves] = await Promise.all([
      underPrefix(db, pk, from.sk, "SK"),
      underPrefix(db, pk, to.sk, "SK"),
      underPrefix(db, pk, PRODUCT, "SK, stock"),
      oldMovements(db, pk, from, to),
    ]);
    oldLeft += olds.length;
    movementsLeft += moves.length;
    const movedHere = outcomes.filter((o) => o.kind === "moved").length;
    if (news.length !== s.newIds.size + movedHere) countsEqual = false;
    expected.push({ teamId: s.teamId, count: news.length });
    for (const o of outcomes) {
      const item = await get(db, { PK: pk, SK: `${to.sk}${o.docId}` });
      if (!item || renameHash(item) !== o.hash) hashesEqual = false;
      if (!item || !sameTotals(projectTotals(item), o.totals)) totalsEqual = false;
    }
    const after = new Map(products.map((p) => [String(p.SK), p.stock]));
    if (after.size !== s.stock.size || [...s.stock].some(([sk, stock]) => !after.has(sk) || after.get(sk) !== stock)) stockEqual = false;
  }

  // GSI1 is eventually consistent: wait for it to agree with the table
  const indexAgrees = async () => {
    for (const { teamId, count } of expected) {
      const [news, olds] = await Promise.all([indexCount(db, `${TEAM}${teamId}${to.index}`), indexCount(db, `${TEAM}${teamId}${from.index}`)]);
      if (news !== count || olds !== 0) return false;
    }
    return true;
  };
  let indexOk = await indexAgrees();
  for (let waited = 0; !indexOk && waited < indexWaitMs; waited += 2_000) {
    await sleep(Math.min(2_000, indexWaitMs - waited));
    indexOk = await indexAgrees();
  }

  const checks: RenameCheck[] = [
    { check: `no ${from.sk} items left`, ok: oldLeft === 0 },
    { check: `${to.sk} items = ${to.sk} items before + moved`, ok: countsEqual },
    { check: `GSI1 ${to.index} counts equal the table's, and ${from.index} is empty`, ok: indexOk },
    { check: "moved items' attributes unchanged (hash)", ok: hashesEqual },
    { check: "moved items' totals unchanged (counts and charge)", ok: totalsEqual },
    { check: "product stock unchanged", ok: stockEqual },
    { check: `no movements with ${from.ref} or ${from.fromRef}`, ok: movementsLeft === 0 },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
