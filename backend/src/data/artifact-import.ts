// One-time import of a claude.ai artifact's data into a team
// (supply-checkout-ig9, ADR 0004, ADR 0014): the artifact's "Everything
// (JSON)" export (allJson in src/export.js) goes into a team's products and
// sheets, with the same keys and IDs, so the team sees what the artifact showed.
//
// Run by the owner with scripts/import-artifact.ts (docs/backend.md,
// "Importing artifact data"), never by a Lambda: index.ts doesn't export it.
// It still acts through a TeamContext from authorizeTeam for a user who must
// be an owner of the team, and every read and write is in that team's
// partition.
//
// In three steps, each a function the CLI calls:
//
// 1. Read (parseArtifactExport). Checks the whole file before anything is
//    written: its shape, every field's type and size, and that each sheet's
//    lines add up to the totals the artifact exported with it (sheet-math.js's
//    rule: used x price each, in whole cents). Legacy values are mapped per
//    ADR 0014: money rounded to cents (as the artifact already rounds it for
//    display), a stock that isn't a number means the item doesn't track stock
//    (hasStock in src/format.js), `packSize` and `cost` are kept when valid.
//    Marks of recent saves (`ops`) and the claude.ai user IDs in `createdBy`
//    are dropped: the name the artifact showed (`preparedBy`) becomes the
//    sheet's `createdByName`, as for a sheet made without a signed-in user.
//    Unknown fields are left out, and named in the report.
// 2. Plan (planArtifactImport). Reads the team's products and sheets. A
//    document that's already there with the same content is skipped (so a
//    re-run, or a run after one that stopped part-way, only writes what's
//    missing). One that's there with other content, or a team item with the
//    same barcode under another key, is a conflict, and nothing is written
//    while there are any.
// 3. Apply (applyArtifactImport), unless it's a dry run: each missing
//    document, created only if its key is still free and the team is still
//    open (a condition check on its META item in the same transaction). A product that tracks
//    stock is written in one transaction with an `import` movement from 0 to
//    its count, so the stock history adds up. Ad hoc sheets (`adhoc-<n>`, ADR
//    0017) keep their `kind`, and the team's ADHOC item is then set from them:
//    its count to the highest number, and its pointer to the open one, so the
//    next quick take adds to it or starts the one after. Then it reads everything back
//    and checks every stock count and every sheet's totals against the file.
//
// Resumable and idempotent rather than all or nothing: every write is a
// create-if-absent of a whole document, so a run that stops (a throttle, an
// expired session) leaves only complete documents, and running it again
// finishes the rest. A second run over a finished import writes nothing.
//
// Reports hold counts, sums, indexes, product keys and sheet IDs: never
// names, clients or user IDs.

import { randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection, storable } from "./client.js";
import type { Movement } from "./commands.js";
import { MAX_DOCUMENT_BYTES } from "./documents.js";
import { ConflictError, InvalidInputError, TeamClosedError } from "./errors.js";
import { MAX_NAME_LENGTH, MAX_PACK_SIZE } from "./imports.js";
import { adhocCount, adhocOpen, adhocPut, readAdhoc } from "./adhoc.js";
import { MAX_CODE_LENGTH, adhocNumber, gsi1, isAdhocId, keys, prefixes, teamPartition } from "./keys.js";
import { MAX_MONEY, MAX_QUANTITY, roundCents } from "./money.js";
import { queryAll } from "./query.js";
import { type TeamContext, readable, writable } from "./team-context.js";

/** The largest export file, as UTF-8. A family business's years of sheets are a few MB. */
export const MAX_EXPORT_BYTES = 20_000_000;
/** The most products one import takes. */
export const MAX_EXPORT_PRODUCTS = 5000;
/** The most sheets one import takes. */
export const MAX_EXPORT_SHEETS = 5000;
/** Problems listed at most; the counts have the totals. */
export const MAX_ISSUES = 200;

const APP = "Supply Checkout";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_TIMESTAMP_LENGTH = 40;

type Item = Record<string, unknown>;

/** A product as it will be stored: the artifact's fields, mapped per ADR 0014. */
export interface ArtifactProduct {
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly cost?: number;
  readonly packSize?: number;
  /** Absent: the item doesn't track stock. */
  readonly stock?: number;
  readonly updatedAt?: string;
}

