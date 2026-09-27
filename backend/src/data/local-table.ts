// Creates the app table in DynamoDB Local for tests and local development,
// with the same keys and indexes as the deployed table (infra/lib/stacks/data-stack.ts).

import { CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { type Db, connection } from "./client.js";
import { GSI1, GSI1PK, GSI1SK, GSI2, GSI2PK, GSI2SK, GSI3, GSI3PK, GSI3SK, OPS_INDEX_ATTRIBUTES, PK, SK } from "./schema.js";

export async function createLocalTable(db: Db): Promise<void> {
  await connection(db).client.send(
    new CreateTableCommand({
      TableName: db.tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [PK, SK, GSI1PK, GSI1SK, GSI2PK, GSI2SK, GSI3PK, GSI3SK].map((AttributeName) => ({ AttributeName, AttributeType: "S" })),
      KeySchema: [
        { AttributeName: PK, KeyType: "HASH" },
        { AttributeName: SK, KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: GSI1,
          KeySchema: [
            { AttributeName: GSI1PK, KeyType: "HASH" },
            { AttributeName: GSI1SK, KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        {
          IndexName: GSI2,
          KeySchema: [
            { AttributeName: GSI2PK, KeyType: "HASH" },
            { AttributeName: GSI2SK, KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
        {
          IndexName: GSI3,
          KeySchema: [
            { AttributeName: GSI3PK, KeyType: "HASH" },
            { AttributeName: GSI3SK, KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "INCLUDE", NonKeyAttributes: [...OPS_INDEX_ATTRIBUTES] },
        },
      ],
    }),
  );
}

export async function deleteLocalTable(db: Db): Promise<void> {
  await connection(db).client.send(new DeleteTableCommand({ TableName: db.tableName }));
}
