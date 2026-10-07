// Reads one receipt photo with Claude on Amazon Bedrock (ADR 0008) and
// returns the shape the app's review screen reads, checked here whatever the
// model sent: structured outputs constrain the reply, and this is the second
// look. Nothing is saved; the user checks every line before saving.
//
// Never logged or kept: the photo, the inventory, the prompt or anything the
// model read. Callers log sizes, timings, token counts and error names only.

import { APIConnectionTimeoutError, APIError, APIUserAbortError, BadRequestError, RateLimitError, UnprocessableEntityError } from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import { withoutHiddenCharacters } from "../text/hidden-characters.js";
import { inventoryList, type InventoryItem, RECEIPT_INSTRUCTIONS, RECEIPT_SCHEMA } from "./prompt.js";

/** The part of the Anthropic Bedrock client this uses, so tests can fake it. */
export interface ReceiptModel {
  readonly messages: {
    create(body: MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal; timeout?: number; maxRetries?: number }): PromiseLike<Message>;
  };
}

/** Media types the endpoint takes, as the app's runtime says (limits().images.mediaTypes). */
export const RECEIPT_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export type ReceiptMediaType = (typeof RECEIPT_MEDIA_TYPES)[number];

/** Room for the reply: a long receipt's lines are a few thousand tokens. */
export const RECEIPT_MAX_TOKENS = 4096;

/** The most lines a reply may have; more is not a receipt. */
export const MAX_RECEIPT_LINES = 200;
const MAX_TEXT = 300;
const MAX_QTY = 100_000;
const MAX_MONEY = 1_000_000;

/**
 * Why a read failed. `image_rejected`: the model service refused the image
 * (the caller's photo). `model_busy`: throttled. `timeout`: it didn't answer
 * by the deadline. `invalid_output`: the reply wasn't the schema's shape, was
 * cut short or was refused. `unavailable`: anything else on the model
 * service's side.
 */
export type ReceiptFailure = "image_rejected" | "model_busy" | "timeout" | "invalid_output" | "unavailable";

export class ReceiptReadError extends Error {
  override readonly name = "ReceiptReadError";
  readonly kind: ReceiptFailure;
  /** The underlying error's name or the model's stop reason: safe to log, never its message. */
  readonly detail: string;
  /**
   * The model service refused the call before doing any work it bills for:
   * a throttle (429) or 503 Service Unavailable. Only these give the team's
   * read back (refundReceipt); every other failure may have been billed.
   */
  readonly refundable: boolean;

  constructor(kind: ReceiptFailure, detail: string, refundable = false) {
    super(`Receipt read failed: ${kind}`);
    this.kind = kind;
    this.detail = detail;
    this.refundable = refundable;
  }
}

export interface ReceiptLine {
  readonly raw: string;
  readonly name: string;
  readonly qty: number;
  readonly price: number;
  /** The matched product's key, or null. */
  readonly match: string | null;
}

export interface ReceiptResult {
  readonly store: string | null;
  readonly date: string | null;
  readonly items: ReceiptLine[];
  readonly subtotal: number | null;
  readonly tax: number | null;
  readonly total: number | null;
}

export interface ReceiptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly stopReason: string;
}

export interface ReadReceiptInput {
  readonly modelId: string;
  readonly image: { readonly mediaType: ReceiptMediaType; readonly data: string };
  readonly inventory: readonly InventoryItem[];
  /** Aborts the call: the deadline. */
  readonly signal: AbortSignal;
  /** Milliseconds the SDK may wait for one attempt. */
  readonly timeoutMs: number;
}

