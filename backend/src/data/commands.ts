// Checkout, return and stock-adjust commands (supply-checkout-1dg.1): each is
// one DynamoDB transaction, and each is idempotent by a client-generated
// operation ID. docs/architecture/README.md (section 4) has the sequence and
// docs/api/commands.md the client contract.
//
// One TransactWriteItems per command, all in the team's partition (so the
// data-access role's LeadingKeys condition still holds):
//
// 1. Put the operation record `OP#<operationId>`, only if it doesn't exist.
//    It keeps the command's result, so a retry with the same ID gets the
//    first result back and changes nothing. It expires after
//    OPERATION_TTL_DAYS.
// 2. The project line (checkout and return): add to `out` or `returned` on the
//    server (`SET x = x + :qty`, since DynamoDB's ADD works only on top-level
//    attributes and a line is nested in the project's `items` map) and ADD 1 to
//    the project's `version`, only while the project is open, and for a return
//    only while returned stays at or below out. A new line snapshots `code`,
//    `name`, `price` and `cost` from the product (ADR 0014).
// 3. The product: ADD to `stock` and 1 to `version` when the product tracks
//    stock (has a numeric `stock`), otherwise a condition check that it still
//    doesn't. The new version makes a document write made against the old one
//    (an edit screen's PATCH with `stock`) fail with a conflict instead of
//    overwriting the command's change. Checking
//    out a new line also checks the product's version, so the snapshot is the
//    product as it is when the transaction commits.
//    (A receipt's lines for a client, addLines, change only the project: those
//    items were never in storage.)
// 4. Put a movement record `MOVE#<escaped key>#<at>#<operationId>`: the
//    product's stock history, which the nightly drift check reconciles against
//    `stock`.
//
// The line and stock move by server-side addition, never by writing a value
// computed from a read, so two checkouts on one line never lose a count. The conditions come from a strongly consistent read just before the
// transaction; if another write gets in between, the transaction is cancelled
// as a whole, and the command reads again and retries, up to MAX_ATTEMPTS.

import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection, storable } from "./client.js";
import { adhocCount, adhocOpen, adhocPut, readAdhoc } from "./adhoc.js";
import { MAX_DOCUMENT_BYTES, projectItem } from "./documents.js";
import { ConflictError, InvalidInputError, NotFoundError, StockChangedError, TooLargeError, isCancelledAsTooLarge } from "./errors.js";
import { BOUGHT_SUFFIX, adhocProjectId, barcode, date as checkDate, id as checkId, keys, movementPrefix, productKey, strip, teamPartition } from "./keys.js";
import { count as checkCount, MAX_MONEY, MAX_QUANTITY, money, quantity as checkQuantity, roundCents, storedMoney } from "./money.js";
import { type Page, queryPage } from "./query.js";
import { legacy } from "./legacy-sheets.js";
import { projectKeyFor, readProjectItem } from "./project-items.js";
import { ackEnds, ackOnRaise, ackRemoval } from "./reorder.js";
import { PK } from "./schema.js";
import { storedMarkup } from "./settings.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export type CommandName = "checkout" | "quickTake" | "return" | "lost" | "move" | "stockAdjust" | "addLines";

/**
 * Why a product's stock moved. `import` is a CSV inventory import setting
 * stock (imports.ts); `delete` is the product's document being deleted,
 * taking its stock to 0 (documents.ts); `uncount` is someone no longer
 * counting the item, which removes its stock, recorded as taking it to 0.
 * `lost` is company equipment lost or broken on a job (ADR 0017): it left the
 * business, but stock already went down when it was checked out, so its
 * delta is always 0. `move` is a whole line moved from the General Use project to a
 * client project (ADR 0017, section 5): the items left storage once, at the quick
 * take, so its delta is always 0 too.
 */
export type MovementReason = "checkout" | "return" | "receipt" | "count" | "uncount" | "import" | "delete" | "lost" | "move";


/** How long a retry with the same operation ID returns the first result. */
export const OPERATION_TTL_DAYS = 7;

/** Reads and transaction attempts before a busy line or product gives up with ConflictError. */
export const MAX_ATTEMPTS = 6;

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NAME = 200;

/**
 * The price and names a new line copies from the product (ADR 0014), and its
 * kind (ADR 0017): company equipment has no client price, so its line has no
 * `price`, and `kind: "equipment"`. A supply's line has no `kind`.
 */
export interface LineSnapshot {
  readonly code: string;
  readonly name: string;
  readonly price?: number;
  readonly cost?: number;
  readonly kind?: "equipment";
}

/**
 * What a command did. The operation record keeps it, and a retry with the
 * same operation ID returns it unchanged.
 */
export interface CommandResult {
  readonly operationId: string;
  readonly command: CommandName;
  readonly reason: MovementReason;
  readonly productKey: string;
  /** The project it acted on: for a quick take, the General Use project it went on; for a move, the General Use project it came off. */
  readonly projectId?: string;
  /** Eaches checked out, returned or received; for a move, the line's `out`. Absent for a count or uncount. */
  readonly quantity?: number;
  /** For a count: the stock level counted. */
  readonly count?: number;
  /** The change to the product's `stock`: 0 when the product doesn't track stock (or isn't in inventory). */
  readonly stockDelta: number;
  /** Checkout: true when this checkout added the line to the project. For a move: when it added the line to the client project. */
  readonly lineCreated?: boolean;
  /** Quick take: true when this take started the General Use project. */
  readonly projectCreated?: boolean;
  /** Move: the client project the line went to. */
  readonly toProjectId?: string;
  /** Move: the line's `returned` and `lost` that moved with it. */
  readonly returned?: number;
  readonly lost?: number;
  /**
   * The old names of `projectId`, `toProjectId` and `projectCreated`, with the
   * same values: a command's response carries both spellings through the
   * rename's window (supply-checkout-005.6), and withProjectNames adds them.
   * An operation record stored before the rename has only these.
   */
  readonly sheetId?: string;
  readonly toSheetId?: string;
  readonly sheetCreated?: boolean;
  /** Checkout of a new line: what the line copied. */
  readonly snapshot?: LineSnapshot;
  /** Receipt: what was paid per each. */
  readonly unitCost?: number;
  /** Lost: the amount charged to the client for it, if any. */
  readonly charge?: number;
  readonly userId: string;
  readonly at: string;
}

export interface CommandOutcome<R = CommandResult> {
  readonly result: R;
  /** True when this was a retry of an operation that had already run. */
  readonly replayed: boolean;
}

/** One entry in a product's stock history. */
export interface Movement {
  readonly type: "movement";
  readonly productKey: string;
  readonly reason: MovementReason;
  /** The change to `stock`. The sum of a product's deltas is its stock change. */
  readonly delta: number;
  /** Whether the product tracked stock. When false, delta is 0. */
  readonly tracked: boolean;
  readonly quantity?: number;
  readonly count?: number;
  /** The project a checkout, return or lost record was on; for a move, the client project the line went to. */
  readonly projectId?: string;
  /** Move: the General Use project the line came off. */
  readonly fromProjectId?: string;
  /**
   * The old names of `projectId` and `fromProjectId`: stored on movements
   * written before the rename (supply-checkout-005.6), until the backfill
   * renames them, and sent next to the new names (listMovements) through the
   * rename's window.
   */
  readonly sheetId?: string;
  readonly fromSheetId?: string;
  /** Move: the line's `returned` and `lost` that moved with it (`quantity` is its `out`). */
  readonly returned?: number;
  readonly lost?: number;
  readonly unitCost?: number;
  /** Lost: the amount charged to the client for it, if any. */
  readonly charge?: number;
  readonly operationId: string;
  readonly userId: string;
  readonly at: string;
}

export interface CheckoutInput {
  readonly operationId: unknown;
  /** The project: `projectId`, or its old name `sheetId` (supply-checkout-005.6). */
  readonly projectId?: unknown;
  readonly sheetId?: unknown;
  readonly productKey: unknown;
  readonly quantity: unknown;
  /** Only for an item that isn't in inventory (a one-off line). */
  readonly name?: unknown;
  readonly price?: unknown;
  readonly code?: unknown;
  readonly cost?: unknown;
}

export interface ReturnInput {
  readonly operationId: unknown;
  /** The project: `projectId`, or its old name `sheetId` (supply-checkout-005.6). */
  readonly projectId?: unknown;
  readonly sheetId?: unknown;
  readonly productKey: unknown;
  readonly quantity: unknown;
}

export interface LostInput {
  readonly operationId: unknown;
  /** The project: `projectId`, or its old name `sheetId` (supply-checkout-005.6). */
  readonly projectId?: unknown;
  readonly sheetId?: unknown;
  readonly productKey: unknown;
  readonly quantity: unknown;
  /** Dollars to charge the client for the lot, if anything (client projects only). */
  readonly charge?: unknown;
}

