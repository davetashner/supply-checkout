// TeamContext: the only way to read or write a team's data (ADR 0005).
//
// The server builds it from the caller's verified identity and their MEMBER
// item; the client never supplies the team or the role. Every function that
// issues a context lives in this file, and the issuer is private to it: the
// constructor needs a symbol that isn't exported, and every data function
// checks that the context it gets is one this file issued.
//
// Issuers: authorizeTeam (the API authorizer), createTeam (the new owner),
// acceptInvite (the new member), teamContextForStripeCustomer (webhooks) and
// teamContextForEmailEvent (bounces and complaints).

import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactGetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, ForbiddenError, LimitReachedError, NotFoundError, TeamClosedError, TeamFullError, conflictOnConditionFailure } from "./errors.js";
import { gsi1, gsi3, id, keys, prefixes, strip } from "./keys.js";
import {
  type Invite,
  type Member,
  type Role,
  type Team,
  type UserTeam,
  MAX_TEAMS_PER_USER,
  TEAMS_PER_USER_PER_DAY,
  TRIAL_DAYS,
  hashInviteToken,
  isClosed,
  isMemberRole,
  normalizeEmail,
  teamCounts,
  teamIdForRequest,
  teamName,
} from "./model.js";
import { memberCount } from "./member-count.js";
import { queryAll } from "./query.js";
import { writeRegionFor } from "./region.js";
import { GSI1 } from "./schema.js";

export type { Role } from "./model.js";

const RANK: Record<Role, number> = { viewer: 0, contributor: 1, owner: 2, system: 3 };

const ISSUE = Symbol("issue TeamContext");
const issued = new WeakSet<object>();

export class TeamContext {
  readonly teamId: string;
  /** The verified caller, or `system:<process>` for server processes. */
  readonly userId: string;
  readonly role: Role;
  /** The team's home region (ADR 0010), from its META item. */
  readonly homeRegion: string;
  /**
   * The team was closed (closeTeam) when the context was issued: members may
   * read it and leave, and nothing else (writable). Always false for system
   * contexts, which writable doesn't hold to it.
   */
  readonly closed: boolean;

  constructor(token: symbol, teamId: string, userId: string, role: Role, homeRegion: string, closed = false) {
    if (token !== ISSUE) throw new ForbiddenError("TeamContext can only be issued by the data layer");
    this.teamId = teamId;
    this.userId = userId;
    this.role = role;
    this.homeRegion = homeRegion;
    this.closed = closed;
    Object.freeze(this);
    issued.add(this);
  }
}

// Not exported: only the issuers below can call it.
function issue(teamId: string, userId: string, role: Role, homeRegion: string, closed = false): TeamContext {
  return new TeamContext(ISSUE, teamId, userId, role, homeRegion, closed);
}

/** Throws unless `ctx` was issued by this file. */
export function assertContext(ctx: TeamContext): TeamContext {
  if (!(ctx instanceof TeamContext) || !issued.has(ctx)) {
    throw new ForbiddenError("Not a TeamContext issued by the data layer");
  }
  return ctx;
}

/** A context allowed to read. Every member can read their team's data. */
export function readable(ctx: TeamContext): TeamContext {
  return assertContext(ctx);
}

/**
 * A context allowed to write at `minimum` role, routed to the region that
 * takes this team's writes. The MVP has one region, so the route is always
 * local; phase 2 forwards to the home region here.
 *
 * A closed team is read-only (TeamClosedError), except for what `whileClosed`
 * allows: leaving or removing a member, revoking invites, and closing it again.
 * System processes (billing, email events) aren't held to it.
 */
export function writable(db: Db, ctx: TeamContext, minimum: Role = "contributor", options: { readonly whileClosed?: boolean } = {}): TeamContext {
  assertContext(ctx);
  // Fails closed: a role without a rank (which authorizeTeam never issues) can't write
  const rank = RANK[ctx.role] as number | undefined;
  if (rank === undefined || rank < RANK[minimum]) throw new ForbiddenError(`Needs the ${minimum} role`);
  if (ctx.closed && ctx.role !== "system" && !options.whileClosed) throw new TeamClosedError(TEAM_CLOSED);
  const target = writeRegionFor(ctx, db.region);
  if (target !== db.region) throw new Error(`Writes for this team go to ${target}; forwarding is phase 2`);
  return ctx;
}

const TEAM_CLOSED = "This team was closed. It's read-only until its data is deleted.";

/**
 * Builds the context for a verified user acting on a team. Call it from the
 * authorizer with the user ID from the validated JWT and the team the request
 * names. Throws ForbiddenError if the user isn't a member.
 */
