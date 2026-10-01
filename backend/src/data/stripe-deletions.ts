// The Stripe customer deletions the team purge still owes (supply-checkout-8jc.42,
// the owner's decision on supply-checkout-8jc.19): a closed team's data is
// deleted on schedule even when Stripe can't delete its customer at that
// moment (an outage, a timeout, a rate limit, a key that can't be read). The
// purge then queues the customer's deletion here, before any of the team's
// items go, and every later run retries it until Stripe deletes the customer
// (ops/team-purge-handler.ts). The team's deletion record keeps the same
// Stripe IDs for DELETION_RECORD_RETENTION_DAYS, and a restore re-queues them
// from there (data/restore.ts), so a queue entry lost with a restore is
// queued again.
//
// One item per team in STRIPE_DELETIONS_PARTITION, sort key the team ID,
// holding only STRIPE_DELETION_ATTRIBUTES: the team, its Stripe customer and
// when it was first queued. Nothing a person typed: no names or emails.

import { DeleteCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id } from "./keys.js";
import { STRIPE_DELETIONS_PARTITION } from "./schema.js";

/** A purged team's Stripe customer, still to be deleted in Stripe. */
export interface StripeDeletion {
  readonly teamId: string;
  readonly stripeCustomerId: string;
  /** When it was first queued (ISO 8601). */
  readonly queuedAt: string;
}

const keyOf = (teamId: string) => ({ PK: STRIPE_DELETIONS_PARTITION, SK: id(teamId, "team ID") });
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** A Stripe customer ID: only these are ever queued, or sent to Stripe from the queue. */
const CUSTOMER = /^cus_[A-Za-z0-9]+$/;

/** The Stripe customer ID, checked: `cus_` and letters and digits only. Throws on anything else. */
function customerId(value: unknown): string {
  if (typeof value !== "string" || !CUSTOMER.test(id(value, "Stripe customer ID"))) throw new Error("Invalid Stripe customer ID");
  return value;
}

/**
 * Queues the deletion of a purged team's Stripe customer. Written once: a
 * team already queued keeps its first entry (and so its first time, which the
 * purge's age gauge and alarms read). Throws if it can't be written, so the
 * purge deletes nothing of the team that run.
 */
export async function queueStripeCustomerDeletion(db: Db, deletion: StripeDeletion): Promise<void> {
  if (!ISO.test(deletion.queuedAt)) throw new Error("Invalid queuedAt");
  try {
    await connection(db).doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: { ...keyOf(deletion.teamId), teamId: deletion.teamId, stripeCustomerId: customerId(deletion.stripeCustomerId), queuedAt: deletion.queuedAt },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== "ConditionalCheckFailedException") throw error;
  }
}

/**
 * Every queued deletion, the oldest first (by `queuedAt`), and how many
 * entries it couldn't read (not something this module wrote, or a customer
 * ID that isn't `cus_` and letters and digits: left for a person, never sent
 * to Stripe). Every page: the partition holds only the
 * deletions Stripe hasn't confirmed, normally none.
 */
export async function listStripeCustomerDeletions(db: Db): Promise<{ deletions: StripeDeletion[]; invalid: number }> {
  const deletions: StripeDeletion[] = [];
  let invalid = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk",
        Select: "SPECIFIC_ATTRIBUTES",
        ProjectionExpression: "PK, SK, teamId, stripeCustomerId, queuedAt",
        ExpressionAttributeValues: { ":pk": STRIPE_DELETIONS_PARTITION },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const { SK, teamId, stripeCustomerId, queuedAt } = item;
      try {
        if (SK !== teamId || typeof queuedAt !== "string" || !ISO.test(queuedAt)) throw new Error("Not a queued deletion");
        deletions.push({ teamId: id(teamId, "team ID"), stripeCustomerId: customerId(stripeCustomerId), queuedAt });
      } catch {
        invalid++;
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  // ISO timestamps compare as strings
  deletions.sort((a, b) => (a.queuedAt < b.queuedAt ? -1 : a.queuedAt > b.queuedAt ? 1 : 0));
  return { deletions, invalid };
}

/** Removes a team's queued deletion once Stripe has deleted the customer (or says it's gone). Idempotent. */
export async function removeStripeCustomerDeletion(db: Db, teamId: string): Promise<void> {
  await connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: keyOf(teamId) }));
}
