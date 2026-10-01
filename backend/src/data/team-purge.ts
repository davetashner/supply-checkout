// Deleting closed teams once their read-only period is over (closeTeam,
// CLOSED_TEAM_RETENTION_DAYS). The scheduled purge (src/ops/team-purge.ts)
// lists the teams that are due from GSI1's closed-teams partition and
// deletes each one. Like listStuckImports it acts without a TeamContext: it's
// a server process with no caller, and it takes team IDs only from the
// table's own index. It names only TEAM_PURGE_ATTRIBUTES, the attributes its
// IAM policy allows, so it never reads documents, emails or names.
//
// Before deleting anything it marks the META item `purging` (the time it
// started), on the condition the team is still closed and due. reopenTeam
// refuses a team marked `purging` and purgeTeam refuses one that isn't closed,
// and both are conditional writes to the same META item, so whichever lands
// first wins: a team is never reopened part-deleted, whatever the clocks say.
// The mark is never removed; the META item goes last.
//
// A team is deleted in an order that makes a stopped run safe to repeat: each
// member's team-switcher row, then every other item in the team's partition,
// then the Stripe link, and the META item last, which also takes the team out
// of the index. Until then the next run finds it again and carries on. Every
// delete is idempotent. Nothing can write to the team meanwhile: it's closed,
// so writable refuses members, and nobody can join.
//
// Deleting MEMBER items here doesn't move the META item's counts: the META
// item goes too.
//
// The purge also ends closed teams' Stripe subscriptions (billing/closing.ts):
// listClosedTeamsToEnd lists every closed team with a subscription not yet set
// to end for its closure, closedTeamToEnd re-reads one before Stripe is
// called, and markSubscriptionEnding records it (`stripeCancelledFor`, the
// closure's `closedAt`), so later runs skip it. markSubscriptionSetAside
// records one the purge won't end or retry (`stripeSetAsideFor`, with why in
// `stripeSetAsideReason`), which later runs skip too, so it can't crowd newer
// closures out; a person removing `stripeSetAsideFor` lists it again.
// listSetAsideTeams counts the teams set aside for their current closure, for
// the purge's gauge (supply-checkout-8jc.36). Those teams aren't purged until
// a person deals with them (supply-checkout-8jc.37): listTeamsToPurge leaves
// them out, and purgeTeam holds them. purgeTeam's
// `deleteStripeCustomer` deletes a team's Stripe customer before any of its
// items go.

import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys, prefixes, teamPartition } from "./keys.js";
import { CLOSED_TEAMS_PARTITION, GSI1 } from "./schema.js";

export interface TeamDue {
  readonly teamId: string;
  /** When it became due (ISO 8601). */
  readonly purgeAfter: string;
}

/**
 * The closed teams whose `purgeAfter` has passed, earliest first, at most
 * `limit`, leaving out teams set aside for their current closure
 * (`stripeSetAsideFor` equal to `closedAt`): purgeTeam holds those back until
 * a person deals with them, so they mustn't fill the listing ahead of teams
 * it can delete.
 */
export async function listTeamsToPurge(db: Db, now: Date, limit = 100): Promise<TeamDue[]> {
  const out: TeamDue[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI1,
        // Every GSI1SK here is `<purgeAfter>#<teamId>`, and "#" sorts before any digit
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK < :before",
        Select: "SPECIFIC_ATTRIBUTES",
        ProjectionExpression: "PK, SK, GSI1PK, GSI1SK, closedAt, stripeSetAsideFor",
        ExpressionAttributeValues: { ":pk": CLOSED_TEAMS_PARTITION, ":before": now.toISOString() },
        Limit: limit - out.length,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = String(item.GSI1SK);
      const at = sk.lastIndexOf("#");
      const pk = String(item.PK);
      if (item.SK !== "META" || !pk.startsWith("TEAM#") || isSetAside(item)) continue;
      try {
        out.push({ teamId: id(pk.slice("TEAM#".length), "team ID"), purgeAfter: sk.slice(0, at) });
      } catch {
        // Not a key this app wrote: leave it for a person to look at
      }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey && out.length < limit);
  return out;
}