export async function authorizeTeam(db: Db, userId: string, teamId: string): Promise<TeamContext> {
  id(userId, "user ID");
  id(teamId, "team ID");
  // One strongly consistent, all-or-nothing read of the team and the membership
  const result = await connection(db).doc.send(
    new TransactGetCommand({
      TransactItems: [
        { Get: { TableName: db.tableName, Key: keys.team(teamId), ProjectionExpression: "homeRegion, closedAt" } },
        {
          Get: {
            TableName: db.tableName,
            Key: keys.member(teamId, userId),
            ProjectionExpression: "#role",
            ExpressionAttributeNames: { "#role": "role" },
          },
        },
      ],
    }),
  );
  const [meta, membership] = (result.Responses ?? []).map((r) => r.Item);
  if (!meta || !membership) throw new ForbiddenError("Not a member of this team");
  // A MEMBER item with a missing or unknown role is treated as no membership
  if (!isMemberRole(membership.role)) throw new ForbiddenError("Not a member of this team");
  return issue(teamId, userId, membership.role, meta.homeRegion as string, isClosed(meta));
}

/** The per-item reasons DynamoDB gave for cancelling a transaction, if it did. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
}

const DAY_SECONDS = 24 * 60 * 60;

/** The IDs of the teams a user is in, from their own USER# rows. */
async function teamsOf(db: Db, userId: string): Promise<Set<string>> {
  return new Set((await queryAll<UserTeam>(db, keys.userTeam(userId, "x").PK, prefixes.userTeam)).map((row) => row.teamId));
}

const teamFull = (cap: number) => `This team is full: it can have ${cap} members. Ask an owner to make room.`;

const TOO_MANY_TEAMS = `An account can be in at most ${MAX_TEAMS_PER_USER} teams; leave one first`;

const BEING_DELETED = "This account is being deleted";

/**
 * A transaction item that fails while the user's account is being deleted
 * (keys.accountDeletion), so no membership can be added after the deletion
 * has listed their teams.
 */
function notBeingDeleted(db: Db, userId: string) {
  return { ConditionCheck: { TableName: db.tableName, Key: keys.accountDeletion(userId), ConditionExpression: "attribute_not_exists(PK)" } };
}

/**
 * Creates a team with the verified caller as its owner, and returns the owner's
 * context. The home region is the region this runs in (ADR 0010), and the
 * team starts a TRIAL_DAYS free trial (ADR 0009).
 *
 * With a `requestKey` (the client's idempotency key), the team's ID is derived
 * from the user and the key, so a double-click or a retry makes one team: the
 * repeat finds the team it already made and returns it with `created: false`.
 * A user can create TEAMS_PER_USER_PER_DAY teams a UTC day; the counter is in
 * the user's own partition and moves in the same transaction. A repeat whose
 * name differs from the stored team's is a ConflictError: the key was reused
 * for a different team. A user in MAX_TEAMS_PER_USER teams can't create
 * another (LimitReachedError). That check reads before it writes, so two
 * requests at the same moment can go one over; it bounds work, not billing.
 */
