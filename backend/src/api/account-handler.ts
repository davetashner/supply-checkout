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
//                                   app sends after changing the password
//                                   (unless the caller opts out), and when
//                                   turning TOTP on couldn't. Then records the
//                                   time as the password reset record's, so
//                                   the API refuses every session from before
//                                   it too (supply-checkout-6uw.33).
//   PATCH /me/preferences           The caller's own app preferences: the What's
//                                   New banner on or off, and the local date it
//                                   was last shown (data/preferences.ts). GET /me
//                                   returns them as `user.preferences` (the
//                                   defaults if they can't be read). Refused
//                                   (409) for an account being deleted.
//   PUT    /me/photo                The caller's profile photo: a 256×256 JPEG,
//                                   checked and stripped of its metadata
//                                   (photos/jpeg.ts), stored under a new random
//                                   ID; the one it replaces is deleted. See
//                                   "Profile photos" below.
//   DELETE /me/photo                Removes it (idempotent).
//   GET    /teams/{teamId}/photos   Any member: presigned URLs for the photos of
//                                   the team's current members who have one.
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
//    A session that began before the user's password was last reset is
//    refused (session-reset.ts, supply-checkout-6uw.33).
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
// Profile photos (supply-checkout-6uw.30, data/photos.ts, photos/): one
// object per photo in the photos bucket, `photos/<photoId>.jpg`, the ID 128
// random bits, so no key names a person. The caller's own photo record
// (USER#<sub>, PHOTO) names the current photo and any objects still to be
// deleted (orphans): an upload is counted against the caller's daily limit
// and staged in the record before its object is written, then committed,
// and the photo it replaced is deleted. The photo's ID is copied to the
// caller's MEMBER item in each team they're in, closed ones too (and kept current on
// /me), and the team's /photos route presigns only what its MEMBER items
// name, after the membership check: a removed member's item is gone, and no
// ID from the request reaches the bucket. The photos bucket is reached only
// with the function's own role, PutObject, GetObject and DeleteObject under
// photos/* only. The image, its URLs (bearer links) and names are never
// logged; the photo ID at most. Deleting an account deletes every object the
// record names, before the record goes.
//
// Invite emails: the invite is written first, then sent (email/mailer.ts). If
// SES won't take it, the invite stays, marked failed (`not_sent`), so the
// owner sees "Couldn't deliver" and can re-send or revoke it. Addresses,
// names and tokens never go in a log line or a metric.

import { randomBytes } from "node:crypto";
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
  checklistOf,
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
  setOwnMemberName,
  listInvites,
  listInvitesForEmail,
  listTeamsForUser,
  markNoticeSent,
  emailSeenHash,
  noticeAddress,
  recordNoticeAddress,
  recordTotpOn,
  recordPasswordReset,
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
  clearOrphans,
  commitPhoto,
  getPhotoRecord,
  PhotoLimitError,
  type PhotoRecord,
  photoIdsOf,
  removePhoto,
  setOwnMemberPhoto,
  stagePhoto,
  storedPhotoId,
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
import { PhotoRejectedError, stripPhoto } from "../photos/jpeg.js";
import type { PhotoStore } from "../photos/store.js";
import { BusinessMetric, type BusinessMetricName, type Observability, testMark } from "../observability/index.js";
import type { DbForAccount } from "./account-db.js";
import type { CognitoUser, DeleteUser, EmailCodes, TotpSetup, UserInfo } from "./cognito-user.js";
import { callerId, type DataEvent, errorFor as dataErrorFor } from "./data-handler.js";
import { accessToken, ApiError, errorResponse, header, json, jsonBody, noContent, notMember } from "./http.js";
import { requireRole } from "./roles.js";
import type { SessionCheck } from "./session-reset.js";
import { ACCOUNT_ROUTES, type AccountRoute, IDEMPOTENCY_HEADER, routeKey } from "./routes.js";