export interface ArtifactLine {
  readonly code?: string;
  readonly name: string;
  readonly price: number;
  readonly cost?: number;
  readonly out: number;
  readonly returned: number;
}

export interface ArtifactSheet {
  readonly id: string;
  /** The team's ad hoc sheet (ADR 0017), `adhoc-<n>`. Absent for a client's sheet. */
  readonly kind?: "adhoc";
  readonly client: string;
  readonly date: string;
  readonly status: "open" | "closed";
  readonly createdAt?: string;
  readonly closedAt?: string;
  readonly createdByName?: string;
  readonly source?: { readonly store: string; readonly receiptDate: string };
  readonly items: Record<string, ArtifactLine>;
}

/** A sheet's totals, as the app shows them: counts, and the charge in whole cents. */
export interface SheetTotals {
  readonly taken: number;
  readonly returned: number;
  readonly used: number;
  readonly chargeCents: number;
}

/** A problem with one document or field. `at` names it by position, key or ID, never by its contents. */
export interface ImportIssue {
  readonly at: string;
  readonly message: string;
}

export interface ParsedExport {
  readonly exportedAt?: string;
  readonly products: ArtifactProduct[];
  readonly sheets: ArtifactSheet[];
  /** Each sheet's totals, from its lines: equal to the exported totals where the file has them. */
  readonly totals: Map<string, SheetTotals>;
  readonly errors: ImportIssue[];
  /** Field names left out, with how many documents had each. */
  readonly ignoredFields: Record<string, number>;
  /** Sheets whose claude.ai user ID was dropped (the name the artifact showed is kept). */
  readonly droppedCreatedBy: number;
  /** Sheets the file had no totals for, so only their lines could be checked. */
  readonly sheetsWithoutTotals: number;
}

const isMap = (v: unknown): v is Item => typeof v === "object" && v !== null && !Array.isArray(v);
/** A key or ID as a report shows it: quoted and escaped, and cut short. */
const shown = (s: string) => printable(JSON.stringify(s.length > 60 ? `${s.slice(0, 60)}…` : s));
/**
 * Text safe to print on a terminal: JSON.stringify escapes C0 controls, and
 * this escapes DEL and the C1 controls (U+0080–U+009F, which include CSI)
 * too, so a crafted export can't put escape sequences on the owner's screen.
 */
function printable(s: string): string {
  // eslint-disable-next-line no-control-regex -- escaping control characters is the point
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
/** Cent-safe cents of an amount (sheet-math.js's `cents`). */
const cents = (n: number) => Math.round(Number((n * 100).toPrecision(12)));

class FieldError extends Error {}

function text(value: unknown, field: string, max: number, fallback?: string): string {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new FieldError(`${field} is missing`);
  }
  if (typeof value !== "string") throw new FieldError(`${field} isn't text`);
  if (value.length > max) throw new FieldError(`${field} is longer than ${max} characters`);
  return value;
}

/** Money per ADR 0014: a number from 0 to MAX_MONEY, rounded to cents (legacy values may have more decimals). */
function amount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_MONEY) {
    throw new FieldError(`${field} must be an amount from 0 to ${MAX_MONEY}`);
  }
  return roundCents(value);
}

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new FieldError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  // Printable ASCII only: the report prints exportedAt
  if (typeof value !== "string" || value.length > MAX_TIMESTAMP_LENGTH || !/^[\x20-\x7e]+$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new FieldError(`${field} isn't a date and time`);
  }
  return value;
}

/** A product key or line key, as keys.productKey allows it. */
function docKey(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || CONTROL.test(value) || value === "__proto__") {
    throw new FieldError(`${field} isn't a valid item key`);
  }
  return value;
}

const PRODUCT_FIELDS = new Set(["key", "code", "name", "price", "cost", "packSize", "stock", "updatedAt", "ops"]);
const SHEET_FIELDS = new Set(["id", "kind", "client", "date", "status", "createdAt", "closedAt", "createdBy", "createdByName", "preparedBy", "source", "items", "totals", "ops", "savedReceipts"]);
const LINE_FIELDS = new Set(["code", "name", "price", "cost", "out", "returned", "ops"]);

