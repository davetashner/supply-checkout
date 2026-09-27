// Teams, members and each user's list of teams (ADR 0005, ADR 0007). Creating
// a team issues a context, so createTeam lives in team-context.ts.

import { DeleteCommand, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { auditPut } from "./audit.js";
import { type Db, connection } from "./client.js";
import { ConflictError, InvalidInputError, LastOwnerError, TeamDeletingError, conflictOnConditionFailure } from "./errors.js";
import { gsi1, id, keys, prefixes, strip, teamPartition } from "./keys.js";
import {
  type Invite,
  type Member,
  type MemberRole,
  type Team,
  type UserTeam,
  CLOSED_TEAM_RETENTION_DAYS,
  REOPEN_CUTOFF_MINUTES,
  isClosed,
  memberRole,
  ownersUpdate,
  teamCounts,
  teamName,
} from "./model.js";
import { memberCount } from "./member-count.js";
import { revokeInvitesForEmail } from "./invites.js";
import { queryAll, versionedSet } from "./query.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export type { Invite, InviteFailure, Member, MemberRole, Team, UserTeam } from "./model.js";
export { CLOSED_TEAM_RETENTION_DAYS, REOPEN_CUTOFF_MINUTES, isClosed } from "./model.js";

const CHANGED = "Someone else changed this team's members just now; reload and try again";
const LAST_OWNER = "A team needs at least one owner. Make someone else an owner first.";

export async function getTeam(db: Db, ctx: TeamContext): Promise<Team> {
  readable(ctx);
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.team(ctx.teamId), ConsistentRead: true }));
  return strip<Team>(Item) as Team;
}

/** Owners change the name; the billing webhook (system) changes plan, seats and status. */
export async function updateTeam(
  db: Db,
  ctx: TeamContext,
  changes: { readonly name?: string; readonly plan?: string; readonly seats?: number; readonly status?: string },
  expectedVersion: number,
): Promise<Team> {
  const billing = changes.plan !== undefined || changes.seats !== undefined || changes.status !== undefined;
  writable(db, ctx, billing ? "system" : "owner");
  const fields: Record<string, unknown> = {};
  if (changes.name !== undefined) fields.name = teamName(changes.name);
  if (changes.plan !== undefined) fields.plan = changes.plan;
  if (changes.seats !== undefined) fields.seats = changes.seats;
  if (changes.status !== undefined) fields.status = changes.status;
  const { Attributes } = await connection(db)
    .doc.send(new UpdateCommand({ TableName: db.tableName, Key: keys.team(ctx.teamId), ...versionedSet(fields, expectedVersion), ReturnValues: "ALL_NEW" }))
    .catch(conflictOnConditionFailure("The team changed; reload and try again"));
  return strip<Team>(Attributes) as Team;
}

export async function listMembers(db: Db, ctx: TeamContext): Promise<Member[]> {
  readable(ctx);
  return queryAll<Member>(db, teamPartition(ctx.teamId), prefixes.member);
}

export async function getMember(db: Db, ctx: TeamContext, userId: string): Promise<Member | undefined> {
  readable(ctx);
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.member(ctx.teamId, userId), ConsistentRead: true }));
  return strip<Member>(Item);
}

/**
 * Transaction items that re-check, at write time, that the caller is still an
 * owner. Without it, two owners could each act on a context issued before the
 * other demoted or removed them. Not needed for the caller's own membership
 * (that item is already conditioned) or for system processes.
 */
function callerStillOwner(db: Db, ctx: TeamContext, target: string) {
  if (ctx.role === "system" || target === ctx.userId) return [];
  return [
    {
      ConditionCheck: {
        TableName: db.tableName,
        Key: keys.member(ctx.teamId, ctx.userId),
        ConditionExpression: "#role = :owner",
        ExpressionAttributeNames: { "#role": "role" },
        ExpressionAttributeValues: { ":owner": "owner" },
      },
    },
  ];
}

/**
 * Maps a member change's failed transaction: the owner count's condition
 * (item `ownersAt`, when there is one) failing means the team would lose its
 * last owner, and anything else that failed a condition means someone changed
 * the team meanwhile. The count's condition is the enforcement; this only
 * picks the message.
 */
function memberChangeFailed(ownersAt: number | undefined): (error: unknown) => never {
  return (error: unknown) => {
    const cancelled = error as { name?: string; CancellationReasons?: { Code?: string }[] } | null;
    const reasons = cancelled?.name === "TransactionCanceledException" ? (cancelled.CancellationReasons ?? []) : [];
    const others = reasons.filter((_, i) => i !== ownersAt);
    // Only the owner count refused it: every other condition held
    if (ownersAt !== undefined && reasons[ownersAt]?.Code === "ConditionalCheckFailed" && others.every((r) => r.Code === "None")) throw new LastOwnerError(LAST_OWNER);
    return conflictOnConditionFailure(CHANGED)(error);
  };
}

