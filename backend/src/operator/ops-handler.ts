// The ops API: what platform operators do (ADR 0015, docs/api/openapi.yaml).
//
//   GET    /ops/teams?q=&cursor=        Teams, newest first, or those matching q
//                                       (name or ID), with their owners' emails
//   GET    /ops/teams/{teamId}          One team's account record and owners (audited)
//   PUT    /ops/teams/{teamId}/comp     Comp a team or change or extend its comp
//   DELETE /ops/teams/{teamId}/comp     End a comp early
//   GET    /ops/audit?month=|teamId=    The operator audit trail
//
// Who gets in, on every request:
// 1. API Gateway's ops JWT authorizer checks the token against the operator
//    pool (issuer) and its `ops` client (audience). A customer's token fails
//    it, and the ops pool's tokens fail the customer authorizer.
// 2. This handler checks the claims again: an unexpired access token from the
//    operator pool's issuer, for the `ops` client, whose `cognito:groups`
//    names the operators group. The pool requires TOTP, so every token it
//    issues comes from a session that used MFA.
// 3. Cognito, now: GetUser with the token (refused once it's revoked or the
//    user is disabled) and AdminListGroupsForUser (still an operator). So a
//    removed, disabled or signed-out operator is refused on the next request.
//
// What an operator reaches: the team routes never honor this pool or group,
// and this code has no TeamContext (the lint config keeps team-context
// functions out of it). Every DynamoDB call runs on the operator-access role
// (ops-db.ts), which can read only GSI3's projection, change only comp
// attributes, and only append audit items. Every change is audited in its own
// transaction (data/operator.ts). Log lines carry the action, the team ID,
// the operator's `sub` and the status: never emails, names or tokens.

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import {
  ConflictError,
  endComp,
  getOpsTeam,
  InvalidInputError,
  liveComp,
  listOperatorAudit,
  listOpsOwners,
  listOpsTeams,
  NotFoundError,
  type Operator,
  type OperatorAuditEvent,
  type OperatorAuditSummary,
  type OpsOwner,
  type OpsTeam,
  setComp,
} from "../data/index.js";
import { OPERATORS_GROUP } from "../identity/names.js";
import type { Observability } from "../observability/index.js";
import { ApiError, errorFor as apiErrorFor, errorResponse, header, json, jsonBody } from "../api/http.js";
import { IDEMPOTENCY_HEADER, OPS_ROUTES, type OpsRoute, routeKey } from "../api/routes.js";
import type { OperatorDirectory } from "./cognito.js";
import type { DbForOps } from "./ops-db.js";

export type OpsEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

export interface OpsHandlerDeps {
  readonly dbFor: DbForOps;
  readonly directory: OperatorDirectory;
  /** The operator pool's issuer URL. */
  readonly issuerUrl: string;
  /** The operator pool's `ops` client ID. */
  readonly clientId: string;
  readonly obs: Observability;
  readonly now?: () => number;
}

const ROUTES = new Map(OPS_ROUTES.map((r) => [routeKey(r), r.action]));
const SUB = /^[A-Za-z0-9_-]{1,128}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Operators only: one answer for every way of not being one. */
const notOperator = () => new ApiError(403, "permission_denied", "Operators only");
const signInAgain = () => new ApiError(401, "unauthenticated", "Sign in again");

/**
 * The groups in a token's `cognito:groups` claim. API Gateway hands JWT claims
 * to Lambda as strings, so an array arrives as `[a b]`; a real array is taken
 * as it is.
 */
export function groupsClaim(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value !== "string") return [];
  return value.replace(/^\[|\]$/g, "").split(/[\s,]+/).filter(Boolean);
}

export function errorFor(error: unknown): ApiError {
  if (error instanceof InvalidInputError) return new ApiError(400, "bad_request", error.message);
  if (error instanceof NotFoundError) return new ApiError(404, "not_found", error.message);
  if (error instanceof ConflictError) return new ApiError(409, "aborted", error.message);
  return apiErrorFor(error);
}

/** A team as the ops routes return it. */
export function opsTeamBody(team: OpsTeam, now: Date, owners?: OpsOwner[]) {
  return {
    id: team.teamId,
    name: team.name,
    plan: team.plan,
    seats: team.seats,
    status: team.status,
    trialEndsAt: team.trialEndsAt ?? null,
    ownerCount: team.owners,
    members: team.members ?? null,
    createdAt: team.createdAt,
    stripeCustomerId: team.stripeCustomerId ?? null,
    version: team.version,
    comp:
      team.compPlan === undefined
        ? null
        : {
            plan: team.compPlan,
            seats: team.compSeats ?? null,
            until: team.compUntil ?? null,
            reason: team.compReason ?? null,
            by: team.compBy ?? null,
            at: team.compAt ?? null,
            live: liveComp(team, now) !== undefined,
          },
    ...(owners ? { owners: owners.map((o) => ({ userId: o.userId, email: o.email ?? null, joinedAt: o.joinedAt ?? null })) } : {}),
  };
}

/** An audit event as the ops routes return it: without its type or TTL. */
function auditBody(event: OperatorAuditEvent | OperatorAuditSummary) {
  const { expiresAt, type, ...rest } = event as Partial<OperatorAuditEvent>;
  void expiresAt;
  void type;
  return rest;
}

