// Teams, members and each user's list of teams (ADR 0005, ADR 0007). Creating
// a team issues a context, so createTeam lives in team-context.ts.

import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, conflictOnConditionFailure } from "./errors.js";
import { id, keys, prefixes, strip, teamPartition } from "./keys.js";
import { type Member, type MemberRole, type Team, type UserTeam, memberRole, ownersUpdate, teamName } from "./model.js";
import { queryAll, versionedSet } from "./query.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export type { Invite, InviteFailure, Member, MemberRole, Team, UserTeam } from "./model.js";

const LAST_OWNER = "Someone else changed this team, or it would be left without an owner";

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

async function currentRole(db: Db, ctx: TeamContext, userId: string): Promise<MemberRole> {
  const { Item } = await connection(db).doc.send(
    new GetCommand({ TableName: db.tableName, Key: keys.member(ctx.teamId, id(userId, "user ID")), ConsistentRead: true }),
  );
  if (!Item) throw new ConflictError("Not a member of this team");
  return Item.role as MemberRole;
}

/**
 * Owners change members' roles, their own included. The MEMBER item, the
 * user's switcher row and the team's owner count change in one transaction,
 * conditioned on the role read here, so a team never loses its last owner.
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
          { Update: { TableName: db.tableName, Key: keys.userTeam(userId, ctx.teamId), ...set, ExpressionAttributeValues: { ":role": role } } },
          ...(from === "owner" ? [ownersUpdate(db.tableName, ctx.teamId, -1)] : []),
          ...(role === "owner" ? [ownersUpdate(db.tableName, ctx.teamId, 1)] : []),
          ...callerStillOwner(db, ctx, userId),
        ],
      }),
    )
    .catch(conflictOnConditionFailure(LAST_OWNER));
}

/**
 * Owners remove members; any member can remove themselves (leave). Removing an
 * owner decrements the owner count in the same transaction, conditioned on
 * another owner remaining.
 */
export async function removeMember(db: Db, ctx: TeamContext, userId: string): Promise<void> {
  writable(db, ctx, userId === ctx.userId ? "viewer" : "owner");
  const from = await currentRole(db, ctx, userId);
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
          ...(from === "owner" ? [ownersUpdate(db.tableName, ctx.teamId, -1)] : []),
          ...callerStillOwner(db, ctx, userId),
        ],
      }),
    )
    .catch(conflictOnConditionFailure(LAST_OWNER));
}

/**
 * The verified user's teams, for the team switcher. This reads the user's own
 * partition, so it takes the user ID from the validated token, not a team context.
 */
export async function listTeamsForUser(db: Db, userId: string): Promise<UserTeam[]> {
  return queryAll<UserTeam>(db, keys.userTeam(userId, "x").PK, prefixes.userTeam);
}
