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
//
// Next to the document routes are the inventory commands (checkout, return,
// stock adjust), each one transaction that's idempotent by operation ID, and
// a product's stock history (backend/src/data/commands.ts, docs/api/commands.md),
// and the CSV inventory import, owners only (backend/src/data/imports.ts).

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import {
  adjustStockCommand,
  authorizeTeam,
  checkout,
  type Collection,
  type CommandOutcome,
  ConflictError,
  deleteDocument,
  ForbiddenError,
  getDocument,
  importProducts,
  InvalidInputError,
  LimitReachedError,
  listDocuments,
  listMovements,
  NotFoundError,
  returnItems,
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
const WRITES = new Set(["set", "update", "delete", "checkout", "return", "adjustStock", "importProducts"]);
/** Roles that may write through the API. Anything else (viewer, or a role we don't know) is read-only. */
const WRITERS = new Set(["contributor", "owner"]);
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
export function documentId(event: DataEvent, fromEnd = 0): string {
  const segments = event.rawPath.split("/");
  const raw = segments[segments.length - 1 - fromEnd] ?? "";
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

// Every document write names the version it was made against (ADR 0006), so two people
// editing the same sheet or item can't silently overwrite each other: 0 for a document
// that shouldn't exist yet, otherwise the version the client last read. A stale one is 409.
function expectedVersionFrom(value: unknown): number {
  if (value === undefined) throw new ApiError(400, "bad_request", "expectedVersion is required");
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
    const old = Object.hasOwn(before, key) ? before[key] : undefined;
    checkouts += Math.max(0, int(line?.out) - int(old?.out));
    returns += Math.max(0, int(line?.returned) - int(old?.returned));
  }
  return { checkouts, returns };
}

const CHECKOUT_FIELDS = ["operationId", "productKey", "quantity", "name", "price", "code", "cost"];
const RETURN_FIELDS = ["operationId", "productKey", "quantity"];
const STOCK_FIELDS = ["operationId", "reason", "quantity", "unitCost", "count"];

/**
 * A command's response: what it did (the same on a replay), and the sheet and
 * product as they are now, read after the write.
 */
async function commandResponse(deps: DataHandlerDeps, ctx: TeamContext, outcome: CommandOutcome): Promise<APIGatewayProxyStructuredResultV2> {
  const db = deps.dbForTeam(ctx.teamId);
  const { result, replayed } = outcome;
  const metadata = { teamId: ctx.teamId };
  if (!replayed) {
    deps.obs.count(BusinessMetric.Writes, 1, metadata);
    if (result.command === "checkout") deps.obs.count(BusinessMetric.Checkouts, result.quantity ?? 0, metadata);
    if (result.command === "return") deps.obs.count(BusinessMetric.Returns, result.quantity ?? 0, metadata);
  }
  const [sheet, product] = await Promise.all([
    result.sheetId === undefined ? undefined : getDocument(db, ctx, "sheets", result.sheetId),
    getDocument(db, ctx, "products", result.productKey),
  ]);
  return json(200, {
    operationId: result.operationId,
    replayed,
    result,
    ...(result.sheetId === undefined ? {} : { sheet: sheet ? toBody(sheet) : null }),
    product: product ? toBody(product) : null,
  });
}

async function runCommand(deps: DataHandlerDeps, route: DataRoute, event: DataEvent, ctx: TeamContext): Promise<APIGatewayProxyStructuredResultV2> {
  const db = deps.dbForTeam(ctx.teamId);
  const at = new Date((deps.now ?? Date.now)());
  if (route.operation === "movements") {
    const q = event.queryStringParameters ?? {};
    let limit: number | undefined;
    if (q.limit !== undefined) {
      if (!/^\d{1,3}$/.test(q.limit)) throw new ApiError(400, "bad_request", "limit is a number from 1 to 100");
      limit = Number(q.limit);
    }
    const page = await listMovements(db, ctx, documentId(event, 1), { limit, cursor: q.cursor });
    return json(200, { movements: page.items, ...(page.cursor ? { cursor: page.cursor } : {}) });
  }
  if (route.operation === "adjustStock") {
    const body = jsonBody(event, STOCK_FIELDS);
    return commandResponse(deps, ctx, await adjustStockCommand(db, ctx, { ...body, productKey: documentId(event, 1) } as Parameters<typeof adjustStockCommand>[2], at));
  }
  const sheetId = documentId(event, 1);
  if (route.operation === "checkout") {
    const body = jsonBody(event, CHECKOUT_FIELDS);
    return commandResponse(deps, ctx, await checkout(db, ctx, { ...body, sheetId } as Parameters<typeof checkout>[2], at));
  }
  const body = jsonBody(event, RETURN_FIELDS);
  return commandResponse(deps, ctx, await returnItems(db, ctx, { ...body, sheetId } as Parameters<typeof returnItems>[2], at));
}

const COMMANDS = new Set(["checkout", "return", "adjustStock", "movements"]);
const IMPORT_FIELDS = ["importId", "csv", "dryRun"];

/**
 * A CSV inventory import (data/imports.ts). A dry run answers 200 with the
 * preview, problems included. An import with bad rows answers 400 with every
 * problem, and nothing is written.
 */
async function runImport(deps: DataHandlerDeps, event: DataEvent, ctx: TeamContext): Promise<APIGatewayProxyStructuredResultV2> {
  // The data layer checks the role too; this says why in words the app can show
  if (ctx.role !== "owner") throw new ApiError(403, "permission_denied", "Only the team's owners can import inventory");
  const body = jsonBody(event, IMPORT_FIELDS);
  const outcome = await importProducts(deps.dbForTeam(ctx.teamId), ctx, body as { csv: unknown }, new Date((deps.now ?? Date.now)()));
  if (outcome.status === "invalid" && body.dryRun !== true) {
    const n = outcome.errorCount;
    return json(400, {
      error: { code: "bad_request", message: `${n} ${n === 1 ? "row has a problem" : "rows have problems"}; nothing was imported` },
      errors: outcome.errors,
      errorCount: n,
    });
  }
  if (outcome.status === "imported" && !outcome.replayed) {
    const { created, updated } = outcome.summary;
    if (created + updated) deps.obs.count(BusinessMetric.Writes, created + updated, { teamId: ctx.teamId });
  }
  return json(200, outcome);
}

async function run(deps: DataHandlerDeps, route: DataRoute, event: DataEvent, ctx: TeamContext): Promise<APIGatewayProxyStructuredResultV2> {
  if (route.operation === "importProducts") return runImport(deps, event, ctx);
  if (COMMANDS.has(route.operation)) return runCommand(deps, route, event, ctx);
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
      if (WRITES.has(route.operation) && !WRITERS.has(ctx.role)) throw viewOnly();
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
