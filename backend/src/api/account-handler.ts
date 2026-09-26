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

import type { APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import {
  acceptInvite,
  authorizeTeam,
  createTeam,
  findInviteForEmail,
  ForbiddenError,
  getTeam,
  hashEmail,
  type Invite,
  MAX_TEAMS_PER_USER,
  listInvitesForEmail,
  listTeamsForUser,
  normalizeEmail,
  type Role,
  type Team,
  teamIdForRequest,
} from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import type { DbForAccount } from "./account-db.js";
import type { CognitoUser, UserInfo } from "./cognito-user.js";
import { callerId, type DataEvent, errorFor as dataErrorFor } from "./data-handler.js";
import { ApiError, errorResponse, header, json, jsonBody } from "./http.js";
import { ACCOUNT_ROUTES, type AccountRoute, IDEMPOTENCY_HEADER, routeKey } from "./routes.js";

export interface AccountHandlerDeps {
  readonly dbFor: DbForAccount;
  readonly userInfo: UserInfo;
  /** The user pool's issuer URL; tokens from anywhere else are refused. */
  readonly issuerUrl: string;
  readonly obs: Observability;
  readonly now?: () => number;
}

const ROUTES = new Map(ACCOUNT_ROUTES.map((r) => [routeKey(r), r.action]));
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/** The data layer's errors, as the account routes answer them. */
export function errorFor(error: unknown): ApiError {
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
  };
}

/** What /me shows of an invite: enough to offer it, not to accept it (that needs the emailed token). */
const inviteBody = (invite: Invite) => ({
  id: invite.inviteId,
  teamName: invite.teamName,
  role: invite.role,
  expiresAt: new Date(invite.expiresAt * 1000).toISOString(),
});

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

  /** The caller as Cognito sees them now, from their own access token. */
  async function cognitoUser(event: DataEvent, userId: string): Promise<CognitoUser> {
    // API Gateway accepts the token with or without the Bearer prefix
    const token = (header(event, "authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new ApiError(401, "unauthenticated", "Sign in again");
    const user = await deps.userInfo(token);
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
          return ctx && teamBody(await getTeam(db, ctx), ctx.role);
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

  const actions: Record<AccountRoute["action"], (event: DataEvent, userId: string) => Promise<APIGatewayProxyStructuredResultV2>> = {
    me,
    createTeam: newTeam,
    acceptInvite: accept,
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
