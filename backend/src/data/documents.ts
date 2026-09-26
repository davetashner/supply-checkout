// The app's document model (ADR 0004, 0006): `products/<key>` and
// `sheets/<id>` as free-form JSON documents with get, set (replace), update
// (deep merge), delete and list, the operations the app calls through
// `window.claude.use("db")`. The HTTP data API (src/api) serves these, and the
// browser adapter maps the app's calls onto it.
//
// Documents are stored as the same items the typed functions in products.ts
// and sheets.ts use (ADR 0005): the document's fields at the top level, plus
// the key attributes and a few fields the server owns (RESERVED_FIELDS), which
// never appear in a document's data and can't be written by a client.
//
// Every write reads the item, builds the new one, and puts it on the
// condition that nobody changed it since the read (its version, and for
// products the atomically adjusted `stock`). That gives `update` the app's
// exact deep-merge semantics, gives every write a new version (ADR 0006), and
// makes each write one PutItem or DeleteItem, which is one stream record for
// live updates (supply-checkout-dpc). With an expected version, a write that
// finds another version, or loses a race, fails with ConflictError. The data
// API always passes one (ADR 0006); without one, a lost race is retried on
// the fresh item (last writer wins), for callers inside the backend.

import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection, storable } from "./client.js";
import { ConflictError, InvalidInputError, NotFoundError, TooLargeError } from "./errors.js";
import { barcode, id as checkId, keys, prefixes, productKey, teamPartition } from "./keys.js";
import { type Page, queryPage } from "./query.js";
import { GSI1, GSI1PK, PK } from "./schema.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export type Collection = "products" | "sheets";
export const COLLECTIONS: readonly Collection[] = ["products", "sheets"];

export type DocumentData = Record<string, unknown>;

export interface StoredDocument {
  /** The product key or sheet ID: the last segment of the document's path. */
  readonly id: string;
  /** Starts at 1 and goes up by one with every write. */
  readonly version: number;
  /** The document's fields, as the app wrote them. */
  readonly data: DocumentData;
}

export interface WriteResult {
  /** The document before the write, if it existed. */
  readonly before?: StoredDocument;
  readonly after: StoredDocument;
}

export interface WriteOptions {
  /**
   * Fail with ConflictError unless the stored version is this one. 0 means
   * "only if it doesn't exist yet". Omit it for last-writer-wins.
   */
  readonly expectedVersion?: number;
}

export interface ListOptions {
  /** Sheets only: date order through GSI1, which is eventually consistent. */
  readonly orderBy?: "date";
  /** With orderBy: newest first. */
  readonly descending?: boolean;
  /** At most this many documents (1–1000). A page also stops at 1 MB. */
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Fields the server owns: key and index attributes, the item type, the
 * document's ID and version, and the team (which comes from the path, never
 * the body). A document can't contain them.
 */
export const RESERVED_FIELDS: readonly string[] = ["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK", "type", "id", "key", "version", "teamId"];
const RESERVED = new Set(RESERVED_FIELDS);

/**
 * The largest document, as UTF-8 JSON. DynamoDB's item limit is 400 KB,
 * counting attribute names; this leaves room for them and the server's fields.
 */
export const MAX_DOCUMENT_BYTES = 350_000;

/** DynamoDB allows 32 levels of nesting; the app uses 3 (a sheet's items map). */
const MAX_DEPTH = 16;
const MAX_ATTEMPTS = 5;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkCollection(collection: Collection): Collection {
  if (!COLLECTIONS.includes(collection)) throw new InvalidInputError("Unknown collection");
  return collection;
}

function docId(collection: Collection, value: unknown): string {
  return checkCollection(collection) === "products" ? productKey(value) : checkId(value, "sheet ID");
}

function itemKey(collection: Collection, teamId: string, docId: string) {
  return collection === "products" ? keys.product(teamId, docId) : keys.sheet(teamId, docId);
}

