// Inventory items (ADR 0005). Fields match the artifact's `products` collection.
// `stock` changes only through adjustStock's atomic ADD, never read-then-write.
// Like the commands (commands.ts), it gives the product a new version, so an
// edit made against the version before a stock change conflicts instead of
// overwriting it.

import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Db, connection } from "./client.js";
import { InvalidInputError, conflictOnConditionFailure } from "./errors.js";
import { barcode, keys, prefixes, productKey, strip, teamPartition } from "./keys.js";
import { queryAll, versionedSet } from "./query.js";
import { type TeamContext, readable, writable } from "./team-context.js";

export interface Product {
  readonly type: "product";
  readonly key: string;
  readonly code: string;
  readonly name: string;
  readonly price: number;
  readonly stock: number;
  readonly updatedAt: string;
  readonly version: number;
}

export interface ProductFields {
  readonly code: string;
  readonly name: string;
  readonly price: number;
}

function fields(input: ProductFields): Record<string, unknown> {
  if (typeof input.name !== "string" || !input.name.trim()) throw new InvalidInputError("Invalid product");
  if (typeof input.price !== "number" || !Number.isFinite(input.price) || input.price < 0) {
    throw new InvalidInputError("Invalid price");
  }
  return { code: barcode(input.code), name: input.name.trim(), price: input.price, updatedAt: new Date().toISOString() };
}

export async function listProducts(db: Db, ctx: TeamContext): Promise<Product[]> {
  readable(ctx);
  return queryAll<Product>(db, teamPartition(ctx.teamId), prefixes.product);
}

export async function getProduct(db: Db, ctx: TeamContext, key: string): Promise<Product | undefined> {
  readable(ctx);
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: keys.product(ctx.teamId, key), ConsistentRead: true }));
  return strip<Product>(Item);
}

/** Creates a product. Fails with ConflictError if the key is taken. */
export async function createProduct(db: Db, ctx: TeamContext, key: string, input: ProductFields, stock = 0): Promise<Product> {
  writable(db, ctx);
  const product = { type: "product", key: productKey(key), ...fields(input), stock, version: 1 } as Product;
  await connection(db).doc
    .send(
      new PutCommand({
        TableName: db.tableName,
        Item: { ...keys.product(ctx.teamId, key), ...product },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    )
    .catch(conflictOnConditionFailure("An item with this key already exists"));
  return product;
}

/** Edits code, name and price if nobody else has since `expectedVersion`. */
export async function updateProduct(db: Db, ctx: TeamContext, key: string, input: ProductFields, expectedVersion: number): Promise<Product> {
  writable(db, ctx);
  const { Attributes } = await connection(db).doc
    .send(new UpdateCommand({ TableName: db.tableName, Key: keys.product(ctx.teamId, key), ...versionedSet(fields(input), expectedVersion), ReturnValues: "ALL_NEW" }))
    .catch(conflictOnConditionFailure("This item changed; reload and try again"));
  return strip<Product>(Attributes) as Product;
}

/** Adds `delta` (negative to take out) to the storage count atomically. Returns the new count. */
export async function adjustStock(db: Db, ctx: TeamContext, key: string, delta: number): Promise<number> {
  writable(db, ctx);
  if (!Number.isInteger(delta)) throw new InvalidInputError("Invalid stock change");
  const { Attributes } = await connection(db).doc
    .send(
      new UpdateCommand({
        TableName: db.tableName,
        Key: keys.product(ctx.teamId, key),
        UpdateExpression: "SET #version = if_not_exists(#version, :one) + :one ADD #stock :delta",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#stock": "stock", "#version": "version" },
        ExpressionAttributeValues: { ":delta": delta, ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    )
    .catch(conflictOnConditionFailure("This item was deleted"));
  return Attributes?.stock as number;
}

/** Deletes a product, if unchanged since `expectedVersion` when given. */
export async function deleteProduct(db: Db, ctx: TeamContext, key: string, expectedVersion?: number): Promise<void> {
  writable(db, ctx);
  await connection(db).doc
    .send(
      new DeleteCommand({
        TableName: db.tableName,
        Key: keys.product(ctx.teamId, key),
        ...(expectedVersion === undefined
          ? {}
          : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expectedVersion } }),
      }),
    )
    .catch(conflictOnConditionFailure("This item changed; reload and try again"));
}
