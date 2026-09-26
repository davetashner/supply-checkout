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
import { ForbiddenError, InvalidInputError, conflictOnConditionFailure } from "./errors.js";
import { gsi1, id, keys, strip } from "./keys.js";
import { type Invite, type Member, type Role, type Team, type UserTeam, hashInviteToken, isMemberRole, ownersUpdate, teamName } from "./model.js";
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
    name: teamName(input.name),
    plan: input.plan ?? "trial",
    seats: input.seats ?? 1,
    status: "trialing",
    homeRegion: db.region,
    owners: 1,
    createdAt: now,
    version: 1,
  };
  const member: Member = { type: "member", teamId: team.teamId, userId, role: "owner", email: owner.email, joinedAt: now };
  const userTeam: UserTeam = { type: "userTeam", userId, teamId: team.teamId, teamName: team.name, role: "owner" };
  await connection(db)
    .doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: db.tableName, Item: { ...keys.team(team.teamId), ...team }, ConditionExpression: "attribute_not_exists(PK)" } },
          { Put: { TableName: db.tableName, Item: { ...keys.member(team.teamId, userId), ...member } } },
          { Put: { TableName: db.tableName, Item: { ...keys.userTeam(userId, team.teamId), ...userTeam } } },
        ],
      }),
    )
    .catch(conflictOnConditionFailure("Team already exists"));
  return { team, context: issue(team.teamId, userId, "owner", team.homeRegion) };
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
  await connection(db)
    .doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: db.tableName, Key: keys.invite(invite.teamId, invite.inviteId), ConditionExpression: "attribute_exists(PK)" } },
          { Put: { TableName: db.tableName, Item: { ...keys.member(invite.teamId, userId), ...member }, ConditionExpression: "attribute_not_exists(PK)" } },
          { Put: { TableName: db.tableName, Item: { ...keys.userTeam(userId, invite.teamId), ...userTeam } } },
          ...(invite.role === "owner" ? [ownersUpdate(db.tableName, invite.teamId, 1)] : []),
        ],
      }),
    )
    .catch(conflictOnConditionFailure("This invite was already used, or you're already a member"));
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
