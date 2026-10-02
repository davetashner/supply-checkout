// What platform operators may read and change (ADR 0015): the team list and
// one team's account record, comps, and the operator audit trail.
//
// This file never issues or takes a TeamContext and doesn't import
// team-context.ts (the lint config enforces that): an operator isn't a member
// of any team and gets no access to a team's data. It reads teams only from
// GSI3, the operators' index, whose projection holds the account record and
// nothing about sheets or inventory. The ops function runs it on the
// operator-access role, which may query that index, update only the comp
// attributes of the one team its session is tagged with, and put (never
// update or delete) operator audit items.
//
// Reopening a closed team (reopenOpsTeam) is the exception: the ops function
// can't write closure fields, so it asks the operator reopen function
// (src/operator/reopen-handler.ts) to, and that function runs reopenOpsTeam on
// the operator-reopen role, which may read and update only REOPEN_ATTRIBUTES
// of the one team its session is tagged with.
//
// Every change writes its audit item in the same transaction, with a record
// of the request's Idempotency-Key, so a retry replays instead of acting
// twice. Reading one team's record is audited too.

import { createHash, randomUUID } from "node:crypto";
import { BatchGetCommand, type BatchGetCommandOutput, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, InvalidInputError, NotFoundError, TeamDeletingError } from "./errors.js";
import { gsi3, id, keys, month, operatorAuditPartition, operatorKeys, opsAuditIndexPartition, opsOwnersPartition, strip } from "./keys.js";
import { type Comp, MEMBERS_PER_TEAM, liveComp } from "./model.js";
import { type Page, decodeCursor, encodeCursor, queryPage } from "./query.js";
import { type StuckImport, listStuckImports } from "./imports.js";
import { COMMITTING_IMPORTS_PARTITION, GSI3, GSI3PK, OPERATOR_AUDIT_PREFIX, OPS_TEAMS_PARTITION, PK } from "./schema.js";

/** A signed-in operator, verified by the ops function: their `sub` in the operator pool. */
export interface Operator {
  readonly sub: string;
}

/** A team's account record, as the operators' index holds it. */
export interface OpsTeam {
  readonly teamId: string;
  readonly name: string;
  readonly plan: string;
  readonly seats: number;
  readonly status: string;
  readonly trialEndsAt?: string;
  readonly owners: number;
  readonly createdAt: string;
  /** Set once an owner closed the team: it's read-only, and the purge deletes it later (and so drops it from the index). */
  readonly closedAt?: string;
  readonly stripeCustomerId?: string;
  readonly version: number;
  readonly compPlan?: string;
  readonly compSeats?: number;
  readonly compUntil?: string;
  readonly compReason?: string;
  readonly compBy?: string;
  readonly compAt?: string;
}

/** A team owner, as the operators' index holds them. */
export interface OpsOwner {
  readonly userId: string;
  readonly email?: string;
  readonly joinedAt?: string;
}

/** One operator action. `operatorSub` is never shown to the team. */
export interface OperatorAuditEvent {
  readonly type: "operatorAudit";
  readonly eventId: string;
  readonly ts: string;
  readonly teamId: string;
  readonly operatorSub: string;
  readonly action: OperatorAction;
  readonly target: string;
  readonly reason?: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly idempotencyKey?: string;
  readonly expiresAt: number;
}

export type OperatorAction = "ops.teams.list" | "ops.team.read" | "ops.receipts.usage" | "ops.comp.set" | "ops.comp.end" | "ops.import.clear" | "ops.team.reopen";

/** The operator audit partition for actions on no one team: listing and searching teams (and, later, campaigns). */
export const PLATFORM_AUDIT = "PLATFORM";

/** An audit event as a month's listing has it (the index projects only these). */
export interface OperatorAuditSummary {
  readonly eventId: string;
  readonly ts: string;
  readonly teamId: string;
  readonly action: OperatorAction;
  readonly operatorSub: string;
}

/** Operator audit items are kept for 2 years (TTL). */
export const OPERATOR_AUDIT_RETENTION_DAYS = 730;
/** How long a write's Idempotency-Key replays. */
export const OPERATOR_REQUEST_RETENTION_HOURS = 24;
/** A comp ends at most this many months ahead, and can be extended. */
export const MAX_COMP_MONTHS = 12;
/** Index items one team list request reads at most: a search that hasn't filled its page by then returns what it has, with a cursor to go on. */
export const MAX_OPS_TEAMS_READ = 1000;
/** Index items one Query of the team list asks for while searching. */
const OPS_TEAMS_SEARCH_PAGE = 250;
/** How many teams' owners the list looks up at once. */
export const OWNER_LOOKUPS_AT_ONCE = 10;

const DAY_SECONDS = 24 * 60 * 60;
/**
 * Comps never touch a closed team: it's read-only until the purge deletes it.
 * The check reads the index, which lags a close by a moment; a comp that
 * slipped into that window would only set comp attributes on a team that's
 * still closed and still purged.
 */
const CLOSED = "This team is closed: it's read-only until it's deleted, and can't be comped";
const PLAN = /^[a-z][a-z0-9_-]{0,31}$/;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;

function operatorSub(operator: Operator): string {
  return id(operator?.sub, "operator");
}

/** A comp or audit reason: 3 to 500 characters of text, no control characters. */
export function operatorReason(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInputError("Give a reason");
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 500 || CONTROL.test(reason)) throw new InvalidInputError("The reason must be 3 to 500 characters, on one line");
  return reason;
}