export interface StockAdjustInput {
  readonly operationId: unknown;
  readonly productKey: unknown;
  /**
   * `receipt`: `quantity` eaches bought at `unitCost` each. `count`: stock was counted at `count`.
   * `uncount`: the item is no longer counted (nothing else).
   */
  readonly reason: unknown;
  readonly quantity?: unknown;
  readonly unitCost?: unknown;
  readonly count?: unknown;
  /**
   * For a count or uncount: the stock the person saw when they started (an
   * edit form's count when it opened), or `null` for an item that wasn't
   * counted then. When the stock is something else now, the command is
   * refused (StockChangedError) rather than undo someone else's change, unless
   * it already is what the count sets. Absent: no check.
   */
  readonly expectedStock?: unknown;
}

type Item = Record<string, unknown>;
type TransactItem = Record<string, Record<string, unknown>>;

interface Plan<R = CommandResult> {
  readonly writes: TransactItem[];
  readonly result: R;
}

const isMap = (v: unknown): v is Item => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * One value sent under a field's new name or its old one (the
 * sheets-to-projects rename, supply-checkout-005.6): either, or both when
 * they're the same.
 */
function eitherName(current: unknown, old: unknown, what: string): unknown {
  if (current !== undefined && old !== undefined && current !== old) throw new InvalidInputError(`Send ${what} once`);
  return current ?? old;
}

/** The command's project ID: `projectId`, or its old name `sheetId`. */
function projectIdOf(input: { readonly projectId?: unknown; readonly sheetId?: unknown }): string {
  return checkId(eitherName(input.projectId, input.sheetId, "projectId (or sheetId)"), "project ID");
}

/** A move's destination: `toProjectId`, or its old name `toSheetId`. */
function toProjectIdOf(input: MoveInput): string {
  return checkId(eitherName(input.toProjectId, input.toSheetId, "toProjectId (or toSheetId)"), "toProjectId");
}

/** A client-generated operation ID: a UUID, compared in lowercase. */
export function operationId(value: unknown): string {
  const lower = typeof value === "string" ? value.toLowerCase() : "";
  if (!OPERATION_ID.test(lower)) throw new InvalidInputError("operationId must be a UUID");
  return lower;
}

function lineName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_NAME) {
    throw new InvalidInputError(`name must be 1 to ${MAX_NAME} characters`);
  }
  return value.trim();
}

/** Clauses that all hold, in any of the alternatives: `(a AND b) OR (a AND c)`, without parentheses. */
function anyOf(common: string[], alternatives: string[][]): string {
  return alternatives.map((alt) => [...common, ...alt].join(" AND ")).join(" OR ");
}

/** The project isn't closed. The app treats any status but "closed" as open. */
const PROJECT_OPEN = [["attribute_not_exists(#status)"], ["#status <> :closed"]];

function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
}

const RETRYABLE = new Set([undefined, "None", "ConditionalCheckFailed", "TransactionConflict"]);

/** True for the key of a line bought for the client (ADR 0017, section 2a), which only addLines makes. */
export function isBoughtKey(key: string): boolean {
  return key.endsWith(BOUGHT_SUFFIX);
}

/** A project's line for `key`, only if the project has one: never a built-in like `constructor` from the map's prototype. */
function lineOf(items: Item | undefined, key: string): unknown {
  return items !== undefined && Object.hasOwn(items, key) ? items[key] : undefined;
}

async function getItem(db: Db, key: Item): Promise<Item | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: key, ConsistentRead: true }));
  return Item;
}

/** A request fingerprint's fields under their old names (sheets-to-projects rename, supply-checkout-005.6). */
const LEGACY_REQUEST_FIELDS: Readonly<Record<string, string>> = legacy.requestFields;

/**
 * A command's request fingerprint in its canonical form: the old field names
 * (`sheetId`, `toSheetId`) renamed to the new ones in place, so a record made
 * before the rename matches a retry made after it, and the other way round.
 * The fingerprint is our own JSON, written with fields in a fixed order; one
 * that won't parse is compared as it is.
 */
export function canonicalRequest(request: unknown): unknown {
  if (typeof request !== "string") return request;
  let parsed: unknown;
  try {
    parsed = JSON.parse(request);
  } catch {
    return request;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return request;
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).map(([k, v]) => [Object.hasOwn(LEGACY_REQUEST_FIELDS, k) ? LEGACY_REQUEST_FIELDS[k] : k, v])));
}

/**
 * A command's result with both spellings of each renamed field (`sheetId`
 * and `projectId`, `toSheetId` and `toProjectId`, `sheetCreated` and
 * `projectCreated`), whichever one the stored result has: an old client reads
 * the old names, a new one the new names (supply-checkout-005.6).
 */
export function withProjectNames<R>(result: R): R {
  if (typeof result !== "object" || result === null) return result;
  const r = { ...(result as Record<string, unknown>) };
  for (const [old, current] of Object.entries(legacy.resultFields)) {
    if (r[old] === undefined && r[current] !== undefined) r[old] = r[current];
    if (r[current] === undefined && r[old] !== undefined) r[current] = r[old];
  }
  return r as R;
}

/** The first run's result, if this operation ID was used before. */
async function priorOutcome<R>(db: Db, ctx: TeamContext, opId: string, request: string): Promise<CommandOutcome<R> | undefined> {
  const item = await getItem(db, keys.operation(ctx.teamId, opId));
  if (!item) return undefined;
  if (canonicalRequest(item.request) !== canonicalRequest(request)) throw new InvalidInputError("This operationId was already used for a different request; use a new one");
  return { result: withProjectNames(item.result as R), replayed: true };
}

/**
 * Runs a command: replays a used operation ID, otherwise plans the
 * transaction from a fresh read and commits it with the operation record
 * first, retrying when another write got in between.
 */
async function execute<R = CommandResult>(
  db: Db,
  ctx: TeamContext,
  opId: string,
  command: CommandName,
  request: string,
  now: Date,
  plan: () => Promise<Plan<NoInfer<R>>>,
): Promise<CommandOutcome<R>> {
  const prior = await priorOutcome<R>(db, ctx, opId, request);
  if (prior) return prior;
  const epoch = Math.floor(now.getTime() / 1000);
  for (let attempt = 1; ; attempt++) {
    let planned: Plan<R>;
    try {
      planned = await plan();
    } catch (error) {
      // A retry of this operation racing its first run can find the change already made (a moved
      // line gone, say) and be refused for it: it gets the first run's result instead
      const replay = await priorOutcome<R>(db, ctx, opId, request);
      if (replay) return replay;
      throw error;
    }
    const { writes, result } = planned;
    const record = {
      ...keys.operation(ctx.teamId, opId),
      type: "operation",
      operationId: opId,
      command,
      request,
      result,
      userId: ctx.userId,
      createdAt: now.toISOString(),
      expiresAt: epoch + OPERATION_TTL_DAYS * 24 * 60 * 60,
    };
    try {
      await connection(db).doc.send(
        new TransactWriteCommand({
          TransactItems: [{ Put: { TableName: db.tableName, Item: record, ConditionExpression: "attribute_not_exists(PK)" } }, ...writes],
        }),
      );
      return { result: withProjectNames(result), replayed: false };
    } catch (error) {
      if (isCancelledAsTooLarge(error)) throw new TooLargeError("This project is too large to add to; start another project");
      const codes = cancellationCodes(error);
      // Anything but a failed condition or a race (a malformed item, say) won't get better by retrying
      if (!codes || !codes.every((c) => RETRYABLE.has(c))) throw error;
      // The same operation got in first, from a concurrent retry
      if (codes[0] === "ConditionalCheckFailed") {
        const replay = await priorOutcome<R>(db, ctx, opId, request);
        if (replay) return replay;
      }
      if (attempt >= MAX_ATTEMPTS) throw new ConflictError("Too many changes to this item at once; try again");
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 20 * attempt)));
    }
  }
}

function movementPut(db: Db, ctx: TeamContext, movement: Omit<Movement, "type">): TransactItem {
  return {
    Put: {
      TableName: db.tableName,
      Item: { ...keys.movement(ctx.teamId, movement.productKey, movement.at, movement.operationId), type: "movement", ...movement },
      // History is never overwritten
      ConditionExpression: "attribute_not_exists(PK)",
    },
  };
}

/**
 * Adds 1 to a product's version, with every change to its stock. An item with
 * no version reads as version 1 (documents.ts), so it goes to 2.
 */
const BUMP_VERSION = "#version = if_not_exists(#version, :one) + :one";

/** Refuses a product whose stored version DynamoDB couldn't add to (it would answer ValidationError, a 500). */
function checkVersion(product: Item): void {
  if (product.version !== undefined && typeof product.version !== "number") throw new InvalidInputError("This item's version isn't a number");
}

/**
 * The product's part of a checkout or return: ADD to stock (and a new version) when it tracks
 * stock, otherwise a check that it still doesn't (or still doesn't exist).
 * `extra` adds conditions for a tracked or untracked product that exists.
 */
