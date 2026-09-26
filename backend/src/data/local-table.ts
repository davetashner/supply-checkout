// Creates the app table in DynamoDB Local for tests and local development,
// with the same keys and index as the deployed table (infra/lib/stacks/data-stack.ts).

import { CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import type { Db } from "./client.js";
import { GSI1, GSI1PK, GSI1SK, PK, SK } from "./schema.js";

export async function createLocalTable(db: Db): Promise<void> {
  await db.client.send(
    new CreateTableCommand({
      TableName: db.tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [PK, SK, GSI1PK, GSI1SK].map((AttributeName) => ({ AttributeName, AttributeType: "S" })),
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
      ],
    }),
  );
}

export async function deleteLocalTable(db: Db): Promise<void> {
  await db.client.send(new DeleteTableCommand({ TableName: db.tableName }));
}