function requestKey(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_KEY.test(value)) throw new InvalidInputError("Send an Idempotency-Key: 8 to 128 letters, digits, - or _");
  return value;
}

function expectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new InvalidInputError("expectedVersion must be the team's version, from its record");
  return value;
}

/** The latest time a comp made at `now` may end: MAX_COMP_MONTHS calendar months ahead. */
export function latestCompEnd(now: Date): Date {
  const end = new Date(now.getTime());
  end.setUTCMonth(end.getUTCMonth() + MAX_COMP_MONTHS);
  // 31 March + 12 months is 31 March; 29 February + 12 months rolls to 1 March, which is fine
  return end;
}

/** When a comp ends: an ISO 8601 time or date, in the future and at most MAX_COMP_MONTHS ahead. */
export function compUntil(value: unknown, now: Date): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw new InvalidInputError("until must be a date (YYYY-MM-DD) or an ISO 8601 time with a zone");
  }
  const at = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(at)) throw new InvalidInputError("until isn't a real date");
  if (at <= now.getTime()) throw new InvalidInputError("until must be in the future");
  if (at > latestCompEnd(now).getTime()) throw new InvalidInputError(`A comp can last at most ${MAX_COMP_MONTHS} months; extend it later if needed`);
  return new Date(at).toISOString();
}

function compSeats(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MEMBERS_PER_TEAM) throw new InvalidInputError(`seats must be a whole number from 1 to ${MEMBERS_PER_TEAM}`);
  return value;
}

function compPlan(value: unknown): string {
  if (typeof value !== "string" || !PLAN.test(value)) throw new InvalidInputError("plan must be a plan name: lowercase letters, digits, - or _");
  return value;
}

/** Every item in a GSI3 partition (up to about `max`), newest first, projected attributes only. */
async function indexPartition(db: Db, partition: string, max: number): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI3,
        KeyConditionExpression: "GSI3PK = :pk",
        // The operator-access role requires it (dynamodb:Select): only what the index projects, never a fetch from the table
        Select: "ALL_PROJECTED_ATTRIBUTES",
        ExpressionAttributeValues: { ":pk": partition },
        ScanIndexForward: false,
        ExclusiveStartKey,
      }),
    );
    out.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey && out.length < max);
  return out;
}

/** The ID in a key like `TEAM#<id>` or `MEMBER#<id>`, or undefined. */
function keyId(value: unknown, prefix: string): string | undefined {
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  const rest = value.slice(prefix.length);
  return ID_PATTERN.test(rest) ? rest : undefined;
}

/** A team from its index item: the index projects the account record, and the team's ID is in its key. */
function toTeam(item: Record<string, unknown>): OpsTeam | undefined {
  const teamId = keyId(item.PK, "TEAM#");
  if (!teamId || item.SK !== "META") return undefined;
  return { ...strip<Omit<OpsTeam, "teamId">>(item), teamId } as OpsTeam;
}

/** The cursor of the team list: the index key of the last team it read, opaque to clients. */
function teamsCursor(item: Record<string, unknown>): string {
  return encodeCursor({ GSI3PK: item.GSI3PK, GSI3SK: item.GSI3SK, PK: item.PK, SK: item.SK });
}

/** The team list's cursor for "the walk from the start": after a first page that the ID lookup alone filled. */
const FROM_START = { GSI3PK: OPS_TEAMS_PARTITION };

/**
 * A team list cursor back to an index key: exactly a team META item's key in
 * the OPS#TEAMS partition, or FROM_START (undefined), or InvalidInputError.
 */
function teamsStartKey(cursor: string | undefined): Record<string, unknown> | undefined {
  const key = decodeCursor(cursor, { attribute: GSI3PK, value: OPS_TEAMS_PARTITION });
  if (key === undefined) return undefined;
  const names = Object.keys(key).sort();
  if (names.join() === "GSI3PK") return undefined;
  if (names.join() !== "GSI3PK,GSI3SK,PK,SK" || key.SK !== "META" || keyId(key.PK, "TEAM#") !== key.GSI3SK) throw new InvalidInputError("Invalid cursor");
  return key;
}

/**
 * Teams, `limit` a page (50 by default, at most 100), in the index's order
 * (by team ID): every team, or those whose name contains `q` (ignoring case),
 * with the team whose ID is `q` first. Each request reads at most
 * MAX_OPS_TEAMS_READ index items, whatever the number of teams, so a search
 * may return fewer than `limit` teams (even none) with a cursor to read on.
 * The cursor is opaque: a position in the index, not tied to `q` (nothing
 * checks it), so send it with the same `q`; with another, the search reads on
 * from that position and misses teams before it.
 */
