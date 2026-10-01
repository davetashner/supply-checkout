// The billing-access role's policy (infra/lib/stacks/api-stack.ts), as a check
// the in-memory table runs before each call. The infra tests check the real
// policy; this keeps the billing handler's and worker's requests inside them.

import { BILLING_READ_ATTRIBUTES, BILLING_UPDATE_ATTRIBUTES, CUSTOMER_LINK_TEAM_ATTRIBUTES, MEMBER_SEAT_ATTRIBUTES, STRIPE_LINK_ATTRIBUTES, STRIPE_LINK_READ_ATTRIBUTES, TOTP_RECORD_ATTRIBUTES, WEBHOOK_RECORD_ATTRIBUTES } from "../src/data/schema.js";
import type { BillingScope } from "../src/api/billing-db.js";
import { namedAttributes } from "./helpers.js";

type Input = Record<string, unknown>;

const partitionKey = (input: Input) => ((input.Item ?? input.Key) as Record<string, unknown> | undefined)?.PK;
/** What dynamodb:Attributes sees: the names the request's expressions and key use, and a put's item's names. */
const attributes = (input: Input) => [...namedAttributes(input), ...Object.keys((input.Item ?? {}) as object)];
const only = (input: Input, allowed: readonly string[]) => attributes(input).every((a) => allowed.includes(a));
const returnsNothing = (input: Input) => input.ReturnValues === undefined || input.ReturnValues === "NONE";
const queryPartition = (input: Input) => (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"];

/** The calls the billing-access role allows for a session with these tags. */
export function billingPolicy(scope: BillingScope, denied: { command: string; input: Input }[] = []) {
  const team = `TEAM#${scope.teamId}`;
  const link = `STRIPE#${scope.stripeCustomer ?? "."}`;
  const update = (input: Input) => partitionKey(input) === team && only(input, CUSTOMER_LINK_TEAM_ATTRIBUTES) && returnsNothing(input);
  const put = (input: Input) => partitionKey(input) === link && only(input, STRIPE_LINK_ATTRIBUTES) && returnsNothing(input);
  // The caller's own two-step sign-in record (supply-checkout-8jc.14): totpOnAt only, projected reads, nothing returned
  const user = `USER#${scope.userId ?? "."}`;
  const projected = (input: Input) => typeof input.ProjectionExpression === "string" && (input.Select === undefined || input.Select === "SPECIFIC_ATTRIBUTES");
  const totpRecord = (input: Input) => partitionKey(input) === user && only(input, TOTP_RECORD_ATTRIBUTES);
  return (command: string, input: Input): boolean => {
    const ok = (() => {
      switch (command) {
        case "GetCommand":
          return partitionKey(input) === team || (totpRecord(input) && projected(input));
        case "TransactGetCommand":
          return (input.TransactItems as { Get: Input }[]).every((op) => partitionKey(op.Get) === team);
        case "UpdateCommand":
          return update(input) || (totpRecord(input) && returnsNothing(input));
        case "PutCommand":
          return put(input);
        case "TransactWriteCommand":
          return (input.TransactItems as Record<string, Input>[]).every((op) => (op.Put ? put(op.Put) : op.Update ? update(op.Update) : false));
        case "QueryCommand":
          // Counting the team's billed members for Checkout's seat quantity: keys and role only, on the table
          return input.IndexName === undefined && queryPartition(input) === team && input.Select === "SPECIFIC_ATTRIBUTES" && only(input, MEMBER_SEAT_ATTRIBUTES);
        default:
          // No Scan, DeleteItem or batch calls
          return false;
      }
    })();
    if (!ok) denied.push({ command, input });
    return ok;
  };
}

/**
 * The calls the billing-worker role allows for a session with these tags
 * (infra/lib/stacks/api-stack.ts): its event's records, its customer's link
 * (the team only), and in its team's partition reads of BILLING_READ_ATTRIBUTES
 * and updates of BILLING_UPDATE_ATTRIBUTES only.
 */
export function workerPolicy(scope: { eventId: string; stripeCustomer: string; teamId?: string }, denied: { command: string; input: Input }[] = []) {
  const records = `WEBHOOK#${scope.eventId}`;
  const link = `STRIPE#${scope.stripeCustomer}`;
  const team = `TEAM#${scope.teamId ?? "."}`;
  const projected = (input: Input) => typeof input.ProjectionExpression === "string" && (input.Select === undefined || input.Select === "SPECIFIC_ATTRIBUTES");
  return (command: string, input: Input): boolean => {
    const ok = (() => {
      switch (command) {
        case "GetCommand": {
          const pk = partitionKey(input);
          if (pk === records) return only(input, WEBHOOK_RECORD_ATTRIBUTES) && projected(input);
          if (pk === link) return only(input, STRIPE_LINK_READ_ATTRIBUTES) && projected(input);
          return pk === team && only(input, BILLING_READ_ATTRIBUTES) && projected(input);
        }
        case "QueryCommand":
          return input.IndexName === undefined && queryPartition(input) === team && only(input, BILLING_READ_ATTRIBUTES) && projected(input);
        case "PutCommand":
          return partitionKey(input) === records && only(input, WEBHOOK_RECORD_ATTRIBUTES) && returnsNothing(input);
        case "UpdateCommand":
          return partitionKey(input) === team && only(input, BILLING_UPDATE_ATTRIBUTES) && returnsNothing(input);
        default:
          return false;
      }
    })();
    if (!ok) denied.push({ command, input });
    return ok;
  };
}
