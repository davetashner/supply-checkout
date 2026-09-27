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
import { ConflictError, InvalidInputError, NotFoundError, TooLargeError } from "./errors.js";
import { barcode, id as checkId, keys, movementPrefix, productKey, strip, teamPartition } from "./keys.js";
import { count as checkCount, money, quantity as checkQuantity, storedMoney } from "./money.js";
import { type Page, queryPage } from "./query.js";
import { PK } from "./schema.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export type CommandName = "checkout" | "return" | "stockAdjust" | "addLines";

/** Why a product's stock moved. `import` is a CSV inventory import setting stock (imports.ts). */
export type MovementReason = "checkout" | "return" | "receipt" | "count" | "import";

/** How long a retry with the same operation ID returns the first result. */
export const OPERATION_TTL_DAYS = 7;

/** Reads and transaction attempts before a busy line or product gives up with ConflictError. */
export const MAX_ATTEMPTS = 6;

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_NAME = 200;

/** The price and names a new line copies from the product (ADR 0014). */
export interface LineSnapshot {
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly cost?: number;
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
  /** Eaches checked out, returned or received. Absent for a count. */
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

export interface StockAdjustInput {
  readonly operationId: unknown;
  readonly productKey: unknown;
  /** `receipt`: `quantity` eaches bought at `unitCost` each. `count`: stock was counted at `count`. */
  readonly reason: unknown;
  readonly quantity?: unknown;
  readonly unitCost?: unknown;
  readonly count?: unknown;
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

/** True when DynamoDB cancelled the transaction because an item would pass its 400 KB limit. */
function itemTooLarge(error: unknown): boolean {
  const reasons = (error as { CancellationReasons?: { Code?: string; Message?: string }[] }).CancellationReasons ?? [];
  return reasons.some((r) => r.Code === "ValidationError" && /size/i.test(r.Message ?? ""));
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
      const codes = cancellationCodes(error);
      if (codes && itemTooLarge(error)) throw new TooLargeError("This sheet is too large to add to; start another sheet");
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
function lineCounts(line: Item): { out: number; returned: number | undefined } {
  const { out, returned } = line;
  if (!isCount(out) || (returned !== undefined && !isCount(returned))) {
    throw new InvalidInputError("This line's counts aren't whole numbers; correct the line first");
  }
  return { out, returned };
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
    } else {
      if (product) {
        const cost = storedMoney(product.cost);
        snapshot = {
          code: typeof product.code === "string" ? product.code : "",
          name: typeof product.name === "string" ? product.name : "",
          price: storedMoney(product.price) ?? 0,
          ...(cost === undefined ? {} : { cost }),
        };
      } else {
        if (oneOff.name === undefined || oneOff.price === undefined) {
          throw new InvalidInputError("This item isn't in inventory; send its name and price");
        }
        snapshot = { code: oneOff.code ?? "", name: oneOff.name, price: oneOff.price, ...(oneOff.cost === undefined ? {} : { cost: oneOff.cost }) };
      }
      const line = { ...snapshot, out: qty, returned: 0 };
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
    const { out, returned } = lineCounts(line);
    if ((returned ?? 0) + qty > out) {
      throw new InvalidInputError(`Only ${out - (returned ?? 0)} of this item ${out - (returned ?? 0) === 1 ? "is" : "are"} left to return`);
    }
    // returned + qty <= out: `out` hasn't dropped below the target, and nobody returned any meanwhile
    const clauses = ["#items.#line.#out >= :needed", returned === undefined ? "attribute_not_exists(#items.#line.#returned)" : "#items.#line.#returned = :returned"];
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
            ExpressionAttributeNames: { "#items": "items", "#line": key, "#out": "out", "#returned": "returned", "#status": "status", "#version": "version" },
            ExpressionAttributeValues: {
              ":qty": qty,
              ":zero": 0,
              ":one": 1,
              ":closed": "closed",
              ":needed": (returned ?? 0) + qty,
              ...(returned === undefined ? {} : { ":returned": returned }),
            },
          },
        },
        productItem,
        movementPut(db, ctx, { productKey: key, reason: "return", delta: stockDelta, tracked, quantity: qty, sheetId, operationId: opId, userId: ctx.userId, at }),
      ],
    };
  });
}

/** The most lines one addLines request takes: its expressions stay well inside DynamoDB's 4 KB limit. */
export const MAX_ADD_LINES = 40;

export interface AddLinesInput {
  readonly operationId: unknown;
  readonly sheetId: unknown;
  /** [{ productKey, quantity, name, price, code?, cost? }], each product at most once. */
  readonly lines: unknown;
}

