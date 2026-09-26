import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * Stateful resources in each region: the DynamoDB global table and its KMS key
 * (ADR 0005), the regional web bucket (ADR 0010) and Secrets Manager replicas.
 *
 * - supply-checkout-yj8 adds the `app` table here, created in the primary
 *   region with a replica in every other region. Only the primary region's
 *   stack creates the global table; the other regions' data stacks hold
 *   regional resources only.
 * - Everything added here must use RemovalPolicy.RETAIN.
 */
export class DataStack extends SupplyCheckoutStack {
  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "data", layer: "stateful" });
  }
}
