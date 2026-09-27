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
// The event source mapping only passes MODIFY and REMOVE records whose
// partition key starts with OPAUDIT# (infra/lib/stacks/observability-stack.ts),
// so this function never sees team data. It logs each change with its keys'
// IDs and the event name: never the item's attributes (reasons, operator subs).

import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { OPERATOR_AUDIT_PREFIX } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";

export interface OperatorAuditWatchDeps {
  readonly obs: Observability;
  readonly now?: () => number;
}

/** The TTL process's identity on the stream records of the items it deletes. */
const TTL_PRINCIPAL = "dynamodb.amazonaws.com";
const KEY = /^[A-Za-z0-9_#:.+-]{1,300}$/;

/** A REMOVE made by DynamoDB's TTL process, or of an item whose TTL had already passed. */
export function isExpiry(record: DynamoDBRecord, nowMs: number): boolean {
  if (record.eventName !== "REMOVE") return false;
  const who = record.userIdentity as { type?: unknown; principalId?: unknown } | undefined;
  if (who?.type === "Service" && who.principalId === TTL_PRINCIPAL) return true;
  const expiresAt = Number(record.dynamodb?.OldImage?.expiresAt?.N);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt * 1000 <= nowMs;
}

/** An operator audit item's change that isn't its expiry: tampering. */
export function isTampering(record: DynamoDBRecord, nowMs: number): boolean {
  if (record.eventName !== "MODIFY" && record.eventName !== "REMOVE") return false;
  const pk = record.dynamodb?.Keys?.PK?.S;
  if (typeof pk !== "string" || !pk.startsWith(OPERATOR_AUDIT_PREFIX)) return false;
  return !isExpiry(record, nowMs);
}

/** A key for the log: as stored when it looks like one of ours, otherwise only that it was odd. */
function loggable(value: unknown): string {
  return typeof value === "string" && KEY.test(value) ? value : "(unexpected key)";
}

export function createOperatorAuditWatchHandler(deps: OperatorAuditWatchDeps) {
  const { obs } = deps;
  const now = deps.now ?? Date.now;
  return async (event: DynamoDBStreamEvent): Promise<{ changed: number }> => {
    const at = now();
    let changed = 0;
    for (const record of event.Records ?? []) {
      if (!isTampering(record, at)) continue;
      changed++;
      obs.logger.error("Operator audit item changed", {
        eventName: record.eventName,
        pk: loggable(record.dynamodb?.Keys?.PK?.S),
        sk: loggable(record.dynamodb?.Keys?.SK?.S),
        eventId: loggable(record.eventID),
        region: loggable(record.awsRegion),
      });
    }
    if (changed > 0) obs.count(BusinessMetric.OperatorAuditChanged, changed);
    return { changed };
  };
}
