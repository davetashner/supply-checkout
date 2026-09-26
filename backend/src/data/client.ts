import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { localRegion } from "./region.js";

/** A connection to the app table in the region this code runs in. */
export interface Db {
  /** For table management (tests); items go through `doc`. */
  readonly client: DynamoDBClient;
  readonly doc: DynamoDBDocumentClient;
  readonly tableName: string;
  /** The region this connection writes to (ADR 0010: always the local region in the MVP). */
  readonly region: string;
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
  return { client, doc, tableName, region };
}
