// CSV inventory import (supply-checkout-1dg.4, ADR 0014): an owner uploads a
// spreadsheet of items (name, barcode, price, cost, stock, pack_size) and
// every row goes in, or none does.
//
// All or nothing, for more rows than one DynamoDB transaction can hold (100
// items), in three steps:
//
// 1. Validate. The server parses the CSV itself and checks every cell and
//    every row against the whole inventory (duplicates in the file, ambiguous
//    matches) before it writes anything. Any problem: nothing is written, and
//    the answer lists every bad row. A dry run stops here and returns the
//    preview: what each row will create or change.
// 2. Stage. One transaction writes the import's job record `IMPORT#<id>`
//    (only if new) and its whole plan, in chunk records
//    `IMPORT#<id>#CHUNK#<n>` of up to ROWS_PER_CHUNK rows each: the product
//    key each row writes and the values it sets.
// 3. Commit, chunk by chunk. Each chunk is one transaction: its product
//    writes, a movement for every stock change, and the job's progress
//    counter (`committed = n` to `n + 1`, conditional on it still being n).
//    A chunk is applied exactly once, whole or not at all.
//
// If the commit stops part-way (the Lambda times out, or items keep changing
// under it), the import isn't abandoned half done: the same request again
// (same importId and file) finds the job and carries on from the first chunk
// not committed, with the plan staged in step 2, so it rolls forward to the
// complete import. The app retries automatically and offers "Try again". A
// finished import replays its summary. The job records expire after
// OPERATION_TTL_DAYS.
//
// Re-importing a file doesn't duplicate items: a row matches an existing item
// by barcode, or by name when either side has no barcode (ADR 0014), and
// updates it. A re-import sets values (stock included) rather than adding to
// them, and a row that changes nothing writes nothing. New items get keys
// derived from their barcode (as the app makes them, keyOf in src/format.js)
// or name, so two imports of one file at the same moment write the same keys
// and still make one item each.
//
// Only owners can import (a bulk change to shared prices and stock). Every
// write is in the team's partition, so the data-access role's LeadingKeys
// condition holds.

import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection, storable } from "./client.js";
import { type Movement, OPERATION_TTL_DAYS } from "./commands.js";
import { parseCsv } from "./csv.js";
import { RESERVED_FIELDS } from "./documents.js";
import { ConflictError, InvalidInputError, TooLargeError } from "./errors.js";
import { MAX_CODE_LENGTH, keys, prefixes, teamPartition } from "./keys.js";
import { MAX_MONEY, MAX_QUANTITY, roundCents } from "./money.js";
import { queryAll } from "./query.js";
import { type TeamContext, writable } from "./team-context.js";

/** The largest file, as UTF-8. 1,000 rows of typical inventory are well under it. */
export const MAX_IMPORT_BYTES = 300_000;
/** The most rows (not counting the header) one import takes. */
export const MAX_IMPORT_ROWS = 1000;
/** The largest pack size (ADR 0014). */
export const MAX_PACK_SIZE = 10_000;
/** The longest item name, as the checkout command allows. */
export const MAX_NAME_LENGTH = 200;
/**
 * Rows per commit transaction: each row writes its product and a movement,
 * and the job's progress counter makes 2 × 49 + 1 = 99 of DynamoDB's 100.
 */
export const ROWS_PER_CHUNK = 49;
/** Row errors returned at most; errorCount has the total. */
export const MAX_ERRORS = 200;

const MAX_COLUMNS = 50;
const MAX_NUMBER_TEXT = 32;
const MAX_ATTEMPTS = 6;
const IMPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
const RESERVED = new Set(RESERVED_FIELDS);

type Field = "name" | "barcode" | "price" | "cost" | "stock" | "packSize";

/** The column names errors use, as the file would spell them. */
const LABEL: Record<Field, string> = { name: "name", barcode: "barcode", price: "price", cost: "cost", stock: "stock", packSize: "pack_size" };

/**
 * Header names, lowercased with spaces, underscores and hyphens removed
 * (ADR 0014: "matched without regard to case or spacing"), and a few common
 * spreadsheet names for the same columns. A Map, so a header like
 * "constructor" is just unknown.
 */
const HEADERS = new Map<string, Field>([
  ["name", "name"], ["item", "name"], ["itemname", "name"],
  ["barcode", "barcode"], ["code", "barcode"], ["upc", "barcode"],
  ["price", "price"], ["priceeach", "price"],
  ["cost", "cost"], ["costeach", "cost"], ["unitcost", "cost"],
  ["stock", "stock"], ["instorage", "stock"], ["onhand", "stock"],
  ["packsize", "packSize"], ["casesize", "packSize"],
]);

