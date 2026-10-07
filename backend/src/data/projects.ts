// Projects, called checkout sheets before supply-checkout-005.6 (ADR 0005). One
// item holds a whole project, with its lines in an `items` map keyed by
// product. A new one is written under `PROJECT#<id>`; through the rename's
// window an old one can still be under `SHEET#<id>`, and is read, changed and
// deleted where it is (project-items.ts).
//
// Deviation from ADR 0005: the sort key is `PROJECT#<projectId>` (ADR 0005's
// `SHEET#<sheetId>`), not `<prefix><date>#<id>`. The date is editable, and a key can't change, so a date
// in the key would turn every date edit into a delete and re-put. Date order
// comes from GSI1 (`TEAM#<teamId>#PROJECTS`, `<date>#<id>`), whose keys are
// ordinary attributes that one update can change.

import { randomUUID } from "node:crypto";
import { DeleteCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection, storable } from "./client.js";
import { InvalidInputError, conflictOnConditionFailure } from "./errors.js";
import { barcode, date, id as checkId, keys, productKey, strip } from "./keys.js";
import { legacy } from "./legacy-sheets.js";
import { money } from "./money.js";
import { listProjectItems, projectAttributes, projectItemsByDatePage, projectKeyFor, readProjectItem } from "./project-items.js";
import { type Page, versionedSet } from "./query.js";
import { type TeamContext, readable, writable } from "./team-context.js";

/** One line of a project, as the app writes it: `{code, name, price, cost, out, returned}`. */
export interface ProjectLine {
  /** The item's barcode, empty for an item without one. The project CSV exports it as "Barcode". */
  readonly code?: string;
  readonly name: string;
  readonly price: number;
  /** What the business paid per each (ADR 0014), copied from the product or a receipt. Absent when unknown. */
  readonly cost?: number;
  readonly out: number;
  readonly returned: number;
}

export interface Project {
  /** "project" for one written since the rename; "sheet" for one the backfill hasn't moved yet. */
  readonly type: "project" | typeof legacy.sheetType;
  readonly id: string;
  readonly client: string;
  readonly date: string;
  readonly status: "open" | "closed";
  readonly createdBy: string;
  readonly createdAt: string;
  /** Who prepared the project, when the app has no signed-in user to put in `createdBy`. */
  readonly createdByName?: string;
  readonly closedAt?: string;
  /** The receipt a project was made from (receipt scanning). */
  readonly source?: ProjectSource;
  readonly items: Record<string, ProjectLine>;
  readonly version: number;
}

export interface ProjectSource {
  readonly store: string;
  readonly receiptDate: string;
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.length > 200) throw new InvalidInputError(`Invalid ${what}`);
  return value;
};

function source(value: ProjectSource): ProjectSource {
  if (typeof value !== "object" || value === null) throw new InvalidInputError("Invalid source");
  return { store: text(value.store, "store"), receiptDate: text(value.receiptDate, "receipt date") };
}

function client(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new InvalidInputError("Invalid client");
  return value.trim();
}

function line(value: ProjectLine): ProjectLine {
  const count = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;
  if (
    typeof value?.name !== "string" ||
    !count(value.out) || !count(value.returned) || value.returned > value.out
  ) {
    throw new InvalidInputError("Invalid project line");
  }
  return {
    ...(value.code === undefined ? {} : { code: barcode(value.code) }),
    name: value.name,
    price: money(value.price, "price"),
    ...(value.cost === undefined ? {} : { cost: money(value.cost, "cost") }),
    out: value.out,
    returned: value.returned,
  };
}

