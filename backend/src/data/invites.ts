// Invites (ADR 0005, ADR 0007). Only a SHA-256 hash of the token is stored;
// GSI1 finds the invite from the hash when someone opens the link.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DeleteCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Db } from "./client.js";
import { InvalidInputError, conflictOnConditionFailure } from "./errors.js";
import { gsi1, id, keys, prefixes, strip, teamPartition } from "./keys.js";
import { queryAll } from "./query.js";
import { GSI1 } from "./schema.js";
import { type TeamContext, authorizeTeam, readable, writable } from "./team-context.js";
import { type Member, type MemberRole, type UserTeam, memberRole } from "./teams.js";

export interface Invite {
  readonly type: "invite";
  readonly teamId: string;
  readonly teamName: string;
  readonly inviteId: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly invitedBy: string;
  readonly createdAt: string;
  /** Epoch seconds; DynamoDB's TTL removes the item after this. */
  readonly expiresAt: number;
}

const DAY = 24 * 60 * 60;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Owners invite people. Returns the invite and the one-time token for the link; the token isn't stored. */
export async function createInvite(
  db: Db,
  ctx: TeamContext,
  input: { readonly email: string; readonly role: MemberRole; readonly teamName: string; readonly ttlDays?: number },
): Promise<{ invite: Invite; token: string }> {
  writable(db, ctx, "owner");
  if (typeof input.email !== "string" || !/^[^\s@]+@[^\s@]+$/.test(input.email) || input.email.length > 254) {
    throw new InvalidInputError("Invalid email");
  }
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const invite: Invite = {
    type: "invite",
    teamId: ctx.teamId,
    teamName: input.teamName,
    inviteId: randomUUID(),
    email: input.email.toLowerCase(),
    role: memberRole(input.role),
    invitedBy: ctx.userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: Math.floor(now / 1000) + (input.ttlDays ?? 7) * DAY,
  };
  await db.doc.send(
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
  await db.doc.send(new DeleteCommand({ TableName: db.tableName, Key: keys.invite(ctx.teamId, inviteId) }));
}

/**
 * Finds a live invite from the token in the link. The person opening it isn't a
 * member yet, so this isn't team-scoped: the unguessable token is the proof.
 */
export async function findInvite(db: Db, token: string): Promise<Invite | undefined> {
  if (typeof token !== "string" || token.length < 16) return undefined;
  const { Items } = await db.doc.send(
    new QueryCommand({
      TableName: db.tableName,
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
      ExpressionAttributeValues: { ":pk": gsi1.inviteToken(hashInviteToken(token)).GSI1PK, ":sk": "INVITE" },
    }),
  );
  const invite = strip<Invite>(Items?.[0]);
  // TTL deletion can lag by days, so check expiry here too
  return invite && invite.expiresAt > Date.now() / 1000 ? invite : undefined;
}

/**
 * Accepts an invite for the verified user: deletes it and adds the membership
 * in one transaction, so a token works once. Returns the new member's context.
 */
export async function acceptInvite(
  db: Db,
  user: { readonly userId: string; readonly email?: string },
  token: string,
): Promise<TeamContext> {
  const userId = id(user.userId, "user ID");
  const invite = await findInvite(db, token);
  if (!invite) throw new InvalidInputError("This invite has expired or was already used");
  const member: Member = { type: "member", teamId: invite.teamId, userId, role: invite.role, email: user.email, joinedAt: new Date().toISOString() };
  const userTeam: UserTeam = { type: "userTeam", userId, teamId: invite.teamId, teamName: invite.teamName, role: invite.role };
  await db.doc
    .send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: db.tableName, Key: keys.invite(invite.teamId, invite.inviteId), ConditionExpression: "attribute_exists(PK)" } },
          { Put: { TableName: db.tableName, Item: { ...keys.member(invite.teamId, userId), ...member }, ConditionExpression: "attribute_not_exists(PK)" } },
          { Put: { TableName: db.tableName, Item: { ...keys.userTeam(userId, invite.teamId), ...userTeam } } },
        ],
      }),
    )
    .catch(conflictOnConditionFailure("This invite was already used, or you're already a member"));
  return authorizeTeam(db, userId, invite.teamId);
}
