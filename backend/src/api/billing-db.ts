// Per-team database handles for the billing function (ADR 0005, ADR 0009):
// the IAM layer of isolation for starting a checkout.
//
// Like the data function, the billing function's own role can't reach the
// table. For each request it assumes the billing-access role tagged with:
//
//   teamId          the path's team; the caller's membership is checked on
//                   this handle before anything else (authorizeTeam)      TEAM#<teamId>
//   stripeCustomer  the Stripe customer Stripe made for that team, once   STRIPE#<customer>
//                   it has; BILLING_TAG_UNUSED until then
//   userId          the caller's own `sub`, for the two-step sign-in      USER#<userId>
//                   check only (supply-checkout-8jc.14);
//                   BILLING_TAG_UNUSED otherwise
//
// and that role's policy allows reading `TEAM#<teamId>`, updating only its
// META item's `stripeCustomerId`, putting only the `STRIPE#<customer>` link,
// and reading and updating only `totpOnAt` in `USER#<userId>`
// (dynamodb:LeadingKeys and dynamodb:Attributes). So a checkout can only link
// the customer Stripe returned to the path's team, and can't touch any other
// team, any other user, or any other attribute.

import { STSClient } from "@aws-sdk/client-sts";
import { createDb, type Db, InvalidInputError } from "../data/index.js";
import { BILLING_SESSION_TAGS, BILLING_TAG_UNUSED } from "./routes.js";
import { dbCache, roleSession, type Sts } from "./team-db.js";

export interface BillingScope {
  /** The path's team. */
  readonly teamId: string;
  /** The team's Stripe customer, from Stripe, when it's being linked. */
  readonly stripeCustomer?: string;
  /** The caller's `sub`, from the verified token, to read and record when they turned two-step sign-in on. */
  readonly userId?: string;
}

export type DbForBilling = (scope: BillingScope) => Db;

export interface BillingDbOptions {
  /** The billing-access role (BILLING_ROLE_ARN). */
  readonly roleArn: string;
  /** Defaults to TABLE_NAME. */
  readonly tableName?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** How many scopes' handles to keep. */
  readonly maxScopes?: number;
  /** For tests. */
  readonly sts?: Sts;
  readonly now?: () => number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function billingScopedDbs(options: BillingDbOptions): DbForBilling {
  const env = options.env ?? process.env;
  const sts = options.sts ?? new STSClient({ region: env.AWS_REGION });
  const now = options.now ?? Date.now;
  const cached = dbCache(options.maxScopes ?? 50);

  return (scope: BillingScope) => {
    if (typeof scope.teamId !== "string" || !ID.test(scope.teamId)) throw new InvalidInputError("Invalid team ID");
    // Never the unused marker: that would let a session put STRIPE#. (and ID doesn't allow ".")
    if (scope.stripeCustomer !== undefined && (typeof scope.stripeCustomer !== "string" || scope.stripeCustomer === BILLING_TAG_UNUSED || !ID.test(scope.stripeCustomer))) {
      throw new InvalidInputError("Invalid Stripe customer ID");
    }
    // ID doesn't allow the unused marker either, so no session reaches USER#.
    if (scope.userId !== undefined && (typeof scope.userId !== "string" || !ID.test(scope.userId))) throw new InvalidInputError("Invalid user ID");
    const tags = {
      [BILLING_SESSION_TAGS.teamId]: scope.teamId,
      [BILLING_SESSION_TAGS.stripeCustomer]: scope.stripeCustomer ?? BILLING_TAG_UNUSED,
      [BILLING_SESSION_TAGS.userId]: scope.userId ?? BILLING_TAG_UNUSED,
    };
    return cached(`${tags.teamId} ${tags.stripeCustomer} ${tags.userId}`, () =>
      createDb({ tableName: options.tableName, env, credentials: roleSession(sts, now, { roleArn: options.roleArn, sessionName: `billing-${scope.teamId}`, tags }) }),
    );
  };
}