/**
 * How many closed teams have a `purgeAfter` before `before`, however many
 * there are: a count query on the same index partition (Select COUNT, which
 * returns no items), paged by DynamoDB's 1 MB limit. The purge's
 * ClosedTeamsOverdue gauge uses it, so it isn't capped at a listing's limit.
 */
export async function countTeamsDueBefore(db: Db, before: Date): Promise<number> {
  let count = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk AND GSI1SK < :before",
        Select: "COUNT",
        ExpressionAttributeValues: { ":pk": CLOSED_TEAMS_PARTITION, ":before": before.toISOString() },
        ExclusiveStartKey,
      }),
    );
    count += page.Count ?? 0;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

/** A closed team whose Stripe subscription hasn't been set to end for this closure yet. */
export interface ClosedTeamToEnd {
  readonly teamId: string;
  readonly closedAt: string;
  readonly purgeAfter: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
}

const TO_END = "closedAt, purgeAfter, purging, stripeCustomerId, stripeSubscriptionId, stripeCancelledFor, stripeSetAsideFor";

/**
 * Why the purge set a closed team's subscription aside for a person
 * (`stripeSetAsideReason`): it belongs to another customer, Stripe doesn't
 * have it (maybe a Stripe key or mode mismatch), or Stripe refused to end it
 * with an error that retrying won't change.
 */
export type SetAsideReason = "CustomerMismatch" | "NotFound" | "PermanentError";

/** The team as ClosedTeamToEnd, if it's closed, not being purged, has a subscription, and it isn't recorded as ended or set aside for this closure. */
function toEnd(teamId: string, item: Record<string, unknown> | undefined): ClosedTeamToEnd | undefined {
  if (!item || item.purging !== undefined) return undefined;
  const { closedAt, purgeAfter, stripeCustomerId, stripeSubscriptionId, stripeCancelledFor, stripeSetAsideFor } = item;
  if (typeof closedAt !== "string" || typeof purgeAfter !== "string" || typeof stripeCustomerId !== "string" || typeof stripeSubscriptionId !== "string") return undefined;
  if (stripeCancelledFor === closedAt || stripeSetAsideFor === closedAt) return undefined;
  return { teamId, closedAt, purgeAfter, stripeCustomerId, stripeSubscriptionId };
}

/**
 * Every closed team whose Stripe subscription hasn't been set to end for its
 * closure (no `stripeCancelledFor` equal to its `closedAt`), at most `limit`,
 * the soonest due first. Teams the purge has started on are left out: deleting
 * their customer ends the subscription. So are teams set aside for this
 * closure (`stripeSetAsideFor`, markSubscriptionSetAside), so a pile of
 * subscriptions that will never end can't fill the limit and starve newer
 * closures. Read from the closed-teams index
 * (which projects every attribute), so it may lag a write by a moment:
 * closedTeamToEnd re-reads each one before Stripe is called.
 */
export async function listClosedTeamsToEnd(db: Db, limit = 100): Promise<ClosedTeamToEnd[]> {
  const out: ClosedTeamToEnd[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        Select: "SPECIFIC_ATTRIBUTES",
        ProjectionExpression: `PK, SK, ${TO_END}`,
        ExpressionAttributeValues: { ":pk": CLOSED_TEAMS_PARTITION },
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const pk = String(item.PK);
      if (item.SK !== "META" || !pk.startsWith("TEAM#")) continue;
      let teamId: string;
      try {
        teamId = id(pk.slice("TEAM#".length), "team ID");
      } catch {
        // Not a key this app wrote: leave it for a person to look at
        continue;
      }
      const team = toEnd(teamId, item);
      if (team && out.length < limit) out.push(team);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey && out.length < limit);
  return out;
}

/** The team as it is now (a consistent read), if its subscription still needs ending for this closure. */
export async function closedTeamToEnd(db: Db, teamId: string): Promise<ClosedTeamToEnd | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.team(id(teamId, "team ID")), ConsistentRead: true, ProjectionExpression: TO_END }));
  return toEnd(teamId, Item);
}

