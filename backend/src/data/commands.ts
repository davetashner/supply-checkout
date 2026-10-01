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
// 2. The sheet line (checkout and return): add to `out` or `returned` on the
//    server (`SET x = x + :qty`, since DynamoDB's ADD works only on top-level
//    attributes and a line is nested in the sheet's `items` map) and ADD 1 to
//    the sheet's `version`, only while the sheet is open, and for a return
//    only while returned stays at or below out. A new line snapshots `code`,
//    `name`, `price` and `cost` from the product (ADR 0014).
// 3. The product: ADD to `stock` and 1 to `version` when the product tracks
//    stock (has a numeric `stock`), otherwise a condition check that it still
//    doesn't. The new version makes a document write made against the old one
//    (an edit screen's PATCH with `stock`) fail with a conflict instead of
//    overwriting the command's change. Checking
//    out a new line also checks the product's version, so the snapshot is the
//    product as it is when the transaction commits.
//    (A receipt's lines for a client, addLines, change only the sheet: those
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
import { MAX_DOCUMENT_BYTES } from "./documents.js";
import { ConflictError, InvalidInputError, NotFoundError, StockChangedError, TooLargeError, isCancelledAsTooLarge } from "./errors.js";
import { BOUGHT_SUFFIX, barcode, id as checkId, keys, movementPrefix, productKey, strip, teamPartition } from "./keys.js";
import { count as checkCount, MAX_MONEY, MAX_QUANTITY, money, quantity as checkQuantity, roundCents, storedMoney } from "./money.js";
import { type Page, queryPage } from "./query.js";
import { PK } from "./schema.js";
import { storedMarkup } from "./settings.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export type CommandName = "checkout" | "return" | "lost" | "stockAdjust" | "addLines";

/**
 * Why a product's stock moved. `import` is a CSV inventory import setting
 * stock (imports.ts); `delete` is the product's document being deleted,
 * taking its stock to 0 (documents.ts); `uncount` is someone no longer
 * counting the item, which removes its stock, recorded as taking it to 0.
 * `lost` is company equipment lost or broken on a job (ADR 0017): it left the
 * business, but stock already went down when it was checked out, so its
 * delta is always 0.
 */
export type MovementReason = "checkout" | "return" | "receipt" | "count" | "uncount" | "import" | "delete" | "lost";


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
  readonly sheetId?: string;
  /** Eaches checked out, returned or received. Absent for a count or uncount. */
  readonly quantity?: number;
  /** For a count: the stock level counted. */
  readonly count?: number;
  /** The change to the product's `stock`: 0 when the product doesn't track stock (or isn't in inventory). */
  readonly stockDelta: number;
  /** Checkout: true when this checkout added the line to the sheet. */
  readonly lineCreated?: boolean;
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
  readonly sheetId?: string;
  readonly unitCost?: number;
  /** Lost: the amount charged to the client for it, if any. */
  readonly charge?: number;
  readonly operationId: string;
  readonly userId: string;
  readonly at: string;
}

export interface CheckoutInput {
  readonly operationId: unknown;
  readonly sheetId: unknown;
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
  readonly sheetId: unknown;
  readonly productKey: unknown;
  readonly quantity: unknown;
}

export interface LostInput {
  readonly operationId: unknown;
  readonly sheetId: unknown;
  readonly productKey: unknown;
  readonly quantity: unknown;
  /** Dollars to charge the client for the lot, if anything (job sheets only). */
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

/** The sheet isn't closed. The app treats any status but "closed" as open. */
const SHEET_OPEN = [["attribute_not_exists(#status)"], ["#status <> :closed"]];

function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
}

const RETRYABLE = new Set([undefined, "None", "ConditionalCheckFailed", "TransactionConflict"]);

/** True for the key of a line bought for the client (ADR 0017, section 2a), which only addLines makes. */
export function isBoughtKey(key: string): boolean {
  return key.endsWith(BOUGHT_SUFFIX);
}

/** A sheet's line for `key`, only if the sheet has one: never a built-in like `constructor` from the map's prototype. */
function lineOf(items: Item | undefined, key: string): unknown {
  return items !== undefined && Object.hasOwn(items, key) ? items[key] : undefined;
}

async function getItem(db: Db, key: Item): Promise<Item | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: key, ConsistentRead: true }));
  return Item;
}

