import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll } from "vitest";
import { createDb, type Db } from "../src/data/index.js";
import { createLocalTable, deleteLocalTable } from "../src/data/local-table.js";

/** DynamoDB Local, e.g. http://localhost:8000. CI runs it as a service container. */
export const endpoint = process.env.DYNAMODB_ENDPOINT || undefined;

/** A made-up region: nothing here may depend on a real region name (ADR 0010). */
export const REGION = "test-local-1";

/** A fresh table in DynamoDB Local for one test file, deleted afterwards. */
export function useTable(): { readonly db: Db } {
  const holder = {} as { db: Db };
  beforeAll(async () => {
    holder.db = createDb({ endpoint, region: REGION, tableName: `test-${randomUUID()}`, env: {} });
    await createLocalTable(holder.db);
  });
  afterAll(async () => {
    if (holder.db) await deleteLocalTable(holder.db);
  });
  return holder;
}

/** The raw stored item, keys included, to check where data landed. */
export async function rawItem(db: Db, PK: string, SK: string) {
  const { Item } = await db.doc.send(new GetCommand({ TableName: db.tableName, Key: { PK, SK }, ConsistentRead: true }));
  return Item;
}

export const newUser = () => `user-${randomUUID()}`;
