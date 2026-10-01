import { STRIPE_MODES, type StripeMode, stripeOpsKeySecretName, stripeSecretName, stripeWebhookSecretName } from "../../backend/src/billing/names.js";

// Where the app deploys. Nothing account-specific is committed: the account
// comes from the CLI profile at synth time (CDK_DEFAULT_ACCOUNT), and the
// environment comes from CDK context (cdk.json, or -c on the CLI).
//
// This is the one place region names may appear (ADR 0010).
// scripts/check-region-strings.mjs fails CI on a region name anywhere else in
// infra/, backend/ or src/. Stacks get their region as a parameter; Lambdas
// read AWS_REGION; tests import the constants below.

/** Regions the organization's service control policies allow (ADR 0003). */
export const APPROVED_REGIONS = ["us-east-1", "us-west-2"] as const;

/**
 * Regions that are deployed today. The MVP runs in us-east-1 only; every stack
 * takes its region as a parameter, and tests and CI also synth us-west-2
 * (`-c regions=all`), so turning on the second region (ADR 0010) is a config
 * change: add it here.
 */
export const DEFAULT_REGIONS = ["us-east-1"] as const;

/**
 * The region AWS requires for CloudFront's ACM certificate and a CloudFront
 * WAF web ACL, and where the Cognito user pool lives (ADR 0007, ADR 0010).
 */
export const GLOBAL_SERVICES_REGION = "us-east-1";

/** `-c regions=all` synthesizes every approved region. */
export const ALL_REGIONS = "all";

/**
 * The product's registered domain (Namecheap, delegated to a Route 53 hosted
 * zone in the prod account). Prod serves it directly; every other environment
 * serves `<envName>.<domain>` from its own zone (see lib/domain.ts).
 */
export const DEFAULT_DOMAIN_NAME = "supplycheckout.com";

// Claude on Amazon Bedrock for receipt reading (ADR 0008, supply-checkout-fy9).
// Both are US cross-region inference profiles (the `us.` prefix): Bedrock may
// route a request to any US region the profile covers, and never outside the
// US. A `global.` profile could route it anywhere, so it isn't used.
//
// Invoking a profile needs bedrock:InvokeModel on the inference-profile ARN
// and on the underlying foundation-model ARN in every region it routes to.

