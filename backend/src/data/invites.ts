// Invites (ADR 0005, ADR 0007). Only a SHA-256 hash of the token is stored;
// GSI1 finds the invite from the hash when someone opens the link. GSI2 finds
// the invites for a verified email address, for the "pending invites" list at
// first sign-in. Accepting an invite issues a context, so findInvite and
// acceptInvite live in team-context.ts.

import { randomBytes, randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, InvalidInputError, LimitReachedError, NotFoundError, TeamFullError, conflictOnConditionFailure } from "./errors.js";
import { gsi1, gsi2, id, inviteePartition, keys, prefixes, strip, teamPartition } from "./keys.js";
import {
  type Invite,
  type InviteFailure,
  type Member,
  type MemberRole,
  INVITES_PER_ADDRESS_PER_DAY,
  INVITES_PER_TEAM_ADDRESS_PER_DAY,
  INVITES_PER_TEAM_PER_DAY,
  hashEmail,
  inviteLimitKey,
  mailAddress,
  hashInviteToken,
  memberRole,
  normalizeEmail,
} from "./model.js";
import { memberCount } from "./member-count.js";
import { queryAll } from "./query.js";
import { GSI2 } from "./schema.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export { hashEmail, hashInviteToken } from "./model.js";
export { INVITES_PER_ADDRESS_PER_DAY, INVITES_PER_TEAM_ADDRESS_PER_DAY, INVITES_PER_TEAM_PER_DAY, inviteLimitKey, mailAddress } from "./model.js";

const DAY = 24 * 60 * 60;
export const INVITE_TTL_DAYS = { min: 1, max: 30, default: 7 } as const;

const TOO_MANY_INVITES = "You've sent as many invites as you can for now. Try again tomorrow.";

function ttl(value: number | undefined): number {
  const ttlDays = value ?? INVITE_TTL_DAYS.default;
  if (!Number.isInteger(ttlDays) || ttlDays < INVITE_TTL_DAYS.min || ttlDays > INVITE_TTL_DAYS.max) {
    throw new InvalidInputError(`Invites last ${INVITE_TTL_DAYS.min} to ${INVITE_TTL_DAYS.max} days`);
  }
  return ttlDays;
}

/** One of the day's invite counters, moved by one in the invite's transaction, and refused at `max`. */
function countOne(tableName: string, key: { PK: string; SK: string }, max: number, epoch: number) {
  return {
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: "ADD #count :one SET #type = :type, expiresAt = :expires",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
      ExpressionAttributeNames: { "#count": "count", "#type": "type" },
      ExpressionAttributeValues: { ":one": 1, ":max": max, ":type": "inviteLimit", ":expires": epoch + 2 * DAY },
    },
  };
}

/** The per-cancellation-reason codes of a failed transaction, or undefined. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
}

/**
 * Writes a new invite, with a new ID and a new token, in one transaction with
 * the team's and the address's invite counters for the day (and `before`, a
 * write that must happen with it: re-sending deletes the old invite).
 */
async function writeInvite(
  db: Db,
  ctx: TeamContext,
  input: { readonly email: string; readonly role: MemberRole; readonly ttlDays: number },
  now: Date,
  before: Record<string, unknown>[] = [],
): Promise<{ invite: Invite; token: string }> {
  const { doc } = connection(db);
  const { Item: team } = await doc.send(
    new GetCommand({ TableName: db.tableName, Key: keys.team(ctx.teamId), ConsistentRead: true, ProjectionExpression: "#name", ExpressionAttributeNames: { "#name": "name" } }),
  );
  if (!team) throw new ConflictError("This team no longer exists");
  const token = randomBytes(32).toString("base64url");
  const epoch = Math.floor(now.getTime() / 1000);
  const day = now.toISOString().slice(0, 10);
  const invite: Invite = {
    type: "invite",
    teamId: ctx.teamId,
    teamName: team.name as string,
    inviteId: randomUUID(),
    email: input.email,
    role: input.role,
    invitedBy: ctx.userId,
    createdAt: now.toISOString(),
    expiresAt: epoch + input.ttlDays * DAY,
  };
  const emailHash = hashEmail(input.email);
  const limitKey = inviteLimitKey(input.email);
  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          ...before,
          {
            Put: {
              TableName: db.tableName,
              Item: { ...keys.invite(ctx.teamId, invite.inviteId), ...gsi1.inviteToken(hashInviteToken(token)), ...gsi2.invitee(emailHash, invite.inviteId), ...invite },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          countOne(db.tableName, keys.invitesSent(ctx.teamId, day), INVITES_PER_TEAM_PER_DAY, epoch),
          countOne(db.tableName, keys.invitesToAddress(limitKey, day), INVITES_PER_ADDRESS_PER_DAY, epoch),
          countOne(db.tableName, keys.invitesFromTeamToAddress(ctx.teamId, limitKey, day), INVITES_PER_TEAM_ADDRESS_PER_DAY, epoch),
        ],
      }),
    );
  } catch (error) {
    const codes = cancellationCodes(error);
    const at = before.length;
    // Either counter at its limit. One message for both, so an owner can't
    // learn how many invites another team sent the address.
    if (codes && [1, 2, 3].some((i) => codes[at + i] === "ConditionalCheckFailed")) throw new LimitReachedError(TOO_MANY_INVITES);
    if (codes && at > 0 && codes[0] === "ConditionalCheckFailed") throw new NotFoundError("This invite was accepted or revoked just now");
    return conflictOnConditionFailure("Someone else changed this team's invites just now; try again")(error);
  }
  return { invite, token };
}

