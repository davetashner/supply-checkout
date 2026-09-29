// Stripe links, webhook idempotency and applying a subscription to its team
// (ADR 0005, ADR 0009). The link and the event records live outside any team
// partition: webhooks arrive with a Stripe customer ID, not a signed-in user.
// teamContextForStripeCustomer issues a context, so it lives in
// team-context.ts.

import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, ForbiddenError, conflictOnConditionFailure } from "./errors.js";
import { id, keys, prefixes, teamPartition } from "./keys.js";
import { isReadOnlyForBilling } from "./model.js";
import { type TeamContext, readable, writable } from "./team-context.js";

/** How long an event's records are kept: longer than Stripe retries an event (3 days) or a DLQ holds it. */
const WEBHOOK_RECORD_DAYS = 30;

/** Links a Stripe customer to the team, once. Owners do this at checkout. */
export async function linkStripeCustomer(db: Db, ctx: TeamContext, customerId: string): Promise<void> {
  // Also while the subscription has ended: that's when an owner subscribes again
  writable(db, ctx, "owner", { whileEnded: true });
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
              // Not once the team is closed, even if it closed after the caller's context was issued
              ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(closedAt) AND (attribute_not_exists(stripeCustomerId) OR stripeCustomerId = :customer)",
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

/**
 * The team a Stripe customer is linked to (linkStripeCustomer), or undefined.
 * Reads only the link's team. The billing worker calls it to learn which team
 * to scope its session to, then teamContextForStripeCustomer on that session.
 */
export async function stripeCustomerTeam(db: Db, customerId: string): Promise<string | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.stripe(customerId), ConsistentRead: true, ProjectionExpression: "teamId" }));
  return typeof Item?.teamId === "string" ? id(Item.teamId, "team ID") : undefined;
}

/** True if the billing worker already applied this event (markWebhookProcessed). */
export async function isWebhookProcessed(db: Db, eventId: string): Promise<boolean> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.webhook(eventId), ConsistentRead: true, ProjectionExpression: "eventId" }));
  return Item !== undefined;
}

/**
 * Claims the right to email one owner about one Stripe event: true the first
 * time, false after, so a retried event never emails an owner twice. Claimed
 * before the email goes, so a failure after the claim means no email rather
 * than two (the worker counts it). Kept as long as the event's record.
 */
export async function claimBillingNotice(db: Db, eventId: string, userId: string, now = new Date()): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new PutCommand({
        TableName: db.tableName,
        Item: { ...keys.webhookNotice(eventId, userId), type: "billingNotice", eventId, sentAt: now.toISOString(), expiresAt: Math.floor(now.getTime() / 1000) + WEBHOOK_RECORD_DAYS * 24 * 60 * 60 },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** What the billing worker reads of a team: its META item's billing, closure and comp, nothing else. */
export interface BillingTeam {
  readonly teamId: string;
  readonly name: string;
  readonly status: string;
  readonly plan: string;
  readonly seats: number;
  /** Closed by an owner (closeTeam): webhooks change nothing. */
  readonly closed: boolean;
  /** When it closed, while it's closed: the closure its subscription is ended for (billing/closing.ts). */
  readonly closedAt?: string;
  /** The purge has started deleting it: webhooks change nothing. */
  readonly purging: boolean;
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
  /** Read-only because its subscription ended and no comp keeps it going (isReadOnlyForBilling). */
  readonly readOnly: boolean;
}

/** The team's billing state, or undefined if its META item is gone (purged). */
export async function getBillingTeam(db: Db, ctx: TeamContext, now = new Date()): Promise<BillingTeam | undefined> {
  readable(ctx);
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.team(ctx.teamId),
      ConsistentRead: true,
      ProjectionExpression: "#name, #status, #plan, seats, closedAt, purging, stripeCustomerId, stripeSubscriptionId, compPlan, compUntil",
      ExpressionAttributeNames: { "#name": "name", "#status": "status", "#plan": "plan" },
    }),
  );
  if (!Item) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    teamId: ctx.teamId,
    name: str(Item.name) ?? "",
    status: str(Item.status) ?? "",
    plan: str(Item.plan) ?? "",
    seats: typeof Item.seats === "number" ? Item.seats : 0,
    closed: typeof Item.closedAt === "string",
    ...(str(Item.closedAt) ? { closedAt: Item.closedAt as string } : {}),
    purging: Item.purging !== undefined,
    ...(str(Item.stripeCustomerId) ? { stripeCustomerId: Item.stripeCustomerId as string } : {}),
    ...(str(Item.stripeSubscriptionId) ? { stripeSubscriptionId: Item.stripeSubscriptionId as string } : {}),
    readOnly: isReadOnlyForBilling(Item, now),
  };
}

