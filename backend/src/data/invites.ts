// Invites (ADR 0005, ADR 0007). Only a SHA-256 hash of the token is stored;
// GSI1 finds the invite from the hash when someone opens the link. GSI2 finds
// the invites for a verified email address, for the "pending invites" list at
// first sign-in. Accepting an invite issues a context, so findInvite and
// acceptInvite live in team-context.ts.

import { randomBytes, randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, InvalidInputError } from "./errors.js";
import { gsi1, gsi2, id, inviteePartition, keys, prefixes, strip, teamPartition } from "./keys.js";
import { type Invite, type InviteFailure, type MemberRole, hashEmail, hashInviteToken, memberRole, normalizeEmail } from "./model.js";
import { queryAll } from "./query.js";
import { GSI2 } from "./schema.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export { hashEmail, hashInviteToken } from "./model.js";

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
  const email = normalizeEmail(input.email);
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
    email,
    role,
    invitedBy: ctx.userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: Math.floor(now / 1000) + ttlDays * DAY,
  };
  await doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: { ...keys.invite(ctx.teamId, invite.inviteId), ...gsi1.inviteToken(hashInviteToken(token)), ...gsi2.invitee(hashEmail(email), invite.inviteId), ...invite },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return { invite, token };
}

export async function listInvites(db: Db, ctx: TeamContext): Promise<Invite[]> {
  readable(ctx);
  return queryAll<Invite>(db, teamPartition(ctx.teamId), prefixes.invite);
}

const FAILURES: readonly InviteFailure[] = ["bounced", "complained"];

/**
 * Marks an invite failed after SES reported that its email bounced or drew a
 * complaint, so the owner sees it and can correct the address. Only a system
 * context may (teamContextForEmailEvent). `emailHash` is hashEmail() of the
 * address that bounced: the invite must be for that address, so a stale or
 * wrong tag can't mark another invite. Returns false when there's no such
 * invite (already accepted, revoked or expired and removed). Marking again is
 * harmless: the latest report wins.
 */
export async function markInviteFailed(
  db: Db,
  ctx: TeamContext,
  input: { readonly inviteId: string; readonly emailHash: string; readonly reason: InviteFailure; readonly at: Date },
): Promise<boolean> {
  writable(db, ctx, "system");
  if (!FAILURES.includes(input.reason)) throw new InvalidInputError("Invalid failure reason");
  const { GSI2PK } = gsi2.invitee(input.emailHash, input.inviteId);
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.invite(ctx.teamId, input.inviteId),
        UpdateExpression: "SET #status = :failed, failureReason = :reason, failedAt = :at",
        ConditionExpression: "attribute_exists(PK) AND #type = :invite AND GSI2PK = :invitee",
        ExpressionAttributeNames: { "#status": "status", "#type": "type" },
        ExpressionAttributeValues: { ":failed": "failed", ":reason": input.reason, ":at": input.at.toISOString(), ":invite": "invite", ":invitee": GSI2PK },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

export async function revokeInvite(db: Db, ctx: TeamContext, inviteId: string): Promise<void> {
  writable(db, ctx, "owner");
  await connection(db).doc.send(new DeleteCommand({ TableName: db.tableName, Key: keys.invite(ctx.teamId, inviteId) }));
}

/** An unexpired invite item. (Only invites carry GSI2 keys, and documents can't set them; the type check is belt and braces.) */
const live = (invite: Invite | undefined, now: Date): invite is Invite =>
  invite !== undefined && invite.type === "invite" && typeof invite.expiresAt === "number" && invite.expiresAt > now.getTime() / 1000;

/**
 * The live invites for an email address, across teams, for the signed-in
 * user's first-sign-in screen. Pass only an email the identity provider has
 * verified: the address is what entitles the caller to these invites.
 * Reads GSI2, so an invite made a moment ago may not show yet.
 */
export async function listInvitesForEmail(db: Db, verifiedEmail: string, now = new Date()): Promise<Invite[]> {
  const pk = inviteePartition(hashEmail(verifiedEmail));
  const out: Invite[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await connection(db).doc.send(
      new QueryCommand({ TableName: db.tableName, IndexName: GSI2, KeyConditionExpression: "GSI2PK = :pk", ExpressionAttributeValues: { ":pk": pk }, ExclusiveStartKey }),
    );
    for (const item of page.Items ?? []) out.push(strip<Invite>(item) as Invite);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  // TTL deletion can lag by days, so check expiry here too
  return out.filter((invite) => live(invite, now) && invite.email === normalizeEmail(verifiedEmail));
}

/** One live invite for a verified email address, by its ID, or undefined. */
export async function findInviteForEmail(db: Db, verifiedEmail: string, inviteId: string, now = new Date()): Promise<Invite | undefined> {
  const { GSI2PK, GSI2SK } = gsi2.invitee(hashEmail(verifiedEmail), id(inviteId, "invite ID"));
  const { Items } = await connection(db).doc.send(
    new QueryCommand({
      TableName: db.tableName,
      IndexName: GSI2,
      KeyConditionExpression: "GSI2PK = :pk AND GSI2SK = :sk",
      ExpressionAttributeValues: { ":pk": GSI2PK, ":sk": GSI2SK },
    }),
  );
  const invite = strip<Invite>(Items?.[0]);
  return live(invite, now) && invite.email === normalizeEmail(verifiedEmail) ? invite : undefined;
}