/** One valid row of the file, with its values as they'll be saved. */
export interface ImportRow {
  /** The line of the file it's on (from 1; the header is usually line 1). */
  readonly line: number;
  readonly name: string;
  /** Empty for an item without one. */
  readonly barcode: string;
  /** Client price per each, rounded to cents. */
  readonly price: number;
  readonly cost?: number;
  /** Whole eaches. Absent: leave stock as it is (a new item doesn't track stock). */
  readonly stock?: number;
  readonly packSize?: number;
}

/** A problem with one row (or with the header, on its line). Nothing is imported while there are any. */
export interface RowError {
  readonly line: number;
  /** The column, as the file names it, when the problem is in one cell. */
  readonly column?: string;
  readonly message: string;
}

export type ImportAction = "create" | "update" | "unchanged";

/** A row as the import will apply it: which item it writes and what changes. */
export interface PlannedRow extends ImportRow {
  /** The product key it writes: the matched item's, or a new one. */
  readonly key: string;
  readonly action: ImportAction;
  /** The fields that change (all of the row's for a new item): code, name, price, cost, packSize, stock. */
  readonly changes: string[];
}

export interface ImportSummary {
  readonly rows: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
}

export interface ImportInput {
  /** A UUID the client makes for one import and sends again on every retry of it. Not needed for a dry run. */
  readonly importId?: unknown;
  /** The CSV file's text. */
  readonly csv: unknown;
  /** True: validate and return the preview, and write nothing. */
  readonly dryRun?: unknown;
}

export type ImportOutcome =
  | {
      /** `preview`: a dry run with no problems. `invalid`: nothing was (or would be) imported; see errors. */
      readonly status: "preview" | "invalid";
      readonly rows: PlannedRow[];
      readonly errors: RowError[];
      readonly errorCount: number;
      /** Header cells that aren't a known column, which the import leaves out. */
      readonly ignoredColumns: string[];
      readonly summary: ImportSummary;
    }
  | {
      readonly status: "imported";
      readonly importId: string;
      /** True when this import had already finished and this is its summary again. */
      readonly replayed: boolean;
      readonly summary: ImportSummary;
    };

type Item = Record<string, unknown>;
type TransactItem = Record<string, Record<string, unknown>>;

/** A row as staged in a chunk record: what to write, without the preview's extras. */
interface StagedRow {
  readonly line: number;
  readonly key: string;
  readonly name: string;
  readonly barcode: string;
  readonly price: number;
  readonly cost?: number;
  readonly stock?: number;
  readonly packSize?: number;
}

class CellError extends Error {
  readonly column: string;
  constructor(field: Field, message: string) {
    super(message);
    this.column = LABEL[field];
  }
}

const normalizeHeader = (h: string) => h.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "");
const nameKey = (name: string) => name.normalize("NFKC").trim().toLowerCase();

function textCell(field: Field, raw: string, max: number): string {
  if (raw.length > max) throw new CellError(field, `${LABEL[field]} is longer than ${max} characters`);
  if (CONTROL.test(raw)) throw new CellError(field, `${LABEL[field]} has a control character in it`);
  return raw;
}

const DIGITS = /^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d*)?$|^\.\d+$/;