export async function createTeam(
  db: Db,
  owner: { readonly userId: string; readonly email?: string },
  input: { readonly name: string; readonly plan?: string; readonly seats?: number; readonly requestKey?: string },
  now = new Date(),
): Promise<{ team: Team; context: TeamContext; created: boolean }> {
  const userId = id(owner.userId, "user ID");
  const name = teamName(input.name);
  const teamId = input.requestKey === undefined ? randomUUID() : teamIdForRequest(userId, input.requestKey);
  const createdAt = now.toISOString();
  const team: Team = {
    type: "team",
    teamId,
    name,
    plan: input.plan ?? "trial",
    seats: input.seats ?? 1,
    status: "trialing",
    homeRegion: db.region,
    trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * DAY_SECONDS * 1000).toISOString(),
    owners: 1,
    members: 1,
    createdAt,
    version: 1,
  };
  const member: Member = { type: "member", teamId, userId, role: "owner", email: owner.email, joinedAt: createdAt };
  const userTeam: UserTeam = { type: "userTeam", userId, teamId, teamName: team.name, role: "owner" };
  const epoch = Math.floor(now.getTime() / 1000);
  const mine = await teamsOf(db, userId);
  if (!mine.has(teamId) && mine.size >= MAX_TEAMS_PER_USER) throw new LimitReachedError(TOO_MANY_TEAMS);
  const write = () =>
    connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          // Both in the operators' index (ADR 0015): the team's account record, and its owner
          { Put: { TableName: db.tableName, Item: { ...keys.team(teamId), ...gsi3.team(teamId), ...team }, ConditionExpression: "attribute_not_exists(PK)" } },
          { Put: { TableName: db.tableName, Item: { ...keys.member(teamId, userId), ...gsi3.owner(teamId, userId), ...member } } },
          { Put: { TableName: db.tableName, Item: { ...keys.userTeam(userId, teamId), ...userTeam } } },
          {
            Update: {
              TableName: db.tableName,
              Key: keys.teamsCreated(userId, createdAt.slice(0, 10)),
              UpdateExpression: "ADD #count :one SET #type = :type, expiresAt = :expires",
              ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
              ExpressionAttributeNames: { "#count": "count", "#type": "type" },
              ExpressionAttributeValues: { ":one": 1, ":max": TEAMS_PER_USER_PER_DAY, ":type": "teamsCreated", ":expires": epoch + 2 * DAY_SECONDS },
            },
          },
          notBeingDeleted(db, userId),
        ],
      }),
    );
  for (let attempt = 1; !mine.has(teamId); attempt++) {
    try {
      await write();
      return { team, context: issue(teamId, userId, "owner", team.homeRegion), created: true };
    } catch (error) {
      const codes = cancellationCodes(error);
      // Two creates with the same key at once (a double-click): the loser
      // retries, and then finds the winner's team
      if (codes?.includes("TransactionConflict") && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        continue;
      }
      if (codes?.[4] === "ConditionalCheckFailed") throw new ForbiddenError(BEING_DELETED);
      if (codes?.[0] === "ConditionalCheckFailed") break;
      if (codes?.[3] === "ConditionalCheckFailed") throw new LimitReachedError(`You can create up to ${TEAMS_PER_USER_PER_DAY} teams a day`);
      return conflictOnConditionFailure("Someone else changed this; try again")(error);
    }
  }
  // The team exists. With a request key, that's this user's earlier create:
  // hand back what it made, as long as they're still a member.
  if (input.requestKey !== undefined) {
    const context = await authorizeTeam(db, userId, teamId).catch((e: unknown) => {
      if (e instanceof ForbiddenError) return undefined;
      throw e;
    });
    if (context) {
      const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.team(teamId), ConsistentRead: true }));
      const existing = strip<Team>(Item) as Team;
      if (existing.name !== name) throw new ConflictError("This Idempotency-Key was already used to create a team with another name");
      return { team: existing, context, created: false };
    }
  }
  throw new ConflictError("Team already exists");
}

/**
 * Finds a live invite from the token in the link. The person opening it isn't a
 * member yet, so this isn't team-scoped: the unguessable token is the proof.
 */
export async function findInvite(db: Db, token: string, now = new Date()): Promise<Invite | undefined> {
  if (typeof token !== "string" || token.length < 16) return undefined;
  const { Items } = await connection(db).doc.send(
    new QueryCommand({
      TableName: db.tableName,
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
      ExpressionAttributeValues: { ":pk": gsi1.inviteToken(hashInviteToken(token)).GSI1PK, ":sk": "INVITE" },
    }),
  );
  const invite = strip<Invite>(Items?.[0]);
  // TTL deletion can lag by days, so check expiry here too
  return invite && invite.expiresAt > now.getTime() / 1000 ? invite : undefined;
}

/**
 * Accepts an invite for the verified user and returns the new member's
 * context. Two proofs, both re-checked against the stored invite inside the
 * transaction:
 *
 * - `token`, from the emailed link: its SHA-256 must be the invite's. It
 *   proves the caller read that mailbox.
 * - `verifiedEmail`, an address the identity provider has verified for this
 *   user: it must be the invite's address.
 *
 * So an invite works once, before it expires, for its own address and link
 * only. Deleting the invite and adding the membership happen together. A user
 * already in MAX_TEAMS_PER_USER teams gets LimitReachedError.
 *
 * The team's member count moves in the same transaction, on the condition
 * that it's below memberCap, so a team never goes over its cap, even when two
 * people accept for its last place at once: one joins, the other gets
 * TeamFullError (and keeps the invite, for when a place frees up). A closed
 * team takes nobody (NotFoundError, as for an expired invite), and a user
 * whose account is being deleted can't join (ForbiddenError).
 */
