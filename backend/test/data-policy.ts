// The data-access role's deny on a team's billing, comp and closure
// attributes (NoTeamBillingWrites in infra/lib/stacks/api-stack.ts,
// supply-checkout-3sv.25), as a check the in-memory table runs before each
// call. The infra tests check the real policy; this keeps the data routes'
// writes outside it. LeadingKeys is MemoryTable's own partition check.

import { DATA_ROLE_DENIED_ATTRIBUTES } from "../src/data/schema.js";
import { namedAttributes } from "./helpers.js";

type Input = Record<string, unknown>;

const DENIED = new Set<string>(DATA_ROLE_DENIED_ATTRIBUTES);

/** What dynamodb:Attributes sees: the names the request's expressions and key use, and a put's item's names. */
const attributes = (input: Input) => [...namedAttributes(input), ...Object.keys((input.Item ?? {}) as object)];
const allowedWrite = (input: Input) => !attributes(input).some((a) => DENIED.has(a));

/** The calls the deny lets through: PutItem, UpdateItem and DeleteItem (alone or in a transaction) naming none of DATA_ROLE_DENIED_ATTRIBUTES. */
export function dataPolicy(denied: { command: string; input: Input }[] = []) {
  return (command: string, input: Input): boolean => {
    const ok = (() => {
      switch (command) {
        case "PutCommand":
        case "UpdateCommand":
        case "DeleteCommand":
          return allowedWrite(input);
        case "TransactWriteCommand":
          // A ConditionCheck only reads, so it may name them
          return (input.TransactItems as Record<string, Input>[]).every((op) => [op.Put, op.Update, op.Delete].every((write) => write === undefined || allowedWrite(write)));
        default:
          return true;
      }
    })();
    if (!ok) denied.push({ command, input });
    return ok;
  };
}