/** The first run's result, if this operation ID was used before. */
async function priorOutcome<R>(db: Db, ctx: TeamContext, opId: string, request: string): Promise<CommandOutcome<R> | undefined> {
  const item = await getItem(db, keys.operation(ctx.teamId, opId));
  if (!item) return undefined;
  if (item.request !== request) throw new InvalidInputError("This operationId was already used for a different request; use a new one");
  return { result: item.result as R, replayed: true };
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
    const { writes, result } = await plan();
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
      return { result, replayed: false };
    } catch (error) {
      if (isCancelledAsTooLarge(error)) throw new TooLargeError("This sheet is too large to add to; start another sheet");
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
    return {
      item: {
        Update: {
          TableName: db.tableName,
          Key,
          UpdateExpression: `SET ${BUMP_VERSION} ADD #stock :delta`,
          ConditionExpression: ["attribute_exists(#stock)", ...extra.clauses].join(" AND "),
          ExpressionAttributeNames: { ...names, "#version": "version" },
          ExpressionAttributeValues: { ":delta": delta, ":one": 1, ...extra.values },
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

/** A sheet line's counts, as stored, or InvalidInputError if they can't be added to. */
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

function readSheetAndProduct(db: Db, ctx: TeamContext, sheetId: string, key: string): Promise<[Item | undefined, Item | undefined]> {
  return Promise.all([getItem(db, keys.sheet(ctx.teamId, sheetId)), getItem(db, keys.product(ctx.teamId, key))]);
}

function openSheet(sheet: Item | undefined, action: string): Item {
  if (!sheet) throw new NotFoundError("No such sheet");
  if (sheet.status === "closed") throw new ConflictError(`This sheet is closed. Reopen it to ${action}.`);
  if (sheet.items !== undefined && !isMap(sheet.items)) throw new InvalidInputError("This sheet's items are malformed");
  return sheet;
}

/**
 * Checks `quantity` eaches of `productKey` out onto a sheet: adds them to the
 * line's `out` (creating the line if needed) and takes them off stock.
 *
 * A new line copies `code`, `name`, `price` and `cost` from the product. Only
 * for an item that isn't in inventory does it use the request's `name` and
 * `price` (both required then), and its optional `code` and `cost`. An
 * existing line's copy never changes. The sheet must be open.
 */
export async function checkout(db: Db, ctx: TeamContext, input: CheckoutInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const sheetId = checkId(input.sheetId, "sheet ID");
  const key = productKey(input.productKey);
  if (isBoughtKey(key)) throw new InvalidInputError("Items bought for the client aren't checked out from storage");
  const qty = checkQuantity(input.quantity);
  const oneOff = {
    name: input.name === undefined ? undefined : lineName(input.name),
    price: input.price === undefined ? undefined : money(input.price, "price"),
    code: input.code === undefined ? undefined : barcode(input.code),
    cost: input.cost === undefined ? undefined : money(input.cost, "cost"),
  };
  const request = JSON.stringify({ command: "checkout", userId: ctx.userId, sheetId, key, qty, ...oneOff });
  const at = now.toISOString();

  return execute(db, ctx, opId, "checkout", request, now, async () => {
    const [rawSheet, product] = await readSheetAndProduct(db, ctx, sheetId, key);
    const sheet = openSheet(rawSheet, "check items out");
    const items = sheet.items as Item | undefined;
    const existing = lineOf(items, key);
    if (existing !== undefined && !isMap(existing)) throw new InvalidInputError("This line is malformed; correct it first");

    const names: Record<string, string> = { "#items": "items", "#line": key, "#status": "status", "#version": "version" };
    const values: Item = { ":one": 1, ":closed": "closed" };
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
      if (product) {
        const cost = storedMoney(product.cost);
        snapshot = {
          code: typeof product.code === "string" ? product.code : "",
          name: typeof product.name === "string" ? product.name : "",
          // Company equipment has no client price, and its line says what it is (ADR 0017)
          ...(product.kind === "equipment" ? { kind: "equipment" as const } : { price: storedMoney(product.price) ?? 0 }),
          ...(cost === undefined ? {} : { cost }),
        };
      } else {
        if (oneOff.name === undefined || oneOff.price === undefined) {
          throw new InvalidInputError("This item isn't in inventory; send its name and price");
        }
        snapshot = { code: oneOff.code ?? "", name: oneOff.name, price: oneOff.price, ...(oneOff.cost === undefined ? {} : { cost: oneOff.cost }) };
      }
      const line = { ...snapshot, out: qty, returned: 0, ...(snapshot.kind === "equipment" ? { takenBy: ctx.userId, takenAt: at } : {}) };
      // Refuse early a line that would take the sheet past the document limit
      // (DynamoDB would refuse it past 400 KB anyway, which execute also maps to 413)
      if (Buffer.byteLength(JSON.stringify(sheet), "utf8") + Buffer.byteLength(JSON.stringify({ [key]: line }), "utf8") > MAX_DOCUMENT_BYTES) {
        throw new TooLargeError(`Sheets are limited to ${MAX_DOCUMENT_BYTES} bytes; start another sheet`);
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

    // A new line's snapshot must be the product as the transaction finds it. A version that
    // isn't a number could never match, so refuse it now, not as a conflict after retries.
    if (!existing && product) checkVersion(product);
    const version = product?.version;
    const fresh = existing
      ? NO_EXTRA
      : typeof version === "number"
        ? { names: { "#version": "version" }, values: { ":version": version }, clauses: ["#version = :version"] }
        : { names: { "#version": "version" }, values: {}, clauses: ["attribute_not_exists(#version)"] };
    const { item: productItem, tracked } = productWrite(db, ctx, key, product, -qty, fresh);
    const stockDelta = tracked ? -qty : 0;

    const result: CommandResult = {
      operationId: opId,
      command: "checkout",
      reason: "checkout",
      productKey: key,
      sheetId,
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
            Key: keys.sheet(ctx.teamId, sheetId),
            UpdateExpression: update,
            ConditionExpression: anyOf(clauses, SHEET_OPEN),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: storable(values),
          },
        },
        productItem,
        movementPut(db, ctx, { productKey: key, reason: "checkout", delta: stockDelta, tracked, quantity: qty, sheetId, operationId: opId, userId: ctx.userId, at }),
      ],
    };
  });
}

/**
 * Records `quantity` eaches of a line coming back: adds them to the line's
 * `returned`, which can't go above `out`, and puts them back in stock. The
 * sheet must be open: a closed sheet takes no returns (reopen it, or correct
 * the line's counts with a document edit, which doesn't move stock).
 */
export async function returnItems(db: Db, ctx: TeamContext, input: ReturnInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const sheetId = checkId(input.sheetId, "sheet ID");
  const key = productKey(input.productKey);
  const qty = checkQuantity(input.quantity);
  const request = JSON.stringify({ command: "return", userId: ctx.userId, sheetId, key, qty });
  const at = now.toISOString();

  return execute(db, ctx, opId, "return", request, now, async () => {
    const [rawSheet, product] = await readSheetAndProduct(db, ctx, sheetId, key);
    const sheet = openSheet(rawSheet, "record returns");
    const line = lineOf(sheet.items as Item | undefined, key);
    if (!isMap(line)) throw new InvalidInputError("This item isn't on this sheet");
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
      result: { operationId: opId, command: "return", reason: "return", productKey: key, sheetId, quantity: qty, stockDelta, userId: ctx.userId, at },
      writes: [
        {
          Update: {
            TableName: db.tableName,
            Key: keys.sheet(ctx.teamId, sheetId),
            UpdateExpression: "SET #items.#line.#returned = if_not_exists(#items.#line.#returned, :zero) + :qty ADD #version :one",
            ConditionExpression: anyOf(clauses, SHEET_OPEN),
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
        movementPut(db, ctx, { productKey: key, reason: "return", delta: stockDelta, tracked, quantity: qty, sheetId, operationId: opId, userId: ctx.userId, at }),
      ],
    };
  });
}

/**
 * Records `quantity` of a company equipment line as lost or broken on the job
 * (ADR 0017, section 3): adds them to the line's `lost`, which with `returned`
 * can't go above `out`, and records a `lost` movement in the item's history.
 * Stock doesn't change: it went down when the item was checked out, and the
 * item has left the business. With `charge` (dollars for the lot, job sheets
 * only), adds it to the line's `lostCharge`, which the sheet charges the
 * client. The sheet must be open.
 */
export async function markLost(db: Db, ctx: TeamContext, input: LostInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const sheetId = checkId(input.sheetId, "sheet ID");
  const key = productKey(input.productKey);
  const qty = checkQuantity(input.quantity);
  const charge = input.charge === undefined ? undefined : money(input.charge, "charge");
  const request = JSON.stringify({ command: "lost", userId: ctx.userId, sheetId, key, qty, ...(charge === undefined ? {} : { charge }) });
  const at = now.toISOString();

  return execute(db, ctx, opId, "lost", request, now, async () => {
    const [rawSheet, product] = await readSheetAndProduct(db, ctx, sheetId, key);
    const sheet = openSheet(rawSheet, "record what was lost or broken");
    // An ad hoc sheet (supply-checkout-mdae) has no client to charge
    if (charge !== undefined && sheet.kind === "adhoc") throw new InvalidInputError("This sheet has no client to charge");
    const line = lineOf(sheet.items as Item | undefined, key);
    if (!isMap(line)) throw new InvalidInputError("This item isn't on this sheet");
    if (line.kind !== "equipment") throw new InvalidInputError("Only company equipment is recorded as lost or broken");
    const { out, returned, lost } = lineCounts(line);
    const left = out - (returned ?? 0) - (lost ?? 0);
    if (qty > left) throw new InvalidInputError(`Only ${left} of this item ${left === 1 ? "is" : "are"} still out`);
    const stored = line.lostCharge;
    if (stored !== undefined && storedMoney(stored) === undefined) throw new InvalidInputError("This line's charge isn't an amount; correct the line first");
    // Several lost records on one line add up (in whole cents)
    const total = charge ? roundCents((storedMoney(stored) ?? 0) + charge) : undefined;
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
        sheetId,
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
            Key: keys.sheet(ctx.teamId, sheetId),
            UpdateExpression: `SET ${sets.join(", ")} ADD #version :one`,
            ConditionExpression: anyOf(clauses, SHEET_OPEN),
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
          sheetId,
          ...(charge === undefined ? {} : { charge }),
          operationId: opId,
          userId: ctx.userId,
          at,
        }),
      ],
    };
  });
}

