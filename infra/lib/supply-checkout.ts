import { type App, AspectPriority, Aspects, Tags, Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import { type DeploymentConfig, GLOBAL_SERVICES_REGION } from "./config.js";
import { ObservabilityDefaults } from "./observability/defaults.js";
import { ApiStack } from "./stacks/api-stack.js";
import { AuditStack } from "./stacks/audit-stack.js";
import { BackupAccountStack } from "./stacks/backup-account-stack.js";
import { BackupStack } from "./stacks/backup-stack.js";
import type { SupplyCheckoutStack } from "./stacks/base-stack.js";
import { DataStack } from "./stacks/data-stack.js";
import { DomainStack } from "./stacks/domain-stack.js";
import { EmailStack } from "./stacks/email-stack.js";
import { GithubDeployStack } from "./stacks/github-deploy-stack.js";
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
  /** Primary region only: AWS Backup for the app table (docs/backups.md). */
  readonly backup: BackupStack;
  /** Primary region only: SES bounce and complaint handling. */
  readonly email: EmailStack;
  /** Primary region only: the account's multi-region CloudTrail trail, which every CloudTrail alert rule needs. */
  readonly audit: AuditStack;
  /** GLOBAL_SERVICES_REGION only (CloudFront's web ACL and certificate). */
  readonly web: WebStack;
  readonly all: SupplyCheckoutStack[];
}

/**
 * Adds every stack for one environment to the app.
 *
 * Per region: domain, data (stateful) → api, realtime (stateless) → observability.
 * Primary region only: identity (stateful), and backup (stateful, after the
 * data stack, whose table it backs up, and observability, whose topic its
 * alarms notify). GLOBAL_SERVICES_REGION: web
 * (stateless, CloudFront and WAF; needs every region's data stack for its
 * origin buckets). Identity and web also wait for the domain stack in
 * GLOBAL_SERVICES_REGION, which holds their certificates. Identity waits for
 * web too (its apex record), for the primary region's domain stack (SES), and
 * for its data stack (the email_verified trigger reads the table).
 * Email (primary region only) waits for that region's data stack (the table)
 * and domain stack (the SES configuration set and its events topic).
 * Audit (primary region only, stateful: the CloudTrail trail) waits for that
 * region's data stack (its logs bucket), and that region's observability
 * stack waits for it: its rules need the trail, and one watches its key.
 * The observability stack in GLOBAL_SERVICES_REGION waits for web, whose
 * distribution and router its web alarms watch.
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
  // The SES domain identity Cognito sends from is in the primary region's domain stack.
  identity.addStackDependency(domain[config.primaryRegion] as DomainStack);
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
  const backup = new BackupStack(app, config, config.primaryRegion);
  const primary = regions[config.primaryRegion] as RegionStacks;
  // The email_verified trigger reads the app table (its key ARN from the data stack's SSM output)
  identity.addStackDependency(primary.data);
  backup.addStackDependency(primary.data);
  // Its alarms notify the observability stack's P2 topic
  backup.addStackDependency(primary.observability);
  // The trail every CloudTrail alert rule needs (supply-checkout-3sv.3)
  const audit = new AuditStack(app, config, config.primaryRegion);
  audit.addStackDependency(primary.data);
  primary.observability.addStackDependency(audit);
  const email = new EmailStack(app, config, config.primaryRegion);
  email.addStackDependency(regions[config.primaryRegion]?.data as DataStack);
  email.addStackDependency(domain[config.primaryRegion] as DomainStack);
  // CloudFront's web ACL and certificate must be in GLOBAL_SERVICES_REGION
  const web = new WebStack(app, config, GLOBAL_SERVICES_REGION);
  for (const { data } of Object.values(regions)) web.addStackDependency(data);
  web.addStackDependency(globalDomain);
  // Cognito won't create auth.<domain> until the apex resolves, and the web
  // stack's alias records are what make it resolve.
  identity.addStackDependency(web);
  // The web alarms (supply-checkout-3sv.2) read the distribution's and the
  // router's names from the web stack's SSM outputs, in its region
  regions[GLOBAL_SERVICES_REGION]?.observability.addStackDependency(web);

  const all = [
    ...Object.values(domain),
    identity,
    backup,
    audit,
    web,
    email,
    ...Object.values(regions).flatMap((r) => [r.data, r.api, r.realtime, r.observability]),
  ];
  return { regions, domain, identity, backup, email, audit, web, all };
}

/**
 * The backup account's vault for this environment's copies, in the primary
 * region. Only bin/backup-account.ts calls this, with the backup account's
 * profile; the workload app never includes it.
 */
export function addBackupAccount(app: App, config: DeploymentConfig): BackupAccountStack {
  Tags.of(app).add("app", "supply-checkout");
  Tags.of(app).add("managed-by", "cdk");
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return new BackupAccountStack(app, config, config.primaryRegion);
}

/**
 * GitHub Actions' OIDC provider and deploy role (supply-checkout-5ik), in the
 * primary region. Only bin/github-deploy.ts calls this, with the workload
 * account's profile; the main app never includes it, so a pipeline deploying
 * the main app never changes the role it deploys with by accident. That isn't
 * a security boundary (see GithubDeployStack).
 */
export function addGithubDeploy(app: App, config: DeploymentConfig, repository: string): GithubDeployStack {
  Tags.of(app).add("app", "supply-checkout");
  Tags.of(app).add("managed-by", "cdk");
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  return new GithubDeployStack(app, config, config.primaryRegion, repository);
}
