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
//                                 (best effort: see noticeClosed).
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
//                                   and reloads /me. A verified address that
//                                   changed is copied to the caller's MEMBER
//                                   item in each team they're in, here and on
//                                   /me (keepMemberEmail).
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
// member of, every invite to their verified email is deleted, their USER#
// rows go (not the LIMIT# counters, left to their TTL), and last their Cognito user, with their own access token
// (DeleteUser: no IAM permission to delete anyone else). Every step is
// idempotent, so a retry after a failure part-way carries on. Each removal
// and closure is audited in its team; the log line has only IDs and counts.
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
  countEmailCode,
  createInvite,
  createTeam,
  deleteInviteForEmail,
  deleteUserRows,
  findInviteForEmail,
  ForbiddenError,
  getInvite,
  getMember,
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
  mailAddress,
  markInviteNotSent,
  normalizeEmail,
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
  TeamFullError,
  teamIdForRequest,
} from "../data/index.js";
import { EmailNotSentError, type Mailer, sendInviteEmail, sendTeamNotice } from "../email/mailer.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import type { DbForAccount } from "./account-db.js";
import type { CognitoUser, DeleteUser, EmailCodes, UserInfo } from "./cognito-user.js";
import { callerId, type DataEvent, errorFor as dataErrorFor } from "./data-handler.js";
import { ApiError, errorResponse, header, json, jsonBody, noContent, notMember } from "./http.js";
import { requireRole } from "./roles.js";
import { ACCOUNT_ROUTES, type AccountRoute, IDEMPOTENCY_HEADER, routeKey } from "./routes.js";

export interface AccountHandlerDeps {
  readonly dbFor: DbForAccount;
  readonly userInfo: UserInfo;
  /** Emails the caller a verification code and checks it (cognito-user.ts). */
  readonly emailCodes: EmailCodes;
  /** The user pool's issuer URL; tokens from anywhere else are refused. */
  readonly issuerUrl: string;
  readonly obs: Observability;
  /** Sends invite emails (email/mailer.ts). */
  readonly mailer: Mailer;
  /** Deletes the caller's own Cognito user, with their access token (cognito-user.ts). */
  readonly deleteUser: DeleteUser;
  readonly now?: () => number;
}

const ROUTES = new Map(ACCOUNT_ROUTES.map((r) => [routeKey(r), r.action]));
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;
/** Cognito's verification codes are 6 digits. */
const EMAIL_CODE = /^[0-9]{6}$/;

/** The data layer's errors, as the account routes answer them. */
export function errorFor(error: unknown): ApiError {
  if (error instanceof TeamClosedError) return new ApiError(403, "permission_denied", error.message, "team_closed");
  if (error instanceof LastOwnerError) return new ApiError(409, "aborted", error.message, "last_owner");
  if (error instanceof TeamFullError) return new ApiError(429, "quota_exceeded", error.message, "team_full");
  // Here a ForbiddenError is about membership or an invite, never view-only access
  if (error instanceof ForbiddenError) return new ApiError(403, "permission_denied", error.message);
  return dataErrorFor(error);
}

