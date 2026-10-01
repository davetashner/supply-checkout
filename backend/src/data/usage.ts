// Receipt reads (ADR 0005, ADR 0008, supply-checkout-wxx): what a team may
// read, counted with atomic counters, and the per-user rate limit in front of
// them.
//
// - A paying team (PAID_STATUSES, or a live comp) may read
//   RECEIPTS_PER_TEAM_PER_MONTH receipts each UTC month, counted at
//   `TEAM#<teamId>` / `USAGE#<month>`.
// - Any other team (a trial, or a subscription that isn't paid yet) may read
//   RECEIPTS_PER_TRIAL receipts in all, counted at `TEAM#<teamId>` /
//   `USAGE#TRIAL`, which never resets. Its reads also count in the month's
//   counter, so operators see every team's reads per month.
// - Each user may read RECEIPT_RATE_LIMITS receipts a minute, an hour and a
//   day, from every team they're in together, counted at
//   `RECEIPTRATE#<userId>` / `RECEIPTS#<window>#<stamp>`.
//
// Each counter moves with a conditional update (the rate's three in one
// transaction), so two reads at once can't both take the last one, and none
// can go past its maximum.

import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError, LimitReachedError, RateLimitedError } from "./errors.js";
import { keys, month } from "./keys.js";
import { liveComp, PAID_STATUSES } from "./model.js";
import { type TeamContext, assertContext, readable, writable } from "./team-context.js";

/**
 * Receipts a paying or comped team may read each UTC month. PROVISIONAL: the
 * owner's interim number (ADR 0009's starting proposal) until the pricing
 * decision, supply-checkout-akz.
 */
export const RECEIPTS_PER_TEAM_PER_MONTH = 200;

/**
 * Receipts a team that isn't paying may read in all, for its whole trial (not
 * per month). PROVISIONAL, as above (owner decision 2026-10-01). Low, because
 * anyone can start a trial: a farm of sign-ups gets this many model calls each.
 */
export const RECEIPTS_PER_TRIAL = 25;

/** The share of its allowance at which a team counts as near its limit (ReceiptTeamsNearLimit, a P2 alarm). */
export const RECEIPT_NEAR_LIMIT_SHARE = 0.8;

/**
 * The per-user rate limit: at most `max` receipt reads in each fixed UTC
 * window, from all of the user's teams together. A read must fit every
 * window. Fixed windows let a user read up to twice `max` across a window's
 * edge; the longer windows bound that. Enough for a person photographing a
 * stack of receipts; not enough to make one account a cheap way to the model.
 */
export const RECEIPT_RATE_LIMITS = [
  { window: "MINUTE", max: 10, ms: 60_000 },
  { window: "HOUR", max: 60, ms: 3_600_000 },
  { window: "DAY", max: 200, ms: 86_400_000 },
] as const;

/** How long a rate counter outlives its window before DynamoDB's TTL may delete it. */
const RATE_COUNTER_GRACE_SECONDS = 24 * 60 * 60;

/** What a team may read: per month while it pays, or in all during its trial. */
export interface ReceiptAllowance {
  readonly period: "month" | "trial";
  readonly limit: number;
}

/** A team's receipt reads against its allowance. `month` is the UTC month counted, YYYY-MM. */
export interface ReceiptQuota extends ReceiptAllowance {
  readonly month: string;
  readonly used: number;
  readonly remaining: number;
}

/** The UTC month, YYYY-MM, that usage counts against. */
export function usageMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/**
 * The allowance for a team, from its META item's status and comp: a monthly
 * one while it pays (PAID_STATUSES) or has a live comp, else the trial's.
 */
export function receiptAllowance(team: { readonly status?: unknown; readonly compPlan?: unknown; readonly compUntil?: unknown }, now = new Date()): ReceiptAllowance {
  const paying = liveComp(team, now) !== undefined || (typeof team.status === "string" && PAID_STATUSES.includes(team.status));
  return paying ? { period: "month", limit: RECEIPTS_PER_TEAM_PER_MONTH } : { period: "trial", limit: RECEIPTS_PER_TRIAL };
}

