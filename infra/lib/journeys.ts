// Names for the prod journey tests' AWS pieces (supply-checkout-o60.3,
// docs/journey-tests-plan.md): the test mail subdomain, its SES receipt rule,
// the mail and results buckets and the journeys role. The journeys stack
// (lib/stacks/journeys-stack.ts) builds them; the data stack grants their
// access logs; the harness (supply-checkout-o60.5) builds the same names.
import { Aws } from "aws-cdk-lib";
import type { DeploymentConfig } from "./config.js";
import { envDomain } from "./domain.js";

/** The label of the test mail subdomain: `e2e.<env domain>`. */
export const JOURNEY_MAIL_LABEL = "e2e";

/** The test mail subdomain. Every test account's address is at it, and only SES (for us) receives its mail. */
export const journeyMailDomain = (config: Pick<DeploymentConfig, "envName" | "domainName">) => `${JOURNEY_MAIL_LABEL}.${envDomain(config)}`;

/** Where SES writes each message to the test subdomain, in the mail bucket. Kept 1 day. */
export const JOURNEY_MAIL_INBOX_PREFIX = "inbox/";

/** Where the harness records each run's throwaway accounts (mail bucket) and uploads traces (results bucket). Kept 30 days. */
export const JOURNEY_RUNS_PREFIX = "runs/";

/** How long a message stays in the inbox. */
export const JOURNEY_MAIL_RETENTION_DAYS = 1;

/** How long run records (mail bucket) and traces (results bucket) stay. */
export const JOURNEY_RUNS_RETENTION_DAYS = 30;

/** The mail bucket. The account ID makes the name globally unique; it's resolved at deploy time. */
export function journeyMailBucketName(envName: string, region: string, account: string = Aws.ACCOUNT_ID): string {
  return `supply-checkout-${envName}-journey-mail-${region}-${account}`;
}

/** The results bucket (Playwright traces and videos of failed tests). */
export function journeyResultsBucketName(envName: string, region: string, account: string = Aws.ACCOUNT_ID): string {
  return `supply-checkout-${envName}-journey-results-${region}-${account}`;
}

/** Where each journey bucket's S3 server access logs go in the data stack's logs bucket. */
export const JOURNEY_ACCESS_LOG_PREFIXES = { mail: "s3/journey-mail/", results: "s3/journey-results/" } as const;

/** The SES receipt rule set, and its one rule. Fixed names, so the mail bucket's policy can name the rule. */
export const journeyReceiptRuleSetName = (envName: string) => `supply-checkout-${envName}-journeys`;
export const JOURNEY_RECEIPT_RULE_NAME = "test-mail";

/** The journeys role's fixed name, so the workflow can build its ARN from the account ID. */
export const journeysRoleName = (envName: string) => `supply-checkout-${envName}-journeys`;

/**
 * Whether an environment has the journeys stack: prod only, since the role's
 * trust names the `production-journeys` GitHub environment. The data stack
 * grants the journey buckets' access logs under the same rule.
 */
export const hasJourneys = (config: Pick<DeploymentConfig, "envName">) => config.envName === "prod";
