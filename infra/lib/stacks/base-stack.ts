import { Stack, type StackProps, Tags } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import type { DeploymentConfig } from "../config.js";

/**
 * Stateful stacks hold data that must survive a bad deploy (ADR 0012): they get
 * termination protection, and their resources use RETAIN removal policies.
 * Stateless stacks can be torn down and recreated at any time.
 */
export type Layer = "stateful" | "stateless";

export interface SupplyCheckoutStackProps extends StackProps {
  readonly config: DeploymentConfig;
  readonly region: string;
  readonly component: string;
  readonly layer: Layer;
}

export function stackName(config: DeploymentConfig, region: string, component: string): string {
  return `supply-checkout-${config.envName}-${region}-${component}`;
}

/** Common setup for every stack: name, environment, tags and protection. */
export class SupplyCheckoutStack extends Stack {
  readonly config: DeploymentConfig;
  readonly component: string;
  readonly layer: Layer;
  readonly isPrimaryRegion: boolean;

  constructor(scope: Construct, props: SupplyCheckoutStackProps) {
    const name = stackName(props.config, props.region, props.component);
    super(scope, name, {
      ...props,
      stackName: name,
      env: { account: props.config.account, region: props.region },
      terminationProtection: props.layer === "stateful",
      // Stack-level tags must be explicit (@aws-cdk/core:explicitStackTags);
      // Tags.of(app) in supply-checkout.ts covers the resources.
      tags: {
        app: "supply-checkout",
        "managed-by": "cdk",
        env: props.config.envName,
        component: props.component,
        layer: props.layer,
        ...props.tags,
      },
    });
    this.config = props.config;
    this.component = props.component;
    this.layer = props.layer;
    this.isPrimaryRegion = props.region === props.config.primaryRegion;

    Tags.of(this).add("env", props.config.envName);
    Tags.of(this).add("component", props.component);
    Tags.of(this).add("layer", props.layer);

    // Every stack publishes what it is under /supply-checkout/<env>/<component>/.
    // Later stacks add their outputs (table name, API URL, ...) beside it, so
    // functions and scripts look them up in their own region without
    // cross-stack exports. Standard SSM parameters are free.
    new StringParameter(this, "StackInfo", {
      parameterName: `/supply-checkout/${props.config.envName}/${props.component}/stack`,
      description: `Supply Checkout ${props.component} stack (${props.layer})`,
      stringValue: JSON.stringify({ stackName: name, layer: props.layer }),
    });
  }
}