/** The model receipt reading uses: Claude Haiku 4.5. */
export const RECEIPT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * The regions the US inference profiles route to (AWS's "Supported Regions
 * and models for inference profiles"). The receipts function may invoke the
 * receipt model's foundation model in each of them, and only through its
 * profile (api-stack.ts). If AWS adds a region to the profile, add it here:
 * until then a request Bedrock routes there is refused (AccessDenied).
 */
export const RECEIPT_MODEL_REGIONS = ["us-east-1", "us-east-2", "us-west-1", "us-west-2"] as const;

/** The foundation model behind a `us.` inference profile ID: the ID without its prefix. */
export function foundationModelOf(profileId: string): string {
  if (!profileId.startsWith("us.")) throw new Error(`${profileId} is not a US inference profile`);
  return profileId.slice("us.".length);
}

/**
 * The model the receipt eval benchmarks against: Claude Sonnet 4.6. Sonnet 5
 * and 5.5 weren't available to the account on 2026-10-01 (ADR 0008).
 */
export const RECEIPT_BENCHMARK_MODEL_ID = "us.anthropic.claude-sonnet-4-6";

export interface DeploymentConfig {
  /** Environment name, e.g. prod, staging, dev. Part of every stack name. */
  readonly envName: string;
  /** The registered domain, e.g. supplycheckout.com. Prod uses it as is; see lib/domain.ts. */
  readonly domainName: string;
  /** AWS account ID, or undefined for an account-agnostic synth (CI, tests). */
  readonly account?: string;
  /** Every region the full stack is deployed to (ADR 0010: active-active). */
  readonly regions: readonly string[];
  /** Region for global pieces: Cognito, CloudFront, WAF, Route 53 (ADR 0007, 0010). */
  readonly primaryRegion: string;
  /**
   * Which Stripe key the billing functions use (ADR 0009): `test` (the
   * sandbox) until the live account is ready (supply-checkout-dri), then
   * `-c stripeMode=live`. Defaults to test.
   */
  readonly stripeMode?: StripeMode;
}

/** The Stripe mode an environment uses: test unless it's configured live. */
export const stripeModeOf = (config: Pick<DeploymentConfig, "stripeMode">): StripeMode => config.stripeMode ?? "test";

/**
 * The IAM resource for an environment's Stripe secret key in Secrets Manager,
 * in one region (the secret's name is stripeSecretName; a second region gets
 * a replica with the same name, ADR 0010). Secrets Manager ends a secret's ARN
 * with "-" and six random characters, which `??????` matches exactly, so the
 * pattern names this one secret and no other. The account and partition are
 * CloudFormation's (Aws.ACCOUNT_ID, Aws.PARTITION): no account ID is ever
 * written down.
 */
export function stripeSecretArn(where: { readonly partition: string; readonly region: string; readonly account: string }, envName: string, mode: StripeMode): string {
  return `arn:${where.partition}:secretsmanager:${where.region}:${where.account}:secret:${stripeSecretName(envName, mode)}-??????`;
}

/** The same for the Stripe webhook endpoint's signing secret (stripeWebhookSecretName). */
export function stripeWebhookSecretArn(where: { readonly partition: string; readonly region: string; readonly account: string }, envName: string, mode: StripeMode): string {
  return `arn:${where.partition}:secretsmanager:${where.region}:${where.account}:secret:${stripeWebhookSecretName(envName, mode)}-??????`;
}

/** The same for the ops function's Stripe restricted key (stripeOpsKeySecretName, supply-checkout-6uw.4). */
export function stripeOpsKeySecretArn(where: { readonly partition: string; readonly region: string; readonly account: string }, envName: string, mode: StripeMode): string {
  return `arn:${where.partition}:secretsmanager:${where.region}:${where.account}:secret:${stripeOpsKeySecretName(envName, mode)}-??????`;
}

interface ContextReader {
  tryGetContext(key: string): unknown;
}

function list(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === ALL_REGIONS) return [...APPROVED_REGIONS];
  if (Array.isArray(value)) return value.map(String);
  // -c regions=us-east-1,us-west-2 arrives as a string
  return String(value).split(",").map((s) => s.trim()).filter(Boolean);
}

export function validateConfig(config: DeploymentConfig): DeploymentConfig {
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(config.envName)) {
    throw new Error(`envName must be lowercase letters, digits or dashes (got "${config.envName}")`);
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(config.domainName)) {
    throw new Error(`domainName must be a lowercase domain name like example.com (got "${config.domainName}")`);
  }
  if (config.regions.length === 0) throw new Error("At least one region is required");
  if (new Set(config.regions).size !== config.regions.length) {
    throw new Error(`Regions must not repeat (got ${config.regions.join(", ")})`);
  }
  for (const region of config.regions) {
    if (!(APPROVED_REGIONS as readonly string[]).includes(region)) {
      throw new Error(`Region ${region} is not approved; use one of ${APPROVED_REGIONS.join(", ")}`);
    }
  }
  if (!config.regions.includes(config.primaryRegion)) {
    throw new Error(`primaryRegion ${config.primaryRegion} must be one of the regions`);
  }
  if (config.stripeMode !== undefined && !STRIPE_MODES.includes(config.stripeMode)) {
    throw new Error(`stripeMode must be test or live (got "${String(config.stripeMode)}")`);
  }
  if (config.account !== undefined && !/^\d{12}$/.test(config.account)) {
    throw new Error("account must be a 12-digit AWS account ID");
  }
  return config;
}

