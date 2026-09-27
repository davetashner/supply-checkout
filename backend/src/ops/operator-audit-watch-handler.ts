// The operator audit watch (supply-checkout-6uw.5, ADR 0015), a consumer of
// the table's stream in the primary region.
//
// Operator audit items (`OPAUDIT#<teamId>` and `OPAUDIT#PLATFORM`: each
// action's `AUDIT#` item and each write's `REQUEST#` idempotency record) are
// append-only. The operator-access role may PutItem there but never update or
// delete, yet a PutItem on an existing key replaces the item, so a
// compromised ops function could overwrite an audit entry. Nothing in the app
// ever changes or deletes one: they leave only when their TTL (`expiresAt`)
// passes. So every MODIFY or REMOVE of an operator audit item is counted in
// OperatorAuditChanged, which alarms P1 ("Operator audit changed"), except:
//
// - TTL deletions: a REMOVE whose record says DynamoDB's TTL process made it
//   (userIdentity type Service, principal dynamodb.amazonaws.com);
// - a REMOVE of an item whose `expiresAt` had already passed. A global
//   table's replica may show another replica's TTL deletion without the TTL
//   identity, and an expired item is past its retention anyway. To make a
//   live item look expired, `expiresAt` must first be changed, which is a
//   MODIFY and alarms.
//
// It also counts an INSERT of an `AUDIT#` item whose `expiresAt` is well short
// of the 2 years every audit item is written with (more than
// SHORT_RETENTION_SLACK_DAYS short of OPERATOR_AUDIT_RETENTION_DAYS after the
// write, supply-checkout-6uw.11): the TTL would then delete it early as a
// "TTL expiry", which a REMOVE can't be told apart from. An item with no
// `expiresAt` is kept forever, which hides nothing, so it isn't counted.
//
// And it counts each write of its heartbeat item (OPERATOR_AUDIT_HEARTBEAT,
// rewritten every HEARTBEAT_EVERY_MINUTES by a schedule) in
// OperatorAuditWatchHeartbeat. "Operator audit watch silent" fires when none
// arrives for a while, so anything that stops this function reading the
// stream or its metrics reaching CloudWatch (a disabled mapping, zero
// concurrency, a stream or key policy, a deleted log group) is seen.
//
// The event source mapping only passes MODIFY and REMOVE records whose
// partition key starts with OPAUDIT#, INSERTs whose sort key also starts
// with AUDIT#, and writes of the heartbeat item
// (infra/lib/observability/operator-audit-watch.ts), so this function never
// sees team data. It logs each change with its keys'
// IDs and the event name: never the item's attributes (reasons, operator subs).

import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { OPERATOR_AUDIT_HEARTBEAT, OPERATOR_AUDIT_PREFIX, OPERATOR_AUDIT_RETENTION_DAYS } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";

export interface OperatorAuditWatchDeps {
  readonly obs: Observability;
  readonly now?: () => number;
}

/** The TTL process's identity on the stream records of the items it deletes. */
const TTL_PRINCIPAL = "dynamodb.amazonaws.com";
const KEY = /^[A-Za-z0-9_#:.+-]{1,300}$/;
const DAY_SECONDS = 86_400;
/** How far short of OPERATOR_AUDIT_RETENTION_DAYS a new audit item's `expiresAt` may be (clock skew, stream delay) before it counts. */
export const SHORT_RETENTION_SLACK_DAYS = 7;

/** A REMOVE made by DynamoDB's TTL process, or of an item whose TTL had already passed. */
export function isExpiry(record: DynamoDBRecord, nowMs: number): boolean {
  if (record.eventName !== "REMOVE") return false;
  const who = record.userIdentity as { type?: unknown; principalId?: unknown } | undefined;
  if (who?.type === "Service" && who.principalId === TTL_PRINCIPAL) return true;
  const expiresAt = Number(record.dynamodb?.OldImage?.expiresAt?.N);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt * 1000 <= nowMs;
}

/**
 * A new operator audit entry (`AUDIT#`) set to expire well before its 2
 * years: more than SHORT_RETENTION_SLACK_DAYS short of
 * OPERATOR_AUDIT_RETENTION_DAYS after it was written (the stream's time for
 * the write, or now).
 */
export function isShortLived(record: DynamoDBRecord, nowMs: number): boolean {
  if (record.eventName !== "INSERT") return false;
  const sk = record.dynamodb?.Keys?.SK?.S;
  if (typeof sk !== "string" || !sk.startsWith("AUDIT#")) return false;
  const raw = record.dynamodb?.NewImage?.expiresAt?.N;
  if (raw === undefined) return false;
  const expiresAt = Number(raw);
  const written = Number(record.dynamodb?.ApproximateCreationDateTime) || nowMs / 1000;
  return !Number.isFinite(expiresAt) || expiresAt < written + (OPERATOR_AUDIT_RETENTION_DAYS - SHORT_RETENTION_SLACK_DAYS) * DAY_SECONDS;
}

/** An operator audit item's change that isn't its expiry, or a new entry set to expire early: tampering. */
export function isTampering(record: DynamoDBRecord, nowMs: number): boolean {
  const pk = record.dynamodb?.Keys?.PK?.S;
  if (typeof pk !== "string" || !pk.startsWith(OPERATOR_AUDIT_PREFIX)) return false;
  if (record.eventName === "INSERT") return isShortLived(record, nowMs);
  if (record.eventName !== "MODIFY" && record.eventName !== "REMOVE") return false;
  return !isExpiry(record, nowMs);
}

/** A write of the watch's heartbeat item. */
export function isHeartbeat(record: DynamoDBRecord): boolean {
  const keys = record.dynamodb?.Keys;
  return (record.eventName === "INSERT" || record.eventName === "MODIFY") && keys?.PK?.S === OPERATOR_AUDIT_HEARTBEAT.PK && keys?.SK?.S === OPERATOR_AUDIT_HEARTBEAT.SK;
}

/** A key for the log: as stored when it looks like one of ours, otherwise only that it was odd. */
function loggable(value: unknown): string {
  return typeof value === "string" && KEY.test(value) ? value : "(unexpected key)";
}

export function createOperatorAuditWatchHandler(deps: OperatorAuditWatchDeps) {
  const { obs } = deps;
  const now = deps.now ?? Date.now;
  return async (event: DynamoDBStreamEvent): Promise<{ changed: number; heartbeats: number }> => {
    const at = now();
    let changed = 0;
    let heartbeats = 0;
    for (const record of event.Records ?? []) {
      if (isHeartbeat(record)) heartbeats++;
      if (!isTampering(record, at)) continue;
      changed++;
      obs.logger.error(record.eventName === "INSERT" ? "Operator audit item written to expire early" : "Operator audit item changed", {
        eventName: record.eventName,
        pk: loggable(record.dynamodb?.Keys?.PK?.S),
        sk: loggable(record.dynamodb?.Keys?.SK?.S),
        eventId: loggable(record.eventID),
        region: loggable(record.awsRegion),
      });
    }
    if (changed > 0) obs.count(BusinessMetric.OperatorAuditChanged, changed);
    if (heartbeats > 0) obs.count(BusinessMetric.OperatorAuditWatchHeartbeat, heartbeats);
    return { changed, heartbeats };
  };
}
