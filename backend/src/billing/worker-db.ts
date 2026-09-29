// Database handles for the billing worker (ADR 0005, ADR 0009): the IAM layer
// of isolation for applying a Stripe event.
//
// The worker's own role can't reach the table. For each event it assumes the
// billing-worker role tagged with:
//
//   eventId         the event's ID (or a seat sync's,       WEBHOOK#<eventId> (its records)
//                   seats.ts)
//   stripeCustomer  the event's customer                    STRIPE#<customer> (read the link)
//   teamId          the team that customer is linked to,    TEAM#<teamId> (read billing and
//                   once the link is read; "." before         owners, update billing only)
//
// All three come from an event whose Stripe signature the webhook checked
// before it was queued (only the webhook function may send to the billing
// queue), or from a seat sync (seats.ts) on its own queue, which the account
// function or the nightly reconciliation sent with a customer taken from the
// team's own item: a seat sync can only make the worker recompute a quantity
// from the team's members and, for the nightly reconciliation's, re-apply
// Stripe's own state for that customer (entitlements.ts). The team comes from our own link, never from the
// message.

import { STSClient } from "@aws-sdk/client-sts";
import { dbCache, roleSession, type Sts } from "../api/team-db.js";
import { createDb, type Db, InvalidInputError } from "../data/index.js";

export const BILLING_WORKER_TAGS = { eventId: "eventId", stripeCustomer: "stripeCustomer", teamId: "teamId" } as const;
export const BILLING_WORKER_TAG_UNUSED = ".";

export interface WorkerScope {
  readonly eventId: string;
  readonly stripeCustomer: string;
  readonly teamId?: string;
}

export type DbForWorker = (scope: WorkerScope) => Db;

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function workerScopedDbs(options: { readonly roleArn: string; readonly tableName?: string; readonly env?: NodeJS.ProcessEnv; readonly sts?: Sts; readonly now?: () => number; readonly maxScopes?: number }): DbForWorker {
  const env = options.env ?? process.env;
  const sts = options.sts ?? new STSClient({ region: env.AWS_REGION });
  const now = options.now ?? Date.now;
  const cached = dbCache(options.maxScopes ?? 20);
  return (scope: WorkerScope) => {
    for (const [what, value] of [["event ID", scope.eventId], ["Stripe customer ID", scope.stripeCustomer]] as const) {
      if (typeof value !== "string" || !ID.test(value)) throw new InvalidInputError(`Invalid ${what}`);
    }
    if (scope.teamId !== undefined && (typeof scope.teamId !== "string" || !ID.test(scope.teamId))) throw new InvalidInputError("Invalid team ID");
    const tags = {
      [BILLING_WORKER_TAGS.eventId]: scope.eventId,
      [BILLING_WORKER_TAGS.stripeCustomer]: scope.stripeCustomer,
      [BILLING_WORKER_TAGS.teamId]: scope.teamId ?? BILLING_WORKER_TAG_UNUSED,
    };
    return cached(`${tags.eventId} ${tags.stripeCustomer} ${tags.teamId}`, () =>
      createDb({ tableName: options.tableName, env, credentials: roleSession(sts, now, { roleArn: options.roleArn, sessionName: `billing-${scope.eventId}`, tags }) }),
    );
  };
}
