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
// - Every trial team in the account together may read
//   RECEIPT_TRIAL_READS_PER_DAY receipts each UTC day (supply-checkout-i1d.3),
//   counted at `RECEIPTTRIALS` / `DAY#<day>`: a circuit breaker on model spend
//   for a farm of many accounts, which the per-user and per-team limits don't
//   bound. Paying teams don't count in it and aren't stopped by it.
//
// Each counter moves with a conditional update (the rate's three in one
// transaction), so two reads at once can't both take the last one, and none
// can go past its maximum.

import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError, LimitReachedError, RateLimitedError } from "./errors.js";
import { keys, month } from "./keys.js";
import { MAX_RECEIPT_TRIAL_READS_PER_DAY, RECEIPT_TRIAL_READS_PER_DAY } from "./schema.js";
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

/** The share of its allowance at which a team counts as near its limit (ReceiptTrialsNearLimit, which alarms when several trials cross at once, or ReceiptPaidTeamsNearLimit). */
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

/**
 * Receipts one user may read for trial teams (any period "trial" allowance)
 * each UTC day, from all their trial teams together: a mitigation for trial
 * farms, where one account makes many trial teams to reach 25 reads in each.
 * PROVISIONAL. It doesn't stop a farm of many accounts:
 * RECEIPT_TRIAL_READS_PER_DAY does.
 */
export const RECEIPT_TRIAL_READS_PER_USER_PER_DAY = 30;

// The account-wide trial cap's numbers live with its partition (schema.ts), where the infra reads them too
export { MAX_RECEIPT_TRIAL_READS_PER_DAY, RECEIPT_TRIAL_READS_PER_DAY } from "./schema.js";

/** How long a day's trial count outlives its day before DynamoDB's TTL may delete it: long enough to look at afterwards. */
const TRIAL_DAY_GRACE_SECONDS = 7 * 24 * 60 * 60;

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
 * read also counts in the account's trial reads for the UTC day, unless
 * `trialReadsPerDay` are counted already (TrialCapReachedError, TRIAL_CAP_REACHED;
 * the team's read is given back), and in the month's counter, with no limit
 * there.
 *
 * Each update names only the keys and `receipts` (RECEIPT_USAGE_ATTRIBUTES):
 * the month or `TRIAL` is in the sort key, so the receipts function's role,
 * which may update only those attributes, can't rewrite any other field of
 * any item in the team's partition (an item's `type`, say).
 */
export async function takeReceipt(db: Db, ctx: TeamContext, allowance: ReceiptAllowance, now = new Date(), trialReadsPerDay = RECEIPT_TRIAL_READS_PER_DAY): Promise<ReceiptQuota> {
  writable(db, ctx);
  const { limit, period } = allowance;
  if (!Number.isInteger(limit) || limit < 0) throw new InvalidInputError("Invalid limit");
  if (!validTrialReadsPerDay(trialReadsPerDay)) throw new InvalidInputError("Invalid trial cap");
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
  if (period === "trial") {
    // The team's own trial first, so a team with none left (the usual refusal) never touches the account's count.
    // Between that update and the give-back below, a refused read holds one of the team's trial reads, so another
    // read for the same team at that moment can briefly see receipt_limit instead of the account's trial_cap
    try {
      await takeTrialDay(db, trialReadsPerDay, now);
    } catch (error) {
      // Best effort: the team keeps the read the account's cap refused (or that failed to count)
      await giveBack(db, counterKey(ctx, period, m));
      throw error;
    }
    await addToMonth(db, ctx, m, 1);
  }
  return quota(allowance, m, used);
}

/** A whole number from 0 to MAX_RECEIPT_TRIAL_READS_PER_DAY. */
export function validTrialReadsPerDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_RECEIPT_TRIAL_READS_PER_DAY;
}

/**
 * The receipts function's account-wide trial cap from its environment
 * (RECEIPT_TRIAL_READS_PER_DAY): RECEIPT_TRIAL_READS_PER_DAY when unset.
 * Anything else that isn't a whole number in range throws, so a bad deploy
 * fails at start rather than running without the breaker.
 */