/** Reads the receipt, or throws ReceiptReadError. */
export async function readReceipt(model: ReceiptModel, input: ReadReceiptInput): Promise<{ result: ReceiptResult; usage: ReceiptUsage }> {
  const { text: inventory, ids } = inventoryList(input.inventory);
  let message: Message;
  try {
    message = await model.messages.create(
      {
        model: input.modelId,
        max_tokens: RECEIPT_MAX_TOKENS,
        // Fixed instructions, then the inventory, with the cache breakpoint
        // after it: repeat scans by a team within minutes reuse the prefix
        system: [
          { type: "text", text: RECEIPT_INSTRUCTIONS },
          { type: "text", text: inventory, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: input.image.mediaType, data: input.image.data } },
              { type: "text", text: "Read this receipt." },
            ],
          },
        ],
        output_config: { format: { type: "json_schema", schema: RECEIPT_SCHEMA as unknown as Record<string, unknown> } },
      },
      // One retry for a throttle or a 5xx, inside the same deadline
      { signal: input.signal, timeout: input.timeoutMs, maxRetries: 1 },
    );
  } catch (error) {
    throw failureFor(error, input.signal);
  }
  const usage: ReceiptUsage = {
    inputTokens: count(message.usage?.input_tokens),
    outputTokens: count(message.usage?.output_tokens),
    cacheReadTokens: count(message.usage?.cache_read_input_tokens),
    cacheWriteTokens: count(message.usage?.cache_creation_input_tokens),
    stopReason: String(message.stop_reason ?? "none"),
  };
  // A refusal or a reply cut short may not match the schema: never read one
  if (message.stop_reason !== "end_turn") throw Object.assign(new ReceiptReadError("invalid_output", usage.stopReason), { usage });
  const text = message.content.find((block) => block.type === "text");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text?.type === "text" ? text.text : "");
  } catch {
    throw Object.assign(new ReceiptReadError("invalid_output", "SyntaxError"), { usage });
  }
  const result = checkResult(parsed, ids);
  if (!result) throw Object.assign(new ReceiptReadError("invalid_output", "ShapeError"), { usage });
  return { result, usage };
}

/** The token usage a failed read still had, when the model answered. */
export function usageOf(error: unknown): ReceiptUsage | undefined {
  return (error as { usage?: ReceiptUsage } | null)?.usage;
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

function failureFor(error: unknown, signal: AbortSignal): ReceiptReadError {
  // Fixed names, not the classes' own: the bundle is minified, and an error's message is never logged
  if (signal.aborted || error instanceof APIUserAbortError) return new ReceiptReadError("timeout", "Aborted");
  if (error instanceof APIConnectionTimeoutError) return new ReceiptReadError("timeout", "ConnectionTimeout");
  if (error instanceof RateLimitError) return new ReceiptReadError("model_busy", "RateLimit:429", true);
  // Bedrock answers 400 for an image it can't use (too large, not decodable, wrong type)
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) return new ReceiptReadError("image_rejected", `BadRequest:${error.status}`);
  if (error instanceof APIError) return new ReceiptReadError("unavailable", `APIError:${String(error.status ?? "none")}`, error.status === 503);
  const name = (error as { name?: unknown } | null)?.name;
  return new ReceiptReadError("unavailable", typeof name === "string" ? name.slice(0, 64) : "Error");
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // Without invisible characters (src/text/hidden-characters.ts): a name read here can become an item's name
  const t = withoutHiddenCharacters(withoutHiddenCharacters(v).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT));
  return t || null;
}

function amount(v: unknown, max = MAX_MONEY): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) return null;
  return Math.round(v * 100) / 100;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/**
 * The reply, checked: null unless it's an object with an items array of at
 * most MAX_RECEIPT_LINES. Each field is kept only when it's the right type
 * and in range; a line without a name is dropped, a quantity that isn't a
 * positive number becomes 1, and a match is kept only when it's one of the
 * inventory ids the prompt listed, as that product's key.
 */
export function checkResult(value: unknown, ids: ReadonlyMap<string, string>): ReceiptResult | null {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > MAX_RECEIPT_LINES) return null;
  const items: ReceiptLine[] = [];
  for (const raw of value.items) {
    if (!isRecord(raw)) continue;
    const name = text(raw.name);
    if (!name) continue;
    const qty = typeof raw.qty === "number" && Number.isFinite(raw.qty) && raw.qty > 0 ? Math.min(MAX_QTY, raw.qty) : 1;
    const match = typeof raw.match === "string" ? (ids.get(raw.match) ?? null) : null;
    items.push({ raw: text(raw.raw) ?? "", name, qty, price: amount(raw.price) ?? 0, match });
  }
  return {
    store: text(value.store),
    date: isoDate(value.date),
    items,
    subtotal: amount(value.subtotal),
    tax: amount(value.tax),
    total: amount(value.total),
  };
}