function productWrite(
  db: Db,
  ctx: TeamContext,
  key: string,
  product: Item | undefined,
  delta: number,
  extra: { names: Record<string, string>; values: Item; clauses: string[] },
): { item: TransactItem; tracked: boolean } {
  const Key = keys.product(ctx.teamId, key);
  if (!product) {
    return { item: { ConditionCheck: { TableName: db.tableName, Key, ConditionExpression: "attribute_not_exists(PK)" } }, tracked: false };
  }
  const tracked = typeof product.stock === "number";
  const names = { "#stock": "stock", ...extra.names };
  if (tracked) {
    checkVersion(product);
    // A return that takes stock above the reorder level ends the low-stock acknowledgment (reorder.ts)
    const ack = ackOnRaise(product, delta);
    return {
      item: {
        Update: {
          TableName: db.tableName,
          Key,
          UpdateExpression: `SET ${BUMP_VERSION} ADD #stock :delta${ackRemoval(ack)}`,
          ConditionExpression: ["attribute_exists(#stock)", ...extra.clauses, ...(ack ? [ack.clause] : [])].join(" AND "),
          ExpressionAttributeNames: { ...names, "#version": "version", ...ack?.names },
          ExpressionAttributeValues: { ":delta": delta, ":one": 1, ...extra.values, ...ack?.values },
        },
      },
      tracked,
    };
  }
  return {
    item: {
      ConditionCheck: {
        TableName: db.tableName,
        Key,
        ConditionExpression: ["attribute_exists(PK)", "attribute_not_exists(#stock)", ...extra.clauses].join(" AND "),
        ExpressionAttributeNames: names,
        // DynamoDB refuses an empty values map
        ...(Object.keys(extra.values).length ? { ExpressionAttributeValues: extra.values } : {}),
      },
    },
    tracked,
  };
}

const NO_EXTRA = { names: {}, values: {}, clauses: [] };

/** A project line's counts, as stored, or InvalidInputError if they can't be added to. */
function lineCounts(line: Item): { out: number; returned: number | undefined; lost: number | undefined } {
  const { out, returned, lost } = line;
  if (!isCount(out) || (returned !== undefined && !isCount(returned)) || (lost !== undefined && !isCount(lost))) {
    throw new InvalidInputError("This line's counts aren't whole numbers; correct the line first");
  }
  return { out, returned, lost };
}

/** A line's `returned` or `lost` is what the read found: a number, or not there at all. */
function unchangedCount(field: "#returned" | "#lost", value: number | undefined, placeholder: string): string {
  return value === undefined ? `attribute_not_exists(#items.#line.${field})` : `#items.#line.${field} = ${placeholder}`;
}

/** The project, from whichever key it's under (project-items.ts), and the product. */
function readProjectAndProduct(db: Db, ctx: TeamContext, projectId: string, key: string): Promise<[Item | undefined, Item | undefined]> {
  return Promise.all([readProjectItem(db, ctx.teamId, projectId), getItem(db, keys.product(ctx.teamId, key))]);
}

function openProject(project: Item | undefined, action: string): Item {
  if (!project) throw new NotFoundError("No such project");
  if (project.status === "closed") throw new ConflictError(`This project is closed. Reopen it to ${action}.`);
  if (project.items !== undefined && !isMap(project.items)) throw new InvalidInputError("This project's items are malformed");
  return project;
}

/**
 * Checks `quantity` eaches of `productKey` out onto a project: adds them to the
 * line's `out` (creating the line if needed) and takes them off stock.
 *
 * A new line copies `code`, `name`, `price` and `cost` from the product. Only
 * for an item that isn't in inventory does it use the request's `name` and
 * `price` (both required then), and its optional `code` and `cost`. An
 * existing line's copy never changes. The project must be open.
 */
export async function checkout(db: Db, ctx: TeamContext, input: CheckoutInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const projectId = projectIdOf(input);
  const { key, qty, oneOff } = takeInput(input);
  const request = JSON.stringify({ command: "checkout", userId: ctx.userId, projectId, key, qty, ...oneOff });
  const at = now.toISOString();

  return execute(db, ctx, opId, "checkout", request, now, async () => {
    const [rawProject, product] = await readProjectAndProduct(db, ctx, projectId, key);
    const project = openProject(rawProject, "check items out");
    // The General Use project takes only quick takes (ADR 0017, section 4), and a project's kind never changes
    if (project.kind === "adhoc") throw new InvalidInputError("Take items for no job with Quick take, not onto the General Use project");
    return takePlan(db, ctx, { opId, command: "checkout", project, projectId, key, product, qty, oneOff, at, kind: "job" });
  });
}

/** The request's one-off fields: only for an item that isn't in inventory. */
interface OneOff {
  readonly name?: string;
  readonly price?: number;
  readonly code?: string;
  readonly cost?: number;
}

/** A checkout's or quick take's item, quantity and one-off fields, checked. */
function takeInput(input: Omit<CheckoutInput, "sheetId" | "projectId" | "operationId">): { key: string; qty: number; oneOff: OneOff } {
  const key = productKey(input.productKey);
  if (isBoughtKey(key)) throw new InvalidInputError("Items bought for the client aren't checked out from storage");
  const qty = checkQuantity(input.quantity);
  const oneOff = {
    name: input.name === undefined ? undefined : lineName(input.name),
    price: input.price === undefined ? undefined : money(input.price, "price"),
    code: input.code === undefined ? undefined : barcode(input.code),
    cost: input.cost === undefined ? undefined : money(input.cost, "cost"),
  };
  return { key, qty, oneOff };
}

/**
 * What a new line copies (ADR 0014, 0017): from the product, or for an item
 * that isn't in inventory, from the request's `name` and `price` (both
 * required then) and its optional `code` and `cost`.
 */
function lineSnapshot(product: Item | undefined, oneOff: OneOff): LineSnapshot {
  if (product) {
    const cost = storedMoney(product.cost);
    return {
      code: typeof product.code === "string" ? product.code : "",
      name: typeof product.name === "string" ? product.name : "",
      // Company equipment has no client price, and its line says what it is (ADR 0017)
      ...(product.kind === "equipment" ? { kind: "equipment" as const } : { price: storedMoney(product.price) ?? 0 }),
      ...(cost === undefined ? {} : { cost }),
    };
  }
  if (oneOff.name === undefined || oneOff.price === undefined) {
    throw new InvalidInputError("This item isn't in inventory; send its name and price");
  }
  return { code: oneOff.code ?? "", name: oneOff.name, price: oneOff.price, ...(oneOff.cost === undefined ? {} : { cost: oneOff.cost }) };
}

/** A new line of `qty`, with who took it and when for equipment. */
function newLine(snapshot: LineSnapshot, qty: number, userId: string, at: string): Item {
  return { ...snapshot, out: qty, returned: 0, ...(snapshot.kind === "equipment" ? { takenBy: userId, takenAt: at } : {}) };
}

/**
 * The product's part of taking a line out: stock down by `qty` when it tracks
 * stock. A new line's snapshot must be the product as the transaction finds
 * it, so for a new line it also checks the product's version. (A version that
 * isn't a number could never match, so it's refused now, not as a conflict
 * after retries.)
 */
function takeProduct(db: Db, ctx: TeamContext, key: string, product: Item | undefined, qty: number, lineIsNew: boolean): { item: TransactItem; tracked: boolean } {
  if (lineIsNew && product) checkVersion(product);
  const version = product?.version;
  const fresh = !lineIsNew
    ? NO_EXTRA
    : typeof version === "number"
      ? { names: { "#version": "version" }, values: { ":version": version }, clauses: ["#version = :version"] }
      : { names: { "#version": "version" }, values: {}, clauses: ["attribute_not_exists(#version)"] };
  return productWrite(db, ctx, key, product, -qty, fresh);
}

interface TakeOptions {
  readonly opId: string;
  readonly command: "checkout" | "quickTake";
  /** The project as read: open, with its items a map or missing. */
  readonly project: Item;
  readonly projectId: string;
  readonly key: string;
  readonly product: Item | undefined;
  readonly qty: number;
  readonly oneOff: OneOff;
  readonly at: string;
  /** The project's kind, which the transaction checks it still is: a client project's checkout, or the General Use project's quick take. */
  readonly kind: "job" | "adhoc";
}

/**
 * Takes `qty` of `key` onto an open project that exists: adds to the line's
 * `out`, or creates the line with its snapshot, takes it off stock, and
 * records a checkout movement. The project's part is conditional on it still
 * being open and of `kind`, and the line on still being there (or not).
 */