export async function listOpsTeams(
  db: Db,
  operator: Operator,
  options: { readonly q?: string; readonly limit?: number; readonly cursor?: string } = {},
  now = new Date(),
): Promise<{ teams: OpsTeam[]; cursor?: string }> {
  operatorSub(operator);
  const raw = options.q?.trim();
  if (raw !== undefined && (raw.length > 200 || CONTROL.test(raw))) throw new InvalidInputError("Invalid search");
  const q = raw ? raw.toLowerCase() : undefined;
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError("limit is a number from 1 to 100");
  let start = teamsStartKey(options.cursor);
  const teams: OpsTeam[] = [];
  // A team ID: one direct lookup, on the first page only (the walk below matches names, never the ID, so it isn't listed twice)
  if (raw && options.cursor === undefined && ID_PATTERN.test(raw)) {
    const team = await findTeam(db, raw);
    if (team) teams.push(team);
  }
  let read = 0;
  // A page of 1 that the ID filled: names come next, from the start
  let cursor = teams.length === limit ? encodeCursor(FROM_START) : undefined;
  walk: while (teams.length < limit && read < MAX_OPS_TEAMS_READ) {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI3,
        KeyConditionExpression: "GSI3PK = :pk",
        // The operator-access role requires it (dynamodb:Select): only what the index projects, never a fetch from the table
        Select: "ALL_PROJECTED_ATTRIBUTES",
        ExpressionAttributeValues: { ":pk": OPS_TEAMS_PARTITION },
        Limit: q ? Math.min(OPS_TEAMS_SEARCH_PAGE, MAX_OPS_TEAMS_READ - read) : Math.min(limit - teams.length, MAX_OPS_TEAMS_READ - read),
        ExclusiveStartKey: start,
      }),
    );
    const items = page.Items ?? [];
    for (const [i, item] of items.entries()) {
      read++;
      const team = toTeam(item);
      if (team && (!q || (team.teamId !== raw && team.name.toLowerCase().includes(q)))) teams.push(team);
      if (teams.length === limit || read === MAX_OPS_TEAMS_READ) {
        // Stopped part-way: read on from here next time, unless this was the partition's last item
        if (i < items.length - 1 || page.LastEvaluatedKey) cursor = teamsCursor(item);
        break walk;
      }
    }
    if (!page.LastEvaluatedKey) break;
    start = page.LastEvaluatedKey;
  }
  // The list shows owners' emails like one team's record does, so it's audited too, before anything is returned
  await connection(db).doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: auditItem(operator, PLATFORM_AUDIT, { action: "ops.teams.list", before: null, after: { q: raw ?? null, cursor: options.cursor ?? null, teams: teams.map((t) => t.teamId) } }, now),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return { teams, ...(cursor ? { cursor } : {}) };
}

/**
 * The owners of each of `teamIds`, from the operators' index: one query per
 * team (each team's owners are their own GSI3 partition), OWNER_LOOKUPS_AT_ONCE
 * at a time, so a page of 100 teams takes 10 rounds, never 100 calls at once.
 */
export async function listOpsOwnersOf(db: Db, operator: Operator, teamIds: readonly string[]): Promise<Map<string, OpsOwner[]>> {
  operatorSub(operator);
  const owners = new Map<string, OpsOwner[]>();
  for (let i = 0; i < teamIds.length; i += OWNER_LOOKUPS_AT_ONCE) {
    const batch = teamIds.slice(i, i + OWNER_LOOKUPS_AT_ONCE);
    const found = await Promise.all(batch.map((teamId) => listOpsOwners(db, operator, teamId)));
    batch.forEach((teamId, n) => owners.set(teamId, found[n] as OpsOwner[]));
  }
  return owners;
}

/** A team's owners, from the operators' index. */
export async function listOpsOwners(db: Db, operator: Operator, teamId: string): Promise<OpsOwner[]> {
  operatorSub(operator);
  const owners: OpsOwner[] = [];
  for (const item of await indexPartition(db, opsOwnersPartition(teamId), 1000)) {
    const userId = keyId(item.SK, "MEMBER#");
    if (!userId || item.PK !== `TEAM#${teamId}`) continue;
    owners.push({ userId, ...(typeof item.email === "string" ? { email: item.email } : {}), ...(typeof item.joinedAt === "string" ? { joinedAt: item.joinedAt } : {}) });
  }
  return owners;
}

/** One team's account record: a direct lookup of its index entry (GSI3SK is the team ID). */
async function findTeam(db: Db, teamId: string): Promise<OpsTeam | undefined> {
  const { Items } = await connection(db).doc.send(
    new QueryCommand({
      TableName: db.tableName,
      IndexName: GSI3,
      KeyConditionExpression: "GSI3PK = :pk AND GSI3SK = :sk",
      Select: "ALL_PROJECTED_ATTRIBUTES",
      ExpressionAttributeValues: { ":pk": OPS_TEAMS_PARTITION, ":sk": gsi3.team(teamId).GSI3SK },
    }),
  );
  const team = Items?.[0] ? toTeam(Items[0]) : undefined;
  return team?.teamId === teamId ? team : undefined;
}

function auditItem(
  operator: Operator,
  teamId: string,
  input: { readonly action: OperatorAction; readonly reason?: string; readonly before?: Record<string, unknown> | null; readonly after?: Record<string, unknown> | null; readonly idempotencyKey?: string },
  now: Date,
): OperatorAuditEvent & Record<string, unknown> {
  const ts = now.toISOString();
  const eventId = randomUUID();
  return {
    ...operatorKeys.audit(teamId, ts, eventId),
    ...gsi3.audit(ts, eventId),
    type: "operatorAudit",
    eventId,
    ts,
    teamId,
    operatorSub: operatorSub(operator),
    action: input.action,
    target: teamId === PLATFORM_AUDIT ? "teams" : `team/${teamId}`,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.before === undefined ? {} : { before: input.before }),
    ...(input.after === undefined ? {} : { after: input.after }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    expiresAt: Math.floor(now.getTime() / 1000) + OPERATOR_AUDIT_RETENTION_DAYS * DAY_SECONDS,
  };
}

/**
 * One team's account record and owners, for an operator. The read is audited
 * (`ops.team.read`) before anything is returned. NotFoundError for no such
 * team (the index is eventually consistent: a team made a moment ago may not
 * be in it yet).
 */
