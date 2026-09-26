import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/**
 * The HTTP API with its JWT authorizer and the Lambda functions behind it, in
 * every region (ADR 0006, 0010). Functions are NodejsFunction (Node.js 22,
 * arm64) behind a `live` alias for CodeDeploy canaries (ADR 0012).
 */
export class ApiStack extends SupplyCheckoutStack {
  constructor(scope: Construct, config: DeploymentConfig, region: string) {
    super(scope, { config, region, component: "api", layer: "stateless" });
  }
}