function takePlan(db: Db, ctx: TeamContext, o: TakeOptions): Plan {
  const { project, projectId, key, qty, at } = o;
  const items = project.items as Item | undefined;
  const existing = lineOf(items, key);
  if (existing !== undefined && !isMap(existing)) throw new InvalidInputError("This line is malformed; correct it first");

  const names: Record<string, string> = { "#items": "items", "#line": key, "#status": "status", "#version": "version", "#kind": "kind" };
  const values: Item = { ":one": 1, ":closed": "closed" };
  const kindClause = o.kind === "adhoc" ? "#kind = :adhoc" : "attribute_not_exists(#kind)";
  if (o.kind === "adhoc") values[":adhoc"] = "adhoc";
  let update: string;
  let clauses: string[];
  let snapshot: LineSnapshot | undefined;
  if (existing) {
    lineCounts(existing);
    names["#out"] = "out";
    values[":qty"] = qty;
    update = "SET #items.#line.#out = #items.#line.#out + :qty ADD #version :one";
    clauses = ["attribute_exists(#items.#line.#out)"];
    if (existing.kind === "equipment") {
      // Equipment names the latest person to take more (ADR 0017); the movements keep the rest
      names["#by"] = "takenBy";
      names["#at"] = "takenAt";
      values[":by"] = ctx.userId;
      values[":at"] = at;
      update = "SET #items.#line.#out = #items.#line.#out + :qty, #items.#line.#by = :by, #items.#line.#at = :at ADD #version :one";
    }
  } else {
    snapshot = lineSnapshot(o.product, o.oneOff);
    const line = newLine(snapshot, qty, ctx.userId, at);
    // Refuse early a line that would take the project past the document limit
    // (DynamoDB would refuse it past 400 KB anyway, which execute also maps to 413)
    if (Buffer.byteLength(JSON.stringify(project), "utf8") + Buffer.byteLength(JSON.stringify({ [key]: line }), "utf8") > MAX_DOCUMENT_BYTES) {
      throw new TooLargeError(`Projects are limited to ${MAX_DOCUMENT_BYTES} bytes; start another project`);
    }
    if (items) {
      values[":line"] = line;
      update = "SET #items.#line = :line ADD #version :one";
      clauses = ["attribute_exists(#items)", "attribute_not_exists(#items.#line)"];
    } else {
      // An own field even for a key like "constructor" (storable() below makes it marshal as a map)
      values[":items"] = Object.fromEntries([[key, line]]);
      // DynamoDB refuses a name the expressions don't use
      delete names["#line"];
      update = "SET #items = :items ADD #version :one";
      clauses = ["attribute_exists(PK)", "attribute_not_exists(#items)"];
    }
  }

  const { item: productItem, tracked } = takeProduct(db, ctx, key, o.product, qty, !existing);
  const stockDelta = tracked ? -qty : 0;
  const result: CommandResult = {
    operationId: o.opId,
    command: o.command,
    reason: "checkout",
    productKey: key,
    projectId,
    quantity: qty,
    stockDelta,
    lineCreated: !existing,
    ...(snapshot ? { snapshot } : {}),
    userId: ctx.userId,
    at,
  };
  return {
    result,
    writes: [
      {
        Update: {
          TableName: db.tableName,
          // Where the project was read from (project-items.ts)
          Key: projectKeyFor(ctx.teamId, projectId, project),
          UpdateExpression: update,
          ConditionExpression: anyOf([...clauses, kindClause], PROJECT_OPEN),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: storable(values),
        },
      },
      productItem,
      movementPut(db, ctx, { productKey: key, reason: "checkout", delta: stockDelta, tracked, quantity: qty, projectId, operationId: o.opId, userId: ctx.userId, at }),
    ],
  };
}

export interface QuickTakeInput {
  readonly operationId: unknown;
  readonly productKey: unknown;
  readonly quantity: unknown;
  /** Only for an item that isn't in inventory (a one-off line), as for a checkout. */
  readonly name?: unknown;
  readonly price?: unknown;
  readonly code?: unknown;
  readonly cost?: unknown;
  /** The person's local date, YYYY-MM-DD: a new General Use project's date. Default: today in UTC. */
  readonly date?: unknown;
}

/** How many taken ad hoc IDs a quick take steps past (projects the ADHOC count doesn't know of) before giving up. */
const MAX_ADHOC_SKIPS = 20;

/**
 * Quick take (ADR 0017, section 4): checks `quantity` eaches of `productKey`
 * out onto the team's open General Use project, without choosing a project.
 *
 * Reads the team's ADHOC item (adhoc.ts). When it names an open General Use project,
 * this is a checkout onto it, on the condition that ADHOC is unchanged and the
 * project is still an open General Use project. Otherwise it makes the next one,
 * `adhoc-<count + 1>` (with `kind: "adhoc"`, no client, `date`, and the line),
 * and points ADHOC at it, on the condition that ADHOC is still as read and the
 * project doesn't exist. Two first takes at once both aim at the same project: one
 * transaction makes it, the other is cancelled, reads again, finds the project
 * open and adds to it. `result.projectId` names the project, and a retry with the
 * same operation ID returns the same one. Stock and the movement are as for a
 * checkout.
 */
export async function quickTake(db: Db, ctx: TeamContext, input: QuickTakeInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const { key, qty, oneOff } = takeInput(input);
  const day = input.date === undefined ? now.toISOString().slice(0, 10) : projectDate(input.date);
  const request = JSON.stringify({ command: "quickTake", userId: ctx.userId, key, qty, ...oneOff, date: day });
  const at = now.toISOString();

  return execute(db, ctx, opId, "quickTake", request, now, async () => {
    const [pointer, product] = await Promise.all([readAdhoc(db, ctx.teamId), getItem(db, keys.product(ctx.teamId, key))]);
    const unchanged = adhocPut(db, ctx.teamId, pointer, { open: adhocOpen(pointer), count: adhocCount(pointer) }, at).Put as Item;
    const openId = adhocOpen(pointer);
    const open = openId === undefined ? undefined : await readProjectItem(db, ctx.teamId, openId);
    if (openId !== undefined && open && open.kind === "adhoc" && open.status !== "closed") {
      const plan = takePlan(db, ctx, { opId, command: "quickTake", project: openProject(open, "take"), projectId: openId, key, product, qty, oneOff, at, kind: "adhoc" });
      const [projectWrite, ...rest] = plan.writes;
      // The pointer still names this project when the take commits
      const check = {
        ConditionCheck: {
          TableName: db.tableName,
          Key: keys.adhoc(ctx.teamId),
          ConditionExpression: unchanged.ConditionExpression,
          ...(unchanged.ExpressionAttributeNames ? { ExpressionAttributeNames: unchanged.ExpressionAttributeNames } : {}),
          ...(unchanged.ExpressionAttributeValues ? { ExpressionAttributeValues: unchanged.ExpressionAttributeValues } : {}),
        },
      };
      return { result: plan.result, writes: [projectWrite as TransactItem, check, ...rest] };
    }

    // No open General Use project: the next number that's free (one made outside the count, by a restore say, is stepped past)
    let n = adhocCount(pointer) + 1;
    for (let skips = 0; await readProjectItem(db, ctx.teamId, adhocProjectId(n)); skips++) {
      if (skips >= MAX_ADHOC_SKIPS) throw new ConflictError("Couldn't start the General Use project; try again");
      n++;
    }
    const projectId = adhocProjectId(n);
    const snapshot = lineSnapshot(product, oneOff);
    const data = { kind: "adhoc", client: "", date: day, status: "open", createdBy: ctx.userId, createdAt: at, items: Object.fromEntries([[key, newLine(snapshot, qty, ctx.userId, at)]]) };
    const { item: productItem, tracked } = takeProduct(db, ctx, key, product, qty, true);
    const stockDelta = tracked ? -qty : 0;
    return {
      result: { operationId: opId, command: "quickTake", reason: "checkout", productKey: key, projectId, quantity: qty, stockDelta, lineCreated: true, projectCreated: true, snapshot, userId: ctx.userId, at },
      writes: [
        { Put: { TableName: db.tableName, Item: storable(projectItem(ctx.teamId, projectId, data, 1)), ConditionExpression: "attribute_not_exists(PK)" } },
        adhocPut(db, ctx.teamId, pointer, { open: projectId, count: n }, at),
        productItem,
        movementPut(db, ctx, { productKey: key, reason: "checkout", delta: stockDelta, tracked, quantity: qty, projectId, operationId: opId, userId: ctx.userId, at }),
      ],
    };
  });
}

/** A date sent with a quick take: YYYY-MM-DD. */
function projectDate(value: unknown): string {
  try {
    return checkDate(value);
  } catch {
    throw new InvalidInputError("date must be YYYY-MM-DD");
  }
}

/**
 * Records `quantity` eaches of a line coming back: adds them to the line's
 * `returned`, which can't go above `out`, and puts them back in stock. The
 * project must be open: a closed project takes no returns (reopen it, or correct
 * the line's counts with a document edit, which doesn't move stock).
 */
