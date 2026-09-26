import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * The AppSync Events API and the DynamoDB Streams publisher, in every region
 * (ADR 0006, 0010).
 */
export class RealtimeStack extends SupplyCheckoutStack {
  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "realtime", layer: "stateless" });
  }
}