export async function getOpsTeam(db: Db, operator: Operator, teamId: string, now = new Date()): Promise<{ team: OpsTeam; owners: OpsOwner[] }> {
  operatorSub(operator);
  const team = await findTeam(db, teamId);
  if (!team) throw new NotFoundError("No such team");
  await connection(db).doc.send(
    new PutCommand({ TableName: db.tableName, Item: auditItem(operator, teamId, { action: "ops.team.read" }, now), ConditionExpression: "attribute_not_exists(PK)" }),
  );
  return { team, owners: await listOpsOwners(db, operator, teamId) };
}

/**
 * The team's Stripe customer, from the operators' index, if it has one: for
 * the seat sync the ops function queues after an operator reopens the team
 * (billing/seats.ts). Not audited on its own: the reopen it follows is.
 */
export async function opsTeamStripeCustomer(db: Db, operator: Operator, teamId: string): Promise<string | undefined> {
  operatorSub(operator);
  return (await findTeam(db, id(teamId, "team ID")))?.stripeCustomerId;
}

/** The comp as the audit records it: never who granted it (owners read the audit). */
function compRecord(team: Pick<OpsTeam, "compPlan" | "compSeats" | "compUntil" | "compReason">): Record<string, unknown> | null {
  if (team.compPlan === undefined) return null;
  return { plan: team.compPlan, seats: team.compSeats ?? null, until: team.compUntil ?? null, reason: team.compReason ?? null };
}

function keyHash(operator: Operator, teamId: string, action: OperatorAction, key: string): string {
  return createHash("sha256").update(`${operator.sub}\n${teamId}\n${action}\n${key}`, "utf8").digest("hex");
}

function bodyHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

/** The result of an operator change. `replayed` when the Idempotency-Key had already done it. */
export interface CompOutcome {
  readonly eventId: string;
  readonly replayed: boolean;
  readonly comp: Comp | null;
  /** The team's version after the change. */
  readonly version: number;
}

/** The one item an operator change updates, besides its audit and idempotency records. */
interface OperatorUpdate {
  readonly Key: Record<string, string>;
  readonly UpdateExpression: string;
  readonly ConditionExpression: string;
  readonly ExpressionAttributeNames?: Record<string, string>;
  readonly ExpressionAttributeValues: Record<string, unknown>;
}

/**
 * Runs one operator change: `update` on one item in the team's partition,
 * its audit item and the request's idempotency record, all in one
 * transaction. A retry with the same key and body replays the first result;
 * the same key with another body is a ConflictError, and `update`'s own
 * condition failing is ConflictError(`changed`).
 */
async function auditedUpdate<T extends { readonly eventId: string; readonly replayed: boolean }>(
  db: Db,
  operator: Operator,
  teamId: string,
  input: {
    readonly action: OperatorAction;
    readonly key: string;
    readonly body: Record<string, unknown>;
    readonly reason: string;
    readonly before: Record<string, unknown> | null;
    readonly after: Record<string, unknown> | null;
    readonly update: OperatorUpdate;
    readonly outcome: (eventId: string) => T;
    readonly changed: string;
  },
  now: Date,
): Promise<T> {
  const request = operatorKeys.request(teamId, keyHash(operator, teamId, input.action, input.key));
  const hash = bodyHash(input.body);
  const audit = auditItem(operator, teamId, { action: input.action, reason: input.reason, before: input.before, after: input.after, idempotencyKey: input.key }, now);
  const outcome = input.outcome(audit.eventId);
  const epoch = Math.floor(now.getTime() / 1000);
  try {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: db.tableName, ...input.update } },
          { Put: { TableName: db.tableName, Item: audit, ConditionExpression: "attribute_not_exists(PK)" } },
          {
            Put: {
              TableName: db.tableName,
              Item: { ...request, type: "operatorRequest", action: input.action, bodyHash: hash, outcome, expiresAt: epoch + OPERATOR_REQUEST_RETENTION_HOURS * 3600 },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      }),
    );
    return outcome;
  } catch (error) {
    const e = error as { name?: string; CancellationReasons?: { Code?: string }[] };
    if (e.name !== "TransactionCanceledException") throw error;
    const codes = (e.CancellationReasons ?? []).map((r) => r.Code);
    if (codes[2] === "ConditionalCheckFailed") {
      const done = await replay<T>(db, request, hash);
      // The record can expire between the condition and this read; then the retry is just late
      if (done) return done;
      throw new ConflictError("This Idempotency-Key was already used for a different request");
    }
    if (codes[0] === "ConditionalCheckFailed") throw new ConflictError(input.changed);
    if (codes.includes("TransactionConflict")) throw new ConflictError("It's changing right now; try again");
    throw error;
  }
}

/**
 * The first result of the request with this idempotency record, if it was
 * made with the same body, marked `replayed`; undefined if there's no record
 * (never made, or expired); ConflictError if the key was used for another body.
 */
async function replay<T>(db: Db, request: { PK: string; SK: string }, hash: string): Promise<T | undefined> {
  const { Items } = await connection(db).doc.send(
    new QueryCommand({ TableName: db.tableName, KeyConditionExpression: "PK = :pk AND SK = :sk", ExpressionAttributeValues: { ":pk": request.PK, ":sk": request.SK }, ConsistentRead: true }),
  );
  const done = Items?.[0];
  if (!done) return undefined;
  if (done.bodyHash !== hash) throw new ConflictError("This Idempotency-Key was already used for a different request");
  return { ...(done.outcome as T), replayed: true };
}