function product(raw: unknown, ignored: (field: string) => void): ArtifactProduct {
  if (!isMap(raw)) throw new FieldError("isn't an object");
  for (const field of Object.keys(raw)) if (!PRODUCT_FIELDS.has(field)) ignored(`inventory.${field}`);
  const key = docKey(raw.key, "key");
  const cost = raw.cost === undefined || raw.cost === null ? undefined : amount(raw.cost, "cost");
  const packSize = raw.packSize === undefined || raw.packSize === null ? undefined : whole(raw.packSize, "packSize", 1, MAX_PACK_SIZE);
  // As the app reads it (hasStock): a stock that isn't a number is no count at all
  const stock = typeof raw.stock === "number" ? whole(raw.stock, "stock", 0, MAX_QUANTITY) : undefined;
  const updatedAt = timestamp(raw.updatedAt, "updatedAt");
  return {
    key,
    code: text(raw.code, "code", MAX_CODE_LENGTH, ""),
    name: text(raw.name, "name", MAX_NAME_LENGTH, ""),
    price: amount(raw.price, "price"),
    ...(cost === undefined ? {} : { cost }),
    ...(packSize === undefined ? {} : { packSize }),
    ...(stock === undefined ? {} : { stock }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function line(raw: unknown, ignored: (field: string) => void): ArtifactLine {
  if (!isMap(raw)) throw new FieldError("isn't an object");
  for (const field of Object.keys(raw)) if (!LINE_FIELDS.has(field)) ignored(`sheets.items.${field}`);
  const out = whole(raw.out ?? 0, "out", 0, MAX_QUANTITY);
  const returned = whole(raw.returned ?? 0, "returned", 0, MAX_QUANTITY);
  if (returned > out) throw new FieldError("returned is more than out");
  const cost = raw.cost === undefined || raw.cost === null ? undefined : amount(raw.cost, "cost");
  return {
    ...(raw.code === undefined || raw.code === null ? {} : { code: text(raw.code, "code", MAX_CODE_LENGTH) }),
    name: text(raw.name, "name", MAX_NAME_LENGTH, ""),
    price: amount(raw.price, "price"),
    ...(cost === undefined ? {} : { cost }),
    out,
    returned,
  };
}

/** A sheet's totals, as sheet-math.js adds them: row charges in whole cents. */
export function sheetTotals(items: Record<string, ArtifactLine>): SheetTotals {
  let taken = 0, returned = 0, used = 0, chargeCents = 0;
  for (const l of Object.values(items)) {
    const u = l.out - l.returned;
    taken += l.out;
    returned += l.returned;
    used += u;
    chargeCents += cents(u * l.price);
  }
  return { taken, returned, used, chargeCents };
}

function exportedTotals(raw: unknown): SheetTotals | undefined {
  if (raw === undefined) return undefined;
  if (!isMap(raw)) throw new FieldError("totals isn't an object");
  const count = (v: unknown, field: string) => whole(v, `totals.${field}`, 0, Number.MAX_SAFE_INTEGER);
  if (typeof raw.charge !== "number" || !Number.isFinite(raw.charge) || raw.charge < 0) throw new FieldError("totals.charge isn't an amount");
  return { taken: count(raw.taken, "taken"), returned: count(raw.returned, "returned"), used: count(raw.used, "used"), chargeCents: cents(raw.charge) };
}

const sameTotals = (a: SheetTotals, b: SheetTotals) => a.taken === b.taken && a.returned === b.returned && a.used === b.used && a.chargeCents === b.chargeCents;
const totalsText = (t: SheetTotals) => `taken ${t.taken}, returned ${t.returned}, used ${t.used}, charge ${(t.chargeCents / 100).toFixed(2)}`;

function sheet(raw: unknown, ignored: (field: string) => void, lineErrors: ImportIssue[], at: string): { sheet: ArtifactSheet; exported?: SheetTotals; droppedCreatedBy: boolean } {
  if (!isMap(raw)) throw new FieldError("isn't an object");
  for (const field of Object.keys(raw)) if (!SHEET_FIELDS.has(field)) ignored(`sheets.${field}`);
  if (typeof raw.id !== "string" || !ID.test(raw.id)) throw new FieldError("id isn't a valid sheet ID");
  const date = text(raw.date, "date", 10);
  if (!DATE.test(date)) throw new FieldError("date isn't YYYY-MM-DD");
  const adhoc = raw.kind !== undefined && raw.kind !== null;
  if (adhoc && (raw.kind !== "adhoc" || adhocNumber(raw.id) === undefined)) throw new FieldError('kind must be "adhoc", on a sheet whose id is adhoc-<n>');
  // adhoc- IDs are the ad hoc sheets' (only the quick take makes one in a team)
  if (!adhoc && isAdhocId(raw.id)) throw new FieldError('an id starting "adhoc-" is an ad hoc sheet\'s, which needs kind "adhoc"');
  let status: "open" | "closed" = "open";
  if (raw.status !== undefined && raw.status !== null) {
    if (raw.status !== "open" && raw.status !== "closed") throw new FieldError('status must be "open" or "closed"');
    status = raw.status;
  }
  let source: ArtifactSheet["source"];
  if (raw.source !== undefined && raw.source !== null) {
    if (!isMap(raw.source)) throw new FieldError("source isn't an object");
    source = { store: text(raw.source.store, "source.store", MAX_NAME_LENGTH, ""), receiptDate: text(raw.source.receiptDate, "source.receiptDate", MAX_NAME_LENGTH, "") };
  }
  // The name the artifact showed, which the export resolved (preparedBy: the claude.ai
  // profile's name, or the sheet's own createdByName), else the sheet's createdByName
  const nameField = raw.preparedBy !== undefined && raw.preparedBy !== null ? "preparedBy" : "createdByName";
  const createdByName = raw[nameField] === undefined || raw[nameField] === null ? undefined : text(raw[nameField], nameField, MAX_NAME_LENGTH);
  const createdAt = timestamp(raw.createdAt, "createdAt");
  const closedAt = timestamp(raw.closedAt, "closedAt");
  if (raw.items !== undefined && raw.items !== null && !isMap(raw.items)) throw new FieldError("items isn't an object");
  const items: Record<string, ArtifactLine> = {};
  let bad = false;
  for (const [k, v] of Object.entries((raw.items ?? {}) as Item)) {
    try {
      items[docKey(k, "item key")] = line(v, ignored);
    } catch (error) {
      if (!(error instanceof FieldError)) throw error;
      bad = true;
      lineErrors.push({ at: `${at}.items[${shown(k)}]`, message: error.message });
    }
  }
  const exported = exportedTotals(raw.totals);
  const out: ArtifactSheet = {
    id: raw.id,
    ...(adhoc ? { kind: "adhoc" as const } : {}),
    client: text(raw.client, "client", MAX_NAME_LENGTH, ""),
    date,
    status,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(createdByName === undefined ? {} : { createdByName }),
    ...(source === undefined ? {} : { source }),
    items,
  };
  if (bad) throw new FieldError("has lines with problems (listed separately)");
  return { sheet: out, ...(exported ? { exported } : {}), droppedCreatedBy: typeof raw.createdBy === "string" && raw.createdBy !== "" };
}

/**
 * Reads and checks an export (the file's text). A file that isn't an export
 * at all (not JSON, too big, the wrong shape, too many documents) is an
 * InvalidInputError; problems with documents come back as `errors`, every one.
 */
export function parseArtifactExport(json: unknown): ParsedExport {
  if (typeof json !== "string") throw new InvalidInputError("The export must be the file's text");
  if (Buffer.byteLength(json, "utf8") > MAX_EXPORT_BYTES) throw new InvalidInputError(`The file is larger than ${MAX_EXPORT_BYTES / 1_000_000} MB`);
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new InvalidInputError("The file isn't JSON. Use the artifact's Export, Everything (JSON)");
  }
  if (!isMap(doc) || doc.app !== APP || !Array.isArray(doc.inventory) || !Array.isArray(doc.sheets)) {
    throw new InvalidInputError("The file isn't a Supply Checkout export. Use the artifact's Export, Everything (JSON)");
  }
  if (doc.inventory.length > MAX_EXPORT_PRODUCTS) throw new InvalidInputError(`The export has more than ${MAX_EXPORT_PRODUCTS} items`);
  if (doc.sheets.length > MAX_EXPORT_SHEETS) throw new InvalidInputError(`The export has more than ${MAX_EXPORT_SHEETS} sheets`);
  let exportedAt: string | undefined;
  try {
    exportedAt = timestamp(doc.exportedAt, "exportedAt");
  } catch {
    throw new InvalidInputError("The export's exportedAt isn't a date and time");
  }

  const errors: ImportIssue[] = [];
  const ignoredFields: Record<string, number> = {};
  const ignored = (field: string) => {
    // Field names come from the file: quoted and escaped, as reports print them
    const name = shown(field.slice(0, 80));
    ignoredFields[name] = (ignoredFields[name] ?? 0) + 1;
  };
  // Only a sheet can pass the document size limit: a product's fields are all bounded
  const tooLarge = (data: Item) => Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_DOCUMENT_BYTES - 100;

  const products: ArtifactProduct[] = [];
  const productKeys = new Map<string, number>();
  const productCodes = new Map<string, number>();
  doc.inventory.forEach((raw, i) => {
    const at = `inventory[${i}]${isMap(raw) && typeof raw.key === "string" ? ` key ${shown(raw.key)}` : ""}`;
    try {
      const p = product(raw, ignored);
      const earlier = productKeys.get(p.key);
      if (earlier !== undefined) throw new FieldError(`has the same key as inventory[${earlier}]`);
      // As the CSV import refuses them: two items with one barcode would make a scan ambiguous
      const code = p.code.trim();
      const sameCode = code ? productCodes.get(code) : undefined;
      if (sameCode !== undefined) throw new FieldError(`has the same barcode as inventory[${sameCode}]`);
      if (code) productCodes.set(code, i);
      productKeys.set(p.key, i);
      products.push(p);
    } catch (error) {
      if (!(error instanceof FieldError)) throw error;
      errors.push({ at, message: error.message });
    }
  });

  const sheets: ArtifactSheet[] = [];
  const totals = new Map<string, SheetTotals>();
  const sheetIds = new Map<string, number>();
  let droppedCreatedBy = 0;
  let sheetsWithoutTotals = 0;
  doc.sheets.forEach((raw, i) => {
    const at = `sheets[${i}]${isMap(raw) && typeof raw.id === "string" ? ` id ${shown(raw.id)}` : ""}`;
    try {
      const read = sheet(raw, ignored, errors, at);
      const s = read.sheet;
      const earlier = sheetIds.get(s.id);
      if (earlier !== undefined) throw new FieldError(`has the same id as sheets[${earlier}]`);
      if (tooLarge({ ...s })) throw new FieldError("is too large to save");
      const computed = sheetTotals(s.items);
      // Before: the lines, as imported, add up to what the artifact showed
      if (read.exported && !sameTotals(read.exported, computed)) {
        throw new FieldError(`its lines add up to ${totalsText(computed)}, not the exported ${totalsText(read.exported)}`);
      }
      if (!read.exported) sheetsWithoutTotals++;
      if (read.droppedCreatedBy) droppedCreatedBy++;
      sheetIds.set(s.id, i);
      totals.set(s.id, computed);
      sheets.push(s);
    } catch (error) {
      if (!(error instanceof FieldError)) throw error;
      errors.push({ at, message: error.message });
    }
  });
  // A team has at most one open ad hoc sheet (ADR 0017, section 4)
  const openAdhoc = sheets.filter((s) => s.kind === "adhoc" && s.status !== "closed");
  for (const s of openAdhoc.slice(1)) errors.push({ at: `sheet id ${shown(s.id)}`, message: `is a second open ad hoc sheet (${shown(openAdhoc[0]?.id ?? "")} is open too); finish all but one first` });
  return { ...(exportedAt === undefined ? {} : { exportedAt }), products, sheets, totals, errors, ignoredFields, droppedCreatedBy, sheetsWithoutTotals };
}

/** JSON with object keys sorted, so two documents compare by content. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (isMap(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

/** The fields an import compares: the product's data without when it was saved. */
function productContent(p: Item): Item {
  const pick: Item = {};
  for (const field of ["code", "name", "price", "cost", "packSize"]) if (p[field] !== undefined) pick[field] = p[field];
  if (typeof p.stock === "number") pick.stock = p.stock;
  if (pick.code === undefined) pick.code = "";
  return pick;
}

function sheetContent(s: Item): Item {
  const pick: Item = {};
  for (const field of ["kind", "client", "date", "status", "createdAt", "closedAt", "createdByName", "source", "items"]) if (s[field] !== undefined) pick[field] = s[field];
  return pick;
}

export interface ImportPlan {
  readonly products: ArtifactProduct[];
  readonly sheets: ArtifactSheet[];
  /** Products and sheets already in the team with the same content: skipped. */
  readonly productsPresent: number;
  readonly sheetsPresent: number;
  /** Nothing is written while there are any. */
  readonly conflicts: ImportIssue[];
}

/** Matches the export against the team's products and sheets (see the top of this file). */
export async function planArtifactImport(db: Db, ctx: TeamContext, parsed: ParsedExport): Promise<ImportPlan> {
  writable(db, ctx, "owner");
  const [existingProducts, existingSheets] = await Promise.all([
    queryAll<Item>(db, teamPartition(ctx.teamId), prefixes.product),
    queryAll<Item>(db, teamPartition(ctx.teamId), prefixes.sheet),
  ]);
  const productsByKey = new Map(existingProducts.map((p) => [String(p.key), p]));
  const keysByCode = new Map<string, string[]>();
  for (const p of existingProducts) {
    const code = typeof p.code === "string" ? p.code.trim() : "";
    if (code) keysByCode.set(code, [...(keysByCode.get(code) ?? []), String(p.key)]);
  }
  const sheetsById = new Map(existingSheets.map((s) => [String(s.id), s]));
  const importedKeys = new Set(parsed.products.map((p) => p.key));

  const conflicts: ImportIssue[] = [];
  const products: ArtifactProduct[] = [];
  let productsPresent = 0;
  for (const p of parsed.products) {
    const at = `item key ${shown(p.key)}`;
    const existing = productsByKey.get(p.key);
    if (existing) {
      if (canonical(productContent(existing)) === canonical(productContent({ ...p }))) productsPresent++;
      else conflicts.push({ at, message: "the team already has an item with this key, with other values" });
      continue;
    }
    const code = p.code.trim();
    const others = code ? (keysByCode.get(code) ?? []).filter((k) => !importedKeys.has(k)) : [];
    if (others.length) {
      conflicts.push({ at, message: `the team already has an item with this barcode, under key ${shown(others[0] as string)}` });
      continue;
    }
    products.push(p);
  }
  // An open ad hoc sheet already in the team, other than one the file has: the file's open one would be a second
  const openHere = existingSheets.find((s) => s.kind === "adhoc" && s.status !== "closed" && !parsed.sheets.some((p) => p.id === s.id));
  const openThere = parsed.sheets.find((s) => s.kind === "adhoc" && s.status !== "closed");
  if (openHere && openThere) conflicts.push({ at: `sheet id ${shown(openThere.id)}`, message: `the team already has an open ad hoc sheet, ${shown(String(openHere.id))}; finish one of them first` });
  const sheets: ArtifactSheet[] = [];
  let sheetsPresent = 0;
  for (const s of parsed.sheets) {
    const existing = sheetsById.get(s.id);
    if (existing) {
      if (canonical(sheetContent(existing)) === canonical(sheetContent({ ...s }))) sheetsPresent++;
      else conflicts.push({ at: `sheet id ${shown(s.id)}`, message: "the team already has a sheet with this ID, with other content" });
      continue;
    }
    sheets.push(s);
  }
  return { products, sheets, productsPresent, sheetsPresent, conflicts };
}

export interface ApplyResult {
  readonly productsCreated: number;
  readonly sheetsCreated: number;
  /** Stock movements recorded (one per created product that tracks stock). */
  readonly movements: number;
  /** Documents someone else created with the same content between the plan and the write. */
  readonly alreadyThere: number;
  /** The run's operation ID, on every movement it recorded. */
  readonly operationId: string;
  /** The open ad hoc sheet the team's ADHOC item names afterwards, if any. */
  readonly adhocOpen?: string;
}

/** The cancellation codes of a cancelled transaction, or undefined for any other error. */
function cancellationCodes(error: unknown): (string | undefined)[] | undefined {
  if ((error as { name?: string } | null)?.name !== "TransactionCanceledException") return undefined;
  return ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code);
}

const TEAM_CLOSED = "The team was closed while importing. Documents already written stay; nothing more was written.";

/**
 * Runs one document's writes with a check that the team still exists and is
 * open, so a team closed part-way through isn't written to. Returns false
 * when the document's key was taken (its create condition failed).
 */
async function createWithTeamOpen(db: Db, ctx: TeamContext, writes: Item[]): Promise<boolean> {
  const teamOpen = { ConditionCheck: { TableName: db.tableName, Key: keys.team(ctx.teamId), ConditionExpression: "attribute_exists(PK) AND attribute_not_exists(closedAt)" } };
  try {
    await connection(db).doc.send(new TransactWriteCommand({ TransactItems: [...writes, teamOpen] }));
    return true;
  } catch (error) {
    const codes = cancellationCodes(error);
    if (!codes) throw error;
    if (codes[writes.length] === "ConditionalCheckFailed") throw new TeamClosedError(TEAM_CLOSED);
    if (codes[0] === "ConditionalCheckFailed") return false;
    throw error;
  }
}

async function readItem(db: Db, key: Item): Promise<Item | undefined> {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: key, ConsistentRead: true }));
  return Item;
}