export function createOpsHandler(deps: OpsHandlerDeps) {
  const now = deps.now ?? Date.now;
  const { obs } = deps;

  /** The verified operator, or 401/403. Cognito is asked on every request. */
  async function operator(event: OpsEvent): Promise<Operator> {
    const claims = event.requestContext.authorizer?.jwt?.claims;
    if (!claims) throw signInAgain();
    if (claims.iss !== deps.issuerUrl || claims.client_id !== deps.clientId) throw signInAgain();
    if (claims.token_use !== "access") throw new ApiError(401, "unauthenticated", "Use an access token");
    const exp = Number(claims.exp);
    if (!Number.isFinite(exp) || exp * 1000 <= now()) throw new ApiError(401, "unauthenticated", "Your session expired; sign in again");
    const sub = claims.sub;
    if (typeof sub !== "string" || !SUB.test(sub)) throw signInAgain();
    if (!groupsClaim(claims["cognito:groups"]).includes(OPERATORS_GROUP)) throw notOperator();
    const token = (header(event, "authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) throw signInAgain();
    const user = await deps.directory.getUser(token);
    if (user.sub !== sub) throw signInAgain();
    if (!(await deps.directory.groupsFor(user.username)).includes(OPERATORS_GROUP)) throw notOperator();
    return { sub };
  }

  function teamIdFrom(event: OpsEvent): string {
    const value = event.pathParameters?.teamId;
    if (typeof value !== "string" || !ID.test(value)) throw new ApiError(400, "bad_request", "Invalid team ID");
    return value;
  }

  function limitFrom(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new ApiError(400, "bad_request", "limit is a number from 1 to 100");
    return Number(value);
  }

  type Result = { response: APIGatewayProxyStructuredResultV2; teamId?: string };

  const actions: Record<OpsRoute["action"], (event: OpsEvent, op: Operator) => Promise<Result>> = {
    async listTeams(event, op) {
      const q = event.queryStringParameters ?? {};
      const db = deps.dbFor(op.sub);
      const page = await listOpsTeams(db, op, { q: q.q, cursor: q.cursor, limit: limitFrom(q.limit) });
      const at = new Date(now());
      const teams = await Promise.all(page.teams.map(async (team) => opsTeamBody(team, at, await listOpsOwners(db, op, team.teamId))));
      return { response: json(200, { teams, ...(page.cursor ? { cursor: page.cursor } : {}) }) };
    },
    async getTeam(event, op) {
      const teamId = teamIdFrom(event);
      const at = new Date(now());
      const { team, owners } = await getOpsTeam(deps.dbFor(op.sub), op, teamId, at);
      return { teamId, response: json(200, { team: opsTeamBody(team, at, owners) }) };
    },
    async setComp(event, op) {
      const teamId = teamIdFrom(event);
      const body = jsonBody(event, ["plan", "seats", "until", "reason", "expectedVersion"]);
      const outcome = await setComp(deps.dbFor(op.sub, teamId), op, teamId, { ...body, idempotencyKey: header(event, IDEMPOTENCY_HEADER) } as Parameters<typeof setComp>[3], new Date(now()));
      return { teamId, response: json(200, outcome) };
    },
    async endComp(event, op) {
      const teamId = teamIdFrom(event);
      const body = jsonBody(event, ["reason", "expectedVersion"]);
      const outcome = await endComp(deps.dbFor(op.sub, teamId), op, teamId, { ...body, idempotencyKey: header(event, IDEMPOTENCY_HEADER) } as Parameters<typeof endComp>[3], new Date(now()));
      return { teamId, response: json(200, outcome) };
    },
    async listAudit(event, op) {
      const q = event.queryStringParameters ?? {};
      if (q.teamId !== undefined && q.month !== undefined) throw new ApiError(400, "bad_request", "Give teamId or month, not both");
      if (q.teamId !== undefined && !ID.test(q.teamId)) throw new ApiError(400, "bad_request", "Invalid team ID");
      const month = q.teamId === undefined ? (q.month ?? new Date(now()).toISOString().slice(0, 7)) : undefined;
      const page = await listOperatorAudit(deps.dbFor(op.sub), op, { teamId: q.teamId, month, cursor: q.cursor, limit: limitFrom(q.limit) });
      return { teamId: q.teamId, response: json(200, { events: page.items.map(auditBody), ...(page.cursor ? { cursor: page.cursor } : {}) }) };
    },
  };

  return async (event: OpsEvent, context?: Context): Promise<APIGatewayProxyStructuredResultV2> => {
    void context;
    const started = now();
    const action = ROUTES.get(event.routeKey);
    let status = 500;
    let operatorSub = "";
    let teamId = "";
    try {
      if (!action) throw new ApiError(404, "not_found", "No such route");
      const op = await operator(event);
      operatorSub = op.sub;
      const result = await actions[action](event, op);
      teamId = result.teamId ?? "";
      status = result.response.statusCode ?? 200;
      return result.response;
    } catch (error) {
      const apiError = errorFor(error);
      status = apiError.status;
      if (apiError.status >= 500) obs.logger.error("Request failed", error as Error);
      return errorResponse(apiError);
    } finally {
      // IDs only: the team in the path, and the operator's sub once verified
      obs.logger.info("Ops request", { route: event.routeKey, action: action ?? "", teamId: teamId || (ID.test(event.pathParameters?.teamId ?? "") ? event.pathParameters?.teamId : ""), operator: operatorSub, status, ms: now() - started });
    }
  };
}