async function currentMember(db: Db, ctx: TeamContext, userId: string): Promise<Member> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({ TableName: db.tableName, Key: keys.member(ctx.teamId, id(userId, "user ID")), ConsistentRead: true }),
  );
  if (!Item) throw new ConflictError("Not a member of this team");
  return Item as Member;
}

const currentRole = async (db: Db, ctx: TeamContext, userId: string): Promise<MemberRole> => (await currentMember(db, ctx, userId)).role;

/**
 * Owners change members' roles, their own included. The MEMBER item, the
 * user's switcher row and the team's owner count change in one transaction,
 * conditioned on the role read here, so a team never loses its last owner
 * (LastOwnerError).
 */
export async function setMemberRole(db: Db, ctx: TeamContext, userId: string, role: MemberRole): Promise<void> {
  writable(db, ctx, "owner");
  memberRole(role);
  const from = await currentRole(db, ctx, userId);
  if (from === role) return;
  const set = { UpdateExpression: "SET #role = :role", ExpressionAttributeNames: { "#role": "role" } };
  await connection(db)
    .doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: db.tableName,
              Key: keys.member(ctx.teamId, userId),
              ...set,
              ConditionExpression: "#role = :from",
              ExpressionAttributeValues: { ":role": role, ":from": from },
            },
          },
          // The member's team-switcher row: only `role`, and only if the row exists, so this
          // can't create a partial row. MEMBER_ROW_ATTRIBUTES lists what it may name.
          {
            Update: {
              TableName: db.tableName,
              Key: keys.userTeam(userId, ctx.teamId),
              ...set,
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: { ":role": role },
            },
          },
          ...(from === "owner" ? [ownersUpdate(db.tableName, ctx.teamId, -1)] : []),
          ...(role === "owner" ? [ownersUpdate(db.tableName, ctx.teamId, 1)] : []),
          ...callerStillOwner(db, ctx, userId),
        ],
      }),
    )
    .catch(memberChangeFailed(from === "owner" ? 2 : undefined));
}

/**
 * Owners remove members; any member can remove themselves (leave). The team's
 * member count goes down in the same transaction, and removing an owner also
 * decrements the owner count, conditioned on another owner remaining
 * (LastOwnerError). Their pending invites to the team are revoked first. The
 * removal is audited in the same transaction (`member.left` or
 * `member.removed`, with `reason` when given).
 *
 * A closed team still lets people leave and owners remove them, and its last
 * owner may leave too: nothing about a closed team can change any more, and
 * the purge deletes it.
 */
export async function removeMember(db: Db, ctx: TeamContext, userId: string, options: { readonly reason?: "account_deleted" } = {}, now = new Date()): Promise<void> {
  const minimum = userId === ctx.userId ? "viewer" : "owner";
  writable(db, ctx, minimum, { whileClosed: true });
  const [{ role: from, email }, count] = await Promise.all([currentMember(db, ctx, userId), memberCount(db, ctx.teamId)]);
  if (!count) throw new ConflictError(CHANGED);
  const closed = count.closed;
  // Writing the count for the first time: its condition is that nobody else
  // did, so a failure there can't be told apart from the last owner by the
  // cancellation reasons. The owner count read here answers that case.
  if (!closed && count.counted !== undefined && from === "owner" && count.owners <= 1) throw new LastOwnerError(LAST_OWNER);
  // Any other invite to this team for their address goes first, so someone
  // removed can't rejoin with an invite they hadn't used. If the removal then
  // fails (the last owner), only their own unused invites are gone.
  if (typeof email === "string" && email) await revokeInvitesForEmail(db, ctx, email, minimum);
  const audit = auditPut(db, ctx, { action: userId === ctx.userId ? "member.left" : "member.removed", target: userId, ...(options.reason ? { detail: { reason: options.reason } } : {}) }, now);
  await connection(db)
    .doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: db.tableName,
              Key: keys.member(ctx.teamId, userId),
              ConditionExpression: "#role = :from",
              ExpressionAttributeNames: { "#role": "role" },
              ExpressionAttributeValues: { ":from": from },
            },
          },
          { Delete: { TableName: db.tableName, Key: keys.userTeam(userId, ctx.teamId) } },
          teamCounts(db.tableName, ctx.teamId, { members: -1, counted: count.counted, closed, ...(from === "owner" ? { owners: -1 as const } : {}) }),
          audit,
          ...callerStillOwner(db, ctx, userId),
        ],
      }),
    )
    .catch(memberChangeFailed(from === "owner" && count.counted === undefined && !closed ? 2 : undefined));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A team name as typed to confirm closing it: trimmed, compatibility-normalized and case-folded. */
