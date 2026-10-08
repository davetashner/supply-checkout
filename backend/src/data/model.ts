// Item shapes and validators shared by the team, member and invite functions.
// No imports from team-context.ts, so it can import these without a cycle.

import { createHash } from "node:crypto";
import { InvalidInputError } from "./errors.js";
import { keys } from "./keys.js";
import { hasHiddenCharacter, withoutHiddenCharacters } from "../text/hidden-characters.js";

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
  /** The team's Stripe customer (linkStripeCustomer), made the first time an owner starts a checkout. */
  readonly stripeCustomerId?: string;
  /** The team's Stripe subscription, which the billing webhook records (ADR 0009). */
  readonly stripeSubscriptionId?: string;
  /** How often the subscription bills: `month` or `year` (the billing worker, from its price). */
  readonly billingInterval?: string;
  /** When the subscription's current period ends (ISO 8601): its next renewal, or when a trial ends. */
  readonly currentPeriodEnd?: string;
  /** The subscription ends at `currentPeriodEnd` rather than renewing (canceled in the Customer Portal, or the team closed). */
  readonly cancelAtPeriodEnd?: boolean;
  /** When the billing worker last applied the subscription from Stripe (ISO 8601). */
  readonly stripeSyncedAt?: string;
  /**
   * While the subscription is `past_due`: when the billing worker first saw it
   * so (ISO 8601). The PAYMENT_GRACE_DAYS grace runs from here (billingAccess).
   * Removed when it's anything else.
   */
  readonly pastDueSince?: string;
  /**
   * While the subscription is over (STOPPED_STATUSES: `canceled`,
   * `incomplete_expired`): when it ended, from Stripe's `ended_at`, or when
   * the billing worker first saw it so. The READ_ONLY_RETENTION_DAYS before
   * deletion run from here (billingAccess). Never set for `unpaid`. Removed
   * with any other status.
   */
  readonly subscriptionEndedAt?: string;
  /**
   * When an owner closed the team (ISO 8601; closeTeam). A closed team is
   * read-only: members can still read and export it, and leave, but nothing
   * else changes. Its live updates stop, its invites are gone, and the
   * scheduled purge deletes all of it after `purgeAfter`.
   */
  readonly closedAt?: string;
  /** Who closed it (a user ID). */
  readonly closedBy?: string;
  /** When the purge may delete the team (ISO 8601): CLOSED_TEAM_RETENTION_DAYS after `closedAt`. */
  readonly purgeAfter?: string;
  /**
   * When the purge started deleting the team (ISO 8601; purgeTeam). It's set,
   * on the condition the team is still closed and due, before anything is
   * deleted, and never removed: reopenTeam refuses a team with it.
   */
  readonly purging?: string;
  readonly createdAt: string;
  readonly version: number;
  /**
   * A test team (supply-checkout-o60.2, test-accounts.ts): a test account
   * created it. Written once, by createTeam, and never changed. It only
   * leaves the team out of customer-activity metrics and shows operators a
   * Test badge; it never grants anything.
   */
  readonly test?: true;
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
  /**
   * A comp for a number of months (1 to 12, supply-checkout-6e4b): while it's
   * live, the team's Stripe subscription also gets a 100%-off discount for
   * those months (billing/comp-discount.ts).
   */
  readonly compMonths?: number;
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
  /**
   * Their name from Cognito (given_name and family_name, from sign-up or from
   * Google or Apple), as memberName() makes it; absent when they have none.
   * Copied when they create a team or accept an invite, and kept current on
   * /me (supply-checkout-lx7). Only the team's owners see it (GET /members),
   * as they see the email. The person can change it themselves, so it's shown
   * beside the email, never instead of it, and never logged. Not called
   * `name`: the team's META item has one, and the operators' index and the
   * billing and lapse roles may read that attribute anywhere in a team's
   * partition (OPS_INDEX_ATTRIBUTES, BILLING_READ_ATTRIBUTES,
   * LAPSE_READ_ATTRIBUTES); none of them may read this one.
   */
  readonly displayName?: string;
  readonly joinedAt: string;
}