export async function returnItems(db: Db, ctx: TeamContext, input: ReturnInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const projectId = projectIdOf(input);
  const key = productKey(input.productKey);
  const qty = checkQuantity(input.quantity);
  const request = JSON.stringify({ command: "return", userId: ctx.userId, projectId, key, qty });
  const at = now.toISOString();

  return execute(db, ctx, opId, "return", request, now, async () => {
    const [rawProject, product] = await readProjectAndProduct(db, ctx, projectId, key);
    const project = openProject(rawProject, "record returns");
    const line = lineOf(project.items as Item | undefined, key);
    if (!isMap(line)) throw new InvalidInputError("This item isn't on this project");
    // Bought for the client (ADR 0017, section 2a): it belongs to them and isn't expected back
    if (line.purchased === true) throw new InvalidInputError("This was bought for the client, so it doesn't come back");
    const { out, returned, lost } = lineCounts(line);
    // Equipment lost or broken isn't coming back either
    const left = out - (returned ?? 0) - (lost ?? 0);
    if (qty > left) {
      throw new InvalidInputError(`Only ${left} of this item ${left === 1 ? "is" : "are"} left to return`);
    }
    // returned + lost + qty <= out: `out` hasn't dropped below the target, and nobody returned or lost any meanwhile
    const clauses = ["#items.#line.#out >= :needed", unchangedCount("#returned", returned, ":returned"), unchangedCount("#lost", lost, ":lost")];
    const { item: productItem, tracked } = productWrite(db, ctx, key, product, qty, NO_EXTRA);
    const stockDelta = tracked ? qty : 0;
    return {
      result: { operationId: opId, command: "return", reason: "return", productKey: key, projectId, quantity: qty, stockDelta, userId: ctx.userId, at },
      writes: [
        {
          Update: {
            TableName: db.tableName,
            Key: projectKeyFor(ctx.teamId, projectId, project),
            UpdateExpression: "SET #items.#line.#returned = if_not_exists(#items.#line.#returned, :zero) + :qty ADD #version :one",
            ConditionExpression: anyOf(clauses, PROJECT_OPEN),
            ExpressionAttributeNames: { "#items": "items", "#line": key, "#out": "out", "#returned": "returned", "#lost": "lost", "#status": "status", "#version": "version" },
            ExpressionAttributeValues: {
              ":qty": qty,
              ":zero": 0,
              ":one": 1,
              ":closed": "closed",
              ":needed": (returned ?? 0) + (lost ?? 0) + qty,
              ...(returned === undefined ? {} : { ":returned": returned }),
              ...(lost === undefined ? {} : { ":lost": lost }),
            },
          },
        },
        productItem,
        movementPut(db, ctx, { productKey: key, reason: "return", delta: stockDelta, tracked, quantity: qty, projectId, operationId: opId, userId: ctx.userId, at }),
      ],
    };
  });
}

/**
 * Records `quantity` of a company equipment line as lost or broken on the job
 * (ADR 0017, section 3): adds them to the line's `lost`, which with `returned`
 * can't go above `out`, and records a `lost` movement in the item's history.
 * Stock doesn't change: it went down when the item was checked out, and the
 * item has left the business. With `charge` (dollars for the lot, client projects
 * only), adds it to the line's `lostCharge`, which the project charges the
 * client. The project must be open.
 */
export async function markLost(db: Db, ctx: TeamContext, input: LostInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const projectId = projectIdOf(input);
  const key = productKey(input.productKey);
  const qty = checkQuantity(input.quantity);
  const charge = input.charge === undefined ? undefined : money(input.charge, "charge");
  const request = JSON.stringify({ command: "lost", userId: ctx.userId, projectId, key, qty, ...(charge === undefined ? {} : { charge }) });
  const at = now.toISOString();

  return execute(db, ctx, opId, "lost", request, now, async () => {
    const [rawProject, product] = await readProjectAndProduct(db, ctx, projectId, key);
    const project = openProject(rawProject, "record what was lost or broken");
    // A General Use project (supply-checkout-mdae) has no client to charge
    if (charge !== undefined && project.kind === "adhoc") throw new InvalidInputError("This project has no client to charge");
    const line = lineOf(project.items as Item | undefined, key);
    if (!isMap(line)) throw new InvalidInputError("This item isn't on this project");
    if (line.kind !== "equipment") throw new InvalidInputError("Only company equipment is recorded as lost or broken");
    const { out, returned, lost } = lineCounts(line);
    const left = out - (returned ?? 0) - (lost ?? 0);
    if (qty > left) throw new InvalidInputError(`Only ${left} of this item ${left === 1 ? "is" : "are"} still out`);
    const stored = line.lostCharge;
    if (stored !== undefined && storedMoney(stored) === undefined) throw new InvalidInputError("This line's charge isn't an amount; correct the line first");
    // Several lost records on one line add up (in whole cents)
    // A charge of 0 is a charge too: the line gets a lostCharge (of what it had), as the movement records it
    const total = charge === undefined ? undefined : roundCents((storedMoney(stored) ?? 0) + charge);
    if (total !== undefined && total > MAX_MONEY) throw new InvalidInputError(`A line's charge can't be more than ${MAX_MONEY}`);

    const names: Record<string, string> = { "#items": "items", "#line": key, "#out": "out", "#returned": "returned", "#lost": "lost", "#status": "status", "#version": "version" };
    const values: Item = { ":lostNow": (lost ?? 0) + qty, ":needed": (returned ?? 0) + (lost ?? 0) + qty, ":one": 1, ":closed": "closed" };
    if (returned !== undefined) values[":returned"] = returned;
    if (lost !== undefined) values[":lost"] = lost;
    const sets = ["#items.#line.#lost = :lostNow"];
    // returned + lost <= out, and nobody returned or lost any meanwhile
    const clauses = ["#items.#line.#out >= :needed", unchangedCount("#returned", returned, ":returned"), unchangedCount("#lost", lost, ":lost")];
    if (total !== undefined) {
      names["#charge"] = "lostCharge";
      values[":charge"] = total;
      sets.push("#items.#line.#charge = :charge");
      if (stored === undefined) clauses.push("attribute_not_exists(#items.#line.#charge)");
      else {
        values[":stored"] = stored;
        clauses.push("#items.#line.#charge = :stored");
      }
    }
    const tracked = typeof product?.stock === "number";
    return {
      result: {
        operationId: opId,
        command: "lost",
        reason: "lost",
        productKey: key,
        projectId,
        quantity: qty,
        stockDelta: 0,
        ...(charge === undefined ? {} : { charge }),
        userId: ctx.userId,
        at,
      },
      writes: [
        {
          Update: {
            TableName: db.tableName,
            Key: projectKeyFor(ctx.teamId, projectId, project),
            UpdateExpression: `SET ${sets.join(", ")} ADD #version :one`,
            ConditionExpression: anyOf(clauses, PROJECT_OPEN),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          },
        },
        movementPut(db, ctx, {
          productKey: key,
          reason: "lost",
          delta: 0,
          tracked,
          quantity: qty,
          projectId,
          ...(charge === undefined ? {} : { charge }),
          operationId: opId,
          userId: ctx.userId,
          at,
        }),
      ],
    };
  });
}

export interface MoveInput {
  readonly operationId: unknown;
  /** The open General Use project the line comes off: `projectId`, or its old name `sheetId`. */
  readonly projectId?: unknown;
  readonly sheetId?: unknown;
  readonly productKey: unknown;
  /** The open client project it goes to: `toProjectId`, or its old name `toSheetId`. */
  readonly toProjectId?: unknown;
  readonly toSheetId?: unknown;
}

/** A project's version condition: the version read, or none when it had none. */
function sameVersion(project: Item, values: Item): string {
  if (typeof project.version !== "number") return "attribute_not_exists(#version)";
  values[":version"] = project.version;
  return "#version = :version";
}

/**
 * Moves a whole line from the open General Use project to an open client project (ADR
 * 0017, section 5), with its counts (`out`, `returned`, `lost`), in one
 * transaction:
 *
 * - The General Use project loses the line, on the condition that the project is
 *   unchanged since the read (its version), so the counts moved are exactly
 *   the ones taken off.
 * - The client project's line for the item gets the counts added to it, keeping its
 *   own snapshot (its price), or, if it has none, the line arrives as it is,
 *   with the snapshot it was taken with. Lines of different kinds (the item's
 *   kind changed between the two checkouts) are refused.
 * - A `move` movement records the counts, `fromProjectId` and `projectId` (the
 *   client project), with `delta: 0`: stock doesn't change, since the items left
 *   storage once, at the quick take.
 *
 * Both projects get a new version. Both must be open, and the client project must be
 * a client project, checked in the transaction. A retry with the same operation ID
 * changes nothing more.
 */