export async function createProject(
  db: Db,
  ctx: TeamContext,
  input: {
    readonly client: string;
    readonly date: string;
    readonly createdByName?: string;
    readonly source?: ProjectSource;
    readonly items?: Record<string, ProjectLine>;
  },
): Promise<Project> {
  writable(db, ctx);
  const items: Record<string, ProjectLine> = {};
  for (const [key, value] of Object.entries(input.items ?? {})) items[productKey(key)] = line(value);
  const project: Project = {
    type: "project",
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
      Item: storable({ ...project, ...projectAttributes(ctx.teamId, project.id, project.date, "project") }),
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return project;
}

/** Reads one project by ID, strongly consistent, from either of its keys. */
export async function getProject(db: Db, ctx: TeamContext, projectId: string): Promise<Project | undefined> {
  readable(ctx);
  return strip<Project>(await readProjectItem(db, ctx.teamId, projectId));
}

/** Every project in the team, strongly consistent, in no particular order (the app's initial load). */
export async function listProjects(db: Db, ctx: TeamContext): Promise<Project[]> {
  readable(ctx);
  return (await listProjectItems(db, ctx.teamId)).map((item) => strip<Project>(item) as Project);
}

/** The key a change to an existing project goes to: wherever it is now. */
async function existingKey(db: Db, ctx: TeamContext, projectId: string) {
  return projectKeyFor(ctx.teamId, checkId(projectId, "project ID"), await readProjectItem(db, ctx.teamId, projectId));
}

/**
 * Projects in date order, newest first by default, optionally within a date
 * range, a page at a time. Served by GSI1, so a change can take a moment to
 * appear (GSIs are eventually consistent); live updates cover that gap.
 */
export async function listProjectsByDate(
  db: Db,
  ctx: TeamContext,
  options: { readonly from?: string; readonly to?: string; readonly oldestFirst?: boolean; readonly limit?: number; readonly cursor?: string } = {},
): Promise<Page<Project>> {
  readable(ctx);
  const page = await projectItemsByDatePage(db, ctx.teamId, { from: options.from, to: options.to, forward: options.oldestFirst ?? false, limit: options.limit, cursor: options.cursor });
  return { items: page.items.map((item) => strip<Project>(item) as Project), ...(page.cursor ? { cursor: page.cursor } : {}) };
}

/**
 * Changes a project's client, date, status or preparer's name if nobody else has since
 * `expectedVersion`. A date change is one update: the key doesn't change, only
 * the index attribute does.
 */
export async function updateProject(
  db: Db,
  ctx: TeamContext,
  projectId: string,
  changes: { readonly client?: string; readonly date?: string; readonly status?: "open" | "closed"; readonly createdByName?: string },
  expectedVersion: number,
): Promise<Project> {
  writable(db, ctx);
  const fields: Record<string, unknown> = {};
  if (changes.client !== undefined) fields.client = client(changes.client);
  if (changes.date !== undefined) {
    fields.date = date(changes.date);
    fields.GSI1SK = projectAttributes(ctx.teamId, projectId, fields.date, "project").GSI1SK;
  }
  if (changes.createdByName !== undefined) fields.createdByName = text(changes.createdByName, "name");
  if (changes.status !== undefined) {
    if (changes.status !== "open" && changes.status !== "closed") throw new InvalidInputError("Invalid status");
    fields.status = changes.status;
    if (changes.status === "closed") fields.closedAt = new Date().toISOString();
  }
  const { Attributes } = await connection(db).doc
    .send(new UpdateCommand({ TableName: db.tableName, Key: await existingKey(db, ctx, projectId), ...versionedSet(fields, expectedVersion), ReturnValues: "ALL_NEW" }))
    .catch(conflictOnConditionFailure("This project changed; reload and try again"));
  return strip<Project>(Attributes) as Project;
}

/** Sets one line (checkout, return or edit) if the project is unchanged since `expectedVersion`. */
export async function setProjectLine(
  db: Db,
  ctx: TeamContext,
  projectId: string,
  key: string,
  value: ProjectLine,
  expectedVersion: number,
): Promise<Project> {
  writable(db, ctx);
  const update = versionedSet({}, expectedVersion);
  const { Attributes } = await connection(db).doc
    .send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: await existingKey(db, ctx, projectId),
        ...update,
        UpdateExpression: `${update.UpdateExpression}, #items.#line = :line`,
        ExpressionAttributeNames: { ...update.ExpressionAttributeNames, "#items": "items", "#line": productKey(key) },
        ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ":line": line(value) },
        ReturnValues: "ALL_NEW",
      }),
    )
    .catch(conflictOnConditionFailure("This project changed; reload and try again"));
  return strip<Project>(Attributes) as Project;
}

export async function removeProjectLine(db: Db, ctx: TeamContext, projectId: string, key: string, expectedVersion: number): Promise<Project> {
  writable(db, ctx);
  const update = versionedSet({}, expectedVersion);
  const { Attributes } = await connection(db).doc
    .send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: await existingKey(db, ctx, projectId),
        ...update,
        UpdateExpression: `${update.UpdateExpression} REMOVE #items.#line`,
        ExpressionAttributeNames: { ...update.ExpressionAttributeNames, "#items": "items", "#line": productKey(key) },
        ReturnValues: "ALL_NEW",
      }),
    )
    .catch(conflictOnConditionFailure("This project changed; reload and try again"));
  return strip<Project>(Attributes) as Project;
}

/**
 * Deletes a project. With `expectedVersion`, only the item as it is now (under
 * whichever key), if its version is still that one; without, it's gone from
 * both keys, as deleteDocument does (project-items.ts).
 */
export async function deleteProject(db: Db, ctx: TeamContext, projectId: string, expectedVersion?: number): Promise<void> {
  writable(db, ctx);
  const id = checkId(projectId, "project ID");
  if (expectedVersion === undefined) {
    await connection(db).doc.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: db.tableName, Key: keys.project(ctx.teamId, id) } },
          { Delete: { TableName: db.tableName, Key: legacy.sheetKey(ctx.teamId, id) } },
        ],
      }),
    );
    return;
  }
  await connection(db).doc
    .send(
      new DeleteCommand({
        TableName: db.tableName,
        Key: await existingKey(db, ctx, id),
        ConditionExpression: "#version = :expected",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":expected": expectedVersion },
      }),
    )
    .catch(conflictOnConditionFailure("This project changed; reload and try again"));
}
