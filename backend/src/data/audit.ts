// The audit trail (ADR 0005): who changed what, newest first, removed by TTL
// after the retention period.

import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ForbiddenError, InvalidInputError } from "./errors.js";
import { keys, operatorAuditPartition, prefixes, teamPartition } from "./keys.js";
import { type Page, queryPage } from "./query.js";
import { OWNER_OPERATOR_AUDIT_ATTRIBUTES, PK } from "./schema.js";
import { type TeamContext, assertContext, readable } from "./team-context.js";

export interface AuditEvent {
  readonly type: "audit";
  readonly eventId: string;
  readonly ts: string;
  readonly userId: string;
  readonly action: string;
  readonly target?: string;
  readonly detail?: Record<string, unknown>;
  readonly expiresAt: number;
}

export const AUDIT_RETENTION_DAYS = 365;

/**
 * Records an event for the context's team. Any member's action is audited,
 * viewers included (for example, a CSV download), so this needs no write role.
 */
export async function recordAudit(
  db: Db,
  ctx: TeamContext,
  input: { readonly action: string; readonly target?: string; readonly detail?: Record<string, unknown> },
  now = new Date(),
): Promise<AuditEvent> {
  assertContext(ctx);
  if (typeof input.action !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(input.action)) throw new InvalidInputError("Invalid action");
  const event: AuditEvent = {
    type: "audit",
    eventId: randomUUID(),
    ts: now.toISOString(),
    userId: ctx.userId,
    action: input.action,
    target: input.target,
    detail: input.detail,
    expiresAt: Math.floor(now.getTime() / 1000) + AUDIT_RETENTION_DAYS * 24 * 60 * 60,
  };
  await connection(db).doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.audit(ctx.teamId, event.ts, event.eventId), ...event } }));
  return event;
}

/** Owners read the audit trail, newest first. */
export async function listAudit(
  db: Db,
  ctx: TeamContext,
  options: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<Page<AuditEvent>> {
  readable(ctx);
  if (ctx.role !== "owner" && ctx.role !== "system") throw new ForbiddenError("Only owners can read the audit trail");
  const pk = teamPartition(ctx.teamId);
  return queryPage<AuditEvent>(
    db,
    {
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefixes.audit },
      ScanIndexForward: false,
      Limit: options.limit,
    },
    { attribute: PK, value: pk },
    options.cursor,
  );
}

/** How the team sees who took an operator action (ADR 0015): never the operator's identity. */
export const SUPPORT_ACTOR = "Supply Checkout support";

/** An operator action on the team, as its owners see it. */
export interface SupportAction {
  readonly eventId: string;
  readonly ts: string;
  readonly actor: typeof SUPPORT_ACTOR;
  readonly action: string;
  readonly reason?: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

/**
 * Owners read what operators did to their team (ADR 0015), newest first:
 * comps, and reads of the team's account record. Only the attributes in
 * OWNER_OPERATOR_AUDIT_ATTRIBUTES are asked for, which is all the data-access
 * role may read there, so the operator's identity never leaves the table.
 */
export async function listSupportActions(
  db: Db,
  ctx: TeamContext,
  options: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<Page<SupportAction>> {
  readable(ctx);
  if (ctx.role !== "owner") throw new ForbiddenError("Only owners can read support actions");
  const pk = operatorAuditPartition(ctx.teamId);
  const page = await queryPage<Record<string, unknown>>(
    db,
    {
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      // The data-access role requires both (dynamodb:Select, dynamodb:Attributes)
      Select: "SPECIFIC_ATTRIBUTES",
      ProjectionExpression: OWNER_OPERATOR_AUDIT_ATTRIBUTES.map((_, i) => `#a${i}`).join(", "),
      ExpressionAttributeNames: Object.fromEntries(OWNER_OPERATOR_AUDIT_ATTRIBUTES.map((name, i) => [`#a${i}`, name])),
      ExpressionAttributeValues: { ":pk": pk, ":prefix": "AUDIT#" },
      ScanIndexForward: false,
      Limit: options.limit,
    },
    { attribute: PK, value: pk },
    options.cursor,
  );
  return {
    items: page.items.map((item) => ({
      eventId: String(item.eventId),
      ts: String(item.ts),
      actor: SUPPORT_ACTOR,
      action: String(item.action),
      ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
      ...("before" in item ? { before: item.before as Record<string, unknown> | null } : {}),
      ...("after" in item ? { after: item.after as Record<string, unknown> | null } : {}),
    })),
    ...(page.cursor ? { cursor: page.cursor } : {}),
  };
}