export function trialReadsPerDayFrom(raw: string | undefined): number {
  if (raw === undefined || raw === "") return RECEIPT_TRIAL_READS_PER_DAY;
  const n = /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : Number.NaN;
  if (!validTrialReadsPerDay(n)) throw new Error(`The trial receipt cap must be a whole number from 0 to ${MAX_RECEIPT_TRIAL_READS_PER_DAY}`);
  return n;
}

/** Seconds from `now` until the next UTC midnight, at least 1. */
function untilTomorrow(now: Date): number {
  const at = now.getTime();
  return Math.max(1, Math.ceil((Math.floor(at / 86_400_000) * 86_400_000 + 86_400_000 - at) / 1000));
}

/**
 * The account-wide trial cap refused a read (a RateLimitedError, so callers
 * that don't care see one). `firstToday` is true for the first refusal of the
 * UTC day only, which the receipts function sends to "Needs attention": a
 * trial user can make every later one (supply-checkout-7pe.1).
 */
export class TrialCapReachedError extends RateLimitedError {
  readonly firstToday: boolean;

  constructor(retryAfterSeconds: number, firstToday: boolean) {
    super(TRIAL_CAP_REACHED, retryAfterSeconds);
    this.firstToday = firstToday;
  }
}

/**
 * Whether this is the day's first refusal at the trial cap: marks the day's
 * item `capReachedAt` (seconds), once, with a conditional update that only a
 * refused read makes, so a read under the cap costs nothing more. A failed
 * write counts as the first, so a broken table can't silence the alert.
 */
async function firstCapToday(db: Db, day: string, now: Date, expiresAt: number): Promise<boolean> {
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.receiptTrialDay(day),
        UpdateExpression: "SET capReachedAt = :at, expiresAt = :expires",
        ConditionExpression: "attribute_not_exists(capReachedAt)",
        ExpressionAttributeValues: { ":at": Math.floor(now.getTime() / 1000), ":expires": expiresAt },
      }),
    );
    return true;
  } catch (error) {
    return !conditionFailed(error);
  }
}

/**
 * Counts one trial read in the account's count for the UTC day, unless
 * `max` are counted already: TrialCapReachedError, with the seconds to the
 * next UTC day. One conditional update, so reads at once can't go past it.
 * It, and the refusal's mark (firstCapToday), name only the keys, `count`,
 * `capReachedAt` and `expiresAt` (RECEIPT_TRIAL_CAP_ATTRIBUTES) and return
 * nothing, which is all the receipts role may do in the `RECEIPTTRIALS`
 * partition.
 */
async function takeTrialDay(db: Db, max: number, now: Date): Promise<void> {
  const wait = untilTomorrow(now);
  const day = now.toISOString().slice(0, 10);
  const expiresAt = Math.ceil(now.getTime() / 1000) + wait + TRIAL_DAY_GRACE_SECONDS;
  const refused = async () => new TrialCapReachedError(wait, await firstCapToday(db, day, now, expiresAt));
  if (max === 0) throw await refused();
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.receiptTrialDay(day),
        UpdateExpression: "ADD #count :one SET expiresAt = :expires",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":one": 1, ":max": max, ":expires": expiresAt },
      }),
    );
  } catch (error) {
    if (conditionFailed(error)) throw await refused();
    throw error;
  }
}

/** Takes one off a team's receipt counter, never below zero; best effort. */
async function giveBack(db: Db, key: Record<string, string>): Promise<void> {
  await connection(db)
    .doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: key,
        UpdateExpression: "ADD receipts :n",
        ConditionExpression: "receipts > :zero",
        ExpressionAttributeValues: { ":n": -1, ":zero": 0 },
      }),
    )
    .catch(() => undefined);
}

/**
 * The message when the account's trial reads for the day
 * (RECEIPT_TRIAL_READS_PER_DAY) are used up: no one's fault, and it says
 * what still works.
 */
