// Teams, members and each user's list of teams (ADR 0005, ADR 0007). Creating
// a team issues a context, so createTeam lives in team-context.ts.

import { DeleteCommand, GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { auditPut } from "./audit.js";
import { type Db, connection } from "./client.js";
import { ConflictError, ForbiddenError, InvalidInputError, LastOwnerError, LimitReachedError, TeamDeletingError, conflictOnConditionFailure } from "./errors.js";
import { gsi1, gsi3, id, keys, prefixes, strip, teamPartition } from "./keys.js";
import {
  type Invite,
  type Member,
  type MemberRole,
  type Team,
  type UserTeam,
  CLOSED_TEAM_RETENTION_DAYS,
  REOPEN_CUTOFF_MINUTES,
  REOPENS_PER_TEAM_PER_DAY,
  isClosed,
  memberRole,
  normalizeEmail,
  ownersUpdate,
  teamCounts,
  teamName,
} from "./model.js";
import { memberCount } from "./member-count.js";
import { revokeInvitesForEmail } from "./invites.js";
import { queryAll, versionedSet } from "./query.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export type { Invite, InviteFailure, Member, MemberRole, Team, UserTeam } from "./model.js";
export { CLOSED_TEAM_RETENTION_DAYS, REOPEN_CUTOFF_MINUTES, REOPENS_PER_TEAM_PER_DAY, isClosed } from "./model.js";

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
 * Sets the email on the caller's own MEMBER item to `verifiedEmail`, when it
 * differs (or there's none), so the members list and owner notices use the
 * address the caller has verified now, not the one they had when they joined
 * (supply-checkout-xv3k). Pass only an address the identity provider has
 * verified for this user. Always the context's own user: a context names one
 * member, and nothing here takes another's ID. Any member may, whatever their
 * role; a closed team is left as it is (TeamClosedError), since nothing about
 * it changes any more. True when it wrote, false when the item already had
 * this address or is gone (the caller left meanwhile: nothing is recreated).
 */
export async function setOwnMemberEmail(db: Db, ctx: TeamContext, verifiedEmail: string): Promise<boolean> {
  writable(db, ctx, "viewer");
  const email = normalizeEmail(verifiedEmail);
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.member(ctx.teamId, ctx.userId),
        UpdateExpression: "SET email = :email",
        // AND binds tighter than OR: the item exists, and has no email or another one
        ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(email) OR attribute_exists(PK) AND email <> :email",
        ExpressionAttributeValues: { ":email": email },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
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
  const owner = gsi3.owner(ctx.teamId, userId);
  await connection(db)
    .doc.send(
      new TransactWriteCommand({
        TransactItems: [
          // The MEMBER item, in or out of the operators' index of owners (ADR 0015)
          role === "owner"
            ? {
                Update: {
                  TableName: db.tableName,
                  Key: keys.member(ctx.teamId, userId),
                  UpdateExpression: "SET #role = :role, GSI3PK = :gpk, GSI3SK = :gsk",
                  ExpressionAttributeNames: { "#role": "role" },
                  ConditionExpression: "#role = :from",
                  ExpressionAttributeValues: { ":role": role, ":from": from, ":gpk": owner.GSI3PK, ":gsk": owner.GSI3SK },
                },
              }
            : {
                Update: {
                  TableName: db.tableName,
                  Key: keys.member(ctx.teamId, userId),
                  UpdateExpression: "SET #role = :role REMOVE GSI3PK, GSI3SK",
                  ExpressionAttributeNames: { "#role": "role" },
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
 * (LastOwnerError). Their pending invites to the team are revoked first: for
 * the address on their member item and, when they leave, for `verifiedEmail`,
 * the address their identity provider has verified for them now. The
 * removal is audited in the same transaction (`member.left` or
 * `member.removed`, with `reason` when given).
 *
 * A closed team still lets people leave and owners remove them, and its last
 * owner may leave too: nothing about a closed team can change any more, and
 * the purge deletes it.
 */
export async function removeMember(
  db: Db,
  ctx: TeamContext,
  userId: string,
  options: { readonly reason?: "account_deleted"; readonly verifiedEmail?: string } = {},
  now = new Date(),
): Promise<void> {
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
  // Leaving, the caller's current verified address too (`verifiedEmail`), in
  // case the member item has none or an older one (supply-checkout-u0vv)
  const addresses = new Set<string>();
  if (typeof email === "string" && email) addresses.add(normalizeEmail(email));
  if (userId === ctx.userId && options.verifiedEmail) addresses.add(normalizeEmail(options.verifiedEmail));
  for (const address of addresses) await revokeInvitesForEmail(db, ctx, address, minimum);
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
const TOO_OFTEN = `A team can be reopened ${REOPENS_PER_TEAM_PER_DAY} times a day. Try again tomorrow.`;

/**
 * Reopens a closed team before the purge deletes it. The caller types the
 * team's name to confirm (`confirmName`, compared as closeTeam compares it).
 *
 * Only owners reopen a team: an owner who is still a member of it, re-checked
 * at write time as closeTeam does, so an owner removed or demoted since the
 * context was issued can't. System contexts (billing, email events) are
 * refused (ForbiddenError). Operator reopen (bead 6uw.6) will need its own
 * path: operators never get a TeamContext (ADR 0015).
 *
 * A team can be reopened REOPENS_PER_TEAM_PER_DAY times a UTC day
 * (LimitReachedError after that): each reopening and the closure after it
 * email every owner, so this caps those emails without silencing a closure.
 *
 * In one transaction: the META item loses `closedAt`, `closedBy`,
 * `purgeAfter` and its closed-teams index keys (GSI1PK, GSI1SK), so the
 * purge no longer finds it, and its version moves; a `team.reopened` audit
 * event records when it was closed and by whom, and the day's reopen counter
 * moves. The update is conditioned on
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
  // Owners only: writable lets system contexts (billing, email events) through
  if (ctx.role !== "owner") throw new ForbiddenError("Only the team's owners can reopen it");
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
          // The caller's own membership, as it is now
          {
            ConditionCheck: {
              TableName: db.tableName,
              Key: keys.member(ctx.teamId, ctx.userId),
              ConditionExpression: "#role = :owner",
              ExpressionAttributeNames: { "#role": "role" },
              ExpressionAttributeValues: { ":owner": "owner" },
            },
          },
          auditPut(db, ctx, { action: "team.reopened", detail: { closedAt: current.closedAt, ...(current.closedBy ? { closedBy: current.closedBy } : {}) } }, now),
          // The day's reopen counter, refused at the limit
          {
            Update: {
              TableName: db.tableName,
              Key: keys.reopens(ctx.teamId, now.toISOString().slice(0, 10)),
              UpdateExpression: "ADD #count :one SET #type = :type, expiresAt = :expires",
              ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
              ExpressionAttributeNames: { "#count": "count", "#type": "type" },
              ExpressionAttributeValues: { ":one": 1, ":max": REOPENS_PER_TEAM_PER_DAY, ":type": "reopenLimit", ":expires": Math.floor(now.getTime() / 1000) + 2 * 24 * 60 * 60 },
            },
          },
        ],
      }),
    )
    .catch((error: unknown) => {
      const reasons = (error as { name?: string; CancellationReasons?: { Code?: string }[] } | null)?.name === "TransactionCanceledException" ? ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []) : [];
      // Only the counter refused it: every other condition held
      if (reasons[3]?.Code === "ConditionalCheckFailed" && reasons.slice(0, 3).every((r) => r.Code === "None")) throw new LimitReachedError(TOO_OFTEN);
      return conflictOnConditionFailure(CHANGED)(error);
    });
  return { team: (await getTeam(db, ctx)) as Team, reopenedNow: true };
}

/**
 * The verified user's teams, for the team switcher. This reads the user's own
 * partition, so it takes the user ID from the validated token, not a team context.
 */
export async function listTeamsForUser(db: Db, userId: string): Promise<UserTeam[]> {
  return queryAll<UserTeam>(db, keys.userTeam(userId, "x").PK, prefixes.userTeam);
}