/**
 * Whether the team is open now (a consistent read): its META item is there,
 * with no `closedAt` and no `purging` mark. The purge asks after a team was
 * reopened while it set its subscription to cancel (supply-checkout-85qp).
 */
export async function isTeamOpen(db: Db, teamId: string): Promise<boolean> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.team(id(teamId, "team ID")), ConsistentRead: true, ProjectionExpression: "closedAt, purging" }));
  return Item !== undefined && Item.closedAt === undefined && Item.purging === undefined;
}

/**
 * Records that the team's subscription was set to end for this closure
 * (`stripeCancelledFor`, its `closedAt`), on the condition it's still that
 * closure (the same `purgeAfter`). Returns false if it isn't: the team was
 * reopened, or reopened and closed again, while Stripe was being called.
 */
export function markSubscriptionEnding(db: Db, team: Pick<ClosedTeamToEnd, "teamId" | "closedAt" | "purgeAfter">): Promise<boolean> {
  return recordForClosure(db, team, "SET stripeCancelledFor = :at");
}

/**
 * Records that the purge won't end the team's subscription, or try again,
 * for this closure (`stripeSetAsideFor`, its `closedAt`, and why in
 * `stripeSetAsideReason`): a person has to look. listClosedTeamsToEnd leaves
 * it out from then on, and listSetAsideTeams counts it until a person removes
 * `stripeSetAsideFor` (which lists it again) or the team is purged; a new
 * closure lists it again too. On the same condition as markSubscriptionEnding,
 * and false the same way.
 */
export function markSubscriptionSetAside(db: Db, team: Pick<ClosedTeamToEnd, "teamId" | "closedAt" | "purgeAfter">, reason: SetAsideReason): Promise<boolean> {
  return recordForClosure(db, team, "SET stripeSetAsideFor = :at, stripeSetAsideReason = :reason", { ":reason": reason });
}

/** Runs `update` (which sets an attribute to `:at`, the team's `closedAt`) on the condition it's still that closure. False if it isn't. */
function recordForClosure(db: Db, team: Pick<ClosedTeamToEnd, "teamId" | "closedAt" | "purgeAfter">, update: string, values: Record<string, string> = {}): Promise<boolean> {
  return connection(db)
    .doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.team(id(team.teamId, "team ID")),
        UpdateExpression: update,
        // purgeAfter is set with closedAt and goes with it (see the mark below): still this closure
        ConditionExpression: "purgeAfter = :purge",
        ExpressionAttributeValues: { ":at": team.closedAt, ":purge": team.purgeAfter, ...values },
      }),
    )
    .then(
      () => true,
      (error: unknown) => {
        if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
        throw error;
      },
    );
}

/** Whether a team's META item is set aside for its current closure: held back from the purge until a person deals with it. */
const isSetAside = (item: Record<string, unknown>) => typeof item.closedAt === "string" && item.stripeSetAsideFor === item.closedAt;

/** A closed team set aside for its current closure, and why. */
export interface SetAsideTeam {
  readonly teamId: string;
  /** Missing on a team set aside before reasons were recorded. */
  readonly reason?: string;
}

/**
 * The closed teams whose subscription is set aside for their current closure
 * (`stripeSetAsideFor` equal to `closedAt`), however many there are: `count`
 * is all of them, and `teams` the first `limit`, soonest due first, for the
 * log. `overdue` is how many of them have a `purgeAfter` before
 * `overdueBefore` (0 without it): purgeTeam holds them back, so they're
 * kept past their deletion date, and the purge logs how many.
 * Read from the closed-teams index, every page: it holds only teams closed
 * in the last CLOSED_TEAM_RETENTION_DAYS (and set-aside teams held past it),
 * and a team leaves it when it's purged or reopened. The purge sends `count`
 * as a gauge every run, so its alarm keeps firing until a person has dealt
 * with each one.
 */
