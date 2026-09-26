// Teams, members and each user's list of teams (ADR 0005, ADR 0007).

import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Db } from "./client.js";
import { ForbiddenError, InvalidInputError, conflictOnConditionFailure } from "./errors.js";
import { id, keys, prefixes, strip, teamPartition } from "./keys.js";
import { queryAll, versionedSet } from "./query.js";
import { type Role, type TeamContext, issueContext, readable, writable } from "./team-context.js";

export type MemberRole = Exclude<Role, "system">;
const MEMBER_ROLES: readonly MemberRole[] = ["owner", "contributor", "viewer"];

export interface Team {
  readonly type: "team";
  readonly teamId: string;
  readonly name: string;
  readonly plan: string;
  readonly seats: number;
  /** Subscription status from Stripe (ADR 0009), e.g. trialing, active, past_due. */
  readonly status: string;
  /** Region the team was created in; its writes go there once there are two (ADR 0010). */
  readonly homeRegion: string;
  readonly stripeCustomerId?: string;
  readonly createdAt: string;
  readonly version: number;
}

export interface Member {
  readonly type: "member";
  readonly teamId: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly email?: string;
  readonly joinedAt: string;
}

/** A row in the team switcher: the reverse of a MEMBER item. */
export interface UserTeam {
  readonly type: "userTeam";
  readonly userId: string;
  readonly teamId: string;
  readonly teamName: string;
  readonly role: MemberRole;
}

export function memberRole(value: unknown): MemberRole {
  if (!MEMBER_ROLES.includes(value as MemberRole)) throw new InvalidInputError("Invalid role");
  return value as MemberRole;
}

function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new InvalidInputError("Invalid team name");
  return value.trim();
}

/**
 * Creates a team with the verified caller as its owner, and returns the owner's
 * context. The home region is the region this runs in (ADR 0010).
 */
export async function createTeam(
  db: Db,
  owner: { readonly userId: string; readonly email?: string },
  input: { readonly name: string; readonly plan?: string; readonly seats?: number },
): Promise<{ team: Team; context: TeamContext }> {
  const userId = id(owner.userId, "user ID");
  const now = new Date().toISOString();
  const team: Team = {
    type: "team",
    teamId: randomUUID(),
    name: name(input.name),
    plan: input.plan ?? "trial",
    seats: input.seats ?? 1,
    status: "trialing",
    homeRegion: db.region,
    createdAt: now,
    version: 1,
  };
  const member: Member = { type: "member", teamId: team.teamId, userId, role: "owner", email: owner.email, joinedAt: now };
  const userTeam: UserTeam = { type: "userTeam", userId, teamId: team.teamId, teamName: team.name, role: "owner" };
  await db.doc
    .send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: db.tableName, Item: { ...keys.team(team.teamId), ...team }, ConditionExpression: "attribute_not_exists(PK)" } },
          { Put: { TableName: db.tableName, Item: { ...keys.member(team.teamId, userId), ...member } } },
          { Put: { TableName: db.tableName, Item: { ...keys.userTeam(userId, team.teamId), ...userTeam } } },
        ],
      }),
    )
    .catch(conflictOnConditionFailure("Team already exists"));
  return { team, context: issueContext(team.teamId, userId, "owner", team.homeRegion) };
}

export async function getTeam(db: Db, ctx: TeamContext): Promise<Team> {
  readable(ctx);
  const { Item } = await db.doc.send(new GetCommand({ TableName: db.tableName, Key: keys.team(ctx.teamId), ConsistentRead: true }));
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
  if (changes.name !== undefined) fields.name = name(changes.name);
  if (changes.plan !== undefined) fields.plan = changes.plan;
  if (changes.seats !== undefined) fields.seats = changes.seats;
  if (changes.status !== undefined) fields.status = changes.status;
  const { Attributes } = await db.doc
    .send(new UpdateCommand({ TableName: db.tableName, Key: keys.team(ctx.teamId), ...versionedSet(fields, expectedVersion), ReturnValues: "ALL_NEW" }))
    .catch(conflictOnConditionFailure("The team changed; reload and try again"));
  return strip<Team>(Attributes) as Team;
}

export async function listMembers(db: Db, ctx: TeamContext): Promise<Member[]> {
  readable(ctx);
  return queryAll<Member>(db, teamPartition(ctx.teamId), prefixes.member);
}

export async function getMember(db: Db, ctx: TeamContext, userId: string): Promise<Member | undefined> {
  readable(ctx);
  const { Item } = await db.doc.send(new GetCommand({ TableName: db.tableName, Key: keys.member(ctx.teamId, userId), ConsistentRead: true }));
  return strip<Member>(Item);
}

/** Owners change other members' roles. Both the MEMBER item and the user's switcher row change together. */
export async function setMemberRole(db: Db, ctx: TeamContext, userId: string, role: MemberRole): Promise<void> {
  writable(db, ctx, "owner");
  memberRole(role);
  if (userId === ctx.userId) throw new ForbiddenError("Owners can't change their own role");
  const update = {
    UpdateExpression: "SET #role = :role",
    ConditionExpression: "attribute_exists(PK)",
    ExpressionAttributeNames: { "#role": "role" },
    ExpressionAttributeValues: { ":role": role },
  };
  await db.doc
    .send(
      new TransactWriteCommand({
        TransactItems: [
          { Update: { TableName: db.tableName, Key: keys.member(ctx.teamId, userId), ...update } },
          { Update: { TableName: db.tableName, Key: keys.userTeam(userId, ctx.teamId), ...update } },
        ],
      }),
    )
    .catch(conflictOnConditionFailure("Not a member of this team"));
}

/** Owners remove members; any member can remove themselves (leave). */
export async function removeMember(db: Db, ctx: TeamContext, userId: string): Promise<void> {
  writable(db, ctx, userId === ctx.userId ? "viewer" : "owner");
  await db.doc
    .send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: db.tableName, Key: keys.member(ctx.teamId, userId), ConditionExpression: "attribute_exists(PK)" } },
          { Delete: { TableName: db.tableName, Key: keys.userTeam(userId, ctx.teamId) } },
        ],
      }),
    )
    .catch(conflictOnConditionFailure("Not a member of this team"));
}

/**
 * The verified user's teams, for the team switcher. This reads the user's own
 * partition, so it takes the user ID from the validated token, not a team context.
 */
export async function listTeamsForUser(db: Db, userId: string): Promise<UserTeam[]> {
  return queryAll<UserTeam>(db, keys.userTeam(userId, "x").PK, prefixes.userTeam);
}
