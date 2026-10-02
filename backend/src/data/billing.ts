// Stripe links, webhook idempotency and applying a subscription to its team
// (ADR 0005, ADR 0009). The link and the event records live outside any team
// partition: webhooks arrive with a Stripe customer ID, not a signed-in user.
// teamContextForStripeCustomer issues a context, so it lives in
// team-context.ts.

import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, ForbiddenError, conflictOnConditionFailure } from "./errors.js";
import { id, keys, prefixes, teamPartition } from "./keys.js";
import { billingAccess, hasStopped, type ReadOnlyReason } from "./model.js";
import { type TeamContext, readable, writable } from "./team-context.js";

/** How long an event's records are kept: longer than Stripe retries an event (3 days) or a DLQ holds it. */
const WEBHOOK_RECORD_DAYS = 30;

/**
 * Links a Stripe customer to the team, once; owners do this at every checkout
 * (again, for the same customer, after the first). It moves the team's
 * version and records when (`stripeCheckoutAt`): the lapsed-team job doesn't
 * close a team within a Checkout Session's lifetime of it (closeLapsedTeam).
 */
export async function linkStripeCustomer(db: Db, ctx: TeamContext, customerId: string, now = new Date()): Promise<void> {
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
              // The version moves, so a writer conditioned on the version it read (the lapsed-team job's closure) sees the link
              UpdateExpression: "SET stripeCustomerId = :customer, stripeCheckoutAt = :now, #version = if_not_exists(#version, :zero) + :one",
              // Not once the team is closed, even if it closed after the caller's context was issued
              ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(closedAt) AND (attribute_not_exists(stripeCustomerId) OR stripeCustomerId = :customer)",
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: { ":customer": customerId, ":now": now.toISOString(), ":zero": 0, ":one": 1 },
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
  /** Read-only for billing, and no comp keeps it going (billingAccess). */
  readonly readOnly: boolean;
  /** Why it's read-only, when it is. */
  readonly readOnlyReason?: ReadOnlyReason;
  /** When it's closed and deleted unless it subscribes (billingAccess), when it's read-only for that. */
  readonly deleteAfter?: string;
  /** When its subscription went `past_due`, while it is (applySubscription). */
  readonly pastDueSince?: string;
  /** When its subscription ended, while it has (applySubscription). */
  readonly subscriptionEndedAt?: string;
  /** Whether its subscription won't renew, as last applied (`cancelAtPeriodEnd`). */
  readonly cancelAtPeriodEnd: boolean;
  /** Reopened from this closure (its `closedAt`), and its subscription not yet resynced from Stripe (billing/reopening.ts). */
  readonly resyncFor?: string;
  /** When it was last reopened (`stripeReopenedAt`). */
  readonly reopenedAt?: string;
  /** The closure the purge recorded ending its subscription for (`stripeCancelledFor`). */
  readonly cancelledFor?: string;
}

/** The team's billing state, or undefined if its META item is gone (purged). */
export async function getBillingTeam(db: Db, ctx: TeamContext, now = new Date()): Promise<BillingTeam | undefined> {
  readable(ctx);
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.team(ctx.teamId),
      ConsistentRead: true,
      ProjectionExpression:
        "#name, #status, #plan, seats, closedAt, purging, stripeCustomerId, stripeSubscriptionId, compPlan, compUntil, cancelAtPeriodEnd, stripeResyncFor, stripeReopenedAt, stripeCancelledFor, trialEndsAt, createdAt, pastDueSince, subscriptionEndedAt",
      ExpressionAttributeNames: { "#name": "name", "#status": "status", "#plan": "plan" },
    }),
  );
  if (!Item) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const access = billingAccess(Item, now);
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
    readOnly: access.readOnly,
    ...(access.reason ? { readOnlyReason: access.reason } : {}),
    ...(access.deleteAfter ? { deleteAfter: access.deleteAfter } : {}),
    ...(str(Item.pastDueSince) ? { pastDueSince: Item.pastDueSince as string } : {}),
    ...(str(Item.subscriptionEndedAt) ? { subscriptionEndedAt: Item.subscriptionEndedAt as string } : {}),
    cancelAtPeriodEnd: Item.cancelAtPeriodEnd === true,
    ...(str(Item.stripeResyncFor) ? { resyncFor: Item.stripeResyncFor as string } : {}),
    ...(str(Item.stripeReopenedAt) ? { reopenedAt: Item.stripeReopenedAt as string } : {}),
    ...(str(Item.stripeCancelledFor) ? { cancelledFor: Item.stripeCancelledFor as string } : {}),
  };
}