/** A team as /me and the create and accept routes return it. */
export function teamBody(team: Team, role: Role) {
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
    deletesAt: team.closedAt ? (team.purgeAfter ?? null) : null,
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

/** The verified email, normalized, or undefined if Cognito hasn't verified one. */
function verifiedEmail(user: CognitoUser): string | undefined {
  if (!user.emailVerified || !user.email) return undefined;
  try {
    return normalizeEmail(user.email);
  } catch {
    return undefined;
  }
}

export function createAccountHandler(deps: AccountHandlerDeps) {
  const now = deps.now ?? Date.now;
  const { dbFor, obs } = deps;

  /** The caller's access token, as API Gateway verified it (with or without the Bearer prefix). */
  function accessToken(event: DataEvent): string {
    const token = (header(event, "authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new ApiError(401, "unauthenticated", "Sign in again");
    return token;
  }

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
    const [rows, invites] = await Promise.all([listTeamsForUser(own, userId), email ? listInvitesForEmail(own, email, new Date(now())) : []]);
    // Each team's details on a session for that team, after the membership
    // check: a stale switcher row (a removed member) shows nothing. Capped, so
    // one request never needs more role sessions than that.
    const teams = (
      await Promise.all(
        rows.slice(0, MAX_TEAMS_PER_USER).map(async (row) => {
          const db = dbFor({ userId, teamId: row.teamId });
          const ctx = await authorizeTeam(db, userId, row.teamId).catch((error: unknown) => {
            if (error instanceof ForbiddenError) return undefined;
            throw error;
          });
          if (!ctx) return undefined;
          if (email) await keepMemberEmail(db, ctx, email);
          return teamBody(await getTeam(db, ctx), ctx.role);
        }),
      )
    )
      .filter((t) => t !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const joined = new Set(teams.map((t) => t.id));
    return json(200, {
      user: { id: userId, email: user.email ?? null, emailVerified: email !== undefined },
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
    try {
      const member = await getMember(db, ctx, ctx.userId);
      if (member && member.email !== email) await setOwnMemberEmail(db, ctx, email);
    } catch (error) {
      obs.logger.warn("Member email not updated", { teamId: ctx.teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
    }
  }

  /** keepMemberEmail in every team the caller is in (their own USER# rows), each on a session for that team after the membership check. */
  async function keepMemberEmails(userId: string, email: string): Promise<void> {
    const rows = await listTeamsForUser(dbFor({ userId }), userId);
    await Promise.all(
      rows.slice(0, MAX_TEAMS_PER_USER).map(async (row) => {
        const db = dbFor({ userId, teamId: row.teamId });
        const ctx = await authorizeTeam(db, userId, row.teamId).catch((error: unknown) => {
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
    const { team, context, created } = await createTeam(db, { userId, email: verifiedEmail(user) }, { name: body.name as string, requestKey: key }, new Date(now()));
    if (created) obs.count(BusinessMetric.SignUps, 1, { teamId: team.teamId });
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
    obs.count(BusinessMetric.InvitesAccepted, 1, { teamId: ctx.teamId });
    return json(200, { team: teamBody(await getTeam(db, ctx), ctx.role) });
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
    const ctx = await authorizeTeam(dbFor({ userId, teamId }), userId, teamId).catch((error: unknown) => {
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
    // Leaving also revokes invites to the caller's verified address now, whatever their member item holds
    const email = leaving ? verifiedEmail(await cognitoUser(event, userId)) : undefined;
    await removeMember(db, ctx, target, email ? { verifiedEmail: email } : {});
    return noContent();
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
      obs.count(BusinessMetric.InvitesSent, 1, { teamId: ctx.teamId });
      return invite;
    } catch (error) {
      const code = error instanceof EmailNotSentError ? error.code : ((error as { name?: string } | null)?.name ?? "Unknown");
      obs.logger.warn("Invite email not sent", { teamId: ctx.teamId, inviteId: invite.inviteId, code });
      const at = new Date(now());
      await markInviteNotSent(db, ctx, invite.inviteId, at);
      obs.count(BusinessMetric.InvitesFailed, 1, { teamId: ctx.teamId, reason: "not_sent" });
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
      obs.count(BusinessMetric.TeamsClosed, 1, { teamId });
      obs.logger.info("Team closed", { teamId, purgeAfter: team.purgeAfter ?? "" });
      await noticeClosed(db, ctx, team);
    }
    return json(200, { team: teamBody(team, ctx.role) });
  }

  /**
   * Emails every owner of a team that just closed, with the day the purge deletes it,
   * so a closure one owner didn't make (or a compromised account made) doesn't go
   * unnoticed. Best effort: the team is closed either way, and each owner who wasn't
   * emailed (SES refused it, no address on file, or the owners couldn't be listed) is
   * counted in TeamClosedNoticeFailures. Only IDs, counts and SES error names are logged.
   */
  async function noticeClosed(db: ReturnType<DbForAccount>, ctx: TeamContext, team: Team): Promise<void> {
    const { teamId } = ctx;
    let owners: Member[];
    try {
      owners = (await listMembers(db, ctx)).filter((m) => m.role === "owner");
    } catch (error) {
      obs.logger.warn("Team closure emails not sent", { teamId, code: (error as { name?: string } | null)?.name ?? "Unknown" });
      obs.count(BusinessMetric.TeamClosedNoticeFailures, 1, { teamId, reason: "not_listed" });
      return;
    }
    const input = { kind: "teamClosed" as const, teamName: team.name, purgeAfter: team.purgeAfter as string };
    const results = await Promise.allSettled(
      owners.map((owner) => (owner.email ? sendTeamNotice(deps.mailer, owner.email, teamId, input) : Promise.reject(new EmailNotSentError("NoAddress")))),
    );
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (results.length > failed.length) obs.count(BusinessMetric.TeamClosedNotices, results.length - failed.length, { teamId });
    if (failed.length) {
      const codes = [...new Set(failed.map((r) => (r.reason instanceof EmailNotSentError ? r.reason.code : ((r.reason as { name?: string } | null)?.name ?? "Unknown"))))];
      obs.logger.warn("Team closure emails not sent", { teamId, failed: failed.length, owners: owners.length, codes: codes.join(",") });
      obs.count(BusinessMetric.TeamClosedNoticeFailures, failed.length, { teamId, reason: "not_sent" });
    }
  }

  /** Deletes the caller's account (see "Deleting an account" at the top). */
  async function deleteAccount(event: DataEvent, userId: string): Promise<APIGatewayProxyStructuredResultV2> {
    const body = jsonBody(event, ["confirm"]);
    if (typeof body.confirm !== "string" || body.confirm.trim().toUpperCase() !== DELETE_CONFIRMATION) {
      throw new ApiError(400, "bad_request", `Type ${DELETE_CONFIRMATION} to confirm`);
    }
    const token = accessToken(event);
    const email = verifiedEmail(await cognitoUser(event, userId));
    const invitee = email && hashEmail(email);
    const own = dbFor({ userId, invitee });
    const at = new Date(now());
    // No joins from here on, so the teams listed next are all of them
    await startAccountDeletion(own, userId, at);
    const rows = await listTeamsForUser(own, userId);
    const found = await Promise.all(
      rows.map(async (row) => {
        const db = dbFor({ userId, teamId: row.teamId });
        const ctx = await authorizeTeam(db, userId, row.teamId).catch((error: unknown) => {
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
          if (closedNow) obs.count(BusinessMetric.TeamsClosed, 1, { teamId: ctx.teamId });
        }
        await removeMember(db, ctx, userId, { reason: "account_deleted" }, at);
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
    const invites = email ? await listInvitesForEmail(own, email, at, { includeExpired: true }) : [];
    for (const invite of invites) await deleteInviteForEmail(dbFor({ userId, teamId: invite.teamId, invitee }), email as string, invite);
    const rowsDeleted = await deleteUserRows(own, userId);
    // Last: until it's gone the user can sign in and try again
    await deps.deleteUser(token);
    obs.count(BusinessMetric.AccountsDeleted, 1);
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
    // A linked user's address counts once the trigger records it, at the token
    // refresh after this; /me then brings their member items up to date
    const email = verifiedEmail(after);
    if (email) {
      try {
        await keepMemberEmails(userId, email);
      } catch (error) {
        obs.logger.warn("Member emails not updated", { code: (error as { name?: string } | null)?.name ?? "Unknown" });
      }
    }
    return noContent();
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
    deleteAccount,
    sendEmailCode,
    verifyEmail,
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
      if (apiError.status >= 500) obs.logger.error("Request failed", error as Error);
      return errorResponse(apiError);
    } finally {
      obs.logger.info("Request", { route: event.routeKey, status, ms: now() - started });
    }
  };
}