/** The most lines one addLines request takes: its expressions stay well inside DynamoDB's 4 KB limit. */
export const MAX_ADD_LINES = 40;

export interface AddLinesInput {
  readonly operationId: unknown;
  readonly sheetId: unknown;
  /** [{ productKey, quantity, name, price?, code?, cost?, priceSet? }], each product at most once. */
  readonly lines: unknown;
}

/** One line of addLines' result. */
export interface AddedLine {
  /** The product, as requested. */
  readonly productKey: string;
  readonly quantity: number;
  /** True when this added the line to the sheet; false when it added to an existing line. */
  readonly lineCreated: boolean;
  /** Company equipment bought for the client (ADR 0017, section 2a): the line it went on, `<productKey>:bought`. */
  readonly lineKey?: string;
  readonly purchased?: true;
}

/** What addLines did. The operation record keeps it, and a retry returns it unchanged. */
export interface AddLinesResult {
  readonly operationId: string;
  readonly command: "addLines";
  readonly sheetId: string;
  /** Each line as requested, and whether this added it to the sheet (false: it added to an existing line). */
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
 *   price (`priceSet: "manual"`), or else the receipt price each (`cost`,
 *   required then) plus the team's equipment markup, rounded to the cent
 *   (`priceSet: "markup"`). A price sent without "manual" is refused, so a
 *   client-sent price is never stored as a markup price.
 */
function boughtLine(line: RequestedLine, equipment: boolean, markup: number): { key: string; snapshot: Item; purchased: boolean } {
  const { key, code, name, price, cost, priceSet } = line;
  const base = { code, name, ...(cost === undefined ? {} : { cost }) };
  if (!equipment) {
    // A supply's price is the request's, as before: required (money() refuses it missing)
    return { key, snapshot: { code, name, price: money(price, "price"), ...(cost === undefined ? {} : { cost }) }, purchased: false };
  }
  const lineKey = productKey(`${key}${BOUGHT_SUFFIX}`);
  if (priceSet === "manual") return { key: lineKey, snapshot: { ...base, price: price as number, purchased: true, priceSet: "manual" }, purchased: true };
  if (price !== undefined) throw new InvalidInputError('This is company equipment, priced by the team\'s markup: leave its price out, or send priceSet "manual" with the price the reviewer typed');
  if (cost === undefined) throw new InvalidInputError("Company equipment bought for a client needs its receipt price each, as cost");
  const marked = roundCents(cost * (1 + markup / 100));
  if (marked > MAX_MONEY) throw new InvalidInputError(`The price with the markup is more than ${MAX_MONEY}; type a price instead`);
  return { key: lineKey, snapshot: { ...base, price: marked, purchased: true, priceSet: "markup" }, purchased: true };
}

/**
 * Adds lines bought for a sheet's client (a receipt saved to an existing
 * sheet): each line's `quantity` goes on the sheet's `out` for its product,
 * creating the line if the sheet doesn't have it (boughtLine says what the
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
 * storage. The sheet must be open.
 */
export async function addLines(db: Db, ctx: TeamContext, input: AddLinesInput, now = new Date()): Promise<CommandOutcome<AddLinesResult>> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const sheetId = checkId(input.sheetId, "sheet ID");
  const lines = addLinesInput(input.lines);
  const request = JSON.stringify({ command: "addLines", userId: ctx.userId, sheetId, lines });
  const at = now.toISOString();