/**
 * Writes the plan's documents, each only if its key is still free. A key
 * that someone took after the plan is fine if the item there has the same
 * content (another run of this import), and a ConflictError otherwise:
 * documents already written stay, and a dry run then shows the conflict.
 */
export async function applyArtifactImport(db: Db, ctx: TeamContext, plan: ImportPlan, now = new Date()): Promise<ApplyResult> {
  writable(db, ctx, "owner");
  if (plan.conflicts.length) throw new ConflictError("The import has conflicts; nothing was written");
  const operationId = randomUUID();
  const at = now.toISOString();
  let productsCreated = 0, sheetsCreated = 0, movements = 0, alreadyThere = 0;
  for (const p of plan.products) {
    const key = keys.product(ctx.teamId, p.key);
    const { updatedAt, ...fields } = p;
    const writes: Item[] = [
      {
        Put: {
          TableName: db.tableName,
          Item: { ...fields, ...key, type: "product", key: p.key, updatedAt: updatedAt ?? at, version: 1 },
          ConditionExpression: "attribute_not_exists(PK)",
        },
      },
    ];
    if (p.stock !== undefined) {
      const movement: Omit<Movement, "type"> = { productKey: p.key, reason: "import", delta: p.stock, tracked: true, count: p.stock, operationId, userId: ctx.userId, at };
      writes.push({ Put: { TableName: db.tableName, Item: { ...keys.movement(ctx.teamId, p.key, at, operationId), type: "movement", ...movement }, ConditionExpression: "attribute_not_exists(PK)" } });
    }
    if (await createWithTeamOpen(db, ctx, writes)) {
      productsCreated++;
      if (p.stock !== undefined) movements++;
    } else {
      const there = await readItem(db, key);
      if (!there || canonical(productContent(there)) !== canonical(productContent({ ...p }))) {
        throw new ConflictError(`Item key ${shown(p.key)} was added with other values while importing. Run the import again as a dry run to see what's left.`);
      }
      alreadyThere++;
    }
  }
  for (const s of plan.sheets) {
    const key = keys.sheet(ctx.teamId, s.id);
    const put = {
      Put: {
        TableName: db.tableName,
        Item: storable({ ...s, ...key, ...gsi1.sheetsByDate(ctx.teamId, s.date, s.id), type: "sheet", id: s.id, version: 1 }),
        ConditionExpression: "attribute_not_exists(PK)",
      },
    };
    if (await createWithTeamOpen(db, ctx, [put])) sheetsCreated++;
    else {
      const there = await readItem(db, key);
      if (!there || canonical(sheetContent(there)) !== canonical(sheetContent({ ...s }))) {
        throw new ConflictError(`Sheet id ${shown(s.id)} was added with other content while importing. Run the import again as a dry run to see what's left.`);
      }
      alreadyThere++;
    }
  }
  const open = await pointAdhoc(db, ctx, at);
  return { productsCreated, sheetsCreated, movements, alreadyThere, operationId, ...(open === undefined ? {} : { adhocOpen: open }) };
}

