// The account API: what a signed-in user needs before and between teams
// (docs/api/onboarding.md, docs/api/openapi.yaml).
//
//   GET  /me                        The caller's teams (for the switcher) and
//                                   the pending invites for their verified email.
//   POST /teams                     Creates a team with the caller as owner, on
//                                   a 14-day trial. Idempotent per
//                                   Idempotency-Key; rate-limited per user.
//   POST /invites/{inviteId}/accept Joins the team that invited the caller's
//                                   verified email address, with the token
//                                   from the emailed link.
//   GET    /teams/{teamId}/members           Owners: the team's members and roles.
//   PATCH  /teams/{teamId}/members/{userId}  Owners: change a member's role.
//   DELETE /teams/{teamId}/members/{userId}  Owners: remove a member. Anyone:
//                                            leave (their own user ID). Their
//                                            pending invites to the team go too.
//   GET    /teams/{teamId}/invites                     Owners: the team's invites,
//                                                      pending, failed or expired.
//   POST   /teams/{teamId}/invites                     Owners: invite an address with
//                                                      a role, and email it the link.
//   DELETE /teams/{teamId}/invites/{inviteId}          Owners: revoke an invite.
//   POST   /teams/{teamId}/invites/{inviteId}/resend   Owners: a new link and email.
//   POST   /teams/{teamId}/close  Owners: close the team, typing its name to
//                                 confirm. It turns read-only, its invites go,
//                                 and the purge deletes it 30 days later.
//                                 Every owner is emailed the purge date
//                                 (best effort: see noticeOwners).
//   POST   /teams/{teamId}/reopen Owners who are still in a closed team: reopen
//                                 it before the purge, typing its name to
//                                 confirm. It's writable again and leaves the
//                                 purge index; every owner is emailed.
//   DELETE /me                    Delete the caller's account, typing DELETE
//                                 to confirm (see "Deleting an account").
//   POST /me/email/code             Cognito emails the caller a code for their
//                                   unverified address.
//   POST /me/email/verify           Checks the code; Cognito marks the address
//                                   verified, and this records it as the address
//                                   the caller proved (a VERIFIED_EMAIL item in
//                                   their own partition). The app then refreshes
//                                   its tokens, so the pre token generation
//                                   trigger records a linked user's new address,
//                                   and reloads /me. The proven address is
//                                   copied to the caller's MEMBER item in each
//                                   team they're in here, linked user or not,
//                                   and a verified address that changed is
//                                   copied again on /me (keepMemberEmail).
//   POST /me/password               Sets the caller's password (their current
//                                   one, if they have one, confirms it). Once
//                                   an authenticator app is on, Cognito lets
//                                   them sign in only with a password and its
//                                   code, so the app sets one first. The
//                                   account's verified address is emailed
//                                   (see "Security notices" below).
//   POST /me/mfa/totp               A new secret for an authenticator app.
//   POST /me/mfa/totp/verify        Checks a code from the app, turns it on as
//                                   the caller's second factor, and signs
//                                   them out everywhere (see "Two-step
//                                   sign-in" below), then emails the account's
//                                   verified address ("Security notices").
//   POST /me/sign-out-everywhere    Signs the caller out everywhere: what the
//                                   app sends when turning TOTP on couldn't.
//   PATCH /me/preferences           The caller's own app preferences: the What's
//                                   New banner on or off, and the local date it
//                                   was last shown (data/preferences.ts). GET /me
//                                   returns them as `user.preferences` (the
//                                   defaults if they can't be read). Refused
//                                   (409) for an account being deleted.
//
// The team's last owner can't be removed, demoted or leave: the team item's
// owner count moves in the same transaction as the membership, conditioned
// on another owner remaining (data/teams.ts), so two owners demoting each
// other at once can't both succeed.
//
// Isolation, in order:
// 1. API Gateway's JWT authorizer checks the Cognito access token; this handler
//    re-checks it (an access token from our issuer, not expired) and takes the
//    user only from `sub`. Nothing in the path, query or body names a user.
// 2. The email comes from Cognito (GetUser with the caller's own token), and
//    only a verified one lists invites. Accepting also needs the invite's
//    token from the emailed link, checked against the stored hash in the same
//    transaction, so a user who somehow got someone else's address marked
//    verified still can't join without reading that mailbox.
// 3. Every DynamoDB call runs on an account-access role session tagged with the
//    user and, at most, one team and one invitee the request is entitled to
//    (account-db.ts); IAM refuses any other partition.
// 4. Member routes take the team only from the path and check the caller's
//    MEMBER item for it (authorizeTeam) and their role (roles.ts) before
//    anything else. Only after that, and only for a user who is a member of
//    that team, does a session also carry the `member` tag, which lets it
//    update or delete that user's team-switcher row and nothing else in
//    their partition. Likewise, only after an owner's checks does a session
//    carry the `inviteLimit` tag, for the address being invited, which lets it
//    update that address's daily invite counter and nothing else.
//
// Deleting an account (ADR 0007, data/accounts.ts): refused, with nothing
// changed, while the caller is the only owner of an open team that has other
// members (409 `last_owner`: make someone else an owner, or close the team).
// Otherwise the account is marked as being deleted (no more joins), the
// caller leaves every team, closing first any open team they're the only
// member of, a deletion record is written (their user ID, the time and the
// teams it closed, deletions/records.ts: a restore from an older backup deletes
// them again), every invite to their verified email is deleted, their USER#
// rows go (not the LIMIT# counters, left to their TTL), and last their Cognito user, with their own access token
// (DeleteUser: no IAM permission to delete anyone else). Every step is
// idempotent, so a retry after a failure part-way carries on. Each removal
// and closure is audited in its team; the log line has only IDs and counts.
//
// Two-step sign-in (supply-checkout-8jc.12, ADR 0007): the billing routes
// refuse owners without it (billing-handler.ts). Turning it on ends every
// session the caller has (GlobalSignOut, which also makes Cognito's GetUser
// refuse their access tokens, and the billing routes call GetUser), so any
// native session that passes the billing check afterwards began with the
// authenticator's code: with optional MFA, a user with TOTP preferred can
// only sign in natively with a password and the code. Google and Apple users
// (signing in only through their provider) have nothing to set up: the
// provider's sign-in stands in for it, as it does when a user with a provider
// linked signs in through it (docs/infrastructure.md, Sign-in). Passwords,
// secrets and codes are never logged. Once TOTP is on, and before the
// sign-out, the time is recorded in the caller's own partition (TOTP_ON,
// data/two-step.ts), and the billing routes also refuse a session that began
// before it (supply-checkout-8jc.14): that covers a Managed Login session
// cookie from before, which GlobalSignOut doesn't end.
//
// Security notices (supply-checkout-8jc.15): setting up two-step sign-in is
// trust on first use, so someone who got into an account could set a password
// and their own authenticator. After a password is set, and after TOTP is
// turned on (once the sign-out everywhere has run, whether or not it
// finished), the account's verified address is emailed what changed and when
// (noticeAccount). The address is the one Cognito's GetUser returned for the
// caller's own token before the change, verified (verifiedEmail), never one
// from the request. Best effort: the change stands if the email isn't sent,
// which is logged with the user ID, the kind and the error's name only, and
// counted (SecurityNoticeFailures). The send waits at most NOTICE_TIMEOUT_MS.
// The same changes made with direct Cognito calls and the user's own token
// (ChangePassword, VerifySoftwareToken and SetUserMFAPreference), and email
// changes (UpdateUserAttributes and VerifyUserAttribute), are told by the
// security notices function from CloudTrail (identity/security-notices-handler.ts,
// supply-checkout-8jc.28, 8jc.29). So that a change made here isn't emailed
// twice, these routes mark its kind sent once SES has taken the notice
// (markNotice; one that wasn't sent is left to that function), and /me records the account's first verified address, which
// an email change is told to (rememberNoticeAddress).
//
// Seats (supply-checkout-l50): after a membership change commits (an invite
// accepted, a role changed, a member removed or leaving, an account deleted,
// a team reopened), a seat sync for the team's Stripe customer goes on the
// seat sync queue (billing/seats.ts), and the billing worker sets the
// subscription's quantity to the billed members. Only for a team with a
// Stripe customer that isn't closed, and best effort: the change stands, and
// one that couldn't be queued is logged and counted (SeatSyncQueueFailures)
// for the nightly reconciliation to fix. The customer comes from the team's
// own item, never the request.
//
// Closing (supply-checkout-8jc.30): when a team with a Stripe customer closes
// (by an owner, or with its only member's account), a message with reason
// `closed` goes on the same queue, and the billing worker sets the team's
// subscription to cancel at the period's end within seconds, not at the
// hourly purge's next run, so a renewal in that hour isn't charged. A reopen
// right after resumes it (billing/reopening.ts): its seat sync is queued
// behind this one for the same customer. The close never waits on Stripe,
// and a message that couldn't be queued is logged and counted
// (SeatSyncQueueFailures): the purge ends the subscription anyway.
//
// Invite emails: the invite is written first, then sent (email/mailer.ts). If
// SES won't take it, the invite stays, marked failed (`not_sent`), so the
// owner sees "Couldn't deliver" and can re-send or revoke it. Addresses,
// names and tokens never go in a log line or a metric.