  return execute<AddLinesResult>(db, ctx, opId, "addLines", request, now, async () => {
    const [rawSheet, ...products] = await Promise.all([getItem(db, keys.sheet(ctx.teamId, sheetId)), ...lines.map((l) => getItem(db, keys.product(ctx.teamId, l.key)))]);
    const sheet = openSheet(rawSheet, "add to it");
    // The team's settings, read only when an equipment line is priced by its markup
    const needsMarkup = lines.some((l, n) => products[n]?.kind === "equipment" && l.priceSet !== "manual");
    const settings = needsMarkup ? await getItem(db, keys.settings(ctx.teamId)) : undefined;
    const markup = storedMarkup(settings);

    const items = sheet.items as Item | undefined;
    const names: Record<string, string> = { "#i": "items", "#s": "status", "#v": "version" };
    const values: Item = { ":one": 1, ":closed": "closed" };
    const sets: string[] = [];
    const clauses: string[] = [];
    const added: Item = {};
    const checks: TransactItem[] = [];
    const result = lines.map((requested, n): AddedLine => {
      const equipment = products[n]?.kind === "equipment";
      const { key, snapshot, purchased } = boughtLine(requested, equipment, markup);
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
      if (existing !== undefined && !isMap(existing)) throw new InvalidInputError("A line on this sheet is malformed; correct it first");
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
    if (Buffer.byteLength(JSON.stringify(sheet), "utf8") + Buffer.byteLength(JSON.stringify(added), "utf8") > MAX_DOCUMENT_BYTES) {
      throw new TooLargeError(`Sheets are limited to ${MAX_DOCUMENT_BYTES} bytes; start another sheet`);
    }
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
      result: { operationId: opId, command: "addLines", sheetId, lines: result, userId: ctx.userId, at },
      writes: [
        {
          Update: {
            TableName: db.tableName,
            Key: keys.sheet(ctx.teamId, sheetId),
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
 * Changes a product's stock outside a sheet:
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
      return {
        result: { ...base, reason: "receipt", quantity: qty, stockDelta: qty, unitCost },
        writes: [
          {
            Update: {
              TableName: db.tableName,
              Key,
              UpdateExpression: `SET ${BUMP_VERSION} ADD #stock :qty`,
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeNames: { "#stock": "stock", "#version": "version" },
              ExpressionAttributeValues: { ":qty": qty, ":one": 1 },
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
    return {
      result: { ...base, reason: "count", count: parsed.counted, stockDelta: delta },
      writes: [
        {
          Update: {
            TableName: db.tableName,
            Key,
            UpdateExpression: `SET #stock = :count, ${BUMP_VERSION}`,
            // Set from the level just read, so the movement's delta is exact
            ConditionExpression: current === undefined ? "attribute_exists(PK) AND attribute_not_exists(#stock)" : "attribute_exists(PK) AND #stock = :current",
            ExpressionAttributeNames: { "#stock": "stock", "#version": "version" },
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
  return { items: page.items.map((item) => strip<Movement>(item) as Movement), ...(page.cursor ? { cursor: page.cursor } : {}) };
}
