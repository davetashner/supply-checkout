// Invites (ADR 0005, ADR 0007). Only a SHA-256 hash of the token is stored;
// GSI1 finds the invite from the hash when someone opens the link. Accepting
// an invite issues a context, so findInvite and acceptInvite live in
// team-context.ts.

import { randomBytes, randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, InvalidInputError } from "./errors.js";
import { gsi1, keys, prefixes, teamPartition } from "./keys.js";
import { type Invite, type MemberRole, hashInviteToken, memberRole } from "./model.js";
import { queryAll } from "./query.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export { hashInviteToken } from "./model.js";

const DAY = 24 * 60 * 60;
export const INVITE_TTL_DAYS = { min: 1, max: 30, default: 7 } as const;

/**
 * Owners invite people. Returns the invite and the one-time token for the
 * link; the token isn't stored. The team name on the invite comes from the
 * team item, never from the caller.
 */
export async function createInvite(
  db: Db,
  ctx: TeamContext,
  input: { readonly email: string; readonly role: MemberRole; readonly ttlDays?: number },
): Promise<{ invite: Invite; token: string }> {
  writable(db, ctx, "owner");
  if (typeof input.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(input.email) || input.email.length > 254) {
    throw new InvalidInputError("Invalid email");
  }
  const ttlDays = input.ttlDays ?? INVITE_TTL_DAYS.default;
  if (!Number.isInteger(ttlDays) || ttlDays < INVITE_TTL_DAYS.min || ttlDays > INVITE_TTL_DAYS.max) {
    throw new InvalidInputError(`Invites last ${INVITE_TTL_DAYS.min} to ${INVITE_TTL_DAYS.max} days`);
  }
  const role = memberRole(input.role);
  const { doc } = connection(db);
  const { Item: team } = await doc.send(
    new GetCommand({ TableName: db.tableName, Key: keys.team(ctx.teamId), ConsistentRead: true, ProjectionExpression: "#name", ExpressionAttributeNames: { "#name": "name" } }),
  );
  if (!team) throw new ConflictError("This team no longer exists");
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const invite: Invite = {
    type: "invite",
    teamId: ctx.teamId,
    teamName: team.name as string,
    inviteId: randomUUID(),
    email: input.email.toLowerCase(),
    role,
    invitedBy: ctx.userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: Math.floor(now / 1000) + ttlDays * DAY,
  };
  await doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: { ...keys.invite(ctx.teamId, invite.inviteId), ...gsi1.inviteToken(hashInviteToken(token)), ...invite },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return { invite, token };
}

export async function listInvites(db: Db, ctx: TeamContext): Promise<Invite[]> {
  readable(ctx);
  return queryAll<Invite>(db, teamPartition(ctx.teamId), prefixes.invite);
}

export async function revokeInvite(db: Db, ctx: TeamContext, inviteId: string): Promise<void> {
  writable(db, ctx, "owner");
  await connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: keys.invite(ctx.teamId, inviteId) }));
}