export interface AccountHandlerDeps {
  readonly dbFor: DbForAccount;
  /** Refuses a session from before the caller's last password reset (session-reset.ts). The Lambda entry always sets it. */
  readonly sessionCheck?: SessionCheck;
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
  /** The photos bucket (photos/store.ts). The Lambda entry always sets it; absent, there are no photos and the photo routes fail. */
  readonly photos?: PhotoStore;
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

/** The largest PUT /me/photo body: a 64 KB photo in base64, and room for the JSON around it. */
export const PHOTO_BODY_BYTES = 100_000;
/** Base64, with an optional data URL prefix for a JPEG (what canvas.toDataURL gives). */
const PHOTO_BASE64 = /^(?:data:image\/jpeg;base64,)?((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/;

const photoInvalid = () => new ApiError(400, "bad_request", "That isn't a 256×256 JPEG photo", "photo_invalid");
const photoTooLarge = () => new ApiError(413, "quota_exceeded", "That photo is too large", "photo_too_large");

/** The data layer's errors, as the account routes answer them. */
export function errorFor(error: unknown): ApiError {
  if (error instanceof PhotoLimitError) return new ApiError(429, "quota_exceeded", error.message, "photo_limit");
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
    // The first-run checklist's progress (supply-checkout-fs56): owners only, as only they see it
    checklist: role === "owner" ? checklistOf(team) : null,
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
const memberBody = (member: Member, photoUrl: string | null = null) => ({ userId: member.userId, name: member.displayName ?? null, email: member.email ?? null, role: member.role, joinedAt: member.joinedAt ?? null, photoUrl });

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
    const [rows, invites, preferences, photo] = await Promise.all([
      listTeamsForUser(own, userId),
      email ? listInvitesForEmail(own, email, new Date(now())) : [],
      ownPreferences(own, userId),
      ownPhoto(own, userId),
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
          await keepMemberProfile(db, ctx, email, user.name, photo);
          return teamBody(await getTeam(db, ctx), ctx.role, new Date(now()));
        }),
      )
    )
      .filter((t) => t !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const joined = new Set(teams.map((t) => t.id));
    return json(200, {
      user: { id: userId, email: user.email ?? null, emailVerified: email !== undefined, mfa: mfaState(user), preferences, photoUrl: await photoUrl(photo?.photoId) },
      teams,
      invites: invites.filter((i) => !joined.has(i.teamId)).map(inviteBody),
    });
  }

  /**
   * Brings the caller's MEMBER email in one team up to their verified address
   * (supply-checkout-xv3k), when they have one, and their name up to Cognito's
   * (supply-checkout-lx7; removed if they cleared it): the members list and
   * owner notices read them, and they were copied when they joined. And, when
   * `photo` (their photo record) could be read, their photo's ID up to it
   * (supply-checkout-6uw.30), which the team's /photos route reads. Reads
   * first, so a member already current costs no write. Closed teams are left
   * as they are, but for the photo ID. Best effort: a failure is logged (the team ID and error name
   * only, never the address or name) and the request goes on.
   */
  async function keepMemberProfile(db: ReturnType<DbForAccount>, ctx: TeamContext, email: string | undefined, name?: string, photo?: PhotoRecord): Promise<void> {
    // Two /me calls at once, around a change, could each read and write: the
    // last write wins, and if it carried the older value the next /me corrects it
    // (both only ever write what Cognito says for this user). Self-healing.
    try {
      const member = await getMember(db, ctx, ctx.userId);
      if (!member) return;
      // A closed team keeps its email and name as they were, but never names a photo that's gone
      if (photo && member.photoId !== photo.photoId) await setOwnMemberPhoto(db, ctx, photo.photoId);
      if (ctx.closed) return;
      if (email && member.email !== email) await setOwnMemberEmail(db, ctx, email);
      if (member.displayName !== name) await setOwnMemberName(db, ctx, name);
    } catch (error) {
      obs.logger.warn("Member details not updated", { teamId: ctx.teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
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

  /** keepMemberProfile in every team the caller is in (their own USER# rows), each on a session for that team after the membership check. */
  async function keepMemberEmails(userId: string, email: string, name: string | undefined): Promise<void> {
    const rows = await listTeamsForUser(dbFor({ userId }), userId);
    await Promise.all(
      rows.slice(0, MAX_TEAMS_PER_USER).map(async (row) => {
        const db = dbFor({ userId, teamId: row.teamId });
        const ctx = await authorizeTeam(db, userId, row.teamId, new Date(now())).catch((error: unknown) => {
          if (error instanceof ForbiddenError) return undefined;
          throw error;
        });
        if (ctx) await keepMemberProfile(db, ctx, email, name);
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
    const { team, context, created } = await createTeam(db, { userId, email: verifiedEmail(user), name: user.name, test }, { name: body.name as string, requestKey: key }, new Date(now()));
    if (created) obs.count(BusinessMetric.SignUps, 1, { teamId: team.teamId, ...testMark(team.test) });
    return json(created ? 201 : 200, { team: teamBody(team, context.role) });
  }

  async function accept(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const inviteId = event.pathParameters?.inviteId;
    if (typeof inviteId !== "string" || !ID.test(inviteId)) throw new ApiError(400, "bad_request", "Invalid invite ID");
    const token = event.body ? jsonBody(event, ["token"]).token : undefined;
    const user = await cognitoUser(event, userId);
    const email = verifiedEmail(user);
    if (!email) throw new ApiError(403, "permission_denied", "Verify your email address to accept invites");
    const at = new Date(now());
    const invite = await findInviteForEmail(dbFor({ userId, invitee: hashEmail(email) }), email, inviteId, at);
    // Unknown, expired, used, for someone else, or no token: one answer for all
    if (!invite || typeof token !== "string") throw new ApiError(404, "not_found", "This invite has expired, was already used, or is for another email address");
    const db = dbFor({ userId, teamId: invite.teamId });
    const ctx = await acceptInvite(db, { userId, verifiedEmail: email, name: user.name }, invite, token, at);
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
    const list = (await Promise.all((await listMembers(dbFor({ userId, teamId }), ctx)).map(async (m) => memberBody(m, await photoUrl(storedPhotoId(m.photoId))))))
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
    return json(200, { member: memberBody(member, await photoUrl(storedPhotoId(member.photoId))) });
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
    // Before the record that names them goes; a failure stops here, and a retry carries on
    const photosDeleted = await deleteEveryPhoto(own, userId);
    const rowsDeleted = await deleteUserRows(own, userId);
    // Last: until it's gone the user can sign in and try again
    await deps.deleteUser(token);
    obs.count(BusinessMetric.AccountsDeleted, 1, testMark(test));
    obs.logger.info("Account deleted", { userId, teamsLeft: teams.length, teamsClosed: teams.filter((t) => t.alone).length, invitesDeleted: invites.length, photosDeleted, rowsDeleted });
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
      await keepMemberEmails(userId, normalizeEmail(before.email), after.name);
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

  /**
   * Ends every session the caller has (GlobalSignOut with their own token),
   * this one too. GlobalSignOut revokes refresh tokens only, so the time is
   * then recorded as the password reset record's (data/password-reset-time.ts,
   * supply-checkout-6uw.33): every API route refuses a session from before it,
   * an access token or a Managed Login session cookie's (session-reset.ts).
   * After a password change it's the takeover response, so it's recorded
   * here, after the sign-out, rather than at POST /me/password: there the
   * caller can choose to stay signed in, and the app's next call is this one,
   * with a token from before. The caller has been signed out by then, so a
   * failed record doesn't fail the answer: it's logged as an error (the
   * user ID and the error's name only) and counted (SecurityNoticeFailures,
   * reason `record_reset`), which alarms. Either way (a write can land though
   * its answer timed out), this container's cached reset time for the caller
   * is then dropped (SessionCheck.forget), so
   * sessions from before are refused here at once; other containers see it
   * within RESET_CACHE_MS.
   */
  async function signOutEverywhere(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    if (event.body) jsonBody(event, []);
    await cognitoUser(event, userId);
    await endEverySession(accessToken(event), userId);
    try {
      await recordPasswordReset(dbFor({ userId }), userId, new Date(now()));
    } catch (error) {
      obs.logger.error("Sign-out time not recorded", { userId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
      // Sessions from before the sign-out may still pass the API's check: raise "Security notices failing"
      obs.count(BusinessMetric.SecurityNoticeFailures, 1, { kind: "signOutEverywhere", reason: "record_reset", via: "api" });
    } finally {
      // This container's cached time may be older now, even after a failure (a write that landed but
      // whose answer timed out): the next request reads it again
      deps.sessionCheck?.forget?.(userId);
    }
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

  /** The photo store, or a 500: the Lambda entry always has one. */
  function photoStore(): PhotoStore {
    if (!deps.photos) throw new Error("No photo store");
    return deps.photos;
  }

  /** A presigned URL for a photo, or null for none (or no store). */
  async function photoUrl(photoId: string | undefined): Promise<string | null> {
    return photoId && deps.photos ? deps.photos.url(photoId) : null;
  }

  /**
   * The caller's photo record for /me. Cosmetic, so a failed read never fails
   * /me: it's logged (the error's name only), /me says there's no photo, and
   * the member copies are left as they are.
   */
  async function ownPhoto(db: ReturnType<DbForAccount>, userId: string): Promise<PhotoRecord | undefined> {
    try {
      return await getPhotoRecord(db, userId);
    } catch (error) {
      obs.logger.warn("Photo not read", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
      return undefined;
    }
  }

  /**
   * Deletes the objects of the record's orphans and takes them off it. Best
   * effort, unless `strict`: an object that couldn't be deleted is logged
   * (the count and error name) and stays an orphan, for the next upload or
   * removal; with `strict` that's a 503. Returns the record as it is now.
   */
  async function deleteOrphans(db: ReturnType<DbForAccount>, userId: string, record: PhotoRecord, strict = false): Promise<PhotoRecord> {
    if (!record.orphans.length) return record;
    const store = photoStore();
    const results = await Promise.allSettled(record.orphans.map((id) => store.delete(id)));
    const deleted = record.orphans.filter((_, i) => results[i]?.status === "fulfilled");
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      obs.logger.warn("Photos not deleted", { userId, failed: record.orphans.length - deleted.length, code: (failed.reason as { name?: string } | null)?.name ?? "Unknown" });
      if (strict) throw new ApiError(503, "unavailable", "Your photo couldn't be removed just now; try again");
    }
    if (!deleted.length) return record;
    try {
      return await clearOrphans(db, userId, record, deleted, new Date(now()));
    } catch (error) {
      // The objects are gone either way; an orphan left on the record is deleted again next time
      obs.logger.warn("Photo record not updated", { userId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
      return getPhotoRecord(db, userId);
    }
  }

  /**
   * Copies the caller's photo ID (or its removal) to their MEMBER item in
   * every team they're in, closed ones too, each on a session for that team after the
   * membership check. Best effort: a team that fails is logged (its ID and
   * the error's name) and catches up on the next /me.
   */
  async function syncMemberPhotos(userId: string, photo: string | undefined): Promise<void> {
    try {
      const rows = await listTeamsForUser(dbFor({ userId }), userId);
      await Promise.all(
        rows.slice(0, MAX_TEAMS_PER_USER).map(async (row) => {
          try {
            const db = dbFor({ userId, teamId: row.teamId });
            const ctx = await authorizeTeam(db, userId, row.teamId, new Date(now()));
            // Closed teams too: their /photos must not name a photo that's been replaced or removed
            await setOwnMemberPhoto(db, ctx, photo);
          } catch (error) {
            // A stale switcher row: not a member any more
            if (error instanceof ForbiddenError) return;
            obs.logger.warn("Member photo not updated", { teamId: row.teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
          }
        }),
      );
    } catch (error) {
      obs.logger.warn("Member photos not updated", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
    }
  }

  /** PUT /me/photo (see "Profile photos" at the top). */
  async function setPhoto(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    let body: Record<string, unknown>;
    try {
      body = jsonBody(event, ["image"], PHOTO_BODY_BYTES);
    } catch (error) {
      if (error instanceof ApiError && error.status === 413) throw photoTooLarge();
      throw error;
    }
    const match = typeof body.image === "string" ? PHOTO_BASE64.exec(body.image) : null;
    if (!match?.[1]) throw photoInvalid();
    let jpeg: Buffer;
    let dropped: number;
    try {
      ({ bytes: jpeg, dropped } = stripPhoto(Buffer.from(match[1], "base64")));
    } catch (error) {
      if (error instanceof PhotoRejectedError) throw error.reason === "too_large" ? photoTooLarge() : photoInvalid();
      throw error;
    }
    const store = photoStore();
    const own = dbFor({ userId });
    // Leftovers from an earlier upload or removal first, so the record never holds many
    const record = await deleteOrphans(own, userId, await getPhotoRecord(own, userId));
    const photoId = randomBytes(16).toString("hex");
    const staged = await stagePhoto(own, userId, record, photoId, new Date(now()));
    await store.put(photoId, jpeg);
    let committed: PhotoRecord;
    try {
      committed = await commitPhoto(own, userId, staged, photoId, new Date(now()));
    } catch (error) {
      // Not this photo after all (the account is being deleted, or another upload won): its object goes now.
      // If that fails too, it's still an orphan on the record (unless the account is gone with it)
      await store.delete(photoId).catch((e: unknown) => obs.logger.warn("Photo not deleted", { userId, photoId, code: (e as { name?: string } | null)?.name ?? "Unknown" }));
      throw error;
    }
    obs.logger.info("Photo set", { userId, photoId, dropped });
    await deleteOrphans(own, userId, committed);
    await syncMemberPhotos(userId, photoId);
    return json(200, { photoUrl: await store.url(photoId) });
  }

  /** DELETE /me/photo: the record first, then the objects (a failure is a 503, and a retry finishes it). Idempotent. */
  async function deletePhoto(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    if (event.body) jsonBody(event, []);
    const own = dbFor({ userId });
    let record = await getPhotoRecord(own, userId);
    if (record.photoId) record = await removePhoto(own, userId, record, new Date(now()));
    await deleteOrphans(own, userId, record, true);
    await syncMemberPhotos(userId, undefined);
    obs.logger.info("Photo removed", { userId });
    return noContent();
  }

  /**
   * GET /teams/{teamId}/photos: any member of the team gets a presigned URL
   * for each current member who has a photo, by user ID. Only IDs the team's
   * own MEMBER items name are signed; no names or emails.
   */
  async function listPhotos(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const { teamId, ctx } = await teamContext(event, userId);
    const members = await listMembers(dbFor({ userId, teamId }), ctx);
    const photos: [string, string][] = [];
    for (const member of members) {
      const url = await photoUrl(storedPhotoId(member.photoId));
      if (url) photos.push([member.userId, url]);
    }
    // fromEntries: a user ID can't reach an object's prototype
    return json(200, { photos: Object.fromEntries(photos) });
  }

  /**
   * Deletes every photo object the caller's record names (account deletion).
   * Throws if any can't be deleted, so the deletion stops before the record
   * goes and a retry carries on. Returns how many it deleted.
   */
  async function deleteEveryPhoto(db: ReturnType<DbForAccount>, userId: string): Promise<number> {
    const ids = photoIdsOf(await getPhotoRecord(db, userId));
    if (!ids.length) return 0;
    const store = photoStore();
    for (const id of ids) await store.delete(id);
    return ids.length;
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
    setPhoto,
    deletePhoto,
    listPhotos,
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
      await deps.sessionCheck?.(event, userId);
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
