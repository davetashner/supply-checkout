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
  /** When the free trial ends (ISO 8601): TRIAL_DAYS after creation (ADR 0009). Absent on teams made before trials. */
  readonly trialEndsAt?: string;
  /**
   * How many members are owners. Every change to an owner membership updates it
   * in the same transaction, with the condition `owners > 1` on a decrease, so
   * a team can never lose its last owner.
   */
  readonly owners: number;
  /**
   * How many members the team has. Created as 1, and moved in the same
   * transaction as every membership that's added (acceptInvite, refused at
   * memberCap) or removed (removeMember). Absent on teams made before it
   * existed: the next membership change counts the MEMBER items and sets it,
   * on the condition that it's still absent (teamCounts).
   */
  readonly members?: number;
  readonly stripeCustomerId?: string;
  readonly createdAt: string;
  readonly version: number;
  /**
   * A comp (ADR 0015): a plan an operator granted until `compUntil` (ISO
   * 8601), at most 12 months ahead. While it's live (liveComp) the team is
   * active on it whatever its Stripe status says. Only the ops function writes
   * these, and it never writes `plan` or `status` (ADR 0009).
   */
  readonly compPlan?: string;
  readonly compSeats?: number;
  readonly compUntil?: string;
  readonly compReason?: string;
  /** The operator's `sub`. Never shown to the team. */
  readonly compBy?: string;
  readonly compAt?: string;
}

/** A comp that's live now: one whose `compUntil` is in the future. */
export interface Comp {
  readonly plan: string;
  readonly seats?: number;
  readonly until: string;
}

/**
 * The team's comp, if it has one and it hasn't run out. The entitlement
 * checks (memberCap, the live-update audience, /me) treat a team with one as
 * active, whatever Stripe says, and fall back to the Stripe status after it.
 */
export function liveComp(team: { readonly compPlan?: unknown; readonly compSeats?: unknown; readonly compUntil?: unknown }, now = new Date()): Comp | undefined {
  if (typeof team.compPlan !== "string" || typeof team.compUntil !== "string") return undefined;
  const until = Date.parse(team.compUntil);
  if (!(until > now.getTime())) return undefined;
  return { plan: team.compPlan, until: team.compUntil, ...(typeof team.compSeats === "number" ? { seats: team.compSeats } : {}) };
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
  /**
   * "failed" once the invite's email bounced or its recipient marked it as
   * spam (the email-events handler); absent while it's pending. The owner
   * sees it and can correct the address. Nothing re-sends it automatically.
   * Not called `status`: the team's META item has one (its subscription), and
   * the email-events role may write these names anywhere in a team's partition.
   */
  readonly inviteStatus?: "failed";
  readonly failureReason?: InviteFailure;
  /** When the failure was reported (ISO 8601). */
  readonly failedAt?: string;
}

/**
 * Why an invite's email failed: a permanent bounce or a complaint (SES
 * suppresses the address either way; the email-events handler records these),
 * or SES refused to send it at all (`not_sent`, recorded by the request that
 * created or re-sent the invite). Transient bounces don't fail an invite.
 */
export type InviteFailure = "bounced" | "complained" | "not_sent";

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
 * Subscription statuses (ADR 0009) after which a team's members get no more
 * live-update notices: Stripe's `canceled`, `unpaid` (retries ran out and the
 * subscription wasn't canceled) and `incomplete_expired` (the first payment
 * never went through). The billing webhook sets the status with updateTeam;
 * the stream consumer reads it through liveUpdateRecipients, so nothing else
 * has to be called when a team is canceled.
 */
export const ENDED_STATUSES: readonly string[] = ["canceled", "unpaid", "incomplete_expired"];

/** True when a team's subscription status means it has ended. */
export function hasEnded(status: unknown): boolean {
  return typeof status === "string" && ENDED_STATUSES.includes(status);
}

/** The free trial every new team starts with: 14 days, no card (ADR 0009). */
export const TRIAL_DAYS = 14;

