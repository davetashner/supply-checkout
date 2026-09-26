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

export interface DeploymentConfig {
  /** Environment name, e.g. prod, staging, dev. Part of every stack name. */
  readonly envName: string;
  /** AWS account ID, or undefined for an account-agnostic synth (CI, tests). */
  readonly account?: string;
  /** Every region the full stack is deployed to (ADR 0010: active-active). */
  readonly regions: readonly string[];
  /** Region for global pieces: Cognito, CloudFront, WAF, Route 53 (ADR 0007, 0010). */
  readonly primaryRegion: string;
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
    account: env.CDK_DEFAULT_ACCOUNT || undefined,
    regions,
    primaryRegion: String(node.tryGetContext("primaryRegion") ?? regions[0]),
  });
}