export async function moveLine(db: Db, ctx: TeamContext, input: MoveInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const projectId = projectIdOf(input);
  const toProjectId = toProjectIdOf(input);
  const key = productKey(input.productKey);
  const request = JSON.stringify({ command: "move", userId: ctx.userId, projectId, key, toProjectId });
  const at = now.toISOString();

  return execute(db, ctx, opId, "move", request, now, async () => {
    const [rawFrom, rawTo, product, pointer] = await Promise.all([
      readProjectItem(db, ctx.teamId, projectId),
      readProjectItem(db, ctx.teamId, toProjectId),
      getItem(db, keys.product(ctx.teamId, key)),
      readAdhoc(db, ctx.teamId),
    ]);
    const from = openProject(rawFrom, "move its lines");
    // The team's open General Use project, the one its ADHOC item names (checked in the transaction)
    if (from.kind !== "adhoc" || adhocOpen(pointer) !== projectId) throw new InvalidInputError("Only a line on the open General Use project moves to another project");
    if (!rawTo) throw new NotFoundError("No such project");
    const to = openProject(rawTo, "move a line to it");
    if (to.kind !== undefined) throw new InvalidInputError("A line moves to a client project only");
    const line = lineOf(from.items as Item | undefined, key);
    if (!isMap(line)) throw new InvalidInputError("This item isn't on this project");
    if (line.purchased === true) throw new InvalidInputError("This line was bought for a client and doesn't move");
    const { out, returned = 0, lost = 0 } = lineCounts(line);
    const toItems = to.items as Item | undefined;
    const existing = lineOf(toItems, key);
    if (existing !== undefined && !isMap(existing)) throw new InvalidInputError("The project's line for this item is malformed; correct it first");
    if (existing && (existing.kind ?? null) !== (line.kind ?? null)) {
      throw new InvalidInputError(existing.kind === "equipment" ? "The project has this item as company equipment; correct the lines by hand" : "The project has this item as a supply; correct the lines by hand");
    }

    // Off the General Use project, only as it was read
    const fromValues: Item = { ":one": 1, ":closed": "closed", ":adhoc": "adhoc" };
    const fromWrite: TransactItem = {
      Update: {
        TableName: db.tableName,
        Key: projectKeyFor(ctx.teamId, projectId, from),
        UpdateExpression: "REMOVE #items.#line ADD #version :one",
        ConditionExpression: anyOf(["#kind = :adhoc", "attribute_exists(#items.#line)", sameVersion(from, fromValues)], PROJECT_OPEN),
        ExpressionAttributeNames: { "#items": "items", "#line": key, "#kind": "kind", "#status": "status", "#version": "version" },
        ExpressionAttributeValues: fromValues,
      },
    };

    // Onto the client project: counts added to its line, or the line as it is
    const names: Record<string, string> = { "#items": "items", "#line": key, "#kind": "kind", "#status": "status", "#version": "version" };
    const values: Item = { ":one": 1, ":closed": "closed" };
    let update: string;
    let clauses: string[];
    if (existing) {
      lineCounts(existing);
      Object.assign(names, { "#out": "out", "#returned": "returned" });
      Object.assign(values, { ":out": out, ":returned": returned, ":zero": 0 });
      const sets = ["#items.#line.#out = #items.#line.#out + :out", "#items.#line.#returned = if_not_exists(#items.#line.#returned, :zero) + :returned"];
      clauses = ["attribute_exists(#items.#line.#out)"];
      // Still the kind it was read as when this commits (a line's kind never changes, but the line could be replaced)
      if (typeof existing.kind === "string") {
        values[":lineKind"] = existing.kind;
        clauses.push("#items.#line.#kind = :lineKind");
      } else clauses.push("attribute_not_exists(#items.#line.#kind)");
      if (lost > 0) {
        names["#lost"] = "lost";
        values[":lost"] = lost;
        sets.push("#items.#line.#lost = if_not_exists(#items.#line.#lost, :zero) + :lost");
      }
      // Equipment names the latest person to take it: the moved line's, when it's the later
      const takenAt = typeof line.takenAt === "string" ? line.takenAt : undefined;
      const theirs = typeof existing.takenAt === "string" ? existing.takenAt : undefined;
      if (line.kind === "equipment" && takenAt !== undefined && (theirs === undefined || takenAt > theirs)) {
        Object.assign(names, { "#by": "takenBy", "#at": "takenAt" });
        Object.assign(values, { ":by": line.takenBy, ":at": takenAt });
        sets.push("#items.#line.#by = :by", "#items.#line.#at = :at");
        if (theirs === undefined) clauses.push("attribute_not_exists(#items.#line.#at)");
        else {
          values[":theirs"] = theirs;
          clauses.push("#items.#line.#at = :theirs");
        }
      }
      update = `SET ${sets.join(", ")} ADD #version :one`;
    } else {
      if (Buffer.byteLength(JSON.stringify(to), "utf8") + Buffer.byteLength(JSON.stringify({ [key]: line }), "utf8") > MAX_DOCUMENT_BYTES) {
        throw new TooLargeError(`Projects are limited to ${MAX_DOCUMENT_BYTES} bytes; move it to another project`);
      }
      if (toItems) {
        values[":line"] = line;
        update = "SET #items.#line = :line ADD #version :one";
        clauses = ["attribute_exists(#items)", "attribute_not_exists(#items.#line)"];
      } else {
        values[":items"] = Object.fromEntries([[key, line]]);
        delete names["#line"];
        update = "SET #items = :items ADD #version :one";
        clauses = ["attribute_exists(PK)", "attribute_not_exists(#items)"];
      }
    }
    const toWrite: TransactItem = {
      Update: {
        TableName: db.tableName,
        Key: projectKeyFor(ctx.teamId, toProjectId, to),
        UpdateExpression: update,
        ConditionExpression: anyOf([...clauses, "attribute_not_exists(#kind)"], PROJECT_OPEN),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: storable(values),
      },
    };
    const tracked = typeof product?.stock === "number";
    return {
      result: {
        operationId: opId,
        command: "move",
        reason: "move",
        productKey: key,
        projectId,
        toProjectId,
        quantity: out,
        returned,
        lost,
        stockDelta: 0,
        lineCreated: !existing,
        userId: ctx.userId,
        at,
      },
      writes: [
        fromWrite,
        toWrite,
        // The ADHOC item still names the General Use project when this commits
        { ConditionCheck: { TableName: db.tableName, Key: keys.adhoc(ctx.teamId), ConditionExpression: "#open = :from", ExpressionAttributeNames: { "#open": "open" }, ExpressionAttributeValues: { ":from": projectId } } },
        movementPut(db, ctx, { productKey: key, reason: "move", delta: 0, tracked, quantity: out, returned, lost, projectId: toProjectId, fromProjectId: projectId, operationId: opId, userId: ctx.userId, at }),
      ],
    };
  });
}

/** The most lines one addLines request takes: its expressions stay well inside DynamoDB's 4 KB limit. */
export const MAX_ADD_LINES = 40;

export interface AddLinesInput {
  readonly operationId: unknown;
  /** The project: `projectId`, or its old name `sheetId` (supply-checkout-005.6). */
  readonly projectId?: unknown;
  readonly sheetId?: unknown;
  /** [{ productKey, quantity, name, price?, code?, cost?, priceSet? }], each product at most once. */
  readonly lines: unknown;
}

/** One line of addLines' result. */
export interface AddedLine {
  /** The product, as requested. */
  readonly productKey: string;
  readonly quantity: number;
  /** True when this added the line to the project; false when it added to an existing line. */
  readonly lineCreated: boolean;
  /** Company equipment bought for the client (ADR 0017, section 2a): the line it went on, `<productKey>:bought`. */
  readonly lineKey?: string;
  readonly purchased?: true;
}

/** What addLines did. The operation record keeps it, and a retry returns it unchanged. */
export interface AddLinesResult {
  readonly operationId: string;
  readonly command: "addLines";
  readonly projectId: string;
  /** Each line as requested, and whether this added it to the project (false: it added to an existing line). */
  readonly lines: readonly AddedLine[];
  readonly userId: string;
  readonly at: string;
}

interface RequestedLine {
  readonly key: string;
  readonly qty: number;
  readonly code: string;
  readonly name: string;
  /** Absent for company equipment whose price the server works out. */
  readonly price?: number;
  readonly cost?: number;
  /** "manual": the reviewer typed `price` (company equipment only; ignored for a supply). */
  readonly priceSet?: "manual";
}

const LINE_FIELDS = ["productKey", "quantity", "name", "price", "code", "cost", "priceSet"];

