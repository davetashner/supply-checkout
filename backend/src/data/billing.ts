// Stripe links and webhook idempotency (ADR 0005, ADR 0009). These items live
// outside any team partition: webhooks arrive with a Stripe customer ID, not a
// signed-in user. teamContextForStripeCustomer issues a context, so it lives
// in team-context.ts.

import { PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { conflictOnConditionFailure } from "./errors.js";
import { keys } from "./keys.js";
import { type TeamContext, writable } from "./team-context.js";

/** Links a Stripe customer to the team, once. Owners do this at checkout. */
export async function linkStripeCustomer(db: Db, ctx: TeamContext, customerId: string): Promise<void> {
  writable(db, ctx, "owner");
  await connection(db)
    .doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: db.tableName,
              Item: { ...keys.stripe(customerId), type: "stripeLink", customerId, teamId: ctx.teamId },
              // Idempotent for the same team; a customer can never move to another team
              ConditionExpression: "attribute_not_exists(PK) OR teamId = :team",
              ExpressionAttributeValues: { ":team": ctx.teamId },
            },
          },
          {
            Update: {
              TableName: db.tableName,
              Key: keys.team(ctx.teamId),
              UpdateExpression: "SET stripeCustomerId = :customer",
              ConditionExpression: "attribute_exists(PK) AND (attribute_not_exists(stripeCustomerId) OR stripeCustomerId = :customer)",
              ExpressionAttributeValues: { ":customer": customerId },
            },
          },
        ],
      }),
    )
    .catch(conflictOnConditionFailure("This team or customer is already linked"));
}

/**
 * Records a webhook event as processed. Returns false if it already was, so
 * Stripe's retries are handled once. The record expires after 30 days.
 */
export async function markWebhookProcessed(db: Db, eventId: string, now = new Date()): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: {
          ...keys.webhook(eventId),
          type: "webhook",
          eventId,
          processedAt: now.toISOString(),
          expiresAt: Math.floor(now.getTime() / 1000) + 30 * 24 * 60 * 60,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}