export async function listSetAsideTeams(db: Db, limit = 25, overdueBefore?: Date): Promise<{ count: number; teams: SetAsideTeam[]; overdue: number }> {
  const teams: SetAsideTeam[] = [];
  const before = overdueBefore?.toISOString();
  let count = 0;
  let overdue = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({
        TableName: db.tableName,
        IndexName: GSI1,
        KeyConditionExpression: "GSI1PK = :pk",
        Select: "SPECIFIC_ATTRIBUTES",
        ProjectionExpression: "PK, SK, closedAt, purgeAfter, stripeSetAsideFor, stripeSetAsideReason",
        ExpressionAttributeValues: { ":pk": CLOSED_TEAMS_PARTITION },
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const pk = String(item.PK);
      const { purgeAfter, stripeSetAsideReason } = item;
      if (item.SK !== "META" || !pk.startsWith("TEAM#") || !isSetAside(item)) continue;
      count++;
      if (before !== undefined && typeof purgeAfter === "string" && purgeAfter < before) overdue++;
      if (teams.length < limit) teams.push({ teamId: pk.slice("TEAM#".length), ...(typeof stripeSetAsideReason === "string" ? { reason: stripeSetAsideReason } : {}) });
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { count, teams, overdue };
}

/**
 * What purgeTeam did: `skipped` when the team isn't closed or isn't due (it
 * was, or it's gone), or is held: `held` when it's set aside for its current
 * closure.
 */
export interface PurgeResult {
  readonly deleted: number;
  readonly skipped: boolean;
  readonly held?: true;
}

/** A purged team's Stripe customer and subscription, as its META item had them, for its deletion record. */
export interface PurgedStripeIds {
  readonly stripeCustomerId?: string;
  readonly stripeSubscriptionId?: string;
}

/** Runs `fn` over `items`, `concurrency` at a time. */
async function each<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

const CONCURRENCY = 10;

/**
 * Deletes everything a closed team has, if its `purgeAfter` has passed: the
 * whole `TEAM#<teamId>` partition (members, invites, products, sheets,
 * movements, audit trail, counters), each member's team-switcher row, and the
 * Stripe link. Returns how many items it deleted. Safe to run again after it
 * stopped part-way, and a no-op for a team that isn't closed or isn't due.
 * It first marks the team `purging`, conditioned on it still being closed and
 * due, so reopenTeam can't reopen it once anything may be gone.
 *
 * A team set aside for its current closure (`stripeSetAsideFor` equal to
 * `closedAt`, markSubscriptionSetAside) is held: neither marked nor deleted,
 * until a person deals with it and removes `stripeSetAsideFor`
 * (supply-checkout-8jc.37). Its subscription may still be live: under a
 * Stripe key or mode mismatch, deleting its customer would get "not found"
 * too, end nothing, and leave nothing in the table to find it by. The mark's
 * condition holds it too, if it's set aside after the read (a re-read then
 * tells a held team from one reopened or gone).
 *
 * `beforeDelete` runs once the team is marked and before anything is deleted
 * (the purge writes the team's deletion record there, with the team's Stripe
 * IDs, which it's given): after the mark, so a
 * team reopened meanwhile never gets a record. Then, for a team with a Stripe
 * customer, `deleteStripeCustomer` (the purge deletes the customer in Stripe
 * there). If either fails, nothing is deleted and the next run tries again,
 * so a team's items never go while its Stripe customer stays.
 */
export async function purgeTeam(
  db: Db,
  teamId: string,
  now: Date,
  options: { readonly beforeDelete?: (stripe: PurgedStripeIds) => Promise<void>; readonly deleteStripeCustomer?: (customerId: string) => Promise<void> } = {},
): Promise<PurgeResult> {
  const { doc } = connection(db);
  const pk = teamPartition(id(teamId, "team ID"));
  const { Item: meta } = await doc.send(
    new GetCommand({
      TableName: db.tableName,
      Key: keys.team(teamId),
      ConsistentRead: true,
      ProjectionExpression: "closedAt, purgeAfter, stripeCustomerId, stripeSubscriptionId, stripeSetAsideFor",
    }),
  );
  // Only a closed team, and only once it's due: the index is a hint, the META item decides
  if (!meta || typeof meta.closedAt !== "string" || typeof meta.purgeAfter !== "string" || meta.purgeAfter > now.toISOString()) return { deleted: 0, skipped: true };
  // Set aside for this closure: held for a person
  if (isSetAside(meta)) return { deleted: 0, skipped: true, held: true };
  // Mark it before deleting anything, if it's still closed and due: from here reopenTeam refuses it.
  // A team reopened since the read above fails the condition and is left alone.
  const marked = await doc
    .send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.team(teamId),
        UpdateExpression: "SET purging = :now",
        // purgeAfter exists exactly while the team is closed (closeTeam and reopenTeam set and remove it
        // with closedAt), so this is "still closed and due" without naming closedAt (TEAM_PURGE_MARK_ATTRIBUTES).
        // And not set aside since the read for the closure it read (a new closure moves purgeAfter past now)
        ConditionExpression: "attribute_exists(purgeAfter) AND purgeAfter <= :now AND (attribute_not_exists(stripeSetAsideFor) OR stripeSetAsideFor <> :closedAt)",
        ExpressionAttributeValues: { ":now": now.toISOString(), ":closedAt": meta.closedAt },
      }),
    )
    .then(
      () => true,
      (error: unknown) => {
        if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
        throw error;
      },
    );
  if (!marked) {
    // Set aside since the read? Then it's held, not just skipped
    const { Item: current } = await doc.send(new GetCommand({ TableName: db.tableName, Key: keys.team(teamId), ConsistentRead: true, ProjectionExpression: "closedAt, stripeSetAsideFor" }));
    return current && isSetAside(current) ? { deleted: 0, skipped: true, held: true } : { deleted: 0, skipped: true };
  }
  const stripeIds: { stripeCustomerId?: string; stripeSubscriptionId?: string } = {};
  if (typeof meta.stripeCustomerId === "string") stripeIds.stripeCustomerId = meta.stripeCustomerId;
  if (typeof meta.stripeSubscriptionId === "string") stripeIds.stripeSubscriptionId = meta.stripeSubscriptionId;
  await options.beforeDelete?.(stripeIds);
  if (typeof meta.stripeCustomerId === "string") await options.deleteStripeCustomer?.(meta.stripeCustomerId);

  const items: { PK: string; SK: string }[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: db.tableName,
        KeyConditionExpression: "PK = :pk",
        Select: "SPECIFIC_ATTRIBUTES",
        ProjectionExpression: "PK, SK",
        ExpressionAttributeValues: { ":pk": pk },
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) items.push(item as { PK: string; SK: string });
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const remove = (key: { PK: string; SK: string }) => doc.send(new DeleteCommand({ TableName: db.tableName, Key: { PK: key.PK, SK: key.SK } }));
  // Members' switcher rows first: once a MEMBER item is gone, nothing names its row
  const members = items.filter((item) => item.SK.startsWith(prefixes.member));
  await each(members, CONCURRENCY, (item) => {
    const userId = item.SK.slice(prefixes.member.length);
    return remove(keys.userTeam(userId, teamId));
  });
  const rest = items.filter((item) => item.SK !== "META");
  await each(rest, CONCURRENCY, remove);
  let deleted = members.length + rest.length;
  if (typeof meta.stripeCustomerId === "string") {
    await doc.send(
      new DeleteCommand({
        TableName: db.tableName,
        Key: keys.stripe(meta.stripeCustomerId),
        // Only this team's link
        ConditionExpression: "attribute_not_exists(PK) OR teamId = :team",
        ExpressionAttributeValues: { ":team": teamId },
      }),
    );
    deleted++;
  }
  // Last, on the condition it's still closed: this also takes the team out of the index.
  // Already gone means another run finished it.
  await doc.send(new DeleteCommand({ TableName: db.tableName, Key: keys.team(teamId), ConditionExpression: "attribute_exists(closedAt)" })).catch((error: unknown) => {
    if ((error as { name?: string } | null)?.name !== "ConditionalCheckFailedException") throw error;
  });
  return { deleted: deleted + 1, skipped: false };
}
