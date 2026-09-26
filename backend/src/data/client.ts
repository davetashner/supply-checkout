import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
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
  });
  const doc = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
  return dbFromConnection({ client, doc, tableName, region });
}
