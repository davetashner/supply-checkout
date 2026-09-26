// The data API: the app's `products` and `sheets` documents over HTTP
// (ADR 0006, docs/api/openapi.yaml).
//
// Team isolation, in order, on every request:
// 1. API Gateway's JWT authorizer checks the Cognito access token.
// 2. This handler re-checks the claims it gets (an access token, not expired)
//    and takes the user ID only from `sub`.
// 3. The team comes only from the path. authorizeTeam reads the caller's
//    MEMBER item for it and issues the TeamContext every data function needs;
//    no membership, no context. The body can't name a team.
// 4. Writes need the contributor role or above. Viewers get 403
//    `invalid_argument`, the code the app reads as "view-only access".
// 5. Every DynamoDB call runs on a role session tagged with the path's team,
//    whose IAM policy allows only that team's partition (team-db.ts).

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import {
  authorizeTeam,
  type Collection,
  ConflictError,
  deleteDocument,
  ForbiddenError,
  getDocument,
  InvalidInputError,
  LimitReachedError,
  listDocuments,
  NotFoundError,
  setDocument,
  type StoredDocument,
  type TeamContext,
  TooLargeError,
  updateDocument,
  type WriteResult,
} from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { ApiError, errorFor as apiErrorFor, errorResponse, json, jsonBody, noContent, viewOnly } from "./http.js";
import { DATA_ROUTES, type DataRoute, routeKey } from "./routes.js";
import type { DbForTeam } from "./team-db.js";

export type DataEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

export interface DataHandlerDeps {
  readonly dbForTeam: DbForTeam;
  readonly obs: Observability;
  readonly now?: () => number;
}

const ROUTES = new Map(DATA_ROUTES.map((r) => [routeKey(r), r]));
const WRITES = new Set(["set", "update", "delete"]);
const SUB = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Maps the data layer's errors to responses. Their messages are safe to show;
 * anything unexpected is a 500 whose details stay in the logs.
 */
export function errorFor(error: unknown): ApiError {
  if (error instanceof InvalidInputError) return new ApiError(400, "bad_request", error.message);
  if (error instanceof NotFoundError) return new ApiError(404, "not_found", error.message);
  if (error instanceof ConflictError) return new ApiError(409, "aborted", error.message);
  if (error instanceof TooLargeError) return new ApiError(413, "quota_exceeded", error.message);
  if (error instanceof LimitReachedError) return new ApiError(429, "quota_exceeded", error.message);
  // The role check (a viewer writing). The membership check maps its own
  // ForbiddenError to permission_denied before an operation runs.
  if (error instanceof ForbiddenError) return viewOnly();
  return apiErrorFor(error);
}

/** The verified caller's user ID. API Gateway checked the token; this is the second look. */
export function callerId(event: DataEvent, now: number): string {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  if (!claims) throw new ApiError(401, "unauthenticated", "Sign in again");
  // ID tokens are for the app to read, not for calling the API
  if (claims.token_use !== "access") throw new ApiError(401, "unauthenticated", "Use an access token");
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= now) throw new ApiError(401, "unauthenticated", "Your session expired; sign in again");
  const sub = claims.sub;
  if (typeof sub !== "string" || !SUB.test(sub)) throw new ApiError(401, "unauthenticated", "Sign in again");
  return sub;
}

/**
 * The document ID: the last segment of the raw (still percent-encoded) path,
 * decoded once. The raw path is used because API Gateway's decoded path
 * parameters would make a key containing "%" ambiguous.
 */
export function documentId(event: DataEvent): string {
  const raw = event.rawPath.split("/").pop() ?? "";
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new ApiError(400, "bad_request", "Invalid document ID");
  }
  // A "/" can't round-trip through a path segment; the app's keys never have one (keyOf in src/format.js)
  if (id.includes("/")) throw new ApiError(400, "bad_request", "Invalid document ID");
  return id;
}

function expectedVersionFrom(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new ApiError(400, "bad_request", "expectedVersion must be a whole number");
  return n;
}

const toBody = (doc: StoredDocument) => ({ id: doc.id, version: doc.version, data: doc.data });

const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
type Lines = Record<string, { out?: unknown; returned?: unknown } | undefined>;
const linesOf = (doc: StoredDocument | undefined): Lines => {
  const items = doc?.data.items;
  return typeof items === "object" && items !== null && !Array.isArray(items) ? (items as Lines) : {};
};

/** Units checked out and returned by a sheet write: what went up on each line. */
export function sheetMovement(result: WriteResult): { checkouts: number; returns: number } {
  const before = linesOf(result.before);
  const after = linesOf(result.after);
  let checkouts = 0;
  let returns = 0;
  for (const [key, line] of Object.entries(after)) {
    const old = before[key];
    checkouts += Math.max(0, int(line?.out) - int(old?.out));
    returns += Math.max(0, int(line?.returned) - int(old?.returned));
  }
  return { checkouts, returns };
}