/** A number cell without its currency sign and spaces, or a CellError for a negative or malformed one. */
function numberText(field: Field, raw: string, what: string): string {
  const s = raw.replace(/\s+/g, "");
  if (s.length > MAX_NUMBER_TEXT) throw new CellError(field, `${LABEL[field]} isn't ${what}`);
  if (/^(?:\$?[-−(]|\$?\()/.test(s)) throw new CellError(field, `${LABEL[field]} can't be negative`);
  const bare = s.startsWith("$") ? s.slice(1) : s;
  if (!DIGITS.test(bare)) throw new CellError(field, `${LABEL[field]} isn't ${what}`);
  return bare.replaceAll(",", "");
}

/** Money (ADR 0014): `$` and thousands separators allowed, rounded to cents, 0 to MAX_MONEY. */
function moneyCell(field: Field, raw: string): number {
  const n = roundCents(Number(numberText(field, raw, "an amount (for example 12.50 or $1,200)")));
  if (n > MAX_MONEY) throw new CellError(field, `${LABEL[field]} can't be more than ${MAX_MONEY.toLocaleString("en-US")}`);
  return n;
}

function wholeCell(field: Field, raw: string, min: number, max: number): number {
  const n = Number(numberText(field, raw, "a number"));
  if (!Number.isInteger(n)) throw new CellError(field, `${LABEL[field]} must be a whole number`);
  if (n < min || n > max) throw new CellError(field, `${LABEL[field]} must be from ${min} to ${max.toLocaleString("en-US")}`);
  return n;
}

export interface ParsedImport {
  readonly rows: ImportRow[];
  readonly errors: RowError[];
  readonly ignoredColumns: string[];
}

/**
 * Reads and validates the file. A problem with the file as a whole (too big,
 * no header, a missing required column, an unclosed quote) is an
 * InvalidInputError; problems with rows come back as `errors`, every one.
 */
export function parseInventoryCsv(csv: unknown): ParsedImport {
  if (typeof csv !== "string") throw new InvalidInputError("csv must be the file's text");
  if (Buffer.byteLength(csv, "utf8") > MAX_IMPORT_BYTES) throw new InvalidInputError(`The file is larger than ${MAX_IMPORT_BYTES / 1000} KB; split it into smaller files`);
  const records = parseCsv(csv, { maxRecords: MAX_IMPORT_ROWS + 1, maxFields: MAX_COLUMNS }).filter((r) => r.cells.some((c) => c.trim() !== ""));
  const [header, ...body] = records;
  if (!header) throw new InvalidInputError("The file is empty");

  const columns: (Field | undefined)[] = [];
  const ignoredColumns: string[] = [];
  for (const cell of header.cells) {
    const field = HEADERS.get(normalizeHeader(cell));
    columns.push(field);
    if (field === undefined) {
      if (cell.trim()) ignoredColumns.push(cell.trim().slice(0, 100));
    } else if (columns.indexOf(field) !== columns.length - 1) {
      throw new InvalidInputError(`The ${LABEL[field]} column appears twice`);
    }
  }
  for (const required of ["name", "price"] as const) {
    if (!columns.includes(required)) {
      throw new InvalidInputError(`The file needs a ${LABEL[required]} column. Its first row names the columns: name, barcode, price, cost, stock, pack_size`);
    }
  }
  if (!body.length) throw new InvalidInputError("The file has no rows under its header");

  const rows: ImportRow[] = [];
  const errors: RowError[] = [];
  for (const record of body) {
    const extra = record.cells.slice(columns.length).some((c) => c.trim() !== "");
    if (extra) {
      errors.push({ line: record.line, message: "This row has more cells than the header has columns" });
      continue;
    }
    const cell = (field: Field) => {
      const i = columns.indexOf(field);
      return i < 0 ? "" : (record.cells[i] ?? "").trim();
    };
    const problems: RowError[] = [];
    const read = <T>(field: Field, parse: (raw: string) => T): T | undefined => {
      const raw = cell(field);
      try {
        if (raw === "") {
          if (field === "name" || field === "price") throw new CellError(field, `${LABEL[field]} is required`);
          return undefined;
        }
        return parse(raw);
      } catch (error) {
        if (!(error instanceof CellError)) throw error;
        problems.push({ line: record.line, column: error.column, message: error.message });
        return undefined;
      }
    };
    const name = read("name", (raw) => textCell("name", raw, MAX_NAME_LENGTH));
    const barcode = read("barcode", (raw) => textCell("barcode", raw, MAX_CODE_LENGTH));
    const price = read("price", (raw) => moneyCell("price", raw));
    const cost = read("cost", (raw) => moneyCell("cost", raw));
    const stock = read("stock", (raw) => wholeCell("stock", raw, 0, MAX_QUANTITY));
    const packSize = read("packSize", (raw) => wholeCell("packSize", raw, 1, MAX_PACK_SIZE));
    if (problems.length || name === undefined || price === undefined) {
      errors.push(...problems);
      continue;
    }
    rows.push({
      line: record.line,
      name,
      barcode: barcode ?? "",
      price,
      ...(cost === undefined ? {} : { cost }),
      ...(stock === undefined ? {} : { stock }),
      ...(packSize === undefined ? {} : { packSize }),
    });
  }
  return { rows, errors, ignoredColumns };
}

/** A barcode's product key, as the app makes it (keyOf in src/format.js). Keep the two the same. */
export function keyOfBarcode(code: string): string {
  let k = code.trim().replace(/[^A-Za-z0-9_\-.~:@+]/g, "_").slice(0, 150);
  if (/^\.+$/.test(k) || k === "__proto__") k = "x" + k;
  return k;
}

/** The fields an import sets, in the order `changes` lists them. */
const IMPORTED = ["code", "name", "price", "cost", "packSize", "stock"] as const;

/** An item's data after a row is applied: the row's values over what's there, and blank cells keep what's there. */
function applyRow(current: Item | undefined, row: ImportRow): { data: Item; changes: string[] } {
  const before = current ?? {};
  const data: Item = { ...before };
  // A row without a barcode keeps the item's; a new item without one gets "", as the app writes it
  if (row.barcode) data.code = row.barcode;
  else if (!current) data.code = "";
  data.name = row.name;
  data.price = row.price;
  if (row.cost !== undefined) data.cost = row.cost;
  if (row.packSize !== undefined) data.packSize = row.packSize;
  if (row.stock !== undefined) data.stock = row.stock;
  const changes = IMPORTED.filter((f) => (current ? before[f] !== data[f] : data[f] !== undefined && data[f] !== ""));
  return { data, changes };
}

/** A stored item's document data: everything but the key attributes and server-owned fields. */
function documentData(item: Item): Item {
  const data: Item = {};
  for (const [k, v] of Object.entries(item)) if (!RESERVED.has(k)) data[k] = v;
  return data;
}

/**
 * Matches every row to an existing item or a new key, against the whole
 * inventory, and reports rows that would clash: two rows for one item, or a
 * row that matches more than one item.
 */
export function planImport(rows: ImportRow[], products: Item[]): { planned: PlannedRow[]; errors: RowError[] } {
  const byCode = new Map<string, Item[]>();
  const byName = new Map<string, Item[]>();
  const taken = new Set<string>();
  const codeOf = (p: Item) => (typeof p.code === "string" ? p.code.trim() : "");
  const push = (map: Map<string, Item[]>, k: string, p: Item) => map.set(k, [...(map.get(k) ?? []), p]);
  for (const p of products) {
    taken.add(String(p.key));
    if (codeOf(p)) push(byCode, codeOf(p), p);
    if (typeof p.name === "string" && p.name.trim()) push(byName, nameKey(p.name), p);
  }

  const planned: PlannedRow[] = [];
  const errors: RowError[] = [];
  const fileCodes = new Map<string, number>();
  const fileNames = new Map<string, number>();
  const fileKeys = new Map<string, number>();
  for (const row of rows) {
    const n = nameKey(row.name);
    const fail = (column: string | undefined, message: string) => errors.push({ line: row.line, ...(column ? { column } : {}), message });
    const earlier = row.barcode ? fileCodes.get(row.barcode) : fileNames.get(n);
    if (earlier !== undefined) {
      fail(row.barcode ? "barcode" : "name", row.barcode ? `Line ${earlier} has the same barcode` : `Line ${earlier} has the same name, and neither has a barcode`);
      continue;
    }
    if (row.barcode) fileCodes.set(row.barcode, row.line);
    else fileNames.set(n, row.line);

    let candidates: Item[];
    if (row.barcode) {
      candidates = byCode.get(row.barcode) ?? [];
      // No item has this barcode: an item with the same name and no barcode is this one, and gets the barcode
      if (!candidates.length) candidates = (byName.get(n) ?? []).filter((p) => !codeOf(p));
    } else {
      candidates = byName.get(n) ?? [];
    }
    if (candidates.length > 1) {
      fail(row.barcode && codeOf(candidates[0] as Item) ? "barcode" : "name",
        `${candidates.length} items in inventory match this row; delete or rename the extra ones first`);
      continue;
    }
    const match = candidates[0];
    let key: string;
    if (match) {
      key = String(match.key);
      const other = fileKeys.get(key);
      if (other !== undefined) {
        fail(undefined, `Line ${other} already updates the same item`);
        continue;
      }
    } else {
      const base = row.barcode ? keyOfBarcode(row.barcode) : `nb-${createHash("sha256").update(n, "utf8").digest("hex").slice(0, 16)}`;
      key = base;
      for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
      taken.add(key);
    }
    fileKeys.set(key, row.line);
    const { changes } = applyRow(match ? documentData(match) : undefined, row);
    planned.push({ ...row, key, action: match ? (changes.length ? "update" : "unchanged") : "create", changes });
  }
  return { planned, errors };
}

function summaryOf(planned: PlannedRow[]): ImportSummary {
  const count = (a: ImportAction) => planned.filter((r) => r.action === a).length;
  return { rows: planned.length, created: count("create"), updated: count("update"), unchanged: count("unchanged") };
}

async function getItem(db: Db, key: Item): Promise<Item | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: key, ConsistentRead: true }));
  return Item;
}

