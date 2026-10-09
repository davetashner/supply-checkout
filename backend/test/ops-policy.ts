// The operator-access role's policy (infra/lib/stacks/api-stack.ts, ADR
// 0015), as a check the in-memory table runs before each call. The infra
// tests check the real policy; this keeps the ops handler's requests inside it.

import {
  COMMITTING_IMPORTS_PARTITION,
  COMP_ATTRIBUTES,
  GSI1,
  GSI3,
  IMPORT_INDEX_ATTRIBUTES,
  LAPSE_CLOSE_ATTRIBUTES,
  LAPSE_LIST_ATTRIBUTES,
  LAPSE_OWNER_ATTRIBUTES,
  LAPSE_PREFIX,
  LAPSE_READ_ATTRIBUTES,
  LAPSE_RECORD_ATTRIBUTES,
  OPERATOR_AUDIT_PREFIX,
  OPS_AUDIT_INDEX_PREFIX,
  OPS_OWNERS_PREFIX,
  OPS_TEAMS_PARTITION,
  RECEIPT_USAGE_ATTRIBUTES,
  REOPEN_ATTRIBUTES,
  STUCK_IMPORT_ATTRIBUTES,
  TEST_MARK_ATTRIBUTES,
} from "../src/data/schema.js";
import { namedAttributes } from "./helpers.js";

type Input = Record<string, unknown>;

const indexPartition = (pk: unknown) => typeof pk === "string" && (pk === OPS_TEAMS_PARTITION || pk.startsWith(OPS_OWNERS_PREFIX) || pk.startsWith(OPS_AUDIT_INDEX_PREFIX));
const auditPartition = (pk: unknown) => typeof pk === "string" && pk.startsWith(OPERATOR_AUDIT_PREFIX);
const partitionKey = (input: Input) => ((input.Item ?? input.Key) as Record<string, unknown> | undefined)?.PK;

function update(input: Input, team: string): boolean {
  if (partitionKey(input) !== `TEAM#${team}`) return false;
  if (input.ReturnValues !== undefined && !["NONE", "UPDATED_OLD", "UPDATED_NEW"].includes(input.ReturnValues as string)) return false;
  // Either statement: the comp attributes, or a stuck import's GSI1 keys
  const named = [...namedAttributes(input)];
  return [COMP_ATTRIBUTES, IMPORT_INDEX_ATTRIBUTES].some((allowed) => named.every((a) => (allowed as readonly string[]).includes(a)));
}