/** The team's owners and the addresses on their MEMBER items, for billing notices. Reads only their role, email and ID. */
export async function listOwnerContacts(db: Db, ctx: TeamContext): Promise<{ readonly userId: string; readonly email?: string }[]> {
  readable(ctx);
  const out: { userId: string; email?: string }[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
        ProjectionExpression: "userId, #role, email",
        ExpressionAttributeNames: { "#role": "role" },
        ExpressionAttributeValues: { ":pk": teamPartition(ctx.teamId), ":prefix": prefixes.member },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (item.role === "owner" && typeof item.userId === "string") out.push({ userId: item.userId, ...(typeof item.email === "string" ? { email: item.email } : {}) });
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** The billing fields of a team as they were read (getBillingTeam), for applySubscription's `asRead`. */
export interface BillingAsRead {
  readonly status: string;
  readonly plan: string;
  readonly seats: number;
  readonly subscriptionId?: string;
}

/** A subscription as the billing worker applies it to its team (ADR 0009). */
export interface SubscriptionState {
  readonly customerId: string;
  readonly subscriptionId: string;
  /** The subscription this one replaces (the team's, which ended), when it's a new one. */
  readonly replaces?: string;
  /** Our plan, from the price's lookup key; absent for a price we don't sell, which leaves the plan as it is. */
  readonly plan?: string;
  readonly interval?: string;
  readonly seats: number;
  /** Stripe's status: trialing, active, past_due, canceled, unpaid, incomplete, incomplete_expired, paused. */
  readonly status: string;
  readonly currentPeriodEnd?: string;
  readonly cancelAtPeriodEnd: boolean;
}

/**
 * Applies a subscription's latest state to its team's META item: plan, seats,
 * status, interval and period end. Only the billing worker (a system context)
 * may. Conditioned on the item existing, so a purged team is never recreated;
 * on the team not being closed or marked for the purge, so a closed team
 * changes no more; on the customer being the team's; and on the subscription
 * being the team's (or none yet, or the one it replaces). Applying the same
 * state twice changes nothing but `stripeSyncedAt` and the version.
 *
 * With `asRead` (the nightly entitlement check, billing/entitlements.ts),
 * also conditioned on the team's status, plan, seats and subscription being
 * as they were read, so a Stripe event applied meanwhile is almost never
 * overwritten with the older state the check fetched. It compares values,
 * not a version: a change and back (A to B to A) between the read and the
 * write, or a change only to `cancelAtPeriodEnd` or `currentPeriodEnd`, isn't
 * seen, and the next event or night corrects it.
 *
 * Returns "applied", or "ignored" when the team is gone, closed, being purged
 * or belongs to another customer by the time of the write. Any other failed
 * condition (the team took another subscription, or changed, meanwhile) is a
 * ConflictError, so the event is retried and sees the new state.
 */
export async function applySubscription(db: Db, ctx: TeamContext, state: SubscriptionState, now = new Date(), asRead?: BillingAsRead): Promise<"applied" | "ignored"> {
  writable(db, ctx, "system");
  if (ctx.role !== "system") throw new ForbiddenError("Only billing applies a subscription");
  id(state.customerId, "Stripe customer ID");
  id(state.subscriptionId, "Stripe subscription ID");
  if (state.replaces !== undefined) id(state.replaces, "Stripe subscription ID");
  if (!Number.isInteger(state.seats) || state.seats < 0) throw new ConflictError("A subscription's seats must be a whole number");
  const sets = ["#status = :status", "seats = :seats", "stripeSubscriptionId = :sub", "cancelAtPeriodEnd = :cape", "stripeSyncedAt = :at", "#version = #version + :one"];
  const values: Record<string, unknown> = {
    ":status": state.status,
    ":seats": state.seats,
    ":sub": state.subscriptionId,
    ":cape": state.cancelAtPeriodEnd,
    ":at": now.toISOString(),
    ":one": 1,
    ":customer": state.customerId,
  };
  if (state.plan !== undefined) {
    sets.push("#plan = :plan");
    values[":plan"] = state.plan;
  }
  if (state.interval !== undefined) {
    sets.push("billingInterval = :interval");
    values[":interval"] = state.interval;
  }
  if (state.currentPeriodEnd !== undefined) {
    sets.push("currentPeriodEnd = :end");
    values[":end"] = state.currentPeriodEnd;
  }
  const unchanged: string[] = [];
  if (asRead) {
    // Every team is created with a status, plan and seats (createTeam); an absent one reads as "" or 0
    const same = (path: string, key: string, value: string | number, absent: string | number) => {
      values[key] = value;
      unchanged.push(value === absent ? `(${path} = ${key} OR attribute_not_exists(${path}))` : `${path} = ${key}`);
    };
    same("#status", ":readStatus", asRead.status, "");
    same("#plan", ":readPlan", asRead.plan, "");
    same("seats", ":readSeats", asRead.seats, 0);
    if (asRead.subscriptionId === undefined) unchanged.push("attribute_not_exists(stripeSubscriptionId)");
    else same("stripeSubscriptionId", ":readSub", id(asRead.subscriptionId, "Stripe subscription ID"), "");
  }
  const subscription = state.replaces !== undefined ? "(attribute_not_exists(stripeSubscriptionId) OR stripeSubscriptionId = :sub OR stripeSubscriptionId = :replaces)" : "(attribute_not_exists(stripeSubscriptionId) OR stripeSubscriptionId = :sub)";
  if (state.replaces !== undefined) values[":replaces"] = state.replaces;
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.team(ctx.teamId),
        UpdateExpression: `SET ${sets.join(", ")}`,
        // Never recreates a purged team, never touches a closed or purging one
        ConditionExpression: [`attribute_exists(PK) AND stripeCustomerId = :customer AND attribute_not_exists(closedAt) AND attribute_not_exists(purging) AND ${subscription}`, ...unchanged].join(" AND "),
        ExpressionAttributeNames: { "#status": "status", "#version": "version", ...(state.plan !== undefined || asRead ? { "#plan": "plan" } : {}) },
        ExpressionAttributeValues: values,
      }),
    );
    return "applied";
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
    const team = await getBillingTeam(db, ctx, now);
    if (!team || team.closed || team.purging || team.stripeCustomerId !== state.customerId) return "ignored";
    throw new ConflictError("The team's subscription changed meanwhile");
  }
}
