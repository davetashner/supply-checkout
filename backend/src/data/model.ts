// Item shapes and validators shared by the team, member and invite functions.
// No imports from team-context.ts, so it can import these without a cycle.

import { createHash } from "node:crypto";
import { InvalidInputError } from "./errors.js";
import { keys } from "./keys.js";

/** Roles in a team (ADR 0007). `system` is for server processes such as Stripe webhooks. */
export type Role = "owner" | "contributor" | "viewer" | "system";
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
  /**
   * How many members are owners. Every change to an owner membership updates it
   * in the same transaction, with the condition `owners > 1` on a decrease, so
   * a team can never lose its last owner.
   */
  readonly owners: number;
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

export interface Invite {
  readonly type: "invite";
  readonly teamId: string;
  /** Copied from the team when the invite is made, for the invite page. */
  readonly teamName: string;
  readonly inviteId: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly invitedBy: string;
  readonly createdAt: string;
  /** Epoch seconds; DynamoDB's TTL removes the item after this. */
  readonly expiresAt: number;
}

/** True for a role a MEMBER item may hold. */
export function isMemberRole(value: unknown): value is MemberRole {
  return MEMBER_ROLES.includes(value as MemberRole);
}

export function memberRole(value: unknown): MemberRole {
  if (!MEMBER_ROLES.includes(value as MemberRole)) throw new InvalidInputError("Invalid role");
  return value as MemberRole;
}

export function teamName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new InvalidInputError("Invalid team name");
  return value.trim();
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * A transaction item that moves the team's owner count by `delta`. A decrease
 * is conditional on another owner remaining, so it fails (and cancels the whole
 * transaction) rather than leave the team without an owner.
 */
export function ownersUpdate(tableName: string, teamId: string, delta: 1 | -1) {
  return {
    Update: {
      TableName: tableName,
      Key: keys.team(teamId),
      UpdateExpression: "ADD owners :delta",
      ConditionExpression: delta < 0 ? "owners > :one" : "attribute_exists(PK)",
      ExpressionAttributeValues: delta < 0 ? { ":delta": delta, ":one": 1 } : { ":delta": delta },
    },
  };
}