/** The calls the operator-access role allows, for a session tagged with `team` ("." for none). */
export function opsPolicy(team: string, denied: { command: string; input: Input }[] = []) {
  return (command: string, input: Input): boolean => {
    const ok = (() => {
      switch (command) {
        case "QueryCommand": {
          const pk = (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"];
          if (input.IndexName === GSI3) return indexPartition(pk) && ["ALL_PROJECTED_ATTRIBUTES", "SPECIFIC_ATTRIBUTES"].includes(input.Select as string);
          if (input.IndexName === GSI1) {
            return pk === COMMITTING_IMPORTS_PARTITION && input.Select === "SPECIFIC_ATTRIBUTES" && [...namedAttributes(input)].every((a) => (STUCK_IMPORT_ATTRIBUTES as readonly string[]).includes(a));
          }
          return input.IndexName === undefined && auditPartition(pk);
        }
        case "PutCommand":
          return auditPartition(partitionKey(input));
        case "UpdateCommand":
          return update(input, team);
        case "TransactWriteCommand":
          return (input.TransactItems as Record<string, Input>[]).every((op) =>
            op.Put ? auditPartition(partitionKey(op.Put)) : op.Update ? update(op.Update, team) : false,
          );
        case "BatchGetCommand":
          // Teams' receipt counters (supply-checkout-wxx) or test marks (supply-checkout-o60.2): by key in
          // any TEAM# partition, projecting only the keys and `receipts`, or the keys and `test`
          // (each its own statement: dynamodb:Attributes and Select SPECIFIC_ATTRIBUTES)
          return Object.values(input.RequestItems as Record<string, Input>).every(
            (request) =>
              typeof request.ProjectionExpression === "string" &&
              (request.Keys as Input[]).every((k) => typeof k.PK === "string" && k.PK.startsWith("TEAM#")) &&
              [RECEIPT_USAGE_ATTRIBUTES, TEST_MARK_ATTRIBUTES].some((allowed) => [...namedAttributes(request)].every((a) => (allowed as readonly string[]).includes(a))),
          );
        default:
          // No GetItem, Scan, DeleteItem, or batch calls but the receipt counters' reads
          return false;
      }
    })();
    if (!ok) denied.push({ command, input });
    return ok;
  };
}

/**
 * The calls the operator-reopen role allows for a session tagged with `team`
 * (infra/lib/stacks/api-stack.ts, supply-checkout-6uw.6): GetItem and
 * UpdateItem in that team's partition naming only REOPEN_ATTRIBUTES
 * (UpdateItem returning nothing), and PutItem and Query in its OPAUDIT#
 * partition.
 */
export function reopenPolicy(team: string, denied: { command: string; input: Input }[] = []) {
  const teamItem = (input: Input) => partitionKey(input) === `TEAM#${team}` && [...namedAttributes(input)].every((a) => (REOPEN_ATTRIBUTES as readonly string[]).includes(a));
  const update = (input: Input) => teamItem(input) && (input.ReturnValues === undefined || input.ReturnValues === "NONE");
  const audit = (pk: unknown) => pk === `${OPERATOR_AUDIT_PREFIX}${team}`;
  return (command: string, input: Input): boolean => {
    const ok = (() => {
      switch (command) {
        case "GetCommand":
          // dynamodb:Select SPECIFIC_ATTRIBUTES: only a projected read passes
          return teamItem(input) && typeof input.ProjectionExpression === "string" && (input.Select === undefined || input.Select === "SPECIFIC_ATTRIBUTES");
        case "QueryCommand":
          return input.IndexName === undefined && audit((input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"]);
        case "PutCommand":
          return audit(partitionKey(input));
        case "UpdateCommand":
          return update(input);
        case "TransactWriteCommand":
          return (input.TransactItems as Record<string, Input>[]).every((op) => (op.Put ? audit(partitionKey(op.Put)) : op.Update ? update(op.Update) : false));
        default:
          return false;
      }
    })();
    if (!ok) denied.push({ command, input });
    return ok;
  };
}

/**
 * The calls the lapsed-team job's role allows (infra/lib/observability/ops-checks.ts,
 * supply-checkout-qdx): Query on GSI3's OPS#TEAMS partition naming only
 * LAPSE_LIST_ATTRIBUTES and its OPS#OWNERS# partitions naming only
 * LAPSE_OWNER_ATTRIBUTES (Select SPECIFIC_ATTRIBUTES); GetItem on a team's
 * META item naming only LAPSE_READ_ATTRIBUTES; UpdateItem there naming only
 * LAPSE_CLOSE_ATTRIBUTES, returning nothing; GetItem and PutItem in `LAPSE#`
 * partitions naming only LAPSE_RECORD_ATTRIBUTES. Every GetItem projected
 * (Select SPECIFIC_ATTRIBUTES). Nothing else.
 */
export function lapsePolicy(denied: { command: string; input: Input }[] = []) {
  const within = (names: Iterable<string>, allowed: readonly string[]) => [...names].every((a) => allowed.includes(a));
  const teamMeta = (input: Input) => {
    const key = input.Key as Record<string, unknown> | undefined;
    return typeof key?.PK === "string" && key.PK.startsWith("TEAM#") && key.SK === "META";
  };
  const lapse = (pk: unknown) => typeof pk === "string" && pk.startsWith(LAPSE_PREFIX);
  return (command: string, input: Input): boolean => {
    const ok = (() => {
      switch (command) {
        case "QueryCommand": {
          const pk = (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"];
          if (input.IndexName !== GSI3 || input.Select !== "SPECIFIC_ATTRIBUTES") return false;
          if (pk === OPS_TEAMS_PARTITION) return within(namedAttributes(input), LAPSE_LIST_ATTRIBUTES);
          return typeof pk === "string" && pk.startsWith(OPS_OWNERS_PREFIX) && within(namedAttributes(input), LAPSE_OWNER_ATTRIBUTES);
        }
        case "GetCommand":
          // dynamodb:Select SPECIFIC_ATTRIBUTES on both GetItem statements (ReadTeamBilling, ReadLapseRecords): projected only
          if (typeof input.ProjectionExpression !== "string" || (input.Select !== undefined && input.Select !== "SPECIFIC_ATTRIBUTES")) return false;
          if (teamMeta(input)) return within(namedAttributes(input), LAPSE_READ_ATTRIBUTES);
          return lapse(partitionKey(input)) && within(namedAttributes(input), LAPSE_RECORD_ATTRIBUTES);
        case "PutCommand":
          return lapse(partitionKey(input)) && within(Object.keys(input.Item as object), LAPSE_RECORD_ATTRIBUTES) && within(namedAttributes(input), LAPSE_RECORD_ATTRIBUTES);
        case "UpdateCommand":
          return teamMeta(input) && within(namedAttributes(input), LAPSE_CLOSE_ATTRIBUTES) && (input.ReturnValues === undefined || input.ReturnValues === "NONE");
        default:
          return false;
      }
    })();
    if (!ok) denied.push({ command, input });
    return ok;
  };
}
