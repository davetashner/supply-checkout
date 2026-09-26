// Checkout sheets (ADR 0005). One item holds a whole sheet, with its lines in
// an `items` map keyed by product, as in the artifact's `sheets` collection.
//
// Deviation from ADR 0005: the sort key is `SHEET#<sheetId>`, not
// `SHEET#<date>#<id>`. The date is editable, and a key can't change, so a date
// in the key would turn every date edit into a delete and re-put. Date order
// comes from GSI1 (`TEAM#<teamId>#SHEETS`, `<date>#<sheetId>`), whose keys are
// ordinary attributes that one update can change.

import { randomUUID } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection, storable } from "./client.js";
import { InvalidInputError, conflictOnConditionFailure } from "./errors.js";
import { barcode, date, gsi1, keys, prefixes, productKey, strip, teamPartition } from "./keys.js";
import { type Page, queryAll, queryPage, versionedSet } from "./query.js";
import { GSI1, GSI1PK } from "./schema.js";
import { type TeamContext, readable, writable } from "./team-context.js";

/** One line of a sheet, as the app writes it: `{code, name, price, out, returned}`. */
export interface SheetLine {
  /** The item's barcode, empty for an item without one. The sheet CSV exports it as "Barcode". */
  readonly code?: string;
  readonly name: string;
  readonly price: number;
  readonly out: number;
  readonly returned: number;
}

export interface Sheet {
  readonly type: "sheet";
  readonly id: string;
  readonly client: string;
  readonly date: string;
  readonly status: "open" | "closed";
  readonly createdBy: string;
  readonly createdAt: string;
  /** Who prepared the sheet, when the app has no signed-in user to put in `createdBy`. */
  readonly createdByName?: string;
  readonly closedAt?: string;
  /** The receipt a sheet was made from (receipt scanning). */
  readonly source?: SheetSource;
  readonly items: Record<string, SheetLine>;
  readonly version: number;
}

export interface SheetSource {
  readonly store: string;
  readonly receiptDate: string;
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.length > 200) throw new InvalidInputError(`Invalid ${what}`);
  return value;
};

function source(value: SheetSource): SheetSource {
  if (typeof value !== "object" || value === null) throw new InvalidInputError("Invalid source");
  return { store: text(value.store, "store"), receiptDate: text(value.receiptDate, "receipt date") };
}

function client(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new InvalidInputError("Invalid client");
  return value.trim();
}

function line(value: SheetLine): SheetLine {
  const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (
    typeof value?.name !== "string" ||
    typeof value.price !== "number" || !Number.isFinite(value.price) || value.price < 0 ||
    !count(value.out) || !count(value.returned) || value.returned > value.out
  ) {
    throw new InvalidInputError("Invalid sheet line");
  }
  return {
    ...(value.code === undefined ? {} : { code: barcode(value.code) }),
    name: value.name,
    price: value.price,
    out: value.out,
    returned: value.returned,
  };
}

export async function createSheet(
  db: Db,
  ctx: TeamContext,
  input: {
    readonly client: string;
    readonly date: string;
    readonly createdByName?: string;
    readonly source?: SheetSource;
    readonly items?: Record<string, SheetLine>;
  },
): Promise<Sheet> {
  writable(db, ctx);
  const items: Record<string, SheetLine> = {};
  for (const [key, value] of Object.entries(input.items ?? {})) items[productKey(key)] = line(value);
  const sheet: Sheet = {
    type: "sheet",
    id: randomUUID(),
    client: client(input.client),
    date: date(input.date),
    status: "open",
    createdBy: ctx.userId,
    createdAt: new Date().toISOString(),
    ...(input.createdByName === undefined ? {} : { createdByName: text(input.createdByName, "name") }),
    ...(input.source === undefined ? {} : { source: source(input.source) }),
    items,
    version: 1,
  };
  await connection(db).doc.send(
    new PutCommand({
      TableName: db.tableName,
      Item: storable({ ...keys.sheet(ctx.teamId, sheet.id), ...gsi1.sheetsByDate(ctx.teamId, sheet.date, sheet.id), ...sheet }),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return sheet;
}

/** Reads one sheet by ID, strongly consistent. */
export async function getSheet(db: Db, ctx: TeamContext, sheetId: string): Promise<Sheet | undefined> {
  readable(ctx);
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.sheet(ctx.teamId, sheetId), ConsistentRead: true }));
  return strip<Sheet>(Item);
}

/** Every sheet in the team, strongly consistent, in no particular order (the app's initial load). */
export async function listSheets(db: Db, ctx: TeamContext): Promise<Sheet[]> {
  readable(ctx);
  return queryAll<Sheet>(db, teamPartition(ctx.teamId), prefixes.sheet);
}

/**
 * Sheets in date order, newest first by default, optionally within a date
 * range, a page at a time. Served by GSI1, so a change can take a moment to
 * appear (GSIs are eventually consistent); live updates cover that gap.
 */