/** Throws unless `value` is JSON that DynamoDB can store as it is. */
function checkValue(value: unknown, depth: number): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    // DynamoDB numbers: zero, or a magnitude from 1e-130 to just under 1e126
    const abs = Math.abs(value);
    if (!Number.isFinite(value) || (abs !== 0 && (abs < 1e-130 || abs >= 1e126))) throw new InvalidInputError("Number out of range");
    return;
  }
  if (depth >= MAX_DEPTH) throw new InvalidInputError("Document is nested too deeply");
  if (Array.isArray(value)) {
    for (const v of value) checkValue(v, depth + 1);
    return;
  }
  if (isMap(value) && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      if (k === "" || k === "__proto__") throw new InvalidInputError("Invalid field name");
      checkValue(v, depth + 1);
    }
    return;
  }
  throw new InvalidInputError("Documents hold JSON values only");
}

/** Validates a whole document: JSON, no server-owned fields, within the size limit. */
function checkDocument(collection: Collection, data: unknown): DocumentData {
  if (!isMap(data)) throw new InvalidInputError("A document is a JSON object");
  checkValue(data, 0);
  for (const field of Object.keys(data)) {
    if (RESERVED.has(field)) throw new InvalidInputError(`"${field}" is set by the server`);
  }
  // `stock` changes with an atomic ADD elsewhere (adjustStock), so it has to be a number
  if (collection === "products") {
    if ("stock" in data && typeof data.stock !== "number") throw new InvalidInputError("Invalid stock");
    if ("code" in data) barcode(data.code);
  }
  if (collection === "sheets") {
    if ("date" in data && typeof data.date !== "string") throw new InvalidInputError("Invalid date");
    if ("items" in data && !isMap(data.items)) throw new InvalidInputError("Invalid items");
    // Each line keeps its barcode (`code`), which the typed functions bound the same way
    for (const line of Object.values((data.items ?? {}) as Record<string, unknown>)) if (isMap(line) && "code" in line) barcode(line.code);
  }
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_DOCUMENT_BYTES) {
    throw new TooLargeError(`Documents are limited to ${MAX_DOCUMENT_BYTES} bytes`);
  }
  return data;
}

/** The app's update: nested maps merge key by key; anything else replaces. */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    // Own fields only: a key like "constructor" mustn't find the object's prototype
    const current = Object.hasOwn(target, k) ? target[k] : undefined;
    target[k] = isMap(v) && isMap(current) ? deepMerge(current, v) : structuredClone(v);
  }
  return target;
}

function toItem(collection: Collection, teamId: string, docId: string, data: DocumentData, version: number): Record<string, unknown> {
  if (collection === "products") return { ...data, ...keys.product(teamId, docId), type: "product", key: docId, version };
  // Date order comes from GSI1. A sheet without a valid date sorts before
  // every dated one (after them, newest first) rather than dropping out.
  const date = typeof data.date === "string" && DATE.test(data.date) ? data.date : "";
  return {
    ...data,
    ...keys.sheet(teamId, docId),
    GSI1PK: `${teamPartition(teamId)}#SHEETS`,
    GSI1SK: `${date}#${docId}`,
    type: "sheet",
    id: docId,
    version,
  };
}

function fromItem(collection: Collection, item: Record<string, unknown>): StoredDocument {
  const data: DocumentData = {};
  for (const [k, v] of Object.entries(item)) if (!RESERVED.has(k)) data[k] = v;
  const id = String(collection === "products" ? item.key : item.id);
  return { id, version: typeof item.version === "number" ? item.version : 1, data };
}

async function readItem(db: Db, collection: Collection, teamId: string, docId: string) {
  const { Item } = await connection(db).doc.send(
    new GetCommand({ TableName: db.tableName, Key: itemKey(collection, teamId, docId), ConsistentRead: true }),
  );
  return Item;
}

function expectedVersion(options: WriteOptions): number | undefined {
  const v = options.expectedVersion;
  if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new InvalidInputError("Invalid version");
  return v;
}