/** A comp change on the team's META item, at the version the operator saw. */
function change(
  db: Db,
  operator: Operator,
  teamId: string,
  input: {
    readonly action: OperatorAction;
    readonly key: string;
    readonly body: Record<string, unknown>;
    readonly expectedVersion: number;
    readonly reason: string;
    readonly before: Record<string, unknown> | null;
    readonly after: Record<string, unknown> | null;
    readonly update: { UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown>; extraCondition?: string };
    readonly comp: Comp | null;
  },
  now: Date,
): Promise<CompOutcome> {
  return auditedUpdate<CompOutcome>(
    db,
    operator,
    teamId,
    {
      ...input,
      update: {
        Key: keys.team(teamId),
        UpdateExpression: input.update.UpdateExpression,
        // Only the META item, only at the version the operator saw
        ConditionExpression: ["#type = :team", "#version = :v", ...(input.update.extraCondition ? [input.update.extraCondition] : [])].join(" AND "),
        ExpressionAttributeNames: { "#type": "type", "#version": "version", ...input.update.ExpressionAttributeNames },
        ExpressionAttributeValues: { ":team": "team", ":v": input.expectedVersion, ":one": 1, ...input.update.ExpressionAttributeValues },
      },
      outcome: (eventId) => ({ eventId, replayed: false, comp: input.comp, version: input.expectedVersion + 1 }),
      changed: "The team changed since you read it; read it again and retry",
    },
    now,
  );
}

/**
 * Comps a team, or changes or extends its comp: `plan` (for example `free`
 * for a pilot), optional `seats`, until when (at most MAX_COMP_MONTHS ahead)
 * and why. Writes only the comp attributes (never `plan` or `status`, ADR
 * 0009), and the audit item, in one transaction.
 */
export async function setComp(
  db: Db,
  operator: Operator,
  teamId: string,
  input: { readonly plan: unknown; readonly seats?: unknown; readonly until: unknown; readonly reason: unknown; readonly expectedVersion: unknown; readonly idempotencyKey: unknown },
  now = new Date(),
): Promise<CompOutcome> {
  const sub = operatorSub(operator);
  id(teamId, "team ID");
  const key = requestKey(input.idempotencyKey);
  const version = expectedVersion(input.expectedVersion);
  const plan = compPlan(input.plan);
  const seats = compSeats(input.seats);
  const until = compUntil(input.until, now);
  const reason = operatorReason(input.reason);
  const team = await findTeam(db, teamId);
  if (!team) throw new NotFoundError("No such team");
  if (team.closedAt) throw new ConflictError(CLOSED);
  const at = now.toISOString();
  const values: Record<string, unknown> = { ":plan": plan, ":until": until, ":reason": reason, ":by": sub, ":at": at };
  const sets = ["compPlan = :plan", "compUntil = :until", "compReason = :reason", "compBy = :by", "compAt = :at", "#version = #version + :one"];
  if (seats !== undefined) {
    sets.push("compSeats = :seats");
    values[":seats"] = seats;
  }
  const after = { plan, seats: seats ?? null, until, reason };
  return change(
    db,
    operator,
    teamId,
    {
      action: "ops.comp.set",
      key,
      body: { plan, seats: seats ?? null, until, reason, expectedVersion: version },
      expectedVersion: version,
      reason,
      before: compRecord(team),
      after,
      update: { UpdateExpression: `SET ${sets.join(", ")}${seats === undefined ? " REMOVE compSeats" : ""}`, ExpressionAttributeNames: {}, ExpressionAttributeValues: values },
      comp: liveComp({ compPlan: plan, compSeats: seats, compUntil: until }, now) ?? null,
    },
    now,
  );
}

/** Ends a team's comp now. ConflictError if it has none (or the version moved). */
export async function endComp(
  db: Db,
  operator: Operator,
  teamId: string,
  input: { readonly reason: unknown; readonly expectedVersion: unknown; readonly idempotencyKey: unknown },
  now = new Date(),
): Promise<CompOutcome> {
  operatorSub(operator);
  id(teamId, "team ID");
  const key = requestKey(input.idempotencyKey);
  const version = expectedVersion(input.expectedVersion);
  const reason = operatorReason(input.reason);
  const team = await findTeam(db, teamId);
  if (!team) throw new NotFoundError("No such team");
  if (team.closedAt) throw new ConflictError(CLOSED);
  if (team.compPlan === undefined) throw new ConflictError("This team has no comp");
  return change(
    db,
    operator,
    teamId,
    {
      action: "ops.comp.end",
      key,
      body: { reason, expectedVersion: version },
      expectedVersion: version,
      reason,
      before: compRecord(team),
      after: null,
      update: {
        UpdateExpression: "SET #version = #version + :one REMOVE compPlan, compSeats, compUntil, compReason, compBy, compAt",
        ExpressionAttributeNames: {},
        ExpressionAttributeValues: {},
        extraCondition: "attribute_exists(compPlan)",
      },
      comp: null,
    },
    now,
  );
}

/**
 * The operator audit, newest first: one team's (`teamId`), in full, or a
 * summary of every team's for a month (`month`, YYYY-MM, from the index,
 * which is eventually consistent).
 */