export async function listSheetsByDate(
  db: Db,
  ctx: TeamContext,
  options: { readonly from?: string; readonly to?: string; readonly oldestFirst?: boolean; readonly limit?: number; readonly cursor?: string } = {},
): Promise<Page<Sheet>> {
  readable(ctx);
  const pk = gsi1.sheetsPartition(ctx.teamId);
  const values: Record<string, unknown> = { ":pk": pk };
  let range = "";
  if (options.from !== undefined || options.to !== undefined) {
    // `<date>#<id>` sorts between `<from>#` and `<to>#~` for every ID
    values[":from"] = `${date(options.from ?? "0000-01-01")}#`;
    values[":to"] = `${date(options.to ?? "9999-12-31")}#~`;
    range = " AND GSI1SK BETWEEN :from AND :to";
  }
  return queryPage<Sheet>(
    db,
    {
      IndexName: GSI1,
      KeyConditionExpression: `GSI1PK = :pk${range}`,
      ExpressionAttributeValues: values,
      ScanIndexForward: options.oldestFirst ?? false,
      Limit: options.limit,
    },
    { attribute: GSI1PK, value: pk },
    options.cursor,
  );
}

/**
 * Changes a sheet's client, date, status or preparer's name if nobody else has since
 * `expectedVersion`. A date change is one update: the key doesn't change, only
 * the index attribute does.
 */
export async function updateSheet(
  db: Db,
  ctx: TeamContext,
  sheetId: string,
  changes: { readonly client?: string; readonly date?: string; readonly status?: "open" | "closed"; readonly createdByName?: string },
  expectedVersion: number,
): Promise<Sheet> {
  writable(db, ctx);
  const fields: Record<string, unknown> = {};
  if (changes.client !== undefined) fields.client = client(changes.client);
  if (changes.date !== undefined) {
    fields.date = date(changes.date);
    fields.GSI1SK = gsi1.sheetsByDate(ctx.teamId, changes.date, sheetId).GSI1SK;
  }
  if (changes.createdByName !== undefined) fields.createdByName = text(changes.createdByName, "name");
  if (changes.status !== undefined) {
    if (changes.status !== "open" && changes.status !== "closed") throw new InvalidInputError("Invalid status");
    fields.status = changes.status;
    if (changes.status === "closed") fields.closedAt = new Date().toISOString();
  }
  const { Attributes } = await connection(db).doc
    .send(new UpdateCommand({ TableName: db.tableName, Key: keys.sheet(ctx.teamId, sheetId), ...versionedSet(fields, expectedVersion), ReturnValues: "ALL_NEW" }))
    .catch(conflictOnConditionFailure("This sheet changed; reload and try again"));
  return strip<Sheet>(Attributes) as Sheet;
}

/** Sets one line (checkout, return or edit) if the sheet is unchanged since `expectedVersion`. */
export async function setSheetLine(
  db: Db,
  ctx: TeamContext,
  sheetId: string,
  key: string,
  value: SheetLine,
  expectedVersion: number,
): Promise<Sheet> {
  writable(db, ctx);
  const update = versionedSet({}, expectedVersion);
  const { Attributes } = await connection(db).doc
    .send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.sheet(ctx.teamId, sheetId),
        ...update,
        UpdateExpression: `${update.UpdateExpression}, #items.#line = :line`,
        ExpressionAttributeNames: { ...update.ExpressionAttributeNames, "#items": "items", "#line": productKey(key) },
        ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ":line": line(value) },
        ReturnValues: "ALL_NEW",
      }),
    )
    .catch(conflictOnConditionFailure("This sheet changed; reload and try again"));
  return strip<Sheet>(Attributes) as Sheet;
}

export async function removeSheetLine(db: Db, ctx: TeamContext, sheetId: string, key: string, expectedVersion: number): Promise<Sheet> {
  writable(db, ctx);
  const update = versionedSet({}, expectedVersion);
  const { Attributes } = await connection(db).doc
    .send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.sheet(ctx.teamId, sheetId),
        ...update,
        UpdateExpression: `${update.UpdateExpression} REMOVE #items.#line`,
        ExpressionAttributeNames: { ...update.ExpressionAttributeNames, "#items": "items", "#line": productKey(key) },
        ReturnValues: "ALL_NEW",
      }),
    )
    .catch(conflictOnConditionFailure("This sheet changed; reload and try again"));
  return strip<Sheet>(Attributes) as Sheet;
}

export async function deleteSheet(db: Db, ctx: TeamContext, sheetId: string, expectedVersion?: number): Promise<void> {
  writable(db, ctx);
  await connection(db).doc
    .send(
      new DeleteCommand({
        TableName: db.tableName,
        Key: keys.sheet(ctx.teamId, sheetId),
        ...(expectedVersion === undefined
          ? {}
          : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expectedVersion } }),
      }),
    )
    .catch(conflictOnConditionFailure("This sheet changed; reload and try again"));
}