function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
}

const RETRYABLE = new Set([undefined, "None", "ConditionalCheckFailed", "TransactionConflict"]);

function itemTooLarge(error: unknown): boolean {
  const reasons = (error as { CancellationReasons?: { Code?: string; Message?: string }[] }).CancellationReasons ?? [];
  return reasons.some((r) => r.Code === "ValidationError" && /size/i.test(r.Message ?? ""));
}

function importId(value: unknown): string {
  const lower = typeof value === "string" ? value.toLowerCase() : "";
  if (!IMPORT_ID.test(lower)) throw new InvalidInputError("importId must be a UUID");
  return lower;
}

function staged(row: PlannedRow): StagedRow {
  const { line, key, name, barcode, price, cost, stock, packSize } = row;
  return { line, key, name, barcode, price, ...(cost === undefined ? {} : { cost }), ...(stock === undefined ? {} : { stock }), ...(packSize === undefined ? {} : { packSize }) };
}

/**
 * One row's writes in a commit transaction, from the item as it is now: the
 * product put (conditional on nobody having changed it since this read) and,
 * if stock changes, a movement. Nothing when the row changes nothing.
 */
function rowWrites(db: Db, ctx: TeamContext, id: string, row: StagedRow, item: Item | undefined, at: string): TransactItem[] {
  const current = item ? documentData(item) : undefined;
  const { data, changes } = applyRow(current, row);
  if (item && !changes.length) return [];
  data.updatedAt = at;
  const version = item ? (typeof item.version === "number" ? item.version : 1) + 1 : 1;
  const names: Record<string, string> = {};
  const values: Item = {};
  const unchanged = (field: string) => {
    names[`#${field}`] = field;
    if (item?.[field] === undefined) return `attribute_not_exists(#${field})`;
    values[`:${field}`] = item[field];
    return `#${field} = :${field}`;
  };
  const condition = item ? [unchanged("version"), unchanged("stock")].join(" AND ") : "attribute_not_exists(PK)";
  const writes: TransactItem[] = [
    {
      Put: {
        TableName: db.tableName,
        Item: storable({ ...data, ...keys.product(ctx.teamId, row.key), type: "product", key: row.key, version }),
        ConditionExpression: condition,
        ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
        ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
      },
    },
  ];
  if (changes.includes("stock")) {
    const before = typeof current?.stock === "number" ? current.stock : 0;
    const movement: Omit<Movement, "type"> = {
      productKey: row.key,
      reason: "import",
      delta: (row.stock as number) - before,
      tracked: true,
      count: row.stock,
      operationId: id,
      userId: ctx.userId,
      at,
    };
    writes.push({
      Put: {
        TableName: db.tableName,
        Item: { ...keys.movement(ctx.teamId, row.key, at, id), type: "movement", ...movement },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
  }
  return writes;
}

function imported(job: Item, replayed: boolean): ImportOutcome {
  return { status: "imported", importId: String(job.importId), replayed, summary: job.summary as ImportSummary };
}

/** Commits the job's chunks from the first one not yet committed. */
async function commit(db: Db, ctx: TeamContext, id: string, first: Item, now: Date): Promise<ImportOutcome> {
  const jobKey = keys.importJob(ctx.teamId, id);
  let job = first;
  const replayed = job.status === "done";
  const at = now.toISOString();
  while (job.status !== "done") {
    const n = job.committed as number;
    const chunks = job.chunks as number;
    const chunk = await getItem(db, keys.importChunk(ctx.teamId, id, n));
    if (!chunk || !Array.isArray(chunk.rows)) throw new ConflictError("This import expired before it finished; import the file again with a new importId");
    const rows = chunk.rows as StagedRow[];
    const last = n + 1 === chunks;
    for (let attempt = 1; ; attempt++) {
      const items = await Promise.all(rows.map((r) => getItem(db, keys.product(ctx.teamId, r.key))));
      const writes = rows.flatMap((r, i) => rowWrites(db, ctx, id, r, items[i], at));
      writes.push({
        Update: {
          TableName: db.tableName,
          Key: jobKey,
          UpdateExpression: last ? "SET #committed = :next, #status = :done, finishedAt = :at" : "SET #committed = :next",
          ConditionExpression: "#committed = :n AND #status = :committing",
          ExpressionAttributeNames: { "#committed": "committed", "#status": "status" },
          ExpressionAttributeValues: { ":next": n + 1, ":n": n, ":committing": "committing", ...(last ? { ":done": "done", ":at": at } : {}) },
        },
      });
      try {
        await connection(db).doc.send(new TransactWriteCommand({ TransactItems: writes }));
        job = { ...job, committed: n + 1, status: last ? "done" : job.status };
        break;
      } catch (error) {
        const codes = cancellationCodes(error);
        if (codes && itemTooLarge(error)) throw new TooLargeError(`An item on line ${rows[0]?.line ?? 0} or after is too large to save`);
        if (!codes || !codes.every((c) => RETRYABLE.has(c))) throw error;
        // The job moved on: a concurrent retry of this import committed this chunk
        if (codes[writes.length - 1] === "ConditionalCheckFailed") {
          job = (await getItem(db, jobKey)) as Item;
          break;
        }
        if (attempt >= MAX_ATTEMPTS) throw new ConflictError("Items kept changing during the import; try again to finish it");
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.floor(Math.random() * 20 * attempt)));
      }
    }
  }
  return imported(job, replayed);
}

/**
 * Imports a CSV of items into the team's inventory, all or nothing (see the
 * top of this file). With `dryRun`, returns the preview and writes nothing.
 * A file with bad rows comes back as `invalid`, with every problem, and
 * nothing written.
 */
export async function importProducts(db: Db, ctx: TeamContext, input: ImportInput, now = new Date()): Promise<ImportOutcome> {
  writable(db, ctx, "owner");
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new InvalidInputError("dryRun must be true or false");
  const dryRun = input.dryRun === true;
  const id = dryRun && input.importId === undefined ? undefined : importId(input.importId);
  if (typeof input.csv !== "string") throw new InvalidInputError("csv must be the file's text");
  const request = createHash("sha256").update(JSON.stringify({ userId: ctx.userId, csv: input.csv }), "utf8").digest("hex");

  const jobKey = id === undefined ? undefined : keys.importJob(ctx.teamId, id);
  const checkJob = (job: Item) => {
    if (job.request !== request) throw new InvalidInputError("This importId was already used for a different file; use a new one");
    return job;
  };
  if (!dryRun && jobKey) {
    const job = await getItem(db, jobKey);
    if (job) return commit(db, ctx, id as string, checkJob(job), now);
  }

  const parsed = parseInventoryCsv(input.csv);
  const products = await queryAll<Item>(db, teamPartition(ctx.teamId), prefixes.product);
  const { planned, errors: clashes } = planImport(parsed.rows, products);
  const errors = [...parsed.errors, ...clashes].sort((a, b) => a.line - b.line);
  const summary = summaryOf(planned);
  if (dryRun || errors.length) {
    return {
      status: errors.length ? "invalid" : "preview",
      rows: planned,
      errors: errors.slice(0, MAX_ERRORS),
      errorCount: errors.length,
      ignoredColumns: parsed.ignoredColumns,
      summary,
    };
  }

  // Stage the job and its whole plan in one transaction
  const epoch = Math.floor(now.getTime() / 1000);
  const expiresAt = epoch + OPERATION_TTL_DAYS * 24 * 60 * 60;
  const chunks: StagedRow[][] = [];
  for (let i = 0; i < planned.length; i += ROWS_PER_CHUNK) chunks.push(planned.slice(i, i + ROWS_PER_CHUNK).map(staged));
  const job: Item = {
    ...(jobKey as Item),
    type: "import",
    importId: id,
    request,
    status: "committing",
    chunks: chunks.length,
    committed: 0,
    summary,
    userId: ctx.userId,
    createdAt: now.toISOString(),
    expiresAt,
  };
  try {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: db.tableName, Item: job, ConditionExpression: "attribute_not_exists(PK)" } },
          ...chunks.map((rows, n) => ({
            Put: {
              TableName: db.tableName,
              Item: storable({ ...keys.importChunk(ctx.teamId, id as string, n), type: "importChunk", importId: id, chunk: n, rows, expiresAt }),
              ConditionExpression: "attribute_not_exists(PK)",
            },
          })),
        ],
      }),
    );
  } catch (error) {
    const codes = cancellationCodes(error);
    if (!codes || !codes.every((c) => RETRYABLE.has(c))) throw error;
    // A concurrent request with this importId staged first: carry on with its plan
    const existing = await getItem(db, jobKey as Item);
    if (!existing) throw new ConflictError("Couldn't start the import; try again");
    return commit(db, ctx, id as string, checkJob(existing), now);
  }
  return commit(db, ctx, id as string, job, now);
}