const isRace = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";
const isTooLarge = (error: unknown) =>
  (error as { name?: string } | null)?.name === "ValidationException" && /size/i.test((error as Error).message);

/**
 * Reads the current item, lets `build` make the next document from it, and
 * puts it if the item hasn't changed since the read. Retries a lost race.
 */
async function write(
  db: Db,
  ctx: TeamContext,
  collection: Collection,
  rawId: unknown,
  options: WriteOptions,
  build: (current: StoredDocument | undefined) => DocumentData,
): Promise<WriteResult> {
  writable(db, ctx);
  const id = docId(collection, rawId);
  const expected = expectedVersion(options);
  for (let attempt = 1; ; attempt++) {
    const item = await readItem(db, collection, ctx.teamId, id);
    const before = item ? fromItem(collection, item) : undefined;
    if (expected !== undefined && (before?.version ?? 0) !== expected) throw new ConflictError("This document changed; reload and try again");
    const data = checkDocument(collection, build(before));
    const version = (before?.version ?? 0) + 1;
    // Unchanged since the read: same version and, for products, same stock
    // (every stock change gives a new version now; checking stock as well
    // covers items stored before it did)
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const unchanged = (field: string) => {
      names[`#${field}`] = field;
      if (item?.[field] === undefined) return `attribute_not_exists(#${field})`;
      values[`:${field}`] = item[field];
      return `#${field} = :${field}`;
    };
    const condition = !item
      ? "attribute_not_exists(PK)"
      : [unchanged("version"), ...(collection === "products" ? [unchanged("stock")] : [])].join(" AND ");
    try {
      await connection(db).doc.send(
        new PutCommand({
          TableName: db.tableName,
          Item: storable(toItem(collection, ctx.teamId, id, data, version)),
          ConditionExpression: condition,
          ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
          ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
        }),
      );
      return { before, after: { id, version, data } };
    } catch (error) {
      if (isTooLarge(error)) throw new TooLargeError("This document is too large to save");
      if (!isRace(error)) throw error;
      if (expected !== undefined || attempt >= MAX_ATTEMPTS) throw new ConflictError("This document changed; reload and try again");
    }
  }
}

/** One document, strongly consistent, or undefined if it doesn't exist. */
export async function getDocument(db: Db, ctx: TeamContext, collection: Collection, rawId: unknown): Promise<StoredDocument | undefined> {
  readable(ctx);
  const item = await readItem(db, collection, ctx.teamId, docId(collection, rawId));
  return item ? fromItem(collection, item) : undefined;
}

/**
 * False for a cursor from another collection's listing. (queryPage checks the
 * partition, so a cursor can't reach another team; this keeps one listing's
 * cursor out of another's key range.) A malformed cursor passes here and is
 * rejected by queryPage.
 */
function cursorInCollection(cursor: string, prefix: string): boolean {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { SK?: unknown } | null;
    return typeof key?.SK !== "string" || key.SK.startsWith(prefix);
  } catch {
    return true;
  }
}

/**
 * A page of a collection. By default in ID order and strongly consistent;
 * sheets can instead come in date order from GSI1 (eventually consistent).
 */
export async function listDocuments(db: Db, ctx: TeamContext, collection: Collection, options: ListOptions = {}): Promise<Page<StoredDocument>> {
  readable(ctx);
  checkCollection(collection);
  const { limit, cursor } = options;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new InvalidInputError("Invalid limit");
  const prefix = collection === "products" ? prefixes.product : prefixes.sheet;
  if (cursor !== undefined && !cursorInCollection(cursor, prefix)) throw new InvalidInputError("Invalid cursor");
  let page: Page<Record<string, unknown>>;
  try {
    if (options.orderBy !== undefined) {
      if (options.orderBy !== "date" || collection !== "sheets") throw new InvalidInputError("Only sheets can be ordered, and only by date");
      const pk = `${teamPartition(ctx.teamId)}#SHEETS`;
      page = await queryPage(
        db,
        {
          IndexName: GSI1,
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          ScanIndexForward: !options.descending,
          Limit: limit,
        },
        { attribute: GSI1PK, value: pk },
        cursor,
      );
    } else {
      const pk = teamPartition(ctx.teamId);
      page = await queryPage(
        db,
        {
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ConsistentRead: true,
          Limit: limit,
        },
        { attribute: PK, value: pk },
        cursor,
      );
    }
  } catch (error) {
    // A cursor from another collection or order is outside this query's range
    if (cursor !== undefined && (error as { name?: string } | null)?.name === "ValidationException") throw new InvalidInputError("Invalid cursor");
    throw error;
  }
  return { items: page.items.map((item) => fromItem(collection, item)), cursor: page.cursor };
}

