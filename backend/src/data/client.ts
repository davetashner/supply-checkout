import { DynamoDBClient, type DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { localRegion } from "./region.js";

declare const opaque: unique symbol;

/**
 * A handle on the app table in the region this code runs in. It is opaque:
 * callers pass it to the data functions and can't reach the DynamoDB client
 * through it.
 */
export interface Db {
  readonly tableName: string;
  /** The region this handle writes to (ADR 0010: always the local region in the MVP). */
  readonly region: string;
  readonly [opaque]: true;
}

/** The raw clients behind a Db. For this module only (index.ts doesn't export it). */
export interface Connection {
  readonly client: DynamoDBClient;
  readonly doc: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly region: string;
}

const connections = new WeakMap<Db, Connection>();

/** The clients behind a Db made by createDb. */
export function connection(db: Db): Connection {
  const found = connections.get(db);
  if (!found) throw new Error("Not a Db made by createDb");
  return found;
}

/** Wraps a connection in an opaque Db. For this module and its tests. */
export function dbFromConnection(c: Connection): Db {
  const db = Object.freeze({ tableName: c.tableName, region: c.region }) as Db;
  connections.set(db, c);
  return db;
}

export interface DbOptions {
  /** Defaults to the TABLE_NAME environment variable. */
  readonly tableName?: string;
  /** Defaults to AWS_REGION, which Lambda always sets. */
  readonly region?: string;
  /** DynamoDB Local for tests, e.g. http://localhost:8000. Defaults to DYNAMODB_ENDPOINT. */
  readonly endpoint?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Credentials for this handle. Defaults to the Lambda's own role. The data
   * API passes a role session scoped to one team (ADR 0005's LeadingKeys layer).
   */
  readonly credentials?: DynamoDBClientConfig["credentials"];
  /**
   * Ends a request that takes longer than this, in milliseconds, so the SDK
   * retries it (the stream consumer's CONSUMER_DB_REQUEST_TIMEOUT_MS).
   * Defaults to the SDK's, which is no timeout.
   */
  readonly requestTimeoutMs?: number;
}

/** Creates the one DynamoDB client. Create it once per Lambda container, outside the handler. */
export function createDb(options: DbOptions = {}): Db {
  const env = options.env ?? process.env;
  const tableName = options.tableName ?? env.TABLE_NAME;
  if (!tableName) throw new Error("TABLE_NAME is not set");
  const region = options.region ?? localRegion(env);
  const endpoint = options.endpoint ?? (env.DYNAMODB_ENDPOINT || undefined);
  const client = new DynamoDBClient({
    region,
    endpoint,
    // DynamoDB Local accepts any credentials; real AWS uses the Lambda role.
    ...(endpoint ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.requestTimeoutMs ? { requestHandler: { requestTimeout: options.requestTimeoutMs, connectionTimeout: options.requestTimeoutMs, throwOnRequestTimeout: true } } : {}),
  });
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
  return dbFromConnection({ client, doc, tableName, region });
}

const isPlainMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/**
 * An item (or an ExpressionAttributeValues map) in a form the document client
 * stores as it is. The SDK's marshaller picks a value's type from its
 * `constructor` property, so a nested map with a "constructor" key (a sheet
 * line for a product keyed "constructor") would be refused, or stored as the
 * wrong type if that line's `name` were "String", say. Such a map goes as a
 * Map, whose entries can't hide its constructor. The item's own attributes
 * are marshalled one by one, so only nested maps need it. (A "__proto__" key
 * would be dropped on the way; productKey() and the document checks refuse it.)
 */
export function storable(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, storableValue(v)]));
}

function storableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(storableValue);
  if (!isPlainMap(value)) return value;
  const entries = Object.entries(value).map(([k, v]) => [k, storableValue(v)] as const);
  return Object.hasOwn(value, "constructor") ? new Map(entries) : Object.fromEntries(entries);
}

/** Closes the handle's connections. For a cache that evicts handles. */
export function closeDb(db: Db): void {
  connection(db).client.destroy();
}
