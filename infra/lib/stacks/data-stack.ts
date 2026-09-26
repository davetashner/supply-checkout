import { RemovalPolicy } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  StreamViewType,
  TableEncryptionV2,
  TableV2,
} from "aws-cdk-lib/aws-dynamodb";
import { Key } from "aws-cdk-lib/aws-kms";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { GSI1, GSI1PK, GSI1SK, PK, SK, TTL_ATTRIBUTE, tableName } from "../../../backend/src/data/schema.js";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * Stateful resources in each region: the DynamoDB global table and its KMS key
 * (ADR 0005), the regional web bucket (ADR 0010) and Secrets Manager replicas.
 *
 * - The `app` table is a TableV2 (AWS::DynamoDB::GlobalTable) owned by the
 *   primary region's data stack, with one replica: the primary region. The
 *   other regions' replicas, and the KMS keys in those regions, are phase 2
 *   (supply-checkout-72d.1); adding one is another entry in `replicas` plus its
 *   key ARN in `replicaKeyArns`, not a new table.
 * - Its name, ARN, stream ARN and key ARN are published to SSM under
 *   /supply-checkout/<env>/data/ for the API and realtime stacks.
 * - Everything added here must use RemovalPolicy.RETAIN.
 */
export class DataStack extends SupplyCheckoutStack {
  /** The global table. Only the primary region's data stack has it. */
  readonly table?: TableV2;
  /** The table's customer-managed key in this region. */
  readonly tableKey?: Key;

  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "data", layer: "stateful" });
    if (!this.isPrimaryRegion) return;

    const prefix = `/supply-checkout/${config.envName}/data`;

    this.tableKey = new Key(this, "TableKey", {
      alias: `alias/supply-checkout-${config.envName}-app-table`,
      description: "Encrypts the Supply Checkout app table (ADR 0005)",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.table = new TableV2(this, "AppTable", {
      tableName: tableName(config.envName),
      partitionKey: { name: PK, type: AttributeType.STRING },
      sortKey: { name: SK, type: AttributeType.STRING },
      billing: Billing.onDemand(),
      encryption: TableEncryptionV2.customerManagedKey(this.tableKey),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      globalSecondaryIndexes: [
        {
          indexName: GSI1,
          partitionKey: { name: GSI1PK, type: AttributeType.STRING },
          sortKey: { name: GSI1SK, type: AttributeType.STRING },
        },
      ],
      // The stack's own region is always a replica; no others until phase 2.
      replicas: [],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const publish = (id: string, name: string, value: string, description: string) =>
      new StringParameter(this, id, { parameterName: `${prefix}/${name}`, stringValue: value, description });
    publish("TableNameParam", "table-name", this.table.tableName, "App table name");
    publish("TableArnParam", "table-arn", this.table.tableArn, "App table ARN in this region");
    publish("TableStreamArnParam", "table-stream-arn", this.table.tableStreamArn ?? "", "App table stream ARN in this region");
    publish("TableKeyArnParam", "table-key-arn", this.tableKey.keyArn, "KMS key ARN for the app table in this region");
  }
}