/** An invite item as stored, or undefined for no invite. */
async function storedInvite(db: Db, ctx: TeamContext, inviteId: string): Promise<(Invite & { GSI1PK: string }) | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.invite(ctx.teamId, id(inviteId, "invite ID")), ConsistentRead: true }));
  return Item?.type === "invite" ? (Item as Invite & { GSI1PK: string }) : undefined;
}

/**
 * Owners invite people. Returns the invite and the one-time token for the
 * link; the token isn't stored. The team name on the invite comes from the
 * team item, never from the caller.
 *
 * Refused (ConflictError) when the address is already a member's, or already
 * has a live invite to this team (re-send that one instead). Each invite
 * counts against the team's, the address's and the team's-for-that-address
 * limits for the UTC day (INVITES_PER_TEAM_PER_DAY, INVITES_PER_ADDRESS_PER_DAY,
 * INVITES_PER_TEAM_ADDRESS_PER_DAY; LimitReachedError). The address must be a
 * bare addr-spec (mailAddress), and the limits count it by inviteLimitKey.
 *
 * Refused (TeamFullError) when the team's members and live invites already
 * fill its memberCap, so owners don't send invites that can't be accepted.
 * That check reads before it writes; acceptInvite is what enforces the cap.
 */
export async function createInvite(
  db: Db,
  ctx: TeamContext,
  input: { readonly email: string; readonly role: MemberRole; readonly ttlDays?: number },
  now = new Date(),
): Promise<{ invite: Invite; token: string }> {
  writable(db, ctx, "owner");
  const email = mailAddress(input.email);
  const ttlDays = ttl(input.ttlDays);
  const role = memberRole(input.role);
  const [members, invites, count] = await Promise.all([
    queryAll<Member>(db, teamPartition(ctx.teamId), prefixes.member),
    queryAll<Invite>(db, teamPartition(ctx.teamId), prefixes.invite),
    memberCount(db, ctx.teamId, now),
  ]);
  if (!count) throw new ConflictError("This team no longer exists");
  if (members.some((m) => m.email === email)) throw new ConflictError("They're already a member of this team");
  const pending = invites.filter((i) => live(i, now));
  if (pending.some((i) => i.email === email)) throw new ConflictError("They already have an invite to this team. Resend it instead.");
  if (members.length + pending.length >= count.cap) {
    throw new TeamFullError(`This team can have ${count.cap} members, counting pending invites. Remove someone or revoke an invite first.`);
  }
  return writeInvite(db, ctx, { email, role, ttlDays }, now);
}

/**
 * Owners re-send an invite: a new invite with a new ID and a new token (so
 * the old link stops working), the same address and role, a fresh expiry and
 * no failure. The old one is deleted in the same transaction, which also
 * counts against the day's limits. A late bounce report for the old message
 * names the old ID, so it can't mark the new invite failed. Works for an
 * expired or failed invite; NotFoundError if it was accepted or revoked.
 */