export async function acceptInvite(
  db: Db,
  user: { readonly userId: string; readonly verifiedEmail: string },
  invite: Invite,
  token: string,
  now = new Date(),
): Promise<TeamContext> {
  const userId = id(user.userId, "user ID");
  const email = normalizeEmail(user.verifiedEmail);
  if (invite.email !== email) throw new ForbiddenError("This invite is for another email address");
  if (typeof token !== "string" || token.length < 16 || token.length > 512) throw new NotFoundError("This invite has expired or was already used");
  const mine = await teamsOf(db, userId);
  if (mine.has(invite.teamId)) throw new ConflictError("You're already a member of this team");
  if (mine.size >= MAX_TEAMS_PER_USER) throw new LimitReachedError(TOO_MANY_TEAMS);
  const count = await memberCount(db, invite.teamId, now);
  // A closed team takes nobody new; its invites were deleted when it closed
  if (!count || count.closed) throw new NotFoundError("This invite has expired or was already used");
  if (count.members >= count.cap) throw new TeamFullError(teamFull(count.cap));
  const member: Member = { type: "member", teamId: invite.teamId, userId, role: invite.role, email, joinedAt: now.toISOString() };
  const userTeam: UserTeam = { type: "userTeam", userId, teamId: invite.teamId, teamName: invite.teamName, role: invite.role };
  try {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: db.tableName,
              Key: keys.invite(invite.teamId, invite.inviteId),
              ConditionExpression: "attribute_exists(PK) AND #type = :invite AND GSI1PK = :token AND email = :email AND #role = :role AND expiresAt > :now",
              ExpressionAttributeNames: { "#type": "type", "#role": "role" },
              ExpressionAttributeValues: {
                ":invite": "invite",
                ":token": gsi1.inviteToken(hashInviteToken(token)).GSI1PK,
                ":email": email,
                ":role": invite.role,
                ":now": Math.floor(now.getTime() / 1000),
              },
            },
          },
          {
            Put: {
              TableName: db.tableName,
              // An owner is in the operators' index (ADR 0015)
              Item: { ...keys.member(invite.teamId, userId), ...(invite.role === "owner" ? gsi3.owner(invite.teamId, userId) : {}), ...member },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          { Put: { TableName: db.tableName, Item: { ...keys.userTeam(userId, invite.teamId), ...userTeam } } },
          teamCounts(db.tableName, invite.teamId, { members: 1, cap: count.cap, counted: count.counted, ...(invite.role === "owner" ? { owners: 1 as const } : {}) }),
          notBeingDeleted(db, userId),
        ],
      }),
    );
  } catch (error) {
    const codes = cancellationCodes(error);
    if (codes?.[4] === "ConditionalCheckFailed") throw new ForbiddenError(BEING_DELETED);
    if (codes?.[0] === "ConditionalCheckFailed") throw new NotFoundError("This invite has expired or was already used");
    if (codes?.[1] === "ConditionalCheckFailed") throw new ConflictError("You're already a member of this team");
    // The count's condition: the team filled up meanwhile. (Not when this
    // wrote the count for the first time: then someone changed the members.)
    if (codes?.[3] === "ConditionalCheckFailed" && count.counted === undefined) throw new TeamFullError(teamFull(count.cap));
    return conflictOnConditionFailure("Someone else changed this team; try again")(error);
  }
  return authorizeTeam(db, userId, invite.teamId);
}

/**
 * The context for a Stripe webhook acting on the customer's team, or undefined
 * for an unknown customer. The webhook's signature check is what makes the
 * customer ID trustworthy; call this only after it passes.
 */
export async function teamContextForStripeCustomer(db: Db, customerId: string): Promise<TeamContext | undefined> {
  const { doc } = connection(db);
  const { Item: link } = await doc.send(new GetCommand({ TableName: db.tableName, Key: keys.stripe(customerId), ConsistentRead: true }));
  if (!link) return undefined;
  const teamId = id(link.teamId, "team ID");
  const { Item: team } = await doc.send(
    new GetCommand({ TableName: db.tableName, Key: keys.team(teamId), ConsistentRead: true, ProjectionExpression: "homeRegion" }),
  );
  if (!team) return undefined;
  return issue(teamId, "system:stripe", "system", team.homeRegion as string);
}

/**
 * The context for the email-events handler acting on a team's invite after
 * SES reported a bounce or complaint, or undefined if the team is gone. The
 * team ID comes from the message's tags, which only our own sends set, in an
 * event only SES can publish (the topic's policy); markInviteFailed also
 * checks that the invite is for the address that bounced.
 */
export async function teamContextForEmailEvent(db: Db, teamId: string): Promise<TeamContext | undefined> {
  const { Item: team } = await connection(db).doc.send(
    new GetCommand({ TableName: db.tableName, Key: keys.team(id(teamId, "team ID")), ConsistentRead: true, ProjectionExpression: "homeRegion" }),
  );
  if (!team) return undefined;
  return issue(teamId, "system:email", "system", team.homeRegion as string);
}
