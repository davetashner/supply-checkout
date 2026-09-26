// TeamContext: the only way to read or write a team's data (ADR 0005).
//
// The server builds it from the caller's verified identity and their MEMBER
// item; the client never supplies the team or the role. Every function that
// issues a context lives in this file, and the issuer is private to it: the
// constructor needs a symbol that isn't exported, and every data function
// checks that the context it gets is one this file issued.
//
// Issuers: authorizeTeam (the API authorizer), createTeam (the new owner),
// acceptInvite (the new member) and teamContextForStripeCustomer (webhooks).

import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactGetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { ConflictError, ForbiddenError, LimitReachedError, NotFoundError, conflictOnConditionFailure } from "./errors.js";
import { gsi1, id, keys, strip } from "./keys.js";
import {
  type Invite,
  type Member,
  type Role,
  type Team,
  type UserTeam,
  TEAMS_PER_USER_PER_DAY,
  TRIAL_DAYS,
  hashInviteToken,
  isMemberRole,
  normalizeEmail,
  ownersUpdate,
  teamIdForRequest,
  teamName,
} from "./model.js";
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

  constructor(token: symbol, teamId: string, userId: string, role: Role, homeRegion: string) {
    if (token !== ISSUE) throw new ForbiddenError("TeamContext can only be issued by the data layer");
    this.teamId = teamId;
    this.userId = userId;
    this.role = role;
    this.homeRegion = homeRegion;
    Object.freeze(this);
    issued.add(this);
  }
}

// Not exported: only the issuers below can call it.
function issue(teamId: string, userId: string, role: Role, homeRegion: string): TeamContext {
  return new TeamContext(ISSUE, teamId, userId, role, homeRegion);
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
 */
export function writable(db: Db, ctx: TeamContext, minimum: Role = "contributor"): TeamContext {
  assertContext(ctx);
  // Fails closed: a role without a rank (which authorizeTeam never issues) can't write
  const rank = RANK[ctx.role] as number | undefined;
  if (rank === undefined || rank < RANK[minimum]) throw new ForbiddenError(`Needs the ${minimum} role`);
  const target = writeRegionFor(ctx, db.region);
  if (target !== db.region) throw new Error(`Writes for this team go to ${target}; forwarding is phase 2`);
  return ctx;
}

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
        { Get: { TableName: db.tableName, Key: keys.team(teamId), ProjectionExpression: "homeRegion" } },
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
  return issue(teamId, userId, membership.role, meta.homeRegion as string);
}

/** The per-item reasons DynamoDB gave for cancelling a transaction, if it did. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
}

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Creates a team with the verified caller as its owner, and returns the owner's
 * context. The home region is the region this runs in (ADR 0010), and the
 * team starts a TRIAL_DAYS free trial (ADR 0009).
 *
 * With a `requestKey` (the client's idempotency key), the team's ID is derived
 * from the user and the key, so a double-click or a retry makes one team: the
 * repeat finds the team it already made and returns it with `created: false`.
 * A user can create TEAMS_PER_USER_PER_DAY teams a UTC day; the counter is in
 * the user's own partition and moves in the same transaction.
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
    createdAt,
    version: 1,
  };
  const member: Member = { type: "member", teamId, userId, role: "owner", email: owner.email, joinedAt: createdAt };
  const userTeam: UserTeam = { type: "userTeam", userId, teamId, teamName: team.name, role: "owner" };
  const epoch = Math.floor(now.getTime() / 1000);
  const write = () =>
    connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: db.tableName, Item: { ...keys.team(teamId), ...team }, ConditionExpression: "attribute_not_exists(PK)" } },
          { Put: { TableName: db.tableName, Item: { ...keys.member(teamId, userId), ...member } } },
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
        ],
      }),
    );
  for (let attempt = 1; ; attempt++) {
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
      return { team: strip<Team>(Item) as Team, context, created: false };
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
 * context. `verifiedEmail` must be an address the identity provider has
 * verified for this user: it has to match the invite's. The invite comes from
 * findInviteForEmail (or findInvite); the transaction re-checks it against the
 * stored item, so it works once, only before it expires, and only for that
 * email. Deleting the invite and adding the membership happen together.
 */
export async function acceptInvite(
  db: Db,
  user: { readonly userId: string; readonly verifiedEmail: string },
  invite: Invite,
  now = new Date(),
): Promise<TeamContext> {
  const userId = id(user.userId, "user ID");
  const email = normalizeEmail(user.verifiedEmail);
  if (invite.email !== email) throw new ForbiddenError("This invite is for another email address");
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
              ConditionExpression: "attribute_exists(PK) AND #type = :invite AND email = :email AND #role = :role AND expiresAt > :now",
              ExpressionAttributeNames: { "#type": "type", "#role": "role" },
              ExpressionAttributeValues: { ":invite": "invite", ":email": email, ":role": invite.role, ":now": Math.floor(now.getTime() / 1000) },
            },
          },
          { Put: { TableName: db.tableName, Item: { ...keys.member(invite.teamId, userId), ...member }, ConditionExpression: "attribute_not_exists(PK)" } },
          { Put: { TableName: db.tableName, Item: { ...keys.userTeam(userId, invite.teamId), ...userTeam } } },
          ...(invite.role === "owner" ? [ownersUpdate(db.tableName, invite.teamId, 1)] : []),
        ],
      }),
    );
  } catch (error) {
    const codes = cancellationCodes(error);
    if (codes?.[0] === "ConditionalCheckFailed") throw new NotFoundError("This invite has expired or was already used");
    if (codes?.[1] === "ConditionalCheckFailed") throw new ConflictError("You're already a member of this team");
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
