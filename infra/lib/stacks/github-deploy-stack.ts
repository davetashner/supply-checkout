import { Aws, CfnOutput, DefaultStackSynthesizer, Duration, RemovalPolicy } from "aws-cdk-lib";
import { Effect, OidcProviderNative, PolicyStatement, Role, WebIdentityPrincipal } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { type DeploymentConfig, GITHUB_DEPLOY_ENVIRONMENT, GLOBAL_SERVICES_REGION } from "../config.js";
import { SupplyCheckoutStack } from "./base-stack.js";

/** GitHub Actions' OIDC issuer. */
export const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
/** The audience aws-actions/configure-aws-credentials asks GitHub for. */
export const GITHUB_OIDC_AUDIENCE = "sts.amazonaws.com";

const ISSUER = GITHUB_OIDC_URL.replace(/^https:\/\//, "");

/** The deploy role's fixed name, so a workflow can build its ARN from the account ID. */
export const githubDeployRoleName = (envName: string) => `supply-checkout-${envName}-github-deploy`;

/** The CDK bootstrap roles a `cdk deploy` (and `cdk diff`) assumes, by their bootstrap template names. */
const BOOTSTRAP_ROLES = ["deploy", "file-publishing", "image-publishing", "lookup"] as const;

/**
 * GitHub Actions' way into the account (supply-checkout-5ik, ADR 0012): an IAM
 * OIDC provider for GitHub's token issuer and one deploy role. No access keys
 * are stored anywhere; a workflow job exchanges its GitHub OIDC token for
 * the role's short-lived credentials.
 *
 * - The role trusts only tokens with audience `sts.amazonaws.com` and subject
 *   `repo:<owner>/<name>:environment:production`, exactly (StringEquals):
 *   a job in this repository that runs in the `production` GitHub
 *   environment. A job without that environment, a pull request, or another
 *   repository gets a different subject and is refused. The environment's
 *   protection rules on GitHub (required reviewers, which branches and tags
 *   may deploy) decide which jobs get that subject.
 * - Its only permission is to assume this account's CDK bootstrap roles
 *   (deploy, file publishing, image publishing, lookup) in the deployed
 *   regions and GLOBAL_SERVICES_REGION. Everything a deploy changes is done
 *   by CloudFormation through those roles, as when the owner deploys from a
 *   laptop. No managed policy, no wildcard.
 * - It is NOT part of the main app: the owner deploys it once, from
 *   bin/github-deploy.ts (`npm run deploy:github-deploy`), so a pipeline
 *   running `cdk deploy --all` can't change its own trust. Termination
 *   protection and RETAIN keep a stray delete from locking the pipeline out.
 */
export class GithubDeployStack extends SupplyCheckoutStack {
  readonly provider: OidcProviderNative;
  readonly role: Role;

  constructor(scope: Construct, config: DeploymentConfig, region: string, repository: string) {
    // Stateful: termination protection. IAM is global, so one stack, in the primary region.
    super(scope, { config, region, component: "github-deploy", layer: "stateful" });
    if (region !== config.primaryRegion) throw new Error("The GitHub deploy stack is in the primary region only (IAM is global)");

    this.provider = new OidcProviderNative(this, "GithubOidc", {
      url: GITHUB_OIDC_URL,
      clientIds: [GITHUB_OIDC_AUDIENCE],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.role = new Role(this, "DeployRole", {
      roleName: githubDeployRoleName(config.envName),
      description: `GitHub Actions deploys from ${repository}, environment ${GITHUB_DEPLOY_ENVIRONMENT} only`,
      assumedBy: new WebIdentityPrincipal(this.provider.oidcProviderArn, {
        StringEquals: {
          [`${ISSUER}:aud`]: GITHUB_OIDC_AUDIENCE,
          [`${ISSUER}:sub`]: `repo:${repository}:environment:${GITHUB_DEPLOY_ENVIRONMENT}`,
        },
      }),
      maxSessionDuration: Duration.hours(1),
    });
    this.role.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const qualifier = this.node.tryGetContext("@aws-cdk/core:bootstrapQualifier") ?? DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    const regions = [...new Set([...config.regions, GLOBAL_SERVICES_REGION])];
    this.role.addToPolicy(
      new PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        effect: Effect.ALLOW,
        // TagSession: newer CDK CLIs and bootstrap templates pass session tags
        // when assuming the bootstrap roles; it's limited to the same roles.
        actions: ["sts:AssumeRole", "sts:TagSession"],
        resources: regions.flatMap((r) =>
          BOOTSTRAP_ROLES.map((kind) => `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/cdk-${qualifier}-${kind}-role-${Aws.ACCOUNT_ID}-${r}`),
        ),
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: this.role.roleArn,
      description: "The role GitHub Actions assumes to deploy (aws-actions/configure-aws-credentials role-to-assume)",
    });
  }
}