function addLinesInput(value: unknown): RequestedLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ADD_LINES) throw new InvalidInputError(`lines must be a list of 1 to ${MAX_ADD_LINES} lines`);
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (!isMap(raw)) throw new InvalidInputError("Each line must be an object");
    for (const field of Object.keys(raw)) {
      if (!LINE_FIELDS.includes(field)) throw new InvalidInputError(`Unexpected line field "${field}"`);
    }
    const key = productKey(raw.productKey);
    // Only the server puts a line under `<productKey>:bought`, for equipment it finds the product is
    if (isBoughtKey(key)) throw new InvalidInputError("Send the item's own key; the server keeps a bought item's line apart");
    if (seen.has(key)) throw new InvalidInputError("Each product can be in lines only once");
    seen.add(key);
    // A price is worked out by the server ("markup") or typed by the reviewer ("manual"), never sent as a markup price
    if (raw.priceSet !== undefined && raw.priceSet !== "manual") throw new InvalidInputError('priceSet is "manual", for a price the reviewer typed, or left out');
    if (raw.priceSet === "manual" && raw.price === undefined) throw new InvalidInputError('A line with priceSet "manual" needs its price');
    const cost = raw.cost === undefined ? undefined : money(raw.cost, "cost");
    const price = raw.price === undefined ? undefined : money(raw.price, "price");
    return {
      key,
      qty: checkQuantity(raw.quantity),
      code: raw.code === undefined ? "" : barcode(raw.code),
      name: lineName(raw.name),
      ...(price === undefined ? {} : { price }),
      ...(cost === undefined ? {} : { cost }),
      ...(raw.priceSet === "manual" ? { priceSet: "manual" as const } : {}),
    };
  });
}

/**
 * The line a requested line becomes, given its product as the transaction
 * reads it (ADR 0017, section 2a):
 *
 * - A supply's (or an item not in inventory): under its own key, with the
 *   request's `code`, `name`, `price` and `cost`, as before. `price` is required.
 * - Company equipment's: bought for the client, under `<productKey>:bought`
 *   with `purchased: true` and no `kind`. Its price is the reviewer's typed
 *   price (`priceSet: "manual"`, with `priceSetBy` and `priceSetAt`: who
 *   typed it and when), or else the receipt price each (`cost`,
 *   required then) plus the team's equipment markup, rounded to the cent
 *   (`priceSet: "markup"`). A price sent without "manual" is refused, so a
 *   client-sent price is never stored as a markup price.
 */
function boughtLine(line: RequestedLine, equipment: boolean, markup: number, typed: { readonly by: string; readonly at: string }): { key: string; snapshot: Item; purchased: boolean } {
  const { key, code, name, price, cost, priceSet } = line;
  const base = { code, name, ...(cost === undefined ? {} : { cost }) };
  if (!equipment) {
    // A supply's price is the request's, as before: required (money() refuses it missing)
    return { key, snapshot: { code, name, price: money(price, "price"), ...(cost === undefined ? {} : { cost }) }, purchased: false };
  }
  const lineKey = productKey(`${key}${BOUGHT_SUFFIX}`);
  // A typed price says who typed it and when, kept on the line (the operation record expires)
  if (priceSet === "manual") return { key: lineKey, snapshot: { ...base, price: price as number, purchased: true, priceSet: "manual", priceSetBy: typed.by, priceSetAt: typed.at }, purchased: true };
  if (price !== undefined) throw new InvalidInputError('This is company equipment, priced by the team\'s markup: leave its price out, or send priceSet "manual" with the price the reviewer typed');
  if (cost === undefined) throw new InvalidInputError("Company equipment bought for a client needs its receipt price each, as cost");
  const marked = roundCents(cost * (1 + markup / 100));
  if (marked > MAX_MONEY) throw new InvalidInputError(`The price with the markup is more than ${MAX_MONEY}; type a price instead`);
  return { key: lineKey, snapshot: { ...base, price: marked, purchased: true, priceSet: "markup" }, purchased: true };
}

/**
 * Adds lines bought for a project's client (a receipt saved to an existing
 * project): each line's `quantity` goes on the project's `out` for its product,
 * creating the line if the project doesn't have it (boughtLine says what the
 * new line holds). An existing line keeps its copy and its price. All the
 * lines change in one transaction, or none do, and a retry with the same
 * operation ID changes nothing.
 *
 * Each line's product is read, and checked in the transaction to still be
 * what it was read as (company equipment or not), so a line goes where its
 * product's kind says. A markup price is worked out from the team's settings
 * as read, and the transaction checks the markup is unchanged.
 *
 * Stock doesn't move: the items were bought for the client and never were in
 * storage. The project must be open.
 */
export async function addLines(db: Db, ctx: TeamContext, input: AddLinesInput, now = new Date()): Promise<CommandOutcome<AddLinesResult>> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const projectId = projectIdOf(input);
  const lines = addLinesInput(input.lines);
  const request = JSON.stringify({ command: "addLines", userId: ctx.userId, projectId, lines });
  const at = now.toISOString();

  return execute<AddLinesResult>(db, ctx, opId, "addLines", request, now, async () => {
    const [rawProject, ...products] = await Promise.all([readProjectItem(db, ctx.teamId, projectId), ...lines.map((l) => getItem(db, keys.product(ctx.teamId, l.key)))]);
    const project = openProject(rawProject, "add to it");
    // A receipt's lines go to a client project, never the General Use project (ADR 0017, section 4)
    if (project.kind === "adhoc") throw new InvalidInputError("A receipt's lines go on a client project, not the General Use project");
    // The team's settings, read only when an equipment line is priced by its markup
    const needsMarkup = lines.some((l, n) => products[n]?.kind === "equipment" && l.priceSet !== "manual");
    const settings = needsMarkup ? await getItem(db, keys.settings(ctx.teamId)) : undefined;
    const markup = storedMarkup(settings);

    const items = project.items as Item | undefined;
    const names: Record<string, string> = { "#i": "items", "#s": "status", "#v": "version", "#kd": "kind" };
    const values: Item = { ":one": 1, ":closed": "closed" };
    const sets: string[] = [];
    const clauses: string[] = [];
    const added: Item = {};
    const checks: TransactItem[] = [];
    const result = lines.map((requested, n): AddedLine => {
      const equipment = products[n]?.kind === "equipment";
      const { key, snapshot, purchased } = boughtLine(requested, equipment, markup, { by: ctx.userId, at });
      // Still what it was read as when this commits: equipment, or not (a missing item counts as not)
      checks.push({
        ConditionCheck: {
          TableName: db.tableName,
          Key: keys.product(ctx.teamId, requested.key),
          ConditionExpression: equipment ? "#kind = :equipment" : "attribute_not_exists(#kind) OR #kind <> :equipment",
          ExpressionAttributeNames: { "#kind": "kind" },
          ExpressionAttributeValues: { ":equipment": "equipment" },
        },
      });
      const existing = lineOf(items, key);
      if (existing !== undefined && !isMap(existing)) throw new InvalidInputError("A line on this project is malformed; correct it first");
      if (existing) {
        lineCounts(existing);
        names[`#k${n}`] = key;
        names["#o"] = "out";
        values[`:q${n}`] = requested.qty;
        sets.push(`#i.#k${n}.#o = #i.#k${n}.#o + :q${n}`);
        clauses.push(`attribute_exists(#i.#k${n}.#o)`);
      } else {
        const line = { ...snapshot, out: requested.qty, returned: 0 };
        added[key] = line;
        if (items) {
          names[`#k${n}`] = key;
          values[`:l${n}`] = line;
          sets.push(`#i.#k${n} = :l${n}`);
          clauses.push(`attribute_not_exists(#i.#k${n})`);
        }
      }
      return { productKey: requested.key, quantity: requested.qty, lineCreated: !existing, ...(purchased ? { lineKey: key, purchased: true as const } : {}) };
    });
    if (Buffer.byteLength(JSON.stringify(project), "utf8") + Buffer.byteLength(JSON.stringify(added), "utf8") > MAX_DOCUMENT_BYTES) {
      throw new TooLargeError(`Projects are limited to ${MAX_DOCUMENT_BYTES} bytes; start another project`);
    }
    // Still a client project when this commits
    clauses.unshift("attribute_not_exists(#kd)");
    if (items) clauses.unshift("attribute_exists(#i)");
    else {
      // No items map yet, so every line is new. An own field even for a key like "constructor".
      values[":items"] = added;
      sets.push("#i = :items");
      clauses.push("attribute_exists(PK)", "attribute_not_exists(#i)");
    }
    if (needsMarkup) {
      // The markup the prices were worked out with is still the team's when this commits
      const stored = settings?.equipmentMarkup;
      checks.push({
        ConditionCheck: {
          TableName: db.tableName,
          Key: keys.settings(ctx.teamId),
          ConditionExpression: stored === undefined ? "attribute_not_exists(#m)" : "#m = :m",
          ExpressionAttributeNames: { "#m": "equipmentMarkup" },
          ...(stored === undefined ? {} : { ExpressionAttributeValues: { ":m": stored } }),
        },
      });
    }
    return {
      result: { operationId: opId, command: "addLines", projectId, lines: result, userId: ctx.userId, at },
      writes: [
        {
          Update: {
            TableName: db.tableName,
            Key: projectKeyFor(ctx.teamId, projectId, project),
            UpdateExpression: `SET ${sets.join(", ")} ADD #v :one`,
            ConditionExpression: anyOf(clauses, [["attribute_not_exists(#s)"], ["#s <> :closed"]]),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: storable(values),
          },
        },
        ...checks,
      ],
    };
  });
}