/** What addLines did. The operation record keeps it, and a retry returns it unchanged. */
export interface AddLinesResult {
  readonly operationId: string;
  readonly command: "addLines";
  readonly sheetId: string;
  /** Each line as requested, and whether this added it to the sheet (false: it added to an existing line). */
  readonly lines: readonly { readonly productKey: string; readonly quantity: number; readonly lineCreated: boolean }[];
  readonly userId: string;
  readonly at: string;
}

interface NewLine extends LineSnapshot {
  readonly key: string;
  readonly qty: number;
}

function addLinesInput(value: unknown): NewLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ADD_LINES) throw new InvalidInputError(`lines must be a list of 1 to ${MAX_ADD_LINES} lines`);
  const seen = new Set<string>();
  return value.map((raw: unknown) => {
    if (!isMap(raw)) throw new InvalidInputError("Each line must be an object");
    for (const field of Object.keys(raw)) {
      if (!["productKey", "quantity", "name", "price", "code", "cost"].includes(field)) throw new InvalidInputError(`Unexpected line field "${field}"`);
    }
    const key = productKey(raw.productKey);
    if (seen.has(key)) throw new InvalidInputError("Each product can be in lines only once");
    seen.add(key);
    const cost = raw.cost === undefined ? undefined : money(raw.cost, "cost");
    return {
      key,
      qty: checkQuantity(raw.quantity),
      code: raw.code === undefined ? "" : barcode(raw.code),
      name: lineName(raw.name),
      price: money(raw.price, "price"),
      ...(cost === undefined ? {} : { cost }),
    };
  });
}

/**
 * Adds lines bought for a sheet's client (a receipt saved to an existing
 * sheet): each line's `quantity` goes on the sheet's `out` for its product,
 * creating the line, with the request's `code`, `name`, `price` and `cost`,
 * if the sheet doesn't have it. An existing line keeps its copy. All the lines
 * change in one transaction, or none do, and a retry with the same operation
 * ID changes nothing.
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
    const sheet = openSheet(await getItem(db, keys.sheet(ctx.teamId, sheetId)), "add to it");
    const items = sheet.items as Item | undefined;
    const names: Record<string, string> = { "#i": "items", "#s": "status", "#v": "version" };
    const values: Item = { ":one": 1, ":closed": "closed" };
    const sets: string[] = [];
    const clauses: string[] = [];
    const added: Item = {};
    const result = lines.map(({ key, qty, ...snapshot }, n) => {
      const existing = lineOf(items, key);
      if (existing !== undefined && !isMap(existing)) throw new InvalidInputError("A line on this sheet is malformed; correct it first");
      if (existing) {
        lineCounts(existing);
        names[`#k${n}`] = key;
        names["#o"] = "out";
        values[`:q${n}`] = qty;
        sets.push(`#i.#k${n}.#o = #i.#k${n}.#o + :q${n}`);
        clauses.push(`attribute_exists(#i.#k${n}.#o)`);
      } else {
        const line = { ...snapshot, out: qty, returned: 0 };
        added[key] = line;
        if (items) {
          names[`#k${n}`] = key;
          values[`:l${n}`] = line;
          sets.push(`#i.#k${n} = :l${n}`);
          clauses.push(`attribute_not_exists(#i.#k${n})`);
        }
      }
      return { productKey: key, quantity: qty, lineCreated: !existing };
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
 */
export async function adjustStockCommand(db: Db, ctx: TeamContext, input: StockAdjustInput, now = new Date()): Promise<CommandOutcome> {
  writable(db, ctx);
  const opId = operationId(input.operationId);
  const key = productKey(input.productKey);
  let parsed: { reason: "receipt"; qty: number; unitCost: number } | { reason: "count"; counted: number };
  if (input.reason === "receipt") {
    if (input.count !== undefined) throw new InvalidInputError("A receipt takes quantity and unitCost, not count");
    parsed = { reason: "receipt", qty: checkQuantity(input.quantity), unitCost: money(input.unitCost, "unitCost") };
  } else if (input.reason === "count") {
    if (input.quantity !== undefined || input.unitCost !== undefined) throw new InvalidInputError("A count takes count only");
    parsed = { reason: "count", counted: checkCount(input.count) };
  } else {
    throw new InvalidInputError('reason must be "receipt" or "count"');
  }
  const request = JSON.stringify({ command: "stockAdjust", userId: ctx.userId, key, ...parsed });
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