/**
 * Sets the team's ADHOC item (adhoc.ts) from its ad hoc sheets after an
 * import: the count to at least the highest `adhoc-<n>`, and the pointer, if
 * it doesn't already name an open ad hoc sheet, to the highest-numbered open
 * one. Written only when that changes it, on the condition that it's as read
 * (a conflict means someone took meanwhile; run the import again).
 */
async function pointAdhoc(db: Db, ctx: TeamContext, at: string): Promise<string | undefined> {
  const [pointer, sheets] = await Promise.all([readAdhoc(db, ctx.teamId), queryAll<Item>(db, teamPartition(ctx.teamId), prefixes.sheet)]);
  const adhoc = sheets
    .filter((s) => s.kind === "adhoc")
    .map((s) => ({ id: String(s.id), n: adhocNumber(String(s.id)) ?? 0, open: s.status !== "closed" }))
    .sort((a, b) => b.n - a.n);
  if (!adhoc.length) return adhocOpen(pointer);
  const named = adhocOpen(pointer);
  const opens = adhoc.filter((s) => s.open);
  // Never leave two open (the plan refuses that; this catches a quick take made meanwhile)
  if (opens.length > 1) throw new ConflictError(`The team has more than one open ad hoc sheet (${opens.map((s) => shown(s.id)).join(", ")}); finish all but one, then run the import again`);
  const open = opens[0]?.id;
  const count = Math.max(adhocCount(pointer), adhoc[0]?.n ?? 0);
  if (pointer && count === adhocCount(pointer) && open === named) return open;
  try {
    await connection(db).doc.send(new TransactWriteCommand({ TransactItems: [adhocPut(db, ctx.teamId, pointer, { open, count }, at)] }));
  } catch (error) {
    if (cancellationCodes(error)) throw new ConflictError("The team's ad hoc sheet changed while importing. Run the import again to finish.");
    throw error;
  }
  return open;
}