export const TRIAL_CAP_REACHED = "Free trial receipt scanning has reached its limit for today; more tomorrow. Enter the items by hand, or ask an owner to subscribe to keep scanning receipts.";

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
 * get a read, and we didn't pay for one. Never below zero. A trial read is
 * also given back to the account's trial count for the day it was counted in
 * (`takenAt`, the time takeReceipt was given). Not the rate limit's counters:
 * those count attempts.
 */
export async function refundReceipt(db: Db, ctx: TeamContext, taken: ReceiptQuota, takenAt?: Date): Promise<void> {
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
  if (taken.period === "trial") {
    // The month's and the account's day's (the day the read was counted in) each on its own: one failing doesn't skip the other
    const results = await Promise.allSettled([
      addToMonth(db, ctx, taken.month, -1).catch(keep),
      takenAt ? giveBackTrialDay(db, takenAt.toISOString().slice(0, 10)).catch(keep) : Promise.resolve(),
    ]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }
}

async function giveBackTrialDay(db: Db, day: string): Promise<void> {
  await connection(db).doc.send(
    new UpdateCommand({
      TableName: db.tableName,
      Key: keys.receiptTrialDay(day),
      UpdateExpression: "ADD #count :n",
      ConditionExpression: "#count > :zero",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: { ":n": -1, ":zero": 0 },
    }),
  );
}

/** The read that takeReceipt counted crosses RECEIPT_NEAR_LIMIT_SHARE of the allowance: true once per allowance. */
export function crossesNearLimit(taken: ReceiptQuota): boolean {
  return taken.limit > 0 && taken.used === Math.ceil(taken.limit * RECEIPT_NEAR_LIMIT_SHARE);
}

/** Attempts at the rate limit's transaction when it collides with another of the same user's (TransactionConflict). */
const RATE_ATTEMPTS = 4;

/**
 * Counts one receipt read against the caller's per-user rate limit, in every
 * window of RECEIPT_RATE_LIMITS at once (and, for a trial team's read, the
 * day's RECEIPT_TRIAL_READS_PER_USER_PER_DAY), or in none: one transaction, so a
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
export async function takeReceiptRate(db: Db, ctx: TeamContext, period: ReceiptAllowance["period"], now = new Date()): Promise<void> {
  writable(db, ctx);
  const { userId } = assertContext(ctx);
  const at = now.getTime();
  const iso = now.toISOString();
  const stamps = { MINUTE: iso.slice(0, 16), HOUR: iso.slice(0, 13), DAY: iso.slice(0, 10), TRIALDAY: iso.slice(0, 10) } as const;
  const limits: readonly { window: keyof typeof stamps; max: number; ms: number }[] = [
    ...RECEIPT_RATE_LIMITS,
    // A read for a trial team also counts in the user's trial reads for the day
    ...(period === "trial" ? [{ window: "TRIALDAY" as const, max: RECEIPT_TRIAL_READS_PER_USER_PER_DAY, ms: 86_400_000 }] : []),
  ];
  const windows = limits.map(({ window, max, ms }) => ({ window, max, ends: Math.floor(at / ms) * ms + ms }));
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
        // Only the day's trial reads are used up: say so, rather than "a lot in a short time"
        const message = full.every(({ window }) => window === "TRIALDAY") ? TRIAL_DAY_USED : rateLimited(wait);
        throw new RateLimitedError(message, wait);
      }
      if (!codes.includes("TransactionConflict")) throw error;
      if (attempt >= RATE_ATTEMPTS) throw new RateLimitedError(rateLimited(1), 1);
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt + Math.floor(Math.random() * 20)));
    }
  }
}

/** The message when only the user's trial reads for the day (RECEIPT_TRIAL_READS_PER_USER_PER_DAY) are used up. */
export const TRIAL_DAY_USED = "You've used today's free trial receipt scans; more tomorrow. Enter the items by hand, or ask an owner to subscribe.";

function rateLimited(seconds: number): string {
  const hours = Math.ceil(seconds / 3600);
  const when = seconds <= 60 ? "in a minute" : seconds < 3600 ? `in ${Math.ceil(seconds / 60)} minutes` : hours === 1 ? "in an hour" : `in ${hours} hours`;
  return `You've read a lot of receipts in a short time. Try again ${when}, or enter the items by hand.`;
}
