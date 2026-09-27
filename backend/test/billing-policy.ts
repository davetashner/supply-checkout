// The billing-access role's policy (infra/lib/stacks/api-stack.ts), as a check
// the in-memory table runs before each call. The infra tests check the real
// policy; this keeps the billing handler's requests inside it.

import { CUSTOMER_LINK_TEAM_ATTRIBUTES, STRIPE_LINK_ATTRIBUTES } from "../src/data/schema.js";
import type { BillingScope } from "../src/api/billing-db.js";
import { namedAttributes } from "./helpers.js";

type Input = Record<string, unknown>;

const partitionKey = (input: Input) => ((input.Item ?? input.Key) as Record<string, unknown> | undefined)?.PK;
/** What dynamodb:Attributes sees: the names the request's expressions and key use, and a put's item's names. */
const attributes = (input: Input) => [...namedAttributes(input), ...Object.keys((input.Item ?? {}) as object)];
const only = (input: Input, allowed: readonly string[]) => attributes(input).every((a) => allowed.includes(a));
const returnsNothing = (input: Input) => input.ReturnValues === undefined || input.ReturnValues === "NONE";

/** The calls the billing-access role allows for a session with these tags. */
export function billingPolicy(scope: BillingScope, denied: { command: string; input: Input }[] = []) {
  const team = `TEAM#${scope.teamId}`;
  const link = `STRIPE#${scope.stripeCustomer ?? "."}`;
  const update = (input: Input) => partitionKey(input) === team && only(input, CUSTOMER_LINK_TEAM_ATTRIBUTES) && returnsNothing(input);
  const put = (input: Input) => partitionKey(input) === link && only(input, STRIPE_LINK_ATTRIBUTES) && returnsNothing(input);
  return (command: string, input: Input): boolean => {
    const ok = (() => {
      switch (command) {
        case "GetCommand":
          return partitionKey(input) === team;
        case "TransactGetCommand":
          return (input.TransactItems as { Get: Input }[]).every((op) => partitionKey(op.Get) === team);
        case "UpdateCommand":
          return update(input);
        case "PutCommand":
          return put(input);
        case "TransactWriteCommand":
          return (input.TransactItems as Record<string, Input>[]).every((op) => (op.Put ? put(op.Put) : op.Update ? update(op.Update) : false));
        default:
          // No Query, Scan, DeleteItem or batch calls
          return false;
      }
    })();
    if (!ok) denied.push({ command, input });
    return ok;
  };
}
