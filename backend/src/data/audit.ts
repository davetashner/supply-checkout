// The audit trail (ADR 0005): who changed what, newest first, removed by TTL
// after the retention period.

import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Db } from "./client.js";
import { ForbiddenError, InvalidInputError } from "./errors.js";
import { keys, prefixes, teamPartition } from "./keys.js";
import { type Page, queryPage } from "./query.js";
import { PK } from "./schema.js";
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
  await db.doc.send(new PutCommand({ TableName: db.tableName, Item: { ...keys.audit(ctx.teamId, event.ts, event.eventId), ...event } }));
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
