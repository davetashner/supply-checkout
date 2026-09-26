import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * CloudFront with AWS WAF and an origin group over the regional web buckets,
 * in the primary region only because CloudFront's certificate and WAF web ACL
 * must live in us-east-1 (ADR 0010). Filled in by supply-checkout-qk1.
 */
export class WebStack extends SupplyCheckoutStack {
  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "web", layer: "stateless" });
  }
}