/** The longest name a MEMBER item keeps (memberName). */
export const MEMBER_NAME_MAX = 100;

/**
 * A member's name as it's stored and shown: given and family names joined, on
 * one line, without control or invisible characters (they could reorder or
 * hide what an owner reads), cut to MEMBER_NAME_MAX; undefined when nothing's
 * left. Each part is user-writable in Cognito, so neither is trusted.
 */
export function memberName(given: unknown, family: unknown): string | undefined {
  const part = (value: unknown) => (typeof value === "string" ? withoutHiddenCharacters(value.slice(0, 4 * MEMBER_NAME_MAX)) : "");
  const flat = `${part(given)} ${part(family)}`.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > MEMBER_NAME_MAX ? withoutHiddenCharacters(flat.slice(0, MEMBER_NAME_MAX)).trimEnd() : flat;
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
  // No control or invisible characters (src/text/hidden-characters.ts): it's in the team switcher and in emails
  if (typeof value !== "string" || !value.trim() || value.length > 200 || hasHiddenCharacter(value)) throw new InvalidInputError("Invalid team name");
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

/**
 * Subscription statuses after which the subscription is over for good and
 * the team's READ_ONLY_RETENTION_DAYS before deletion run (billingAccess,
 * `subscriptionEndedAt`): ENDED_STATUSES but `unpaid`, which is a payment
 * still owed on a live subscription (Terms 5.6), read-only until it's paid.
 */
export const STOPPED_STATUSES: readonly string[] = ["canceled", "incomplete_expired"];

/** True when a subscription status is one of STOPPED_STATUSES. */
export function hasStopped(status: unknown): boolean {
  return typeof status === "string" && STOPPED_STATUSES.includes(status);
}

/**
 * How long a `past_due` team keeps full access while Stripe retries the
 * payment (ADR 0009, Terms 5.6): then it's read-only until the balance is paid.
 */
export const PAYMENT_GRACE_DAYS = 7;

/**
 * How long a team whose trial or subscription ended stays read-only, so its
 * owners can export it or subscribe, before it's closed and deleted (ADR 0009,
 * Terms sections 4 and 6, the privacy policy's retention table). The same 30
 * days a closed team gets (CLOSED_TEAM_RETENTION_DAYS).
 */
export const READ_ONLY_RETENTION_DAYS = 30;

/** How far behind UTC the last time zone on Earth is (UTC−12): a calendar date has ended everywhere this long after it ends in UTC. */
const LAST_ZONE_MS = 12 * 60 * 60 * 1000;

/**
 * When a lapsed team may be deleted, for a deletion due at `ms` (epoch ms):
 * the end of `ms`'s UTC calendar date in the last time zone on Earth (UTC−12),
 * which is 12:00 UTC the next day. Owners are told that date
 * (deletionLastDay), so they never lose data while it's still that date where
 * they are. Up to 36 hours later than `ms`, never earlier.
 */
export function deletionTime(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + LAST_ZONE_MS;
}

/**
 * The last calendar date (YYYY-MM-DD) a team deleted at `deleteAfter` (ISO
 * 8601, a deletionTime) is kept: the date in UTC−12 just before it, the date
 * every email, and the app, state. For a deletionTime that's the UTC date it
 * was rounded from.
 */
export function deletionLastDay(deleteAfter: string): string {
  return new Date(Date.parse(deleteAfter) - LAST_ZONE_MS - 1).toISOString().slice(0, 10);
}

const ACCESS_DAY_MS = 24 * 60 * 60 * 1000;

/** Why a team is read-only for billing (billingAccess). */
export type ReadOnlyReason = "trial_ended" | "payment_overdue" | "subscription_ended";

/** What the team's billing allows now (billingAccess). */
export interface BillingAccess {
  /** Read-only: members may read, export and leave; owners may subscribe or pay. */
  readonly readOnly: boolean;
  readonly reason?: ReadOnlyReason;
  /** When it became read-only (ISO 8601), when that's known. */
  readonly readOnlyFrom?: string;
  /** A `past_due` team still in its grace period: when the grace ends (ISO 8601). */
  readonly graceEndsAt?: string;
  /**
   * When the team is closed and deleted unless it subscribes (ISO 8601):
   * READ_ONLY_RETENTION_DAYS after it became read-only, rounded up to the
   * end of that date everywhere (deletionTime; owners are told
   * deletionLastDay), for a trial that
   * ended without a subscription and for a subscription that ended. Never for
   * `payment_overdue` (Stripe's retries decide when that subscription ends,
   * and its 30 days start then), and never while the date it ended is unknown.
   */
  readonly deleteAfter?: string;
}

/** The fields of a team's META item that billingAccess reads. */
export interface BillingAccessFields {
  readonly status?: unknown;
  readonly trialEndsAt?: unknown;
  readonly createdAt?: unknown;
  readonly stripeSubscriptionId?: unknown;
  /** When the subscription went `past_due` (the billing worker, applySubscription). */
  readonly pastDueSince?: unknown;
  /** When the subscription ended (Stripe's `ended_at`, or when the worker first saw it ended). */
  readonly subscriptionEndedAt?: unknown;
  readonly compPlan?: unknown;
  readonly compUntil?: unknown;
}

const dateMs = (value: unknown) => (typeof value === "string" ? Date.parse(value) : NaN);

/** When the team's free trial ends (epoch ms): `trialEndsAt`, or TRIAL_DAYS after it was made for a team from before trials; NaN when neither is a date. */
export function trialEnd(team: { readonly trialEndsAt?: unknown; readonly createdAt?: unknown }): number {
  const at = dateMs(team.trialEndsAt);
  if (Number.isFinite(at)) return at;
  return dateMs(team.createdAt) + TRIAL_DAYS * ACCESS_DAY_MS;
}

/**
 * What a team's billing allows now (ADR 0009, Terms 4, 5.6 and 6). The one
 * place the access rules are decided; authorizeTeam (writable), /me, the
 * billing worker and the lapsed-team job all use it.
 *
 * - A live comp (ADR 0015): full access, whatever Stripe says, and never
 *   deleted. When it runs out, every clock below starts no earlier than its
 *   `compUntil`.
 * - `canceled`, `incomplete_expired` (STOPPED_STATUSES): read-only
 *   (`subscription_ended`) from `subscriptionEndedAt`, and deleted
 *   READ_ONLY_RETENTION_DAYS later.
 * - `past_due`: full access for PAYMENT_GRACE_DAYS from `pastDueSince`, then
 *   read-only (`payment_overdue`) until it's paid. Not deleted: Stripe is set
 *   to cancel the subscription once its retries all fail (Terms 5.6), and the
 *   rule above applies then.
 * - `unpaid` (Stripe's other choice for when retries all fail, a fallback in
 *   case it's ever set so): read-only (`payment_overdue`) until it's paid,
 *   at once, and never deleted for it.
 * - `trialing` with no Stripe subscription (the app's own trial, no
 *   Checkout): read-only (`trial_ended`) from trialEnd, and deleted
 *   READ_ONLY_RETENTION_DAYS later. A trial with a subscription is Stripe's:
 *   it cancels the subscription at the trial's end if no card was added.
 * - Anything else (`active`, a Stripe trial, `incomplete`, `paused`): full.
 *
 * A date that's missing or not a date never makes a team read-only sooner,
 * and never sets a deletion date: an ended team without `subscriptionEndedAt`
 * is read-only but not deleted until the billing worker records it.
 */
export function billingAccess(team: BillingAccessFields, now = new Date()): BillingAccess {
  if (liveComp(team, now)) return { readOnly: false };
  const compEnd = dateMs(team.compUntil);
  // A comp that ran out: no clock starts before it did
  const after = (ms: number) => (Number.isFinite(compEnd) ? Math.max(ms, compEnd) : ms);
  // A date past what Date can hold (corrupt data) is dropped rather than failing the caller
  const iso = (ms: number) => (Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : undefined);
  // Rounded up to the end of that date everywhere (deletionTime), so nobody loses data on the date they were told
  const retention = (from: number) => iso(deletionTime(from + READ_ONLY_RETENTION_DAYS * ACCESS_DAY_MS));
  const dated = <T extends object>(fields: Record<string, string | undefined>, rest: T) => ({ ...rest, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
  const at = now.getTime();
  if (team.status === "unpaid") return { readOnly: true, reason: "payment_overdue" };
  if (hasStopped(team.status)) {
    const ended = dateMs(team.subscriptionEndedAt);
    if (!Number.isFinite(ended)) return { readOnly: true, reason: "subscription_ended" };
    const from = after(ended);
    return dated({ readOnlyFrom: iso(from), deleteAfter: retention(from) }, { readOnly: true, reason: "subscription_ended" as const });
  }
  if (team.status === "past_due") {
    const since = dateMs(team.pastDueSince);
    if (!Number.isFinite(since)) return { readOnly: false };
    const graceEnd = after(since) + PAYMENT_GRACE_DAYS * ACCESS_DAY_MS;
    return graceEnd <= at ? dated({ readOnlyFrom: iso(graceEnd) }, { readOnly: true, reason: "payment_overdue" as const }) : dated({ graceEndsAt: iso(graceEnd) }, { readOnly: false });
  }
  if (team.status === "trialing" && typeof team.stripeSubscriptionId !== "string") {
    const end = trialEnd(team);
    if (!Number.isFinite(end)) return { readOnly: false };
    const from = after(end);
    return from <= at ? dated({ readOnlyFrom: iso(from), deleteAfter: retention(from) }, { readOnly: true, reason: "trial_ended" as const }) : { readOnly: false };
  }
  return { readOnly: false };
}

/**
 * True when the team is read-only for billing (billingAccess): its trial or
 * subscription ended, or a payment is overdue past the grace period, and no
 * live comp keeps it going. Its members can still read and export it, and
 * leave; an owner can subscribe again, or pay.
 */
export function isReadOnlyForBilling(team: BillingAccessFields, now = new Date()): boolean {
  return billingAccess(team, now).readOnly;
}

/** True for a team an owner has closed (closeTeam), from its META item. */
export function isClosed(team: { readonly closedAt?: unknown } | undefined): boolean {
  return typeof team?.closedAt === "string";
}

/**
 * How long a closed team stays, read-only, before the purge deletes it: long
 * enough to export it (ADR 0009 gives a canceled team the same 30 days).
 */
export const CLOSED_TEAM_RETENTION_DAYS = 30;

/**
 * A closed team can be reopened (reopenTeam) until this long before its
 * `purgeAfter`. The purge runs hourly and stops starting teams after 4
 * minutes, so a team it may already be deleting can never be reopened.
 */
export const REOPEN_CUTOFF_MINUTES = 60;

/**
 * Times one team may be reopened per UTC day. Each reopening and each
 * closure after it emails every owner, so this bounds how often an owner can
 * make those emails by closing and reopening, without ever silencing a
 * closure notice.
 */
export const REOPENS_PER_TEAM_PER_DAY = 3;

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
 * Invites (new or re-sent) one user may send one address per UTC day, from
 * every team they own together. The same as one team's, so an account that
 * owns many teams can't use up the address's allowance by spreading invites
 * over them.
 */
export const INVITES_PER_USER_ADDRESS_PER_DAY = 3;

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
 * This is the one place the cap is decided. Paid seats don't cap it: the
 * subscription's seat quantity follows the team's billed members instead
 * (supply-checkout-l50, data/seats.ts and billing/seats.ts). A team with a
 * live comp (liveComp) counts as paying.
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
 *   accepts racing for the last place can't both join, and on the team not
 *   being closed.
 * - `owners: -1` is conditional on another owner remaining (ownersUpdate),
 *   or, with `closed`, on the team being closed instead: the last owner may
 *   leave a closed team, which nobody can change any more.
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
  change: { readonly members: 1 | -1; readonly owners?: 1 | -1; readonly cap?: number; readonly counted?: number; readonly closed?: boolean },
) {
  const conditions = ["attribute_exists(PK)"];
  if (change.members > 0) conditions.push("attribute_not_exists(closedAt)");
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
    if (change.owners < 0 && change.closed) conditions.push("attribute_exists(closedAt)");
    else if (change.owners < 0) {
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
