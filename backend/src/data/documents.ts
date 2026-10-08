// The app's document model (ADR 0004, 0006): `products/<key>` and
// `projects/<id>` (formerly `sheets/<id>`, a name still accepted through the
// rename's window, supply-checkout-005.6) as free-form JSON documents with get, set (replace), update
// (deep merge), delete and list, the operations the app calls through
// `window.claude.use("db")`. The HTTP data API (src/api) serves these, and the
// browser adapter maps the app's calls onto it.
//
// Documents are stored as the same items the typed functions in products.ts
// and projects.ts use (ADR 0005): the document's fields at the top level, plus
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

import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection, storable } from "./client.js";
import { adhocCount, adhocOpen, adhocPut, readAdhoc } from "./adhoc.js";
import { brandOf } from "./brand.js";
import { hiddenCharacterProblem, withoutHiddenCharacters } from "../text/hidden-characters.js";
import { AdhocOpenError, ConflictError, EquipmentOutError, InvalidInputError, NotFoundError, TooLargeError, isCancelledAsTooLarge, isItemTooLarge } from "./errors.js";
import { BOUGHT_SUFFIX, adhocNumber, barcode, dateFormat, id as checkId, isAdhocId, keys, prefixes, productKey, teamPartition } from "./keys.js";
import { legacy } from "./legacy-sheets.js";
import { money, storedMoney } from "./money.js";
import type { Movement } from "./commands.js";
import { type ProjectFilter, type ProjectLayout, layoutOf, projectAttributes, projectItemsByDatePage, projectItemsPage, projectKeyFor, readProjectItem } from "./project-items.js";
import { type Page, queryPage } from "./query.js";
import { checkReorderFields } from "./reorder.js";
import { PK } from "./schema.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export type Collection = "products" | "projects";
/**
 * A collection as a caller may name it: `sheets` is the old name of
 * `projects`, accepted (and treated as `projects`) through the rename's window
 * (supply-checkout-005.6).
 */
export type CollectionName = Collection | typeof legacy.sheetsCollection;
export const COLLECTIONS: readonly CollectionName[] = ["products", "projects", legacy.sheetsCollection];

export type DocumentData = Record<string, unknown>;

export interface StoredDocument {
  /** The product key or project ID: the last segment of the document's path. */
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
  /** The write's time, for what the server stamps on it (a typed price's `priceSetAt`). Default: now. */
  readonly now?: Date;
}

export interface ListOptions {
  /** Projects only: date order through GSI1, which is eventually consistent. */
  readonly orderBy?: "date";
  /** With orderBy: newest first. */
  readonly descending?: boolean;
  /** At most this many documents (1–1000). A page also stops at 1 MB. */
  readonly limit?: number;
  readonly cursor?: string;
  /**
   * Projects only, in ID order, without a limit: only the projects the app
   * loads at start (supply-checkout-1dg.11), those that are open, dated or
   * finished on or after this day (YYYY-MM-DD), or have no date. See
   * recentFilter.
   */
  readonly since?: string;
}

/**
 * The projects a list `since` a day keeps: open ones (any status but
 * `closed`, or none), and finished ones dated on or after the day, finished
 * (`closedAt`, an ISO time) on or after it, or with no date to go by (none,
 * or one that sorts before "0", such as ""). What it leaves out are the
 * finished projects from before the day, which the app fetches when someone
 * asks for them.
 */
export function recentFilter(since: string): ProjectFilter {
  return {
    expression: "attribute_not_exists(#status) OR #status <> :closed OR attribute_not_exists(#date) OR #date < :zero OR #date >= :since OR #closedAt >= :since",
    names: { "#status": "status", "#date": "date", "#closedAt": "closedAt" },
    values: { ":closed": "closed", ":zero": "0", ":since": dateFormat(since) },
  };
}

/**
 * Fields the server owns: key and index attributes, the item type, the
 * document's ID and version, and the team (which comes from the path, never
 * the body). A document can't contain them.
 */
export const RESERVED_FIELDS: readonly string[] = ["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK", "GSI3PK", "GSI3SK", "type", "id", "key", "version", "teamId"];
const RESERVED = new Set(RESERVED_FIELDS);
/** Every index key, including indexes not added yet: a document must never put itself in an index (ADR 0015's GSI3 is the operators'). */
const INDEX_KEY = /^GSI\d+(PK|SK)$/;