/**
 * A product's `stock` moves only through the stock commands (commands.ts)
 * and the CSV import (imports.ts), which record a movement for every change.
 * A document write keeps the stored stock: `written` (the body) may leave it
 * out, or repeat the stored value, and anything else is refused. A new
 * product has no stock, so creating one with `stock` is refused too: it
 * starts counting with a `count` adjustment, which records the movement.
 */
function keepStock(collection: Collection, current: StoredDocument | undefined, written: DocumentData, next: DocumentData): DocumentData {
  if (collection !== "products") return next;
  const stored = current?.data.stock;
  if (Object.hasOwn(written, "stock") && written.stock !== stored) {
    throw new InvalidInputError("Stock changes only through the stock command (POST /teams/{teamId}/products/{key}/stock)");
  }
  if (stored !== undefined) next.stock = stored;
  return next;
}

/** Replaces a document, creating it if needed (the app's `set`). A product keeps its stock (keepStock). */
export function setDocument(db: Db, ctx: TeamContext, collection: Collection, rawId: unknown, data: unknown, options: WriteOptions = {}): Promise<WriteResult> {
  // Validate before cloning: structuredClone of a very deep value overflows the stack
  if (!isMap(data)) throw new InvalidInputError("A document is a JSON object");
  checkValue(data, 0);
  return write(db, ctx, collection, rawId, options, (current) => keepStock(collection, current, data, structuredClone(data) as DocumentData));
}

/**
 * Deep-merges `patch` into an existing document (the app's `update`): a
 * nested object merges into an existing nested object key by key, and any
 * other value replaces what was there. Throws NotFoundError if the document
 * doesn't exist. A product keeps its stock (keepStock).
 */
export function updateDocument(db: Db, ctx: TeamContext, collection: Collection, rawId: unknown, patch: unknown, options: WriteOptions = {}): Promise<WriteResult> {
  if (!isMap(patch)) throw new InvalidInputError("An update is a JSON object");
  checkValue(patch, 0);
  return write(db, ctx, collection, rawId, options, (current) => {
    if (!current) throw new NotFoundError("No such document");
    return keepStock(collection, current, patch, deepMerge(structuredClone(current.data), patch));
  });
}

/**
 * Deletes a document. Deleting one that doesn't exist succeeds, unless an
 * expected version is given.
 */
export async function deleteDocument(db: Db, ctx: TeamContext, collection: Collection, rawId: unknown, options: WriteOptions = {}): Promise<{ before?: StoredDocument }> {
  writable(db, ctx);
  const id = docId(collection, rawId);
  const expected = expectedVersion(options);
  const conditional = expected !== undefined;
  try {
    const { Attributes } = await connection(db).doc.send(
      new DeleteCommand({
        TableName: db.tableName,
        Key: itemKey(collection, ctx.teamId, id),
        ReturnValues: "ALL_OLD",
        ...(conditional
          ? expected === 0
            ? { ConditionExpression: "attribute_not_exists(PK)" }
            : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expected } }
          : {}),
      }),
    );
    return { before: Attributes ? fromItem(collection, Attributes) : undefined };
  } catch (error) {
    if (isRace(error)) throw new ConflictError("This document changed; reload and try again");
    throw error;
  }
}