/**
 * Changes a product's stock outside a project:
 *
 * - `receipt`: `quantity` eaches bought at `unitCost` each (after any pack
 *   conversion, ADR 0014) are added to stock. A product that didn't track
 *   stock starts at `quantity`. The product's own price and cost don't change.
 * - `count`: someone counted `count` in storage; stock is set to it, and the
 *   movement records the difference.
 * - `uncount`: the item is no longer counted. Its `stock` is removed, and the
 *   movement records taking it to 0 (`delta` is minus the stock it had), as a
 *   delete does, so its movements still add up when it's counted again (from
 *   0). An item that wasn't counted stays as it is, with a movement of
 *   `delta: 0, tracked: false`, like a checkout of it.
 */
export async function adjustStockCommand(db: Db, ctx: TeamContext, input: StockAdjustInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const key = productKey(input.productKey);
  let parsed: { reason: "receipt"; qty: number; unitCost: number } | { reason: "count"; counted: number } | { reason: "uncount" };
  if (input.reason === "receipt") {
    if (input.count !== undefined || input.expectedStock !== undefined) throw new InvalidInputError("A receipt takes quantity and unitCost, not count or expectedStock");
    parsed = { reason: "receipt", qty: checkQuantity(input.quantity), unitCost: money(input.unitCost, "unitCost") };
  } else if (input.reason === "count") {
    if (input.quantity !== undefined || input.unitCost !== undefined) throw new InvalidInputError("A count takes count only");
    parsed = { reason: "count", counted: checkCount(input.count) };
  } else if (input.reason === "uncount") {
    if (input.quantity !== undefined || input.unitCost !== undefined || input.count !== undefined) throw new InvalidInputError("Stopping the count takes no quantity, unitCost or count");
    parsed = { reason: "uncount" };
  } else {
    throw new InvalidInputError('reason must be "receipt", "count" or "uncount"');
  }
  // undefined: no check; null: the item wasn't counted; a number: the stock it had
  const expected = input.expectedStock === undefined || input.expectedStock === null ? input.expectedStock : expectedStock(input.expectedStock);
  const request = JSON.stringify({ command: "stockAdjust", userId: ctx.userId, key, ...parsed, ...(expected === undefined ? {} : { expectedStock: expected }) });
  const at = now.toISOString();
  const Key = keys.product(ctx.teamId, key);

  return execute(db, ctx, opId, "stockAdjust", request, now, async () => {
    const product = await getItem(db, Key);
    if (!product) throw new NotFoundError("No such item");
    checkVersion(product);
    const base = { operationId: opId, command: "stockAdjust" as const, productKey: key, userId: ctx.userId, at };
    if (parsed.reason === "receipt") {
      const { qty, unitCost } = parsed;
      // A restock above the reorder level ends the low-stock acknowledgment (reorder.ts)
      const ack = ackOnRaise(product, qty);
      return {
        result: { ...base, reason: "receipt", quantity: qty, stockDelta: qty, unitCost },
        writes: [
          {
            Update: {
              TableName: db.tableName,
              Key,
              UpdateExpression: `SET ${BUMP_VERSION} ADD #stock :qty${ackRemoval(ack)}`,
              ConditionExpression: ["attribute_exists(PK)", ...(ack ? [ack.clause] : [])].join(" AND "),
              ExpressionAttributeNames: { "#stock": "stock", "#version": "version", ...ack?.names },
              ExpressionAttributeValues: { ":qty": qty, ":one": 1, ...ack?.values },
            },
          },
          movementPut(db, ctx, { productKey: key, reason: "receipt", delta: qty, tracked: true, quantity: qty, unitCost, operationId: opId, userId: ctx.userId, at }),
        ],
      };
    }
    const current = product.stock;
    if (current !== undefined && typeof current !== "number") throw new InvalidInputError("This item's stock isn't a number");
    // Moved since the person started, and not already what they're setting: refused, not
    // undone. The writes below are conditional on `current`, so this holds when they commit.
    const target = parsed.reason === "count" ? parsed.counted : undefined;
    if (expected !== undefined && (current ?? null) !== expected && current !== target) {
      throw new StockChangedError(current === undefined ? "The count changed while you were editing: it's no longer counted" : `The count changed while you were editing: it's now ${current}`);
    }
    if (parsed.reason === "uncount") {
      const movement = { productKey: key, reason: "uncount" as const, operationId: opId, userId: ctx.userId, at };
      if (current === undefined) {
        return {
          result: { ...base, reason: "uncount", stockDelta: 0 },
          writes: [
            // Still not counted when this commits, or the movement would be wrong
            { ConditionCheck: { TableName: db.tableName, Key, ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(#stock)", ExpressionAttributeNames: { "#stock": "stock" } } },
            movementPut(db, ctx, { ...movement, delta: 0, tracked: false }),
          ],
        };
      }
      return {
        result: { ...base, reason: "uncount", stockDelta: 0 - current },
        writes: [
          {
            Update: {
              TableName: db.tableName,
              Key,
              UpdateExpression: `SET ${BUMP_VERSION} REMOVE #stock`,
              // Removed from the level just read, so the movement's delta is exact
              ConditionExpression: "attribute_exists(PK) AND #stock = :current",
              ExpressionAttributeNames: { "#stock": "stock", "#version": "version" },
              ExpressionAttributeValues: { ":current": current, ":one": 1 },
            },
          },
          movementPut(db, ctx, { ...movement, delta: 0 - current, tracked: true }),
        ],
      };
    }
    const delta = parsed.counted - (current ?? 0);
    // A count above the reorder level ends the low-stock acknowledgment (reorder.ts). The write is
    // conditional on the stock just read, so this is decided on the stock it replaces.
    const endsAck = ackEnds(product, parsed.counted);
    return {
      result: { ...base, reason: "count", count: parsed.counted, stockDelta: delta },
      writes: [
        {
          Update: {
            TableName: db.tableName,
            Key,
            UpdateExpression: `SET #stock = :count, ${BUMP_VERSION}${ackRemoval({ remove: endsAck })}`,
            // Set from the level just read, so the movement's delta is exact
            ConditionExpression: current === undefined ? "attribute_exists(PK) AND attribute_not_exists(#stock)" : "attribute_exists(PK) AND #stock = :current",
            ExpressionAttributeNames: { "#stock": "stock", "#version": "version", ...(endsAck ? { "#ackedAtStock": "ackedAtStock" } : {}) },
            ExpressionAttributeValues: { ":count": parsed.counted, ":one": 1, ...(current === undefined ? {} : { ":current": current }) },
          },
        },
        movementPut(db, ctx, { productKey: key, reason: "count", delta, tracked: true, count: parsed.counted, operationId: opId, userId: ctx.userId, at }),
      ],
    };
  });
}

/** An expectedStock that's a number, in a count's range. */
function expectedStock(value: unknown): number {
  if (!isCount(value) || value > MAX_QUANTITY) throw new InvalidInputError(`expectedStock must be null or a whole number from 0 to ${MAX_QUANTITY}`);
  return value;
}

/** True for a cursor whose sort key is in this product's history (or one queryPage will reject anyway). */
function cursorInHistory(cursor: string, prefix: string): boolean {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { SK?: unknown } | null;
    return typeof key?.SK !== "string" || key.SK.startsWith(prefix);
  } catch {
    return true;
  }
}

/** A product's stock history, newest first, a page at a time (1–100, default 50). Any member can read it. */
export async function listMovements(
  db: Db,
  ctx: TeamContext,
  rawKey: unknown,
  options: { readonly limit?: number; readonly cursor?: string } = {},
): Promise<Page<Movement>> {
  readable(ctx);
  const prefix = movementPrefix(productKey(rawKey));
  const { limit = 50, cursor } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInputError("limit is a number from 1 to 100");
  if (cursor !== undefined && !cursorInHistory(cursor, prefix)) throw new InvalidInputError("Invalid cursor");
  const pk = teamPartition(ctx.teamId);
  const page = await queryPage<Item>(
    db,
    {
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      ScanIndexForward: false,
      ConsistentRead: true,
      Limit: limit,
    },
    { attribute: PK, value: pk },
    cursor,
  );
  return { items: page.items.map((item) => movementWithBothNames(strip<Movement>(item) as Movement)), ...(page.cursor ? { cursor: page.cursor } : {}) };
}

/**
 * A movement with both spellings of its project fields (`sheetId` and
 * `projectId`, `fromSheetId` and `fromProjectId`), whichever it was stored
 * with, through the rename's window (supply-checkout-005.6).
 */
export function movementWithBothNames(movement: Movement): Movement {
  const m: Record<string, unknown> = { ...movement };
  for (const [old, current] of Object.entries(legacy.movementFields)) {
    if (m[current] === undefined && m[old] !== undefined) m[current] = m[old];
    if (m[old] === undefined && m[current] !== undefined) m[old] = m[current];
  }
  return m as unknown as Movement;
}