/** True for a field only the server may set: RESERVED_FIELDS, and any GSI<n>PK or GSI<n>SK. */
export function isReservedField(field: string): boolean {
  return RESERVED.has(field) || INDEX_KEY.test(field);
}

/**
 * The largest document, as UTF-8 JSON. DynamoDB's item limit is 400 KB,
 * counting attribute names; this leaves room for them and the server's fields.
 */
export const MAX_DOCUMENT_BYTES = 350_000;

/** DynamoDB allows 32 levels of nesting; the app uses 3 (a project's items map). */
const MAX_DEPTH = 16;
const MAX_ATTEMPTS = 5;

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The collection a name means: `sheets` is `projects`. Throws for any other name. */
export function canonicalCollection(name: CollectionName): Collection {
  if (!COLLECTIONS.includes(name)) throw new InvalidInputError("Unknown collection");
  return name === legacy.sheetsCollection ? "projects" : name;
}

function docId(collection: Collection, value: unknown): string {
  return collection === "products" ? productKey(value) : checkId(value, "project ID");
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

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * A product's or project line's price or cost as the write leaves it. A value
 * the write changes (or a new product's or line's) must follow the money
 * rule. One `stored` already had is legacy money the write doesn't touch
 * (ADR 0014: the server accepts it on read and rejects only what's written),
 * so it doesn't block the write: it's rounded to cents, as ADR 0014 says it
 * is "when next saved", or kept as it is if it isn't an amount at all.
 */
function writtenMoney(value: unknown, stored: Record<string, unknown> | undefined, field: "price" | "cost" | "lostCharge"): unknown {
  if (stored && Object.hasOwn(stored, field) && sameValue(stored[field], value)) return storedMoney(value) ?? value;
  return money(value, field);
}

/**
 * Validates a whole document: JSON, no server-owned fields, within the size
 * limit. `before` is the stored document, if any, for the legacy values a
 * write may carry over unchanged.
 */
/** Who is writing, and when: the server stamps them on what it owns (a typed price, ADR 0017). */
interface Actor {
  readonly userId: string;
  readonly at: string;
}

function checkDocument(collection: Collection, data: unknown, actor: Actor, before?: StoredDocument): DocumentData {
  return checkKinds(collection, checkFields(collection, data, before), actor, before);
}

function checkFields(collection: Collection, data: unknown, before?: StoredDocument): DocumentData {
  if (!isMap(data)) throw new InvalidInputError("A document is a JSON object");
  checkValue(data, 0);
  for (const field of Object.keys(data)) {
    if (isReservedField(field)) throw new InvalidInputError(`"${field}" is set by the server`);
  }
  // Within the size limit before any field is read, so no check below scans more than that
  checkSize(data);
  // `stock` changes with an atomic ADD elsewhere (adjustStock), so it has to be a number
  if (collection === "products") {
    if ("stock" in data && typeof data.stock !== "number") throw new InvalidInputError("Invalid stock");
    if ("code" in data) barcode(data.code);
    // The name and brand have no control or invisible characters (src/text/hidden-characters.ts). One a
    // product was stored with before they were refused doesn't block a write that leaves it as it is.
    if (typeof data.name === "string" && data.name !== before?.data.name) visible("name", data.name);
    // An optional brand (brand.ts): stored trimmed, and blank or null removes it
    if (Object.hasOwn(data, "brand")) {
      const brand = brandOf(data.brand, before?.data.brand);
      if (brand === undefined) delete data.brand;
      else data.brand = brand;
    }
    // A product's price and cost follow the money rule like a project line's (ADR 0014)
    for (const field of ["price", "cost"] as const) if (Object.hasOwn(data, field)) data[field] = writtenMoney(data[field], before?.data, field);
    // The reorder level, usual order and the team's acknowledgment of a low-stock alert (reorder.ts)
    checkReorderFields(data, before?.data);
  }
  if (collection === "projects") {
    if ("date" in data && typeof data.date !== "string") throw new InvalidInputError("Invalid date");
    if ("items" in data && !isMap(data.items)) throw new InvalidInputError("Invalid items");
    // The client, who made the project and the receipt's store have no control or invisible
    // characters (src/text/hidden-characters.ts, supply-checkout-1dg.13), where the write changes them
    for (const field of ["client", "createdByName"] as const) {
      if (typeof data[field] === "string" && data[field] !== before?.data[field]) visible(field, data[field]);
    }
    const storedStore = isMap(before?.data.source) ? before.data.source.store : undefined;
    if (isMap(data.source) && typeof data.source.store === "string" && data.source.store !== storedStore) visible("source.store", data.source.store);
    // Each line keeps its barcode (`code`), its price each and its cost each (`price`, `cost`,
    // ADR 0014), which the typed functions bound the same way
    const storedLines = isMap(before?.data.items) ? before.data.items : {};
    // A line is an object. null removes it (the app's removeLine; a PATCH can't otherwise drop a
    // key), so it's never stored. Anything else is refused, unless the write carries a legacy
    // value over unchanged (supply-checkout-1dg.10)
    if (isMap(data.items)) data.items = Object.fromEntries(Object.entries(data.items).filter(([, line]) => line !== null));
    for (const [key, line] of Object.entries((data.items ?? {}) as Record<string, unknown>)) {
      if (!isMap(line)) {
        if (Object.hasOwn(storedLines, key) && sameValue(line, storedLines[key])) continue;
        throw new InvalidInputError("A line is a JSON object, or null to remove it");
      }
      const stored = Object.hasOwn(storedLines, key) && isMap(storedLines[key]) ? storedLines[key] : undefined;
      if ("code" in line) barcode(line.code);
      // A line's name is a copy of the item's: one the write changes loses its control and invisible
      // characters, as the commands' copies do, rather than failing the write
      if (typeof line.name === "string" && line.name !== stored?.name) line.name = withoutHiddenCharacters(line.name);
      for (const field of ["price", "cost"] as const) if (Object.hasOwn(line, field)) line[field] = writtenMoney(line[field], stored, field);
    }
  }
  checkSize(data);
  return data;
}

/** Refuses text with a control or invisible character in it, naming the field and never the text. */
function visible(field: string, value: string): void {
  const problem = hiddenCharacterProblem(field, value);
  if (problem) throw new InvalidInputError(problem);
}

function checkSize(data: DocumentData): void {
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_DOCUMENT_BYTES) {
    throw new TooLargeError(`Documents are limited to ${MAX_DOCUMENT_BYTES} bytes`);
  }
}

const PRODUCT_KINDS = new Set(["supply", "equipment"]);
const PRICE_SET = new Set(["markup", "manual"]);
/** Line fields only the server sets: who took equipment last and when (checkout), and who typed a bought line's price and when. */
const SERVER_LINE_FIELDS = ["takenBy", "takenAt", "priceSetBy", "priceSetAt"] as const;
const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const counted = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** What's still out on an equipment line (ADR 0017): neither back nor lost. */
const stillOut = (line: Record<string, unknown> | undefined) => (line ? counted(line.out) - counted(line.returned) - counted(line.lost) : 0);

/**
 * Company equipment and the lines that carry it (ADR 0017, section 7):
 *
 * - A product's `kind` is "supply" or "equipment", or missing (a supply).
 *   No new product's key ends in ":bought", which is kept for lines bought
 *   for a client.
 * - A project's `kind` is set only by the server (the General Use project's quick take,
 *   supply-checkout-mdae): a document write can't add, change or remove it.
 * - A line's `kind` is "equipment" or missing, and can't change once the line
 *   exists. `lost` (whole eaches) and `lostCharge` (money) are only on
 *   equipment lines, and a charge only on a client project. A changed line keeps
 *   `returned + lost <= out`.
 * - `takenBy` and `takenAt` (the checkout command's), and `priceSetBy` and
 *   `priceSetAt`, are the server's: a write may only repeat what's stored.
 * - A line bought for the client (`purchased: true`, keyed
 *   `<productKey>:bought`) is made only by the receipt's lines command, so a
 *   document write can't add one, or mark or unmark a line as bought. Nothing
 *   of it comes back, so its `returned` stays 0. Its `priceSet` is the
 *   server's: a changed price is "manual", stamped with who changed it and
 *   when (`priceSetBy`, `priceSetAt`), so a typed price can be traced.
 * - A project isn't closed (`status: "closed"`) while an equipment line has
 *   something still out, and no such line is removed: EquipmentOutError (409).
 * - A project's `closedAt` is the server's: stampClosedAt.
 */
function checkKinds(collection: Collection, data: DocumentData, actor: Actor, before?: StoredDocument): DocumentData {
  const stored = before?.data;
  if (collection === "products") {
    if (Object.hasOwn(data, "kind") && !PRODUCT_KINDS.has(data.kind as string)) throw new InvalidInputError('kind is "supply" or "equipment"');
    return data;
  }
  if (!sameValue(data.kind, stored?.kind)) throw new InvalidInputError("A project's kind is set by the server");
  stampClosedAt(data, stored, actor.at);
  const storedLines = isMap(stored?.items) ? stored.items : {};
  const lines = isMap(data.items) ? data.items : {};
  for (const [key, line] of Object.entries(lines)) {
    if (!isMap(line)) continue;
    const old = Object.hasOwn(storedLines, key) && isMap(storedLines[key]) ? storedLines[key] : undefined;
    const has = (field: string) => Object.hasOwn(line, field);
    if (has("kind") && line.kind !== "equipment") throw new InvalidInputError('A line\'s kind is "equipment" or left out');
    if (old && !sameValue(line.kind, old.kind)) throw new InvalidInputError("A line's kind can't change");
    const equipment = line.kind === "equipment";
    // Bought for the client: only addLines marks a line so, and the mark stays
    if (has("purchased") && line.purchased !== true) throw new InvalidInputError("purchased is true or left out");
    if (!sameValue(line.purchased, old?.purchased) || (key.endsWith(BOUGHT_SUFFIX) && line.purchased !== true)) {
      throw new InvalidInputError("Only a receipt's lines (POST .../projects/{projectId}/lines) add a line bought for the client");
    }
    if (line.purchased === true && line.kind !== undefined) throw new InvalidInputError("A line bought for the client has no kind");
    if (has("priceSet") && (line.purchased !== true || !PRICE_SET.has(line.priceSet as string))) throw new InvalidInputError("priceSet is set by the server, on lines bought for the client");
    for (const field of SERVER_LINE_FIELDS) {
      if (!sameValue(line[field], old?.[field])) throw new InvalidInputError(`${field} is set by the server`);
    }
    if (line.purchased === true) {
      if (has("returned") && line.returned !== 0) throw new InvalidInputError("Nothing bought for the client comes back, so its returned stays 0");
      // A price someone changed is a typed price, whatever the request says, and says who typed it
      // (Compared with the stored price as written and as rounded: re-saving a legacy price that
      // isn't in whole cents rounds it, ADR 0014, but nobody typed it)
      if (old && !sameValue(line.price, old.price) && !sameValue(line.price, storedMoney(old.price))) {
        Object.assign(line, { priceSet: "manual", priceSetBy: actor.userId, priceSetAt: actor.at });
      }
      else if (old?.priceSet === undefined) delete line.priceSet;
      else line.priceSet = old.priceSet;
    }
    if (has("lost") && (!equipment || !isWhole(line.lost))) throw new InvalidInputError("lost is a whole number, on company equipment lines only");
    if (has("lostCharge")) {
      if (!equipment || data.kind === "adhoc") throw new InvalidInputError("lostCharge is only on company equipment lines of a client project");
      line.lostCharge = writtenMoney(line.lostCharge, old, "lostCharge");
    }
    // Counts the write changes: what came back and what was lost can't be more than went out
    if (!sameValue(line, old) && typeof line.out === "number" && counted(line.returned) + counted(line.lost) > line.out) {
      throw new InvalidInputError("A line's returned and lost can't add up to more than its out");
    }
  }
  // Removing an equipment line (left out of a PUT, or null in a PATCH) with something still out is
  // refused as closing the project is: it would lose track of what's out (supply-checkout-1dg.10)
  for (const [key, old] of Object.entries(storedLines)) {
    if (isMap(old) && old.kind === "equipment" && stillOut(old) > 0 && !Object.hasOwn(lines, key)) {
      throw new EquipmentOutError("Equipment is still out on this line: return it or mark it lost before removing it");
    }
  }
  if (data.status === "closed") {
    // Closing, or changing a closed project so that more is out: every piece of equipment must be accounted for first
    const wasClosed = stored?.status === "closed";
    for (const [key, line] of Object.entries(lines)) {
      if (!isMap(line) || line.kind !== "equipment" || stillOut(line) <= 0) continue;
      const old = Object.hasOwn(storedLines, key) && isMap(storedLines[key]) ? storedLines[key] : undefined;
      if (!wasClosed || stillOut(line) > stillOut(old)) throw new EquipmentOutError("Equipment is still out on this project");
    }
  }
  return data;
}

/**
 * A project's `closedAt` is the server's (supply-checkout-1dg.16): the list
 * `since` a day keeps a finished project by it (recentFilter), so it can't
 * come from a device's clock. A write that finishes the project (or makes a
 * finished one) stamps it with the write's time; any other write keeps what's
 * stored, or none, so a reopened project keeps the time it was last finished.
 * A `closedAt` in the request, which older versions of the app send, is
 * ignored rather than refused.
 */
function stampClosedAt(data: DocumentData, stored: DocumentData | undefined, at: string): void {
  if (data.status === "closed" && stored?.status !== "closed") data.closedAt = at;
  else if (stored !== undefined && Object.hasOwn(stored, "closedAt")) data.closedAt = stored.closedAt;
  else delete data.closedAt;
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

/**
 * The item a document is stored as. A project's goes where `layout` says: the
 * key it was read from, or, for a new one, `PROJECT#` (project-items.ts).
 * Date order comes from GSI1.
 */
function toItem(collection: Collection, teamId: string, docId: string, data: DocumentData, version: number, layout: ProjectLayout = "project"): Record<string, unknown> {
  if (collection === "products") return { ...data, ...keys.product(teamId, docId), type: "product", key: docId, version };
  return { ...data, ...projectAttributes(teamId, docId, data.date, layout), id: docId, version };
}

/** A new project's item as stored, with its keys and date index: for the quick take, which makes the General Use project (commands.ts). */
export function projectItem(teamId: string, projectId: string, data: DocumentData, version: number): Record<string, unknown> {
  return toItem("projects", teamId, projectId, data, version);
}

function fromItem(collection: Collection, item: Record<string, unknown>): StoredDocument {
  const data: DocumentData = {};
  for (const [k, v] of Object.entries(item)) if (!isReservedField(k)) data[k] = v;
  const id = String(collection === "products" ? item.key : item.id);
  return { id, version: typeof item.version === "number" ? item.version : 1, data };
}

/** A document's item, keys included; a project's from either key (project-items.ts). */
async function readItem(db: Db, collection: Collection, teamId: string, docId: string) {
  if (collection === "projects") return readProjectItem(db, teamId, docId);
  const { Item } = await connection(db).doc.send(
    new GetCommand({ TableName: db.tableName, Key: keys.product(teamId, docId), ConsistentRead: true }),
  );
  return Item;
}

function expectedVersion(options: WriteOptions): number | undefined {
  const v = options.expectedVersion;
  if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new InvalidInputError("Invalid version");
  return v;
}

const isRace = (error: unknown) => (error as { name?: string } | null)?.name === "ConditionalCheckFailedException";
const RACE_CODES = new Set([undefined, "None", "ConditionalCheckFailed", "TransactionConflict"]);
/** A transaction cancelled only because an item changed, or another transaction had it. */
const isCancelledByRace = (error: unknown) =>
  (error as { name?: string } | null)?.name === "TransactionCanceledException" &&
  ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).every((r) => RACE_CODES.has(r.Code));

/** Up to this long, in milliseconds, before the next attempt after a lost race. */
const MAX_BACKOFF_MS = 200;
/**
 * The wait before attempt `attempt + 1` after a lost race: "full jitter", a
 * random time up to an exponentially growing cap, so writers that keep
 * racing for one item spread out instead of colliding again in step.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return Math.floor(random() * Math.min(MAX_BACKOFF_MS, 10 * 2 ** attempt));
}
const backoff = (attempt: number) => new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));

type TransactItem = Record<string, Record<string, unknown>>;

/**
 * The change to the team's ADHOC item (adhoc.ts) that goes with a write to an
 * General Use project, in the same transaction (ADR 0017, section 7):
 *
 * - Closing the open General Use project (Finished Return) clears the pointer, so
 *   the next quick take starts the next project.
 * - Reopening a finished one points at it, unless another General Use project is
 *   open: AdhocOpenError (409). A pointer naming a project that's gone or
 *   closed (which these transactions never leave, but a restore might) doesn't
 *   count as open.
 *
 * Any other write, or a write to a client project, leaves the item alone.
 */
async function adhocChange(db: Db, ctx: TeamContext, id: string, before: StoredDocument | undefined, data: DocumentData, at: string): Promise<TransactItem | undefined> {
  if (before?.data.kind !== "adhoc") return undefined;
  const closing = data.status === "closed";
  if ((before.data.status === "closed") === closing) return undefined;
  const pointer = await readAdhoc(db, ctx.teamId);
  const open = adhocOpen(pointer);
  if (closing) return open === id ? adhocPut(db, ctx.teamId, pointer, { open: undefined, count: adhocCount(pointer) }, at) : undefined;
  if (open !== undefined && open !== id) {
    const other = await readItem(db, "projects", ctx.teamId, open);
    if (other && other.status !== "closed") throw new AdhocOpenError("Another General Use project is open. Finish it before reopening this one.");
  }
  return adhocPut(db, ctx.teamId, pointer, { open: id, count: adhocNumber(id) ?? 0 }, at);
}

/**
 * Reads the current item, lets `build` make the next document from it, and
 * puts it if the item hasn't changed since the read. Retries a lost race.
 */
async function write(
  db: Db,
  ctx: TeamContext,
  name: CollectionName,
  rawId: unknown,
  options: WriteOptions,
  build: (current: StoredDocument | undefined) => DocumentData,
): Promise<WriteResult> {
  writable(db, ctx);
  const collection = canonicalCollection(name);
  const id = docId(collection, rawId);
  const expected = expectedVersion(options);
  for (let attempt = 1; ; attempt++) {
    const item = await readItem(db, collection, ctx.teamId, id);
    const before = item ? fromItem(collection, item) : undefined;
    // Before anything about the body: the app's whole-item PUTs (marking an item ordered, src/main.js)
    // carry the stock they saw, and a stale one must be a conflict (409), not a refused stock (400)
    if (expected !== undefined && (before?.version ?? 0) !== expected) throw new ConflictError("This document changed; reload and try again");
    // Kept for the lines of equipment bought for a client (ADR 0017), which aren't products
    if (collection === "products" && !before && id.endsWith(BOUGHT_SUFFIX)) throw new InvalidInputError(`An item's key can't end in "${BOUGHT_SUFFIX}"`);
    // Kept for the General Use projects, which only the quick take makes (ADR 0017, section 4)
    if (collection === "projects" && !before && isAdhocId(id)) throw new InvalidInputError('Project IDs starting "adhoc-" are kept for the General Use project, which Quick take makes');
    const at = (options.now ?? new Date()).toISOString();
    const data = checkDocument(collection, build(before), { userId: ctx.userId, at }, before);
    const adhoc = collection === "projects" ? await adhocChange(db, ctx, id, before, data, at) : undefined;
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
    // An item that exists must still exist: an unchanged missing version is also true of a
    // missing item, and a project's item can be moved by the rename's backfill meanwhile
    const condition = !item
      ? "attribute_not_exists(PK)"
      : ["attribute_exists(PK)", unchanged("version"), ...(collection === "products" ? [unchanged("stock")] : [])].join(" AND ");
    const put = {
      TableName: db.tableName,
      // Back where it was read from; a new project is PROJECT# (project-items.ts)
      Item: storable(toItem(collection, ctx.teamId, id, data, version, layoutOf(item))),
      ConditionExpression: condition,
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
    };
    try {
      // With the ADHOC item's change, both or neither
      if (adhoc) await connection(db).doc.send(new TransactWriteCommand({ TransactItems: [{ Put: put }, adhoc] }));
      else await connection(db).doc.send(new PutCommand(put));
      return { before, after: { id, version, data } };
    } catch (error) {
      // DynamoDB's "Item size has exceeded the maximum allowed size"; any other ValidationException is a 500
      if (isItemTooLarge(error) || isCancelledAsTooLarge(error)) throw new TooLargeError("This document is too large to save");
      if (!isRace(error) && !isCancelledByRace(error)) throw error;
      if (expected !== undefined || attempt >= MAX_ATTEMPTS) throw new ConflictError("This document changed; reload and try again");
      await backoff(attempt);
    }
  }
}

/** One document, strongly consistent, or undefined if it doesn't exist. */
export async function getDocument(db: Db, ctx: TeamContext, name: CollectionName, rawId: unknown): Promise<StoredDocument | undefined> {
  readable(ctx);
  const collection = canonicalCollection(name);
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
 * projects can instead come in date order from GSI1 (eventually consistent).
 * Projects come from both their keys through the rename's window
 * (project-items.ts).
 */
export async function listDocuments(db: Db, ctx: TeamContext, name: CollectionName, options: ListOptions = {}): Promise<Page<StoredDocument>> {
  readable(ctx);
  const collection = canonicalCollection(name);
  const { limit, cursor } = options;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) throw new InvalidInputError("Invalid limit");
  if (options.orderBy !== undefined && (options.orderBy !== "date" || collection !== "projects")) throw new InvalidInputError("Only projects can be ordered, and only by date");
  if (options.since !== undefined && (collection !== "projects" || options.orderBy !== undefined || limit !== undefined)) {
    throw new InvalidInputError("since lists projects by ID, without a limit");
  }
  const filter = options.since === undefined ? undefined : recentFilter(options.since);
  let page: Page<Record<string, unknown>>;
  try {
    if (collection === "projects") {
      page = options.orderBy === "date"
        ? await projectItemsByDatePage(db, ctx.teamId, { forward: !options.descending, limit, cursor })
        : await projectItemsPage(db, ctx.teamId, { limit, cursor, filter });
    } else {
      if (cursor !== undefined && !cursorInCollection(cursor, prefixes.product)) throw new InvalidInputError("Invalid cursor");
      const pk = teamPartition(ctx.teamId);
      page = await queryPage(
        db,
        {
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefixes.product },
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
 *
 * A stored stock that isn't a number (written before stock was checked) is
 * no count at all: the commands treat the item as not tracking stock. A
 * write drops it rather than copying it into a document checkDocument would
 * refuse, so the item can still be edited, and stays untracked.
 */
function keepStock(collection: Collection, current: StoredDocument | undefined, written: DocumentData, next: DocumentData): DocumentData {
  if (collection !== "products") return next;
  const stored = current?.data.stock;
  if (Object.hasOwn(written, "stock") && !sameValue(written.stock, stored)) {
    throw new InvalidInputError("Stock changes only through the stock command (POST /teams/{teamId}/products/{key}/stock)");
  }
  if (typeof stored === "number") next.stock = stored;
  else delete next.stock;
  return next;
}

/** Replaces a document, creating it if needed (the app's `set`). A product keeps its stock (keepStock). */
export function setDocument(db: Db, ctx: TeamContext, name: CollectionName, rawId: unknown, data: unknown, options: WriteOptions = {}): Promise<WriteResult> {
  // Validate before cloning: structuredClone of a very deep value overflows the stack
  if (!isMap(data)) throw new InvalidInputError("A document is a JSON object");
  checkValue(data, 0);
  const collection = canonicalCollection(name);
  return write(db, ctx, collection, rawId, options, (current) => keepStock(collection, current, data, structuredClone(data) as DocumentData));
}

/**
 * Deep-merges `patch` into an existing document (the app's `update`): a
 * nested object merges into an existing nested object key by key, and any
 * other value replaces what was there. Throws NotFoundError if the document
 * doesn't exist. A product keeps its stock (keepStock).
 */
export function updateDocument(db: Db, ctx: TeamContext, name: CollectionName, rawId: unknown, patch: unknown, options: WriteOptions = {}): Promise<WriteResult> {
  if (!isMap(patch)) throw new InvalidInputError("An update is a JSON object");
  checkValue(patch, 0);
  const collection = canonicalCollection(name);
  return write(db, ctx, collection, rawId, options, (current) => {
    if (!current) throw new NotFoundError("No such document");
    return keepStock(collection, current, patch, deepMerge(structuredClone(current.data), patch));
  });
}

/**
 * Deletes a document. Deleting one that doesn't exist succeeds, unless an
 * expected version is given. Deleting a product that tracks stock also
 * records a `delete` movement taking its stock to 0, in the same
 * transaction, so its stock history still adds up if the key is used again
 * (a product made again under it starts untracked, and a later count starts
 * from 0).
 */
export async function deleteDocument(db: Db, ctx: TeamContext, name: CollectionName, rawId: unknown, options: WriteOptions = {}): Promise<{ before?: StoredDocument }> {
  writable(db, ctx);
  const collection = canonicalCollection(name);
  const id = docId(collection, rawId);
  const expected = expectedVersion(options);
  if (collection === "products") return deleteProductDocument(db, ctx, id, expected);
  if (isAdhocId(id)) return deleteAdhocProject(db, ctx, id, expected);
  if (expected === undefined) {
    // Last writer wins: gone from both keys, wherever it was (project-items.ts)
    const item = await readProjectItem(db, ctx.teamId, id);
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: db.tableName, Key: keys.project(ctx.teamId, id) } },
          { Delete: { TableName: db.tableName, Key: legacy.sheetKey(ctx.teamId, id) } },
        ],
      }),
    );
    return { before: item ? fromItem(collection, item) : undefined };
  }
  // The key it's under now; a move by the rename's backfill since makes the condition fail (409)
  const key = projectKeyFor(ctx.teamId, id, await readProjectItem(db, ctx.teamId, id));
  try {
    const { Attributes } = await connection(db).doc.send(
      new DeleteCommand({
        TableName: db.tableName,
        Key: key,
        ReturnValues: "ALL_OLD",
        ...(expected === 0
          ? { ConditionExpression: "attribute_not_exists(PK)" }
          : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expected } }),
      }),
    );
    return { before: Attributes ? fromItem(collection, Attributes) : undefined };
  } catch (error) {
    if (isRace(error)) throw new ConflictError("This document changed; reload and try again");
    throw error;
  }
}

