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
// Every change writes its audit item in the same transaction, with a record
// of the request's Idempotency-Key, so a retry replays instead of acting
// twice. Reading one team's record is audited too.

import { createHash, randomUUID } from "node:crypto";
import { PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, InvalidInputError, NotFoundError } from "./errors.js";
import { gsi3, id, keys, month, operatorAuditPartition, operatorKeys, opsAuditIndexPartition, opsOwnersPartition, strip } from "./keys.js";
import { type Comp, MEMBERS_PER_TEAM, liveComp } from "./model.js";
import { type Page, queryPage } from "./query.js";
import { GSI3, GSI3PK, OPERATOR_AUDIT_PREFIX, OPS_TEAMS_PARTITION, PK } from "./schema.js";

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
  readonly members?: number;
  readonly createdAt: string;
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

export type OperatorAction = "ops.teams.list" | "ops.team.read" | "ops.comp.set" | "ops.comp.end";

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
/** The most teams the list reads. Past it, the partition needs sharding (ADR 0015). */
export const MAX_OPS_TEAMS = 5000;

const DAY_SECONDS = 24 * 60 * 60;
const PLAN = /^[a-z][a-z0-9_-]{0,31}$/;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;
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

/** Every item in a GSI3 partition, newest first, projected attributes only. */
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
  return /^[A-Za-z0-9_-]{1,128}$/.test(rest) ? rest : undefined;
}

/** A team from its index item: the index projects the account record, and the team's ID is in its key. */
function toTeam(item: Record<string, unknown>): OpsTeam | undefined {
  const teamId = keyId(item.PK, "TEAM#");
  if (!teamId || item.SK !== "META") return undefined;
  return { ...strip<Omit<OpsTeam, "teamId">>(item), teamId } as OpsTeam;
}

/** Every team, newest first, as the operators' index holds them. */
async function allTeams(db: Db): Promise<OpsTeam[]> {
  return (await indexPartition(db, OPS_TEAMS_PARTITION, MAX_OPS_TEAMS))
    .map(toTeam)
    .filter((t): t is OpsTeam => t !== undefined)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.teamId.localeCompare(b.teamId));
}

/**
 * Teams, newest first, 50 a page: every team, or those whose name contains
 * `q` (ignoring case) or whose ID is `q`. The cursor is the last team's ID.
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
  const q = raw?.toLowerCase();
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError("limit is a number from 1 to 100");
  let teams = await allTeams(db);
  if (q) teams = teams.filter((t) => t.teamId === raw || t.name.toLowerCase().includes(q));
  if (options.cursor !== undefined) {
    const at = teams.findIndex((t) => t.teamId === id(options.cursor, "cursor"));
    if (at < 0) throw new InvalidInputError("Invalid cursor");
    teams = teams.slice(at + 1);
  }
  const page = teams.slice(0, limit);
  // The list shows owners' emails like one team's record does, so it's audited too, before anything is returned
  await connection(db).doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: auditItem(operator, PLATFORM_AUDIT, { action: "ops.teams.list", before: null, after: { q: raw ?? null, cursor: options.cursor ?? null, teams: page.map((t) => t.teamId) } }, now),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return { teams: page, ...(teams.length > limit ? { cursor: page[page.length - 1]?.teamId } : {}) };
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

/**
 * Runs one operator change: `update` on the team's META item (conditioned on
 * the item being a team at `expectedVersion`), its audit item and the
 * request's idempotency record, all in one transaction. A retry with the same
 * key and body replays the first result; the same key with another body is a
 * ConflictError.
 */
async function change(
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
  const request = operatorKeys.request(teamId, keyHash(operator, teamId, input.action, input.key));
  const hash = bodyHash(input.body);
  const audit = auditItem(operator, teamId, { action: input.action, reason: input.reason, before: input.before, after: input.after, idempotencyKey: input.key }, now);
  const outcome: CompOutcome = { eventId: audit.eventId, replayed: false, comp: input.comp, version: input.expectedVersion + 1 };
  const epoch = Math.floor(now.getTime() / 1000);
  try {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: db.tableName,
              Key: keys.team(teamId),
              UpdateExpression: input.update.UpdateExpression,
              // Only the META item, only at the version the operator saw
              ConditionExpression: ["#type = :team", "#version = :v", ...(input.update.extraCondition ? [input.update.extraCondition] : [])].join(" AND "),
              ExpressionAttributeNames: { "#type": "type", "#version": "version", ...input.update.ExpressionAttributeNames },
              ExpressionAttributeValues: { ":team": "team", ":v": input.expectedVersion, ":one": 1, ...input.update.ExpressionAttributeValues },
            },
          },
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
      const { Items } = await connection(db).doc.send(
        new QueryCommand({ TableName: db.tableName, KeyConditionExpression: "PK = :pk AND SK = :sk", ExpressionAttributeValues: { ":pk": request.PK, ":sk": request.SK }, ConsistentRead: true }),
      );
      const done = Items?.[0];
      // The record can expire between the condition and this read; then the retry is just late
      if (done && done.bodyHash === hash) return { ...(done.outcome as CompOutcome), replayed: true };
      throw new ConflictError("This Idempotency-Key was already used for a different request");
    }
    if (codes[0] === "ConditionalCheckFailed") throw new ConflictError("The team changed since you read it; read it again and retry");
    if (codes.includes("TransactionConflict")) throw new ConflictError("The team is changing right now; try again");
    throw error;
  }
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