export async function listOperatorAudit(
  db: Db,
  operator: Operator,
  options: { readonly teamId?: string; readonly month?: string; readonly limit?: number; readonly cursor?: string },
): Promise<Page<OperatorAuditEvent | OperatorAuditSummary>> {
  operatorSub(operator);
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError("limit is a number from 1 to 100");
  if (options.teamId !== undefined) {
    const pk = operatorAuditPartition(options.teamId);
    return queryPage<OperatorAuditEvent>(
      db,
      {
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "AUDIT#" },
        ScanIndexForward: false,
        Limit: limit,
      },
      { attribute: PK, value: pk },
      options.cursor,
    );
  }
  const pk = opsAuditIndexPartition(month(options.month));
  const page = await queryPage<Record<string, unknown>>(
    db,
    {
      IndexName: GSI3,
      KeyConditionExpression: "GSI3PK = :pk",
      Select: "ALL_PROJECTED_ATTRIBUTES",
      ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: false,
      Limit: limit,
    },
    { attribute: GSI3PK, value: pk },
    options.cursor,
    { keepKeys: true },
  );
  return { items: page.items.map(auditSummary).filter((e): e is OperatorAuditSummary => e !== undefined), ...(page.cursor ? { cursor: page.cursor } : {}) };
}

/** A month's audit event, from the index: when, which team, what and who. The rest is in the team's audit. */
function auditSummary(item: Record<string, unknown>): OperatorAuditSummary | undefined {
  const teamId = keyId(item.PK, OPERATOR_AUDIT_PREFIX);
  const sk = /^AUDIT#(.+)#([A-Za-z0-9_-]{1,128})$/.exec(String(item.SK));
  if (!teamId || !sk) return undefined;
  return { eventId: sk[2] as string, ts: sk[1] as string, teamId, action: item.action as OperatorAction, operatorSub: String(item.operatorSub) };
}

/**
 * Every team's imports still committing that started before `startedBefore`
 * (by default STUCK_IMPORT_AFTER_MINUTES ago), oldest first: what the
 * "Imports stuck" alarm counts. Only their keys and progress: the
 * operator-access role may read nothing else there.
 */
export async function listStuckImportsForOps(db: Db, operator: Operator, startedBefore: Date): Promise<StuckImport[]> {
  operatorSub(operator);
  return listStuckImports(db, startedBefore);
}

/** The outcome of clearing a stuck import. */
export interface ClearImportOutcome {
  readonly eventId: string;
  readonly replayed: boolean;
}

/**
 * Takes a stuck import out of GSI1's committing-imports partition, so the
 * "Imports stuck" alarm recovers (docs/journeys.md, J2), with an audit item
 * (`ops.import.clear`) in the same transaction. Only the index keys change:
 * the job and its staged plan stay, so a retry of it still works until it
 * expires. The update's condition keeps it to an import job that's still in
 * that partition and started before `startedBefore`, so it can't touch an
 * import that's still running or any other item.
 */
export async function clearStuckImport(
  db: Db,
  operator: Operator,
  teamId: string,
  importId: string,
  input: { readonly reason: unknown; readonly idempotencyKey: unknown; readonly startedBefore: Date },
  now = new Date(),
): Promise<ClearImportOutcome> {
  operatorSub(operator);
  const key = requestKey(input.idempotencyKey);
  const reason = operatorReason(input.reason);
  const jobKey = keys.importJob(teamId, importId);
  return auditedUpdate<ClearImportOutcome>(
    db,
    operator,
    teamId,
    {
      action: "ops.import.clear",
      key,
      body: { importId, reason },
      reason,
      before: { importId, committing: true },
      after: { importId, committing: false },
      update: {
        Key: jobKey,
        UpdateExpression: "REMOVE GSI1PK, GSI1SK",
        ConditionExpression: "GSI1PK = :committing AND GSI1SK < :before",
        ExpressionAttributeValues: { ":committing": COMMITTING_IMPORTS_PARTITION, ":before": input.startedBefore.toISOString() },
      },
      outcome: (eventId) => ({ eventId, replayed: false }),
      changed: "That import isn't stuck: it finished, was cleared already, doesn't exist, or started too recently",
    },
    now,
  );
}

/**
 * An operator can reopen a closed team until this long before its
 * `purgeAfter`, past the owners' REOPEN_CUTOFF_MINUTES (supply-checkout-6uw.6:
 * restoring a disputed closure in its last hour). The purge deletes a team
 * only once `purgeAfter` has passed, and marks it `purging` first, which the
 * reopen's condition refuses, so a reopen can't meet a purge part-way
 * whatever the clocks say; the margin is only for clarity to operators.
 */
export const OPS_REOPEN_CUTOFF_MINUTES = 5;

/** The result of an operator reopen. `replayed` when the Idempotency-Key had already done it. */
export interface ReopenOutcome {
  readonly eventId: string;
  readonly replayed: boolean;
  /** The team's version after the reopen. */
  readonly version: number;
}

const NOT_CLOSED = "This team isn't closed";
const TOO_LATE_FOR_OPS = "This team is about to be deleted and can't be reopened any more";

/**
 * Reopens a closed team for an operator (supply-checkout-6uw.6), at the
 * version the operator read (`expectedVersion`) and with a reason, until
 * OPS_REOPEN_CUTOFF_MINUTES before its purge (TeamDeletingError after). Like
 * an owner's reopen (reopenTeam), the META item loses `closedAt`, `closedBy`,
 * `purgeAfter` and its closed-teams index keys, so the purge no longer finds
 * it and it's writable again, and its version moves. In the same transaction
 * an `ops.team.reopen` audit item records when it was closed and when it
 * would have been deleted, which its owners read in their support actions,
 * attributed to "Supply Checkout support". The update is conditioned on the
 * closure read being unchanged, on `purgeAfter` still being far enough
 * ahead, on the team not being marked `purging` (purgeTeam's mark, set
 * before it deletes anything: whichever write lands first wins), and on the
 * team having an owner.
 *
 * Like an owner's reopen, it sets `stripeResyncFor` to the closure it ends
 * and `stripeReopenedAt` to now,
 * and doesn't call Stripe: the ops function's seat sync has the billing
 * worker resync the subscription (billing/reopening.ts).
 *
 * Unlike an owner's reopen there's no daily limit (the route's throttle and
 * the audit are the operators' limits) and no email to owners yet. Invites
 * deleted at closing stay deleted, as for an owner's reopen.
 *
 * Runs on the operator-reopen role (REOPEN_ATTRIBUTES), never the
 * operator-access role: it reads the META item's closure fields directly,
 * since GSI3 doesn't project `purgeAfter`.
 */