/** The team's allowance now, read from its META item (strongly consistent). */
export async function getReceiptAllowance(db: Db, ctx: TeamContext, now = new Date()): Promise<ReceiptAllowance> {
  readable(ctx);
  const { Item } = await connection(db).doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.team(ctx.teamId),
      ProjectionExpression: "#status, compPlan, compUntil",
      ExpressionAttributeNames: { "#status": "status" },
      ConsistentRead: true,
    }),
  );
  return receiptAllowance(Item ?? {}, now);
}

const counterKey = (ctx: TeamContext, period: ReceiptAllowance["period"], m: string) => (period === "trial" ? keys.trialUsage(ctx.teamId) : keys.usage(ctx.teamId, m));

const quota = (allowance: ReceiptAllowance, m: string, used: number): ReceiptQuota => ({ ...allowance, month: m, used, remaining: Math.max(0, allowance.limit - used) });

/** Receipts read so far in `m` (YYYY-MM), whatever the team's allowance. */
export async function getReceiptUsage(db: Db, ctx: TeamContext, m: string): Promise<number> {
  readable(ctx);
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.usage(ctx.teamId, month(m)), ProjectionExpression: "receipts", ConsistentRead: true }));
  return (Item?.receipts as number | undefined) ?? 0;
}

/** The team's reads against its allowance now: this month's while it pays, its trial's while it doesn't. */
export async function getReceiptQuota(db: Db, ctx: TeamContext, now = new Date()): Promise<ReceiptQuota> {
  const allowance = await getReceiptAllowance(db, ctx, now);
  const m = usageMonth(now);
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: counterKey(ctx, allowance.period, m), ProjectionExpression: "receipts", ConsistentRead: true }));
  return quota(allowance, m, (Item?.receipts as number | undefined) ?? 0);
}

const limitReached = (allowance: ReceiptAllowance) =>
  allowance.period === "trial"
    ? `This team has read all ${allowance.limit} receipts included in its trial. An owner can subscribe to read more.`
    : `This team has read all ${allowance.limit} receipts included this month.`;

const conditionFailed = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";

/**
 * Counts one receipt read against the team's allowance, unless it's used up
 * (LimitReachedError). Returns the reads so far, this one included. A trial
 * read also counts in the month's counter, with no limit there.
 *
 * Each update names only the keys and `receipts` (RECEIPT_USAGE_ATTRIBUTES):
 * the month or `TRIAL` is in the sort key, so the receipts function's role,
 * which may update only those attributes, can't rewrite any other field of
 * any item in the team's partition (an item's `type`, say).
 */
export async function takeReceipt(db: Db, ctx: TeamContext, allowance: ReceiptAllowance, now = new Date()): Promise<ReceiptQuota> {
  writable(db, ctx);
  const { limit, period } = allowance;
  if (!Number.isInteger(limit) || limit < 0) throw new InvalidInputError("Invalid limit");
  const m = usageMonth(now);
  // An allowance of none: the counter's condition would let the first read through
  if (limit === 0) throw new LimitReachedError(limitReached(allowance));
  let used: number;
  try {
    const { Attributes } = await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: counterKey(ctx, period, m),
        UpdateExpression: "ADD receipts :one",
        ConditionExpression: "attribute_not_exists(receipts) OR receipts < :limit",
        ExpressionAttributeValues: { ":one": 1, ":limit": limit },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    used = Attributes?.receipts as number;
  } catch (error) {
    if (conditionFailed(error)) throw new LimitReachedError(limitReached(allowance));
    throw error;
  }
  if (period === "trial") await addToMonth(db, ctx, m, 1);
  return quota(allowance, m, used);
}

async function addToMonth(db: Db, ctx: TeamContext, m: string, n: 1 | -1): Promise<void> {
  await connection(db).doc.send(
    new UpdateCommand({
      TableName: db.tableName,
      Key: keys.usage(ctx.teamId, m),
      UpdateExpression: "ADD receipts :n",
      ...(n < 0 ? { ConditionExpression: "receipts > :zero", ExpressionAttributeValues: { ":n": n, ":zero": 0 } } : { ExpressionAttributeValues: { ":n": n } }),
    }),
  );
}