export interface Verification {
  /** Imported products whose stock (a count, or not tracked) is as in the file. */
  readonly productsChecked: number;
  readonly sheetsChecked: number;
  /** The file's total eaches in storage, and the team's for the same items. */
  readonly stockBefore: number;
  readonly stockAfter: number;
  /** The file's sheet charges, in cents, and the team's for the same sheets. */
  readonly chargeBeforeCents: number;
  readonly chargeAfterCents: number;
  readonly mismatches: ImportIssue[];
}

/**
 * Reads the team's products and sheets back and checks that every imported
 * item's stock and every imported sheet's totals are what the export had.
 */
export async function verifyArtifactImport(db: Db, ctx: TeamContext, parsed: ParsedExport): Promise<Verification> {
  readable(ctx);
  const [products, sheets] = await Promise.all([
    queryAll<Item>(db, teamPartition(ctx.teamId), prefixes.product),
    queryAll<Item>(db, teamPartition(ctx.teamId), prefixes.sheet),
  ]);
  const productsByKey = new Map(products.map((p) => [String(p.key), p]));
  const sheetsById = new Map(sheets.map((s) => [String(s.id), s]));
  const mismatches: ImportIssue[] = [];
  let stockBefore = 0, stockAfter = 0, chargeBeforeCents = 0, chargeAfterCents = 0;
  for (const p of parsed.products) {
    const stored = productsByKey.get(p.key);
    const before = p.stock;
    const after = typeof stored?.stock === "number" ? stored.stock : undefined;
    stockBefore += before ?? 0;
    stockAfter += after ?? 0;
    if (!stored) mismatches.push({ at: `item key ${shown(p.key)}`, message: "isn't in the team" });
    else if (before !== after) mismatches.push({ at: `item key ${shown(p.key)}`, message: `stock is ${after ?? "not tracked"}, not ${before ?? "not tracked"}` });
  }
  for (const s of parsed.sheets) {
    const before = parsed.totals.get(s.id) as SheetTotals;
    chargeBeforeCents += before.chargeCents;
    const stored = sheetsById.get(s.id);
    if (!stored) {
      mismatches.push({ at: `sheet id ${shown(s.id)}`, message: "isn't in the team" });
      continue;
    }
    const lines = (isMap(stored.items) ? stored.items : {}) as Record<string, ArtifactLine>;
    const after = sheetTotals(lines);
    chargeAfterCents += after.chargeCents;
    if (!sameTotals(before, after)) mismatches.push({ at: `sheet id ${shown(s.id)}`, message: `totals are ${totalsText(after)}, not ${totalsText(before)}` });
  }
  return { productsChecked: parsed.products.length, sheetsChecked: parsed.sheets.length, stockBefore, stockAfter, chargeBeforeCents, chargeAfterCents, mismatches };
}