/** Teams one user may create per UTC day: a guard against scripts and runaway retries. */
export const TEAMS_PER_USER_PER_DAY = 5;

/** Invites (new or re-sent) one team may send per UTC day. */
export const INVITES_PER_TEAM_PER_DAY = 50;

/**
 * Invites (new or re-sent) one team may send one address per UTC day. Low, so
 * one team can't use up the address's allowance from every team.
 */
export const INVITES_PER_TEAM_ADDRESS_PER_DAY = 3;

/**
 * Invites (new or re-sent) one address may be sent per UTC day, from all teams
 * together. A complaint suppresses the address for Cognito's sign-in codes
 * too, so invites mustn't be a way to flood someone's mailbox.
 */
export const INVITES_PER_ADDRESS_PER_DAY = 15;

/**
 * Members a team may have while it isn't paying (trialing, or its
 * subscription is anything but PAID_STATUSES): enough for a crew to try it,
 * few enough that free accounts can't make a team whose live updates are
 * costly to fan out (ADR 0016).
 */
export const MEMBERS_PER_TRIAL_TEAM = 10;

/**
 * Members a paying team may have. It bounds the live-update fan-out (one
 * publish per member per chunk of changes, ADR 0016) and the per-team work
 * the members screen does. A bigger customer asks support, which raises it.
 */
export const MEMBERS_PER_TEAM = 100;

/** Subscription statuses that count as paying for memberCap: `active`, and `past_due` while Stripe retries. */
export const PAID_STATUSES: readonly string[] = ["active", "past_due"];

/**
 * How many members a team may have. Pending invites count against it when an
 * owner invites someone (createInvite), and acceptInvite enforces it
 * atomically with the team's `members` count.
 *
 * This is the one place the cap is decided. Seat billing (bead
 * supply-checkout-l50) plugs in here: when a paid team's members must fit its
 * paid seats, return `Math.min(MEMBERS_PER_TEAM, team.seats)` for paying
 * teams. Until then seats aren't enforced. A team with a live comp
 * (liveComp) counts as paying.
 */
export function memberCap(team: { readonly status?: unknown; readonly seats?: unknown; readonly compPlan?: unknown; readonly compUntil?: unknown }, now = new Date()): number {
  // A live comp counts as paying (ADR 0015)
  if (liveComp(team, now)) return MEMBERS_PER_TEAM;
  return typeof team.status === "string" && PAID_STATUSES.includes(team.status) ? MEMBERS_PER_TEAM : MEMBERS_PER_TRIAL_TEAM;
}

/** Teams one user may belong to. It bounds the per-team work /me does (a role session each). */
export const MAX_TEAMS_PER_USER = 20;

/**
 * An email address as invites store and match it: NFKC-normalized, then
 * trimmed and lowercased, so look-alike compatibility characters (a Kelvin
 * sign for a K, full-width letters) compare equal to the plain ones on both
 * the invite and the accept side.
 */
export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") throw new InvalidInputError("Invalid email");
  const email = value.normalize("NFKC").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) throw new InvalidInputError("Invalid email");
  return email;
}

// A bare addr-spec, lowercase ASCII: a dot-atom local part and a dotted DNS
// name (international domains in their xn-- form). No display name, angle
// brackets, quotes, commas, comments or spaces: SES reads a recipient as an
// RFC 5322 address, and anything more than an addr-spec could send the mail
// somewhere other than the address that was checked, hashed and limited.
const ADDR_SPEC = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * An address the app may send mail to, or InvalidInputError: normalizeEmail's
 * form, and also a strict addr-spec (ADDR_SPEC). Invites and the mailer use
 * it. Matching a signed-in user's verified email to their invites still uses
 * normalizeEmail, so an unusual but verified address can't lock anyone out;
 * such an address just can't be invited.
 */
