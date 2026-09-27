// Deleting closed teams once their read-only period is over (closeTeam,
// CLOSED_TEAM_RETENTION_DAYS). The scheduled purge (src/ops/team-purge.ts)
// lists the teams that are due from GSI1's closed-teams partition and
// deletes each one. Like listStuckImports it acts without a TeamContext: it's
// a server process with no caller, and it takes team IDs only from the
// table's own index. It names only TEAM_PURGE_ATTRIBUTES, the attributes its
// IAM policy allows, so it never reads documents, emails or names.
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

import { DeleteCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { id, keys, prefixes, teamPartition } from "./keys.js";
import { CLOSED_TEAMS_PARTITION, GSI1 } from "./schema.js";

export interface TeamDue {
  readonly teamId: string;
  /** When it became due (ISO 8601). */
  readonly purgeAfter: string;
}

/** The closed teams whose `purgeAfter` has passed, earliest first, at most `limit`. */
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
        ProjectionExpression: "PK, SK, GSI1PK, GSI1SK",
        ExpressionAttributeValues: { ":pk": CLOSED_TEAMS_PARTITION, ":before": now.toISOString() },
        Limit: limit - out.length,
        ExclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      const sk = String(item.GSI1SK);
      const at = sk.lastIndexOf("#");
      const pk = String(item.PK);
      if (item.SK !== "META" || !pk.startsWith("TEAM#")) continue;
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

/** What purgeTeam did: `skipped` when the team isn't closed or isn't due (it was, or it's gone). */
export interface PurgeResult {
  readonly deleted: number;
  readonly skipped: boolean;
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
 *
 * `beforeDelete` runs once the team is found due and before anything is
 * deleted (the purge writes the team's deletion record there); if it fails,
 * nothing is deleted and the next run tries again.
 */
export async function purgeTeam(db: Db, teamId: string, now: Date, options: { readonly beforeDelete?: () => Promise<void> } = {}): Promise<PurgeResult> {
  const { doc } = connection(db);
  const pk = teamPartition(id(teamId, "team ID"));
  const { Item: meta } = await doc.send(
    new GetCommand({ TableName: db.tableName, Key: keys.team(teamId), ConsistentRead: true, ProjectionExpression: "closedAt, purgeAfter, stripeCustomerId" }),
  );
  // Only a closed team, and only once it's due: the index is a hint, the META item decides
  if (!meta || typeof meta.closedAt !== "string" || typeof meta.purgeAfter !== "string" || meta.purgeAfter > now.toISOString()) return { deleted: 0, skipped: true };
  await options.beforeDelete?.();

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