export function configFromContext(
  node: ContextReader,
  env: NodeJS.ProcessEnv = process.env,
): DeploymentConfig {
  const regions = list(node.tryGetContext("regions")) ?? [...DEFAULT_REGIONS];
  return validateConfig({
    envName: String(node.tryGetContext("envName") ?? "prod"),
    domainName: String(node.tryGetContext("domainName") ?? DEFAULT_DOMAIN_NAME),
    account: env.CDK_DEFAULT_ACCOUNT || undefined,
    regions,
    primaryRegion: String(node.tryGetContext("primaryRegion") ?? regions[0]),
    stripeMode: String(node.tryGetContext("stripeMode") ?? "test") as StripeMode,
  });
}

/**
 * A GitHub repository whose Actions workflows may deploy (supply-checkout-5ik):
 * its `owner/name`, and GitHub's numeric IDs for its owner and for the
 * repository. The deploy role's trust matches GitHub's immutable subject,
 * which has both (supply-checkout-pbp.23): a name can be freed by a rename or
 * deletion and registered again by someone else, an ID never is.
 */
export interface GithubRepository {
  readonly name: string;
  readonly ownerId: number;
  readonly repositoryId: number;
}

/**
 * This repository. Override all three together with
 * `-c githubRepository=owner/name -c githubOwnerId=<n> -c githubRepositoryId=<n>`
 * (a fork, or after a transfer). They're public identifiers, fine to commit:
 * `gh api repos/<owner>/<name> --jq '{owner_id: .owner.id, repo_id: .id}'`.
 */
export const DEFAULT_GITHUB_REPOSITORY: GithubRepository = {
  name: "davetashner/supply-checkout",
  ownerId: 5702882,
  repositoryId: 1388338851,
};

/**
 * The GitHub environment a deploy job must run in to assume the deploy role
 * (ADR 0012). Its protection rules on GitHub (who may approve, which branches
 * and tags may use it) are what stand between a workflow and prod.
 */
export const GITHUB_DEPLOY_ENVIRONMENT = "production";

// GitHub's own rules: an owner is 1-39 letters, digits or single dashes, not
// starting with a dash; a repository name is letters, digits, `.`, `_` and `-`.
// Nothing else (no `:`, `@` or wildcard), so the value can't widen or reshape
// the role's `sub` condition.
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

// A GitHub ID: a positive integer in decimal, no sign, no leading zero, and
// small enough to be exact. Nothing else, so it can't widen the `sub` condition.
const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,14}$/;

function githubId(key: string, value: unknown): number {
  const text = String(value);
  if (!GITHUB_ID_PATTERN.test(text)) throw new Error(`${key} must be a GitHub numeric ID, a positive integer (got "${text}")`);
  return Number(text);
}

/**
 * The repository from `-c githubRepository=owner/name -c githubOwnerId=<n>
 * -c githubRepositoryId=<n>` (all three or none), or DEFAULT_GITHUB_REPOSITORY.
 */
export function githubRepositoryFromContext(node: ContextReader): GithubRepository {
  const keys = ["githubRepository", "githubOwnerId", "githubRepositoryId"] as const;
  const given = keys.filter((key) => node.tryGetContext(key) !== undefined);
  if (given.length === 0) return DEFAULT_GITHUB_REPOSITORY;
  if (given.length !== keys.length) {
    throw new Error(`Give githubRepository, githubOwnerId and githubRepositoryId together, or none of them (got only ${given.join(", ")})`);
  }
  const name = String(node.tryGetContext("githubRepository"));
  if (!GITHUB_REPOSITORY_PATTERN.test(name)) {
    throw new Error(`githubRepository must be a GitHub owner/name like octo-org/octo-repo (got "${name}")`);
  }
  return {
    name,
    ownerId: githubId("githubOwnerId", node.tryGetContext("githubOwnerId")),
    repositoryId: githubId("githubRepositoryId", node.tryGetContext("githubRepositoryId")),
  };
}
