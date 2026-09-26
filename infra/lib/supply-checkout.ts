import { type App, Tags, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import type { DeploymentConfig } from "./config.js";
import { ApiStack } from "./stacks/api-stack.js";
import type { SupplyCheckoutStack } from "./stacks/base-stack.js";
import { DataStack } from "./stacks/data-stack.js";
import { IdentityStack } from "./stacks/identity-stack.js";
import { ObservabilityStack } from "./stacks/observability-stack.js";
import { RealtimeStack } from "./stacks/realtime-stack.js";
import { WebStack } from "./stacks/web-stack.js";

export interface RegionStacks {
  readonly data: DataStack;
  readonly api: ApiStack;
  readonly realtime: RealtimeStack;
  readonly observability: ObservabilityStack;
}

export interface SupplyCheckoutStacks {
  readonly regions: Record<string, RegionStacks>;
  /** Primary region only. */
  readonly identity: IdentityStack;
  /** Primary region only. */
  readonly web: WebStack;
  readonly all: SupplyCheckoutStack[];
}

/**
 * Adds every stack for one environment to the app.
 *
 * Per region: data (stateful) → api, realtime (stateless) → observability.
 * Primary region only: identity (stateful), web (stateless, needs every
 * region's data stack for its origin buckets).
 */
export function addSupplyCheckout(app: App, config: DeploymentConfig): SupplyCheckoutStacks {
  Tags.of(app).add("app", "supply-checkout");
  Tags.of(app).add("managed-by", "cdk");

  // AWS Solutions rules run on every synth. Findings fail the synth unless
  // acknowledged with Validations.of(construct).acknowledge({ id, reason }).
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));

  const identity = new IdentityStack(app, config, config.primaryRegion);
  const regions: Record<string, RegionStacks> = {};
  for (const region of config.regions) {
    const data = new DataStack(app, config, region);
    const api = new ApiStack(app, config, region);
    const realtime = new RealtimeStack(app, config, region);
    const observability = new ObservabilityStack(app, config, region);
    api.addStackDependency(data);
    api.addStackDependency(identity);
    realtime.addStackDependency(data);
    observability.addStackDependency(api);
    observability.addStackDependency(realtime);
    regions[region] = { data, api, realtime, observability };
  }
  const web = new WebStack(app, config, config.primaryRegion);
  for (const { data } of Object.values(regions)) web.addStackDependency(data);

  const all = [identity, web, ...Object.values(regions).flatMap((r) => [r.data, r.api, r.realtime, r.observability])];
  return { regions, identity, web, all };
}