/**
 * Gives back a read takeReceipt counted, when the model service refused it
 * before any tokens were billed (throttled or unavailable): the caller didn't
 * get a read, and we didn't pay for one. Never below zero. Not the rate
 * limit's counters: those count attempts.
 */
export async function refundReceipt(db: Db, ctx: TeamContext, taken: ReceiptQuota): Promise<void> {
  writable(db, ctx);
  const keep = (error: unknown) => {
    if (!conditionFailed(error)) throw error;
  };
  await connection(db)
    .doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: counterKey(ctx, taken.period, taken.month),
        UpdateExpression: "ADD receipts :n",
        ConditionExpression: "receipts > :zero",
        ExpressionAttributeValues: { ":n": -1, ":zero": 0 },
      }),
    )
    .catch(keep);
  if (taken.period === "trial") await addToMonth(db, ctx, taken.month, -1).catch(keep);
}

/** The read that takeReceipt counted crosses RECEIPT_NEAR_LIMIT_SHARE of the allowance: true once per allowance. */
export function crossesNearLimit(taken: ReceiptQuota): boolean {
  return taken.limit > 0 && taken.used === Math.ceil(taken.limit * RECEIPT_NEAR_LIMIT_SHARE);
}

/** Attempts at the rate limit's transaction when it collides with another of the same user's (TransactionConflict). */
const RATE_ATTEMPTS = 4;

/**
 * Counts one receipt read against the caller's per-user rate limit, in every
 * window of RECEIPT_RATE_LIMITS at once, or in none: one transaction, so a
 * read refused by one window doesn't use up the others (a client retrying in
 * a loop is held to the minute's limit, not locked out for the day). Throws
 * RateLimitedError, with the seconds until the last full window ends. The
 * caller is the context's user (the token's `sub`), whichever team the read
 * is for. Two of one user's reads at once can collide (TransactionConflict):
 * it tries again a few times, then refuses for a second rather than let a
 * read through uncounted.
 *
 * Each update names only the keys, `count` and `expiresAt`
 * (RECEIPT_RATE_ATTRIBUTES) and returns nothing, which is all the receipts
 * role may do in the user's `RECEIPTRATE#` partition.
 */
export async function takeReceiptRate(db: Db, ctx: TeamContext, now = new Date()): Promise<void> {
  writable(db, ctx);
  const { userId } = assertContext(ctx);
  const at = now.getTime();
  const iso = now.toISOString();
  const stamps = { MINUTE: iso.slice(0, 16), HOUR: iso.slice(0, 13), DAY: iso.slice(0, 10) } as const;
  const windows = RECEIPT_RATE_LIMITS.map(({ window, max, ms }) => ({ window, max, ends: Math.floor(at / ms) * ms + ms }));
  const write = new TransactWriteCommand({
    TransactItems: windows.map(({ window, max, ends }) => ({
      Update: {
        TableName: db.tableName,
        Key: keys.receiptRate(userId, window, stamps[window]),
        UpdateExpression: "ADD #count :one SET expiresAt = :expires",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":one": 1, ":max": max, ":expires": Math.ceil(ends / 1000) + RATE_COUNTER_GRACE_SECONDS },
      },
    })),
  });
  for (let attempt = 1; ; attempt++) {
    try {
      await connection(db).doc.send(write);
      return;
    } catch (error) {
      if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") throw error;
      const codes = ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
      const full = windows.filter((_, i) => codes[i] === "ConditionalCheckFailed");
      if (full.length > 0) {
        const wait = Math.max(...full.map(({ ends }) => Math.max(1, Math.ceil((ends - at) / 1000))));
        throw new RateLimitedError(rateLimited(wait), wait);
      }
      if (!codes.includes("TransactionConflict")) throw error;
      if (attempt >= RATE_ATTEMPTS) throw new RateLimitedError(rateLimited(1), 1);
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 20)));
    }
  }
}

function rateLimited(seconds: number): string {
  const hours = Math.ceil(seconds / 3600);
  const when = seconds <= 60 ? "in a minute" : seconds < 3600 ? `in ${Math.ceil(seconds / 60)} minutes` : hours === 1 ? "in an hour" : `in ${hours} hours`;
  return `You've read a lot of receipts in a short time. Try again ${when}, or enter the items by hand.`;
}
