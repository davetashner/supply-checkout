import { type App, AspectPriority, Aspects, Tags, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { type DeploymentConfig, GLOBAL_SERVICES_REGION } from "./config.js";
import { ObservabilityDefaults } from "./observability/defaults.js";
import { ApiStack } from "./stacks/api-stack.js";
import type { SupplyCheckoutStack } from "./stacks/base-stack.js";
import { DataStack } from "./stacks/data-stack.js";
import { DomainStack } from "./stacks/domain-stack.js";
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
  /**
   * Certificates, DNS and email, one per deployed region plus
   * GLOBAL_SERVICES_REGION (for the CloudFront, Cognito and AppSync
   * certificates) when that isn't a deployed region.
   */
  readonly domain: Record<string, DomainStack>;
  /** Primary region only. */
  readonly identity: IdentityStack;
  /** GLOBAL_SERVICES_REGION only (CloudFront's web ACL and certificate). */
  readonly web: WebStack;
  readonly all: SupplyCheckoutStack[];
}

/**
 * Adds every stack for one environment to the app.
 *
 * Per region: domain, data (stateful) → api, realtime (stateless) → observability.
 * Primary region only: identity (stateful). GLOBAL_SERVICES_REGION: web
 * (stateless, CloudFront and WAF; needs every region's data stack for its
 * origin buckets). Identity and web also wait for the domain stack in
 * GLOBAL_SERVICES_REGION, which holds their certificates.
 */
export function addSupplyCheckout(app: App, config: DeploymentConfig): SupplyCheckoutStacks {
  Tags.of(app).add("app", "supply-checkout");
  Tags.of(app).add("managed-by", "cdk");

  // AWS Solutions rules run on every synth. Findings fail the synth unless
  // acknowledged with Validations.of(construct).acknowledge({ id, reason }).
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  // Log retention, X-Ray tracing and metrics settings for every function and
  // log group, including ones added later (supply-checkout-7pe).
  Aspects.of(app).add(new ObservabilityDefaults(config), { priority: AspectPriority.MUTATING });

  const domain: Record<string, DomainStack> = {};
  for (const region of new Set([...config.regions, GLOBAL_SERVICES_REGION])) {
    domain[region] = new DomainStack(app, config, region);
  }
  const globalDomain = domain[GLOBAL_SERVICES_REGION] as DomainStack;

  const identity = new IdentityStack(app, config, config.primaryRegion);
  identity.addStackDependency(globalDomain);
  const regions: Record<string, RegionStacks> = {};
  for (const region of config.regions) {
    const data = new DataStack(app, config, region);
    const api = new ApiStack(app, config, region);
    const realtime = new RealtimeStack(app, config, region);
    const observability = new ObservabilityStack(app, config, region);
    api.addStackDependency(data);
    api.addStackDependency(identity);
    api.addStackDependency(domain[region] as DomainStack);
    realtime.addStackDependency(data);
    realtime.addStackDependency(globalDomain);
    observability.addStackDependency(api);
    observability.addStackDependency(realtime);
    regions[region] = { data, api, realtime, observability };
  }
  // CloudFront's web ACL and certificate must be in GLOBAL_SERVICES_REGION
  const web = new WebStack(app, config, GLOBAL_SERVICES_REGION);
  for (const { data } of Object.values(regions)) web.addStackDependency(data);
  web.addStackDependency(globalDomain);

  const all = [
    ...Object.values(domain),
    identity,
    web,
    ...Object.values(regions).flatMap((r) => [r.data, r.api, r.realtime, r.observability]),
  ];
  return { regions, domain, identity, web, all };
}