export async function reopenOpsTeam(
  db: Db,
  operator: Operator,
  teamId: string,
  input: { readonly reason: unknown; readonly expectedVersion: unknown; readonly idempotencyKey: unknown },
  now = new Date(),
): Promise<ReopenOutcome> {
  operatorSub(operator);
  id(teamId, "team ID");
  const key = requestKey(input.idempotencyKey);
  const version = expectedVersion(input.expectedVersion);
  const reason = operatorReason(input.reason);
  const body = { reason, expectedVersion: version };
  const { Item: team } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.team(teamId),
      ConsistentRead: true,
      // Only REOPEN_ATTRIBUTES: the role may read nothing else of the team
      ProjectionExpression: "#type, #version, #owners, closedAt, purgeAfter, purging",
      ExpressionAttributeNames: { "#type": "type", "#version": "version", "#owners": "owners" },
    }),
  );
  if (!team || team.type !== "team") throw new NotFoundError("No such team");
  if (typeof team.closedAt !== "string") {
    // A retry of a reopen that already happened replays it
    const done = await replay<ReopenOutcome>(db, operatorKeys.request(teamId, keyHash(operator, teamId, "ops.team.reopen", key)), bodyHash(body));
    if (done) return done;
    throw new ConflictError(NOT_CLOSED);
  }
  if (team.version !== version) throw new ConflictError("The team changed since you read it; read it again and retry");
  const cutoff = new Date(now.getTime() + OPS_REOPEN_CUTOFF_MINUTES * 60_000).toISOString();
  // Too close to the purge, or the purge has started: it marks the team `purging` before deleting anything
  if (typeof team.purgeAfter !== "string" || team.purgeAfter <= cutoff || team.purging !== undefined) throw new TeamDeletingError(TOO_LATE_FOR_OPS);
  if (typeof team.owners !== "number" || team.owners < 1) throw new ConflictError("This team has no owner left to reopen it for");
  return auditedUpdate<ReopenOutcome>(
    db,
    operator,
    teamId,
    {
      action: "ops.team.reopen",
      key,
      body,
      reason,
      before: { closedAt: team.closedAt, purgeAfter: team.purgeAfter },
      after: null,
      update: {
        Key: keys.team(teamId),
        // stripeResyncFor, as an owner's reopen: the billing worker resyncs the subscription (billing/reopening.ts)
        UpdateExpression: "REMOVE closedAt, closedBy, purgeAfter, GSI1PK, GSI1SK SET #version = #version + :one, stripeResyncFor = :at, stripeReopenedAt = :now",
        // The META item, at the version and with the closure the operator saw, still ahead of the purge
        ConditionExpression: "#type = :team AND #version = :v AND closedAt = :at AND purgeAfter = :purge AND purgeAfter > :cutoff AND attribute_not_exists(purging) AND #owners > :zero",
        ExpressionAttributeNames: { "#type": "type", "#version": "version", "#owners": "owners" },
        ExpressionAttributeValues: { ":team": "team", ":v": version, ":at": team.closedAt, ":purge": team.purgeAfter, ":cutoff": cutoff, ":one": 1, ":zero": 0, ":now": now.toISOString() },
      },
      outcome: (eventId) => ({ eventId, replayed: false, version: version + 1 }),
      changed: "The team changed since you read it; read it again and retry",
    },
    now,
  );
}

/**
 * What one receipt read costs us, roughly, in US dollars: the top of ADR
 * 0008's estimate for Claude Haiku 4.5 (about $0.005 to $0.007 a receipt at
 * list prices). PROVISIONAL: an estimate, not billing. It turns read counts
 * into the "cost per team" operators see (supply-checkout-wxx); the real
 * spend is in Cost Explorer, and tokens per team in the receipts function's
 * logs (ReceiptTokens).
 */
export const ESTIMATED_COST_PER_RECEIPT_USD = 0.007;

/** Months of a team's receipt reads its ops record shows: this one and the five before. */
export const OPS_USAGE_MONTHS = 6;

/** Keys one BatchGetItem may ask for (DynamoDB's limit). */
const BATCH_GET_KEYS = 100;

/** A team's receipt reads, for operators: per UTC month, and in its trial, with the estimated cost. */
export interface OpsReceiptUsage {
  readonly months: { readonly month: string; readonly receipts: number; readonly estimatedCostUsd: number }[];
  /** Reads while the team wasn't paying, in all (USAGE#TRIAL; they count in their months too). */
  readonly trialReceipts: number;
}

const cost = (receipts: number) => Math.round(receipts * ESTIMATED_COST_PER_RECEIPT_USD * 10_000) / 10_000;

/** `m` and the months before it, newest first: YYYY-MM. */
function monthsBack(m: string, count: number): string[] {
  const [y, mo] = month(m).split("-").map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, mo - 1 - i, 1)).toISOString().slice(0, 7));
}