const confirmation = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("en-US");

/**
 * An owner closes the team. The caller types the team's name to confirm
 * (`confirmName`, compared ignoring case and surrounding spaces). In one
 * transaction, conditioned on the caller still being an owner: the META item
 * gets `closedAt`, `closedBy` and `purgeAfter` (CLOSED_TEAM_RETENTION_DAYS
 * later) and joins the closed-teams index the purge reads, and a `team.closed`
 * audit event is written. Then every invite to the team is deleted.
 *
 * From then on the team is read-only (writable refuses anything but leaving,
 * removing members and revoking invites), its members' live updates stop
 * (liveUpdateRecipients), nobody can join (teamCounts), and the purge
 * deletes all of it once `purgeAfter` passes (team-purge.ts). Members keep
 * read access meanwhile, so owners can export the data.
 *
 * With `onlyMember`, the closure is also conditioned on the team still having one
 * member (account deletion closing a team its caller is alone in).
 *
 * Idempotent: closing a closed team changes nothing and returns it as it is,
 * with `closedNow: false`, after deleting any invites still there (a retry
 * after the invites step failed part-way). The Stripe subscription isn't
 * cancelled here yet: billing (supply-checkout-x0l) does that from the
 * team's `closedAt`.
 */
export async function closeTeam(
  db: Db,
  ctx: TeamContext,
  input: { readonly confirmName: string; readonly onlyMember?: boolean },
  now = new Date(),
): Promise<{ team: Team; closedNow: boolean }> {
  writable(db, ctx, "owner", { whileClosed: true });
  if (typeof input.confirmName !== "string") throw new InvalidInputError(CONFIRM);
  const current = await getTeam(db, ctx);
  if (!current) throw new ConflictError(CHANGED);
  let closedNow = false;
  if (!isClosed(current)) {
    if (confirmation(input.confirmName) !== confirmation(current.name)) throw new InvalidInputError(CONFIRM);
    const closedAt = now.toISOString();
    const purgeAfter = new Date(now.getTime() + CLOSED_TEAM_RETENTION_DAYS * DAY_MS).toISOString();
    // With `onlyMember` (account deletion closing a team its caller is alone in): only
    // while the count still says one member, so someone who joined since the caller's
    // read keeps an open team (ConflictError). A team from before the count has none
    // to condition on.
    const alone = input.onlyMember === true && typeof current.members === "number";
    await connection(db)
      .doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: db.tableName,
                Key: keys.team(ctx.teamId),
                UpdateExpression: "SET closedAt = :at, closedBy = :by, purgeAfter = :purge, GSI1PK = :gpk, GSI1SK = :gsk, #version = #version + :one",
                ConditionExpression: `attribute_exists(PK) AND attribute_not_exists(closedAt)${alone ? " AND #members = :one" : ""}`,
                ExpressionAttributeNames: { "#version": "version", ...(alone ? { "#members": "members" } : {}) },
                ExpressionAttributeValues: {
                  ":at": closedAt,
                  ":by": ctx.userId,
                  ":purge": purgeAfter,
                  ":gpk": gsi1.closedTeam(purgeAfter, ctx.teamId).GSI1PK,
                  ":gsk": gsi1.closedTeam(purgeAfter, ctx.teamId).GSI1SK,
                  ":one": 1,
                },
              },
            },
            // The caller's own membership, as it is now: an owner demoted or
            // removed since the context was issued can't close the team
            {
              ConditionCheck: {
                TableName: db.tableName,
                Key: keys.member(ctx.teamId, ctx.userId),
                ConditionExpression: "#role = :owner",
                ExpressionAttributeNames: { "#role": "role" },
                ExpressionAttributeValues: { ":owner": "owner" },
              },
            },
            auditPut(db, ctx, { action: "team.closed" }, now),
          ],
        }),
      )
      .catch(conflictOnConditionFailure(CHANGED));
    closedNow = true;
  }
  // Nobody can accept these any more (teamCounts refuses a closed team), but
  // they hold addresses, so they go now rather than with the purge
  const invites = await queryAll<Invite>(db, teamPartition(ctx.teamId), prefixes.invite);
  for (const invite of invites) {
    await connection(db).doc.send(
      new DeleteCommand({
        TableName: db.tableName,
        Key: keys.invite(ctx.teamId, invite.inviteId),
        ConditionExpression: "attribute_not_exists(PK) OR #type = :invite",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: { ":invite": "invite" },
      }),
    );
  }
  return { team: closedNow ? ((await getTeam(db, ctx)) as Team) : current, closedNow };
}

