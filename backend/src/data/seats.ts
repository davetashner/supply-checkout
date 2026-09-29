// Who a team is billed for (supply-checkout-l50, ADR 0009): the subscription's
// seat quantity is the number of billed members, which the billing worker
// keeps in sync with Stripe (billing/seats.ts).
//
// The rule lives here, and only here: BILLED_ROLES. Owner decision
// 2026-09-28: owners and editors (`contributor`) are billed seats; viewers
// are free. When the tiers change (supply-checkout-akz), change the list.

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, prefixes, teamPartition } from "./keys.js";
import { hasEnded, type MemberRole } from "./model.js";
import { GSI3, GSI3PK, OPS_TEAMS_PARTITION, SEAT_RECONCILE_ATTRIBUTES } from "./schema.js";
import { type TeamContext, readable } from "./team-context.js";

/** The roles that take a paid seat. Every other role is free. */
export const BILLED_ROLES: readonly MemberRole[] = ["owner", "contributor"];

/** Whether a member with this role takes a paid seat. */
export function isBilledRole(role: unknown): boolean {
  return (BILLED_ROLES as readonly unknown[]).includes(role);
}

/**
 * The team's members who take a paid seat, counted from its MEMBER items as
 * they are now (strongly consistent), reading only their keys and role. Not a
 * stored count: the quantity sent to Stripe is always computed from the
 * membership itself, so changes that race converge on the same answer.
 */
export async function countBilledMembers(db: Db, ctx: TeamContext): Promise<number> {
  readable(ctx);
  let count = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ProjectionExpression: "SK, #role",
        ExpressionAttributeNames: { "#role": "role" },
        ExpressionAttributeValues: { ":pk": teamPartition(ctx.teamId), ":prefix": prefixes.member },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) if (isBilledRole(item.role)) count++;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

/** A team the nightly seat reconciliation asks the billing worker to check. */
export interface TeamToReconcile {
  readonly teamId: string;
  readonly stripeCustomerId: string;
}

/**
 * Every team that may have a Stripe subscription to reconcile: open (not
 * closed), with a Stripe customer, and a status that hasn't ended. Read from
 * the operators' index (GSI3's OPS#TEAMS partition), naming only
 * SEAT_RECONCILE_ATTRIBUTES, so the reconciliation reads no team's data,
 * names or emails. The worker checks the rest (a subscription, its state).
 */
export async function listTeamsToReconcile(db: Db): Promise<TeamToReconcile[]> {
  const out: TeamToReconcile[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI3,
        KeyConditionExpression: `#a${SEAT_RECONCILE_ATTRIBUTES.indexOf(GSI3PK)} = :pk`,
        // The IAM policy requires it (dynamodb:Select); DynamoDB doesn't infer it from the projection
        Select: "SPECIFIC_ATTRIBUTES",
        ExpressionAttributeValues: { ":pk": OPS_TEAMS_PARTITION },
        // Placeholders for every name: `status` is a reserved word
        ProjectionExpression: SEAT_RECONCILE_ATTRIBUTES.map((_, i) => `#a${i}`).join(", "),
        ExpressionAttributeNames: Object.fromEntries(SEAT_RECONCILE_ATTRIBUTES.map((name, i) => [`#a${i}`, name])),
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (typeof item.stripeCustomerId !== "string" || item.closedAt !== undefined || hasEnded(item.status)) continue;
      const teamId = String(item.PK).slice("TEAM#".length);
      out.push({ teamId: id(teamId, "team ID"), stripeCustomerId: id(item.stripeCustomerId, "Stripe customer ID") });
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}