/**
 * The `receipts` count of each key, read with BatchGetItem projecting only the
 * keys and `receipts` (the operator-access role allows nothing else of a
 * team's items, and no Query there: only these exact keys). Missing items
 * count 0. Keys DynamoDB leaves unprocessed are asked for again.
 */
async function receiptCounts(db: Db, wanted: { PK: string; SK: string }[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let i = 0; i < wanted.length; i += BATCH_GET_KEYS) {
    let Keys: Record<string, unknown>[] | undefined = wanted.slice(i, i + BATCH_GET_KEYS);
    for (let attempt = 1; Keys?.length; attempt++) {
      if (attempt > 5) throw new Error("Receipt usage reads kept coming back unprocessed");
      const out: BatchGetCommandOutput = await connection(db).doc.send(
        new BatchGetCommand({ RequestItems: { [db.tableName]: { Keys, ProjectionExpression: "PK, SK, receipts", ConsistentRead: false } } }),
      );
      for (const item of out.Responses?.[db.tableName] ?? []) {
        if (typeof item.receipts === "number") counts.set(`${String(item.PK)} ${String(item.SK)}`, item.receipts);
      }
      Keys = out.UnprocessedKeys?.[db.tableName]?.Keys;
      if (Keys?.length) await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  return counts;
}

const countOf = (counts: Map<string, number>, key: { PK: string; SK: string }) => counts.get(`${key.PK} ${key.SK}`) ?? 0;

/**
 * One team's receipt reads for its ops record: the OPS_USAGE_MONTHS months to
 * `now`'s, and its trial's. Not audited on its own: it's part of reading the
 * team's record (getOpsTeam, `ops.team.read`).
 */
export async function getOpsReceiptUsage(db: Db, operator: Operator, teamId: string, now = new Date()): Promise<OpsReceiptUsage> {
  operatorSub(operator);
  const months = monthsBack(now.toISOString().slice(0, 7), OPS_USAGE_MONTHS);
  const monthKeys = months.map((m) => keys.usage(teamId, m));
  const trialKey = keys.trialUsage(teamId);
  const counts = await receiptCounts(db, [...monthKeys, trialKey]);
  return {
    months: months.map((m, i) => {
      const receipts = countOf(counts, monthKeys[i] as { PK: string; SK: string });
      return { month: m, receipts, estimatedCostUsd: cost(receipts) };
    }),
    trialReceipts: countOf(counts, trialKey),
  };
}

/** One team in the month's receipt ranking. */
export interface OpsReceiptRank {
  readonly teamId: string;
  readonly name: string;
  readonly status: string;
  readonly plan: string;
  readonly compLive: boolean;
  readonly receipts: number;
  readonly trialReceipts: number;
  readonly estimatedCostUsd: number;
}

/**
 * The teams that read the most receipts in month `m` (YYYY-MM), most first,
 * `limit` of them (20 by default, at most 100), with each one's trial reads
 * and estimated cost. It walks the team list in the operators' index (at most
 * MAX_OPS_TEAMS_READ teams; `complete` is false if there were more) and reads
 * each team's month and trial counters by key. Audited (`ops.receipts.usage`,
 * in the platform partition) before anything is returned, with the teams it
 * returns.
 */
export async function listOpsReceiptUsage(
  db: Db,
  operator: Operator,
  options: { readonly month: string; readonly limit?: number },
  now = new Date(),
): Promise<{ month: string; teams: OpsReceiptRank[]; teamsRead: number; complete: boolean; estimatedCostPerReceiptUsd: number }> {
  operatorSub(operator);
  const m = month(options.month);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError("limit is a number from 1 to 100");
  const teams: OpsTeam[] = [];
  let start: Record<string, unknown> | undefined;
  let complete = true;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI3,
        KeyConditionExpression: "GSI3PK = :pk",
        // The operator-access role requires it (dynamodb:Select): only what the index projects
        Select: "ALL_PROJECTED_ATTRIBUTES",
        ExpressionAttributeValues: { ":pk": OPS_TEAMS_PARTITION },
        Limit: MAX_OPS_TEAMS_READ - teams.length,
        ExclusiveStartKey: start,
      }),
    );
    for (const item of page.Items ?? []) {
      const team = toTeam(item);
      if (team) teams.push(team);
    }
    start = page.LastEvaluatedKey;
    if (start && teams.length >= MAX_OPS_TEAMS_READ) complete = false;
  } while (start && complete);
  const wanted = teams.flatMap((t) => [keys.usage(t.teamId, m), keys.trialUsage(t.teamId)]);
  const counts = await receiptCounts(db, wanted);
  const ranked = teams
    .map((t) => {
      const receipts = countOf(counts, keys.usage(t.teamId, m));
      return { teamId: t.teamId, name: t.name, status: t.status, plan: t.plan, compLive: liveComp(t, now) !== undefined, receipts, trialReceipts: countOf(counts, keys.trialUsage(t.teamId)), estimatedCostUsd: cost(receipts) };
    })
    .filter((t) => t.receipts > 0)
    .sort((a, b) => b.receipts - a.receipts || a.teamId.localeCompare(b.teamId))
    .slice(0, limit);
  await connection(db).doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: auditItem(operator, PLATFORM_AUDIT, { action: "ops.receipts.usage", before: null, after: { month: m, teams: ranked.map((t) => t.teamId) } }, now),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return { month: m, teams: ranked, teamsRead: teams.length, complete, estimatedCostPerReceiptUsd: ESTIMATED_COST_PER_RECEIPT_USD };
}
