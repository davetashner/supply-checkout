// Reading a receipt photo (ADR 0008, docs/api/openapi.yaml):
// POST /teams/{teamId}/receipts/read with the photo, answered with the lines
// Claude read from it, for the app's review screen. Nothing is saved, here or
// anywhere: the user checks every line and saves through the data API.
//
// In order, on every request:
// 1. The caller is checked as on every team route (data-handler.ts): an
//    access token, the user from `sub`, the team from the path only, the
//    membership read on the team-scoped role session (team-db.ts), and at
//    least contributor (routes.ts, minRole).
// 2. The photo is checked before anything is spent: a JPEG or PNG, by its
//    bytes as well as its declared type, at most MAX_RECEIPT_IMAGE_BYTES.
// 3. One receipt is counted against the team's monthly limit, atomically, so
//    two reads at once can't both take the last one (data/usage.ts). The
//    count also refuses a closed team and one whose subscription ended.
// 4. The team's inventory is read for matching, and the model is called with
//    a deadline (RECEIPT_DEADLINE_MS) under API Gateway's 30 seconds.
//
// Logs and metrics carry sizes, timings, token counts and error names only:
// never the photo, the prompt, the inventory or anything the model read.

import type { APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { authorizeTeam, ForbiddenError, LimitReachedError, listDocuments, RECEIPTS_PER_TEAM_PER_MONTH, recordReceiptRead, type TeamContext, usageMonth } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { MAX_INVENTORY_LINES } from "../receipts/prompt.js";
import { RECEIPT_MEDIA_TYPES, type ReceiptMediaType, type ReceiptModel, ReceiptReadError, readReceipt, usageOf } from "../receipts/reader.js";
import { callerId, type DataEvent, errorFor } from "./data-handler.js";
import { ApiError, errorResponse, json, jsonBody, notMember } from "./http.js";
import { requireRole } from "./roles.js";
import { RECEIPT_ROUTES, routeKey } from "./routes.js";
import type { DbForTeam } from "./team-db.js";

/**
 * The largest photo the endpoint takes, decoded. The app shrinks photos to at
 * most 600 KB (src/photo.js); this leaves room for a phone whose browser
 * can't, and stays well under the model's 5 MB image limit.
 */
export const MAX_RECEIPT_IMAGE_BYTES = 1_500_000;
/** The smallest: anything less isn't a photo. */
const MIN_RECEIPT_IMAGE_BYTES = 100;
/** The body: the photo as base64 plus a little JSON. */
export const MAX_RECEIPT_BODY_BYTES = Math.ceil(MAX_RECEIPT_IMAGE_BYTES / 3) * 4 + 1024;

/**
 * How long the model may take. API Gateway's HTTP API gives up at 30
 * seconds, so the call is aborted before that and the app gets a timeout it
 * can say something about.
 */
export const RECEIPT_DEADLINE_MS = 25_000;
/** Time kept back from the function's own timeout for the response and the logs. */
const SAFETY_MS = 2_000;

export interface ReceiptsHandlerDeps {
  readonly dbForTeam: DbForTeam;
  readonly obs: Observability;
  readonly model: ReceiptModel;
  /** RECEIPT_MODEL_ID. */
  readonly modelId: string;
  readonly now?: () => number;
  /** Defaults to RECEIPT_DEADLINE_MS. */
  readonly deadlineMs?: number;
  /** Defaults to RECEIPTS_PER_TEAM_PER_MONTH. */
  readonly monthlyLimit?: number;
}

const ROUTES = new Map(RECEIPT_ROUTES.map((r) => [routeKey(r), r]));
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const imageRejected = (message: string, status = 400) =>
  new ApiError(status, status === 413 ? "quota_exceeded" : "bad_request", message, "image_rejected");

/** True if the bytes start the way a file of `type` does. */
function looksLike(bytes: Buffer, type: ReceiptMediaType): boolean {
  if (type === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** The body's photo, checked: `{ "image": { "mediaType": "image/jpeg", "data": "<base64>" } }`. */
export function receiptImage(value: unknown): { mediaType: ReceiptMediaType; data: string; bytes: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw imageRejected("Body needs an image object");
  const image = value as Record<string, unknown>;
  for (const field of Object.keys(image)) if (field !== "mediaType" && field !== "data") throw new ApiError(400, "bad_request", `Unexpected field "image.${field}"`);
  const { mediaType, data } = image;
  if (typeof mediaType !== "string" || !(RECEIPT_MEDIA_TYPES as readonly string[]).includes(mediaType)) throw imageRejected("The photo must be a JPEG or PNG");
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) throw imageRejected("The photo must be base64");
  // Before decoding: the decoded size is at most three quarters of the text
  if ((data.length / 4) * 3 > MAX_RECEIPT_IMAGE_BYTES + 2) throw imageRejected("The photo is too large", 413);
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_RECEIPT_IMAGE_BYTES) throw imageRejected("The photo is too large", 413);
  if (bytes.length < MIN_RECEIPT_IMAGE_BYTES || !looksLike(bytes, mediaType as ReceiptMediaType)) throw imageRejected("That isn't a JPEG or PNG photo");
  // Sent on as the decoded bytes encoded again, so only the checked bytes reach the model
  return { mediaType: mediaType as ReceiptMediaType, data: bytes.toString("base64"), bytes: bytes.length };
}

/** A failed read as the response the app's runtime maps to its own codes (src/receipt-prompt.js, sampleErr). */
function readFailure(error: ReceiptReadError): ApiError {
  switch (error.kind) {
    case "image_rejected":
      return new ApiError(400, "bad_request", "That photo couldn't be read. Try a JPEG or PNG photo.", "image_rejected");
    case "model_busy":
      return new ApiError(429, "quota_exceeded", "Receipt reading is busy right now. Wait a minute and try again.", "model_busy");
    case "timeout":
      return new ApiError(504, "unavailable", "Reading the receipt took too long. Try again.", "model_timeout");
    case "invalid_output":
      return new ApiError(502, "internal", "The receipt couldn't be read cleanly. Try again, or take a sharper photo.", "invalid_output");
    default:
      return new ApiError(503, "unavailable", "Receipt reading isn't available right now. Try again in a few minutes.");
  }
}

export function createReceiptsHandler(deps: ReceiptsHandlerDeps) {
  const now = deps.now ?? Date.now;
  const limit = deps.monthlyLimit ?? RECEIPTS_PER_TEAM_PER_MONTH;
  const deadlineMs = deps.deadlineMs ?? RECEIPT_DEADLINE_MS;

  async function read(event: DataEvent, ctx: TeamContext, context: Context | undefined, log: Record<string, string | number>): Promise<APIGatewayProxyStructuredResultV2> {
    const body = jsonBody(event, ["image"], MAX_RECEIPT_BODY_BYTES);
    const image = receiptImage(body.image);
    log.imageBytes = image.bytes;
    const db = deps.dbForTeam(ctx.teamId);
    const month = usageMonth(new Date(now()));
    let used: number;
    try {
      used = await recordReceiptRead(db, ctx, month, limit);
    } catch (error) {
      if (error instanceof LimitReachedError) throw new ApiError(429, "quota_exceeded", `This team has read all ${limit} receipts included this month.`, "receipt_limit");
      throw error;
    }
    const products = await listDocuments(db, ctx, "products", { limit: MAX_INVENTORY_LINES });
    const inventory = products.items.map((doc) => ({ key: doc.id, name: doc.data.name, price: doc.data.price }));
    log.inventoryItems = inventory.length;

    // The deadline: RECEIPT_DEADLINE_MS, or less if the function has less time left
    const remaining = context?.getRemainingTimeInMillis ? context.getRemainingTimeInMillis() - SAFETY_MS : deadlineMs;
    const budget = Math.max(1, Math.min(deadlineMs, remaining));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), budget);
    const started = now();
    const metadata = { teamId: ctx.teamId };
    deps.obs.count(BusinessMetric.ReceiptReads, 1, metadata);
    try {
      const { result, usage } = await readReceipt(deps.model, { modelId: deps.modelId, image, inventory, signal: abort.signal, timeoutMs: budget });
      Object.assign(log, { modelMs: now() - started, items: result.items.length, ...tokenFields(usage) });
      return json(200, { ...result, usage: { month, used, limit } });
    } catch (error) {
      if (!(error instanceof ReceiptReadError)) throw error;
      deps.obs.count(BusinessMetric.ReceiptReadFailures, 1, metadata);
      Object.assign(log, { modelMs: now() - started, failure: error.kind, failureDetail: error.detail, ...tokenFields(usageOf(error)) });
      throw readFailure(error);
    } finally {
      clearTimeout(timer);
      const tokens = usageOrNone(log);
      if (tokens) deps.obs.count(BusinessMetric.ReceiptTokens, tokens, metadata);
      if (typeof log.modelMs === "number") deps.obs.gauge(BusinessMetric.ReceiptReadLatency, log.modelMs, "Milliseconds");
    }
  }

  return async (event: DataEvent, context?: Context): Promise<APIGatewayProxyStructuredResultV2> => {
    const started = now();
    const route = ROUTES.get(event.routeKey);
    const teamId = event.pathParameters?.teamId;
    const log: Record<string, string | number> = {};
    let status = 500;
    try {
      if (!route) throw new ApiError(404, "not_found", "No such route");
      const userId = callerId(event, now());
      if (typeof teamId !== "string") throw new ApiError(400, "bad_request", "Missing team ID");
      let ctx: TeamContext;
      try {
        ctx = await authorizeTeam(deps.dbForTeam(teamId), userId, teamId);
      } catch (error) {
        // Not a member, or no such team: one answer for both
        if (error instanceof ForbiddenError) throw notMember();
        throw error;
      }
      requireRole(ctx.role, route.minRole);
      const response = await read(event, ctx, context, log);
      status = response.statusCode ?? 200;
      return response;
    } catch (error) {
      const apiError = errorFor(error);
      status = apiError.status;
      // The error's name only: a message could carry what was read
      if (apiError.status >= 500 && !(error instanceof ApiError)) log.errorName = String((error as { name?: unknown } | null)?.name ?? "Error").slice(0, 64);
      return errorResponse(apiError);
    } finally {
      deps.obs.logger.info("Request", { route: event.routeKey, teamId: teamId ?? "", status, ms: now() - started, ...log });
    }
  };
}

function tokenFields(usage: ReturnType<typeof usageOf>): Record<string, string | number> {
  if (!usage) return {};
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens, stopReason: usage.stopReason };
}

/** Every token the read was billed for, from its log fields. */
function usageOrNone(log: Record<string, string | number>): number {
  return ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"].reduce((n, k) => n + (typeof log[k] === "number" ? (log[k] as number) : 0), 0);
}