async function run(deps: DataHandlerDeps, route: DataRoute, event: DataEvent, ctx: TeamContext): Promise<APIGatewayProxyStructuredResultV2> {
  const db = deps.dbForTeam(ctx.teamId);
  const collection: Collection = route.collection;
  const metadata = { teamId: ctx.teamId };

  if (route.operation === "list") {
    const q = event.queryStringParameters ?? {};
    let orderBy: "date" | undefined;
    if (q.orderBy !== undefined) {
      if (q.orderBy !== "date" || collection !== "sheets") throw new ApiError(400, "bad_request", "Only sheets can be ordered, and only by date");
      orderBy = "date";
    }
    if (q.direction !== undefined && q.direction !== "asc" && q.direction !== "desc") throw new ApiError(400, "bad_request", "direction is asc or desc");
    if (q.direction !== undefined && !orderBy) throw new ApiError(400, "bad_request", "direction needs orderBy");
    let limit: number | undefined;
    if (q.limit !== undefined) {
      if (!/^\d{1,4}$/.test(q.limit)) throw new ApiError(400, "bad_request", "limit is a number from 1 to 1000");
      limit = Number(q.limit);
    }
    const page = await listDocuments(db, ctx, collection, { orderBy, descending: q.direction === "desc", limit, cursor: q.cursor });
    return json(200, { documents: page.items.map(toBody), ...(page.cursor ? { cursor: page.cursor } : {}) });
  }

  if (route.operation === "get") {
    const doc = await getDocument(db, ctx, collection, documentId(event));
    if (!doc) throw new ApiError(404, "not_found", "No such document");
    return json(200, toBody(doc));
  }

  if (route.operation === "delete") {
    const expectedVersion = expectedVersionFrom(event.queryStringParameters?.expectedVersion);
    await deleteDocument(db, ctx, collection, documentId(event), { expectedVersion });
    deps.obs.count(BusinessMetric.Writes, 1, metadata);
    return noContent();
  }

  const body = jsonBody(event, ["data", "expectedVersion"]);
  if (!("data" in body)) throw new ApiError(400, "bad_request", "Body needs a data object");
  const expectedVersion = expectedVersionFrom(body.expectedVersion);
  const id = documentId(event);
  const result =
    route.operation === "set"
      ? await setDocument(db, ctx, collection, id, body.data, { expectedVersion })
      : await updateDocument(db, ctx, collection, id, body.data, { expectedVersion });
  deps.obs.count(BusinessMetric.Writes, 1, metadata);
  if (collection === "sheets") {
    const { checkouts, returns } = sheetMovement(result);
    if (checkouts) deps.obs.count(BusinessMetric.Checkouts, checkouts, metadata);
    if (returns) deps.obs.count(BusinessMetric.Returns, returns, metadata);
  }
  return json(200, toBody(result.after));
}

export function createDataHandler(deps: DataHandlerDeps) {
  const now = deps.now ?? Date.now;
  return async (event: DataEvent, context?: Context): Promise<APIGatewayProxyStructuredResultV2> => {
    void context;
    const started = now();
    const route = ROUTES.get(event.routeKey);
    const teamId = event.pathParameters?.teamId;
    let status = 500;
    try {
      if (!route) throw new ApiError(404, "not_found", "No such route");
      const userId = callerId(event, now());
      if (typeof teamId !== "string") throw new ApiError(400, "bad_request", "Missing team ID");
      let ctx: TeamContext;
      try {
        ctx = await authorizeTeam(deps.dbForTeam(teamId), userId, teamId);
      } catch (error) {
        // Not a member, or no such team: the same answer for both, so the
        // response doesn't reveal which teams exist
        if (error instanceof ForbiddenError) throw new ApiError(403, "permission_denied", "You're not a member of this team");
        throw error;
      }
      if (WRITES.has(route.operation) && ctx.role === "viewer") throw viewOnly();
      const response = await run(deps, route, event, ctx);
      status = response.statusCode ?? 200;
      return response;
    } catch (error) {
      const apiError = errorFor(error);
      status = apiError.status;
      if (apiError.status === 409) deps.obs.count(BusinessMetric.ConditionalWriteConflicts, 1, teamId ? { teamId } : {});
      if (apiError.status >= 500) deps.obs.logger.error("Request failed", error as Error);
      return errorResponse(apiError);
    } finally {
      deps.obs.logger.info("Request", { route: event.routeKey, teamId: teamId ?? "", status, ms: now() - started });
    }
  };
}