export function mailAddress(value: unknown): string {
  const email = normalizeEmail(value);
  const at = email.lastIndexOf("@");
  if (!ADDR_SPEC.test(email) || at > 64) throw new InvalidInputError("Invalid email");
  return email;
}

/**
 * The key the invite limits count an address under: its mailAddress form,
 * less a `+tag` in the local part, and for Gmail less the dots too (Gmail
 * delivers all of those to one mailbox). Only for rate limiting: invites are
 * stored and matched by the address as given.
 */
export function inviteLimitKey(value: unknown): string {
  const email = mailAddress(value);
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at).replace(/\+.*$/, "");
  let domain = email.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    local = local.replaceAll(".", "");
    domain = "gmail.com";
  }
  return createHash("sha256").update(`${local || email.slice(0, at)}@${domain}`, "utf8").digest("hex");
}

/**
 * The GSI2 partition value for an email: its SHA-256, so the address itself
 * isn't a key, and so it fits an IAM session tag (which can't hold every
 * character an email address can).
 */
export function hashEmail(email: string): string {
  return createHash("sha256").update(normalizeEmail(email), "utf8").digest("hex");
}

/** A client's idempotency key for creating a team. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * The ID of the team a user's create request makes. It is derived from the
 * user and their idempotency key, so a double-click or a retry names the same
 * team, and the create's `attribute_not_exists` condition makes one team.
 */
export function teamIdForRequest(userId: string, requestKey: string): string {
  if (typeof requestKey !== "string" || !REQUEST_KEY.test(requestKey)) throw new InvalidInputError("Invalid idempotency key");
  const h = createHash("sha256").update(`team\n${userId}\n${requestKey}`, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The one transaction item on a team's META item for a membership that's
 * added or removed: it moves the member count, and the owner count too when
 * the membership is an owner's. (DynamoDB allows one operation per item in a
 * transaction, so both counts move in one Update.)
 *
 * - `members: 1` is conditional on the count being below `cap`, so two
 *   accepts racing for the last place can't both join.
 * - `owners: -1` is conditional on another owner remaining (ownersUpdate).
 * - `counted`: the team has no `members` yet (a team made before the count),
 *   and this is how many MEMBER items it has now. The update sets the count
 *   to `counted + members`, on the condition that it's still absent. Every
 *   membership change sets it, so one that commits between the caller's
 *   count and this write makes the condition fail (a ConflictError to retry),
 *   rather than leave a wrong count. The caller checks the cap against
 *   `counted` itself.
 */
export function teamCounts(
  tableName: string,
  teamId: string,
  change: { readonly members: 1 | -1; readonly owners?: 1 | -1; readonly cap?: number; readonly counted?: number },
) {
  const conditions = ["attribute_exists(PK)"];
  const values: Record<string, number> = {};
  const add: string[] = [];
  let set = "";
  if (change.counted === undefined) {
    add.push("#members :members");
    values[":members"] = change.members;
    if (change.members > 0) {
      if (change.cap === undefined) throw new Error("Adding a member needs the team's cap");
      conditions.push("#members < :cap");
      values[":cap"] = change.cap;
    } else conditions.push("attribute_exists(#members)");
  } else {
    set = "SET #members = :members";
    values[":members"] = Math.max(0, change.counted + change.members);
    conditions.push("attribute_not_exists(#members)");
  }
  if (change.owners !== undefined) {
    add.push("owners :owners");
    values[":owners"] = change.owners;
    if (change.owners < 0) {
      conditions.push("owners > :one");
      values[":one"] = 1;
    }
  }
  return {
    Update: {
      TableName: tableName,
      Key: keys.team(teamId),
      UpdateExpression: [set, add.length ? `ADD ${add.join(", ")}` : ""].filter(Boolean).join(" "),
      ConditionExpression: conditions.join(" AND "),
      // MEMBERS is a DynamoDB reserved word
      ExpressionAttributeNames: { "#members": "members" },
      ExpressionAttributeValues: values,
    },
  };
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
