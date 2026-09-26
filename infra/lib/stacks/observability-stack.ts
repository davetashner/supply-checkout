import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * Alarms, dashboards and synthetics canaries for the stacks in this region.
 * Filled in by supply-checkout-7pe.
 */
export class ObservabilityStack extends SupplyCheckoutStack {
  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "observability", layer: "stateless" });
  }
}