/**
 * Records that a reopened team's subscription was resynced from Stripe
 * (billing/reopening.ts): removes `stripeResyncFor`, on the condition it's
 * still the closure the resync read (`closedAt`). Returns false if it isn't
 * (another reopen since, which its own resync handles, or already removed).
 * Only the billing worker (a system context) may.
 */
export async function finishReopenResync(db: Db, ctx: TeamContext, closedAt: string): Promise<boolean> {
  readable(ctx);
  if (ctx.role !== "system") throw new ForbiddenError("Only billing resyncs a reopened team");
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.team(ctx.teamId),
        UpdateExpression: "REMOVE stripeResyncFor",
        ConditionExpression: "stripeResyncFor = :at",
        ExpressionAttributeValues: { ":at": closedAt },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
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
  /** Whether it won't renew, as read: compared too when given (the nightly entitlement check). */
  readonly cancelAtPeriodEnd?: boolean;
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
  /** When it ended (Stripe's `ended_at`), if it has and Stripe says. */
  readonly endedAt?: string;
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
 * It also keeps the dates the access rules count from (billingAccess):
 * `pastDueSince`, set the first time the status is `past_due` and kept while
 * it stays so, and `subscriptionEndedAt`, Stripe's `ended_at` (or, without
 * one, when this first saw it) while the status is one of STOPPED_STATUSES
 * (`canceled`, `incomplete_expired`; never `unpaid`, which owes a payment and
 * is never deleted for it). Each is removed with any other status.
 *
 * With `asRead` (the nightly entitlement check, billing/entitlements.ts),
 * also conditioned on the team's status, plan, seats, subscription and
 * `cancelAtPeriodEnd` being as they were read, so a Stripe event applied
 * meanwhile is almost never overwritten with the older state the check
 * fetched. It compares values, not a version: a change and back (A to B to
 * A) between the read and the write, or a change only to `currentPeriodEnd`,
 * isn't seen, and the next event or night corrects it.
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
  // The dates the access rules count from (billingAccess): kept while the status lasts, removed after
  const removes: string[] = [];
  if (state.status === "past_due") {
    sets.push("pastDueSince = if_not_exists(pastDueSince, :at)");
  } else removes.push("pastDueSince");
  if (hasStopped(state.status)) {
    // Stripe's own time when it has one (a late or replayed event still counts from then), else when this first saw it
    if (state.endedAt !== undefined) {
      sets.push("subscriptionEndedAt = :ended");
      values[":ended"] = state.endedAt;
    } else sets.push("subscriptionEndedAt = if_not_exists(subscriptionEndedAt, :at)");
  } else removes.push("subscriptionEndedAt");
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
    if (asRead.cancelAtPeriodEnd !== undefined) {
      // Never applied reads as false
      values[":readCape"] = asRead.cancelAtPeriodEnd;
      unchanged.push(asRead.cancelAtPeriodEnd ? "cancelAtPeriodEnd = :readCape" : "(cancelAtPeriodEnd = :readCape OR attribute_not_exists(cancelAtPeriodEnd))");
    }
  }
  const subscription = state.replaces !== undefined ? "(attribute_not_exists(stripeSubscriptionId) OR stripeSubscriptionId = :sub OR stripeSubscriptionId = :replaces)" : "(attribute_not_exists(stripeSubscriptionId) OR stripeSubscriptionId = :sub)";
  if (state.replaces !== undefined) values[":replaces"] = state.replaces;
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.team(ctx.teamId),
        UpdateExpression: `SET ${sets.join(", ")}${removes.length ? ` REMOVE ${removes.join(", ")}` : ""}`,
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
