// TeamContext: the only way to read or write a team's data (ADR 0005).
//
// The server builds it from the caller's verified identity and their MEMBER
// item; the client never supplies the team or the role. It can't be built
// outside this module: the constructor needs a symbol that isn't exported, and
// every data function checks that the context it gets was issued here.

import { TransactGetCommand } from "@aws-sdk/lib-dynamodb";
import type { Db } from "./client.js";
import { ForbiddenError } from "./errors.js";
import { id, keys } from "./keys.js";
import { writeRegionFor } from "./region.js";

/** Roles in a team (ADR 0007). `system` is for server processes such as Stripe webhooks. */
export type Role = "owner" | "contributor" | "viewer" | "system";

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

/** For this module only: issues a context once membership has been checked. */
export function issueContext(teamId: string, userId: string, role: Role, homeRegion: string): TeamContext {
  return new TeamContext(ISSUE, teamId, userId, role, homeRegion);
}

/** Throws unless `ctx` was issued by this module. */
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
  if (RANK[ctx.role] < RANK[minimum]) throw new ForbiddenError(`Needs the ${minimum} role`);
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
  const result = await db.doc.send(
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
  return issueContext(teamId, userId, membership.role as Role, meta.homeRegion as string);
}