import type { APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import {
  acceptInvite,
  authorizeTeam,
  cancelAccountDeletion,
  closeTeam,
  reopenTeam,
  countEmailCode,
  createInvite,
  createTeam,
  deleteInviteForEmail,
  deleteUserRows,
  findInviteForEmail,
  ForbiddenError,
  getInvite,
  getMember,
  DEFAULT_PREFERENCES,
  getPreferences,
  getTeam,
  inviteLimitKey,
  hashEmail,
  type Invite,
  LastOwnerError,
  listMembers,
  type Member,
  MAX_TEAMS_PER_USER,
  memberRole,
  removeMember,
  setMemberRole,
  setOwnMemberEmail,
  listInvites,
  listInvitesForEmail,
  listTeamsForUser,
  markNoticeSent,
  emailSeenHash,
  noticeAddress,
  recordNoticeAddress,
  recordTotpOn,
  hasEnded,
  isTestAccount,
  billingAccess,
  deletionLastDay,
  liveComp,
  mailAddress,
  memberCap,
  REOPEN_CUTOFF_MINUTES,
  markInviteNotSent,
  normalizeEmail,
  PREFERENCE_FIELDS,
  type Preferences,
  preferencesChange,
  setPreferences,
  clearCodeSent,
  codeSentHash,
  recordCodeSent,
  recordVerifiedEmail,
  verifiedEmailHash,
  resendInvite,
  revokeInvite,
  type Role,
  startAccountDeletion,
  type Team,
  TeamClosedError,
  type TeamContext,
  TeamDeletingError,
  TeamFullError,
  teamIdForRequest,
} from "../data/index.js";
import { EmailNotSentError, type Mailer, sendInviteEmail, sendTeamNotice } from "../email/mailer.js";
import type { EmailInput, SecurityNotice } from "../email/templates.js";
import type { DeletionLog } from "../deletions/records.js";
import type { SeatSyncQueue } from "../billing/seat-queue.js";
import { BusinessMetric, type BusinessMetricName, type Observability, testMark } from "../observability/index.js";
import type { DbForAccount } from "./account-db.js";
import type { CognitoUser, DeleteUser, EmailCodes, TotpSetup, UserInfo } from "./cognito-user.js";
import { callerId, type DataEvent, errorFor as dataErrorFor } from "./data-handler.js";
import { accessToken, ApiError, errorResponse, header, json, jsonBody, noContent, notMember } from "./http.js";
import { requireRole } from "./roles.js";
import { ACCOUNT_ROUTES, type AccountRoute, IDEMPOTENCY_HEADER, routeKey } from "./routes.js";

export interface AccountHandlerDeps {
  readonly dbFor: DbForAccount;
  readonly userInfo: UserInfo;
  /** Emails the caller a verification code and checks it (cognito-user.ts). */
  readonly emailCodes: EmailCodes;
  /** Sets the caller's password and authenticator app up, and signs them out everywhere (cognito-user.ts). */
  readonly totp: TotpSetup;
  /** The user pool's issuer URL; tokens from anywhere else are refused. */
  readonly issuerUrl: string;
  readonly obs: Observability;
  /** Sends invite emails (email/mailer.ts). */
  readonly mailer: Mailer;
  /** Deletes the caller's own Cognito user, with their access token (cognito-user.ts). */
  readonly deleteUser: DeleteUser;
  /** Where a deleted account's record goes (deletions/records.ts). */
  readonly deletions: DeletionLog;
  /** Queues a seat sync on the seat sync queue after a membership change (billing/seats.ts). Absent, nothing is queued. */
  readonly seats?: SeatSyncQueue;
  /** How long a security notice may wait on SES (NOTICE_TIMEOUT_MS); for tests. */
  readonly noticeTimeoutMs?: number;
  /**
   * The test mail domain (TEST_MAIL_DOMAIN, data/test-accounts.ts): a team a
   * verified address there creates is a test team, left out of customer
   * metrics. Absent, no account is a test account.
   */
  readonly testMailDomain?: string;
  readonly now?: () => number;
}

const ROUTES = new Map(ACCOUNT_ROUTES.map((r) => [routeKey(r), r.action]));

/** The email code routes count their 5xx answers, for the "Email codes failing" alarm (docs/journeys.md). */
const EMAIL_CODE_FAILURES: Partial<Record<AccountRoute["action"], BusinessMetricName>> = {
  sendEmailCode: BusinessMetric.EmailCodeSendFailures,
  verifyEmail: BusinessMetric.EmailCodeVerifyFailures,
};
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;
/** Cognito's verification codes are 6 digits, as are an authenticator app's. */
const EMAIL_CODE = /^[0-9]{6}$/;
/** Cognito's password limit; the pool's policy (12+, mixed) is Cognito's to check. */
const MAX_PASSWORD = 256;
/** How many times turning TOTP on tries to sign the user out everywhere. */
const SIGN_OUT_ATTEMPTS = 3;
/** The wait before each try after the first, times the tries so far. */
const SIGN_OUT_BACKOFF_MS = 100;

/** The data layer's errors, as the account routes answer them. */
export function errorFor(error: unknown): ApiError {
  if (error instanceof TeamClosedError) return new ApiError(403, "permission_denied", error.message, "team_closed");
  if (error instanceof TeamDeletingError) return new ApiError(409, "aborted", error.message, "team_deleting");
  if (error instanceof LastOwnerError) return new ApiError(409, "aborted", error.message, "last_owner");
  if (error instanceof TeamFullError) return new ApiError(429, "quota_exceeded", error.message, "team_full");
  // Here a ForbiddenError is about membership or an invite, never view-only access
  if (error instanceof ForbiddenError) return new ApiError(403, "permission_denied", error.message);
  return dataErrorFor(error);
}

/**
 * A team as /me and the create and accept routes return it. `comp` is a live
 * comp from support (ADR 0015): while it's there, the team is active on its
 * plan whatever `status` says. Who granted it and why aren't shown here.
 * `members` and `memberCap` are for the members screen's seat count
 * (`members` is null on a team from before the count), and `reopenBy` is when
 * a closed team stops being reopenable (REOPEN_CUTOFF_MINUTES before it's
 * deleted). `subscriptionEnded` says the team is read-only for billing
 * (billingAccess), and `readOnlyReason` why: `trial_ended`,
 * `subscription_ended` (an owner subscribes) or `payment_overdue` (an owner
 * pays in Billing). `readOnlyDeletesAt` is when such a team is closed and
 * deleted unless it subscribes (after its date has ended everywhere), and
 * `readOnlyLastDay` the date to show for it (YYYY-MM-DD, the last day it's
 * kept, as the emails say: not readOnlyDeletesAt's local date; null once
 * readOnlyDeletesAt has passed), and `paymentGraceEndsAt` when a `past_due`
 * team still in its grace period becomes read-only. `billingAccount` says the team
 * has a Stripe customer, so its owners can open the Customer Portal, and
 * `cancelsAt` when a subscription that was canceled (in the portal) ends: its
 * current period's end, until then.
 */
export function teamBody(team: Team, role: Role, now = new Date()) {
  const comp = liveComp(team, now);
  const access = billingAccess(team, now);
  const deletesAt = team.closedAt ? (team.purgeAfter ?? null) : null;
  // A purgeAfter that isn't a date gives no reopenBy rather than failing all of /me
  const purgeMs = deletesAt ? Date.parse(deletesAt) : NaN;
  return {
    id: team.teamId,
    name: team.name,
    role,
    plan: team.plan,
    status: team.status,
    trialEndsAt: team.trialEndsAt ?? null,
    homeRegion: team.homeRegion,
    // A closed team is read-only until deletesAt, when the purge deletes it
    closedAt: team.closedAt ?? null,
    deletesAt,
    reopenBy: Number.isFinite(purgeMs) ? new Date(purgeMs - REOPEN_CUTOFF_MINUTES * 60_000).toISOString() : null,
    comp: comp ? { plan: comp.plan, until: comp.until } : null,
    // Read-only for billing (and no comp keeps it going): an owner subscribes again, or pays
    subscriptionEnded: access.readOnly,
    readOnlyReason: access.reason ?? null,
    readOnlyDeletesAt: access.deleteAfter ?? null,
    // The date to show for it: the last day it's kept (the emails state the same). Not once that's passed: the team
    // is closed as soon as its warning's 7 days are up, which the warning email states
    readOnlyLastDay: access.deleteAfter && Date.parse(access.deleteAfter) > now.getTime() ? deletionLastDay(access.deleteAfter) : null,
    paymentGraceEndsAt: access.graceEndsAt ?? null,
    // The Customer Portal needs the team's Stripe customer (made by its first checkout)
    billingAccount: typeof team.stripeCustomerId === "string",
    // Canceled but not ended yet: it ends with the current period
    cancelsAt: team.cancelAtPeriodEnd === true && !hasEnded(team.status) && typeof team.currentPeriodEnd === "string" ? team.currentPeriodEnd : null,
    members: typeof team.members === "number" ? team.members : null,
    memberCap: memberCap(team, now),
  };
}

/** What /me shows of an invite: enough to offer it, not to accept it (that needs the emailed token). */
const inviteBody = (invite: Invite) => ({
  id: invite.inviteId,
  teamName: invite.teamName,
  role: invite.role,
  expiresAt: new Date(invite.expiresAt * 1000).toISOString(),
});

/**
 * An invite as its team's owners see it: the address, role and state, never
 * the token or its hash. `inviteStatus` is `failed` when its email bounced,
 * drew a complaint or couldn't be sent (`failureReason`), `expired` once it
 * lapsed, and `pending` otherwise.
 */
const teamInviteBody = (invite: Invite, nowMs: number) => ({
  id: invite.inviteId,
  email: invite.email,
  role: invite.role,
  createdAt: invite.createdAt,
  expiresAt: new Date(invite.expiresAt * 1000).toISOString(),
  inviteStatus: invite.inviteStatus === "failed" ? "failed" : invite.expiresAt * 1000 <= nowMs ? "expired" : "pending",
  failureReason: invite.inviteStatus === "failed" ? (invite.failureReason ?? null) : null,
  failedAt: invite.inviteStatus === "failed" ? (invite.failedAt ?? null) : null,
});

const ROLE_ORDER = { owner: 0, contributor: 1, viewer: 2 };

/** What the caller types to confirm deleting their account (any case). */
export const DELETE_CONFIRMATION = "DELETE";

/** Why an account can't be deleted yet: the teams it's the only owner of, by name (at most three). */
function lastOwnerOf(names: string[]): string {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const shown = sorted.slice(0, 3).join(", ") + (sorted.length > 3 ? ` and ${sorted.length - 3} more` : "");
  return `You're the only owner of ${shown}. Make someone else an owner, or close the team, before you delete your account.`;
}

/** A member as the members routes return them: never the stored item as is. */
const memberBody = (member: Member) => ({ userId: member.userId, email: member.email ?? null, role: member.role, joinedAt: member.joinedAt ?? null });

/** Two addresses the same but for ASCII case and surrounding space, and neither empty. */
const sameAddress = (a?: string, b?: string) => !!a?.trim() && !!b?.trim() && verifiedEmailHash(a) === verifiedEmailHash(b);

const emailChanged = () => new ApiError(409, "aborted", "Your email address changed while it was being verified; send a new code", "email_changed");

/**
 * Two-step sign-in, as /me says it: `totp` (an authenticator app is on),
 * `provider` (a Google or Apple user, whose provider's sign-in counts for it),
 * or `off`.
 */
export const mfaState = (user: Pick<CognitoUser, "totp" | "federated">) => (user.federated ? "provider" : user.totp ? "totp" : "off");

/** Refuses the setup routes to a Google or Apple user: their provider's sign-in counts, and Cognito would never ask them for a code. */
function nativeOnly(user: CognitoUser): void {
  if (user.federated) throw new ApiError(409, "aborted", "You sign in with Google or Apple, so there's no authenticator to set up", "federated_sign_in");
}

/** The verified email, normalized, or undefined if Cognito hasn't verified one. */
function verifiedEmail(user: CognitoUser): string | undefined {
  if (!user.emailVerified || !user.email) return undefined;
  try {
    return normalizeEmail(user.email);
  } catch {
    return undefined;
  }
}

/** An email to every owner about a change to the team (noticeOwners). */
type TeamNotice = Extract<EmailInput, { kind: "teamClosed" | "teamReopened" }>;

/** The metrics and warning of one kind of owner notice. */
interface NoticeMetrics {
  readonly sent: BusinessMetricName;
  readonly failures: BusinessMetricName;
  readonly log: string;
}

const CLOSED_NOTICES: NoticeMetrics = { sent: BusinessMetric.TeamClosedNotices, failures: BusinessMetric.TeamClosedNoticeFailures, log: "Team closure emails not sent" };
const REOPENED_NOTICES: NoticeMetrics = { sent: BusinessMetric.TeamReopenedNotices, failures: BusinessMetric.TeamReopenedNoticeFailures, log: "Team reopened emails not sent" };

/** An email to the account's own verified address about a change to how it signs in (noticeAccount). */
type AccountNotice = Exclude<SecurityNotice["kind"], "passwordReset">;

/** How long a security notice may wait on SES before the change is answered without it. */
const NOTICE_TIMEOUT_MS = 3000;

export function createAccountHandler(deps: AccountHandlerDeps) {
  const now = deps.now ?? Date.now;
  const { dbFor, obs } = deps;

  /** The caller as Cognito sees them now, from their own access token. */
  async function cognitoUser(event: DataEvent, userId: string): Promise<CognitoUser> {
    const user = await deps.userInfo(accessToken(event));
    // The same user API Gateway verified, or something is badly wrong
    if (user.sub !== userId) throw new ApiError(401, "unauthenticated", "Sign in again");
    return user;
  }

  async function me(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const user = await cognitoUser(event, userId);
    const email = verifiedEmail(user);
    const own = dbFor({ userId, invitee: email && hashEmail(email) });
    const [rows, invites, preferences] = await Promise.all([
      listTeamsForUser(own, userId),
      email ? listInvitesForEmail(own, email, new Date(now())) : [],
      ownPreferences(own, userId),
      email ? rememberNoticeAddress(own, userId, email, user.email ?? email) : undefined,
    ]);
    // Each team's details on a session for that team, after the membership
    // check: a stale switcher row (a removed member) shows nothing. Capped, so
    // one request never needs more role sessions than that.
    const teams = (
      await Promise.all(
        rows.slice(0, MAX_TEAMS_PER_USER).map(async (row) => {
          const db = dbFor({ userId, teamId: row.teamId });
          const ctx = await authorizeTeam(db, userId, row.teamId, new Date(now())).catch((error: unknown) => {
            if (error instanceof ForbiddenError) return undefined;
            throw error;
          });
          if (!ctx) return undefined;
          if (email) await keepMemberEmail(db, ctx, email);
          return teamBody(await getTeam(db, ctx), ctx.role, new Date(now()));
        }),
      )
    )
      .filter((t) => t !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const joined = new Set(teams.map((t) => t.id));
    return json(200, {
      user: { id: userId, email: user.email ?? null, emailVerified: email !== undefined, mfa: mfaState(user), preferences },
      teams,
      invites: invites.filter((i) => !joined.has(i.teamId)).map(inviteBody),
    });
  }

  /**
   * Brings the caller's MEMBER email in one team up to their verified address
   * (supply-checkout-xv3k): the members list and owner notices read it, and it
   * was copied when they joined. Reads first, so an address already current
   * costs no write. Closed teams are left as they are. Best effort: a failure
   * is logged (the team ID and error name only) and the request goes on.
   */
  async function keepMemberEmail(db: ReturnType<DbForAccount>, ctx: TeamContext, email: string): Promise<void> {
    if (ctx.closed) return;
    // Two /me calls at once, around an address change, could each read and write: the
    // last write wins, and if it carried the older address the next /me corrects it
    // (both only ever write an address Cognito verified for this user). Self-healing.
    try {
      const member = await getMember(db, ctx, ctx.userId);
      if (member && member.email !== email) await setOwnMemberEmail(db, ctx, email);
    } catch (error) {
      obs.logger.warn("Member email not updated", { teamId: ctx.teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
    }
  }

  /**
   * Records the caller's verified address as the one an email change is told
   * to (NOTICE_ADDRESS, data/security-notices.ts), the first time there is
   * one. Never replaces it: after an email change, only the security notices
   * function moves it, once it has told the old address, so someone who
   * changed the email and then loads the app can't, and never for an account
   * being deleted (recordNoticeAddress checks its DELETING mark in the same
   * transaction, so a /me racing a deletion can't leave an address behind).
   * Also records Cognito's own address as it was (emailSeenHash), which is
   * what the notices function compares. Reads first, so an
   * account that has one costs no write. Best effort: a failure is logged
   * (the user ID and error name only) and /me goes on.
   */
  async function rememberNoticeAddress(db: ReturnType<DbForAccount>, userId: string, email: string, cognitoEmail: string): Promise<void> {
    try {
      if (!(await noticeAddress(db, userId))) await recordNoticeAddress(db, userId, email, emailSeenHash(cognitoEmail), new Date(now()));
    } catch (error) {
      obs.logger.warn("Notice address not recorded", { userId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
    }
  }

  /** keepMemberEmail in every team the caller is in (their own USER# rows), each on a session for that team after the membership check. */
  async function keepMemberEmails(userId: string, email: string): Promise<void> {
    const rows = await listTeamsForUser(dbFor({ userId }), userId);
    await Promise.all(
      rows.slice(0, MAX_TEAMS_PER_USER).map(async (row) => {
        const db = dbFor({ userId, teamId: row.teamId });
        const ctx = await authorizeTeam(db, userId, row.teamId, new Date(now())).catch((error: unknown) => {
          if (error instanceof ForbiddenError) return undefined;
          throw error;
        });
        if (ctx) await keepMemberEmail(db, ctx, email);
      }),
    );
  }

  async function newTeam(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const key = header(event, IDEMPOTENCY_HEADER);
    if (!key || !REQUEST_KEY.test(key)) throw new ApiError(400, "bad_request", "Send an Idempotency-Key header: 8 to 128 letters, digits, - or _, new for each team");
    const body = jsonBody(event, ["name"]);
    const user = await cognitoUser(event, userId);
    const db = dbFor({ userId, teamId: teamIdForRequest(userId, key) });
    // A test account (its verified address, from Cognito, at the test mail domain) makes a test team: metrics only
    const test = isTestAccount(user, deps.testMailDomain);
    const { team, context, created } = await createTeam(db, { userId, email: verifiedEmail(user), test }, { name: body.name as string, requestKey: key }, new Date(now()));
    if (created) obs.count(BusinessMetric.SignUps, 1, { teamId: team.teamId, ...testMark(team.test) });
    return json(created ? 201 : 200, { team: teamBody(team, context.role) });
  }

  async function accept(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const inviteId = event.pathParameters?.inviteId;
    if (typeof inviteId !== "string" || !ID.test(inviteId)) throw new ApiError(400, "bad_request", "Invalid invite ID");
    const token = event.body ? jsonBody(event, ["token"]).token : undefined;
    const email = verifiedEmail(await cognitoUser(event, userId));
    if (!email) throw new ApiError(403, "permission_denied", "Verify your email address to accept invites");
    const at = new Date(now());
    const invite = await findInviteForEmail(dbFor({ userId, invitee: hashEmail(email) }), email, inviteId, at);
    // Unknown, expired, used, for someone else, or no token: one answer for all
    if (!invite || typeof token !== "string") throw new ApiError(404, "not_found", "This invite has expired, was already used, or is for another email address");
    const db = dbFor({ userId, teamId: invite.teamId });
    const ctx = await acceptInvite(db, { userId, verifiedEmail: email }, invite, token, at);
    obs.count(BusinessMetric.InvitesAccepted, 1, { teamId: ctx.teamId, ...testMark(ctx.test) });
    const team = await getTeam(db, ctx);
    await queueSeatSync(ctx.teamId, team);
    return json(200, { team: teamBody(team, ctx.role) });
  }

  /** A path parameter that must be an ID, or 400. */
  function pathId(event: DataEvent, name: string, what: string): string {
    const value = event.pathParameters?.[name];
    if (typeof value !== "string" || !ID.test(value)) throw new ApiError(400, "bad_request", `Invalid ${what}`);
    return value;
  }

  /** The caller's context for the path's team, or 403 `not_member` (the same for a team that doesn't exist). */
  async function teamContext(event: DataEvent, userId: string): Promise<{ teamId: string; ctx: TeamContext }> {
    const teamId = pathId(event, "teamId", "team ID");
    const ctx = await authorizeTeam(dbFor({ userId, teamId }), userId, teamId, new Date(now())).catch((error: unknown) => {
      if (error instanceof ForbiddenError) throw notMember();
      throw error;
    });
    return { teamId, ctx };
  }

  /**
   * The member the path names, checked to be in the team, and a handle that
   * may also update or delete their team-switcher row. Call only after the
   * caller's role check.
   */
  async function targetMember(event: DataEvent, userId: string, teamId: string, ctx: TeamContext) {
    const target = pathId(event, "userId", "user ID");
    if (!(await getMember(dbFor({ userId, teamId }), ctx, target))) throw new ApiError(404, "not_found", "That person isn't a member of this team");
    return { target, db: dbFor({ userId, teamId, member: target === userId ? undefined : target }) };
  }

  async function members(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const { teamId, ctx } = await teamContext(event, userId);
    requireRole(ctx.role, "owner");
    const list = (await listMembers(dbFor({ userId, teamId }), ctx))
      .map(memberBody)
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.email ?? "").localeCompare(b.email ?? "") || a.userId.localeCompare(b.userId));
    return json(200, { members: list });
  }

  async function changeRole(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    // Membership and role first, so anyone else gets the same 403 whatever they send
    const { teamId, ctx } = await teamContext(event, userId);
    requireRole(ctx.role, "owner");
    const role = memberRole(jsonBody(event, ["role"]).role);
    const { target, db } = await targetMember(event, userId, teamId, ctx);
    await setMemberRole(db, ctx, target, role);
    await seatsAfterChange(db, ctx);
    const member = await getMember(db, ctx, target);
    if (!member) throw new ApiError(409, "aborted", "That person was removed from the team just now");
    return json(200, { member: memberBody(member) });
  }

  async function remove(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const { teamId, ctx } = await teamContext(event, userId);
    // Anyone can leave; only owners remove someone else
    const leaving = pathId(event, "userId", "user ID") === userId;
    if (!leaving) requireRole(ctx.role, "owner");
    const { target, db } = await targetMember(event, userId, teamId, ctx);
    // Leaving also revokes invites to the caller's verified address now, whatever their member item holds.
    // Best effort: if Cognito can't say (an outage, throttling), leaving still works, with the member item's address
    const email = leaving
      ? await cognitoUser(event, userId)
          .then(verifiedEmail)
          .catch((error: unknown) => {
            obs.logger.warn("Verified email not read for leaving", { teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
            return undefined;
          })
      : undefined;
    await removeMember(db, ctx, target, email ? { verifiedEmail: email } : {});
    await seatsAfterChange(db, ctx);
    return noContent();
  }

  /**
   * Queues a seat sync for the team's Stripe customer (see "Seats" at the
   * top), if it has one and isn't closed. Never throws: a failure is logged
   * (the error's name only) and counted.
   */
  async function queueSeatSync(teamId: string, team: Pick<Team, "stripeCustomerId" | "closedAt">): Promise<void> {
    if (!deps.seats || !team.stripeCustomerId || team.closedAt) return;
    try {
      await deps.seats(team.stripeCustomerId, "membership");
    } catch (error) {
      obs.logger.warn("Seat sync not queued", { teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
      obs.count(BusinessMetric.SeatSyncQueueFailures, 1, { teamId });
    }
  }

  /** Asks the billing worker to end a team's subscription now that it has closed (see "Closing" at the top). Never throws. */
  async function queueClosedSync(teamId: string, team: Pick<Team, "stripeCustomerId">): Promise<void> {
    if (!deps.seats || !team.stripeCustomerId) return;
    try {
      await deps.seats(team.stripeCustomerId, "closed");
      obs.logger.info("Closed team's subscription end queued", { teamId });
    } catch (error) {
      obs.logger.warn("Closed team's subscription end not queued", { teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
      obs.count(BusinessMetric.SeatSyncQueueFailures, 1, { teamId, reason: "closed" });
    }
  }

  /** queueSeatSync after a change to the team's members, reading the team as it is now. Never throws. */
  async function seatsAfterChange(db: ReturnType<DbForAccount>, ctx: TeamContext): Promise<void> {
    if (!deps.seats) return;
    const team = await getTeam(db, ctx).catch((error: unknown) => {
      obs.logger.warn("Seat sync not queued", { teamId: ctx.teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
      obs.count(BusinessMetric.SeatSyncQueueFailures, 1, { teamId: ctx.teamId });
      return undefined;
    });
    if (team) await queueSeatSync(ctx.teamId, team);
  }

  /** An owner's context for the path's team, or 403. */
  async function ownerContext(event: DataEvent, userId: string): Promise<{ teamId: string; ctx: TeamContext }> {
    const found = await teamContext(event, userId);
    requireRole(found.ctx.role, "owner");
    return found;
  }

  /**
   * Emails a new or re-sent invite its link. When SES won't take it, the
   * invite is marked failed and returned that way: it exists, and the owner
   * can re-send or revoke it. Only the error's name is logged.
   */
  async function send(db: ReturnType<DbForAccount>, ctx: TeamContext, invite: Invite, token: string): Promise<Invite> {
    try {
      await sendInviteEmail(deps.mailer, invite, token);
      obs.count(BusinessMetric.InvitesSent, 1, { teamId: ctx.teamId, ...testMark(ctx.test) });
      return invite;
    } catch (error) {
      const code = error instanceof EmailNotSentError ? error.code : ((error as { name?: string } | null)?.name ?? "Unknown");
      obs.logger.warn("Invite email not sent", { teamId: ctx.teamId, inviteId: invite.inviteId, code });
      const at = new Date(now());
      await markInviteNotSent(db, ctx, invite.inviteId, at);
      obs.count(BusinessMetric.InvitesFailed, 1, { teamId: ctx.teamId, reason: "not_sent", ...testMark(ctx.test) });
      return { ...invite, inviteStatus: "failed", failureReason: "not_sent", failedAt: at.toISOString() };
    }
  }

  async function invites(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const { teamId, ctx } = await ownerContext(event, userId);
    const at = now();
    const list = (await listInvites(dbFor({ userId, teamId }), ctx))
      .map((invite) => teamInviteBody(invite, at))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return json(200, { invites: list });
  }

  async function invite(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    // Membership and role first, so anyone else gets the same 403 whatever they send
    const { teamId, ctx } = await ownerContext(event, userId);
    const body = jsonBody(event, ["email", "role"]);
    const email = mailAddress(body.email);
    const role = memberRole(body.role);
    const db = dbFor({ userId, teamId, inviteLimit: inviteLimitKey(email) });
    const made = await createInvite(db, ctx, { email, role }, new Date(now()));
    return json(201, { invite: teamInviteBody(await send(db, ctx, made.invite, made.token), now()) });
  }

  async function revoke(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const { teamId, ctx } = await ownerContext(event, userId);
    await revokeInvite(dbFor({ userId, teamId }), ctx, pathId(event, "inviteId", "invite ID"));
    return noContent();
  }

  async function resend(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const { teamId, ctx } = await ownerContext(event, userId);
    const inviteId = pathId(event, "inviteId", "invite ID");
    if (event.body) jsonBody(event, []);
    // The address comes from the stored invite, never the request
    const old = await getInvite(dbFor({ userId, teamId }), ctx, inviteId);
    if (!old) throw new ApiError(404, "not_found", "This invite was accepted or revoked");
    const db = dbFor({ userId, teamId, inviteLimit: inviteLimitKey(old.email) });
    const made = await resendInvite(db, ctx, inviteId, {}, new Date(now()));
    return json(201, { invite: teamInviteBody(await send(db, ctx, made.invite, made.token), now()) });
  }

  /** An owner closes the team, typing its name to confirm. Closing a closed team returns it as it is. */
  async function close(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    // Membership and role first, so anyone else gets the same 403 whatever they send
    const { teamId, ctx } = await ownerContext(event, userId);
    const body = jsonBody(event, ["name"]);
    const db = dbFor({ userId, teamId });
    const { team, closedNow } = await closeTeam(db, ctx, { confirmName: body.name as string }, new Date(now()));
    if (closedNow) {
      obs.count(BusinessMetric.TeamsClosed, 1, { teamId, ...testMark(ctx.test) });
      obs.logger.info("Team closed", { teamId, purgeAfter: team.purgeAfter ?? "" });
      await queueClosedSync(teamId, team);
      await noticeOwners(db, ctx, { kind: "teamClosed", teamName: team.name, purgeAfter: team.purgeAfter as string }, CLOSED_NOTICES);
    }
    return json(200, { team: teamBody(team, ctx.role) });
  }

  /**
   * An owner who is still in a closed team reopens it before the purge, typing its name
   * to confirm. Reopening a team that isn't closed returns it as it is.
   */
  async function reopen(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    // Membership and role first, so anyone else gets the same 403 whatever they send
    const { teamId, ctx } = await ownerContext(event, userId);
    const body = jsonBody(event, ["name"]);
    const db = dbFor({ userId, teamId });
    const { team, reopenedNow } = await reopenTeam(db, ctx, { confirmName: body.name as string }, new Date(now()));
    if (reopenedNow) {
      obs.count(BusinessMetric.TeamsReopened, 1, { teamId, ...testMark(ctx.test) });
      obs.logger.info("Team reopened", { teamId });
      // Members may have left while it was closed
      await queueSeatSync(teamId, team);
      await noticeOwners(db, ctx, { kind: "teamReopened", teamName: team.name }, REOPENED_NOTICES);
    }
    return json(200, { team: teamBody(team, ctx.role) });
  }

  /**
   * Emails every owner of a team that just closed (with the day the purge deletes it) or
   * was reopened, so a change one owner didn't make (or a compromised account made)
   * doesn't go unnoticed. Best effort: the change stands either way, and each owner who
   * wasn't emailed (SES refused it, no address on file, or the owners couldn't be listed)
   * is counted in the failures metric. Only IDs, counts and SES error names are logged.
   */
  async function noticeOwners(db: ReturnType<DbForAccount>, ctx: TeamContext, input: TeamNotice, metrics: NoticeMetrics): Promise<void> {
    const { teamId } = ctx;
    const test = testMark(ctx.test);
    let owners: Member[];
    try {
      owners = (await listMembers(db, ctx)).filter((m) => m.role === "owner");
    } catch (error) {
      obs.logger.warn(metrics.log, { teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
      obs.count(metrics.failures, 1, { teamId, reason: "not_listed", ...test });
      return;
    }
    const results = await Promise.allSettled(
      owners.map((owner) => (owner.email ? sendTeamNotice(deps.mailer, owner.email, teamId, input) : Promise.reject(new EmailNotSentError("NoAddress")))),
    );
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (results.length > failed.length) obs.count(metrics.sent, results.length - failed.length, { teamId, ...test });
    if (failed.length) {
      const codes = [...new Set(failed.map((r) => (r.reason instanceof EmailNotSentError ? r.reason.code : ((r.reason as { name?: string } | null)?.name ?? "Unknown"))))];
      obs.logger.warn(metrics.log, { teamId, failed: failed.length, owners: owners.length, codes: codes.join(",") });
      obs.count(metrics.failures, failed.length, { teamId, reason: "not_sent", ...test });
    }
  }

  /**
   * Emails the caller's verified address that their password was set or two-step sign-in
   * turned on (see "Security notices" at the top). `user` is what GetUser said for the
   * caller's own token before the change. Never throws.
   */
  async function noticeAccount(user: CognitoUser, userId: string, kind: AccountNotice): Promise<void> {
    const to = verifiedEmail(user);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!to) throw new EmailNotSentError("NoAddress");
      // Bounded: a slow SES mustn't turn a change that's made into a 5xx (and a retried
      // password change into password_mismatch). One that times out may still arrive
      await Promise.race([
        deps.mailer.send(to, { kind, at: new Date(now()).toISOString() }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new EmailNotSentError("Timeout")), deps.noticeTimeoutMs ?? NOTICE_TIMEOUT_MS);
        }),
      ]);
      obs.count(BusinessMetric.SecurityNotices, 1, { kind });
      // Only once it's sent: a notice that didn't go out leaves the CloudTrail copy to send it
      await markNotice(userId, kind);
    } catch (error) {
      const code = error instanceof EmailNotSentError ? error.code : ((error as { name?: string } | null)?.name ?? "Unknown");
      obs.logger.warn("Security notice not sent", { userId, kind, code });
      obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind, reason: to ? "not_sent" : "no_address" });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Marks a notice of `kind` as sent, once SES has taken it, so the security
   * notices function doesn't email it again when CloudTrail's record of the
   * call reaches it (see "Security notices" at the top). One that wasn't sent
   * isn't marked, so that copy sends it. Never throws: without the mark the
   * account may get two emails, which is better than failing a change that's
   * made.
   */
  async function markNotice(userId: string, kind: AccountNotice): Promise<void> {
    try {
      await markNoticeSent(dbFor({ userId }), userId, kind, new Date(now()));
    } catch (error) {
      obs.logger.warn("Security notice not marked", { userId, kind, code: (error as { name?: string } | null)?.name ?? "Unknown" });
    }
  }

  /** Deletes the caller's account (see "Deleting an account" at the top). */
  async function deleteAccount(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const body = jsonBody(event, ["confirm"]);
    if (typeof body.confirm !== "string" || body.confirm.trim().toUpperCase() !== DELETE_CONFIRMATION) {
      throw new ApiError(400, "bad_request", `Type ${DELETE_CONFIRMATION} to confirm`);
    }
    const token = accessToken(event);
    const user = await cognitoUser(event, userId);
    const email = verifiedEmail(user);
    // Read before the Cognito user goes: a test account's deletion is left out of the metric
    const test = isTestAccount(user, deps.testMailDomain);
    const invitee = email && hashEmail(email);
    const own = dbFor({ userId, invitee });
    const at = new Date(now());
    // No joins from here on, so the teams listed next are all of them
    await startAccountDeletion(own, userId, at);
    const rows = await listTeamsForUser(own, userId);
    const found = await Promise.all(
      rows.map(async (row) => {
        const db = dbFor({ userId, teamId: row.teamId });
        const ctx = await authorizeTeam(db, userId, row.teamId, new Date(now())).catch((error: unknown) => {
          // A stale switcher row: deleteUserRows removes it
          if (error instanceof ForbiddenError) return undefined;
          throw error;
        });
        if (!ctx) return undefined;
        const team = await getTeam(db, ctx);
        const soleOwner = ctx.role === "owner" && !team.closedAt && team.owners <= 1;
        // A team from before the member count: count its members
        const members = !soleOwner ? 0 : typeof team.members === "number" ? team.members : (await listMembers(db, ctx)).length;
        return { db, ctx, team, soleOwner, alone: soleOwner && members <= 1 };
      }),
    );
    const teams = found.filter((t) => t !== undefined);
    const blocking = teams.filter((t) => t.soleOwner && !t.alone).map((t) => t.team.name);
    if (blocking.length) {
      await cancelAccountDeletion(own, userId);
      throw new ApiError(409, "aborted", lastOwnerOf(blocking), "last_owner");
    }
    // Each team on its own: one that fails doesn't stop the others, and a retry carries on
    const left = await Promise.allSettled(
      teams.map(async ({ db, ctx, team, alone }) => {
        if (alone) {
          // Only while they're still alone in it: someone who joined meanwhile makes it a ConflictError
          const { closedNow } = await closeTeam(db, ctx, { confirmName: team.name, onlyMember: true }, at);
          if (closedNow) {
            obs.count(BusinessMetric.TeamsClosed, 1, { teamId: ctx.teamId, ...testMark(ctx.test) });
            await queueClosedSync(ctx.teamId, team);
          }
        }
        await removeMember(db, ctx, userId, { reason: "account_deleted" }, at);
        // A team it closed has nothing left to bill
        if (!alone) await queueSeatSync(ctx.teamId, team);
      }),
    );
    const failed = left.find((r) => r.status === "rejected");
    if (failed) {
      // Not stuck unable to join for the mark's 30 days: a retry marks the account again
      // before it lists the teams, so taking the mark away here loses nothing. (The
      // teams already left stay left.)
      await cancelAccountDeletion(own, userId);
      throw (failed as PromiseRejectedResult).reason;
    }
    // Once nothing can refuse the deletion, and before their rows and Cognito user go.
    // A retry keeps the first record (and the teams it closed)
    await deps.deletions.record({ kind: "user", id: userId, deletedAt: at.toISOString(), teamsClosed: teams.filter((t) => t.alone).map((t) => t.ctx.teamId) });
    const invites = email ? await listInvitesForEmail(own, email, at, { includeExpired: true }) : [];
    for (const invite of invites) await deleteInviteForEmail(dbFor({ userId, teamId: invite.teamId, invitee }), email as string, invite);
    const rowsDeleted = await deleteUserRows(own, userId);
    // Last: until it's gone the user can sign in and try again
    await deps.deleteUser(token);
    obs.count(BusinessMetric.AccountsDeleted, 1, testMark(test));
    obs.logger.info("Account deleted", { userId, teamsLeft: teams.length, teamsClosed: teams.filter((t) => t.alone).length, invitesDeleted: invites.length, rowsDeleted });
    return noContent();
  }

  /**
   * Cognito emails the caller a code for their address. Only for an address
   * that doesn't count as verified yet (for a linked user, one that isn't the
   * recorded one), so it can't be used to send mail for nothing. Once it's
   * sent, records the address the code went to (EMAIL_CODE_SENT,
   * data/verified-email.ts), if GetUser shows the same address before and
   * after the send; otherwise 409 `email_changed` and nothing is recorded, so
   * that code can't prove anything (supply-checkout-cjw7).
   */
  async function sendEmailCode(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    if (event.body) jsonBody(event, []);
    const user = await cognitoUser(event, userId);
    if (!user.email) throw new ApiError(400, "bad_request", "There's no email address to verify");
    if (verifiedEmail(user)) throw new ApiError(409, "aborted", "Your email address is already verified", "already_verified");
    await countEmailCode(dbFor({ userId }), userId, new Date(now()));
    await deps.emailCodes.send(accessToken(event));
    const after = await cognitoUser(event, userId);
    if (!sameAddress(user.email, after.email)) {
      obs.logger.warn("Email code's address not recorded", { outcome: "email-changed" });
      throw emailChanged();
    }
    await recordCodeSent(dbFor({ userId }), userId, user.email, new Date(now()));
    return noContent();
  }

  /**
   * Checks the code from the email. Cognito's answer says whether it was
   * right; the code is never logged. Then records the address as the one the
   * caller proved (data/verified-email.ts), which is what lets the pre token
   * generation trigger record a linked user's address (supply-checkout-ytr2).
   * Only for the address the code was sent to through the API, less than a
   * day ago: GetUser must show that address before the code goes to Cognito
   * (or Cognito isn't asked at all) and after it, verified. So neither a
   * provider's rewrite between sending and checking the code, nor one while
   * it's checked, gets another address recorded, even if Cognito accepted
   * the code for it (supply-checkout-cjw7). Otherwise 409 `email_changed`:
   * send a new code. A used code's record is deleted either way.
   */
  async function verifyEmail(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const code = jsonBody(event, ["code"]).code;
    if (typeof code !== "string" || !EMAIL_CODE.test(code)) throw new ApiError(400, "bad_request", "Enter the 6-digit code from the email", "code_mismatch");
    const before = await cognitoUser(event, userId);
    if (verifiedEmail(before)) throw new ApiError(409, "aborted", "Your email address is already verified", "already_verified");
    const own = dbFor({ userId });
    const sent = await codeSentHash(own, userId, new Date(now()));
    if (!sent || !before.email?.trim() || verifiedEmailHash(before.email) !== sent) {
      obs.logger.warn("Verified email not recorded", { outcome: sent ? "not-sent-address" : "no-code-sent" });
      throw emailChanged();
    }
    await deps.emailCodes.verify(accessToken(event), code);
    const after = await cognitoUser(event, userId);
    const recorded = after.emailVerifiedInCognito && sameAddress(before.email, after.email) && (await recordVerifiedEmail(own, userId, before.email, new Date(now())));
    if (!recorded) {
      await clearCodeSent(own, userId);
      obs.logger.warn("Verified email not recorded", { outcome: after.emailVerifiedInCognito ? "email-changed" : "not-verified" });
      throw emailChanged();
    }
    // The address the code just proved, copied to the caller's member items
    // now (supply-checkout-mcnv). For a linked user too: their address counts
    // for invites only once the trigger records it at the next token refresh,
    // but a client that refreshes without loading /me would otherwise leave
    // the old one on their member items. It's the address the code was sent
    // to and Cognito verified, the same proof the trigger records, and a
    // member item's email only names the member (the members list, owner
    // notices); it's never what entitles anyone to an invite.
    try {
      await keepMemberEmails(userId, normalizeEmail(before.email));
    } catch (error) {
      obs.logger.warn("Member emails not updated", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
    }
    return noContent();
  }

  /**
   * Sets the caller's password. `currentPassword` is theirs if they have one;
   * a user who has only ever signed in with an email code or a passkey sends
   * none. Cognito checks both, and the password policy.
   */
  async function setPassword(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const body = jsonBody(event, ["password", "currentPassword"]);
    const { password, currentPassword } = body;
    if (typeof password !== "string" || !password || password.length > MAX_PASSWORD) throw new ApiError(400, "bad_request", "Choose a password", "password_invalid");
    if (currentPassword !== undefined && (typeof currentPassword !== "string" || !currentPassword || currentPassword.length > MAX_PASSWORD)) {
      throw new ApiError(400, "bad_request", "Enter your current password", "password_mismatch");
    }
    const user = await cognitoUser(event, userId);
    nativeOnly(user);
    await deps.totp.setPassword(accessToken(event), password, currentPassword);
    obs.logger.info("Password set", { userId });
    await noticeAccount(user, userId, "passwordSet");
    return noContent();
  }

  /** A new secret for the caller's authenticator app, to show as a QR code and as text. Nothing is on until a code from it is verified. */
  async function startTotp(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    if (event.body) jsonBody(event, []);
    nativeOnly(await cognitoUser(event, userId));
    const secret = await deps.totp.associate(accessToken(event));
    return json(200, { totp: { secret } });
  }

  /** Checks a code from the authenticator app, turns TOTP on and signs the caller out everywhere (see "Two-step sign-in"). */
  async function verifyTotp(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const code = jsonBody(event, ["code"]).code;
    if (typeof code !== "string" || !EMAIL_CODE.test(code)) throw new ApiError(400, "bad_request", "Enter the 6-digit code from your authenticator app", "code_mismatch");
    const user = await cognitoUser(event, userId);
    nativeOnly(user);
    const token = accessToken(event);
    await deps.totp.verify(token, code);
    obs.logger.info("Two-step sign-in turned on", { userId });
    // Before the sign-out, so no session from before it can pass the billing check meanwhile
    await recordTwoStepOn(userId);
    try {
      // Every earlier session, this one too, began without the code: end them all. Until that
      // works they'd pass the billing check, so it's tried again, and if it still fails the app
      // is told to finish it (POST /me/sign-out-everywhere)
      await endEverySession(token, userId);
    } finally {
      // TOTP is on whether or not the sign-out finished: the account's address hears of it either way
      await noticeAccount(user, userId, "twoStepOn");
    }
    return noContent();
  }

  /**
   * Records when TOTP was turned on (data/two-step.ts): the billing routes
   * refuse a session that began before it. Never throws, since TOTP is on
   * either way: CloudTrail's record of the same change records it too
   * (identity/security-notices-handler.ts), and billing records one when it
   * finds none. Logged as an error, since until then an older record could
   * let a Managed Login session cookie from before it reach billing.
   */
  async function recordTwoStepOn(userId: string): Promise<void> {
    try {
      await recordTotpOn(dbFor({ userId }), userId, new Date(now()));
    } catch (error) {
      obs.logger.error("Two-step sign-in time not recorded", { userId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
    }
  }

  async function endEverySession(token: string, userId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await deps.totp.signOutEverywhere(token);
        return;
      } catch (error) {
        // A revoked token: every session has ended already. Anything else, throttling
        // included, is tried again, and then the app is told to finish it
        if (error instanceof ApiError && error.status === 401) throw error;
        if (attempt >= SIGN_OUT_ATTEMPTS) {
          obs.logger.error("Sign-out everywhere failed", { userId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
          throw new ApiError(503, "internal", "Two-step sign-in is on, but your other sessions weren't signed out yet. Try again.", "signout_failed");
        }
        await new Promise((resolve) => setTimeout(resolve, SIGN_OUT_BACKOFF_MS * attempt));
      }
    }
  }

  /** Ends every session the caller has (GlobalSignOut with their own token), this one too. */
  async function signOutEverywhere(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    if (event.body) jsonBody(event, []);
    await cognitoUser(event, userId);
    await endEverySession(accessToken(event), userId);
    return noContent();
  }

  /**
   * The caller's preferences for /me. Cosmetic, so a failed read never fails
   * /me: it's logged (the error's name only) and the defaults are returned.
   */
  async function ownPreferences(db: ReturnType<DbForAccount>, userId: string): Promise<Preferences> {
    try {
      return await getPreferences(db, userId);
    } catch (error) {
      obs.logger.warn("Preferences not read", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
      return DEFAULT_PREFERENCES;
    }
  }

  /**
   * Changes the caller's own preferences (data/preferences.ts), in their own
   * partition only: the session is tagged with nothing but their user ID.
   * Every field is checked before anything is written; the answer is the
   * preferences after the change.
   */
  async function setPreferencesRoute(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const at = new Date(now());
    const change = preferencesChange(jsonBody(event, PREFERENCE_FIELDS), at);
    const preferences = await setPreferences(dbFor({ userId }), userId, change, at);
    return json(200, { preferences });
  }

  const actions: Record<AccountRoute["action"], (event: DataEvent, userId: string) => Promise<APIGatewayProxyStructuredResultV2>> = {
    me,
    createTeam: newTeam,
    acceptInvite: accept,
    listMembers: members,
    setMemberRole: changeRole,
    removeMember: remove,
    listInvites: invites,
    createInvite: invite,
    revokeInvite: revoke,
    resendInvite: resend,
    closeTeam: close,
    reopenTeam: reopen,
    deleteAccount,
    sendEmailCode,
    verifyEmail,
    setPassword,
    startTotp,
    verifyTotp,
    signOutEverywhere,
    setPreferences: setPreferencesRoute,
  };

  return async (event: DataEvent, context?: Context): Promise<APIGatewayProxyStructuredResultV2> => {
    void context;
    const started = now();
    const action = ROUTES.get(event.routeKey);
    let status = 500;
    try {
      if (!action) throw new ApiError(404, "not_found", "No such route");
      const userId = callerId(event, now());
      if (event.requestContext.authorizer.jwt.claims.iss !== deps.issuerUrl) throw new ApiError(401, "unauthenticated", "Sign in again");
      const response = await actions[action](event, userId);
      status = response.statusCode ?? 200;
      return response;
    } catch (error) {
      const apiError = errorFor(error);
      status = apiError.status;
      if (apiError.status >= 500) {
        obs.logger.error("Request failed", error as Error);
        // The email code routes' own alarm: they're too quiet for the API errors alarm's 2% to see
        const codeFailure = EMAIL_CODE_FAILURES[action as AccountRoute["action"]];
        if (codeFailure) obs.count(codeFailure);
      }
      return errorResponse(apiError);
    } finally {
      obs.logger.info("Request", { route: event.routeKey, status, ms: now() - started });
    }
  };
}