export async function resendInvite(db: Db, ctx: TeamContext, inviteId: string, input: { readonly ttlDays?: number } = {}, now = new Date()): Promise<{ invite: Invite; token: string }> {
  writable(db, ctx, "owner");
  const ttlDays = ttl(input.ttlDays);
  const old = await storedInvite(db, ctx, inviteId);
  if (!old) throw new NotFoundError("This invite was accepted or revoked");
  const remove = {
    Delete: {
      TableName: db.tableName,
      Key: keys.invite(ctx.teamId, old.inviteId),
      // The invite read above, unchanged: not accepted or re-sent meanwhile
      ConditionExpression: "attribute_exists(PK) AND GSI1PK = :token",
      ExpressionAttributeValues: { ":token": old.GSI1PK },
    },
  };
  return writeInvite(db, ctx, { email: mailAddress(old.email), role: memberRole(old.role), ttlDays }, now, [remove]);
}

/**
 * Marks an invite failed because SES wouldn't send its email (the mailer's
 * EmailNotSentError), so the owner sees "Couldn't deliver" and can re-send or
 * correct the address. Owners only: it's the request that created or re-sent
 * the invite. Returns false when the invite is gone.
 */
export async function markInviteNotSent(db: Db, ctx: TeamContext, inviteId: string, at = new Date()): Promise<boolean> {
  writable(db, ctx, "owner");
  try {
    await connection(db).doc.send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.invite(ctx.teamId, inviteId),
        UpdateExpression: "SET inviteStatus = :failed, failureReason = :reason, failedAt = :at",
        ConditionExpression: "attribute_exists(PK) AND #type = :invite",
        ExpressionAttributeNames: { "#type": "type" },
        ExpressionAttributeValues: { ":failed": "failed", ":reason": "not_sent", ":at": at.toISOString(), ":invite": "invite" },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** One of the team's invites by ID, live or not, or undefined. */
export async function getInvite(db: Db, ctx: TeamContext, inviteId: string): Promise<Invite | undefined> {
  readable(ctx);
  return strip<Invite>((await storedInvite(db, ctx, inviteId)) as Record<string, unknown> | undefined);
}

export async function listInvites(db: Db, ctx: TeamContext): Promise<Invite[]> {
  readable(ctx);
  return queryAll<Invite>(db, teamPartition(ctx.teamId), prefixes.invite);
}

// Only what SES reports: `not_sent` is the owner's request's own (markInviteNotSent)
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
        // inviteStatus, not status: a team's META item has a status (its
        // subscription), and this role's policy pins the partition, not the item
        UpdateExpression: "SET inviteStatus = :failed, failureReason = :reason, failedAt = :at",
        // Only invites have GSI2 keys, and this one must be for the address that bounced
        ConditionExpression: "attribute_exists(PK) AND GSI2PK = :invitee",
        ExpressionAttributeValues: { ":failed": "failed", ":reason": input.reason, ":at": input.at.toISOString(), ":invitee": GSI2PK },
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/** Owners revoke an invite: its link stops working. Revoking one that's gone (accepted, revoked or removed by TTL) is harmless. */
export async function revokeInvite(db: Db, ctx: TeamContext, inviteId: string): Promise<void> {
  writable(db, ctx, "owner");
  await connection(db).doc.send(
    new DeleteCommand({
      TableName: db.tableName,
      Key: keys.invite(ctx.teamId, inviteId),
      // Only an invite: the key builder already keeps the ID to one sort key
      ConditionExpression: "attribute_not_exists(PK) OR #type = :invite",
      ExpressionAttributeNames: { "#type": "type" },
      ExpressionAttributeValues: { ":invite": "invite" },
    }),
  );
}

/**
 * Deletes every invite to this team for `email`, however many there are.
 * removeMember calls it, so a removed member can't rejoin with another
 * invite they hadn't used. Needs the same role as the removal.
 */
export async function revokeInvitesForEmail(db: Db, ctx: TeamContext, email: string, minimum: "viewer" | "owner"): Promise<number> {
  writable(db, ctx, minimum);
  const address = normalizeEmail(email);
  const invites = (await queryAll<Invite>(db, teamPartition(ctx.teamId), prefixes.invite)).filter((i) => i.email === address);
  for (const invite of invites) {
    await connection(db).doc.send(
      new DeleteCommand({
        TableName: db.tableName,
        Key: keys.invite(ctx.teamId, invite.inviteId),
        ConditionExpression: "attribute_not_exists(PK) OR email = :email",
        ExpressionAttributeValues: { ":email": address },
      }),
    );
  }
  return invites.length;
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