const CONFIRM = "Type the team's name to close it";

const REOPEN_CONFIRM = "Type the team's name to reopen it";
const TOO_LATE = "This team is about to be deleted and can't be reopened any more";

/**
 * Reopens a closed team before the purge deletes it. The caller types the
 * team's name to confirm (`confirmName`, compared as closeTeam compares it).
 *
 * Owners reopen their own team: an owner who is still a member of it, re-checked
 * at write time as closeTeam does, so an owner removed or demoted since the
 * context was issued can't. A system context (operator support, bead 6uw.6)
 * may reopen any team it was issued for; its user ID goes in the audit event.
 *
 * In one transaction: the META item loses `closedAt`, `closedBy`,
 * `purgeAfter` and its closed-teams index keys (GSI1PK, GSI1SK), so the
 * purge no longer finds it, and its version moves; a `team.reopened` audit
 * event records when it was closed and by whom. The update is conditioned on
 * the team still having the closure that was read (same `closedAt` and
 * `purgeAfter`), on `purgeAfter` being more than REOPEN_CUTOFF_MINUTES away
 * (TeamDeletingError otherwise: the purge may already be deleting it), and on
 * the team having an owner.
 *
 * From then on the team is writable again (authorizeTeam reads `closedAt`)
 * and its members get live updates again (liveUpdateRecipients). Nothing
 * the closure undid comes back: its invites stay deleted, and anyone who
 * left or was removed while it was closed stays out, so owners invite people
 * again. The Stripe subscription isn't touched: closing doesn't cancel it yet
 * either (billing, supply-checkout-x0l, will need to resume it here).
 *
 * Idempotent: reopening a team that isn't closed changes nothing and returns
 * it as it is, with `reopenedNow: false`.
 */
export async function reopenTeam(
  db: Db,
  ctx: TeamContext,
  input: { readonly confirmName: string },
  now = new Date(),
): Promise<{ team: Team; reopenedNow: boolean }> {
  writable(db, ctx, "owner", { whileClosed: true });
  if (typeof input.confirmName !== "string") throw new InvalidInputError(REOPEN_CONFIRM);
  const current = await getTeam(db, ctx);
  if (!current) throw new ConflictError(CHANGED);
  if (!isClosed(current)) return { team: current, reopenedNow: false };
  if (confirmation(input.confirmName) !== confirmation(current.name)) throw new InvalidInputError(REOPEN_CONFIRM);
  const cutoff = new Date(now.getTime() + REOPEN_CUTOFF_MINUTES * 60_000).toISOString();
  if (typeof current.purgeAfter !== "string" || current.purgeAfter <= cutoff) throw new TeamDeletingError(TOO_LATE);
  await connection(db)
    .doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: db.tableName,
              Key: keys.team(ctx.teamId),
              UpdateExpression: "REMOVE closedAt, closedBy, purgeAfter, GSI1PK, GSI1SK SET #version = #version + :one",
              ConditionExpression: "closedAt = :at AND purgeAfter = :purge AND purgeAfter > :cutoff AND owners > :zero",
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: { ":at": current.closedAt, ":purge": current.purgeAfter, ":cutoff": cutoff, ":one": 1, ":zero": 0 },
            },
          },
          // The caller's own membership, as it is now (not for a system context)
          ...(ctx.role === "system"
            ? []
            : [
                {
                  ConditionCheck: {
                    TableName: db.tableName,
                    Key: keys.member(ctx.teamId, ctx.userId),
                    ConditionExpression: "#role = :owner",
                    ExpressionAttributeNames: { "#role": "role" },
                    ExpressionAttributeValues: { ":owner": "owner" },
                  },
                },
              ]),
          auditPut(db, ctx, { action: "team.reopened", detail: { closedAt: current.closedAt, ...(current.closedBy ? { closedBy: current.closedBy } : {}) } }, now),
        ],
      }),
    )
    .catch(conflictOnConditionFailure(CHANGED));
  return { team: (await getTeam(db, ctx)) as Team, reopenedNow: true };
}

/**
 * The verified user's teams, for the team switcher. This reads the user's own
 * partition, so it takes the user ID from the validated token, not a team context.
 */
export async function listTeamsForUser(db: Db, userId: string): Promise<UserTeam[]> {
  return queryAll<UserTeam>(db, keys.userTeam(userId, "x").PK, prefixes.userTeam);
}