/**
 * A General Use project's delete (ADR 0017, section 4): reads it, then deletes it on
 * the condition that its version hasn't changed since, and, when it's the
 * open one, clears the team's ADHOC pointer in the same transaction, so the
 * next quick take starts a new project. Stock doesn't change, as for any project.
 * A lost race is retried on the fresh item unless a version was expected.
 */
async function deleteAdhocProject(db: Db, ctx: TeamContext, id: string, expected: number | undefined): Promise<{ before?: StoredDocument }> {
  for (let attempt = 1; ; attempt++) {
    const item = await readItem(db, "projects", ctx.teamId, id);
    const before = item ? fromItem("projects", item) : undefined;
    if (expected !== undefined && (before?.version ?? 0) !== expected) throw new ConflictError("This document changed; reload and try again");
    if (!item) return {};
    const pointer = item.kind === "adhoc" ? await readAdhoc(db, ctx.teamId) : undefined;
    const version = item.version;
    const del = {
      Delete: {
        TableName: db.tableName,
        Key: projectKeyFor(ctx.teamId, id, item),
        ...(typeof version === "number"
          ? { ConditionExpression: "#version = :version", ExpressionAttributeValues: { ":version": version } }
          : { ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(#version)" }),
        ExpressionAttributeNames: { "#version": "version" },
      },
    };
    const clear = adhocOpen(pointer) === id ? [adhocPut(db, ctx.teamId, pointer, { open: undefined, count: adhocCount(pointer) }, new Date().toISOString())] : [];
    try {
      await connection(db).doc.send(new TransactWriteCommand({ TransactItems: [del, ...clear] }));
      return { before };
    } catch (error) {
      if (!isCancelledByRace(error)) throw error;
      if (expected !== undefined || attempt >= MAX_ATTEMPTS) throw new ConflictError("This document changed; reload and try again");
      await backoff(attempt);
    }
  }
}

/**
 * A product's delete: reads it, then deletes it on the condition that its
 * version and stock haven't changed since, with the movement when it tracks
 * stock. A lost race is retried on the fresh item unless a version was expected.
 */
async function deleteProductDocument(db: Db, ctx: TeamContext, id: string, expected: number | undefined): Promise<{ before?: StoredDocument }> {
  const key = keys.product(ctx.teamId, id);
  for (let attempt = 1; ; attempt++) {
    const item = await readItem(db, "products", ctx.teamId, id);
    const before = item ? fromItem("products", item) : undefined;
    if (expected !== undefined && (before?.version ?? 0) !== expected) throw new ConflictError("This document changed; reload and try again");
    if (!item) return {};
    const names: Record<string, string> = { "#version": "version", "#stock": "stock" };
    const values: Record<string, unknown> = {};
    const unchanged = (field: string) => {
      if (item[field] === undefined) return `attribute_not_exists(#${field})`;
      values[`:${field}`] = item[field];
      return `#${field} = :${field}`;
    };
    const condition = `${unchanged("version")} AND ${unchanged("stock")}`;
    const stock = item.stock;
    const at = new Date().toISOString();
    const operationId = randomUUID();
    const movement: Omit<Movement, "type"> = { productKey: id, reason: "delete", delta: typeof stock === "number" ? -stock : 0, tracked: true, count: 0, operationId, userId: ctx.userId, at };
    try {
      await connection(db).doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: db.tableName,
                Key: key,
                ConditionExpression: condition,
                ExpressionAttributeNames: names,
                ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
              },
            },
            ...(typeof stock === "number"
              ? [{ Put: { TableName: db.tableName, Item: { ...keys.movement(ctx.teamId, id, at, operationId), type: "movement", ...movement }, ConditionExpression: "attribute_not_exists(PK)" } }]
              : []),
          ],
        }),
      );
      return { before };
    } catch (error) {
      // Cancelled because the product changed (or another transaction had it): read it again
      if (!isCancelledByRace(error)) throw error;
      if (expected !== undefined || attempt >= MAX_ATTEMPTS) throw new ConflictError("This document changed; reload and try again");
      await backoff(attempt);
    }
  }
}
