import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * The Cognito user pool, in the primary region only (ADR 0007). Both regions
 * verify JWTs locally against its signing keys. Filled in by
 * supply-checkout-zsm.
 */
export class IdentityStack extends SupplyCheckoutStack {
  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "identity", layer: "stateful" });
  }
}
